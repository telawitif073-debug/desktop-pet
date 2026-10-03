#!/usr/bin/env node
/**
 * 共享包 `@pet/domain` → 平台后端 源码同步
 * ---------------------------------------------------------------------------
 * 背景：`platform/backend/tsconfig.json` 的 `include` 只有 `src`/`scripts`。
 * 若后端直接跨目录 import 仓库根的 `packages/pet-domain/src/**`，TypeScript 会把
 * common source root 上移到仓库根，产物变成 `dist/platform/backend/src/main.js`，
 * `node dist/main.js`（package.json 的 start）随即失效。
 *
 * 做法：把共享包源码**同步复制**到 `platform/backend/src/pet-domain/`，
 * 后端照常用普通相对 import（`./pet-domain`），产物布局保持不变。
 *
 * 该目录是**生成物**（已加入 .gitignore），请勿手工编辑；改动一律落在
 * `packages/pet-domain/src/`，再由本脚本同步。
 *
 * 复制范围：`src/**\/*.ts`，**排除 `*.spec.ts`**（单测由仓库根的 vitest 统一执行，
 * 后端 jest 的 testRegex 会误拾取，且不需要编进 dist）。
 *
 * 用法：node scripts/sync-pet-domain.mjs [--check]
 *   --check  只报告差异、不写入（差异存在时退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'packages', 'pet-domain', 'src');
const DEST_DIR = path.join(ROOT, 'platform', 'backend', 'src', 'pet-domain');
const checkOnly = process.argv.includes('--check');

const listSources = () =>
  fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
    .map((e) => e.name)
    .sort();

const files = listSources();
if (files.length === 0) {
  console.error(`[sync-pet-domain] 源目录没有可复制文件：${SRC_DIR}`);
  process.exit(1);
}

// 清理目标目录里「源已不存在」的残留（例如共享包删了某个模块）
const stale = fs.existsSync(DEST_DIR)
  ? fs.readdirSync(DEST_DIR).filter((name) => name.endsWith('.ts') && !files.includes(name))
  : [];

if (checkOnly) {
  const changed = files.filter((name) => {
    const destPath = path.join(DEST_DIR, name);
    return !fs.existsSync(destPath) || fs.readFileSync(destPath, 'utf8') !== fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
  });
  if (changed.length || stale.length) {
    console.error(`[sync-pet-domain] 需要同步：新增/改动 ${changed.length} 个，残留 ${stale.length} 个`);
    for (const name of [...changed, ...stale.map((n) => `${n}（残留）`)]) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log(`[sync-pet-domain] 已是最新（${files.length} 个文件）`);
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
for (const name of stale) fs.rmSync(path.join(DEST_DIR, name));

let written = 0;
for (const name of files) {
  const from = path.join(SRC_DIR, name);
  const to = path.join(DEST_DIR, name);
  const content = fs.readFileSync(from, 'utf8');
  if (!fs.existsSync(to) || fs.readFileSync(to, 'utf8') !== content) {
    fs.writeFileSync(to, content, 'utf8');
    written += 1;
  }
}

const rel = path.relative(ROOT, DEST_DIR).replace(/\\/g, '/');
console.log(`[sync-pet-domain] ${rel}：${files.length} 个文件，写入 ${written} 个${stale.length ? `，清理残留 ${stale.length} 个` : ''}`);
