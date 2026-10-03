import axios, { isAxiosError } from 'axios';
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { loadConfig, saveConfig, type AppConfig, type PetFormat } from './config';
import { addFramesAction, addClipAction, clearPlatformActions } from './petActions';
import { readBuiltinCover } from './builtinPets';
import { pickPetAppearance } from './petPack';

export type PlatformAssetType = 'pet' | 'agent' | 'voice';

/** 渲染端经 IPC 传来的待上传文件（结构化克隆：原始文件名 + 字节） */
export interface UploadFilePayload {
  name: string;
  /** 渲染端 File.type（可为空；最终 MIME 以后缀映射为准，需与后端白名单一致） */
  type?: string;
  bytes: Uint8Array;
}

/** 宠物附带动作元数据（与 actionFiles 按下标对齐，见 publish 注释） */
export interface PublishActionMeta {
  name: string;
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  clipName?: string;
}

/** 宠工坊各页发布的载荷（对应平台 POST /pets、POST /agents、POST /voices） */
export interface PublishPayload {
  type: PlatformAssetType;
  /** 纯文本字段（name/description/category/format/tags(JSON)/configSchema(JSON)/dependencies(JSON) 等） */
  fields: Record<string, string>;
  /** 主资源文件；智能体结构化配置由渲染端生成 JSON 后放入 */
  file?: UploadFilePayload;
  /** 宠物预览图（多图包 / Live2D / 3D 必需） */
  preview?: UploadFilePayload;
  /** 附带动作的帧图 zip（顺序须与 actionsMeta 中需要文件的项一致） */
  actionFiles?: UploadFilePayload[];
  actionsMeta?: PublishActionMeta[];
}

export interface PlatformAuthState {
  loggedIn: boolean;
  user: AppConfig['platform']['user'];
  baseUrl: string;
}

/** 扩展名 → MIME：必须与后端 upload-validation 白名单一致（MIME 与后缀不匹配会被拒） */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

/** 平台接口错误 → 可读中文（401/403 给出重新登录指引，连接失败指出平台服务未启动） */
export function platformErrorText(error: unknown): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as { message?: unknown } | undefined;
    const raw = data?.message;
    const text = Array.isArray(raw) ? raw.join('；') : typeof raw === 'string' ? raw : '';
    if (text) return text;
    const status = error.response?.status;
    if (status === 401 || status === 403) return '登录状态已失效：请重新登录后再上传';
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNABORTED') {
      return '无法连接平台服务：请在「资源中心」窗口确认平台服务已启动后重试';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

interface AssetResponse {
  id: string;
  name: string;
  fileUrl: string;
  status: string;
  /** 宠物资源形态（image/pack/live2d/model3d） */
  format?: unknown;
  [key: string]: unknown;
}

/** 宠物附带动作（GET /pets/:id/actions 返回） */
interface PetActionResponse {
  id: string;
  name: string;
  kind?: string;
  clipName?: string | null;
  interaction?: string | null;
}

interface DownloadResponse {
  url: string;
  downloads: number;
}

function assetPath(type: PlatformAssetType): string {
  return type === 'pet' ? 'pets' : 'agents';
}

function assertAssetType(type: string): asserts type is PlatformAssetType {
  if (type !== 'pet' && type !== 'agent') {
    throw new Error('资源类型必须是 pet 或 agent');
  }
}

function apiUrl(baseUrl: string, resourcePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${resourcePath.replace(/^\//, '')}`;
}

function findFirstFile(directory: string, predicate: (filePath: string) => boolean): string | null {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstFile(entryPath, predicate);
      if (nested) return nested;
    } else if (predicate(entryPath)) {
      return entryPath;
    }
  }
  return null;
}

/** 递归收集目录下全部文件（含子目录），用于动作包解压后的帧图扫描 */
function listFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(entryPath));
    else result.push(entryPath);
  }
  return result;
}

function isZipFile(filePath: string, contentType?: string): boolean {
  if (contentType?.includes('zip')) return true;
  const header = Buffer.alloc(2);
  const file = fs.openSync(filePath, 'r');
  try {
    fs.readSync(file, header, 0, 2, 0);
  } finally {
    fs.closeSync(file);
  }
  return header[0] === 0x50 && header[1] === 0x4b;
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp)$/i;

export class PlatformClient {
  private get config(): AppConfig {
    return loadConfig();
  }

  private get headers() {
    const token = this.config.platform.accessToken;
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  async search(type: PlatformAssetType, query: string, page = 1) {
    assertAssetType(type);
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/${assetPath(type)}`), {
      params: { search: query, page, limit: 20 },
      headers: this.headers,
    });
    return response.data;
  }

  async getDetail(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/${assetPath(type)}/${id}`), {
      headers: this.headers,
    });
    return response.data as AssetResponse;
  }

  async login(identifier: string, password: string) {
    const response = await axios.post(apiUrl(this.config.platform.baseUrl, '/auth/login'), {
      identifier,
      password,
    });
    const data = response.data as { accessToken: string; refreshToken: string; user: AppConfig['platform']['user'] };
    saveConfig({
      platform: {
        ...this.config.platform,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      },
    });
    return { user: data.user };
  }

  logout() {
    saveConfig({
      platform: {
        ...this.config.platform,
        accessToken: '',
        refreshToken: '',
        user: null,
      },
    });
    return { success: true };
  }

  // ── 鉴权状态（宠工坊「上传/发布」与平台 Web 窗口共用同一份令牌）──

  getAuthState(): PlatformAuthState {
    const platform = this.config.platform;
    return { loggedIn: !!platform.accessToken, user: platform.user ?? null, baseUrl: platform.baseUrl };
  }

  /** 平台 Web 窗口登录/续期后把令牌同步到主进程（桌面端下载/安装/上传都读这里） */
  setTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
    user?: AppConfig['platform']['user'];
  }): PlatformAuthState {
    saveConfig({
      platform: {
        ...this.config.platform,
        accessToken: tokens.accessToken || '',
        refreshToken: tokens.refreshToken ?? this.config.platform.refreshToken ?? '',
        user: tokens.user ?? this.config.platform.user ?? null,
      },
    });
    return this.getAuthState();
  }

  // ── 发布资源（宠工坊「上传/发布」工作区 → 平台 POST /pets | /agents）──

  /** 上传文件 → multipart 段（MIME 以后缀映射为准，需与后端白名单严格匹配） */
  private toBlobPart(file: UploadFilePayload): Blob {
    const extension = path.extname(file.name).toLowerCase();
    const mime = MIME_BY_EXTENSION[extension] ?? file.type ?? 'application/octet-stream';
    return new Blob([Buffer.from(file.bytes)], { type: mime });
  }

  /**
   * 提交资源到平台（等待管理员审核）：宠物 / 智能体 / 音色三类共用同一条 multipart 通道。
   * 注意：后端按下标取 actionFiles（metas[i] ↔ actionFiles[i]），因此附带动作必须在渲染端
   * 先排「帧图 zip 动作」再排「模型 clip 动作」，否则取到空文件会报「动作缺少 zip」。
   */
  async publish(payload: PublishPayload) {
    const form = new FormData();
    if (payload.file) form.append('file', this.toBlobPart(payload.file), payload.file.name);
    if (payload.preview) form.append('preview', this.toBlobPart(payload.preview), payload.preview.name);
    for (const actionFile of payload.actionFiles ?? []) {
      form.append('actionFiles', this.toBlobPart(actionFile), actionFile.name);
    }
    if (payload.actionsMeta?.length) form.append('actionsMeta', JSON.stringify(payload.actionsMeta));
    for (const [key, value] of Object.entries(payload.fields)) {
      if (value !== undefined && value !== null && value !== '') form.append(key, value);
    }
    const resourcePath = payload.type === 'pet' ? '/pets' : payload.type === 'agent' ? '/agents' : '/voices';
    try {
      const response = await axios.post(apiUrl(this.config.platform.baseUrl, resourcePath), form, {
        headers: this.headers,
        // 大文件（上限 50MB）不做本地体积限制，超时给足
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180_000,
      });
      return response.data as { id?: string; name?: string; status?: string };
    } catch (error) {
      throw new Error(platformErrorText(error));
    }
  }

  // --- 用户数据云同步（/api/sync/*，LLM Key 由服务端 AES 加密落库） ---
  /** kind 用下划线（客户端内部标识），服务端路由用连字符（REST 惯例） */
  private syncPath(kind: 'config' | 'pet_state' | 'chat_history'): string {
    return `/sync/${kind === 'pet_state' ? 'pet-state' : kind === 'chat_history' ? 'chat-history' : 'config'}`;
  }

  async syncGet(kind: 'config' | 'pet_state' | 'chat_history') {
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, this.syncPath(kind)), {
      headers: this.headers,
    });
    return response.data as { data: unknown; updatedAt: string | null };
  }

  async syncPut(kind: 'config' | 'pet_state' | 'chat_history', data: unknown) {
    const response = await axios.put(
      apiUrl(this.config.platform.baseUrl, this.syncPath(kind)),
      { data },
      { headers: this.headers },
    );
    return response.data as { updatedAt: string };
  }

  async download(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const detail = await this.getDetail(type, id);
    const download = await axios.post<DownloadResponse>(
      apiUrl(this.config.platform.baseUrl, `/${assetPath(type)}/${id}/download`),
      undefined,
      { headers: this.headers },
    );
    const fileUrl = new URL(download.data.url, `${this.config.platform.baseUrl}/`).toString();
    const file = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      headers: this.headers,
    });
    const extension = path.extname(new URL(fileUrl).pathname) || (type === 'agent' ? '.json' : '.asset');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-platform-'));
    const tempPath = path.join(tempDir, `${id}${extension}`);
    fs.writeFileSync(tempPath, Buffer.from(file.data));
    return { tempPath, detail, downloads: download.data.downloads };
  }

  /** 安装宠物时同步安装其附带动作：frames 下载 zip 注册帧序列，clip 直接登记模型动画名。
   * 单个动作失败不阻断安装，但**必须回报失败清单**——过去只 `console.error`，
   * 一旦动作数超过配额，安装会静默缩水（少装的动作用户完全看不见）。 */
  private async installPetActions(
    petId: string,
  ): Promise<{ installed: number; failures: Array<{ name: string; reason: string }> }> {
    let actions: PetActionResponse[] = [];
    try {
      const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/pets/${petId}/actions`), {
        headers: this.headers,
      });
      actions = Array.isArray(response.data) ? (response.data as PetActionResponse[]) : [];
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`Failed to fetch pet actions for "${petId}": ${reason}`);
      return { installed: 0, failures: [{ name: '动作列表', reason: `拉取动作列表失败：${reason}` }] };
    }

    let installed = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    for (const action of actions) {
      const interaction = action.interaction === 'feed' || action.interaction === 'rest' || action.interaction === 'play'
        ? action.interaction
        : 'none';
      try {
        if (action.kind === 'clip' && action.clipName) {
          addClipAction(action.name, action.clipName, { petAssetId: petId, interaction });
        } else {
          const download = await axios.post<{ url: string }>(
            apiUrl(this.config.platform.baseUrl, `/pets/${petId}/actions/${action.id}/download`),
            undefined,
            { headers: this.headers },
          );
          const fileUrl = new URL(download.data.url, `${this.config.platform.baseUrl}/`).toString();
          const file = await axios.get<ArrayBuffer>(fileUrl, { responseType: 'arraybuffer', headers: this.headers });
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-action-'));
          try {
            const tempPath = path.join(tempDir, `${action.id}.zip`);
            fs.writeFileSync(tempPath, Buffer.from(file.data));
            if (!isZipFile(tempPath)) throw new Error('动作包不是有效的 zip');
            const extractDir = path.join(tempDir, 'extract');
            new AdmZip(tempPath).extractAllTo(extractDir, true);
            const frames = listFiles(extractDir)
              .filter((p) => IMAGE_EXTS.test(p))
              .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
            if (!frames.length) throw new Error('动作包中未找到帧图（需要 png/jpg/gif/webp，1~30 张）');
            addFramesAction(
              action.name,
              frames.map((p) => ({ filename: path.basename(p), data: fs.readFileSync(p) })),
              { petAssetId: petId, interaction },
            );
          } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
        installed += 1;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ name: action.name, reason });
        console.error(`Failed to install pet action "${action.name}": ${reason}`);
      }
    }
    return { installed, failures };
  }

  async install(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const downloaded = await this.download(type, id);
    const installRoot = path.join(app.getPath('userData'), assetPath(type));
    const installDir = path.join(installRoot, id);
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });

    const contentType = undefined;
    if (isZipFile(downloaded.tempPath, contentType)) {
      new AdmZip(downloaded.tempPath).extractAllTo(installDir, true);
    } else {
      fs.copyFileSync(downloaded.tempPath, path.join(installDir, path.basename(downloaded.tempPath)));
    }

    if (type === 'pet') {
      // 动作随宠物：换宠物时清除旧宠物的资源库动作与互动绑定
      clearPlatformActions();

      // 入口文件：按「宠物本体资源分类标准」（src/shared/petResource）挑本体入口。
      // 过去是「main.* → 任意图片 → 目录里第一个文件」的 glob 兜底，会把图标/背景/截图/
      // 表情包当成宠物本体装进来；现在若没有「够格的本体」则**显式报错，绝不回落**。
      const pick = pickPetAppearance(installDir, downloaded.detail.format);
      if (!pick.ok || !pick.path) {
        const rejected = pick.evaluation.rejected
          .slice(0, 5)
          .map((r) => `${r.path}（${r.role}：${r.evidence[0]}）`)
          .join('；');
        throw new Error(
          `宠物资源包校验未通过：${pick.errors.join('；')}` + (rejected ? `｜被拒资源：${rejected}` : ''),
        );
      }
      const format = pick.format;
      const installedPath = pick.path;

      // 随宠物安装附带动作（frames/clip）
      const { installed: actionsCount, failures: actionsFailed } = await this.installPetActions(id);

      saveConfig({
        petAssetPath: installedPath,
        petAssetName: downloaded.detail.name,
        petAssetId: id,
        petAssetFormat: format,
        // 平台宠物与内置演示宠物互斥：装平台资源即让出内置形象
        builtinPet: undefined,
      });

      fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
      return {
        success: true, type, id, path: installedPath, actionsCount,
        // 有动作没装上时一并回报（过去被静默吞掉，用户只会觉得"动作少了一堆"）
        ...(actionsFailed.length ? { actionsFailed } : {}),
      };
    }

    let installedPath = findFirstFile(installDir, (filePath) => /\.json$/i.test(filePath));
    if (!installedPath) installedPath = findFirstFile(installDir, () => true);
    if (!installedPath) throw new Error('资源文件为空，无法安装');

    let agentConfig: unknown = null;
    if (installedPath.endsWith('.json')) {
      try {
        agentConfig = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
      } catch {
        agentConfig = null;
      }
    }
    saveConfig({
      agentType: downloaded.detail.type === 'string' ? downloaded.detail.type : 'installed',
      agentConfigPath: installedPath,
      installedAgentId: id,
      installedAgentConfig: agentConfig,
    });

    fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
    return { success: true, type, id, path: installedPath };
  }

  async uninstall(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const installDir = path.join(app.getPath('userData'), assetPath(type), id);
    fs.rmSync(installDir, { recursive: true, force: true });

    // 卸载宠物：清理该宠物的资源库动作（动作随宠物，不可跨宠物使用）
    if (type === 'pet') {
      clearPlatformActions(id);
      const current = this.config.petAssetPath;
      if (current && path.dirname(path.resolve(current)).toLowerCase() === installDir.toLowerCase()) {
        saveConfig({
          petAssetPath: undefined,
          petAssetName: undefined,
          petAssetId: undefined,
          petAssetFormat: undefined,
        });
      }
    } else if (this.config.installedAgentId === id) {
      saveConfig({
        agentType: 'default',
        agentConfigPath: undefined,
        installedAgentId: undefined,
        installedAgentConfig: undefined,
      });
    }
    return { success: true };
  }

  getInstalledPet() {
    const installedPath = this.config.petAssetPath;
    const mimeTypes: Record<string, string> = {
      '.gif': 'image/gif',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    if (installedPath && fs.existsSync(installedPath)) {
      const mimeType = mimeTypes[path.extname(installedPath).toLowerCase()];
      if (!mimeType) {
        // 模型类宠物（live2d/model3d）：无位图入口，仅返回路径供渲染端走模型渲染分支
        return { path: installedPath, dataUrl: null };
      }
      return {
        path: installedPath,
        dataUrl: `data:${mimeType};base64,${fs.readFileSync(installedPath).toString('base64')}`,
      };
    }
    // 未安装平台宠物（或本地文件已丢失）：回落到内置演示宠物（离线可用）
    if (this.config.builtinPet) {
      const cover = readBuiltinCover(this.config.builtinPet);
      if (cover) return { path: cover.path, dataUrl: cover.dataUrl || null };
    }
    return null;
  }

  getInstalledAgent() {
    return {
      id: this.config.installedAgentId ?? null,
      type: this.config.agentType,
      configPath: this.config.agentConfigPath ?? null,
      config: this.config.installedAgentConfig ?? null,
    };
  }
}

export const platformClient = new PlatformClient();
