import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// petLibrary.ts 依赖 electron 的 app.getPath('userData') / getAppPath() / isPackaged。
// 测试用两个临时目录分别替代「打包资源根」与 userData，避免污染真实工程与 %APPDATA%。
let userDataDir = '';
let appPathDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
    getAppPath: vi.fn(() => appPathDir),
    isPackaged: false,
  },
}));

type LibraryModule = typeof import('./petLibrary');
type ConfigModule = typeof import('./config');
let library: LibraryModule;
let configModule: ConfigModule;

/** 只用到 PNG 魔数：读取/复制链路不校验像素内容 */
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

function writeLibraryFixture(files: Record<string, Buffer | string>): string {
  const libDir = path.join(appPathDir, 'resources', 'pet-asset-library');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(libDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return libDir;
}

function entry(file: string, repo = 'owner/repo') {
  return {
    file,
    sha256: 'sha',
    bytes: 8,
    source: { repo, url: `https://github.com/${repo}`, license: 'MIT', originalPath: `assets/${path.basename(file)}` },
  };
}

beforeEach(async () => {
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-library-userdata-'));
  appPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-library-app-'));
  configModule = await import('./config');
  library = await import('./petLibrary');
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(appPathDir, { recursive: true, force: true });
});

describe('资源库索引解析（纯函数）', () => {
  it('保留合法条目并规范化来源字段', () => {
    const parsed = library.parseLibraryIndex({
      schemaVersion: 1,
      entries: [entry('owner-repo/a.png')],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].repo).toBe('owner/repo');
    expect(parsed.entries[0].license).toBe('MIT');
    expect(parsed.entries[0].originalPath).toBe('assets/a.png');
  });

  it('丢弃目录穿越、绝对路径、非图片与缺 file 的条目（索引可能被污染）', () => {
    const parsed = library.parseLibraryIndex({
      entries: [
        { file: '../../etc/passwd' },
        { file: 'C:/Windows/system32/cmd.exe' },
        { file: 'owner-repo/notes.txt' },
        { file: '' },
        {},
        null,
        entry('owner-repo/ok.png'),
      ],
    });
    expect(parsed.entries.map((e) => e.file)).toEqual(['owner-repo/ok.png']);
  });

  it('非对象输入返回空索引而不是抛错', () => {
    expect(library.parseLibraryIndex(null).entries).toEqual([]);
    expect(library.parseLibraryIndex('nonsense').entries).toEqual([]);
  });
});

describe('safeJoin 路径防护', () => {
  it('接受库内相对路径，拒绝绝对路径与越界', () => {
    const base = path.join(appPathDir, 'resources', 'pet-asset-library');
    expect(library.safeJoin(base, 'a/b.png')).toBe(path.resolve(base, 'a/b.png'));
    expect(library.safeJoin(base, '../x.png')).toBeNull();
    expect(library.safeJoin(base, 'C:/x.png')).toBeNull();
    expect(library.safeJoin(base, '')).toBeNull();
    expect(library.safeJoin(base, 42)).toBeNull();
  });
});

describe('资源库读取与列表', () => {
  it('列表标记文件是否存在，读取返回 dataUrl，未索引的文件被拒绝', () => {
    writeLibraryFixture({
      'owner-repo/a.png': PNG_MAGIC,
      'index.json': JSON.stringify({ schemaVersion: 1, entries: [entry('owner-repo/a.png'), entry('owner-repo/missing.png')] }),
    });

    const assets = library.listLibraryAssets();
    expect(assets).toHaveLength(2);
    expect(assets.find((a) => a.file === 'owner-repo/a.png')?.available).toBe(true);
    expect(assets.find((a) => a.file === 'owner-repo/missing.png')?.available).toBe(false);

    const read = library.readLibraryAsset('owner-repo/a.png');
    expect(read.success).toBe(true);
    expect(read.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);

    // 磁盘上存在但不在索引内 → 拒绝（索引即白名单）
    fs.writeFileSync(path.join(appPathDir, 'resources', 'pet-asset-library', 'owner-repo', 'b.png'), PNG_MAGIC);
    expect(library.readLibraryAsset('owner-repo/b.png').success).toBe(false);
  });
});

describe('矢量素材（SVG）：可登记可预览，但不可直接设为形象/动作', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

  it('索引接受 .svg 并标记 format=svg，读取返回 image/svg+xml dataUrl', () => {
    writeLibraryFixture({
      'owner-repo/icon.svg': SVG,
      'index.json': JSON.stringify({
        schemaVersion: 1,
        entries: [{ file: 'owner-repo/icon.svg', sha256: 's', format: 'svg', source: { repo: 'owner/repo', url: 'u', license: 'MIT', originalPath: 'assets/icon.svg' } }],
      }),
    });
    const assets = library.listLibraryAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0].format).toBe('svg');
    const read = library.readLibraryAsset('owner-repo/icon.svg');
    expect(read.success).toBe(true);
    expect(read.dataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('设为形象 / 加为动作都被明确拒绝（不静默失败、不产生副作用）', () => {
    writeLibraryFixture({
      'owner-repo/icon.svg': SVG,
      'index.json': JSON.stringify({
        schemaVersion: 1,
        entries: [{ file: 'owner-repo/icon.svg', sha256: 's', format: 'svg', source: { repo: 'owner/repo', url: 'u', license: 'MIT', originalPath: 'assets/icon.svg' } }],
      }),
    });
    const applied = library.applyLibraryAsset('owner-repo/icon.svg');
    expect(applied.success).toBe(false);
    expect(applied.error).toContain('栅格化');
    const action = library.addLibraryAssetAsAction('owner-repo/icon.svg');
    expect(action.success).toBe(false);
    expect(configModule.loadConfig().petActions).toHaveLength(0);
    expect(configModule.loadConfig().petAssetPath).toBeUndefined();
  });
});

describe('设为形象 / 加为动作', () => {
  it('设为形象：复制进 userData、写入既有形象链路字段、让出内置宠物', async () => {
    writeLibraryFixture({
      'owner-repo/a.png': PNG_MAGIC,
      'index.json': JSON.stringify({ schemaVersion: 1, entries: [entry('owner-repo/a.png')] }),
    });

    const result = library.applyLibraryAsset('owner-repo/a.png', '测试形象');
    expect(result.success).toBe(true);
    expect(result.path && fs.existsSync(result.path)).toBe(true);
    expect(result.path?.includes('pet-library')).toBe(true);

    const cfg = configModule.loadConfig();
    expect(cfg.petAssetFormat).toBe('image');
    expect(cfg.petAssetName).toBe('测试形象');
    expect(cfg.builtinPet).toBeUndefined();
    expect(cfg.petAssetPath).toBe(result.path);
  });

  it('加为动作：包成单帧动作并落进 petActions（宠物窗可播放）', () => {
    writeLibraryFixture({
      'owner-repo/a.png': PNG_MAGIC,
      'index.json': JSON.stringify({ schemaVersion: 1, entries: [entry('owner-repo/a.png')] }),
    });

    const result = library.addLibraryAssetAsAction('owner-repo/a.png', '资源库动作');
    expect(result.success).toBe(true);
    expect(result.action?.name).toBe('资源库动作');
    expect(result.action?.frameFiles).toHaveLength(1);
    expect(result.action?.frameFiles?.[0].endsWith('.png')).toBe(true);
    expect(fs.existsSync(result.action?.frameFiles?.[0] ?? '')).toBe(true);

    const cfg = configModule.loadConfig();
    expect(cfg.petActions.map((a) => a.name)).toContain('资源库动作');
  });

  it('未索引 / 文件缺失时都失败且不产生副作用', () => {
    writeLibraryFixture({
      'owner-repo/missing.png': '',
      'index.json': JSON.stringify({ schemaVersion: 1, entries: [entry('owner-repo/missing.png')] }),
    });
    fs.rmSync(path.join(appPathDir, 'resources', 'pet-asset-library', 'owner-repo', 'missing.png'), { force: true });

    expect(library.applyLibraryAsset('nope.png').success).toBe(false);
    expect(library.applyLibraryAsset('owner-repo/missing.png').success).toBe(false);
    expect(library.addLibraryAssetAsAction('owner-repo/missing.png').success).toBe(false);
    expect(configModule.loadConfig().petActions).toHaveLength(0);
  });
});
