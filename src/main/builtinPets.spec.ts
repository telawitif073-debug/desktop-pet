import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// builtinPets.ts 依赖 electron 的 app.getPath('userData') / getAppPath() / isPackaged；
// 测试用临时目录替代真实 userData，避免污染 %APPDATA%\desktop-pet。
let userDataDir = '';
const appRoot = process.cwd();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
    getAppPath: vi.fn(() => appRoot),
    isPackaged: false,
  },
}));

type BuiltinModule = typeof import('./builtinPets');
type ConfigModule = typeof import('./config');
let builtin: BuiltinModule;
let configModule: ConfigModule;

beforeEach(async () => {
  // 每个用例重置模块级缓存，并使用全新的临时 userData 目录
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-builtin-test-'));
  configModule = await import('./config');
  builtin = await import('./builtinPets');
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

/** 取非空值（避免非空断言触发 lint 警告；缺失时直接失败更清晰） */
function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`期望存在但为空：${label}`);
  return value;
}

describe('内置演示宠物 · manifest 解析（纯函数）', () => {
  it('合法清单补默认值并规范化 interaction / frameRate', () => {
    const parsed = requireValue(
      builtin.parseBuiltinPetManifest({
        id: 'x',
        name: 'X',
        cover: { file: 'cover.png' },
        actions: [{ id: 'eat', name: '吃饭', frames: [{ file: 'actions/eat/frame_000.png' }] }],
      }),
      'manifest',
    );
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.actions[0].interaction).toBe('none');
    expect(parsed.actions[0].frameRate).toBe(6);
    expect(parsed.canvas.width).toBe(512);
    expect(parsed.provenance.kind).toBe('procedural');
  });

  it('缺 id/name/cover/动作/帧文件一律拒绝', () => {
    expect(builtin.parseBuiltinPetManifest(null)).toBeNull();
    // 缺 id
    expect(
      builtin.parseBuiltinPetManifest({
        name: 'X',
        cover: { file: 'c.png' },
        actions: [{ id: 'a', name: 'a', frames: [{ file: 'f.png' }] }],
      }),
    ).toBeNull();
    // cover 缺 file
    expect(
      builtin.parseBuiltinPetManifest({
        id: 'x',
        name: 'X',
        cover: {},
        actions: [{ id: 'a', name: 'a', frames: [{ file: 'f.png' }] }],
      }),
    ).toBeNull();
    // 空动作
    expect(builtin.parseBuiltinPetManifest({ id: 'x', name: 'X', cover: { file: 'c.png' }, actions: [] })).toBeNull();
    // 帧缺 file
    expect(
      builtin.parseBuiltinPetManifest({
        id: 'x',
        name: 'X',
        cover: { file: 'c.png' },
        actions: [{ id: 'a', name: 'a', frames: [{}] }],
      }),
    ).toBeNull();
  });
});

describe('内置演示宠物 · 资源目录与列表', () => {
  it('解析到随包的 resources/builtin-pets（dev 下同样可用）', () => {
    const dir = builtin.resolveBuiltinPetsDir();
    expect(dir.endsWith(path.join('resources', 'builtin-pets'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('列出已生成的芽芽猫：3 动作 / 24 帧且未激活', () => {
    const pets = builtin.listBuiltinPets();
    const cat = requireValue(
      pets.find((item) => item.id === 'sprout-cat'),
      'sprout-cat',
    );
    expect(cat.actionCount).toBe(3);
    expect(cat.frameCount).toBe(24);
    expect(cat.active).toBe(false);
    expect(cat.license).not.toBe('');
  });

  it('形象图可读且为 png dataUrl', () => {
    const cover = builtin.readBuiltinCover('sprout-cat');
    expect(cover?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('未知 id 返回 null / 失败而不是抛错', () => {
    expect(builtin.readBuiltinCover('not-exist')).toBeNull();
    const result = builtin.applyBuiltinPet('not-exist');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('内置演示宠物 · 应用与还原', () => {
  it('应用：写形象字段 + 3 个带 builtinPetId 的动作 + 三条互动绑定，帧图落盘', () => {
    const result = builtin.applyBuiltinPet('sprout-cat');
    expect(result.success).toBe(true);

    const cfg = configModule.loadConfig();
    expect(cfg.builtinPet).toBe('sprout-cat');
    expect(cfg.petAssetName).toBe('芽芽猫');
    // 必须显式 image，否则渲染端会落入 three/Live2D 分支导致空白
    expect(cfg.petAssetFormat).toBe('image');
    // 与平台宠物互斥
    expect(cfg.petAssetId).toBeUndefined();
    expect(cfg.petAssetPath).toBeUndefined();

    expect(cfg.petActions).toHaveLength(3);
    expect(cfg.petActions.every((a) => a.builtinPetId === 'sprout-cat')).toBe(true);
    // 动作名保留同名回退（吃饭/休息/玩耍）
    expect(cfg.petActions.map((a) => a.name).sort()).toEqual(['休息', '吃饭', '玩耍'].sort());
    // 帧图确实拷进 userData/pet-actions
    const frames = cfg.petActions[0].frameFiles ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(fs.existsSync(frames[0])).toBe(true);
    expect(path.normalize(frames[0]).startsWith(path.normalize(path.join(userDataDir, 'pet-actions')))).toBe(true);

    // 三条绑定指向三个不同动作
    const bindings = cfg.petActionBindings ?? {};
    expect(bindings.feed).toBeTruthy();
    expect(bindings.rest).toBeTruthy();
    expect(bindings.play).toBeTruthy();
    expect(new Set([bindings.feed, bindings.rest, bindings.play]).size).toBe(3);
    const active = requireValue(
      builtin.listBuiltinPets().find((p) => p.id === 'sprout-cat'),
      'sprout-cat active',
    );
    expect(active.active).toBe(true);
  });

  it('重复应用同一只幂等：不叠加动作', () => {
    builtin.applyBuiltinPet('sprout-cat');
    builtin.applyBuiltinPet('sprout-cat');
    expect(configModule.loadConfig().petActions).toHaveLength(3);
  });

  it('还原默认：动作/绑定/形象字段回到基线，帧目录被清理', () => {
    builtin.applyBuiltinPet('sprout-cat');
    const frames = configModule.loadConfig().petActions[0].frameFiles ?? [];
    const framesDir = path.dirname(frames[0]);
    expect(fs.existsSync(framesDir)).toBe(true);

    expect(builtin.resetBuiltinPet().success).toBe(true);

    const cfg = configModule.loadConfig();
    expect(cfg.builtinPet).toBeUndefined();
    expect(cfg.petAssetName).toBeUndefined();
    expect(cfg.petAssetFormat).toBeUndefined();
    expect(cfg.petActions).toHaveLength(0);
    expect(cfg.petActionBindings).toEqual({});
    expect(fs.existsSync(framesDir)).toBe(false);
  });

  it('用户已有 14 个自建动作时仍可应用内置宠物（配额按归属分别计数，互不挤占）', () => {
    const existing = Array.from({ length: 14 }, (_, i) => ({
      id: `manual_${i}`,
      name: `自定义${i}`,
      kind: 'frames' as const,
      source: 'manual' as const,
      frameFiles: [] as string[],
      createdAt: Date.now(),
    }));
    configModule.saveConfig({ petActions: existing });

    // 旧口径是「全应用动作总数 ≤ 15」，14 + 3 会被拒；新口径用户自建 14/15、本宠 3/128 都合规
    const result = builtin.applyBuiltinPet('sprout-cat');
    expect(result.success).toBe(true);

    const cfg = configModule.loadConfig();
    expect(cfg.petActions).toHaveLength(14 + (result.actionIds?.length ?? 0));
    // 自建动作一个都没被丢掉
    expect(cfg.petActions.filter((a) => a.source === 'manual' && !a.builtinPetId)).toHaveLength(14);
    // 本宠动作全部带 builtinPetId（归属清晰，才谈得上"各算各的"）
    expect(cfg.petActions.filter((a) => a.builtinPetId === 'sprout-cat').length).toBeGreaterThan(0);
  });
});