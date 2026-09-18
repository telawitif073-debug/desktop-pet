import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { drawPetFrame, type PetDesign, type PetMotion } from './petCanvas';

/** GIF 循环参数：12 帧 × 100ms = 1.2s 一轮，与面板预览动画保持一致 */
export const GIF_LOOP_MS = 1200;
export const GIF_FRAMES = 12;
export const GIF_DELAY = 100;
const GIF_SIZE = 300;

function nearestColor(r: number, g: number, b: number, palette: number[][]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * 将参数化宠物逐帧渲染并编码为透明底 GIF：
 * 0 号调色板索引保留为透明色，不透明像素量化到 ≤255 色。
 */
export function encodePetGif(design: PetDesign, motion: PetMotion, loopMs = GIF_LOOP_MS): Blob {
  const canvas = document.createElement('canvas');
  canvas.width = GIF_SIZE;
  canvas.height = GIF_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');

  const gif = GIFEncoder();
  const frameDelay = loopMs / GIF_FRAMES;
  for (let i = 0; i < GIF_FRAMES; i++) {
    drawPetFrame(canvas, design, motion, (i * loopMs) / GIF_FRAMES);
    const { data } = ctx.getImageData(0, 0, GIF_SIZE, GIF_SIZE);

    // 仅不透明像素参与量化（最多 255 色，0 号保留给透明）
    const opaque: number[] = [];
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] >= 128) opaque.push(data[p], data[p + 1], data[p + 2]);
    }
    // gifenc 内部以 new Uint32Array(rgba.buffer) 读取像素，字节长度必须是 4 的倍数（不足则补 0）
    const opaqueBytes = new Uint8Array((opaque.length + 3) & ~3);
    opaqueBytes.set(opaque);
    const colors = quantize(opaqueBytes, 255);
    const palette = [[0, 0, 0], ...colors];
    const indices = applyPalette(data, palette);

    for (let p = 0, pi = 0; p < data.length; p += 4, pi++) {
      if (data[p + 3] < 128) {
        indices[pi] = 0; // 透明
      } else if (indices[pi] === 0 && colors.length) {
        // 不透明像素落到 0 号（黑色占位）时重找最近的真实颜色
        indices[pi] = 1 + nearestColor(data[p], data[p + 1], data[p + 2], colors);
      }
    }
    gif.writeFrame(indices, GIF_SIZE, GIF_SIZE, {
      palette,
      delay: frameDelay,
      transparent: true,
      transparentIndex: 0,
      repeat: 0,
    });
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

/** 加载 AI 主体透明 PNG（dataUrl → HTMLImageElement，GIF 编码与预览共用） */
export function loadSubjectImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('主体图加载失败'));
    img.src = dataUrl;
  });
}

/** t 时刻把主体图绘制到 300×300 画布（弹跳 + 呼吸挤压 + 轻摆，底部留 6% 边距；面板预览与 GIF 编码共用） */
export function drawSubjectFrame(canvas: HTMLCanvasElement, img: HTMLImageElement, tMs: number, loopMs = GIF_LOOP_MS): void {
  canvas.width = GIF_SIZE;
  canvas.height = GIF_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, GIF_SIZE, GIF_SIZE);
  const phase = (2 * Math.PI * tMs) / loopMs;
  const box = GIF_SIZE * 0.88;
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const breathe = 1 + 0.02 * Math.sin(phase * 2);
  const jump = 8 * Math.abs(Math.sin(phase));
  const sway = ((2.5 * Math.PI) / 180) * Math.sin(phase / 2);
  ctx.save();
  ctx.translate(GIF_SIZE / 2, GIF_SIZE - h / 2 - GIF_SIZE * 0.06 + jump);
  ctx.rotate(sway);
  ctx.scale(breathe, 2 - breathe);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** 将 AI 主体透明 PNG 编码为循环待机动画 GIF（弹跳+呼吸+轻摆，透明底，0 号调色板保留透明） */
export function encodeSubjectGif(img: HTMLImageElement, loopMs = GIF_LOOP_MS): Blob {
  const canvas = document.createElement('canvas');
  canvas.width = GIF_SIZE;
  canvas.height = GIF_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');

  const gif = GIFEncoder();
  const frameDelay = loopMs / GIF_FRAMES;
  for (let i = 0; i < GIF_FRAMES; i++) {
    drawSubjectFrame(canvas, img, (i * loopMs) / GIF_FRAMES, loopMs);
    const { data } = ctx.getImageData(0, 0, GIF_SIZE, GIF_SIZE);

    const opaque: number[] = [];
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] >= 128) opaque.push(data[p], data[p + 1], data[p + 2]);
    }
    const opaqueBytes = new Uint8Array((opaque.length + 3) & ~3);
    opaqueBytes.set(opaque);
    const colors = quantize(opaqueBytes, 255);
    const palette = [[0, 0, 0], ...colors];
    const indices = applyPalette(data, palette);

    for (let p = 0, pi = 0; p < data.length; p += 4, pi++) {
      if (data[p + 3] < 128) {
        indices[pi] = 0;
      } else if (indices[pi] === 0 && colors.length) {
        indices[pi] = 1 + nearestColor(data[p], data[p + 1], data[p + 2], colors);
      }
    }
    gif.writeFrame(indices, GIF_SIZE, GIF_SIZE, {
      palette,
      delay: frameDelay,
      transparent: true,
      transparentIndex: 0,
      repeat: 0,
    });
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}
