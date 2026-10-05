/**
 * 平台 API 客户端：auth/login、资源列表/详情/下载、/sync/* 同步。
 * 所有方法从 useAppStore 读取 token 与 baseUrl，401 时清登录态。
 */
import { useAppStore } from '../store/appStore';
import type { AssetItem, VoiceConfig } from '../types';

function buildUrl(path: string): string {
  const base = useAppStore.getState().baseUrl.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

function authHeaders(): Record<string, string> {
  const { token } = useAppStore.getState();
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 用 refreshToken 静默换新双令牌。并发 401 共享同一个刷新 Promise（单飞）：
 * 后端每次刷新都轮换 refreshToken，并发各刷各的会互相踩踏导致误登出。
 */
let refreshing: Promise<string> | null = null;

function refreshAccessToken(): Promise<string> {
  if (!refreshing) {
    refreshing = (async (): Promise<string> => {
      const rt = useAppStore.getState().refreshToken;
      if (!rt) throw new ApiError(401, '缺少 refreshToken');
      // 直接走原生 fetch，不能经过 request()，否则 401 会递归
      const res = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) throw new ApiError(res.status, 'refresh failed');
      const data = (await res.json()) as LoginResult;
      useAppStore.getState().setAuth(data.user, data.accessToken, data.refreshToken);
      return data.accessToken;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  const extra = init?.headers as Record<string, string> | undefined;
  if (extra) Object.assign(headers, extra);
  // FormData（音色发布）：必须删掉 JSON 头，让 fetch 自动生成 multipart boundary
  if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
    delete headers['Content-Type'];
  }
  const res = await fetch(buildUrl(path), { ...init, headers });
  if (res.status === 401) {
    // access token 过期：有 refresh token 且不是 auth 接口本身、且本轮尚未刷新过时，
    // 静默换新并重放原请求一次；刷新失败（refresh 也过期/无效）或重放仍 401 才登出
    const canRefresh =
      !retried &&
      !path.startsWith('/auth/') &&
      !!useAppStore.getState().refreshToken;
    if (canRefresh) {
      try {
        await refreshAccessToken();
        return request<T>(path, init, true);
      } catch {
        // 落到下面的登出分支
      }
    }
    useAppStore.getState().logout();
    throw new ApiError(401, '登录已过期，请重新登录');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// --- 静态资源 URL（/uploads 公开直出，无需鉴权） ---
export function assetUrl(fileUrl: string): string {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  const root = useAppStore.getState().baseUrl.replace(/\/api\/?$/, '');
  return `${root}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
}

// --- 鉴权 ---
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; username: string; role?: string };
}

export async function login(identifier: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export interface SendCodeResult {
  sent: boolean;
  /** 仅开发环境（服务端未配邮件服务且开启回显）返回，便于联调注册 */
  devCode?: string;
  devMode?: boolean;
}

/** 发送邮箱验证码（purpose=register 注册 / login 验证码登录） */
export async function sendCode(email: string, purpose: 'register' | 'login'): Promise<SendCodeResult> {
  return request<SendCodeResult>('/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ email, purpose }),
  });
}

/** 验证码注册（DeepSeek 式）：验证码 + 密码（≥8 位），用户名缺省由服务端取邮箱前缀 */
export async function register(email: string, code: string, password: string, username?: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, code, password, ...(username ? { username } : {}) }),
  });
}

/** 邮箱验证码登录（免密码） */
export async function loginByEmailCode(email: string, code: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
}

// --- 智能体技能（平台代理，登录可用；数据已归一化为中文 JSON） ---
export async function toolWeather(city: string, day = 0): Promise<Record<string, unknown>> {
  const usp = new URLSearchParams({ city });
  if (day) usp.set('day', String(day));
  return request<Record<string, unknown>>(`/tools/weather?${usp.toString()}`);
}

export async function toolStock(q: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/tools/stock?q=${encodeURIComponent(q)}`);
}

export async function toolFootball(date?: string): Promise<Record<string, unknown>> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<Record<string, unknown>>(`/tools/football${q}`);
}

// --- 资源列表（智能体） ---
export interface ListAssetParams {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  sort?: string;
}

export async function listAssets(params?: ListAssetParams | string): Promise<{ items: AssetItem[]; total: number }> {
  let query = '';
  if (typeof params === 'string') {
    query = params ? `?search=${encodeURIComponent(params)}` : '';
  } else if (params) {
    const usp = new URLSearchParams();
    if (params.search) usp.set('search', params.search);
    if (params.status) usp.set('status', params.status);
    if (params.page) usp.set('page', String(params.page));
    if (params.limit) usp.set('limit', String(params.limit));
    if (params.sort) usp.set('sort', params.sort);
    query = usp.toString() ? `?${usp.toString()}` : '';
  }
  const res = await request<{ items: AssetItem[]; total: number }>(`/agents${query}`);
  // 平台返回 items/total，兼容直接返回数组
  return Array.isArray(res) ? { items: res, total: res.length } : res;
}

// --- 管理员审核（需 admin 角色，后端 RolesGuard 校验） ---
export async function approveAsset(id: string): Promise<void> {
  await request(`/admin/approve/agent/${id}`, { method: 'POST' });
}

export async function rejectAsset(id: string): Promise<void> {
  await request(`/admin/reject/agent/${id}`, { method: 'POST' });
}

export async function getAssetDetail(id: string): Promise<AssetItem> {
  return request<AssetItem>(`/agents/${id}`);
}

/** 下载资源：触发后端计数并返回可直接使用的文件 URL */
export async function downloadAsset(id: string): Promise<{ url: string; version?: string }> {
  const res = await request<{ url: string; version?: string }>(`/agents/${id}/download`, { method: 'POST' });
  const { baseUrl } = useAppStore.getState();
  const root = baseUrl.replace(/\/api\/?$/, '');
  return { ...res, url: new URL(res.url, `${root}/`).toString() };
}

// --- 音色资产（商店「音色」板块；返回结构与 agents 不同，独立一套） ---
export interface VoiceAssetItem {
  id: string;
  name: string;
  description: string | null;
  configSchema: VoiceConfig;
  fileUrl: string | null;
  version: string;
  downloads: number;
  rating?: string | number | null;
  status?: 'pending' | 'approved' | 'rejected';
  author?: { id: string; username?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface DownloadVoiceResult {
  config: VoiceConfig;
  sampleUrl: string | null;
  name: string;
  version: string;
  downloads: number;
}

export async function listVoices(params?: ListAssetParams): Promise<{ items: VoiceAssetItem[]; total: number }> {
  let query = '';
  if (params) {
    const usp = new URLSearchParams();
    if (params.search) usp.set('search', params.search);
    if (params.page) usp.set('page', String(params.page));
    if (params.limit) usp.set('limit', String(params.limit));
    if (params.sort) usp.set('sort', params.sort);
    query = usp.toString() ? `?${usp.toString()}` : '';
  }
  return request<{ items: VoiceAssetItem[]; total: number }>(`/voices${query}`);
}

export async function getVoiceDetail(id: string): Promise<VoiceAssetItem> {
  return request<VoiceAssetItem>(`/voices/${id}`);
}

/** 我发布的音色（含待审核/驳回，登录态） */
export async function myVoices(): Promise<VoiceAssetItem[]> {
  const res = await request<VoiceAssetItem[] | { items: VoiceAssetItem[] }>('/voices/mine');
  return Array.isArray(res) ? res : res.items;
}

/** 安装音色：计数 + 返回配置（不含 Key）；sampleUrl 转绝对直链 */
export async function downloadVoice(id: string): Promise<DownloadVoiceResult> {
  const res = await request<DownloadVoiceResult>(`/voices/${id}/download`, { method: 'POST' });
  const root = useAppStore.getState().baseUrl.replace(/\/api\/?$/, '');
  return {
    ...res,
    sampleUrl: res.sampleUrl ? new URL(res.sampleUrl, `${root}/`).toString() : null,
  };
}

export interface PublishVoiceInput {
  name: string;
  description?: string;
  version?: string;
  /** 音色配置 JSON（engine/voiceId/...，严禁携带任何 Key） */
  config: VoiceConfig;
  /** 可选试听样本直链（http(s) 的 mp3/m4a/aac/wav，≤5MB，由后端代拉校验入库） */
  sampleUrl?: string;
}

/** 发布音色（multipart/form-data；config 以 JSON 字符串随表单提交） */
export async function publishVoice(input: PublishVoiceInput): Promise<VoiceAssetItem> {
  const form = new FormData();
  form.append('name', input.name);
  if (input.description) form.append('description', input.description);
  form.append('version', input.version || '1.0.0');
  form.append('configSchema', JSON.stringify(input.config));
  if (input.sampleUrl) form.append('sampleUrl', input.sampleUrl);
  return request<VoiceAssetItem>('/voices', { method: 'POST', body: form });
}

export async function deleteVoice(id: string): Promise<void> {
  await request(`/voices/${id}`, { method: 'DELETE' });
}

export async function reviewVoice(id: string, rating: number, comment?: string): Promise<unknown> {
  return request(`/voices/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ rating, comment }),
  });
}

export interface DepVerifyResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

/** 多智能体外部依赖连通性测试：后端代发 GET 探测（8s 超时），规避设备端 CORS */
export async function verifyDependency(options: {
  url: string;
  protocol?: string;
  auth?: string;
  apiKey?: string;
}): Promise<DepVerifyResult> {
  return request<DepVerifyResult>('/agents/deps/verify', {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

// --- 用户数据云同步（与桌面端 cloudSync.ts 对齐的 kind 命名） ---
type SyncKind = 'config' | 'chat-history' | 'library';

export async function syncGet(kind: SyncKind): Promise<{ data: unknown; updatedAt: string | null }> {
  return request<{ data: unknown; updatedAt: string | null }>(`/sync/${kind}`);
}

export async function syncPut(kind: SyncKind, data: unknown): Promise<{ updatedAt: string }> {
  return request<{ updatedAt: string }>(`/sync/${kind}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

// --- 多智能体运行时（编排接口；配置在智能体档案 multiConfig 里，由服务端解密注入） ---
export interface MultiChatTraceItem {
  stage: string;
  agentId?: string;
  model?: string;
  input?: string;
  output?: string;
  latencyMs?: number;
  error?: string;
}

/** 幂等获取多智能体会话：同一智能体档案复用一条会话 */
export async function ensureMultiSession(
  agentProfileId: string,
  title?: string,
): Promise<{ id: string; title: string; messageCount?: number; createdAt: string }> {
  return request<{ id: string; title: string; messageCount?: number; createdAt: string }>(
    '/multi-chat/sessions',
    { method: 'POST', body: JSON.stringify({ agentProfileId, title }) },
  );
}

/** 多智能体会话列表（含消息数，便于排查） */
export async function listMultiSessions(): Promise<
  Array<{ id: string; agentProfileId: string; title: string; messageCount: number; updatedAt: string }>
> {
  return request<Array<{ id: string; agentProfileId: string; title: string; messageCount: number; updatedAt: string }>>(
    '/multi-chat/sessions',
  );
}

/** 会话历史消息（assistant 消息 meta.trace 为协同轨迹） */
export async function listMultiMessages(
  sessionId: string,
): Promise<
  Array<{
    id: string;
    role: string;
    agentId: string | null;
    content: string;
    latencyMs: number | null;
    error: string | null;
    meta: { trace?: MultiChatTraceItem[] } | null;
    createdAt: string;
  }>
> {
  return request(`/multi-chat/sessions/${sessionId}/messages`);
}

/** 发送消息并执行多智能体编排（服务端返回最终答复与协同轨迹） */
export async function multiChatSend(
  sessionId: string,
  content: string,
  history?: Array<{ role: string; content: string }>,
): Promise<{
  id: string;
  role: string;
  content: string;
  latencyMs: number | null;
  meta: { trace?: MultiChatTraceItem[] } | null;
}> {
  return request(`/multi-chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, history: history ?? [] }),
  });
}
