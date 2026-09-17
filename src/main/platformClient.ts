import axios from 'axios';
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { loadConfig, saveConfig, type AppConfig } from './config';

export type PlatformAssetType = 'pet' | 'agent';

interface AssetResponse {
  id: string;
  name: string;
  fileUrl: string;
  status: string;
  [key: string]: unknown;
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

    let installedPath = findFirstFile(installDir, (filePath) => type === 'pet'
      ? /\.(png|jpe?g|gif|webp)$/i.test(filePath)
      : /\.json$/i.test(filePath));
    if (!installedPath) installedPath = findFirstFile(installDir, () => true);
    if (!installedPath) throw new Error('资源文件为空，无法安装');

    if (type === 'pet') {
      saveConfig({ petAssetPath: installedPath, petAssetName: downloaded.detail.name });
    } else {
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
    }

    fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
    return { success: true, type, id, path: installedPath };
  }

  async uninstall(type: PlatformAssetType, id: string) {
    assertAssetType(type);
    const installDir = path.join(app.getPath('userData'), assetPath(type), id);
    fs.rmSync(installDir, { recursive: true, force: true });

    // 若删除的是当前生效的资源，复位配置（宠物恢复默认形象，智能体恢复 default）
    if (type === 'pet') {
      const current = this.config.petAssetPath;
      if (current && path.dirname(path.resolve(current)).toLowerCase() === installDir.toLowerCase()) {
        saveConfig({ petAssetPath: undefined, petAssetName: undefined });
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
    if (!mimeType) return null;
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