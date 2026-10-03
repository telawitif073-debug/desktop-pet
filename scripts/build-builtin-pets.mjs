#!/usr/bin/env node
/**
 * 内置原创演示宠物 · 美术生成器（纯 Node，无第三方依赖）
 * ---------------------------------------------------------------------------
 * 产物：resources/builtin-pets/<petId>/{manifest.json, cover.png, actions/<aid>/frame_NNN.png}
 *
 * 设计约束（与渲染端 App.tsx 对齐，改动前务必先读）：
 *  1) 每一帧都是**完整 512×512 画布**、角色同位置同尺寸 —— 渲染端对 cover 与帧序列
 *     使用同一缩放公式 min((W-60)/w, (H-60)/h)，只有画布尺寸一致才不会跳变。
 *  2) 动作 loop=false（播完回本体），所以**每套动作首尾帧必须是中性姿态**，否则会 pop。
 *  3) 透明底 RGBA；输出严格确定性（同参数同字节），便于「跑两遍无 diff」核验。
 *
 * 美术来源两条路线：
 *  - procedural（默认）：本脚本逐像素解析式绘制 + 确定性派生动画帧。
 *  - t2i（可选）：若存在缓存底图 resources/builtin-pets/.t2i-cache/<petId>-cover.png，
 *    则用它作为 cover（经无依赖 flood-fill 抠底），帧仍由程序化派生，
 *    provenance.kind 记为 't2i'，并在 manifest 里保留 prompt/model 以便追溯。
 *
 * 用法：node scripts/build-builtin-pets.mjs [petId ...]   （缺省=全部）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'resources', 'builtin-pets');
const T2I_CACHE = path.join(OUT_ROOT, '.t2i-cache');

const SIZE = 512;
const GENERATOR_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// PNG 编码（IHDR / tEXt / IDAT / IEND，全部 8bit RGBA，filter 0）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array(w*h*4) 非预乘 */
function encodePng(width, height, rgba, textChunks = {}) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < width * 4; x++) raw[rowStart + 1 + x] = rgba[y * width * 4 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
  for (const [key, value] of Object.entries(textChunks)) {
    parts.push(pngChunk('tEXt', Buffer.from(`${key}\0${String(value)}`, 'latin1')));
  }
  parts.push(pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('仅支持 8bit RGBA 输入');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    if (raw[rowStart] !== 0) throw new Error('仅支持 filter 0');
    for (let x = 0; x < width * 4; x++) rgba[y * width * 4 + x] = raw[rowStart + 1 + x];
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// 光栅化基元
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 旋转后的归一化椭圆距离（<=1 为内部） */
function rotDist(x, y, cx, cy, rx, ry, ang) {
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  const px = x - cx;
  const py = y - cy;
  const ux = px * c - py * s;
  const uy = px * s + py * c;
  return Math.hypot(ux / rx, uy / ry);
}

/** 超椭圆归一化距离（n>2 更方正，n=2 即椭圆） */
function superDist(x, y, cx, cy, rx, ry, n) {
  const dx = Math.abs((x - cx) / rx);
  const dy = Math.abs((y - cy) / ry);
  if (dx >= 1 && dy >= 1) return 1e9;
  return Math.pow(Math.pow(dx, n) + Math.pow(dy, n), 1 / n);
}

/** 归一化距离 → 覆盖率（soft 为归一化单位下的半像素宽度） */
const coverageFromDist = (d, soft) => clamp((1 - d) / soft + 0.5, 0, 1);

const softOf = (rx, ry) => 1.5 / Math.min(rx, ry);

function blendPx(buf, i, r, g, b, a) {
  if (a <= 0.002) return;
  const inv = 1 - a;
  buf[i] = r * a + buf[i] * inv;
  buf[i + 1] = g * a + buf[i + 1] * inv;
  buf[i + 2] = b * a + buf[i + 2] * inv;
  buf[i + 3] = a + buf[i + 3] * inv;
}

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// ---------------------------------------------------------------------------
// 角色几何：由 palette/proportions 参数化，方便 1 → N 只复用
// ---------------------------------------------------------------------------
function silhouette(pet, pose) {
  const b = pet.body;
  const ears = [-1, 1].map((side) => ({
    cx: b.cx + side * pet.ear.dx,
    cy: pet.ear.y + (side === -1 ? pose.earLeft : pose.earRight),
    rx: pet.ear.rx,
    ry: pet.ear.ry,
    ang: side * pet.ear.tilt + pose.earTwist * side,
  }));
  const tail = [];
  const rad = (pose.tailDeg * Math.PI) / 180;
  const pivotX = b.cx + b.rx * 0.86;
  const pivotY = b.cy + b.ry * 0.5;
  // 10 个采样圆：太少会让尾尖出现扇贝状缺口（描边从凹口透出）
  for (let k = 0; k < 10; k++) {
    const t = k / 9;
    const lx = pet.tail.dx + pet.tail.travelX * t + pet.tail.curveX * t * t;
    const ly = pet.tail.dy + pet.tail.travelY * t + pet.tail.curveY * t * t;
    tail.push({
      x: pivotX + lx * Math.cos(rad) - ly * Math.sin(rad),
      y: pivotY + lx * Math.sin(rad) + ly * Math.cos(rad),
      r: mix(pet.tail.r0, pet.tail.r1, t),
    });
  }
  return { ears, tail };
}

/** 轮廓覆盖率（expand 为外扩像素，用于描边） */
function coverOf(x, y, pet, pose, expand) {
  const { ears, tail } = pose._shapes;
  let m = 0;
  for (const c of tail) {
    const r = c.r + expand;
    m = Math.max(m, clamp((r - Math.hypot(x - c.x, y - c.y)) / 1.8 + 0.5, 0, 1));
  }
  for (const e of ears) {
    const rx = e.rx + expand;
    const ry = e.ry + expand;
    m = Math.max(m, coverageFromDist(rotDist(x, y, e.cx, e.cy, rx, ry, e.ang), softOf(rx, ry)));
  }
  const b = pet.body;
  const rx = b.rx + expand;
  const ry = b.ry + expand;
  m = Math.max(m, coverageFromDist(superDist(x, y, b.cx, b.cy, rx, ry, b.n), softOf(rx, ry)));
  return m;
}

function shadeAt(x, y, pet) {
  const b = pet.body;
  const t = clamp((y - (b.cy - b.ry * 0.1)) / (b.ry * 1.5), 0, 1);
  let c = [
    mix(pet.bodyColor[0], pet.bodyDark[0], 0.42 * t),
    mix(pet.bodyColor[1], pet.bodyDark[1], 0.42 * t),
    mix(pet.bodyColor[2], pet.bodyDark[2], 0.42 * t),
  ];
  const hx = b.cx - b.rx * 0.32;
  const hy = b.cy - b.ry * 0.52;
  const hd = Math.hypot((x - hx) / (b.rx * 0.82), (y - hy) / (b.ry * 0.82));
  const h = smoothstep(1.0, 0.15, hd) * 0.55;
  c = [
    mix(c[0], pet.bodyLight[0], h),
    mix(c[1], pet.bodyLight[1], h),
    mix(c[2], pet.bodyLight[2], h),
  ];
  return c;
}

function drawDetails(buf, i, x, y, pet, pose) {
  const b = pet.body;
  const { ears } = pose._shapes;

  // 内耳
  for (const e of ears) {
    const rx = e.rx * 0.46;
    const ry = e.ry * 0.5;
    const d = rotDist(x, y, e.cx, e.cy + e.ry * 0.12, rx, ry, e.ang);
    blendPx(buf, i, pet.inner[0], pet.inner[1], pet.inner[2], coverageFromDist(d, softOf(rx, ry)) * 0.92);
  }

  // 腮红
  for (const side of [-1, 1]) {
    const rx = pet.face.blushRx;
    const ry = pet.face.blushRy;
    const d = rotDist(x, y, b.cx + side * pet.face.blushDx, pet.face.blushY, rx, ry, 0);
    blendPx(buf, i, pet.blush[0], pet.blush[1], pet.blush[2], coverageFromDist(d, softOf(rx, ry)) * 0.65);
  }

  // 眼睛（eyeOpen 0 → 细线 = 闭眼）
  for (const side of [-1, 1]) {
    const ex = b.cx + side * pet.face.eyeDx;
    const ey = pet.face.eyeY;
    const eyRy = Math.max(2.4, pet.face.eyeRy * pose.eyeOpen);
    const d = rotDist(x, y, ex, ey, pet.face.eyeRx, eyRy, 0);
    blendPx(buf, i, pet.eye[0], pet.eye[1], pet.eye[2], coverageFromDist(d, softOf(pet.face.eyeRx, eyRy)));
    if (pose.eyeOpen > 0.38) {
      const hd = Math.hypot(x - (ex - pet.face.eyeRx * 0.32), y - (ey - pet.face.eyeRy * 0.34)) / 6.4;
      if (hd < 1.2) blendPx(buf, i, 255, 255, 255, clamp(1.15 - hd, 0, 1) * 0.9);
    }
  }

  // 鼻
  {
    const d = rotDist(x, y, b.cx, pet.face.noseY, pet.face.noseRx, pet.face.noseRy, 0);
    blendPx(buf, i, pet.mouth[0], pet.mouth[1], pet.mouth[2], coverageFromDist(d, softOf(pet.face.noseRx, pet.face.noseRy)) * 0.85);
  }

  // 嘴（mouth 0 → 极小点，1 → 张嘴）
  {
    const rx = pet.face.mouthRx;
    const ry = 2.2 + pose.mouth * pet.face.mouthMax;
    const d = rotDist(x, y, b.cx, pet.face.mouthY, rx, ry, 0);
    blendPx(buf, i, pet.mouth[0], pet.mouth[1], pet.mouth[2], coverageFromDist(d, softOf(rx, ry)));
    if (pose.mouth > 0.5) {
      const td = rotDist(x, y, b.cx + 1, b.cy + 44 + ry * 0.35, rx * 0.42, ry * 0.3, 0);
      blendPx(buf, i, pet.tongue[0], pet.tongue[1], pet.tongue[2], coverageFromDist(td, softOf(rx * 0.42, ry * 0.3)) * 0.9);
    }
  }

  // 休息：头顶 Zzz（在轮廓之外，由 drawOverlays 负责，见下方）
}

/** 轮廓之外的叠加元素：头顶嫩芽、休息 Zzz。
 *  必须独立于主体素循环 —— 主循环对轮廓外像素直接 continue。 */
function drawOverlays(buf, pet, pose) {
  const b = pet.body;
  const anchorY = pet.anchorY;
  const [er, eg, eb] = pet.eye;
  const [lr, lg, lb] = pet.bodyDark;

  for (let py = 36; py <= 218; py++) {
    const yChar = anchorY - (anchorY - py + pose.bob) * pose.squash;
    for (let px = 168; px <= 504; px++) {
      const i = (py * SIZE + px) * 4;

      // 头顶嫩芽（芽芽猫的标识）
      if (pet.extras === 'sprout') {
        const topY = b.cy - b.ry;
        const stemTop = topY - 28;
        const vy = stemTop - (topY + 6);
        const t = clamp((yChar - (topY + 6)) / vy, 0, 1);
        const ds = Math.hypot(px - b.cx, yChar - (topY + 6) - vy * t) - 3.4;
        blendPx(buf, i, lr, lg, lb, clamp(0.5 - ds / 2.4, 0, 1));
        for (const side of [-1, 1]) {
          const rx = 21;
          const ry = 11;
          const d = rotDist(px, yChar, b.cx + side * 20, topY - 26, rx, ry, side * -0.62);
          blendPx(buf, i, lr, lg, lb, coverageFromDist(d, softOf(rx, ry)));
        }
      }

      // 休息 Zzz
      if (pose.zzz > 0.01) {
        for (let k = 0; k < 2; k++) {
          const a = clamp(pose.zzz - k * 0.28, 0, 1);
          if (a <= 0.02) continue;
          const bx = b.cx + b.rx * 1.05 + k * 30;
          const by = b.cy - b.ry * 1.06 - k * 30 - a * 12;
          const s = 16 - k * 2;
          const stroke = 4.4 - k * 0.6;
          const seg = (ax, ay, cx2, cy2) => {
            const sx = cx2 - ax;
            const sy = cy2 - ay;
            const len2 = sx * sx + sy * sy || 1;
            const tt = clamp(((px - ax) * sx + (yChar - ay) * sy) / len2, 0, 1);
            const d = Math.hypot(px - ax - sx * tt, yChar - ay - sy * tt) - stroke;
            blendPx(buf, i, er, eg, eb, clamp(0.5 - d / 2.6, 0, 1) * a * 0.9);
          };
          seg(bx, by, bx + s, by);
          seg(bx + s, by, bx, by + s);
          seg(bx, by + s, bx + s, by + s);
        }
      }
    }
  }
}

function renderPet(pet, poseInput) {
  const pose = {
    bob: 0,
    squash: 1,
    eyeOpen: 1,
    mouth: 0,
    earTwist: 0,
    earLeft: 0,
    earRight: 0,
    tailDeg: 0,
    zzz: 0,
    ...poseInput,
  };
  pose._shapes = silhouette(pet, pose);

  const buf = new Float32Array(SIZE * SIZE * 4);
  const anchorY = pet.anchorY;
  const [or_, og, ob] = pet.outline;

  for (let py = 0; py < SIZE; py++) {
    const yChar = anchorY - (anchorY - py + pose.bob) * pose.squash;
    for (let px = 0; px < SIZE; px++) {
      const i = (py * SIZE + px) * 4;
      const cOut = coverOf(px, yChar, pet, pose, 3.6);
      if (cOut <= 0.003) continue;
      blendPx(buf, i, or_, og, ob, cOut * 0.95);
      const cFill = coverOf(px, yChar, pet, pose, 0);
      const [sr, sg, sb] = shadeAt(px, yChar, pet);
      blendPx(buf, i, sr, sg, sb, cFill);
      drawDetails(buf, i, px, yChar, pet, pose);
    }
  }

  drawOverlays(buf, pet, pose);

  // 反预乘 → 直通 RGBA（buf 里的 a 是 0~1 覆盖率，写盘前必须 ×255）
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = buf[i + 3];
    if (a <= 0.003) continue;
    out[i] = clamp(Math.round(buf[i] / a), 0, 255);
    out[i + 1] = clamp(Math.round(buf[i + 1] / a), 0, 255);
    out[i + 2] = clamp(Math.round(buf[i + 2] / a), 0, 255);
    out[i + 3] = clamp(Math.round(a * 255), 0, 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 可选：文生图底图（缓存 raw → flood-fill 抠底）
// ---------------------------------------------------------------------------
function t2iCoverIfCached(petId) {
  const raw = path.join(T2I_CACHE, `${petId}-cover.png`);
  if (!fs.existsSync(raw)) return null;
  const { width, height, rgba } = decodePng(raw);
  // 以四角像素均值为背景色，flood-fill（容差）标记背景，再对边界做羽化
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ].map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2]];
  });
  const bg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / corners.length);
  const tol = 34;
  const isBg = (i) =>
    Math.abs(rgba[i] - bg[0]) < tol && Math.abs(rgba[i + 1] - bg[1]) < tol && Math.abs(rgba[i + 2] - bg[2]) < tol;
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) {
    stack.push(x, 0, x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    stack.push(0, y, width - 1, y);
  }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const p = y * width + x;
    if (seen[p]) continue;
    if (!isBg(p * 4)) continue;
    seen[p] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  const scaleTo = (v, w, channels) => {
    const out = new Uint8Array(w * w * channels);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, Math.floor((x * width) / w));
        const sy = Math.min(height - 1, Math.floor((y * height) / w));
        for (let k = 0; k < channels; k++) out[(y * w + x) * channels + k] = v[(sy * width + sx) * channels + k];
      }
    }
    return out;
  };
  const square = scaleTo(rgba, SIZE, 4);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = seen[i] ? 255 : 0;
  const seenSq = scaleTo(mask, SIZE, 1);
  // 抠底 + 1px 羽化（seenSq 是单通道掩码，必须用 y*SIZE+x 索引，不能用 RGBA 下标）
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (seenSq[y * SIZE + x] > 127) {
        square[i + 3] = 0;
        continue;
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        if (seenSq[ny * SIZE + nx] > 127) {
          square[i + 3] = Math.min(square[i + 3], 190);
          break;
        }
      }
    }
  }
  return square;
}

// ---------------------------------------------------------------------------
// 动作定义（首尾帧均为中性姿态）
// ---------------------------------------------------------------------------
const ACTIONS = [
  {
    id: 'eat',
    name: '吃饭',
    interaction: 'feed',
    frameRate: 6,
    poses: [
      {},
      { mouth: 0.55, bob: 1, earTwist: 0.02 },
      { mouth: 1, bob: 0, earTwist: 0.04 },
      { mouth: 0.35, bob: -1, earTwist: 0.02 },
      { mouth: 1, bob: 0, earTwist: 0.05 },
      { mouth: 0.4, bob: 1, earTwist: 0.02 },
      { mouth: 0.85, bob: 0, earTwist: 0.03 },
      {},
    ],
  },
  {
    id: 'rest',
    name: '休息',
    interaction: 'rest',
    frameRate: 4,
    poses: [
      {},
      { eyeOpen: 0.55, bob: -1, squash: 0.99, zzz: 0.15 },
      { eyeOpen: 0, bob: -2, squash: 0.985, zzz: 0.4 },
      { eyeOpen: 0, bob: -3, squash: 0.98, zzz: 0.7 },
      { eyeOpen: 0, bob: -3, squash: 0.98, zzz: 1 },
      { eyeOpen: 0, bob: -2, squash: 0.985, zzz: 0.55 },
      { eyeOpen: 0.35, bob: -1, squash: 0.99, zzz: 0.2 },
      {},
    ],
  },
  {
    id: 'play',
    name: '玩耍',
    interaction: 'play',
    frameRate: 6,
    poses: [
      {},
      { bob: -3, squash: 1.015, tailDeg: 9, earTwist: 0.03 },
      { bob: 0, tailDeg: -9, eyeOpen: 0.1 },
      { bob: -3, squash: 1.015, tailDeg: 9, mouth: 0.3 },
      { bob: 0, tailDeg: -9, earTwist: 0.04 },
      { bob: -3, squash: 1.015, tailDeg: 9, eyeOpen: 0.1 },
      { bob: 0, tailDeg: -6, mouth: 0.25 },
      {},
    ],
  },
];

// ---------------------------------------------------------------------------
// 宠物定义
// ---------------------------------------------------------------------------
const PETS = [
  {
    id: 'sprout-cat',
    name: '芽芽猫',
    description: '薄荷绿的圆脸小猫，头上顶着一片嫩芽，安静又黏人。',
    author: 'desktop-pet 项目组（程序化原创绘制）',
    license: 'CC0-1.0（本项目自产）',
    seed: 20261002,
    palette: {
      bodyColor: '#7FD3A6',
      bodyDark: '#4C9E77',
      bodyLight: '#D2F5E3',
      outline: '#2B5A47',
      inner: '#F3A8BE',
      eye: '#233029',
      blush: '#EE6E8F',
      mouth: '#8C3B52',
      tongue: '#E77C97',
    },
    body: { cx: 256, cy: 294, rx: 172, ry: 158, n: 2.35 },
    ear: { dx: 108, y: 156, rx: 62, ry: 78, tilt: 0.42 },
    tail: { dx: 4, dy: 44, r0: 34, r1: 15, travelX: 44, curveX: -14, travelY: -96, curveY: 24 },
    face: {
      eyeDx: 52,
      eyeY: 292,
      eyeRx: 22,
      eyeRy: 27,
      blushDx: 88,
      blushY: 332,
      blushRx: 30,
      blushRy: 17,
      noseY: 318,
      noseRx: 9,
      noseRy: 6,
      mouthY: 336,
      mouthRx: 13,
      mouthMax: 22,
    },
    anchorY: 452,
    extras: 'sprout',
  },
  {
    id: 'cloud-rabbit',
    name: '云朵兔',
    description: '奶白微蓝的长耳兔，尾巴是一团蓬松的云，最擅长打盹。',
    author: 'desktop-pet 项目组（程序化原创绘制）',
    license: 'CC0-1.0（本项目自产）',
    seed: 20261003,
    palette: {
      bodyColor: '#E6EEFA',
      bodyDark: '#AFBEDA',
      bodyLight: '#FFFFFF',
      outline: '#4B5D80',
      inner: '#F6B9CE',
      eye: '#2B2F3F',
      blush: '#F09AB8',
      mouth: '#9A5A72',
      tongue: '#E88CA8',
    },
    body: { cx: 256, cy: 300, rx: 162, ry: 152, n: 2.3 },
    ear: { dx: 78, y: 142, rx: 44, ry: 104, tilt: 0.2 },
    // 尾巴：就地聚成一团蓬松的圆球
    tail: { dx: 8, dy: 22, r0: 32, r1: 31, travelX: 8, curveX: -2, travelY: -6, curveY: 2 },
    face: {
      eyeDx: 50,
      eyeY: 300,
      eyeRx: 21,
      eyeRy: 26,
      blushDx: 86,
      blushY: 340,
      blushRx: 29,
      blushRy: 16,
      noseY: 324,
      noseRx: 9,
      noseRy: 6,
      mouthY: 342,
      mouthRx: 12,
      mouthMax: 20,
    },
    anchorY: 452,
  },
  {
    id: 'charcoal-pup',
    name: '炭炭犬',
    description: '暖灰色的垂耳小狗，尾巴摇个不停，最喜欢被摸头。',
    author: 'desktop-pet 项目组（程序化原创绘制）',
    license: 'CC0-1.0（本项目自产）',
    seed: 20261004,
    palette: {
      bodyColor: '#8E8580',
      bodyDark: '#5A534F',
      bodyLight: '#CCC4BE',
      outline: '#2E2A28',
      inner: '#D79B8A',
      eye: '#1F1A18',
      blush: '#D9856F',
      mouth: '#6B3A32',
      tongue: '#DE8B84',
    },
    body: { cx: 256, cy: 300, rx: 146, ry: 150, n: 2.45 },
    // 垂耳：椭圆细长、贴在头侧下垂（身体收窄后耳片才能露出轮廓外侧）
    ear: { dx: 132, y: 238, rx: 42, ry: 86, tilt: 0.55 },
    tail: { dx: 2, dy: 46, r0: 26, r1: 11, travelX: 26, curveX: -6, travelY: -104, curveY: 20 },
    face: {
      eyeDx: 48,
      eyeY: 296,
      eyeRx: 21,
      eyeRy: 25,
      blushDx: 80,
      blushY: 338,
      blushRx: 30,
      blushRy: 17,
      noseY: 322,
      noseRx: 11,
      noseRy: 8,
      mouthY: 340,
      mouthRx: 13,
      mouthMax: 22,
    },
    anchorY: 452,
  },
];

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function writePng(file, rgba, pet, pose, textExtra = {}) {
  const buf = encodePng(SIZE, SIZE, rgba, {
    Software: `desktop-pet builtin-pets generator v${GENERATOR_VERSION}`,
    Author: pet.author,
    License: pet.license,
    Seed: String(pet.seed),
    Pose: JSON.stringify(pose),
    ...textExtra,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { file, sha256: sha256(buf), bytes: buf.length };
}

function buildPet(pet) {
  const palette = {
    bodyColor: hexToRgb(pet.palette.bodyColor),
    bodyDark: hexToRgb(pet.palette.bodyDark),
    bodyLight: hexToRgb(pet.palette.bodyLight),
    outline: hexToRgb(pet.palette.outline),
    inner: hexToRgb(pet.palette.inner),
    eye: hexToRgb(pet.palette.eye),
    blush: hexToRgb(pet.palette.blush),
    mouth: hexToRgb(pet.palette.mouth),
    tongue: hexToRgb(pet.palette.tongue),
  };
  const full = { ...pet, ...palette };
  const dir = path.join(OUT_ROOT, pet.id);
  fs.rmSync(dir, { recursive: true, force: true });

  const t2i = t2iCoverIfCached(pet.id);
  const coverPose = {};
  const coverRgba = t2i ?? renderPet(full, coverPose);
  const cover = writePng(path.join(dir, 'cover.png'), coverRgba, full, coverPose, {
    Kind: t2i ? 't2i' : 'procedural',
  });

  const actions = ACTIONS.map((action) => {
    const frames = action.poses.map((pose, index) => {
      const rgba = renderPet(full, pose);
      return writePng(path.join(dir, 'actions', action.id, `frame_${String(index).padStart(3, '0')}.png`), rgba, full, pose);
    });
    return {
      id: action.id,
      name: action.name,
      interaction: action.interaction,
      frameRate: action.frameRate,
      frames: frames.map((f) => ({ file: path.relative(dir, f.file).split(path.sep).join('/'), sha256: f.sha256 })),
    };
  });

  const manifest = {
    schemaVersion: 1,
    id: pet.id,
    name: pet.name,
    description: pet.description,
    author: pet.author,
    license: pet.license,
    canvas: { width: SIZE, height: SIZE, anchor: 'center' },
    cover: { file: 'cover.png', sha256: cover.sha256 },
    actions,
    provenance: {
      kind: t2i ? 't2i' : 'procedural',
      generator: 'scripts/build-builtin-pets.mjs',
      version: GENERATOR_VERSION,
      seed: pet.seed,
      generatedAt: new Date().toISOString().slice(0, 10),
    },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const totalFrames = actions.reduce((s, a) => s + a.frames.length, 0);
  const size = [cover.file, ...actions.flatMap((a) => a.frames.map((f) => path.join(dir, f.file)))]
    .reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(
    `✓ ${pet.id}（${pet.name}）cover + ${actions.length} 动作 / ${totalFrames} 帧，` +
      `${(size / 1024).toFixed(1)} KB，来源=${manifest.provenance.kind}`,
  );
  return manifest;
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = wanted.length ? PETS.filter((p) => wanted.includes(p.id)) : PETS;
  if (!targets.length) {
    console.error(`未匹配到宠物：${wanted.join(', ')}；可用：${PETS.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const manifests = targets.map(buildPet);
  fs.writeFileSync(
    path.join(OUT_ROOT, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, pets: manifests.map((m) => m.id) }, null, 2)}\n`,
  );
  console.log(`完成：${manifests.length} 只 → ${path.relative(ROOT, OUT_ROOT)}`);
}

main();