#!/usr/bin/env node
/**
 * 打包产物核验：确认 electron-forge 打出来的应用里，确实带着完整、未损坏的宠物资源
 * ---------------------------------------------------------------------------
 * 校验内容（对 resources/builtin-pets 与 resources/pet-asset-library 逐文件比对）：
 *   1) 源目录的每个文件在打包产物里都存在，且 sha256 完全一致（不是「看起来有」）；
 *   2) 打包产物里没有源目录里不存在的多余文件（避免把上一轮的孤儿文件打进包）；
 *   3) 每个宠物 manifest 能被 JSON 解析，且 id 与目录名一致（主进程运行期强校验）；
 *   4) 资源库 index.json 的条目数与磁盘文件数一致、format 分布可读。
 *
 * 用法：node scripts/pets/verify-package.mjs [--app=<out 下的应用目录名>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'out');
const argv = process.argv.slice(2);
const appArg = argv.find((a) => a.startsWith('--app='));

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function findPackagedResources() {
  if (!fs.existsSync(OUT)) throw new Error('缺少 out/ 目录：请先运行 npm run package');
  const candidates = fs
    .readdirSync(OUT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(OUT, e.name, 'resources'))
    .filter((p) => fs.existsSync(path.join(p, 'builtin-pets')));
  if (appArg) {
    const forced = path.join(OUT, appArg.split('=')[1], 'resources');
    if (fs.existsSync(forced)) return forced;
  }
  if (!candidates.length) throw new Error('out/ 下找不到包含 builtin-pets 的打包产物');
  return candidates[0];
}

const problems = [];
const stats = {};

const packagedResources = findPackagedResources();
console.log(`打包资源目录：${path.relative(ROOT, packagedResources)}`);

for (const dirName of ['builtin-pets', 'pet-asset-library']) {
  const src = path.join(ROOT, 'resources', dirName);
  const dst = path.join(packagedResources, dirName);
  if (!fs.existsSync(dst)) {
    problems.push(`打包产物缺少目录：resources/${dirName}`);
    continue;
  }
  const srcFiles = walk(src);
  const dstFiles = new Set(walk(dst));
  let mismatch = 0;
  for (const rel of srcFiles) {
    if (!dstFiles.has(rel)) {
      problems.push(`打包产物缺少文件：${dirName}/${rel}`);
      continue;
    }
    if (sha256(path.join(src, rel)) !== sha256(path.join(dst, rel))) {
      problems.push(`文件内容不一致：${dirName}/${rel}`);
      mismatch++;
    }
  }
  for (const rel of dstFiles) if (!srcFiles.includes(rel)) problems.push(`打包产物多出文件：${dirName}/${rel}`);
  stats[dirName] = { files: srcFiles.length, mismatch };
  console.log(`  ${dirName.padEnd(18)} 源文件 ${String(srcFiles.length).padStart(5)}｜sha256 不一致 ${mismatch}`);
}

// 宠物清单运行期校验（id 必须与目录名一致）
const packagedPets = path.join(packagedResources, 'builtin-pets');
const petDirs = fs.readdirSync(packagedPets, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
let imported = 0;
let originals = 0;
for (const name of petDirs) {
  const manifestPath = path.join(packagedPets, name, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push(`宠物目录缺 manifest：${name}`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    problems.push(`manifest 无法解析：${name}（${e.message}）`);
    continue;
  }
  if (manifest.id !== name) problems.push(`manifest.id(${manifest.id}) 与目录名(${name}) 不一致`);
  if (!manifest.actions?.length) problems.push(`宠物没有动作：${name}`);
  if ((manifest.origin ?? {}).provider === 'github') imported++;
  else originals++;
}
stats.pets = { total: petDirs.length, imported, originals };
console.log(`  宠物目录            ${petDirs.length}（导入 ${imported} / 自产 ${originals}）`);

// 资源库索引一致性
const libIndexPath = path.join(packagedResources, 'pet-asset-library', 'index.json');
if (fs.existsSync(libIndexPath)) {
  const index = JSON.parse(fs.readFileSync(libIndexPath, 'utf-8'));
  const byFormat = index.entries.reduce((acc, e) => ((acc[e.format ?? 'unknown'] = (acc[e.format ?? 'unknown'] ?? 0) + 1), acc), {});
  const onDisk = walk(path.join(packagedResources, 'pet-asset-library')).filter((f) => f !== 'index.json');
  stats.library = { entries: index.entries.length, onDisk: onDisk.length, byFormat };
  console.log(`  资源库条目          ${index.entries.length}（磁盘文件 ${onDisk.length}，格式 ${JSON.stringify(byFormat)}）`);
  if (index.entries.length !== onDisk.length) problems.push('资源库索引条目数与磁盘文件数不一致');
} else {
  problems.push('打包产物缺少 pet-asset-library/index.json');
}

console.log('');
if (problems.length) {
  console.log(`PACKAGE VERIFY FAIL（${problems.length} 项）`);
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('PACKAGE VERIFY PASS：打包产物与源资源逐文件 sha256 一致，清单与索引自洽');
