import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { buildPackEntries, pickPetAppearance, probeImageFile, walkPackFiles } from './petPack';

// ---------------------------------------------------------------------------
// 测试用最小 PNG 编码器（与 scripts/build-builtin-pets.mjs 同思路：zlib + 手写 CRC32）
// 目的：造出真实可解析的 PNG 字节，验证「只读文件头」的探测是否准确。
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
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};
/** 生成 width×height 的 8bit RGBA PNG（color type 6 → 有 alpha） */
function makePng(width: number, height: number, rgba: [number, number, number, number] = [10, 20, 30, 255]): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * stride + 1 + x * 4;
      raw[i] = rgba[0];
      raw[i + 1] = rgba[1];
      raw[i + 2] = rgba[2];
      raw[i + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let dir = '';
const write = (rel: string, data: Buffer | string): string => {
  const full = path.join(dir, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-petpack-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('文件头探测（不整图解码）', () => {
  it('PNG：宽高 / alpha / 单帧', () => {
    const file = write('a.png', makePng(48, 32));
    const probe = probeImageFile(file);
    expect(probe?.width).toBe(48);
    expect(probe?.height).toBe(32);
    expect(probe?.hasAlpha).toBe(true);
    expect(probe?.frames).toBe(1);
    expect(probe?.animated).toBe(false);
  });

  it('仓库内真实内置宠物封面：512×512 且带 alpha', () => {
    const cover = path.join(process.cwd(), 'resources', 'builtin-pets', 'sprout-cat', 'cover.png');
    const probe = probeImageFile(cover);
    expect(probe?.width).toBe(512);
    expect(probe?.height).toBe(512);
    expect(probe?.hasAlpha).toBe(true);
  });

  it('webm / 模型文件按「动画载荷 / 模型」处理，未知文本返回 undefined', () => {
    expect(probeImageFile(write('x.webm', Buffer.from('1a45dfa3', 'hex')))?.animated).toBe(true);
    expect(probeImageFile(write('m.model3.json', '{"Version":3}'))).toBeDefined();
    expect(probeImageFile(write('notes.txt', 'hello'))).toBeUndefined();
  });

  it('walkPackFiles 跳过 .git/node_modules 与隐藏文件', () => {
    write('pet/a.png', makePng(8, 8));
    write('.git/config', 'x');
    write('node_modules/pkg/index.js', 'x');
    write('.hidden.png', makePng(8, 8));
    const files = walkPackFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'));
    expect(files).toEqual(['pet/a.png']);
  });
});

describe('模块级 pickPetAppearance：修复「取第一个文件」的根因', () => {
  it('回归：只有 README/LICENSE 的包 → 明确拒绝（旧逻辑会把 README 当形象装进去）', () => {
    write('README.md', '# hello');
    write('LICENSE', 'MIT');
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(false);
    expect(pick.path).toBeUndefined();
    expect(pick.errors.length).toBeGreaterThan(0);
  });

  it('只有界面件/品牌资源的包 → 拒绝，且原因指向非本体', () => {
    write('ui/cursor-grab.png', makePng(64, 64));
    write('ui/notify-done.png', makePng(48, 48));
    write('logo.png', makePng(256, 256));
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(false);
    expect(pick.evaluation.rejected.map((r) => r.role).sort()).toEqual(['branding', 'ui', 'ui']);
    expect(pick.errors.join(' ')).toContain('没有宠物本体资源');
  });

  it('只有封面图（无本体）→ 拒绝', () => {
    write('preview/cover.png', makePng(512, 512));
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(false);
    expect(pick.errors.join(' ')).toContain('封面');
  });

  it('本体 + 干扰项：只选本体为入口，干扰项进 rejected 并带原因', () => {
    write('pet/idle/frame_000.png', makePng(512, 512));
    write('pet/idle/frame_001.png', makePng(512, 512));
    write('memes/wave.png', makePng(300, 300, [1, 2, 3, 0]));
    write('logo.png', makePng(512, 512));
    write('docs/screenshot.png', makePng(1920, 1080));
    write('ui/cursor.png', makePng(32, 32));
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(true);
    expect(pick.relative).toBe('pet/idle/frame_000.png');
    expect(fs.existsSync(pick.path as string)).toBe(true);
    expect(pick.evaluation.rejected.map((r) => r.role).sort()).toEqual(['branding', 'document', 'meme', 'ui']);
  });

  it('像素画帧序列（32×32）按序列整体认作本体', () => {
    write('pet/walk/frame_000.png', makePng(32, 32));
    write('pet/walk/frame_001.png', makePng(32, 32));
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(true);
    expect(pick.relative).toBe('pet/walk/frame_000.png');
  });

  it('声明 live2d：优先 model3.json；缺失则显式报错', () => {
    write('model/char.model3.json', '{"Version":3}');
    write('model/textures/tex.png', makePng(512, 512));
    const ok = pickPetAppearance(dir, 'live2d');
    expect(ok.ok).toBe(true);
    expect(ok.format).toBe('live2d');
    expect(ok.relative).toBe('model/char.model3.json');
    expect(probeImageFile(path.join(dir, 'model', 'char.model3.json'))).toBeDefined();

    const missing = pickPetAppearance(dir, 'model3d');
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toContain('没有 glb/gltf/vrm');
  });

  it('未探测内容的空目录 → 拒绝而不是谎报可用', () => {
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(false);
    expect(pick.errors.join(' ')).toContain('资源包为空');
  });

  it('buildPackEntries 产出稳定排序与相对路径（正斜杠）', () => {
    write('b/x.png', makePng(300, 300));
    write('a/y.png', makePng(300, 300));
    const entries = buildPackEntries(dir);
    expect(entries.map((e) => e.path)).toEqual(['a/y.png', 'b/x.png']);
  });
});
