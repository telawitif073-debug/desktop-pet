import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  PET_PACK_MAX_ENTRIES,
  inspectPetPack,
  validatePetPackFile,
} from '../src/pet-packs/pack-inspection';
import { ZipFormatException, readZipDirectory, readZipEntry } from '../src/pet-packs/zip-reader';
import { buildZip, makeIconOnlyPackZip, makePng, makeValidPackZip, type ZipFileInput } from './pack-fixtures';

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
    const err = caught(() => inspectPetPack(makeIconOnlyPackZip()));
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
  const zip = makeValidPackZip();

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
