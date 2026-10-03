#!/usr/bin/env node
/**
 * 把公开 GitHub 仓库的源码取到工作区内的 Environment/downloads 下（并解包）
 * ---------------------------------------------------------------------------
 * 为什么不用 git clone：本机 `github.com:443` 不可达（实测 3 次仅 1 次成功），
 *   `codeload.github.com` 可达且**不消耗 API 额度**，因此统一用 zipball。
 *
 * 合规与可复现：
 *   - 默认 `--pin`：先用 1 次 api.github.com 调用把 ref 解析成 **commit sha**，
 *     再按 sha 下载 zipball → 产物与「哪一次提交」严格绑定，可复查；
 *   - 落盘 `.fetch.json` 记录 repo/ref/sha/url/字节数/zip 的 sha256/解包文件数；
 *   - 抓取范围可限定 `--subdir`（只解包子目录 + 根目录许可/说明文件），避免整仓搬运。
 *
 * 用法：
 *   node scripts/env/fetch-github-repo.mjs PC2005-cloud/dsh-pet --ref=main --subdir=dsh-pet
 *   node scripts/env/fetch-github-repo.mjs owner/repo --ref=main --name=mytool --no-pin
 *
 * 输出根目录：E:\desktop-pet\Environment\downloads\github\<name>\
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_ROOT = process.env.DESKTOP_PET_ENV || path.join(ROOT, 'Environment');
const DL_ROOT = path.join(ENV_ROOT, 'downloads', 'github');
const UA = 'desktop-pet-env-fetch/1.0';
const CAP_MB = Number(process.env.FETCH_CAP_MB || '800');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const flag = (n) => argv.includes(`--${n}`);
const slug = argv.find((a) => !a.startsWith('--'));
if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) {
  console.error('用法：node scripts/env/fetch-github-repo.mjs <owner/repo> [--ref=main] [--subdir=x] [--name=y] [--no-pin] [--keep-zip]');
  process.exit(2);
}
const [owner, repo] = slug.split('/');
const ref = arg('ref', 'main');
const name = arg('name', repo);
const subdir = arg('subdir', '');
const dest = path.join(DL_ROOT, name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function resolveSha() {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, sha: json.sha, date: json.commit?.committer?.date ?? '' };
  } catch (e) {
    return { ok: false, note: e.message };
  }
}

async function downloadZip(cachePath) {
  // 依 sha 下载（精确）或依分支下载（宽松）
  const pinned = resolveShaOut;
  const url = pinned.ok
    ? `https://codeload.github.com/${owner}/${repo}/zip/${pinned.sha}`
    : `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${ref}`;
  process.stdout.write(`下载 ${url}\n`);
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`codeload HTTP ${res.status}`);
  const cap = CAP_MB * 1024 * 1024;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const out = fs.createWriteStream(cachePath);
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > cap) {
      out.destroy();
      fs.rmSync(cachePath, { force: true });
      throw new Error(`归档超过上限 ${CAP_MB}MB`);
    }
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return { url, bytes };
}

/** 只解包需要的条目：子目录（若指定）＋ 根目录的许可/说明/清单文件 */
function extract(zipPath, destDir, subdirPrefix) {
  const zip = new AdmZip(zipPath);
  const rootKeeper = /^(licen[cs]e|copying|notice|readme|authors|third[-_]?party|package\.json|pyproject\.toml|cargo\.toml|mod\.json|pet\.json|manifest\.json)(\..*)?$/i;
  let extracted = 0;
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    total++;
    const parts = entry.entryName.split('/');
    const rel = parts.slice(1).join('/'); // 去掉 <repo>-<sha>/ 前缀
    if (!rel) continue;
    const isRootFile = !rel.includes('/') && rootKeeper.test(rel);
    const inSubdir = subdirPrefix ? rel === subdirPrefix || rel.startsWith(`${subdirPrefix}/`) : true;
    if (!isRootFile && !inSubdir) continue;
    const target = path.join(destDir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    extracted++;
  }
  return { extracted, total };
}

fs.mkdirSync(DL_ROOT, { recursive: true });
let resolveShaOut = { ok: false, note: '已按 --no-pin 跳过' };
if (!flag('no-pin')) resolveShaOut = await resolveSha();
if (!resolveShaOut.ok) console.warn(`! 未能解析 commit sha（${resolveShaOut.note}），退回按分支 ${ref} 下载`);

const zipCache = path.join(ENV_ROOT, 'caches', 'zips', `${name}-${resolveShaOut.ok ? resolveShaOut.sha.slice(0, 10) : ref}.zip`);
const { url, bytes } = await downloadZip(zipCache);
const zipSha = sha256(fs.readFileSync(zipCache));

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const { extracted, total } = extract(zipCache, dest, subdir);
if (!flag('keep-zip')) fs.rmSync(zipCache, { force: true });

const meta = {
  repo: `${owner}/${repo}`,
  repoUrl: `https://github.com/${owner}/${repo}`,
  ref,
  commit: resolveShaOut.ok ? resolveShaOut.sha : null,
  commitDate: resolveShaOut.ok ? resolveShaOut.date : null,
  downloadUrl: url,
  zipBytes: bytes,
  zipSha256: zipSha,
  scope: subdir ? `subdir:${subdir} + 根目录许可/说明文件` : '整仓',
  extractedEntries: extracted,
  archiveEntries: total,
  fetchedAt: new Date().toISOString(),
  note: 'codeload zipball（不消耗 API 额度）；zip 已在解包后删除以省磁盘，如需保留加 --keep-zip',
};
fs.writeFileSync(path.join(dest, '.fetch.json'), `${JSON.stringify(meta, null, 2)}\n`);

console.log(`OK  ${meta.repo}@${meta.commit ? meta.commit.slice(0, 10) : ref} → ${path.relative(ROOT, dest)}`);
console.log(`    解包 ${extracted}/${total} 项，归档 ${(bytes / 1048576).toFixed(1)}MB，zip sha256=${zipSha.slice(0, 16)}…，范围=${meta.scope}`);
