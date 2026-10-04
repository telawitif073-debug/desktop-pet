/**
 * 测试用 ZIP / PNG 构造器（被多个 spec 共用的夹具，非测试文件本身）
 * ---------------------------------------------------------------------------
 * 为什么要手写：后端不引入第三方依赖，测试也不能依赖 zip 库。
 * `buildZip` 支持 store(0)/deflate(8) 两种 method，crc32 真实计算；
 * `makePng` 产出 8bit RGBA（color type 6 → 带 alpha）的最小可解析 PNG。
 */

import * as zlib from 'zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export interface ZipFileInput { name: string; data: Buffer; method?: 0 | 8; flags?: number }
export interface ZipBuildOptions { zip64EntriesMarker?: boolean }

export function buildZip(files: ZipFileInput[], opts: ZipBuildOptions = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const method = f.method ?? 8;
    const raw = f.data;
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(f.name, 'utf8');
    const flags = (f.flags ?? 0) | 0x0800; // 置 UTF-8 名标志
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, comp);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(flags, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(comp.length, 20);
    cdfh.writeUInt32LE(raw.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);
    cdfh.writeUInt16LE(0, 32);
    cdfh.writeUInt16LE(0, 34);
    cdfh.writeUInt16LE(0, 36);
    cdfh.writeUInt32LE(0, 38);
    cdfh.writeUInt32LE(offset, 42);
    centralParts.push(cdfh, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = opts.zip64EntriesMarker ? 0xffff : files.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]);
}

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};

/** 生成 width×height 的 8bit RGBA PNG（color type 6 → hasAlpha） */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(32))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 造一个「合格本体」的最小宠物包（单张 512×512 静帧） */
export const makeValidPackZip = (): Buffer =>
  buildZip([{ name: 'pet/body.png', data: makePng(512, 512) }]);

/** 造一个「只有图标」的不合格包 */
export const makeIconOnlyPackZip = (): Buffer =>
  buildZip([
    { name: 'ui/cursor-grab.png', data: makePng(64, 64) },
    { name: 'logo.png', data: makePng(256, 256) },
  ]);
