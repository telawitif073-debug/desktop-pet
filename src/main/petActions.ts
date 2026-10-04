import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, assertActionQuota, type PetAction } from './config';
import { probeImageBuffer } from './petPack';
import { evaluatePetPack } from '../pet'; // 宠物主体功能模块（统一入口）

function getActionsDir(): string {
  return path.join(app.getPath('userData'), 'pet-actions');
}

/**
 * 上传/安装动作帧时的**宠物本体校验**（修复「任意图都能变成宠物动作」）：
 * - 用与资源包同一套分类标准（src/shared/petResource）判定上传内容；
 * - 只有**全部帧都被证明为非本体**（界面件/表情包/品牌/文档/音频）时才拒绝——
 *   这类是明确的误用，给出显式原因；
 * - 只要有任一帧属于本体或**无法定性**（unknown）就放行：用户主动上传属于显式意图，
 *   探测能力不足不能当成拒绝理由（与资源包安装的 fail-closed 口径刻意区分）。
 */
function assertPetBodyFrames(files: Array<{ filename: string; data: Buffer }>): void {
  const entries = files.map((f) => ({ path: f.filename, probe: probeImageBuffer(f.data, f.filename) }));
  const evaluation = evaluatePetPack(entries);
  if (evaluation.valid) return;
  const rejected = evaluation.rejected;
  const allProvenNonBody = rejected.length === entries.length && rejected.every((r) => r.role !== 'unknown');
  if (!allProvenNonBody) return; // 含 unknown/未定性 → 尊重用户意图放行
  const detail = rejected
    .slice(0, 5)
    .map((r) => `${r.path}（${r.role}：${r.evidence[0]}）`)
    .join('；');
  throw new Error(`这些图片不属于宠物本体资源，已拒绝添加：${detail}`);
}

/** 新增帧序列动作：图片写入 userData/pet-actions/<id>/，元数据写入 config。
 * options.petAssetId 提供时标记为资源库动作（随宠物安装，换宠物时清除） */
export function addFramesAction(
  name: string,
  files: Array<{ filename: string; data: Buffer }>,
  options?: {
    petAssetId?: string;
    interaction?: 'none' | 'feed' | 'rest' | 'play';
    frameRate?: number;
    /**
     * 跳过「是否宠物本体」的启发式校验。仅用于**宠物包内已声明的动作载荷**
     * （`pet/actions/<动作名>/`）——那些帧不是本体，且包本身已通过本体校验；
     * 手动上传/AI 生成仍必须走校验。
     */
    skipBodyCheck?: boolean;
  },
): PetAction {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!files.length) throw new Error('至少上传一张图片作为帧');
  if (files.length > 30) throw new Error('帧数过多（最多 30 张）');

  const config = loadConfig();
  // 配额按归属计数：带 petAssetId 的动作只占该宠物的配额，不挤占用户自建动作
  assertActionQuota(config.petActions, { petAssetId: options?.petAssetId });
  // 本体校验：只有「全部帧都被证明为非本体」时才拒绝（详见 assertPetBodyFrames 注释）
  if (!options?.skipBodyCheck) assertPetBodyFrames(files);

  const id = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(getActionsDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  // 按传入顺序编号写盘，避免文件名冲突/乱序（播放顺序 = 上传顺序）
  const exts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  const frameFiles: string[] = [];
  files.forEach((file, index) => {
    const ext = path.extname(file.filename || '').toLowerCase();
    if (!exts.has(ext)) throw new Error(`不支持的图片格式: ${file.filename}`);
    const framePath = path.join(dir, `frame_${String(index).padStart(3, '0')}${ext}`);
    fs.writeFileSync(framePath, file.data);
    frameFiles.push(framePath);
  });

  const action: PetAction = {
    id,
    name: trimmedName,
    kind: 'frames',
    source: options?.petAssetId ? 'platform' : 'manual',
    frameFiles,
    frameRate: options?.frameRate ?? 6,
    ...(options?.petAssetId ? { petAssetId: options.petAssetId } : {}),
    ...(options?.interaction && options.interaction !== 'none' ? { interaction: options.interaction } : {}),
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...config.petActions, action] });
  return action;
}

/** 注册模型内置动画 clip 动作（Live2D/3D 模型宠物，播放由渲染端按形态驱动） */
export function addClipAction(
  name: string,
  clipName: string,
  options?: { petAssetId?: string; interaction?: 'none' | 'feed' | 'rest' | 'play' },
): PetAction {
  const trimmedName = name.trim();
  const trimmedClip = clipName.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!trimmedClip) throw new Error('模型动画 clip 名称不能为空');

  const config = loadConfig();
  assertActionQuota(config.petActions, { petAssetId: options?.petAssetId });

  const action: PetAction = {
    id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmedName,
    kind: 'clip',
    source: 'platform',
    clipName: trimmedClip,
    ...(options?.petAssetId ? { petAssetId: options.petAssetId } : {}),
    ...(options?.interaction && options.interaction !== 'none' ? { interaction: options.interaction } : {}),
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...config.petActions, action] });
  return action;
}

/**
 * 视频动作目前只收 **WebM（EBML，VP9 alpha）**：
 * P0 spike 已实测 Electron 44/Chromium 152 能完整保住它的 alpha；其它容器（mp4/mov）渲染端虽可播，
 * 但没有做过 alpha 验证，故显式拒绝而不是「先收下再说」（fail-closed，与资源包判定的口径一致）。
 */
const VIDEO_ACTION_EXT = '.webm';
const EBML_MAGIC = Buffer.from('1a45dfa3', 'hex');

/**
 * 新增**视频动作**：webm 写入 `userData/pet-actions/<id>/clip.webm`，渲染端用 `<video>` 直接播。
 * 为什么不转帧序列：106 段动画转成 512 画布 PNG 帧序列实测需 198–364 MB，而 webm 合计仅 52 MB。
 */
export function addVideoAction(
  name: string,
  video: { filename: string; data: Buffer },
  options?: { petAssetId?: string; interaction?: 'none' | 'feed' | 'rest' | 'play' },
): PetAction {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!video?.data?.length) throw new Error('视频数据为空');
  const ext = path.extname(video.filename || '').toLowerCase();
  if (ext !== VIDEO_ACTION_EXT) {
    throw new Error(`视频动作目前只支持 WebM（${VIDEO_ACTION_EXT}），收到：${video.filename}`);
  }
  if (!video.data.subarray(0, 4).equals(EBML_MAGIC)) {
    throw new Error('不是有效的 WebM 文件（缺少 EBML 头）');
  }

  const config = loadConfig();
  assertActionQuota(config.petActions, { petAssetId: options?.petAssetId });

  const id = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(getActionsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const videoFile = path.join(dir, `clip${VIDEO_ACTION_EXT}`);
  fs.writeFileSync(videoFile, video.data);

  const action: PetAction = {
    id,
    name: trimmedName,
    kind: 'video',
    source: options?.petAssetId ? 'platform' : 'manual',
    videoFile,
    // 刻意不写 frameRate：视频自带帧率（模型里该字段对 video 动作是可选的）
    ...(options?.petAssetId ? { petAssetId: options.petAssetId } : {}),
    ...(options?.interaction && options.interaction !== 'none' ? { interaction: options.interaction } : {}),
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...config.petActions, action] });
  return action;
}

/** 清除资源库动作（换宠物时旧宠物的动作不可复用），并清理关联的互动绑定。
 * petAssetId 提供时仅清除属于该宠物的动作 */
export function clearPlatformActions(petAssetId?: string): number {
  const config = loadConfig();
  const removed = config.petActions.filter((a) => a.source === 'platform' && (!petAssetId || a.petAssetId === petAssetId));
  if (!removed.length) return 0;

  for (const action of removed) {
    removeActionFiles(action);
  }

  const removedIds = new Set(removed.map((a) => a.id));
  const bindings = { ...(config.petActionBindings || {}) };
  (Object.keys(bindings) as Array<keyof typeof bindings>).forEach((key) => {
    const boundId = bindings[key];
    if (boundId && removedIds.has(boundId)) delete bindings[key];
  });
  saveConfig({
    petActions: config.petActions.filter((a) => a.source !== 'platform'),
    petActionBindings: bindings,
  });
  return removed.length;
}

/** 获取当前宠物形象信息；若 config 缺少资源名（旧版本安装），从平台反查一次并回写 */
export async function resolvePetInfo(
  getDetail: (id: string) => Promise<{ name?: string }>
): Promise<{ name?: string; width?: number; height?: number }> {
  const config = loadConfig();
  const info: { name?: string; width?: number; height?: number } = {};
  if (!config.petAssetPath) return info;

  if (config.petAssetName) {
    info.name = config.petAssetName;
  } else {
    // 安装目录为 userData/pets/<资源id>/...，从路径提取 id 反查名称
    const parts = path.normalize(config.petAssetPath).split(path.sep);
    const petsIdx = parts.lastIndexOf('pets');
    const assetId = petsIdx >= 0 && parts[petsIdx + 1] ? parts[petsIdx + 1] : null;
    if (assetId) {
      try {
        const detail = await getDetail(assetId);
        if (detail?.name) {
          info.name = detail.name;
          saveConfig({ petAssetName: detail.name });
        }
      } catch { /* 平台不可达时跳过名称 */ }
    }
  }
  return info;
}

/** 删除动作：帧序列/视频同时清理磁盘目录 */
export function removeAction(id: string): void {
  const config = loadConfig();
  const target = config.petActions.find((a) => a.id === id);
  if (!target) return;
  removeActionFiles(target);
  saveConfig({ petActions: config.petActions.filter((a) => a.id !== id) });
}

/**
 * 动作的文件落盘目录：帧序列看首帧、视频动作看视频文件。
 * 两者都放在 `userData/pet-actions/<actionId>/` 下，因此删目录即可（返回 null 表示无文件）。
 */
function actionFilesDir(action: PetAction): string | null {
  const anchor = action.kind === 'video' ? action.videoFile : action.frameFiles?.[0];
  return anchor ? path.dirname(anchor) : null;
}

/** 删除动作的磁盘文件（删不掉只记日志，不阻断配置变更） */
function removeActionFiles(action: PetAction): void {
  const dir = actionFilesDir(action);
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`Failed to remove action files dir "${dir}":`, e);
  }
}
