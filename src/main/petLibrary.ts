import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { addFramesAction } from './petActions';
import { clearBuiltinActions } from './builtinPets';
import { saveConfig, type PetAction } from './config';

/**
 * 上游美术资源库（pet-asset-library）
 * ---------------------------------------------------------------------------
 * 背景：从 GitHub「pet」开源项目导入的美术资源里，只有**帧序列/动图**能直接当动作播放；
 * 大量静态立绘、图标、单帧素材无法塞进「动作」模型。若不做功能扩展，这部分素材只能被丢弃，
 * 与「所有取得的素材都要用起来」的目标冲突。因此新增本资源库：
 *   - 磁盘：resources/pet-asset-library/<repoSlug>/<name>.png（随 forge extraResource 打包）
 *   - 索引：resources/pet-asset-library/index.json（来源仓库/许可/原始路径，便于溯源与合规）
 *   - 能力：任何一张都能「设为形象」（复用既有 petAssetPath + petAssetFormat='image' 链路）
 *           或「加为动作」（复用 actions:add-frames，单帧动作，宠物窗可播放）
 *
 * 与内置演示宠物的关系：形象互斥（同一时刻只有一只宠物形象生效），因此设为形象时会
 * 清掉内置演示宠物产生的动作与绑定（与 applyBuiltinPet 的互斥语义保持一致）。
 */

export interface PetLibraryAsset {
  /** 相对资源库根的路径，例如 ayangweb-BongoCat/xxx.png */
  file: string;
  sha256?: string;
  bytes?: number;
  /** raster=已归一化 PNG；svg=矢量原样登记（Chromium 可渲染，Pillow 不能栅格化） */
  format?: string;
  repo: string;
  repoUrl: string;
  license: string;
  originalPath: string;
}

export interface PetLibraryIndex {
  schemaVersion: number;
  generatedAt?: string;
  note?: string;
  entries: PetLibraryAsset[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // 矢量素材：主进程不栅格化（Pillow 不支持），但渲染端 <img> 可直接显示
  '.svg': 'image/svg+xml',
};

const IMAGE_EXTS = new Set(Object.keys(MIME_BY_EXT));
const VECTOR_EXTS = new Set(['.svg']);

/** 矢量素材只能预览：设为形象走 Pixi 纹理、加为动作走帧图复制，都不接受未栅格化的 SVG */
function isVector(file: string): boolean {
  return VECTOR_EXTS.has(path.extname(file).toLowerCase());
}

/** 资源库根目录：dev 用工程目录，打包后位于 process.resourcesPath（与 builtinPets 同策略） */
export function resolveLibraryDir(): string {
  const candidates: string[] = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'pet-asset-library'));
  candidates.push(path.join(app.getAppPath(), 'resources', 'pet-asset-library'));
  candidates.push(path.resolve(app.getAppPath(), '..', '..', 'resources', 'pet-asset-library'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return path.resolve(dir);
  }
  return path.resolve(candidates[0]);
}

/** 解析 manifest 内的相对路径，拒绝绝对路径与越界（..）—— 资源库是外部素材，必须防目录穿越 */
export function safeJoin(base: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return null;
  const resolved = path.resolve(base, rel);
  const inside = path.relative(base, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return resolved;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** 纯函数：校验并规范化资源库索引（非法条目丢弃而不是整体失败） */
export function parseLibraryIndex(raw: unknown): PetLibraryIndex {
  const empty: PetLibraryIndex = { schemaVersion: 1, entries: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const src = raw as Record<string, unknown>;
  const list = Array.isArray(src.entries) ? src.entries : [];
  const entries: PetLibraryAsset[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (!isNonEmptyString(e.file)) continue;
    const source = (e.source ?? {}) as Record<string, unknown>;
    // 只接受图片扩展名，且拒绝绝对路径/越界，避免索引被污染成任意文件读取入口
    const ext = path.extname(e.file).toLowerCase();
    if (!IMAGE_EXTS.has(ext) || path.isAbsolute(e.file) || e.file.includes('..')) continue;
    entries.push({
      file: e.file,
      sha256: typeof e.sha256 === 'string' ? e.sha256 : undefined,
      bytes: typeof e.bytes === 'number' ? e.bytes : undefined,
      format: typeof e.format === 'string' ? e.format : ext === '.svg' ? 'svg' : 'raster',
      repo: typeof source.repo === 'string' ? source.repo : '',
      repoUrl: typeof source.url === 'string' ? source.url : '',
      license: typeof source.license === 'string' ? source.license : '',
      originalPath: typeof source.originalPath === 'string' ? source.originalPath : '',
    });
  }
  entries.sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file));
  return {
    schemaVersion: typeof src.schemaVersion === 'number' ? src.schemaVersion : 1,
    generatedAt: typeof src.generatedAt === 'string' ? src.generatedAt : undefined,
    note: typeof src.note === 'string' ? src.note : undefined,
    entries,
  };
}

/** 读取资源库索引；目录/文件缺失时返回空列表，不抛错（与 listBuiltinPets 行为一致） */
export function readLibraryIndex(): PetLibraryIndex {
  try {
    const file = path.join(resolveLibraryDir(), 'index.json');
    if (!fs.existsSync(file)) return { schemaVersion: 1, entries: [] };
    return parseLibraryIndex(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

export interface PetLibrarySummary extends PetLibraryAsset {
  /** 磁盘上确实存在 */
  available: boolean;
}

export function listLibraryAssets(): PetLibrarySummary[] {
  const dir = resolveLibraryDir();
  return readLibraryIndex().entries.map((e) => {
    const full = safeJoin(dir, e.file);
    return { ...e, available: !!full && fs.existsSync(full) };
  });
}

/** 读取单张素材为 dataUrl（渲染端 <img> 直接用）；只允许索引内的文件 */
export function readLibraryAsset(file: string): { success: boolean; dataUrl?: string; error?: string } {
  const dir = resolveLibraryDir();
  const full = safeJoin(dir, file);
  if (!full) return { success: false, error: '资源路径非法' };
  if (!readLibraryIndex().entries.some((e) => e.file === file)) return { success: false, error: '该素材不在资源库索引内' };
  if (!fs.existsSync(full)) return { success: false, error: '素材文件不存在' };
  const mime = MIME_BY_EXT[path.extname(full).toLowerCase()];
  if (!mime) return { success: false, error: '不支持的图片格式' };
  try {
    return { success: true, dataUrl: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 设为形象：复制进 userData（打包后资源目录只读也不影响运行），并让出内置演示宠物 */
export function applyLibraryAsset(file: string, name?: string): { success: boolean; error?: string; path?: string } {
  const dir = resolveLibraryDir();
  const src = safeJoin(dir, file);
  if (!src) return { success: false, error: '资源路径非法' };
  if (isVector(file))
    return {
      success: false,
      error: '矢量素材（SVG）暂不能直接设为形象：请先用 scripts/pets/rasterize-svg.cjs 栅格化为 PNG',
    };
  const entry = readLibraryIndex().entries.find((e) => e.file === file);
  if (!entry) return { success: false, error: '该素材不在资源库索引内' };
  if (!fs.existsSync(src)) return { success: false, error: '素材文件不存在' };

  try {
    const ext = path.extname(src).toLowerCase();
    const stem = path.basename(src, ext).replace(/[^\w.-]+/g, '_').slice(0, 48) || 'asset';
    const targetDir = path.join(app.getPath('userData'), 'pet-library');
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${stem}${ext}`);
    fs.copyFileSync(src, target);

    // 形象互斥：清掉内置演示宠物的动作/绑定，避免留下指向旧宠物的互动
    clearBuiltinActions();
    saveConfig({
      petAssetPath: target,
      petAssetName: name?.trim() || `${entry.repo} · ${path.basename(file)}`,
      petAssetFormat: 'image',
      petAssetId: undefined,
      builtinPet: undefined,
    });
    return { success: true, path: target };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 加为动作：静态素材包成单帧动作（宠物窗可播放），复用既有动作链路 */
export function addLibraryAssetAsAction(
  file: string,
  name?: string,
): { success: boolean; error?: string; action?: PetAction } {
  const dir = resolveLibraryDir();
  const src = safeJoin(dir, file);
  if (!src) return { success: false, error: '资源路径非法' };
  if (isVector(file))
    return {
      success: false,
      error: '矢量素材（SVG）暂不能直接加为动作：请先用 scripts/pets/rasterize-svg.cjs 栅格化为 PNG',
    };
  const entry = readLibraryIndex().entries.find((e) => e.file === file);
  if (!entry) return { success: false, error: '该素材不在资源库索引内' };
  if (!fs.existsSync(src)) return { success: false, error: '素材文件不存在' };
  try {
    const action = addFramesAction(name?.trim() || `${entry.repo} · ${path.basename(file, path.extname(file))}`, [
      { filename: path.basename(src), data: fs.readFileSync(src) },
    ]);
    return { success: true, action };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
