import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  PET_PACK_MAX_ENTRIES,
  inspectPetPack,
  validatePetPackFile,
} from '../src/pet-packs/pack-inspection';
import { ZipFormatException, readZipDirectory, readZipEntry } from '../src/pet-packs/zip-reader';

// ---------------------------------------------------------------------------
// 测试用 ZIP 构造器（store / deflate 两种 method；crc32 真实计算，便于将来加校验）
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

interface ZipFileInput { name: string; data: Buffer; method?: 0 | 8; flags?: number }
interface ZipBuildOptions { zip64EntriesMarker?: boolean }

function buildZip(files: ZipFileInput[], opts: ZipBuildOptions = {}): Buffer {
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

// ---------------------------------------------------------------------------
// 测试用 PNG（8bit RGBA → hasAlpha）
// ---------------------------------------------------------------------------
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};
function makePng(width: number, height: number): Buffer {
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

/** 捕获抛出的 HttpException，便于断言结构化响应体 */
function caught(fn: () => unknown): BadRequestException {
  try {
    fn();
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('期望抛出 BadRequestException，但没有');
}

describe('zip-reader · 结构与边界', () => {
  it('store 与 deflate 两种 method 都能原样解出', () => {
    const zip = buildZip([
      { name: 'store.txt', data: Buffer.from('hello-store'), method: 0 },
      { name: 'deflate.txt', data: Buffer.from('hello-deflate'), method: 8 },
    ]);
    const entries = readZipDirectory(zip);
    expect(entries.map((e) => e.name)).toEqual(['store.txt', 'deflate.txt']);
    expect(readZipEntry(zip, entries[0]).toString()).toBe('hello-store');
    expect(readZipEntry(zip, entries[1]).toString()).toBe('hello-deflate');
  });

  it('空 zip 合法（返回 0 条目，由上层判「资源包为空」）', () => {
    expect(readZipDirectory(buildZip([]))).toEqual([]);
  });

  it('条目顺序不影响读取（按中央目录顺序）', () => {
    const zip = buildZip([
      { name: 'z.png', data: makePng(200, 200) },
      { name: 'a.png', data: makePng(200, 200) },
    ]);
    expect(readZipDirectory(zip).map((e) => e.name)).toEqual(['z.png', 'a.png']);
  });

  it('加密条目显式报错', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'), flags: 0x0001 }]);
    expect(() => readZipDirectory(zip)).toThrow(ZipFormatException);
    expect(() => readZipDirectory(zip)).toThrow(/加密/);
  });

  it('ZIP64 显式报错', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }], { zip64EntriesMarker: true });
    expect(() => readZipDirectory(zip)).toThrow(/ZIP64/);
  });

  it('截断文件显式报错', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(() => readZipDirectory(zip.subarray(0, zip.length - 8))).toThrow(/EOCD|截断|损坏/);
  });

  it('不支持的压缩方式显式报错', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    const [e] = readZipDirectory(zip);
    expect(() => readZipEntry(zip, { ...e, method: 12 })).toThrow(/不支持的 ZIP 压缩方式/);
  });

  it('单条解压上限生效（防 zip 炸弹）', () => {
    const zip = buildZip([{ name: 'a.bin', data: Buffer.alloc(64) }]);
    const [e] = readZipDirectory(zip);
    expect(() => readZipEntry(zip, e, { maxEntryBytes: 16 })).toThrow(/条目过大/);
  });

  it('条目数超上限显式报错', () => {
    expect(PET_PACK_MAX_ENTRIES).toBeGreaterThan(0);
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }, { name: 'b.txt', data: Buffer.from('y') }]);
    expect(() => readZipDirectory(zip, { maxEntries: 1 })).toThrow(/条目过多/);
  });
});

describe('inspectPetPack · 合格包通过', () => {
  it('含帧序列本体 + 干扰项：通过，派生 body_kinds 与入口', () => {
    const zip = buildZip([
      { name: 'pet/idle/frame_000.png', data: makePng(512, 512) },
      { name: 'pet/idle/frame_001.png', data: makePng(512, 512) },
      { name: 'logo.png', data: makePng(256, 256) },
    ]);
    const r = inspectPetPack(zip);
    expect(r.entry?.path).toBe('pet/idle/frame_000.png');
    expect(r.bodyKinds).toEqual(['body-animation']);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.bytes).toBe(zip.length);
    expect(r.manifest.rejected.map((x) => x.path)).toEqual(['logo.png']);
    expect(r.manifest.rejected[0].evidence.length).toBeGreaterThan(0);
  });

  it('单张达标静帧 → body-still', () => {
    const zip = buildZip([{ name: 'pet/body.png', data: makePng(512, 512) }]);
    const r = inspectPetPack(zip);
    expect(r.bodyKinds).toEqual(['body-still']);
  });

  it('store 压缩的包也能通过', () => {
    const zip = buildZip([{ name: 'pet/body.png', data: makePng(512, 512), method: 0 }]);
    expect(inspectPetPack(zip).bodyKinds).toEqual(['body-still']);
  });

  it('忽略项（node_modules/隐藏项）不参与判定', () => {
    const zip = buildZip([
      { name: 'pet/body.png', data: makePng(512, 512) },
      { name: 'node_modules/pkg/other.png', data: makePng(64, 64) },
      { name: '.DS_Store', data: Buffer.from('junk') },
    ]);
    const r = inspectPetPack(zip);
    expect(r.entryCount).toBe(1);
    expect(r.manifest.rejected).toEqual([]);
  });

  it('包内 pet/actions.json 进清单快照', () => {
    const actions = { schemaVersion: 3, actions: [{ id: 'idle' }] };
    const zip = buildZip([
      { name: 'pet/body.png', data: makePng(512, 512) },
      { name: 'pet/actions.json', data: Buffer.from(JSON.stringify(actions), 'utf8') },
    ]);
    const r = inspectPetPack(zip);
    expect(r.manifest.actions).toEqual(actions);
    expect(r.manifest.warnings).toEqual([]);
    // actions.json 不是「资源」，不参与分类
    expect(r.manifest.rejected.map((x) => x.path)).not.toContain('pet/actions.json');
  });

  it('非法 actions.json 记入 warnings 但不影响本体判定', () => {
    const zip = buildZip([
      { name: 'pet/body.png', data: makePng(512, 512) },
      { name: 'pet/actions.json', data: Buffer.from('{not json', 'utf8') },
    ]);
    const r = inspectPetPack(zip);
    expect(r.manifest.actions).toBeNull();
    expect(r.manifest.warnings.join(' ')).toContain('actions.json');
  });
});

describe('inspectPetPack · 不合格包被拒（返回结构化 400）', () => {
  it('只有图标的包 → 400，逐条给出角色与理由', () => {
    const zip = buildZip([
      { name: 'ui/cursor-grab.png', data: makePng(64, 64) },
      { name: 'logo.png', data: makePng(256, 256) },
    ]);
    const err = caught(() => inspectPetPack(zip));
    expect(err).toBeInstanceOf(BadRequestException);
    const body = err.getResponse() as { errors: string[]; rejected: Array<{ path: string; role: string; evidence: string[] }> };
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.rejected.map((r) => r.role).sort()).toEqual(['branding', 'ui']);
    expect(body.rejected.every((r) => r.evidence.length > 0)).toBe(true);
  });

  it('空包 → 400「资源包为空」', () => {
    const err = caught(() => inspectPetPack(buildZip([])));
    expect((err.getResponse() as { errors: string[] }).errors.join(' ')).toContain('资源包为空');
  });

  it('非 zip 字节 → 400', () => {
    expect(() => inspectPetPack(Buffer.from('not a zip at all'))).toThrow(/PK|ZIP/);
  });

  it('路径穿越条目 → 400', () => {
    const zip = buildZip([{ name: '../evil.png', data: makePng(512, 512) }, { name: 'pet/a.png', data: makePng(512, 512) }]);
    expect(() => inspectPetPack(zip)).toThrow(/非法路径/);
  });

  it('AES 加密包 → 400「格式不合法」而不是 500', () => {
    const zip = buildZip([{ name: 'pet/a.png', data: makePng(512, 512), flags: 0x0001 }]);
    expect(() => inspectPetPack(zip)).toThrow(/加密/);
  });
});

describe('validatePetPackFile · 与 upload-validation 叠加', () => {
  const zip = buildZip([{ name: 'pet/body.png', data: makePng(512, 512) }]);

  it('合法 .zip 通过两层校验', () => {
    const r = validatePetPackFile({ originalname: 'sprout.zip', mimetype: 'application/zip', buffer: zip });
    expect(r.bodyKinds).toEqual(['body-still']);
  });

  it('扩展名不是 zip → 拒绝', () => {
    expect(() => validatePetPackFile({ originalname: 'pack.png', mimetype: 'image/png', buffer: zip })).toThrow(BadRequestException);
  });

  it('MIME 与扩展名不符 → 拒绝', () => {
    expect(() => validatePetPackFile({ originalname: 'pack.zip', mimetype: 'text/plain', buffer: zip })).toThrow(/MIME/);
  });
});

describe('真实内置宠物包（端到端口径）', () => {
  it('resources/builtin-pets/sprout-cat 打包后判为合格宠物', () => {
    const dir = path.resolve(__dirname, '../../../resources/builtin-pets/sprout-cat');
    if (!fs.existsSync(dir)) return; // 仓库裁剪场景下跳过

    const files: ZipFileInput[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ name: path.relative(dir, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
      }
    };
    walk(dir);

    const r = inspectPetPack(buildZip(files));
    expect(r.evaluation.valid).toBe(true);
    expect(r.bodyKinds).toContain('body-animation');
    expect(r.entry?.path).toMatch(/^actions\/.*\.png$/);
    expect(r.manifest.entryCount).toBeGreaterThan(5);
  });
});
