/**
 * 服务器地址自动发现：trycloudflare 快速隧道每次重启地址都会变，
 * 当本机保存的服务器地址失效时，自动按「局域网直连优先 → 云端发现文件 → 历史可用地址记忆」
 * 的顺序引导最新地址（参考 LocalSend / Oryxis / Syncthing 等自托管应用的发现策略），
 * 用户无需手动改地址。
 */
import { useAppStore } from '../store/appStore';

const REPO = 'telawitif073-debug/desktop-pet';

/** 发现文件源（多域冗余：jsdelivr 三个域 + GitHub raw + gh-proxy 公共镜像兜底，国内网络至少一个可达） */
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@main/server-discovery.json`,
  `https://fastly.jsdelivr.net/gh/${REPO}@main/server-discovery.json`,
  `https://testingcf.jsdelivr.net/gh/${REPO}@main/server-discovery.json`,
  `https://raw.githubusercontent.com/${REPO}/main/server-discovery.json`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/main/server-discovery.json`,
];

export interface DiscoveryFile {
  /** 当前公网隧道根地址 */
  tunnel?: string;
  /** 完整 API 地址 */
  api?: string;
  /** 局域网兜底地址（同一 WiFi 下直连更快更稳，优先尝试） */
  lan?: string;
  updatedAt?: number;
}

/** 健康检查：API 地址能在 timeoutMs 内返回 app-update 即视为可用 */
export async function checkServerHealth(apiBase: string, timeoutMs = 6000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${apiBase.replace(/\/$/, '')}/app-update`, {
      signal: ctrl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 把可用地址记入历史列表（去重置顶，最多保留 5 个；云端发现源全挂时逐个重试） */
function rememberServer(api: string): void {
  const prev = useAppStore.getState().knownServers.filter((u) => u !== api);
  useAppStore.getState().patch({ knownServers: [api, ...prev].slice(0, 5) });
}

/** 从发现源文件拉取候选地址：局域网地址排最前（3s 短超时探测，非同一 WiFi 快速跳过） */
async function fetchDiscoveryCandidates(): Promise<string[]> {
  const lanCandidates: string[] = [];
  const remoteCandidates: string[] = [];
  for (const src of SOURCES) {
    try {
      // 时间戳绕 CDN 缓存，确保拿到最新换址结果
      const r = await fetch(`${src}?v=${Date.now()}`, { method: 'GET' });
      if (!r.ok) continue;
      const data = (await r.json()) as DiscoveryFile;
      if (data.lan) lanCandidates.push(data.lan);
      if (data.api) remoteCandidates.push(data.api);
      if (data.tunnel) remoteCandidates.push(`${data.tunnel.replace(/\/$/, '')}/api`);
    } catch {
      // 该源不可达，尝试下一个
    }
  }
  return [...lanCandidates, ...remoteCandidates];
}

/**
 * 当前服务器不可达时，自动引导可用地址并更新 baseUrl。
 * 探测顺序：局域网地址（LAN 优先，同 WiFi 下直连）→ 云端发现文件里的公网地址 → 本机历史可用地址。
 * 返回是否发生了地址更新；当前地址健康时什么都不做（零打扰、零延迟）。
 * force=true 时跳过健康检查直接引导（手动「重新发现」按钮用）。
 */
export async function discoverAndUpdateServer(force = false): Promise<boolean> {
  const store = useAppStore.getState();
  if (!force && (await checkServerHealth(store.baseUrl))) {
    // 当前地址健康也记录进历史，供发现源不可达时兜底
    if (!store.knownServers.includes(store.baseUrl)) rememberServer(store.baseUrl);
    return false;
  }

  // 1) 云端发现文件（lan 在前 tunnel 在后）
  let candidates = await fetchDiscoveryCandidates();
  // 2) 本机历史可用地址兜底（发现源全挂时）
  if (!candidates.length) candidates = store.knownServers.filter((u) => u !== store.baseUrl);

  for (const api of candidates) {
    // 局域网地址短超时：不在同一 WiFi 时 3 秒内放弃，不拖慢整体
    const isLan = /:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(api);
    if (await checkServerHealth(api, isLan ? 3000 : 6000)) {
      useAppStore.getState().setBaseUrl(api);
      rememberServer(api);
      return true;
    }
  }
  return false;
}
