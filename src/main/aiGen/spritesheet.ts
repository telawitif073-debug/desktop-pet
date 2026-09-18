/**
 * 精灵表拼装（路径A 最后一段）——自平台后端 spritesheet.ts 原样移植：
 *   ① 视频均匀截帧（ffmpeg-static，每状态 6 帧）；
 *   ② 逐帧绿幕抠图（复用 cutout.ts）；
 *   ③ 全帧统一 bbox 裁剪 + 居中缩放进 256×256 格，6列×5行拼合（行序 idle/moving/eating/resting/playing）；
 *   ④ 产出 spritesheet.png（dataUrl）与 animations.json。
 */

import { execFile } from 'child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { PNG } from 'pngjs';
import { cutoutBuffer } from './cutout';

/** 状态行序与帧率（与客户端 SpriteAnimator 约定一致） */
export const STATE_ROWS = ['idle', 'moving', 'eating', 'resting', 'playing'] as const;
export type StateName = (typeof STATE_ROWS)[number];
export const FPS_BY_STATE: Record<StateName, number> = { idle: 4, moving: 8, eating: 6, resting: 3, playing: 10 };
const CELL = 256;
const FRAMES_PER_STATE = 6;

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg 执行失败: ${String(stderr).slice(-400)}`));
      else resolve(String(stderr));
    });
  });
}

/** 从视频 Buffer 均匀截取 count 帧 PNG（先解析时长，再按 fps=count/duration 抽帧） */
export async function extractFrames(video: Buffer, count = FRAMES_PER_STATE): Promise<Buffer[]> {
  if (!ffmpegPath) throw new Error('ffmpeg-static 二进制缺失');
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-frames-'));
  try {
    const videoPath = path.join(dir, 'input.mp4');
    await writeFile(videoPath, video);
    // 一趟解析时长（-i 无输出文件会以退出码 1 结束，但 stderr 含 Duration）
    const probe = await new Promise<string>((resolve) => {
      execFile(ffmpegPath as string, ['-i', videoPath], { windowsHide: true }, (_e, _o, stderr) => resolve(String(stderr)));
    });
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(probe);
    if (!m) throw new Error('无法解析视频时长');
    const duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (!(duration > 0)) throw new Error('视频时长异常');
    await run(ffmpegPath as string, [
      '-y', '-i', videoPath,
      '-vf', `fps=${count / duration}`,
      '-frames:v', String(count),
      '-start_number', '0',
      path.join(dir, 'frame_%02d.png'),
    ]);
    const names = (await readdir(dir)).filter((n) => n.startsWith('frame_')).sort();
    const frames: Buffer[] = [];
    for (const name of names) frames.push(await readFile(path.join(dir, name)));
    if (frames.length === 0) throw new Error('视频截帧结果为空');
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface FrameBitmap {
  data: Buffer;
  width: number;
  height: number;
}

/** 双线性缩放 RGBA 位图 */
function resizeBilinear(src: FrameBitmap, dw: number, dh: number): FrameBitmap {
  const out = Buffer.alloc(dw * dh * 4);
  const { width: sw, height: sh, data } = src;
  for (let y = 0; y < dh; y += 1) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = data[(y0 * sw + x0) * 4 + c];
        const p01 = data[(y0 * sw + x1) * 4 + c];
        const p10 = data[(y1 * sw + x0) * 4 + c];
        const p11 = data[(y1 * sw + x1) * 4 + c];
        out[o + c] = Math.round(
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy,
        );
      }
    }
  }
  return { data: out, width: dw, height: dh };
}

/** 把位图绘制到目标画布指定位置（带透明混合，直接覆盖非透明像素） */
function blit(dst: PNG, src: FrameBitmap, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const so = (y * src.width + x) * 4;
      if (src.data[so + 3] === 0) continue;
      const to = (ty * dst.width + tx) * 4;
      dst.data[to] = src.data[so];
      dst.data[to + 1] = src.data[so + 1];
      dst.data[to + 2] = src.data[so + 2];
      dst.data[to + 3] = src.data[so + 3];
    }
  }
}

export interface SpriteSheetResult {
  sheetDataUrl: string;
  animations: Record<string, unknown>;
  previewDataUrl: string;
}

/**
 * 构建精灵表：stateFrames[状态] = 该状态视频截出的 PNG 帧数组（绿幕底）。
 * 全帧统一按联合 bbox 裁剪对齐（避免帧间抖动），居中缩放进 256×256 格。
 */
export async function buildSpriteSheet(stateFrames: Record<StateName, Buffer[]>): Promise<SpriteSheetResult> {
  // ① 逐帧抠图
  const cutFrames = new Map<StateName, { data: Buffer; width: number; height: number }[]>();
  let ux0 = Infinity; let uy0 = Infinity; let ux1 = -Infinity; let uy1 = -Infinity;
  for (const state of STATE_ROWS) {
    const frames = stateFrames[state] || [];
    if (frames.length === 0) throw new Error(`状态 ${state} 缺少视频帧`);
    const list: { data: Buffer; width: number; height: number }[] = [];
    for (const frame of frames) {
      const cut = await cutoutBuffer(frame, 'image/png');
      if (cut.bbox) {
        ux0 = Math.min(ux0, cut.bbox.x0); uy0 = Math.min(uy0, cut.bbox.y0);
        ux1 = Math.max(ux1, cut.bbox.x1); uy1 = Math.max(uy1, cut.bbox.y1);
      }
      const png = PNG.sync.read(Buffer.from(cut.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      list.push({ data: Buffer.from(png.data), width: png.width, height: png.height });
    }
    cutFrames.set(state, list);
  }
  if (!Number.isFinite(ux0)) throw new Error('所有帧均为空，无法拼合精灵表');

  // ② 统一 bbox 裁剪 + 等比缩放进格（留 8px 边距）
  const bw = ux1 - ux0 + 1;
  const bh = uy1 - uy0 + 1;
  const scale = Math.min((CELL - 16) / bw, (CELL - 16) / bh);
  const dw = Math.max(1, Math.round(bw * scale));
  const dh = Math.max(1, Math.round(bh * scale));

  const sheet = new PNG({ width: CELL * 6, height: CELL * 5 });
  let previewDataUrl = '';
  for (let row = 0; row < STATE_ROWS.length; row += 1) {
    const state = STATE_ROWS[row];
    const frames = cutFrames.get(state)!;
    for (let col = 0; col < FRAMES_PER_STATE; col += 1) {
      const frame = frames[Math.min(col, frames.length - 1)];
      // 联合 bbox 裁剪
      const cw = Math.min(ux1 + 1, frame.width) - ux0;
      const ch = Math.min(uy1 + 1, frame.height) - uy0;
      const cropped: FrameBitmap = { width: cw, height: ch, data: Buffer.alloc(cw * ch * 4) };
      for (let y = 0; y < ch; y += 1) {
        const srcRow = ((uy0 + y) * frame.width + ux0) * 4;
        cropped.data.set(frame.data.subarray(srcRow, srcRow + cw * 4), y * cw * 4);
      }
      const scaled = resizeBilinear(cropped, dw, dh);
      const dx = col * CELL + Math.floor((CELL - dw) / 2);
      const dy = row * CELL + Math.floor((CELL - dh) / 2);
      blit(sheet, scaled, dx, dy);
      if (state === 'idle' && col === 0) {
        const preview = new PNG({ width: CELL, height: CELL });
        blit(preview, scaled, Math.floor((CELL - dw) / 2), Math.floor((CELL - dh) / 2));
        previewDataUrl = `data:image/png;base64,${PNG.sync.write(preview).toString('base64')}`;
      }
    }
  }

  const animations: Record<string, unknown> = {
    renderMode: 'sprite',
    frameWidth: CELL,
    frameHeight: CELL,
    animations: Object.fromEntries(
      STATE_ROWS.map((state, row) => [state, { row, frames: FRAMES_PER_STATE, fps: FPS_BY_STATE[state] }]),
    ),
  };
  return {
    sheetDataUrl: `data:image/png;base64,${PNG.sync.write(sheet).toString('base64')}`,
    animations,
    previewDataUrl,
  };
}
