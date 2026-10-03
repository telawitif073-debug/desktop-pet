import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, PET_ACTIONS_MAX, type PetAction, type PetActionBindings } from './config';
import { clearPlatformActions } from './petActions';

/**
 * 内置演示宠物：随包分发（forge extraResource → resources/builtin-pets），完全离线可用。
 * - 形象图：主进程读字节返回 dataUrl（渲染端走 Pixi 单图分支，无需改渲染代码）
 * - 动作帧：安装时拷贝进 userData/pet-actions/<id>/，完全复用既有播放链路
 * - 与平台宠物互斥：应用内置会清掉 petAsset*；安装平台宠物会清掉 builtinPet
 */

export interface BuiltinPetFrameManifest {
  file: string;
  sha256?: string;
}

export interface BuiltinPetActionManifest {
  id: string;
  name: string;
  interaction: 'none' | 'feed' | 'rest' | 'play';
  frameRate: number;
  frames: BuiltinPetFrameManifest[];
}

export interface BuiltinPetManifest {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  canvas: { width: number; height: number; anchor: string };
  cover: BuiltinPetFrameManifest;
  actions: BuiltinPetActionManifest[];
  provenance: {
    kind: string;
    generator: string;
    version: string;
    seed?: number;
    generatedAt?: string;
  };
}

export interface BuiltinPetSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  actionCount: number;
  frameCount: number;
  /** 当前是否正在使用 */
  active: boolean;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 内置资源根目录。
 * dev 下 extraResource 不生效（electron-forge start 直接以工程根为 appPath），
 * 打包后位于 process.resourcesPath；两处都探一次，避免依赖单一假设。
 */
export function resolveBuiltinPetsDir(): string {
  const candidates: string[] = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'builtin-pets'));
  candidates.push(path.join(app.getAppPath(), 'resources', 'builtin-pets'));
  // 兜底：dev 下 appPath 若指向 .vite/build，则上溯到工程根
  candidates.push(path.resolve(app.getAppPath(), '..', '..', 'resources', 'builtin-pets'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return path.resolve(dir);
  }
  return path.resolve(candidates[0]);
}

/** 解析 manifest 内的相对路径，拒绝绝对路径与越界（..） */
function safeJoin(base: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return null;
  const resolved = path.resolve(base, rel);
  const inside = path.relative(base, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return resolved;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** 纯函数：校验并规范化 manifest（可单测）。非法返回 null */
export function parseBuiltinPetManifest(raw: unknown): BuiltinPetManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!isNonEmptyString(m.id) || !isNonEmptyString(m.name)) return null;
  const cover = m.cover as Record<string, unknown> | undefined;
  if (!cover || !isNonEmptyString(cover.file)) return null;
  if (!Array.isArray(m.actions) || m.actions.length === 0) return null;

  const actions: BuiltinPetActionManifest[] = [];
  for (const item of m.actions) {
    if (!item || typeof item !== 'object') return null;
    const a = item as Record<string, unknown>;
    if (!isNonEmptyString(a.id) || !isNonEmptyString(a.name)) return null;
    if (!Array.isArray(a.frames) || a.frames.length === 0) return null;
    const frames: BuiltinPetFrameManifest[] = [];
    for (const f of a.frames) {
      if (!f || typeof f !== 'object') return null;
      const frame = f as Record<string, unknown>;
      if (!isNonEmptyString(frame.file)) return null;
      frames.push({ file: frame.file, sha256: typeof frame.sha256 === 'string' ? frame.sha256 : undefined });
    }
    const interaction =
      a.interaction === 'feed' || a.interaction === 'rest' || a.interaction === 'play' ? a.interaction : 'none';
    actions.push({
      id: a.id,
      name: a.name,
      interaction,
      frameRate: typeof a.frameRate === 'number' && a.frameRate > 0 ? a.frameRate : 6,
      frames,
    });
  }

  const canvas = (m.canvas ?? {}) as Record<string, unknown>;
  const provenance = (m.provenance ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: typeof m.schemaVersion === 'number' ? m.schemaVersion : 1,
    id: m.id,
    name: m.name,
    description: typeof m.description === 'string' ? m.description : '',
    author: typeof m.author === 'string' ? m.author : '',
    license: typeof m.license === 'string' ? m.license : '',
    canvas: {
      width: typeof canvas.width === 'number' ? canvas.width : 512,
      height: typeof canvas.height === 'number' ? canvas.height : 512,
      anchor: typeof canvas.anchor === 'string' ? canvas.anchor : 'center',
    },
    cover: { file: (cover.file as string), sha256: typeof cover.sha256 === 'string' ? cover.sha256 : undefined },
    actions,
    provenance: {
      kind: typeof provenance.kind === 'string' ? provenance.kind : 'procedural',
      generator: typeof provenance.generator === 'string' ? provenance.generator : '',
      version: typeof provenance.version === 'string' ? provenance.version : '',
      seed: typeof provenance.seed === 'number' ? provenance.seed : undefined,
      generatedAt: typeof provenance.generatedAt === 'string' ? provenance.generatedAt : undefined,
    },
  };
}

function readManifest(petDir: string): BuiltinPetManifest | null {
  try {
    const file = path.join(petDir, 'manifest.json');
    if (!fs.existsSync(file)) return null;
    const parsed = parseBuiltinPetManifest(JSON.parse(fs.readFileSync(file, 'utf-8')));
    if (!parsed) return null;
    // id 必须与目录名一致，避免 manifest 指向别的目录
    return parsed.id === path.basename(petDir) ? parsed : null;
  } catch {
    return null;
  }
}

/** 列出可用的内置演示宠物（目录/清单缺失时返回空数组，不抛错） */
export function listBuiltinPets(): BuiltinPetSummary[] {
  const dir = resolveBuiltinPetsDir();
  if (!fs.existsSync(dir)) return [];
  const active = loadConfig().builtinPet;
  const out: BuiltinPetSummary[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifest = readManifest(path.join(dir, entry.name));
    if (!manifest) continue;
    out.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license,
      actionCount: manifest.actions.length,
      frameCount: manifest.actions.reduce((sum, a) => sum + a.frames.length, 0),
      active: active === manifest.id,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 清除内置演示宠物产生的动作（含帧图目录）与指向它们的互动绑定 */
export function clearBuiltinActions(petId?: string): number {
  const config = loadConfig();
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
  const bindings: PetActionBindings = { ...(config.petActionBindings || {}) };
  (Object.keys(bindings) as Array<keyof PetActionBindings>).forEach((key) => {
    const boundId = bindings[key];
    if (boundId && removedIds.has(boundId)) delete bindings[key];
  });

  saveConfig({
    petActions: config.petActions.filter((a) => !(!!a.builtinPetId && (!petId || a.builtinPetId === petId))),
    petActionBindings: bindings,
  });
  return removed.length;
}

/** 读取内置演示宠物的形象图（供 getInstalledPet 兜底） */
export function readBuiltinCover(id: string): { path: string; dataUrl: string } | null {
  const petDir = path.join(resolveBuiltinPetsDir(), id);
  const manifest = readManifest(petDir);
  if (!manifest) return null;
  const file = safeJoin(petDir, manifest.cover.file);
  if (!file || !fs.existsSync(file)) return null;
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) return { path: file, dataUrl: '' };
  return { path: file, dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
}

/**
 * 应用内置演示宠物（幂等：先清被替换的动作，再整体重建）。
 * - 平台动作与其它内置宠物的动作都会被清掉（同一时刻只应有一只宠物在生效）
 * - 必须显式写 petAssetFormat='image'，否则渲染端会落入 three/Live2D 分支导致空白
 * - 绑定写死 petActionBindings，同时动作名保留「吃饭/休息/玩耍」做同名回退双保险
 */
export function applyBuiltinPet(id: string): { success: boolean; error?: string; actionIds?: string[] } {
  const petDir = path.join(resolveBuiltinPetsDir(), id);
  const manifest = readManifest(petDir);
  if (!manifest) return { success: false, error: `未找到内置演示宠物「${id}」的资源清单` };

  // 校验资源齐全，避免装出半套
  const coverFile = safeJoin(petDir, manifest.cover.file);
  if (!coverFile || !fs.existsSync(coverFile)) return { success: false, error: '内置资源缺少形象图' };
  for (const action of manifest.actions) {
    for (const frame of action.frames) {
      const file = safeJoin(petDir, frame.file);
      if (!file || !fs.existsSync(file)) return { success: false, error: `内置资源缺失：${frame.file}` };
    }
  }

  const config = loadConfig();
  const keep = config.petActions.filter((a) => a.source !== 'platform' && !a.builtinPetId);
  if (keep.length + manifest.actions.length > PET_ACTIONS_MAX) {
    return {
      success: false,
      error: `动作数量将超过上限（${PET_ACTIONS_MAX} 个），请先删除部分自定义动作`,
    };
  }

  clearPlatformActions();
  clearBuiltinActions();

  const actionsDir = path.join(app.getPath('userData'), 'pet-actions');
  const bindings: PetActionBindings = {};
  const added: PetAction[] = [];
  const actionIds: string[] = [];

  for (const action of manifest.actions) {
    const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const targetDir = path.join(actionsDir, actionId);
    fs.mkdirSync(targetDir, { recursive: true });

    const frameFiles: string[] = [];
    action.frames.forEach((frame, index) => {
      const source = safeJoin(petDir, frame.file);
      if (!source) throw new Error(`内置资源路径非法：${frame.file}`);
      const ext = path.extname(frame.file).toLowerCase() || '.png';
      const target = path.join(targetDir, `frame_${String(index).padStart(3, '0')}${ext}`);
      fs.copyFileSync(source, target);
      frameFiles.push(target);
    });

    added.push({
      id: actionId,
      name: action.name,
      kind: 'frames',
      source: 'manual',
      frameFiles,
      frameRate: action.frameRate,
      builtinPetId: id,
      ...(action.interaction !== 'none' ? { interaction: action.interaction } : {}),
      createdAt: Date.now(),
    });
    actionIds.push(actionId);
    if (action.interaction !== 'none') bindings[action.interaction] = actionId;
  }

  saveConfig({
    builtinPet: id,
    petAssetName: manifest.name,
    petAssetFormat: 'image',
    petAssetId: undefined,
    petAssetPath: undefined,
    petActions: [...keep, ...added],
    petActionBindings: bindings,
  });

  return { success: true, actionIds };
}

/** 还原为「内置默认形象」：清掉内置宠物动作与相关字段，回落到 src/assets/pet.png */
export function resetBuiltinPet(): { success: boolean } {
  const config = loadConfig();
  if (!config.builtinPet) return { success: true };
  clearBuiltinActions();
  const patch: Record<string, unknown> = { builtinPet: undefined };
  // 已有平台宠物时不要动它的展示字段（理论上互斥，这里兜一层）
  if (!config.petAssetPath) {
    patch.petAssetName = undefined;
    patch.petAssetFormat = undefined;
  }
  saveConfig(patch);
  return { success: true };
}