#!/usr/bin/env node
/**
 * 校验 platform/backend/src/pet-domain/ 与 pet/{domain,api,ui} 源是否一致。
 *
 * 用途：提交前 / CI 兜底——防止有人直接改了后端副本（或改了 pet/ 却忘了同步）。
 * 不一致 → 打印差异并**退出码 1**。
 *
 * 用法：node pet/tools/verify-sync.mjs
 * 注意：GENERATED_HEADER 必须与 tools/sync-to-backend.mjs 完全一致。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRS = ['domain', 'api', 'ui'];

/** 必须与 sync-to-backend.mjs 一致 */
const GENERATED_HEADER =
  '/* eslint-disable */\n' +
  '// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。\n' +
  '// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs\n\n';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const petRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(petRoot, '..');
const destRoot = join(repoRoot, 'platform', 'backend', 'src', 'pet-domain');

if (!existsSync(destRoot)) {
  console.error('✗ 后端副本不存在：请先运行 node pet/tools/sync-to-backend.mjs');
  process.exit(1);
}

const expected = new Map();
for (const d of SOURCE_DIRS) {
  const from = join(petRoot, d);
  if (!existsSync(from)) continue;
  for (const full of walk(from)) {
    const rel = relative(petRoot, full);
    if (rel.endsWith('.spec.ts')) continue;
    expected.set(rel, GENERATED_HEADER + readFileSync(full, 'utf8'));
  }
}

const actual = new Map();
for (const full of walk(destRoot)) {
  actual.set(relative(destRoot, full), readFileSync(full, 'utf8'));
}

const problems = [];
for (const [rel, content] of expected) {
  if (!actual.has(rel)) problems.push(`缺失：${rel}`);
  else if (actual.get(rel) !== content) problems.push(`内容不一致：${rel}`);
}
for (const rel of actual.keys()) {
  if (!expected.has(rel)) problems.push(`多余（源已删除）：${rel}`);
}

if (problems.length) {
  console.error('✗ 后端副本与 pet/ 源不一致：');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('请运行：node pet/tools/sync-to-backend.mjs');
  process.exit(1);
}

console.log(`✓ 一致：${expected.size} 个文件与 pet/ 源完全同步`);
