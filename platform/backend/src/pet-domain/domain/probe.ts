/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 图片/视频「肩部」头部探测（纯逻辑，不做整图解码）
 * ---------------------------------------------------------------------------
 * 为什么在共享包里：桌面端安装（读本地文件）与服务端发布（读 zip 条目）**必须用同一份探测**，
 * 否则会出现「服务端按某尺寸/alpha 判合格、客户端算出不同结果装不上」（设计文档 D2）。
 *
 * 边界原则（与整个 `packages/pet-domain` 一致）：只依赖 ES 标准对象
 * （`Uint8Array` / `DataView`），**不用 Node 内置**（`Buffer` / `path` / `fs`）——
 * 这样移动端（Hermes）也能打包同一份代码。
 *
 * 只读文件头即可定性：PNG/APNG 宽高+alpha+帧数、GIF 帧数与透明、
 * WebP（VP8X/VP8/VP8L）、JPEG（SOF）、BMP 宽高与 32 位 alpha；视频/模型按扩展名定性。
 */

import type { ResourceProbe } from './resource';

/**
 * 头部读取上限：GIF 计帧需要多读一些，其余格式 64KB 足够。
 * 桌面端按文件读取、服务端按 zip 条目截断，**两侧都用这个常量**以保持口径一致。
 */
export const PROBE_HEAD_BYTES = 256 * 1024;

const VIDEO_EXTS = new Set(['.webm', '.mp4', '.mov', '.mkv', '.avi']);
const MODEL_EXTS = new Set(['.moc3', '.cmo3', '.glb', '.gltf', '.vrm', '.fbx', '.obj']);
const IMAGE_EXTS = new Set([
  '.png', '.apng', '.gif', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.ico',
]);
/** 真正会解析字节的扩展名（其余可只看扩展名+体积，无需读内容，见 {@link probeNeedsBytes}） */
const PARSED_EXTS = new Set(['.png', '.apng', '.gif', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp']);
const LIVE2D_JSON_RE = /\.(live2d(-lite)?|model3)\.json$/i;

/** 取小写扩展名（纯实现，替代 Node 的 `path.extname`） */
const extname = (p: string): string => {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};

/** 该文件是否需要读取内容才能探测（栅格图需要；视频/模型/Live2D 清单只看扩展名与体积） */
export function probeNeedsBytes(filename: string): boolean {
  return PARSED_EXTS.has(extname(filename));
}

/** 该文件是否值得探测（其它类型不产生 probe，分类层会按扩展名/路径判定） */
export function isProbeablePath(filename: string): boolean {
  const ext = extname(filename);
  return VIDEO_EXTS.has(ext) || MODEL_EXTS.has(ext) || IMAGE_EXTS.has(ext) || LIVE2D_JSON_RE.test(filename);
}

/** 按字节读 ASCII（替代 `Buffer.toString('latin1')`，避免 Node 依赖） */
const ascii = (b: Uint8Array, start: number, end: number): string => {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
};

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

function probePng(head: Uint8Array, size: number): ResourceProbe | undefined {
  if (head.length < 33 || view(head).getUint32(0) !== 0x89504e47) return undefined;
  const dv = view(head);
  const colorType = head[25];
  // 遍历 PNG 块找 acTL（APNG 动画控制块）
  let offset = 8;
  let frames = 1;
  while (offset + 8 <= head.length) {
    const len = dv.getUint32(offset);
    const type = ascii(head, offset + 4, offset + 8);
    if (type === 'acTL') {
      frames = Math.max(2, dv.getUint32(offset + 8));
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + len;
  }
  return {
    width: dv.getUint32(16),
    height: dv.getUint32(20),
    frames,
    animated: frames > 1,
    hasAlpha: colorType === 4 || colorType === 6,
    bytes: size,
  };
}

function probeGif(head: Uint8Array, size: number): ResourceProbe | undefined {
  if (head.length < 10) return undefined;
  const sig = ascii(head, 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined;
  const dv = view(head);
  let frames = 0;
  let transparent = false;
  for (let i = 0; i + 7 < head.length; i++) {
    if (head[i] === 0x21 && head[i + 1] === 0xf9) {
      frames++;
      if ((head[i + 3] & 0x01) === 1) transparent = true;
    }
  }
  return {
    width: dv.getUint16(6, true),
    height: dv.getUint16(8, true),
    frames: Math.max(frames, 1),
    // 头部可能截断导致少计帧：体积明显大于单帧时按动画处理
    animated: frames > 1 || (size > 4096 && frames <= 1),
    hasAlpha: transparent,
    bytes: size,
  };
}

function probeWebp(head: Uint8Array, size: number): ResourceProbe | undefined {
  if (head.length < 12 || ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 12) !== 'WEBP') return undefined;
  const dv = view(head);
  const chunk = ascii(head, 12, 16);
  if (chunk === 'VP8X' && head.length >= 30) {
    const flags = head[20];
    const width = (dv.getUint8(24) | (dv.getUint8(25) << 8) | (dv.getUint8(26) << 16)) + 1;
    const height = (dv.getUint8(27) | (dv.getUint8(28) << 8) | (dv.getUint8(29) << 16)) + 1;
    const animated = (flags & 0x02) !== 0;
    return { width, height, frames: animated ? 2 : 1, animated, hasAlpha: (flags & 0x10) !== 0, bytes: size };
  }
  if (chunk === 'VP8 ' && head.length >= 30) {
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, frames: 1, animated: false, hasAlpha: false, bytes: size };
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    const bits = dv.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, frames: 1, animated: false, hasAlpha: true, bytes: size };
  }
  return { bytes: size };
}

function probeJpeg(head: Uint8Array, size: number): ResourceProbe | undefined {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return undefined;
  const dv = view(head);
  let i = 2;
  while (i + 9 < head.length) {
    if (head[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = head[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5), frames: 1, animated: false, hasAlpha: false, bytes: size };
    }
    const len = dv.getUint16(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { frames: 1, animated: false, hasAlpha: false, bytes: size };
}

function probeBmp(head: Uint8Array, size: number): ResourceProbe | undefined {
  if (head.length < 30 || ascii(head, 0, 2) !== 'BM') return undefined;
  const dv = view(head);
  const bitCount = dv.getUint16(28, true);
  return {
    width: Math.abs(dv.getInt32(18, true)),
    height: Math.abs(dv.getInt32(22, true)),
    frames: 1,
    animated: false,
    hasAlpha: bitCount === 32,
    bytes: size,
  };
}

/**
 * 头部字节 → 探测结果。
 * - `head` 只需前若干字节（调用方按 {@link PROBE_HEAD_BYTES} 截断即可）；
 * - `size` 是**完整文件体积**（用于 GIF 的动画兜底判断与 `probe.bytes`）；
 * - 无法识别/截断/损坏时返回一个只带 `bytes` 的结果（分类层会据此 fail-closed），
 *   只有「非可探测类型」才返回 `undefined`。
 */
export function probeImageHead(head: Uint8Array, size: number, filename: string): ResourceProbe | undefined {
  try {
    const ext = extname(filename);
    if (VIDEO_EXTS.has(ext)) {
      // 视频载荷：不解析编码，按「多帧动画」处理（分类只关心它是不是动画）
      return { frames: 2, animated: true, bytes: size };
    }
    if (MODEL_EXTS.has(ext)) {
      return { bytes: size };
    }
    if (!IMAGE_EXTS.has(ext) && !LIVE2D_JSON_RE.test(filename)) return undefined;
    return probePng(head, size) ?? probeGif(head, size) ?? probeWebp(head, size) ?? probeJpeg(head, size) ?? probeBmp(head, size) ?? { bytes: size };
  } catch {
    return undefined;
  }
}

/** 不读内容即可得的探测结果（视频/模型/Live2D 清单，`head` 可为空） */
export function probeByMeta(filename: string, size: number): ResourceProbe | undefined {
  return probeImageHead(new Uint8Array(0), size, filename);
}
