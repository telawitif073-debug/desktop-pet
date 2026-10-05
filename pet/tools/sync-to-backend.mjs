#!/usr/bin/env node
/**
 * 把 pet/{domain,api,ui} 的共享源码同步复制到 platform/backend/src/pet-domain/。
 *
 * 为什么用「复制」而不是跨目录直接引用：后端 `nest build` 受 `rootDir` 约束，
 * 且项目硬约束「后端不引第三方依赖 / 不改依赖拓扑」；因此采用复制 + 一致性校验。
 *
 * 规则：
 *   - 目录结构原样镜像（domain/ api/ ui/），相对 import 保持不变；
 *   - **跳过 `*.spec.ts`**（避免被后端 jest 收集、污染覆盖率）；
 *   - 每个文件注入「生成物勿手改」头注释；
 *   - 覆盖前整目录重建，保证删除的源文件不会留下孤儿副本。
 *
 * 用法：node pet/tools/sync-to-backend.mjs
 * 注意：与 tools/verify-sync.mjs 共用同一份头注释常量，改动需同步。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRS = ['domain', 'api', 'ui'];

/** 生成物头注释（verify-sync.mjs 必须与此完全一致） */
export const GENERATED_HEADER =
  '/* eslint-disable */\n' +
  '// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。\n' +
  '// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs\n\n';

/** 递归收集 .ts 文件（绝对路径） */
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

if (existsSync(destRoot)) rmSync(destRoot, { recursive: true, force: true });
mkdirSync(destRoot, { recursive: true });

let copied = 0;
let skipped = 0;
for (const d of SOURCE_DIRS) {
  const from = join(petRoot, d);
  if (!existsSync(from)) continue;
  for (const full of walk(from)) {
    const rel = relative(petRoot, full);
    if (rel.endsWith('.spec.ts')) {
      skipped++;
      continue;
    }
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, GENERATED_HEADER + readFileSync(full, 'utf8'), 'utf8');
    copied++;
  }
}

console.log(`已同步 ${copied} 个文件 → platform/backend/src/pet-domain/（跳过 ${skipped} 个 spec）`);
