#!/usr/bin/env node
/**
 * 生成 pet/resources/upstream-manifest.json —— 上游第三方素材的「索引」（不含字节本体）。
 *
 * 背景：pet/resources/upstream/ 是 PC2005-cloud/dsh-pet 的素材副本（代码 MIT，
 * 素材「禁止商用 + 二创须署名」）。素材本身不入库（见 .gitignore），仓库只保留本索引，
 * 用于可追溯来源、体积核对与署名留档。
 *
 * 用法：node pet/tools/build-resource-manifest.mjs
 * 输出确定性：仅按路径排序 + 字节/哈希，不含时间戳，重复运行结果一致。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = join(petRoot, 'resources', 'upstream');
const outFile = join(petRoot, 'resources', 'upstream-manifest.json');

const SOURCE = {
  repo: 'https://github.com/PC2005-cloud/dsh-pet',
  codeLicense: 'MIT',
  assetLicense: 'SourceAvailable-NonCommercial',
  attribution: '二创/分发须署名 https://github.com/PC2005-cloud/dsh-pet',
};

if (!existsSync(upstreamDir)) {
  console.error(`找不到 ${upstreamDir}（素材被 .gitignore 排除，仅本机存在；请先放置素材再生成索引）`);
  process.exit(1);
}

/** 递归收集文件（绝对路径） */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const files = walk(upstreamDir).sort((a, b) => a.localeCompare(b));
const entries = files.map((full) => {
  const bytes = readFileSync(full);
  return {
    path: relative(upstreamDir, full).split(sep).join('/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});

const manifest = {
  source: SOURCE,
  root: 'pet/resources/upstream',
  count: entries.length,
  totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
  entries,
};

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(
  `已生成 ${relative(process.cwd(), outFile)}：${entries.length} 个文件，` +
    `${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MiB`,
);
