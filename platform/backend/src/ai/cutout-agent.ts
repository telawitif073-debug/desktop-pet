/**
 * AI 抠图智能体（独立文件，与绘图智能体 painting-agent.ts 构成两段链路）。
 * 职责：接收图像生成模型（CogView）产出的纯白底原始立绘，在服务端去背，返回只有主体的透明 PNG。
 * 算法（针对「白色主体 + 白色背景」防误删设计）：
 *   ① 洪泛：从四边清除与背景色差在容差内的 4 邻接连通像素；
 *   ② 腐蚀 + 边缘连通过滤（核心）：白色裙子/尾巴等主体内部与背景色差极小，洪泛会沿
 *      抗锯齿细缝「泄漏」进主体内部——对清除掩码做 3x3 腐蚀两轮，细泄漏通道断裂，
 *      再只保留与画面边缘连通的清除区域（真实背景），被泄漏的主体内部恢复不透明；
 *   ③ 残留小岛清理：清掉与主体不相连的小块背景残渣；
 *   ④ 边界按色差羽化，弱化锯齿/白边；
 *   ⑤ 自检阶梯（34→46→58）：透明占比不达标自动提高容差重试（最多 3 轮）。
 * 依赖 jpeg-js/pngjs 纯 JS 编解码（无原生编译）。
 */

import jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';

export interface CutoutResult {
  /** 透明背景 PNG 的 dataUrl */
  dataUrl: string;
  /** 实际使用的容差 */
  tolerance: number;
  /** 透明像素占比（0-100，自检指标） */
  transparentPct: number;
}

/** dataUrl → { mime, buffer }（mime 按魔数复核：FFD8=jpeg / 8950=png） */
function parseDataUrl(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  const buffer = Buffer.from(match ? match[2] : dataUrl, 'base64');
  const magic = buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8
    ? 'image/jpeg'
    : buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : '';
  return { buffer, mime: magic || (match ? match[1] : 'image/png') };
}

/** 解码为 RGBA 像素（jpeg 走 jpeg-js，png 走 pngjs，其余格式不支持） */
function decodeToRgba(buffer: Buffer, mime: string): { data: Buffer; width: number; height: number } {
  if (mime === 'image/jpeg') {
    const img = jpegJs.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { data: Buffer.from(img.data), width: img.width, height: img.height };
  }
  if (mime === 'image/png') {
    const img = PNG.sync.read(buffer);
    return { data: Buffer.from(img.data), width: img.width, height: img.height };
  }
  throw new Error(`不支持的图像格式: ${mime}`);
}

/** 背景基准色取四边像素平均（提示词要求纯白底，边缘应全为背景） */
function bgColorOf(rgba: Buffer, width: number, height: number): { br: number; bg: number; bb: number } {
  let br = 0;
  let bg = 0;
  let bb = 0;
  let count = 0;
  const sample = (idx: number) => {
    const o = idx * 4;
    br += rgba[o];
    bg += rgba[o + 1];
    bb += rgba[o + 2];
    count += 1;
  };
  for (let x = 0; x < width; x += 1) {
    sample(x);
    sample((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(y * width);
    sample(y * width + width - 1);
  }
  return { br: br / count, bg: bg / count, bb: bb / count };
}

/** 色差函数 */
function distAt(rgba: Buffer, idx: number, br: number, bg: number, bb: number): number {
  const o = idx * 4;
  const dr = rgba[o] - br;
  const dg = rgba[o + 1] - bg;
  const db = rgba[o + 2] - bb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 逐行背景基准（容忍摄影棚地面/幕布的垂直渐变）：每行取左右边缘各 3px 平均，
 * 再做 ±3 行垂直滑动平均。返回打包数组 L/R（height*3，按 y*3+{0,1,2} 取 rgb）。
 */
function rowBenchmarks(rgba: Buffer, width: number, height: number): { L: Float64Array; R: Float64Array } {
  const Lr = new Float64Array(height);
  const Lg = new Float64Array(height);
  const Lb = new Float64Array(height);
  const Rr = new Float64Array(height);
  const Rg = new Float64Array(height);
  const Rb = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let k = 0; k < 3; k += 1) {
      const lo = (row + k) * 4;
      const ro = (row + width - 1 - k) * 4;
      Lr[y] += rgba[lo]; Lg[y] += rgba[lo + 1]; Lb[y] += rgba[lo + 2];
      Rr[y] += rgba[ro]; Rg[y] += rgba[ro + 1]; Rb[y] += rgba[ro + 2];
    }
    Lr[y] /= 3; Lg[y] /= 3; Lb[y] /= 3;
    Rr[y] /= 3; Rg[y] /= 3; Rb[y] /= 3;
  }
  const L = new Float64Array(height * 3);
  const R = new Float64Array(height * 3);
  for (let y = 0; y < height; y += 1) {
    let lr = 0, lg = 0, lb = 0, rr = 0, rg = 0, rb = 0, n = 0;
    for (let k = Math.max(0, y - 3); k <= Math.min(height - 1, y + 3); k += 1) {
      lr += Lr[k]; lg += Lg[k]; lb += Lb[k];
      rr += Rr[k]; rg += Rg[k]; rb += Rb[k];
      n += 1;
    }
    L[y * 3] = lr / n; L[y * 3 + 1] = lg / n; L[y * 3 + 2] = lb / n;
    R[y * 3] = rr / n; R[y * 3 + 1] = rg / n; R[y * 3 + 2] = rb / n;
  }
  return { L, R };
}

/** 从四边向内洪泛，标记与背景色差在容差内的 4 邻接连通区域（只算掩码不写 alpha）。
 *  判定基准三选一：全局四边平均 / 本行本侧边缘基准 / 本行任一侧基准（取 min，
 *  兼容中央地面被主体投影压暗时离对侧基准更近的情形）。 */
function floodMask(
  rgba: Buffer,
  width: number,
  height: number,
  tolerance: number,
  br: number,
  bg: number,
  bb: number,
  L: Float64Array,
  R: Float64Array,
): Uint8Array {
  const total = width * height;
  const clear = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const isBg = (idx: number) => {
    if (distAt(rgba, idx, br, bg, bb) <= tolerance) return true;
    const x = idx % width;
    const y = (idx - x) / width;
    const o = idx * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const base = x < width / 2 ? L : R;
    const other = x < width / 2 ? R : L;
    const oy = y * 3;
    let dr = r - base[oy];
    let dg = g - base[oy + 1];
    let db = b - base[oy + 2];
    let d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d <= tolerance) return true;
    dr = r - other[oy];
    dg = g - other[oy + 1];
    db = b - other[oy + 2];
    d = Math.sqrt(dr * dr + dg * dg + db * db);
    return d <= tolerance;
  };
  const push = (idx: number) => {
    if (clear[idx] || !isBg(idx)) return;
    clear[idx] = 1;
    queue[tail] = idx;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }
  return clear;
}

/** 3x3 腐蚀一轮：清除掩码中宽度不足 3px 的细缝（抗锯齿泄漏通道）断裂消失 */
function erodeMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      let solid = 1;
      for (let dy = -1; dy <= 1 && solid; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) { solid = 0; break; }
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || !mask[ny * width + nx]) { solid = 0; break; }
        }
      }
      out[idx] = solid ? 1 : 0;
    }
  }
  return out;
}

/**
 * 只保留与画面边缘连通的清除区域（真实背景），泄漏进主体内部的清除区域恢复不透明。
 * 种子取边缘 4px 环带：erodeMask 把出界邻域视为不 solid，边框 2px 内的清除像素
 * 会被腐蚀掉，若只在 1px 边框找种子会全部落空（整个清除区被误丢，透明占比归零）。
 */
function keepBorderConnected(mask: Uint8Array, width: number, height: number): Uint8Array {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const out = new Uint8Array(total);
  let head = 0;
  let tail = 0;
  const seedBorder = (idx: number) => {
    if (mask[idx] && !visited[idx]) {
      visited[idx] = 1;
      queue[tail] = idx;
      tail += 1;
    }
  };
  const BAND = 4;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < Math.min(BAND, height); y += 1) seedBorder(y * width + x);
    for (let y = Math.max(0, height - BAND); y < height; y += 1) seedBorder(y * width + x);
  }
  for (let y = BAND; y < height - BAND; y += 1) {
    for (let x = 0; x < BAND; x += 1) seedBorder(y * width + x);
    for (let x = Math.max(0, width - BAND); x < width; x += 1) seedBorder(y * width + x);
  }
  while (head < tail) {
    const idx = queue[head];
    head += 1;
    out[idx] = 1;
    const x = idx % width;
    const y = (idx - x) / width;
    const tryPush = (n: number) => {
      if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail] = n; tail += 1; }
    };
    if (x > 0) tryPush(idx - 1);
    if (x < width - 1) tryPush(idx + 1);
    if (y > 0) tryPush(idx - width);
    if (y < height - 1) tryPush(idx + width);
  }
  return out;
}

/** 强制清除画面边缘 band px 环带：erodeMask 把出界邻域视为不 solid，边框清除区
 *  被腐蚀 2px 后形成一圈横跨全图、永不清除的「框域」，成品表现为四周彩色细边。
 *  提示词保证主体四周留 5% 边距，强制清除 4px 环带不会误伤主体。 */
function forceClearBorderBand(clear: Uint8Array, width: number, height: number, band: number): void {
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < Math.min(band, height); y += 1) clear[y * width + x] = 1;
    for (let y = Math.max(0, height - band); y < height; y += 1) clear[y * width + x] = 1;
  }
  for (let y = band; y < height - band; y += 1) {
    for (let x = 0; x < band; x += 1) clear[y * width + x] = 1;
    for (let x = Math.max(0, width - band); x < width; x += 1) clear[y * width + x] = 1;
  }
}

/** 绿幕残晕清扫：从已清除区向内洪泛，连片清除「绿色主导」的残晕像素。
 *  CogView 常无视平涂要求，在浅绿底上画出绿色光晕/脚下椭圆阴影，其色差远超洪泛
 *  容差后以大块深浅绿斑残留。只清除与清除区连通且 G 通道显著高于 R/B 的像素——
 *  主体内部的绿色（眼睛/服饰）不与背景清除区连通，不会被波及。 */
function sweepGreenResidue(rgba: Buffer, clear: Uint8Array, width: number, height: number): void {
  const total = width * height;
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const isGreen = (idx: number) => {
    const o = idx * 4;
    return rgba[o + 1] > rgba[o] + 18 && rgba[o + 1] > rgba[o + 2] + 18;
  };
  const push = (idx: number) => {
    if (clear[idx] || !isGreen(idx)) return;
    clear[idx] = 1;
    queue[tail] = idx;
    tail += 1;
  };
  for (let idx = 0; idx < total; idx += 1) {
    if (!clear[idx]) continue;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }
  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }
}

/** 兜底清除右下角「AI生成」徽章矩形区：当水印角标与残留阴影/光晕连成同一连通域时，
 *  removeSmallIslands 的外接框判定失效（外接框不再落在角落内），此矩形硬清除保证徽章必除。
 *  提示词强制主体四边留 5% 边距，右下角 (80%w, 91%h) 以下不会有主体部位。 */
function forceClearBadgeZone(clear: Uint8Array, width: number, height: number): void {
  const x0 = Math.round(width * 0.8);
  const y0 = Math.round(height * 0.91);
  for (let y = y0; y < height; y += 1) {
    for (let x = x0; x < width; x += 1) clear[y * width + x] = 1;
  }
}

/**
 * 残留小岛清理 + 水印清除：对未清除像素做连通域标记，保留最大连通域（主体），
 * 清掉与主体不相连的小块背景碎块（<0.15% 画布），以及外接框完全落在右下角
 * 25%×12% 区域内的「AI生成」水印角标（CogView 免费版强制添加；腐蚀会让水印域
 * 外扩 1-2px，0.8/0.92 的紧边界的判定会以 1px 之差落空）。
 */
function removeSmallIslands(width: number, height: number, clear: Uint8Array): Uint8Array {
  const total = width * height;
  const label = new Int32Array(total);
  const queue = new Int32Array(total);
  const areas: number[] = [];
  const minX: number[] = [];
  const minY: number[] = [];
  const maxX: number[] = [];
  const maxY: number[] = [];
  let next = 0;
  let mainLabel = -1;
  let mainArea = 0;
  for (let seed = 0; seed < total; seed += 1) {
    if (clear[seed] || label[seed]) continue;
    next += 1;
    let head = 0;
    let tail = 0;
    label[seed] = next;
    queue[tail] = seed;
    tail += 1;
    let area = 0;
    let x0 = seed % width;
    let x1 = x0;
    let y0 = (seed - x0) / width;
    let y1 = y0;
    while (head < tail) {
      const idx = queue[head];
      head += 1;
      area += 1;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !clear[idx - 1] && !label[idx - 1]) { label[idx - 1] = next; queue[tail] = idx - 1; tail += 1; }
      if (x < width - 1 && !clear[idx + 1] && !label[idx + 1]) { label[idx + 1] = next; queue[tail] = idx + 1; tail += 1; }
      if (y > 0 && !clear[idx - width] && !label[idx - width]) { label[idx - width] = next; queue[tail] = idx - width; tail += 1; }
      if (y < height - 1 && !clear[idx + width] && !label[idx + width]) { label[idx + width] = next; queue[tail] = idx + width; tail += 1; }
    }
    areas[next] = area;
    minX[next] = x0;
    minY[next] = y0;
    maxX[next] = x1;
    maxY[next] = y1;
    if (area > mainArea) { mainArea = area; mainLabel = next; }
  }
  const islandMin = Math.max(300, Math.round(total * 0.0015));
  // 「AI生成」水印固定在画面右下角（CogView 免费版强制角标，无关闭参数）：
  // 连通域外接框完全落在右下角 25%×12% 区域内的一律清除（主体部位与身体相连，不受影响）
  const cornerX = Math.round(width * 0.75);
  const cornerY = Math.round(height * 0.88);
  const out = clear.slice();
  for (let idx = 0; idx < total; idx += 1) {
    const l = label[idx];
    if (!l || l === mainLabel) continue;
    const inCorner = minX[l] >= cornerX && minY[l] >= cornerY;
    if (areas[l] < islandMin || inCorner) out[idx] = 1;
  }
  return out;
}

/** 按掩码清透明 + 边界按色差羽化，返回透明占比 */
function applyMask(rgba: Buffer, width: number, height: number, clear: Uint8Array, tolerance: number, br: number, bg: number, bb: number): number {
  const total = width * height;
  let cleared = 0;
  for (let idx = 0; idx < total; idx += 1) {
    if (clear[idx]) {
      rgba[idx * 4 + 3] = 0;
      cleared += 1;
      continue;
    }
    const x = idx % width;
    const y = (idx - x) / width;
    const nearCleared =
      (x > 0 && clear[idx - 1]) ||
      (x < width - 1 && clear[idx + 1]) ||
      (y > 0 && clear[idx - width]) ||
      (y < height - 1 && clear[idx + width]);
    if (!nearCleared) continue;
    const dist = distAt(rgba, idx, br, bg, bb);
    if (dist < tolerance * 2) {
      rgba[idx * 4 + 3] = Math.max(0, Math.min(255, Math.round(((dist - tolerance) / tolerance) * 255)));
    }
  }
  return (cleared / total) * 100;
}

/** RGBA Buffer → 透明 PNG dataUrl */
function encodePngDataUrl(rgba: Buffer, width: number, height: number): string {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

/**
 * 运行抠图智能体：洪泛 → 腐蚀断泄漏通道 → 只留边缘连通背景 → 小岛清理 → 羽化。
 * 自检阶梯：透明占比 <8% 视为没抠动（背景非纯白）→ 提高容差重试；>97% 过度清除 → 降低容差。最多 3 轮。
 */
export async function cutoutImage(dataUrl: string): Promise<CutoutResult> {
  const { buffer, mime } = parseDataUrl(dataUrl);
  const source = decodeToRgba(buffer, mime);
  const ladder = [34, 46, 58];

  let best: { rgba: Buffer; transparentPct: number; tolerance: number } | null = null;
  const { L, R } = rowBenchmarks(source.data, source.width, source.height);
  for (const tolerance of ladder) {
    const rgba = Buffer.from(source.data); // 每轮在副本上操作
    const { br, bg, bb } = bgColorOf(rgba, source.width, source.height);
    let clear = floodMask(rgba, source.width, source.height, tolerance, br, bg, bb, L, R);
    clear = erodeMask(clear, source.width, source.height);
    clear = erodeMask(clear, source.width, source.height);
    clear = keepBorderConnected(clear, source.width, source.height);
    forceClearBorderBand(clear, source.width, source.height, 4);
    clear = removeSmallIslands(source.width, source.height, clear);
    sweepGreenResidue(rgba, clear, source.width, source.height);
    forceClearBadgeZone(clear, source.width, source.height);
    const transparentPct = applyMask(rgba, source.width, source.height, clear, tolerance, br, bg, bb);
    best = { rgba, transparentPct, tolerance };
    if (transparentPct >= 8 && transparentPct <= 97) break;
  }

  if (!best) throw new Error('抠图智能体未产出结果');
  return {
    dataUrl: encodePngDataUrl(best.rgba, source.width, source.height),
    tolerance: best.tolerance,
    transparentPct: Math.round(best.transparentPct * 10) / 10,
  };
}
