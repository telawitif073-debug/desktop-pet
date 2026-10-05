import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { DEFAULT_PET_SETTINGS, loadConfig, saveConfig, type PetActionConfig, type PetSettings } from '../config';
import { clearPlatformActions } from './petActions';

/**
 * 内置演示宠物：随包分发（仓库根 `pet/resources/builtin/`），完全离线可用，作为零配置默认形象。
 * - 清单：`pet/resources/builtin/manifest.json`（`pets[]`，每条含 id/name/entry/bodyKinds/actions）
 * - 形象：`entry`（相对本目录，如 `sprout-cat/cover.svg`）；渲染端经 `petaction://` 读取绝对路径
 * - 动作：`actions[]`（可选，帧序列）安装时拷贝进 userData/pet-actions/<actionId>/
 * - 与平台宠物互斥：应用内置会清掉 petAsset*；安装平台宠物会清掉 builtinPet
 */

export interface BuiltinPetFrameManifest {
  file: string;
}

export interface BuiltinPetActionManifest {
  id: string;
  name: string;
  interaction: 'none' | 'feed' | 'rest' | 'play';
  frameRate: number;
  frames: BuiltinPetFrameManifest[];
}

export interface BuiltinPetEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  /** 本体入口相对路径（相对内置资源根） */
  entry: string;
  /** 本体形态（image / frames / live2d / model3d） */
  bodyKinds: string[];
  actions: BuiltinPetActionManifest[];
}

export interface BuiltinPetManifestFile {
  schemaVersion: number;
  pets: BuiltinPetEntry[];
}

export interface BuiltinPetSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  entry: string;
  bodyKinds: string[];
  actionCount: number;
  frameCount: number;
  /** 当前是否正在使用 */
  active: boolean;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * 纯函数：解析内置演示宠物清单（`pets[]`）。非法条目丢弃而不是整体失败；无合法条目返回 null。
 * 保证 id 唯一、entry 相对且不含越界（与外部素材同口径防目录穿越）。
 */
export function parseBuiltinManifest(raw: unknown): BuiltinPetManifestFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const list = Array.isArray(src.pets) ? src.pets : [];
  const pets: BuiltinPetEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (!isNonEmptyString(e.id) || !isNonEmptyString(e.name) || !isNonEmptyString(e.entry)) continue;
    if (path.isAbsolute(e.entry) || e.entry.includes('..')) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);

    const actions: BuiltinPetActionManifest[] = [];
    if (Array.isArray(e.actions)) {
      for (const a of e.actions) {
        if (!a || typeof a !== 'object') continue;
        const item2 = a as Record<string, unknown>;
        if (!isNonEmptyString(item2.id) || !isNonEmptyString(item2.name)) continue;
        const frames = Array.isArray(item2.frames)
          ? item2.frames
              .map((f) =>
                f && typeof f === 'object' && isNonEmptyString((f as Record<string, unknown>).file)
                  ? { file: (f as Record<string, unknown>).file as string }
                  : null,
              )
              .filter((f): f is BuiltinPetFrameManifest => !!f)
          : [];
        if (!frames.length) continue;
        const interaction =
          item2.interaction === 'feed' || item2.interaction === 'rest' || item2.interaction === 'play'
            ? item2.interaction
            : 'none';
        actions.push({
          id: item2.id,
          name: item2.name,
          interaction,
          frameRate: typeof item2.frameRate === 'number' && item2.frameRate > 0 ? item2.frameRate : 6,
          frames,
        });
      }
    }

    const bodyKinds = Array.isArray(e.bodyKinds)
      ? (e.bodyKinds as unknown[]).filter(isNonEmptyString)
      : [];
    pets.push({
      id: e.id,
      name: e.name,
      description: typeof e.description === 'string' ? e.description : '',
      author: typeof e.author === 'string' ? e.author : '',
      license: typeof e.license === 'string' ? e.license : '',
      entry: e.entry,
      bodyKinds: bodyKinds.length ? bodyKinds : ['image'],
      actions,
    });
  }
  if (!pets.length) return null;
  return { schemaVersion: typeof src.schemaVersion === 'number' ? src.schemaVersion : 1, pets };
}

/**
 * 内置资源根目录。dev 下 appPath 即工程根；打包后位于 process.resourcesPath。
 * 两处都探一次，避免依赖单一假设。仓库根 `pet/resources/builtin` 是唯一事实来源。
 */
export function resolveBuiltinPetsDir(): string {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'pet', 'resources', 'builtin'));
    candidates.push(path.join(process.resourcesPath, 'builtin'));
  }
  candidates.push(path.join(app.getAppPath(), 'pet', 'resources', 'builtin'));
  // 兜底：dev 下 appPath 若指向 .vite/build，则上溯到工程根
  candidates.push(path.resolve(app.getAppPath(), '..', '..', 'pet', 'resources', 'builtin'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return path.resolve(dir);
  }
  return path.resolve(candidates[0]);
}

/** 解析清单元数据内的相对路径，拒绝绝对路径与越界（..） */
export function safeJoin(base: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return null;
  const resolved = path.resolve(base, rel);
  const inside = path.relative(base, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return resolved;
}

/** 读取内置清单（目录/文件缺失时返回空清单，不抛错） */
export function readBuiltinManifest(): BuiltinPetManifestFile {
  try {
    const file = path.join(resolveBuiltinPetsDir(), 'manifest.json');
    if (!fs.existsSync(file)) return { schemaVersion: 1, pets: [] };
    return parseBuiltinManifest(JSON.parse(fs.readFileSync(file, 'utf-8'))) ?? { schemaVersion: 1, pets: [] };
  } catch {
    return { schemaVersion: 1, pets: [] };
  }
}

/** 列出可用的内置演示宠物（清单缺失时返回空数组，不抛错） */
export function listBuiltinPets(): BuiltinPetSummary[] {
  const active = loadConfig().pet?.builtinPet ?? '';
  return readBuiltinManifest().pets.map((pet) => ({
    id: pet.id,
    name: pet.name,
    description: pet.description,
    author: pet.author,
    license: pet.license,
    entry: pet.entry,
    bodyKinds: pet.bodyKinds,
    actionCount: pet.actions.length,
    frameCount: pet.actions.reduce((sum, a) => sum + a.frames.length, 0),
    active: active === pet.id,
  }));
}

/** 读取某个内置宠物的清单条目 */
export function getBuiltinPet(id: string): BuiltinPetEntry | null {
  return readBuiltinManifest().pets.find((p) => p.id === id) ?? null;
}

/** 内置宠物本体入口的绝对路径（不存在返回 null） */
export function resolveBuiltinEntry(id: string): string | null {
  const pet = getBuiltinPet(id);
  if (!pet) return null;
  const file = safeJoin(resolveBuiltinPetsDir(), pet.entry);
  return file && fs.existsSync(file) ? file : null;
}

/** 由 bodyKinds 推断渲染形态：image / pack / live2d / model3d */
function formatOf(pet: BuiltinPetEntry): string {
  const kind = pet.bodyKinds[0];
  return kind === 'frames' || kind === 'pack' || kind === 'live2d' || kind === 'model3d' ? kind : 'image';
}

/** 清除内置演示宠物产生的动作（含帧图目录）与指向它们的互动绑定 */
export function clearBuiltinActions(petId?: string): number {
  const config = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const removed = config.petActions.filter((a) => !!a.builtinPetId && (!petId || a.builtinPetId === petId));
  if (!removed.length) return 0;

  for (const action of removed) {
    const firstFrame = action.frameFiles?.[0];
    if (!firstFrame) continue;
    try {
      fs.rmSync(path.dirname(firstFrame), { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to remove builtin action frames dir:', e);
    }
  }

  const removedIds = new Set(removed.map((a) => a.id));
  const bindings = { ...(config.petActionBindings || {}) };
  (Object.keys(bindings) as Array<keyof typeof bindings>).forEach((key) => {
    const boundId = bindings[key];
    if (boundId && removedIds.has(boundId)) delete bindings[key];
  });

  saveConfig({
    pet: {
      ...config,
      petActions: config.petActions.filter((a) => !(!!a.builtinPetId && (!petId || a.builtinPetId === petId))),
      petActionBindings: bindings,
    },
  });
  return removed.length;
}

/**
 * 应用内置演示宠物（幂等：先清被替换的动作，再整体重建）。
 * - 平台动作与其它内置宠物的动作都会被清掉（同一时刻只应有一只宠物在生效）
 * - 必须显式写 petAssetFormat='image'（或清单声明形态），否则渲染端会落入 Live2D/3D 分支导致空白
 * - 绑定写死 petActionBindings，同时动作名保留「吃饭/休息/玩耍」做同名回退双保险
 */
export function applyBuiltinPet(id: string): { success: boolean; error?: string; actionIds?: string[] } {
  const pet = getBuiltinPet(id);
  if (!pet) return { success: false, error: `未找到内置演示宠物「${id}」的资源清单` };
  const entryAbs = resolveBuiltinEntry(id);
  if (!entryAbs) return { success: false, error: '内置资源缺少形象图' };

  const config = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  // 保留用户自建动作（既不属于平台宠物也不属于内置宠物）
  const keep = config.petActions.filter((a) => !a.petAssetId && !a.builtinPetId);

  clearBuiltinActions();
  clearPlatformActions();

  const actionsDir = path.join(app.getPath('userData'), 'pet-actions');
  const bindings: Record<string, string> = {};
  const added: PetActionConfig[] = [];
  const actionIds: string[] = [];

  for (const action of pet.actions) {
    const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const targetDir = path.join(actionsDir, actionId);
    fs.mkdirSync(targetDir, { recursive: true });
    const base = resolveBuiltinPetsDir();
    const frameFiles: string[] = [];
    action.frames.forEach((frame, index) => {
      const source = safeJoin(base, frame.file);
      if (!source || !fs.existsSync(source)) throw new Error(`内置资源缺失：${frame.file}`);
      const ext = path.extname(frame.file).toLowerCase() || '.png';
      const target = path.join(targetDir, `frame_${String(index).padStart(3, '0')}${ext}`);
      fs.copyFileSync(source, target);
      frameFiles.push(target);
    });
    const built: PetActionConfig = {
      id: actionId,
      name: action.name,
      kind: 'frames',
      frameFiles,
      frameRate: action.frameRate,
      builtinPetId: id,
      ...(action.interaction !== 'none' ? { interaction: action.interaction } : {}),
    };
    added.push(built);
    actionIds.push(actionId);
    if (action.interaction !== 'none') bindings[action.interaction] = actionId;
  }

  const next: PetSettings = {
    ...config,
    builtinPet: id,
    petAssetName: pet.name,
    petAssetPath: entryAbs,
    petAssetFormat: formatOf(pet),
    petAssetId: '',
    currentPet: '',
    petStateReady: true,
    petActions: [...keep, ...added],
    petActionBindings: bindings,
  };
  saveConfig({ pet: next });
  return { success: true, actionIds };
}

/** 还原为「内置默认形象」：清掉内置宠物动作与相关字段 */
export function resetBuiltinPet(): { success: boolean } {
  const config = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  if (!config.builtinPet) return { success: true };
  clearBuiltinActions();
  const next: PetSettings = {
    ...config,
    builtinPet: '',
    // 已有平台宠物时不要动它的展示字段（理论上互斥，这里兜一层）
    ...(config.petAssetPath ? {} : { petAssetName: '', petAssetFormat: '', petAssetPath: '' }),
  };
  saveConfig({ pet: next });
  return { success: true };
}
