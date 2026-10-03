/**
 * 宠物资源包分析（主进程侧：读文件头做内容探测 → 交 src/shared/petResource 定性）
 * ---------------------------------------------------------------------------
 * 修复的核心缺陷：安装宠物时过去只有「文件名 glob + 取目录里第一个文件」这条路径
 * （`findFirstFile(installDir, () => true)`），没有宠物本体定义，导致图标/背景/截图/
 * 表情包都可能被当成宠物形象装进宠物资源包。
 *
 * 本模块只做两件事：
 *   1) **内容探测**：只读文件头（不整图解码），得到宽高/帧数/是否有 alpha；
 *   2) **包级定性**：把探测结果交给 `src/shared/petResource` 的显式分类标准，
 *      选出本体入口或给出**显式失败原因**（不再静默兜底）。
 */
import fs from 'fs';
import path from 'path';
import {
  evaluatePetPack,
  type PetPackEvaluation,
  type ResourceEntry,
  type ResourceProbe,
} from '../shared/petResource';

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', '__MACOSX', 'dist', 'build', '.vite', 'out', 'coverage']);
const IMAGE_LIKE = new Set([
  '.png', '.apng', '.gif', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.ico',
  '.webm', '.mp4', '.mov', '.mkv', '.avi', '.moc3', '.cmo3', '.glb', '.gltf', '.vrm', '.fbx', '.obj', '.model3.json',
]);
/** 头部读取上限：GIF 计帧需要多读一点；其余格式 64KB 足够 */
const HEAD_BYTES = 256 * 1024;

export function walkPackFiles(dir: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 头部探测（不做整图解码）
// ---------------------------------------------------------------------------
function probePng(head: Buffer, size: number): ResourceProbe | undefined {
  if (head.length < 33 || head.readUInt32BE(0) !== 0x89504e47) return undefined;
  const colorType = head[25];
  // 遍历 PNG 块找 acTL（APNG 动画控制块）
  let offset = 8;
  let frames = 1;
  while (offset + 8 <= head.length) {
    const len = head.readUInt32BE(offset);
    const type = head.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') {
      frames = Math.max(2, head.readUInt32BE(offset + 8));
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + len;
  }
  return {
    width: head.readUInt32BE(16),
    height: head.readUInt32BE(20),
    frames,
    animated: frames > 1,
    hasAlpha: colorType === 4 || colorType === 6,
    bytes: size,
  };
}

function probeGif(head: Buffer, size: number): ResourceProbe | undefined {
  const sig = head.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined;
  let frames = 0;
  let transparent = false;
  for (let i = 0; i + 7 < head.length; i++) {
    if (head[i] === 0x21 && head[i + 1] === 0xf9) {
      frames++;
      if ((head[i + 3] & 0x01) === 1) transparent = true;
    }
  }
  return {
    width: head.readUInt16LE(6),
    height: head.readUInt16LE(8),
    frames: Math.max(frames, 1),
    // 头部可能截断导致少计帧：体积明显大于单帧时按动画处理
    animated: frames > 1 || (size > 4096 && frames <= 1),
    hasAlpha: transparent,
    bytes: size,
  };
}

function probeWebp(head: Buffer, size: number): ResourceProbe | undefined {
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return undefined;
  const chunk = head.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && head.length >= 30) {
    const flags = head[20];
    const width = (head.readUIntLE(24, 3) + 1) | 0;
    const height = (head.readUIntLE(27, 3) + 1) | 0;
    const animated = (flags & 0x02) !== 0;
    return { width, height, frames: animated ? 2 : 1, animated, hasAlpha: (flags & 0x10) !== 0, bytes: size };
  }
  if (chunk === 'VP8 ' && head.length >= 30) {
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, frames: 1, animated: false, hasAlpha: false, bytes: size };
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    const bits = head.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, frames: 1, animated: false, hasAlpha: true, bytes: size };
  }
  return { bytes: size };
}

function probeJpeg(head: Buffer, size: number): ResourceProbe | undefined {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < head.length) {
    if (head[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = head[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: head.readUInt16BE(i + 7), height: head.readUInt16BE(i + 5), frames: 1, animated: false, hasAlpha: false, bytes: size };
    }
    const len = head.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { frames: 1, animated: false, hasAlpha: false, bytes: size };
}

function probeBmp(head: Buffer, size: number): ResourceProbe | undefined {
  if (head.length < 30 || head.toString('latin1', 0, 2) !== 'BM') return undefined;
  const bitCount = head.readUInt16LE(28);
  return {
    width: Math.abs(head.readInt32LE(18)),
    height: Math.abs(head.readInt32LE(22)),
    frames: 1,
    animated: false,
    hasAlpha: bitCount === 32,
    bytes: size,
  };
}

/** 头部字节 → 探测结果（各格式解析的公共入口，文件与内存缓冲共用） */
function parseImageHead(head: Buffer, size: number, filename: string): ResourceProbe | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.webm' || ext === '.mp4' || ext === '.mov' || ext === '.mkv' || ext === '.avi') {
    // 视频载荷：不解析编码，按「多帧动画」处理（分类只关心它是不是动画）
    return { frames: 2, animated: true, bytes: size };
  }
  if (ext === '.moc3' || ext === '.cmo3' || ext === '.glb' || ext === '.gltf' || ext === '.vrm' || ext === '.fbx' || ext === '.obj') {
    return { bytes: size };
  }
  if (!IMAGE_LIKE.has(ext) && !/\.(live2d(-lite)?|model3)\.json$/i.test(filename)) return undefined;
  return probePng(head, size) ?? probeGif(head, size) ?? probeWebp(head, size) ?? probeJpeg(head, size) ?? probeBmp(head, size) ?? { bytes: size };
}

/** 内存缓冲探测（上传链路用：文件还没落盘时也要能定性） */
export function probeImageBuffer(buf: Buffer, filename: string): ResourceProbe | undefined {
  try {
    return parseImageHead(buf.subarray(0, Math.min(buf.length, HEAD_BYTES)), buf.length, filename);
  } catch {
    return undefined;
  }
}

/** 只读文件头探测图片/视频元数据；无法识别格式时返回 undefined（分类层会 fail-closed） */
export function probeImageFile(file: string): ResourceProbe | undefined {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }
  const ext = path.extname(file).toLowerCase();
  const isSpecial = ['.webm', '.mp4', '.mov', '.mkv', '.avi', '.moc3', '.cmo3', '.glb', '.gltf', '.vrm', '.fbx', '.obj'].includes(ext);
  if (isSpecial) return parseImageHead(Buffer.alloc(0), size, file);
  if (!IMAGE_LIKE.has(ext) && !/\.(live2d(-lite)?|model3)\.json$/i.test(file)) return undefined;

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, head, 0, head.length, 0);
    return parseImageHead(head, size, file);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 把一个目录（资源包解压根）变成分类输入：相对路径 + 内容探测 */
export function buildPackEntries(dir: string): ResourceEntry[] {
  return walkPackFiles(dir)
    .map((file) => ({
      path: path.relative(dir, file).split(path.sep).join('/'),
      probe: probeImageFile(file),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface PetAppearancePick {
  ok: boolean;
  /** 选中的本体入口绝对路径 */
  path?: string;
  /** 相对包根路径（写进 origin/日志用） */
  relative?: string;
  /** 推断形态：live2d / model3d / pack / image */
  format: 'image' | 'pack' | 'live2d' | 'model3d';
  evaluation: PetPackEvaluation;
  errors: string[];
}

const LIVE2D_ENTRY = /\.(model3|live2d(-lite)?)\.json$/i;
const MODEL3D_ENTRY = /\.(glb|gltf|vrm|fbx|obj)$/i;

/**
 * 从一个已解压的宠物资源包里挑出**本体入口**。
 * - declaredFormat 为 live2d/model3d 时，优先挑对应模型入口（保持既有形态语义）；
 * - 包里没有够格本体 → ok=false，errors 里是显式原因（调用方据此报错，绝不回落第一张图）。
 */
export function pickPetAppearance(dir: string, declaredFormat?: unknown): PetAppearancePick {
  const entries = buildPackEntries(dir);
  const evaluation = evaluatePetPack(entries);
  const errors = [...evaluation.errors];

  const declared = declaredFormat === 'live2d' || declaredFormat === 'model3d' || declaredFormat === 'pack' || declaredFormat === 'image' ? declaredFormat : undefined;

  let chosen = evaluation.entry;
  if (declared === 'live2d') {
    const candidates = evaluation.body.filter((b) => LIVE2D_ENTRY.test(b.path));
    if (!candidates.length) {
      errors.push('声明为 live2d，但包内没有 model3.json / live2d-lite.json 入口');
      return { ok: false, format: 'live2d', evaluation, errors };
    }
    chosen = candidates.sort((a, b) => a.path.localeCompare(b.path))[0];
  } else if (declared === 'model3d') {
    const candidates = evaluation.body.filter((b) => MODEL3D_ENTRY.test(b.path));
    if (!candidates.length) {
      errors.push('声明为 model3d，但包内没有 glb/gltf/vrm 入口');
      return { ok: false, format: 'model3d', evaluation, errors };
    }
    chosen = candidates.sort((a, b) => a.path.localeCompare(b.path))[0];
  }

  if (!chosen) {
    return { ok: false, format: declared ?? 'image', evaluation, errors };
  }

  const format: PetAppearancePick['format'] =
    declared ??
    (LIVE2D_ENTRY.test(chosen.path) ? 'live2d' : MODEL3D_ENTRY.test(chosen.path) ? 'model3d' : evaluation.body.length > 1 ? 'pack' : 'image');

  return {
    ok: true,
    path: path.join(dir, ...chosen.path.split('/')),
    relative: chosen.path,
    format,
    evaluation,
    errors,
  };
}
