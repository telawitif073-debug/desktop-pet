import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// 用真实解析器（src/main/builtinPets.ts）校验导入产物，避免「测试自己写一套宽松校验」。
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getAppPath: vi.fn(() => process.cwd()),
    isPackaged: false,
  },
}));

import { listBuiltinPets, parseBuiltinPetManifest } from './builtinPets';
import { parseLibraryIndex } from './petLibrary';

/**
 * 上游美术资源导入产物 · 端到端校验
 * ---------------------------------------------------------------------------
 * 这份用例是「集成是否真的成立」的守门人，逐条对应本次任务的可验收点：
 *   1) 每个导入宠物都能被主进程的真实解析器接受（id 与目录名一致、至少 1 个动作、帧非空）；
 *   2) 帧文件/封面真实存在，且 sha256 与清单一致（防篡改、防复制漏文件）；
 *   3) 许可与来源可追溯（license / origin.repo / origin.rank 必须存在，合规底线）；
 *   4) 资源库索引里的每张静态素材都存在且哈希一致（证明「取的素材都可用」）。
 */
const ROOT = process.cwd();
const BUILTIN_DIR = path.join(ROOT, 'resources', 'builtin-pets');
const LIBRARY_DIR = path.join(ROOT, 'resources', 'pet-asset-library');

const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ALLOWED_INTERACTIONS = new Set(['none', 'feed', 'rest', 'play']);

interface ImportedPet {
  dir: string;
  id: string;
  raw: Record<string, unknown>;
}

function collectImportedPets(): ImportedPet[] {
  if (!fs.existsSync(BUILTIN_DIR)) return [];
  const out: ImportedPet[] = [];
  for (const name of fs.readdirSync(BUILTIN_DIR)) {
    const dir = path.join(BUILTIN_DIR, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) continue;
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    const origin = (raw.origin ?? {}) as Record<string, unknown>;
    if (origin.provider !== 'github') continue;
    out.push({ dir, id: name, raw });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

describe('上游导入宠物 · 产物完整性', () => {
  const pets = collectImportedPets();

  it('至少导入了一个上游项目（否则说明集成没落地）', () => {
    expect(pets.length).toBeGreaterThan(0);
  });

  it('主进程 listBuiltinPets() 能列出全部导入宠物，且自产宠物未被破坏', () => {
    expect(pets.length).toBeGreaterThan(0);
    const listed = new Set(listBuiltinPets().map((p) => p.id));
    const missing = pets.map((p) => p.id).filter((id) => !listed.has(id));
    expect(missing).toEqual([]);
    // 导入不能挤掉原有 3 只自产宠物
    for (const id of ['sprout-cat', 'cloud-rabbit', 'charcoal-pup']) expect(listed.has(id)).toBe(true);
  });

  it(
    '每个导入宠物：清单合法、封面/帧齐全且 sha256 一致、许可与来源可追溯',
    () => {
      expect(pets.length).toBeGreaterThan(0);
      const problems: string[] = [];

      for (const pet of pets) {
        const parsed = parseBuiltinPetManifest(pet.raw);
        if (!parsed) {
          problems.push(`${pet.id}: 真实解析器拒绝该 manifest`);
          continue;
        }
        if (parsed.id !== pet.id) problems.push(`${pet.id}: manifest.id(${parsed.id}) 与目录名不一致`);
        if (!parsed.license.trim()) problems.push(`${pet.id}: 缺 license（合规要求）`);
        if (!parsed.provenance || parsed.provenance.kind !== 'imported')
          problems.push(`${pet.id}: provenance.kind 应为 imported`);

        const origin = (pet.raw.origin ?? {}) as Record<string, unknown>;
        if (!String(origin.repo ?? '').trim()) problems.push(`${pet.id}: 缺 origin.repo`);
        if (typeof origin.rank !== 'number') problems.push(`${pet.id}: 缺 origin.rank（排序溯源）`);
        if (typeof origin.combinedScore !== 'number') problems.push(`${pet.id}: 缺 origin.combinedScore`);
        if (!String(origin.url ?? '').includes('github.com')) problems.push(`${pet.id}: origin.url 不是 GitHub 地址`);

        // 封面
        const coverFile = path.join(pet.dir, parsed.cover.file);
        if (!fs.existsSync(coverFile)) problems.push(`${pet.id}: 缺封面 ${parsed.cover.file}`);
        else if (parsed.cover.sha256 && sha256File(coverFile) !== parsed.cover.sha256)
          problems.push(`${pet.id}: 封面 sha256 不匹配`);

        // 动作与帧
        if (parsed.actions.length === 0) problems.push(`${pet.id}: 没有动作`);
        for (const action of parsed.actions) {
          if (!ALLOWED_INTERACTIONS.has(action.interaction))
            problems.push(`${pet.id}/${action.id}: interaction 非法 ${action.interaction}`);
          if (!(action.frameRate > 0)) problems.push(`${pet.id}/${action.id}: frameRate 非法`);
          if (action.frames.length === 0) problems.push(`${pet.id}/${action.id}: 没有帧`);
          for (const frame of action.frames) {
            const file = path.join(pet.dir, frame.file);
            if (!fs.existsSync(file)) {
              problems.push(`${pet.id}/${action.id}: 缺帧 ${frame.file}`);
              continue;
            }
            if (frame.sha256 && sha256File(file) !== frame.sha256)
              problems.push(`${pet.id}/${action.id}: 帧 ${frame.file} sha256 不匹配`);
          }
        }
      }

      expect(problems).toEqual([]);
    },
    180_000,
  );

  it('同一只宠物内所有帧尺寸一致（渲染端逐帧不做对齐，尺寸不一致会抖动）', () => {
    expect(pets.length).toBeGreaterThan(0);
    // 仅读 PNG 头（IHDR 宽高），不做整图解码：几千帧也能秒级完成
    const readPngSize = (file: string): string => {
      const buf = fs.readFileSync(file, { flag: 'r' });
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    };
    const problems: string[] = [];
    for (const pet of pets) {
      const parsed = parseBuiltinPetManifest(pet.raw);
      if (!parsed) continue;
      const sizes = new Set<string>();
      sizes.add(readPngSize(path.join(pet.dir, parsed.cover.file)));
      for (const action of parsed.actions) {
        for (const frame of action.frames) sizes.add(readPngSize(path.join(pet.dir, frame.file)));
      }
      if (sizes.size > 1) problems.push(`${pet.id}: 帧尺寸不一致 ${[...sizes].join(', ')}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('上游静态素材资源库 · 索引与文件一致', () => {
  it(
    '索引内每张素材都存在于磁盘且 sha256 与索引一致（缺文件即视为集成不完整）',
    () => {
      const indexFile = path.join(LIBRARY_DIR, 'index.json');
      expect(fs.existsSync(indexFile)).toBe(true);
      const index = parseLibraryIndex(JSON.parse(fs.readFileSync(indexFile, 'utf-8')));
      expect(index.entries.length).toBeGreaterThan(0);

      const problems: string[] = [];
      for (const entry of index.entries) {
        const file = path.join(LIBRARY_DIR, entry.file);
        if (!fs.existsSync(file)) {
          problems.push(`缺文件：${entry.file}`);
          continue;
        }
        if (entry.sha256 && sha256File(file) !== entry.sha256) problems.push(`sha256 不匹配：${entry.file}`);
        if (!entry.repo || !entry.license) problems.push(`缺来源/许可：${entry.file}`);
      }
      expect(problems).toEqual([]);

      // 索引必须真的覆盖所有落盘素材，不能有「下了却没登记」的孤儿文件
      const onDisk: string[] = [];
      const walk = (dir: string, base = dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, base);
          else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) onDisk.push(path.relative(base, full).split(path.sep).join('/'));
        }
      };
      walk(LIBRARY_DIR);
      const indexed = new Set(index.entries.map((e) => e.file));
      const orphans = onDisk.filter((f) => !indexed.has(f));
      expect(orphans).toEqual([]);
    },
    180_000,
  );
});
