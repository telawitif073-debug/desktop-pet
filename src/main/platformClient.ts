import axios from 'axios';
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { loadConfig, saveConfig, type AppConfig, type PetFormat } from './config';
import { addFramesAction, addClipAction, clearPlatformActions } from './petActions';

export type PlatformAssetType = 'pet' | 'agent';

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

  /** 按平台标记或解压目录内容推断宠物形态 */
  private resolveFormat(detailFormat: unknown, installDir: string): PetFormat {
    if (detailFormat === 'pack' || detailFormat === 'live2d' || detailFormat === 'model3d' || detailFormat === 'image') {
      return detailFormat;
    }
    if (findFirstFile(installDir, (p) => /live2d-lite\.json$/i.test(p))) return 'live2d';
    if (findFirstFile(installDir, (p) => /model3\.json$/i.test(p))) return 'live2d';
    if (findFirstFile(installDir, (p) => /\.glb$|\.gltf$/i.test(p))) return 'model3d';
    if (listFiles(installDir).filter((p) => IMAGE_EXTS.test(p)).length > 1) return 'pack';
    return 'image';
  }

  /** 安装宠物时同步安装其附带动作：frames 下载 zip 注册帧序列，clip 直接登记模型动画名。
   * 单个动作失败不阻断安装 */
  private async installPetActions(petId: string): Promise<number> {
    let actions: PetActionResponse[] = [];
    try {
      const response = await axios.get(apiUrl(this.config.platform.baseUrl, `/pets/${petId}/actions`), {
        headers: this.headers,
      });
      actions = Array.isArray(response.data) ? (response.data as PetActionResponse[]) : [];
    } catch {
      return 0;
    }

    let installed = 0;
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
        console.error(`Failed to install pet action "${action.name}":`, e);
      }
    }
    return installed;
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

      // 入口文件：Live2D 优先 model3.json（真 Cubism 模型），兜底 live2d-lite.json（AI 生成分层包）；3D 取 glb/gltf；其余优先 main.* 主图，回退第一张图片
      const format = this.resolveFormat(downloaded.detail.format, installDir);
      const pickers: Array<(p: string) => boolean> = format === 'live2d'
        ? [(p) => /model3\.json$/i.test(p), (p) => /live2d-lite\.json$/i.test(p)]
        : format === 'model3d'
          ? [(p) => /\.(glb|gltf)$/i.test(p)]
          : [(p) => /main\.(png|jpe?g|gif|webp)$/i.test(p), (p) => IMAGE_EXTS.test(p)];
      let installedPath: string | null = null;
      for (const predicate of pickers) {
        installedPath = findFirstFile(installDir, predicate);
        if (installedPath) break;
      }
      if (!installedPath) installedPath = findFirstFile(installDir, () => true);
      if (!installedPath) throw new Error('资源文件为空，无法安装');

      // 随宠物安装附带动作（frames/clip）
      const actionsCount = await this.installPetActions(id);

      saveConfig({
        petAssetPath: installedPath,
        petAssetName: downloaded.detail.name,
        petAssetId: id,
        petAssetFormat: format,
      });

      fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
      return { success: true, type, id, path: installedPath, actionsCount };
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
    if (!installedPath || !fs.existsSync(installedPath)) return null;
    const mimeTypes: Record<string, string> = {
      '.gif': 'image/gif',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
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
