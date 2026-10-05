import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// builtinPets 依赖 electron 的 app.getPath/getAppPath/isPackaged，用临时目录替代
let appPath = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => appPath),
    getAppPath: vi.fn(() => appPath),
    isPackaged: false,
  },
}));

const { parseBuiltinManifest, safeJoin, listBuiltinPets, resolveBuiltinEntry, resolveBuiltinPetsDir } = await import(
  './builtinPets'
);

afterEach(() => {
  if (appPath) fs.rmSync(appPath, { recursive: true, force: true });
  appPath = '';
});

describe('内置演示宠物清单解析（pet/resources/builtin/manifest.json）', () => {
  it('解析 pets[]：补默认 description/author/license/bodyKinds，展开动作与帧', () => {
    const parsed = parseBuiltinManifest({
      schemaVersion: 1,
      pets: [
        {
          id: 'sprout-cat',
          name: '芽芽猫',
          entry: 'sprout-cat/cover.svg',
          bodyKinds: ['image'],
          actions: [
            { id: 'idle', name: '待机', frames: [{ file: 'a.png' }, { file: 'b.png' }], interaction: 'none', frameRate: 8 },
          ],
        },
      ],
    });
    expect(parsed?.pets).toHaveLength(1);
    const pet = parsed!.pets[0];
    expect(pet.id).toBe('sprout-cat');
    expect(pet.bodyKinds).toEqual(['image']);
    expect(pet.description).toBe('');
    expect(pet.actions[0]).toMatchObject({ id: 'idle', name: '待机', frameRate: 8 });
    expect(pet.actions[0].frames).toHaveLength(2);
  });

  it('丢弃非法条目：缺 id/name/entry、绝对路径、越界（..）、重复 id', () => {
    const parsed = parseBuiltinManifest({
      pets: [
        { id: 'abs', name: 'A', entry: '/abs/x.png' },
        { id: 'up', name: 'B', entry: '../x.png' },
        { id: 'noentry', name: 'C' },
        { id: 'dup', name: 'D1', entry: 'd.png' },
        { id: 'dup', name: 'D2', entry: 'd2.png' },
        { id: 'ok', name: 'OK', entry: 'ok/cover.svg' },
      ],
    });
    expect(parsed?.pets.map((p) => p.id)).toEqual(['dup', 'ok']);
  });

  it('无合法条目返回 null；空动作列表不产生动作', () => {
    expect(parseBuiltinManifest({ pets: [] })).toBeNull();
    expect(parseBuiltinManifest(null)).toBeNull();
    const parsed = parseBuiltinManifest({ pets: [{ id: 'x', name: 'X', entry: 'x.svg', actions: [] }] });
    expect(parsed?.pets[0].actions).toEqual([]);
  });

  it('safeJoin 拒绝绝对路径与越界，接受包内相对路径', () => {
    const base = path.resolve('/tmp/base');
    expect(safeJoin(base, 'a/b.png')).toBe(path.join(base, 'a', 'b.png'));
    expect(safeJoin(base, '/etc/passwd')).toBeNull();
    expect(safeJoin(base, '../x')).toBeNull();
    expect(safeJoin(base, '')).toBeNull();
  });

  it('listBuiltinPets / resolveBuiltinEntry 读取真实目录下的 manifest', () => {
    appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-builtin-'));
    const dir = path.join(appPath, 'pet', 'resources', 'builtin');
    fs.mkdirSync(path.join(dir, 'sprout-cat'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sprout-cat', 'cover.svg'), '<svg/>');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, pets: [{ id: 'sprout-cat', name: '芽芽猫', entry: 'sprout-cat/cover.svg' }] }),
    );
    expect(resolveBuiltinPetsDir()).toBe(dir);
    const list = listBuiltinPets();
    expect(list.map((p) => p.id)).toEqual(['sprout-cat']);
    expect(list[0].active).toBe(false);
    expect(resolveBuiltinEntry('sprout-cat')).toBe(path.join(dir, 'sprout-cat', 'cover.svg'));
    expect(resolveBuiltinEntry('missing')).toBeNull();
  });
});
