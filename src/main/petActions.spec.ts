import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

// petActions 依赖 electron 的 app.getPath('userData') 与 config 落盘；用临时目录替代
let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
    getAppPath: vi.fn(() => process.cwd()),
    isPackaged: false,
  },
}));

type ActionsModule = typeof import('./petActions');
type ConfigModule = typeof import('./config');
let actions: ActionsModule;
let configModule: ConfigModule;

// —— 最小 PNG 编码器（同 petPack.spec：真实可解析字节，用于验证按内容定性） ——
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
function png(width: number, height: number, alpha = 255): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) raw[y * stride + 1 + x * 4 + 3] = alpha;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const file = (filename: string, data: Buffer) => ({ filename, data });

beforeEach(async () => {
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-actions-'));
  configModule = await import('./config');
  actions = await import('./petActions');
});
afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('上传动作的宠物本体校验（修复「任意图都能变成宠物动作」）', () => {
  it('全部帧都被证明为非本体（截图 + PCB 工程图）→ 拒绝并给出显式原因', () => {
    expect(() =>
      actions.addFramesAction('误用的动作', [
        file('screenshot.png', png(1920, 1080)),
        file('pcb-dimension.png', png(800, 600)),
      ]),
    ).toThrow(/不属于宠物本体资源/);
    expect(configModule.loadConfig().petActions).toHaveLength(0);
  });

  it('界面件/品牌资源同样被拒（光标、logo）', () => {
    expect(() =>
      actions.addFramesAction('图标动作', [file('cursor-grab.png', png(64, 64)), file('logo.png', png(256, 256))]),
    ).toThrow(/不属于宠物本体资源/);
  });

  it('本体静帧序列（512×512 RGBA）→ 放行并落盘帧文件', () => {
    const action = actions.addFramesAction('待机', [
      file('idle_000.png', png(512, 512)),
      file('idle_001.png', png(512, 512)),
    ]);
    expect(action.frameFiles).toHaveLength(2);
    expect(action.frameFiles?.every((f) => fs.existsSync(f))).toBe(true);
    expect(configModule.loadConfig().petActions.map((a) => a.name)).toEqual(['待机']);
  });

  it('像素画序列（32×32，逐帧很小）按序列整体放行', () => {
    const action = actions.addFramesAction('走路', [
      file('walk_000.png', png(32, 32)),
      file('walk_001.png', png(32, 32)),
    ]);
    expect(action.frameFiles).toHaveLength(2);
  });

  it('无法定性的内容（截断 PNG）→ 放行：探测不足不能当成拒绝理由', () => {
    const truncated = Buffer.from('89504e470d0a1a0a', 'hex');
    const action = actions.addFramesAction('未知格式', [file('weird.png', truncated)]);
    expect(action.frameFiles).toHaveLength(1);
  });

  it('混合上传（非本体 + 本体）→ 放行（用户意图明确）', () => {
    const action = actions.addFramesAction('混合', [
      file('screenshot.png', png(1920, 1080)),
      file('body_000.png', png(512, 512)),
    ]);
    expect(action.frameFiles).toHaveLength(2);
  });

  it('空帧/超量等既有校验保持不变', () => {
    expect(() => actions.addFramesAction('空', [])).toThrow(/至少上传一张图片/);
    expect(() => actions.addFramesAction('  ', [file('a.png', png(512, 512))])).toThrow(/动作名称不能为空/);
  });

  // ── 动作配额：按归属分别计数（旧口径是「全应用动作总数 ≤ 15」） ──────────────

  it('用户自建动作到达上限后，第 16 个被拒；同刻给宠物加动作不受影响', () => {
    const limit = configModule.PET_ACTIONS_MAX_USER;
    for (let i = 0; i < limit; i++) {
      actions.addFramesAction(`自建${i}`, [file(`f${i}.png`, png(512, 512))]);
    }
    expect(() => actions.addFramesAction('第16个', [file('x.png', png(512, 512))]))
      .toThrow(/我的动作数量已达上限/);
    // 关键：用户配额已满，但"宠物自带动作"走的是另一个配额，仍可添加
    expect(() => actions.addFramesAction('宠物动作', [file('y.png', png(512, 512))], { petAssetId: 'pet-A' }))
      .not.toThrow();
  });

  it('配额按归属分别计数：宠物满额只挡该宠物，内置归属与用户互不干扰', () => {
    const petAction = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `a${i}`,
      name: `n${i}`,
      kind: 'frames' as const,
      source: 'manual' as const,
      createdAt: i,
      ...extra,
    });
    const userFull = Array.from({ length: configModule.PET_ACTIONS_MAX_USER }, (_, i) => petAction(i));
    expect(() => configModule.assertActionQuota(userFull, {})).toThrow(/我的动作数量已达上限/);
    expect(() => configModule.assertActionQuota(userFull, { petAssetId: 'pet-A' })).not.toThrow();

    const petAFull = Array.from({ length: configModule.PET_ACTIONS_MAX_PER_PET }, (_, i) =>
      petAction(i, { petAssetId: 'pet-A' }),
    );
    expect(() => configModule.assertActionQuota(petAFull, { petAssetId: 'pet-A' }))
      .toThrow(/该宠物动作数量已达上限/);
    // 换一只宠物、或换成内置宠物归属，都还有各自配额
    expect(() => configModule.assertActionQuota(petAFull, { petAssetId: 'pet-B' })).not.toThrow();
    expect(() => configModule.assertActionQuota(petAFull, { builtinPetId: 'sprout-cat' })).not.toThrow();
  });

  it('归属键优先取 builtinPetId，其次 petAssetId，都没有才算用户自建', () => {
    expect(configModule.actionOwnerKey({})).toBe(configModule.ACTIONS_OWNER_USER);
    expect(configModule.actionOwnerKey({ petAssetId: 'p1' })).toBe('p1');
    expect(configModule.actionOwnerKey({ petAssetId: 'p1', builtinPetId: 'b1' })).toBe('b1');
    expect(configModule.actionQuotaLimit(configModule.ACTIONS_OWNER_USER)).toBe(configModule.PET_ACTIONS_MAX_USER);
    expect(configModule.actionQuotaLimit('p1')).toBe(configModule.PET_ACTIONS_MAX_PER_PET);
  });
});
