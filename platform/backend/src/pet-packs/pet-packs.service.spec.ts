import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PetPacksService } from './pet-packs.service';
import {
  inspectPetPack,
  validatePetPackFile,
  PET_PACK_MAX_BYTES,
  PET_PACK_MAX_ENTRIES,
  PET_PACK_MAX_ENTRY_BYTES,
  PET_PACK_MAX_UNCOMPRESSED_BYTES,
} from './pack-inspection';

/**
 * 只读 Node 内置构造「合成宠物包」与「最小 PNG」，用于钉住发布门禁的字节级/语义级校验。
 * 不引入任何第三方依赖（与 `zip-reader.ts` 同一口径：只读中央目录 + store 解压）。
 */

interface ZipEntrySpec {
  name: string;
  /** 真实数据（省略时只写声明尺寸，用于触发限额拒绝） */
  data?: Buffer;
  /** 覆盖中央目录里声明的解压尺寸（默认 = data.length） */
  size?: number;
}

/** 构造一个最小合法的 store-only zip（含本地头 + 中央目录 + EOCD） */
function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const declared = e.size ?? data.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc32（不校验）
    local.writeUInt32LE(data.length, 18); // compressed
    local.writeUInt32LE(declared, 22); // uncompressed
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16); // crc32
    cd.writeUInt32LE(data.length, 20); // compressed
    cd.writeUInt32LE(declared, 24); // uncompressed
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // local header offset
    name.copy(cd, 46);
    centrals.push(cd);

    offset += local.length + data.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** 最小 PNG（34 字节内的 PNG 签名 + IHDR）：`probeImageHead` 只读头部即可得宽高/alpha */
function makePng(width: number, height: number, colorType = 6): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = colorType; // 6 = RGBA → 有效 alpha
  buf.writeUInt32BE(0, 29); // 伪 CRC（本读取器不校验 crc32）
  return buf;
}

function mkFile(buffer: Buffer, originalname = 'pack.zip', mimetype = 'application/zip') {
  return { originalname, mimetype, buffer, size: buffer.length } as Express.Multer.File;
}

/** 权重合计为 100 的最小合法动作模型（schemaVersion 3，actions 可为空对象） */
const validActionModel = {
  schemaVersion: 3,
  idle: [],
  interaction: { feed: [], rest: [], play: [] },
  clicks: [],
  drag: [],
  moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [] },
  categories: [],
  events: {},
  weights: { idle: 100, turn: 0, move: 0 },
  actions: {},
};

/** `inspectPetPack` 是同步抛错，包一层 promise 以便用 `.rejects` 断言 */
const expectBadRequest = async (fn: () => unknown) => {
  await expect(Promise.resolve().then(fn)).rejects.toBeInstanceOf(BadRequestException);
};

describe('pack-inspection · 上传即校验（限额）', () => {
  it('archive 超过 PET_PACK_MAX_ARCHIVE_BYTES → 400', async () => {
    // 未初始化内容即可：尺寸检查先于任何字节解析
    const oversize = Buffer.allocUnsafe(PET_PACK_MAX_BYTES + 1);
    await expectBadRequest(() => inspectPetPack(oversize));
  });

  it('条目数超过 PET_PACK_MAX_ENTRIES → 400', async () => {
    const entries = Array.from({ length: PET_PACK_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.webm` }));
    await expectBadRequest(() => inspectPetPack(buildZip(entries)));
  });

  it('单条解压后超过 PET_PACK_MAX_ENTRY_BYTES → 400', async () => {
    const zip = buildZip([{ name: 'pet/body.png', size: PET_PACK_MAX_ENTRY_BYTES + 1 }]);
    await expectBadRequest(() => inspectPetPack(zip));
  });

  it('解压总量超过 PET_PACK_MAX_UNCOMPRESSED_BYTES → 400', async () => {
    // 每条恰为单条上限（不触发单条拒绝），条目数 * 上限 > 总量上限
    const count = Math.ceil(PET_PACK_MAX_UNCOMPRESSED_BYTES / PET_PACK_MAX_ENTRY_BYTES) + 1;
    const zip = buildZip(Array.from({ length: count }, (_, i) => ({ name: `v${i}.webm`, size: PET_PACK_MAX_ENTRY_BYTES })));
    await expectBadRequest(() => inspectPetPack(zip));
  });
});

describe('pack-inspection · 本体判定与派生字段', () => {
  it('有效合成包：派生 bodyKinds / sha256 / 入口 / 动作快照', () => {
    const zip = buildZip([
      { name: 'pet/body.moc3', data: Buffer.from('model') },
      { name: 'pet/body.png', data: makePng(256, 256) },
      { name: 'pet/actions.json', data: Buffer.from(JSON.stringify(validActionModel)) },
    ]);
    const result = validatePetPackFile(mkFile(zip));

    expect(result.bodyKinds).toEqual(['body-model', 'body-still']);
    expect(result.entry?.role).toBe('body-model');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBe(zip.length);
    expect(result.manifest.actions).toEqual(validActionModel);
    expect(result.evaluation.valid).toBe(true);
  });

  it('只有过小的非本体图 → 400（fail-closed）', async () => {
    const zip = buildZip([{ name: 'preview.png', data: makePng(32, 32) }]);
    await expectBadRequest(() => inspectPetPack(zip));
  });

  it('pet/actions.json 动作模型不合法 → 400', async () => {
    const zip = buildZip([
      { name: 'pet/body.png', data: makePng(256, 256) },
      { name: 'pet/actions.json', data: Buffer.from(JSON.stringify({ schemaVersion: 99 })) },
    ]);
    await expectBadRequest(() => inspectPetPack(zip));
  });
});

describe('PetPacksService · 状态流转与发布', () => {
  const makeService = () => {
    const repo = {
      findOne: jest.fn(),
      save: jest.fn(async (x: unknown) => x),
      create: jest.fn((x: unknown) => x),
      increment: jest.fn(),
      remove: jest.fn(),
    };
    const reviews = { purgeAsset: jest.fn(), recordDownload: jest.fn(), upsertReview: jest.fn() };
    const storage = { upload: jest.fn(async () => '/uploads/pack.zip'), remove: jest.fn() };
    const service = new PetPacksService(repo as never, reviews as never, storage as never);
    return { service, repo, reviews, storage };
  };

  it('updateStatus：pending → approved / rejected', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue({ id: 'p1', status: 'pending' });
    await expect(service.updateStatus('p1', 'approved')).resolves.toMatchObject({ status: 'approved' });

    repo.findOne.mockResolvedValue({ id: 'p1', status: 'pending' });
    await expect(service.updateStatus('p1', 'rejected')).resolves.toMatchObject({ status: 'rejected' });
  });

  it('updateStatus：不存在 → 404', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue(null);
    await expect(service.updateStatus('missing', 'approved')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publish：非法包 → 400 且不落盘/不落库', async () => {
    const { service, repo, storage } = makeService();
    await expect(
      service.publish({ pack: mkFile(Buffer.from('not a zip')), dto: { name: 'x' }, authorId: 'u1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('publish：合法包 → 落库 status=pending 且派生字段来自校验结果', async () => {
    const { service, repo, storage } = makeService();
    const zip = buildZip([{ name: 'pet/body.png', data: makePng(256, 256) }]);
    const saved = await service.publish({
      pack: mkFile(zip),
      dto: { name: '可爱猫', tags: 'a, b' },
      authorId: 'u1',
    });
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ status: 'pending', tags: ['a', 'b'], bodyKinds: ['body-still'] });
    expect((saved as { packSha256: string }).packSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
