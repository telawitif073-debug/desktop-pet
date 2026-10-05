/**
 * 本机宠物库（主进程）：列表 / 从平台安装 / 选用 / 卸载，并装配渲染端需要的形象模型
 * ---------------------------------------------------------------------------
 * - 已安装宠物登记在 config.pet.downloadedPets（随 config 云同步）；
 * - 平台安装：platformClient.download('pet') → 解包进 userData/pets/<id> → 挑本体（petPack 的
 *   pickPetAppearance，与发布侧同一标准）→ 读包内 `pet/actions.json` 装配动作 → 落 config；
 * - 渲染形象：`resolveCurrentPetAsset` 把当前宠物的本体与动作转成 `petaction://` URL 供渲染端播放。
 */
import { app } from 'electron';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import {
  ACTION_PAYLOAD_DIR,
  actionPayloadDirName,
  migrateActionModel,
  modelFromActions,
  type PetActionModel,
} from '@pet/domain';
import {
  DEFAULT_PET_SETTINGS,
  loadConfig,
  saveConfig,
  type InstalledPet,
  type PetActionBindings,
  type PetActionConfig,
  type PetSettings,
} from '../config';
import { platformClient } from '../platformClient';
import { pickPetAppearance } from './petPack';
import { clearPlatformActions } from './petActions';
import { clearBuiltinActions } from './builtinPets';

/** 列出本机已安装宠物 */
export function listInstalledPets(): InstalledPet[] {
  return loadConfig().pet?.downloadedPets ?? [];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * 本地文件 → `petaction://local/<name>?p=<编码后的绝对路径>`。
 * 渲染端（http origin）无法直接读磁盘文件，统一经主进程注册的自定义协议读取（视频走 Range）。
 */
export function toPetActionUrl(absPath: string): string {
  const name = path.basename(absPath);
  return `petaction://local/${encodeURIComponent(name)}?p=${encodeURIComponent(absPath)}`;
}

/** 渲染端可播放的一个动作（路径已转成 petaction:// URL） */
export interface PetRenderAction {
  id: string;
  name: string;
  kind: 'frames' | 'clip' | 'video';
  interaction: 'none' | 'feed' | 'rest' | 'play';
  /** kind=frames：帧图 URL（按顺序） */
  frameUrls?: string[];
  frameRate?: number;
  /** kind=video：视频 URL */
  videoUrl?: string;
  /** kind=clip：模型内置动画名（Live2D/3D；本项目 DOM 渲染层不支持，保留字段） */
  clipName?: string;
}

/** 当前宠物的渲染模型（pet:get-asset 返回） */
export interface PetRenderAsset {
  /** image / pack / live2d / model3d */
  format: string;
  name: string;
  /** 静态本体图 URL（无本体时为 undefined） */
  imageUrl?: string;
  actions: PetRenderAction[];
  /** 动作决策模型（schemaVersion 3，渲染端 resolvePlayback 用） */
  model: PetActionModel;
}

/** 组装渲染动作（把绝对路径转成 petaction:// URL） */
function toRenderActions(actions: PetActionConfig[]): PetRenderAction[] {
  return actions.map((a) => {
    const base: PetRenderAction = {
      id: a.id,
      name: a.name,
      kind: a.kind,
      interaction: a.interaction ?? 'none',
      ...(typeof a.frameRate === 'number' ? { frameRate: a.frameRate } : {}),
      ...(a.clipName ? { clipName: a.clipName } : {}),
    };
    if (a.kind === 'video' && a.videoFile) base.videoUrl = toPetActionUrl(a.videoFile);
    if (a.kind === 'frames' && a.frameFiles?.length) base.frameUrls = a.frameFiles.map(toPetActionUrl);
    return base;
  });
}

/** 当前宠物的渲染模型（未选用/资源缺失时返回 null） */
export function resolveCurrentPetAsset(): PetRenderAsset | null {
  const pet = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const format = pet.petAssetFormat || '';
  const absPath = pet.petAssetPath;
  if (!absPath || !fs.existsSync(absPath)) return null;
  return {
    format: format || 'image',
    name: pet.petAssetName || '宠物',
    imageUrl: toPetActionUrl(absPath),
    actions: toRenderActions(pet.petActions),
    model: modelFromActions(pet.petActions).model,
  };
}

/** 读取包内 `pet/actions.json` 快照并迁移到当前 schemaVersion（缺失/非法时返回 null） */
function readPackActionModel(installDir: string): PetActionModel | null {
  try {
    const file = path.join(installDir, 'pet', 'actions.json');
    if (!fs.existsSync(file)) return null;
    const migrated = migrateActionModel(JSON.parse(fs.readFileSync(file, 'utf-8')));
    return migrated as PetActionModel;
  } catch {
    return null;
  }
}

const byFrameName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

/**
 * 依据包内动作模型装配 `PetActionConfig[]`：帧序列从 `pet/actions/<动作名>/` 读帧图，视频读清单里的
 * 相对路径（videoFile），模型 clip 只记名字。同时产出互动绑定（feed/rest/play → 动作 id）。
 */
export function derivePackActions(
  installDir: string,
  petId: string,
  model: PetActionModel | null,
): { actions: PetActionConfig[]; bindings: PetActionBindings } {
  const actions: PetActionConfig[] = [];
  const bindings: PetActionBindings = {};
  if (!model) return { actions, bindings };

  let index = 0;
  for (const [name, spec] of Object.entries(model.actions ?? {})) {
    const id = `pet_${petId}_${index++}`;
    const interaction = spec.interaction && spec.interaction !== 'none' ? spec.interaction : undefined;
    const common = {
      id,
      name,
      petAssetId: petId,
      ...(interaction ? { interaction } : {}),
    } as const;

    if (spec.kind === 'clip') {
      actions.push({ ...common, kind: 'clip', clipName: name });
    } else if (spec.kind === 'video') {
      const rel = spec.videoFile;
      const abs = rel ? path.resolve(installDir, rel) : '';
      if (!abs || !fs.existsSync(abs)) continue;
      actions.push({ ...common, kind: 'video', videoFile: abs });
    } else {
      const dir = path.join(installDir, ACTION_PAYLOAD_DIR, actionPayloadDirName(name));
      if (!fs.existsSync(dir)) continue;
      const frames = fs
        .readdirSync(dir)
        .filter((f) => IMAGE_EXT_RE.test(f))
        .sort(byFrameName)
        .map((f) => path.join(dir, f));
      if (!frames.length) continue;
      actions.push({ ...common, kind: 'frames', frameFiles: frames, frameRate: spec.frameRate ?? 6 });
    }
    if (interaction) bindings[interaction] = id;
  }
  return { actions, bindings };
}

/** 把某个已解包宠物设为当前形象（登记本机宠物库 + 清除内置/旧平台宠物 + 装配动作） */
function applyInstalledPet(info: {
  id: string;
  name: string;
  format: string;
  entry: string;
  installDir: string;
  version?: string;
  fromStore?: boolean;
}): { pet: InstalledPet } {
  const config = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  // 保留用户自建动作（既不属于平台宠物也不属于内置宠物）
  const keep = config.petActions.filter((a) => !a.petAssetId && !a.builtinPetId);
  clearPlatformActions();
  clearBuiltinActions();

  const { actions, bindings } = derivePackActions(info.installDir, info.id, readPackActionModel(info.installDir));

  const record: InstalledPet = {
    id: info.id,
    name: info.name || info.id,
    format: info.format,
    localPath: info.installDir,
    ...(info.version ? { version: info.version } : {}),
    installedAt: Date.now(),
    ...(info.fromStore ? { fromStore: true } : {}),
  };
  const downloadedPets = [...config.downloadedPets.filter((p) => p.id !== info.id), record];

  const next: PetSettings = {
    ...config,
    builtinPet: '',
    petAssetId: info.id,
    petAssetName: record.name,
    petAssetPath: info.entry,
    petAssetFormat: info.format,
    currentPet: info.id,
    petStateReady: true,
    downloadedPets,
    petActions: [...keep, ...actions],
    petActionBindings: bindings,
  };
  saveConfig({ pet: next });
  return { pet: record };
}

/** 从平台下载并安装宠物包（解包 → 挑本体 → 装配动作 → 落 config） */
export async function installPet(id: string): Promise<{ success: boolean; pet?: InstalledPet; error?: string }> {
  const downloaded = await platformClient.download('pet', id);
  const installRoot = path.join(app.getPath('userData'), 'pets');
  const installDir = path.join(installRoot, id);
  try {
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });
    try {
      new AdmZip(downloaded.tempPath).extractAllTo(installDir, true);
    } catch (e) {
      fs.rmSync(installDir, { recursive: true, force: true });
      return { success: false, error: `宠物包解压失败：${e instanceof Error ? e.message : String(e)}` };
    }

    const pick = pickPetAppearance(installDir);
    if (!pick.ok || !pick.path) {
      fs.rmSync(installDir, { recursive: true, force: true });
      return { success: false, error: pick.errors.join('；') || '包内没有合格的宠物本体' };
    }

    const detail = downloaded.detail as { name?: string; version?: string };
    const { pet } = applyInstalledPet({
      id,
      name: typeof detail.name === 'string' && detail.name ? detail.name : id,
      format: pick.format,
      entry: pick.path,
      installDir,
      version: typeof detail.version === 'string' ? detail.version : undefined,
      fromStore: true,
    });
    return { success: true, pet };
  } finally {
    fs.rmSync(path.dirname(downloaded.tempPath), { recursive: true, force: true });
  }
}

/** 选用本机已安装的某只宠物（不重新下载；从 localPath 重新装配动作） */
export function useInstalledPet(id: string): { success: boolean; pet?: InstalledPet; error?: string } {
  const record = listInstalledPets().find((p) => p.id === id);
  if (!record) return { success: false, error: '未找到该宠物' };
  const installDir = record.localPath || path.join(app.getPath('userData'), 'pets', id);
  const pick = pickPetAppearance(installDir);
  if (!pick.ok || !pick.path) return { success: false, error: pick.errors.join('；') || '宠物资源缺失' };
  const { pet } = applyInstalledPet({
    id,
    name: record.name,
    format: record.format || pick.format,
    entry: pick.path,
    installDir,
    version: record.version,
    fromStore: record.fromStore,
  });
  return { success: true, pet };
}

/** 卸载宠物：删除安装目录 + 登记 + 该宠物的动作 + 相关绑定；若正是当前形象则清空当前宠物 */
export function uninstallPet(id: string): { success: boolean; pets: InstalledPet[] } {
  const config = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'pets', id), { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to remove pet install dir:', e);
  }
  // 清该宠物的动作文件
  for (const action of config.petActions.filter((a) => a.petAssetId === id)) {
    const anchor = action.kind === 'video' ? action.videoFile : action.frameFiles?.[0];
    if (!anchor) continue;
    try {
      fs.rmSync(path.dirname(anchor), { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to remove pet action files:', e);
    }
  }
  const removedIds = new Set(config.petActions.filter((a) => a.petAssetId === id).map((a) => a.id));
  const bindings = { ...(config.petActionBindings || {}) };
  (Object.keys(bindings) as Array<keyof PetActionBindings>).forEach((key) => {
    const boundId = bindings[key];
    if (boundId && removedIds.has(boundId)) delete bindings[key];
  });

  const downloadedPets = config.downloadedPets.filter((p) => p.id !== id);
  const isCurrent = config.currentPet === id;
  const next: PetSettings = {
    ...config,
    downloadedPets,
    petActions: config.petActions.filter((a) => a.petAssetId !== id),
    petActionBindings: bindings,
    ...(isCurrent
      ? { currentPet: '', petAssetId: '', petAssetName: '', petAssetPath: '', petAssetFormat: '', petStateReady: false }
      : {}),
  };
  saveConfig({ pet: next });
  return { success: true, pets: downloadedPets };
}
