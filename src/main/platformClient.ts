import axios, { isAxiosError } from 'axios';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { loadConfig, saveConfig, type AppConfig, type PetFormat } from './config';
import { addFramesAction, addClipAction, addVideoAction, clearPlatformActions } from './petActions';
import { readBuiltinCover } from './builtinPets';
import { pickPetAppearance } from './petPack';
import {
  ACTION_PAYLOAD_DIR,
  ACTION_PAYLOAD_MANIFEST,
  actionPayloadDirName,
  migrateActionModel,
  validatePetActionModel,
  type PetActionModel,
} from '../pet';
import { buildPetPackForPublish } from './petPackPublish';

export type PlatformAssetType = 'pet' | 'agent' | 'voice';

/** 渲染端经 IPC 传来的待上传文件（结构化克隆：原始文件名 + 字节） */
export interface UploadFilePayload {
  name: string;
  /** 渲染端 File.type（可为空；最终 MIME 以后缀映射为准，需与后端白名单一致） */
  type?: string;
  bytes: Uint8Array;
}

/**
 * 随宠物包一起发布的动作（发布时由主进程注入到包内：
 * 帧图/视频写入 `pet/actions/<动作名>/`，元数据汇总成 `pet/actions.json`）。
 */
export interface PublishPackAction {
  name: string;
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  /** frames=帧图序列（file 为 zip）；clip=模型内置动画（无文件）；video=透明 webm */
  kind: 'frames' | 'clip' | 'video';
  /** kind='clip' 时的模型动画名；缺省取动作名 */
  clipName?: string;
  /** kind='frames' 的帧图 zip；kind='video' 的 webm */
  file?: UploadFilePayload;
}

/** 宠工坊各页发布的载荷（宠物 → POST /pet-packs，智能体 → POST /agents，音色 → POST /voices） */
export interface PublishPayload {
  type: PlatformAssetType;
  /** 纯文本字段（name/description/category/tags(JSON)/version/configSchema/dependencies 等） */
  fields: Record<string, string>;
  /** 宠物包 zip（宠物必填）；智能体结构化配置由渲染端生成 JSON 后放入 */
  file?: UploadFilePayload;
  /** 宠物封面图（可选；不参与本体判定） */
  preview?: UploadFilePayload;
  /** 随宠物包发布的动作（可选） */
  actions?: PublishPackAction[];
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
  /** 宠物包（POST /pet-packs）：zip 地址 / 完整性 sha256 / 体积 */
  packUrl?: string;
  packSha256?: string;
  packBytes?: number | null;
  /** 宠物合格本体类型（由服务端校验派生，不是作者填写） */
  bodyKinds?: string[];
  /** 兼容旧字段（新契约不再返回） */
  format?: unknown;
  [key: string]: unknown;
}

interface DownloadResponse {
  url: string;
  downloads: number;
  /** 宠物包下载附带（安装前做完整性校验） */
  sha256?: string;
  bytes?: number | null;
  version?: string;
}

/** 本地安装目录名：沿用 `pets`/`agents`，避免已安装宠物的识别与卸载断链 */
function assetPath(type: PlatformAssetType): string {
  return type === 'pet' ? 'pets' : 'agents';
}

/** 平台接口资源路径：宠物已由「单文件 /pets」改为「宠物包 /pet-packs」 */
function apiPath(type: PlatformAssetType): string {
  return type === 'pet' ? 'pet-packs' : type === 'agent' ? 'agents' : 'voices';
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

/** 文件 sha256（十六进制小写），用于宠物包完整性校验 */
function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 在 base 目录内安全解析相对路径（拒绝绝对路径与越界 `..`）；非法返回 null */
function safeResolve(base: string, relative: string): string | null {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(base, relative);
  const inside = path.relative(base, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return resolved;
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
   * 提交资源到平台（等待管理员审核）。
   * - **宠物**：必须是一个 zip 宠物包（POST /pet-packs）。先本地解包跑 `evaluatePetPack`
   *   （提前失败，避免白传），再按需把附带动作注入包内
   *   （帧图/视频 → `pet/actions/<动作名>/`，元数据 → `pet/actions.json`），重新打包上传；
   * - 智能体 / 音色：沿用单文件 multipart。
   */
  async publish(payload: PublishPayload) {
    if (payload.type === 'pet') return this.publishPetPack(payload);

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

  /**
   * 宠物包发布：本地组装（解包 → 预校验 → 注入动作 → 重打包，见 petPackPublish.ts）后 POST /pet-packs。
   * 本地预校验失败即抛错，**不发起上传**（避免白传几十 MB）。
   */
  private async publishPetPack(payload: PublishPayload) {
    const packFile = payload.file;
    if (!packFile) throw new Error('请选择宠物包文件（.zip）');
    if (!/\.zip$/i.test(packFile.name)) throw new Error('宠物包必须是 .zip 压缩包');
    const packed = buildPetPackForPublish(Buffer.from(packFile.bytes), payload.actions ?? []);

    const form = new FormData();
    form.append('pack', new Blob([packed], { type: 'application/zip' }), packFile.name);
    if (payload.preview) form.append('preview', this.toBlobPart(payload.preview), payload.preview.name);
    for (const [key, value] of Object.entries(payload.fields)) {
      if (value !== undefined && value !== null && value !== '') form.append(key, value);
    }
    return this.postForm('/pet-packs', form);
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
      apiUrl(this.config.platform.baseUrl, `/${apiPath(type)}/${id}/download`),
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

  /**
   * 从**已解包的宠物包内**安装动作（动作随宠物；旧的 `/pets/:id/actions` 独立接口已下线）：
   * 读 `pet/actions.json` → 迁移/校验 → 按 kind 落盘注册：
   *  - frames：`pet/actions/<动作名>/frame_*.png` 拷进 `userData/pet-actions/<id>/`；
   *  - video ：`pet/actions/<动作名>/clip.webm` 直接注册；
   *  - clip  ：模型内置动画，按名字登记（无文件）。
   * 单个动作失败不阻断安装，但**必须回报失败清单**——过去只 console.error，
   * 动作静默缩水时用户完全看不见。
   */
  private installPackActions(
    installDir: string,
    petId: string,
  ): { installed: number; failures: Array<{ name: string; reason: string }> } {
    const manifestPath = path.join(installDir, ...ACTION_PAYLOAD_MANIFEST.split('/'));
    if (!fs.existsSync(manifestPath)) return { installed: 0, failures: [] };

    let model: PetActionModel;
    try {
      const migrated = migrateActionModel(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      const check = validatePetActionModel(migrated);
      if (!check.ok) {
        return { installed: 0, failures: [{ name: ACTION_PAYLOAD_MANIFEST, reason: `动作清单非法：${check.errors.join('；')}` }] };
      }
      model = migrated as PetActionModel;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { installed: 0, failures: [{ name: ACTION_PAYLOAD_MANIFEST, reason: `解析失败：${reason}` }] };
    }

    let installed = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    const register = (name: string, run: () => void): void => {
      try {
        run();
        installed += 1;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ name, reason });
        console.error(`Failed to install pack action "${name}": ${reason}`);
      }
    };

    for (const [ref, spec] of Object.entries(model.actions ?? {})) {
      const interaction = spec.interaction ?? 'none';
      if (spec.kind === 'video') {
        const rel = spec.videoFile;
        register(ref, () => {
          if (!rel) throw new Error('video 动作缺少 videoFile');
          const file = safeResolve(installDir, rel);
          if (!file || !fs.existsSync(file)) throw new Error(`缺少视频文件：${rel}`);
          addVideoAction(ref, { filename: path.basename(file), data: fs.readFileSync(file) }, { petAssetId: petId, interaction });
        });
      } else if (spec.kind === 'clip') {
        register(ref, () => addClipAction(ref, ref, { petAssetId: petId, interaction }));
      } else {
        register(ref, () => {
          const dirName = actionPayloadDirName(ref);
          const dir = path.join(installDir, ACTION_PAYLOAD_DIR, dirName);
          const frames = fs.existsSync(dir)
            ? listFiles(dir)
                .filter((p) => IMAGE_EXTS.test(p))
                .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }))
            : [];
          if (!frames.length) throw new Error(`缺少帧图目录 ${ACTION_PAYLOAD_DIR}/${dirName}/`);
          addFramesAction(
            ref,
            frames.map((p) => ({ filename: path.basename(p), data: fs.readFileSync(p) })),
            // 载荷来自已校验的宠物包（该目录刻意不参与本体判定），跳过「是否宠物本体」的启发式
            { petAssetId: petId, interaction, frameRate: spec.frameRate, skipBodyCheck: true },
          );
        });
      }
    }

    // 模型内置动画（Live2D/3D）：清单里只留名字，按名字登记
    for (const clip of model.modelClips ?? []) {
      if (model.actions && model.actions[clip]) continue;
      register(clip, () => addClipAction(clip, clip, { petAssetId: petId }));
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

    // 宠物包：先做完整性校验（不信任传输链路），再解包
    if (type === 'pet') {
      const expected = downloaded.detail.packSha256;
      if (typeof expected === 'string' && expected) {
        const actual = sha256OfFile(downloaded.tempPath);
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error('宠物包完整性校验失败（sha256 与服务端不一致），已中止安装');
        }
      }
    }

    const contentType = undefined;
    if (isZipFile(downloaded.tempPath, contentType)) {
      new AdmZip(downloaded.tempPath).extractAllTo(installDir, true);
    } else {
      fs.copyFileSync(downloaded.tempPath, path.join(installDir, path.basename(downloaded.tempPath)));
    }

    if (type === 'pet') {
      // 动作随宠物：换宠物时先清除旧宠物的资源库动作与互动绑定
      clearPlatformActions();

      // 入口文件：按「宠物本体资源分类标准」（src/pet/resource.ts）挑本体入口。
      // 过去是「main.* → 任意图片 → 目录里第一个文件」的 glob 兜底，会把图标/背景/截图/
      // 表情包当成宠物本体装进来；现在若没有「够格的本体」则**显式报错，绝不回落**。
      // 形态一律本地推断（body_kinds 只用于商店筛选，不作为安装依据）。
      const pick = pickPetAppearance(installDir);
      if (!pick.ok || !pick.path) {
        const rejected = pick.evaluation.rejected
          .slice(0, 5)
          .map((r) => `${r.path}（${r.role}：${r.evidence[0]}）`)
          .join('；');
        throw new Error(
          `宠物资源包校验未通过：${pick.errors.join('；')}` + (rejected ? `｜被拒资源：${rejected}` : ''),
        );
      }
      const installedPath = pick.path;

      // 动作来自包内 pet/actions.json（动作随宠物，随安装一次性落地）
      const { installed: actionsCount, failures: actionsFailed } = this.installPackActions(installDir, id);

      saveConfig({
        petAssetPath: installedPath,
        petAssetName: downloaded.detail.name,
        petAssetId: id,
        petAssetFormat: pick.format,
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
