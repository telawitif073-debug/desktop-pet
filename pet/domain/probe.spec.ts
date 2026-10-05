import { describe, expect, it } from 'vitest';
import zlib from 'zlib';
import { isProbeablePath, probeByMeta, probeImageHead, probeNeedsBytes } from './probe';

// ---------------------------------------------------------------------------
// 最小样本字节构造（只造到「足以被头部探测解析」的长度，不做真实解码）
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
const png = (width: number, height: number, colorType = 6, extraChunks: Buffer[] = []): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...extraChunks,
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const gif = (width: number, height: number, frames: number, transparent = false): Buffer => {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  const gce = Buffer.from([0x21, 0xf9, 0x04, transparent ? 0x01 : 0x00, 0x00, 0x00, 0x00]);
  // 尾部补足字节：扫描窗口为 i+7 < length，真实 GIF 帧后还有图像数据，这里补 8 字节等价
  return Buffer.concat([head, ...Array.from({ length: frames }, () => gce), Buffer.alloc(8)]);
};
const webpVp8x = (width: number, height: number, flags: number): Buffer => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = flags;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
};
const jpeg = (width: number, height: number): Buffer => {
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
};
const bmp = (width: number, height: number, bitCount: number): Buffer => {
  const b = Buffer.alloc(30);
  b.write('BM', 0, 'latin1');
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(bitCount, 28);
  return b;
};

const head = (buf: Buffer, name: string) => probeImageHead(buf, buf.length, name);

describe('头部探测（共享：桌面与服务端同一份）', () => {
  it('PNG：宽高 / alpha / 单帧', () => {
    const p = head(png(48, 32), 'a.png');
    expect(p).toMatchObject({ width: 48, height: 32, frames: 1, animated: false, hasAlpha: true });
  });

  it('PNG：非 alpha 色彩类型（RGB）', () => {
    const p = head(png(48, 32, 2), 'a.png');
    expect(p?.hasAlpha).toBe(false);
  });

  it('APNG：acTL 声明多帧 → animated', () => {
    const actl = chunk('acTL', (() => { const b = Buffer.alloc(8); b.writeUInt32BE(6, 0); b.writeUInt32BE(0, 4); return b; })());
    const p = head(png(64, 64, 6, [actl]), 'a.png');
    expect(p?.frames).toBe(6);
    expect(p?.animated).toBe(true);
  });

  it('GIF：宽高 / 帧数 / 透明', () => {
    const p = head(gif(40, 24, 3, true), 'a.gif');
    expect(p?.width).toBe(40);
    expect(p?.height).toBe(24);
    expect(p?.frames).toBe(3);
    expect(p?.animated).toBe(true);
    expect(p?.hasAlpha).toBe(true);
  });

  it('WebP VP8X：动画位与 alpha 位', () => {
    const p = head(webpVp8x(120, 80, 0x12), 'a.webp'); // 0x02 动画 + 0x10 alpha
    expect(p).toMatchObject({ width: 120, height: 80, animated: true, hasAlpha: true });
  });

  it('JPEG：SOF0 宽高', () => {
    const p = head(jpeg(160, 90), 'a.jpg');
    expect(p?.width).toBe(160);
    expect(p?.height).toBe(90);
    expect(p?.hasAlpha).toBe(false);
  });

  it('BMP：32 位视为带 alpha', () => {
    expect(head(bmp(20, 10, 32), 'a.bmp')?.hasAlpha).toBe(true);
    expect(head(bmp(20, 10, 24), 'a.bmp')?.hasAlpha).toBe(false);
  });

  it('视频载荷按多帧动画处理（不解析编码）', () => {
    const p = head(Buffer.from('1a45dfa3', 'hex'), 'clip.webm');
    expect(p?.animated).toBe(true);
    expect(p?.frames).toBe(2);
  });

  it('模型扩展名只回体积', () => {
    expect(head(Buffer.alloc(4), 'x.glb')).toMatchObject({ bytes: 4 });
  });

  it('未知类型返回 undefined；损坏的图回体积（交分类层 fail-closed）', () => {
    expect(head(Buffer.from('hello'), 'notes.txt')).toBeUndefined();
    const broken = head(Buffer.from('not a png'), 'fake.png');
    expect(broken).toEqual({ bytes: 9 });
  });

  it('截断到 4 字节也不抛错', () => {
    const full = png(48, 32);
    expect(head(full.subarray(0, 4), 'a.png')).toEqual({ bytes: 4 });
  });
});

describe('探测辅助判定', () => {
  it('probeNeedsBytes：只有栅格图需要读内容', () => {
    expect(probeNeedsBytes('a.png')).toBe(true);
    expect(probeNeedsBytes('a.GIF')).toBe(true);
    expect(probeNeedsBytes('clip.webm')).toBe(false);
    expect(probeNeedsBytes('x.glb')).toBe(false);
    expect(probeNeedsBytes('m.model3.json')).toBe(false);
  });

  it('isProbeablePath：视频/模型/图片/Live2D 清单为真', () => {
    expect(isProbeablePath('a.png')).toBe(true);
    expect(isProbeablePath('clip.webm')).toBe(true);
    expect(isProbeablePath('x.glb')).toBe(true);
    expect(isProbeablePath('m.live2d.json')).toBe(true);
    expect(isProbeablePath('notes.txt')).toBe(false);
    expect(isProbeablePath('pet/actions.json')).toBe(false);
  });

  it('probeByMeta 无需内容即可给视频/模型定性', () => {
    expect(probeByMeta('clip.webm', 1234)).toMatchObject({ animated: true, bytes: 1234 });
    expect(probeByMeta('x.glb', 42)).toMatchObject({ bytes: 42 });
    expect(probeByMeta('notes.txt', 10)).toBeUndefined();
  });
});
