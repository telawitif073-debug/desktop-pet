import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, PET_ACTIONS_MAX, type PetAction } from './config';

function getActionsDir(): string {
  return path.join(app.getPath('userData'), 'pet-actions');
}

/** 新增帧序列动作：图片写入 userData/pet-actions/<id>/，元数据写入 config。
 * options.petAssetId 提供时标记为资源库动作（随宠物安装，换宠物时清除） */
export function addFramesAction(
  name: string,
  files: Array<{ filename: string; data: Buffer }>,
  options?: { petAssetId?: string; interaction?: 'none' | 'feed' | 'rest' | 'play'; frameRate?: number },
): PetAction {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!files.length) throw new Error('至少上传一张图片作为帧');
  if (files.length > 30) throw new Error('帧数过多（最多 30 张）');

  const config = loadConfig();
  if (config.petActions.length >= PET_ACTIONS_MAX) {
    throw new Error(`动作数量已达上限（${PET_ACTIONS_MAX} 个），请先删除部分动作`);
  }

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
  if (config.petActions.length >= PET_ACTIONS_MAX) {
    throw new Error(`动作数量已达上限（${PET_ACTIONS_MAX} 个），请先删除部分动作`);
  }

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

/** 清除资源库动作（换宠物时旧宠物的动作不可复用），并清理关联的互动绑定。
 * petAssetId 提供时仅清除属于该宠物的动作 */
export function clearPlatformActions(petAssetId?: string): number {
  const config = loadConfig();
  const removed = config.petActions.filter((a) => a.source === 'platform' && (!petAssetId || a.petAssetId === petAssetId));
  if (!removed.length) return 0;

  for (const action of removed) {
    if (action.kind === 'frames' && action.frameFiles?.length) {
      try {
        fs.rmSync(path.dirname(action.frameFiles[0]), { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to remove platform action frames dir:', e);
      }
    }
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

/** 删除动作：帧序列同时清理磁盘目录 */
export function removeAction(id: string): void {
  const config = loadConfig();
  const target = config.petActions.find((a) => a.id === id);
  if (!target) return;
  if (target.kind === 'frames' && target.frameFiles?.length) {
    const dir = path.dirname(target.frameFiles[0]);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to remove action frames dir:', e);
    }
  }
  saveConfig({ petActions: config.petActions.filter((a) => a.id !== id) });
}
