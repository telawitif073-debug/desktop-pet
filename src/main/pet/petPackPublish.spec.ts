import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { buildPetPackForPublish, injectPackActions, type PackActionInput } from './petPackPublish';
import { pickPetAppearance } from './petPack';

// ---------------------------------------------------------------------------
// 最小 PNG 编码器（8bit RGBA → hasAlpha），用于造「合格本体」
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
const makePng = (width: number, height: number): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(24))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const zipOf = (files: Record<string, Buffer>): Buffer => {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
  return zip.toBuffer();
};
const framesZip = (count: number): Buffer =>
  zipOf(Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i + 1}.png`, makePng(200, 200)])));
const readZip = (buf: Buffer, dir: string): string[] => {
  new AdmZip(buf).extractAllTo(dir, true);
  const walk = (current: string): string[] =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(current, entry.name);
      return entry.isDirectory() ? walk(full) : [path.relative(dir, full).split(path.sep).join('/')];
    });
  return walk(dir).sort();
};

const VALID_PACK = () => zipOf({ 'pet/body.png': makePng(512, 512) });

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-packpub-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('宠物包发布组装 · 本体预校验（不合格不上传）', () => {
  it('合格包：原样重打包，本体仍在且可被挑中', () => {
    const out = buildPetPackForPublish(VALID_PACK());
    expect(out.subarray(0, 2).toString('latin1')).toBe('PK');
    const files = readZip(out, dir);
    expect(files).toEqual(['pet/body.png']);
    const pick = pickPetAppearance(dir);
    expect(pick.ok).toBe(true);
    expect(pick.relative).toBe('pet/body.png');
  });

  it('只有图标的包 → 抛错（带被拒资源原因）', () => {
    const pack = zipOf({ 'logo.png': makePng(256, 256), 'ui/cursor.png': makePng(64, 64) });
    expect(() => buildPetPackForPublish(pack)).toThrow(/校验未通过/);
  });

  it('不是 zip → 抛错', () => {
    expect(() => buildPetPackForPublish(Buffer.from('not a zip'))).toThrow(/PK/);
  });
});

describe('宠物包发布组装 · 附带动作注入', () => {
  it('帧图动作：落到 pet/actions/<动作名>/frame_00N.png，并生成 pet/actions.json', () => {
    const actions: PackActionInput[] = [{ name: '挥手', kind: 'frames', interaction: 'play', file: { name: 'w.zip', bytes: framesZip(3) } }];
    const out = buildPetPackForPublish(VALID_PACK(), actions);
    const files = readZip(out, dir);
    expect(files).toEqual([
      'pet/actions.json',
      'pet/actions/挥手/frame_000.png',
      'pet/actions/挥手/frame_001.png',
      'pet/actions/挥手/frame_002.png',
      'pet/body.png',
    ]);

    const model = JSON.parse(fs.readFileSync(path.join(dir, 'pet', 'actions.json'), 'utf8'));
    expect(model.schemaVersion).toBe(3);
    expect(model.actions['挥手']).toMatchObject({ ref: '挥手', kind: 'frames', interaction: 'play', frameRate: 6 });
    expect(model.interaction.play).toEqual(['挥手']);
    // 动作载荷不进本体判定：本体仍是 pet/body.png
    const pick = pickPetAppearance(dir);
    expect(pick.relative).toBe('pet/body.png');
  });

  it('视频动作：写 clip.webm 且清单记 videoFile', () => {
    const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(32)]);
    const actions: PackActionInput[] = [{ name: '打招呼', kind: 'video', file: { name: 'hi.webm', bytes: webm } }];
    const out = buildPetPackForPublish(VALID_PACK(), actions);
    const files = readZip(out, dir);
    expect(files).toContain('pet/actions/打招呼/clip.webm');
    const model = JSON.parse(fs.readFileSync(path.join(dir, 'pet', 'actions.json'), 'utf8'));
    expect(model.actions['打招呼']).toMatchObject({ kind: 'video', videoFile: 'pet/actions/打招呼/clip.webm' });
  });

  it('模型 clip 动作：只进 modelClips，不落文件，互动绑定随 spec 保留', () => {
    const actions: PackActionInput[] = [{ name: '跳跃', kind: 'clip', clipName: 'jump', interaction: 'play' }];
    const out = buildPetPackForPublish(VALID_PACK(), actions);
    const files = readZip(out, dir);
    expect(files).toEqual(['pet/actions.json', 'pet/body.png']);
    const model = JSON.parse(fs.readFileSync(path.join(dir, 'pet', 'actions.json'), 'utf8'));
    expect(model.modelClips).toEqual(['跳跃']);
    expect(model.actions['跳跃']).toMatchObject({ kind: 'clip', interaction: 'play' });
  });

  it('动作名含非法路径字符 → 目录名转义（不越界、可复现）', () => {
    const actions: PackActionInput[] = [{ name: 'a/b', kind: 'frames', file: { name: 'w.zip', bytes: framesZip(1) } }];
    const out = buildPetPackForPublish(VALID_PACK(), actions);
    const files = readZip(out, dir);
    expect(files.some((f) => f.startsWith('pet/actions/a_b~'))).toBe(true);
    expect(files.every((f) => !f.includes('pet/actions/a/frame'))).toBe(true);
  });
});

describe('宠物包发布组装 · 动作边界与错误', () => {
  it('帧图 zip 里没有图片 → 抛错', () => {
    const empty = zipOf({ 'readme.txt': Buffer.from('no images') });
    expect(() => injectPackActions(dir, [{ name: '空', kind: 'frames', file: { name: 'e.zip', bytes: empty } }])).toThrow(/没有帧图/);
  });

  it('帧数超过 30 → 抛错', () => {
    expect(() =>
      injectPackActions(dir, [{ name: '多', kind: 'frames', file: { name: 'm.zip', bytes: framesZip(31) } }]),
    ).toThrow(/帧数过多/);
  });

  it('动作名重复 → 抛错', () => {
    expect(() =>
      injectPackActions(dir, [
        { name: '同名', kind: 'clip', clipName: 'a' },
        { name: '同名', kind: 'clip', clipName: 'b' },
      ]),
    ).toThrow(/动作名重复/);
  });

  it('video 缺文件 / 非 webm / 缺 EBML 头 → 抛错', () => {
    expect(() => injectPackActions(dir, [{ name: 'v1', kind: 'video' }])).toThrow(/缺少视频文件/);
    expect(() =>
      injectPackActions(dir, [{ name: 'v2', kind: 'video', file: { name: 'a.mp4', bytes: Buffer.alloc(8) } }]),
    ).toThrow(/必须是 \.webm/);
    expect(() =>
      injectPackActions(dir, [{ name: 'v3', kind: 'video', file: { name: 'a.webm', bytes: Buffer.from('nope') } }]),
    ).toThrow(/EBML/);
  });

  it('clip 动作未填 clipName 时回落动作名', () => {
    injectPackActions(dir, [{ name: '回落', kind: 'clip' }]);
    const model = JSON.parse(fs.readFileSync(path.join(dir, 'pet', 'actions.json'), 'utf8'));
    expect(model.modelClips).toEqual(['回落']);
  });
});
