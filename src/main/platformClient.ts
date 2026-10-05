import axios, { isAxiosError } from 'axios';
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { loadConfig, saveConfig, type AppConfig, type InstalledVoice, type VoiceConfig } from './config';

export type PlatformAssetType = 'agent' | 'voice';

/** 渲染端经 IPC 传来的待上传文件（结构化克隆：原始文件名 + 字节） */
export interface UploadFilePayload {
  name: string;
  /** 渲染端 File.type（可为空；最终 MIME 以后缀映射为准，需与后端白名单一致） */
  type?: string;
  bytes: Uint8Array;
}

/** 工作台各页发布的载荷（智能体 → POST /agents，音色 → POST /voices） */
export interface PublishPayload {
  type: PlatformAssetType;
  /** 纯文本字段（name/description/category/tags(JSON)/version/configSchema/dependencies 等） */
  fields: Record<string, string>;
  /** 资源文件（智能体配置 JSON 等） */
  file?: UploadFilePayload;
  /** 封面图（可选） */
  preview?: UploadFilePayload;
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
  status: string;
  /** 智能体：配置文件地址 */
  fileUrl?: string;
  /** 兼容旧字段（新契约不再返回） */
  format?: unknown;
  [key: string]: unknown;
}

interface DownloadResponse {
  url: string;
  downloads: number;
  version?: string;
}

/** 本地安装目录名（智能体 / 音色资源字节） */
function assetPath(type: PlatformAssetType): string {
  return type === 'agent' ? 'agents' : 'voices';
}

/** 平台接口资源路径 */
function apiPath(type: PlatformAssetType): string {
  return type === 'agent' ? 'agents' : 'voices';
}

function assertAssetType(type: string): asserts type is PlatformAssetType {
  if (type !== 'agent' && type !== 'voice') {
    throw new Error('资源类型必须是 agent 或 voice');
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
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/${apiPath(type)}`), {
      params: { search: query, page, limit: 20 },
      headers: this.headers,
    });
    return response.data;
  }

  async getDetail(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/${apiPath(type)}/${id}`), {
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

  // ── 鉴权状态（工作台「上传/发布」与平台 Web 窗口共用同一份令牌）──

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

  // ── 发布资源（工作台「上传/发布」工作区 → 平台 POST /agents | /voices）──

  /** 上传文件 → multipart 段（MIME 以后缀映射为准，需与后端白名单严格匹配） */
  private toBlobPart(file: UploadFilePayload): Blob {
    const extension = path.extname(file.name).toLowerCase();
    const mime = MIME_BY_EXTENSION[extension] ?? file.type ?? 'application/octet-stream';
    return new Blob([Buffer.from(file.bytes)], { type: mime });
  }

  /** 提交资源到平台（等待管理员审核）：智能体 / 音色走单文件 multipart */
  async publish(payload: PublishPayload) {
    assertAssetType(payload.type);
    const form = new FormData();
    if (payload.file) form.append('file', this.toBlobPart(payload.file), payload.file.name);
    if (payload.preview) form.append('preview', this.toBlobPart(payload.preview), payload.preview.name);
    for (const [key, value] of Object.entries(payload.fields)) {
      if (value !== undefined && value !== null && value !== '') form.append(key, value);
    }
    return this.postForm(payload.type === 'agent' ? '/agents' : '/voices', form);
  }

  /** multipart 提交（大文件不做本地体积限制，超时给足） */
  private async postForm(resourcePath: string, form: FormData) {
    try {
      const response = await axios.post(apiUrl(this.config.platform.baseUrl, resourcePath), form, {
        headers: this.headers,
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
  private syncPath(kind: 'config' | 'chat_history'): string {
    return `/sync/${kind === 'chat_history' ? 'chat-history' : 'config'}`;
  }

  async syncGet(kind: 'config' | 'chat_history') {
    const response = await axios.get(apiUrl(this.config.platform.baseUrl, this.syncPath(kind)), {
      headers: this.headers,
    });
    return response.data as { data: unknown; updatedAt: string | null };
  }

  async syncPut(kind: 'config' | 'chat_history', data: unknown) {
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
      apiUrl(this.config.platform.baseUrl, `/${apiPath(type)}/${id}/download`),
      undefined,
      { headers: this.headers },
    );
    const fileUrl = new URL(download.data.url, `${this.config.platform.baseUrl}/`).toString();
    const file = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      headers: this.headers,
    });
    const extension = path.extname(new URL(fileUrl).pathname) || '.json';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-platform-'));
    const tempPath = path.join(tempDir, `${id}${extension}`);
    fs.writeFileSync(tempPath, Buffer.from(file.data));
    return { tempPath, detail, downloads: download.data.downloads };
  }

  async install(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const downloaded = await this.download(type, id);
    const installRoot = path.join(app.getPath('userData'), assetPath(type));
    const installDir = path.join(installRoot, id);
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });

    if (isZipFile(downloaded.tempPath)) {
      new AdmZip(downloaded.tempPath).extractAllTo(installDir, true);
    } else {
      fs.copyFileSync(downloaded.tempPath, path.join(installDir, path.basename(downloaded.tempPath)));
    }

    let installedPath = findFirstFile(installDir, (filePath) => /\.json$/i.test(filePath));
    if (!installedPath) installedPath = findFirstFile(installDir, () => true);
    if (!installedPath) throw new Error('资源文件为空，无法安装');

    if (type === 'agent') {
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
    } else {
      // 音色：把资源内的配置登记进本机音色库
      const config = this.readVoiceConfig(installedPath, downloaded.detail);
      const voices = (this.config.downloadedVoices ?? []).filter((v) => v.id !== id);
      const installed: InstalledVoice = {
        id,
        name: typeof downloaded.detail.name === 'string' && downloaded.detail.name ? downloaded.detail.name : id,
        config,
        installedAt: Date.now(),
        fromStore: true,
      };
      saveConfig({ downloadedVoices: [...voices, installed] });
    }

    fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
    return { success: true, type, id, path: installedPath };
  }

  /** 从安装包内读取音色配置（configSchema 对象，或配置文件本身） */
  private readVoiceConfig(installedPath: string, detail: AssetResponse): VoiceConfig {
    let raw: unknown = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
      raw = (parsed as { config?: unknown })?.config ?? (parsed as { configSchema?: unknown })?.configSchema ?? parsed;
    } catch {
      raw = (detail as { config?: unknown }).config ?? null;
    }
    const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceConfig>;
    const engine: VoiceConfig['engine'] =
      cfg.engine === 'gptsovits' ? 'gptsovits' : cfg.engine === 'system' ? 'system' : 'cloud';
    return {
      engine,
      voiceId: typeof cfg.voiceId === 'string' ? cfg.voiceId : '',
      voiceName: typeof cfg.voiceName === 'string' ? cfg.voiceName : undefined,
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      model: typeof cfg.model === 'string' ? cfg.model : undefined,
      instructions: typeof cfg.instructions === 'string' ? cfg.instructions : undefined,
      sampleText: typeof cfg.sampleText === 'string' ? cfg.sampleText : undefined,
      refAudioPath: typeof cfg.refAudioPath === 'string' ? cfg.refAudioPath : undefined,
      promptText: typeof cfg.promptText === 'string' ? cfg.promptText : undefined,
      promptLang: typeof cfg.promptLang === 'string' ? cfg.promptLang : undefined,
      textLang: typeof cfg.textLang === 'string' ? cfg.textLang : undefined,
    };
  }

  async uninstall(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const installDir = path.join(app.getPath('userData'), assetPath(type), id);
    fs.rmSync(installDir, { recursive: true, force: true });

    if (type === 'agent') {
      if (this.config.installedAgentId === id) {
        saveConfig({
          agentType: 'default',
          agentConfigPath: undefined,
          installedAgentId: undefined,
          installedAgentConfig: undefined,
        });
      }
    } else {
      saveConfig({
        downloadedVoices: (this.config.downloadedVoices ?? []).filter((v) => v.id !== id),
        ...(this.config.activeCloudVoiceId === id ? { activeCloudVoiceId: '' } : {}),
      });
    }
    return { success: true };
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
