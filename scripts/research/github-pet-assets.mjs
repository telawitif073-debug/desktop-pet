#!/usr/bin/env node
/**
 * 阶段 3：美术资源清点（zipball 取源 → 选择性解包 → 逐文件魔数嗅探）
 * ---------------------------------------------------------------------------
 * 取源通道的工程决策（本机实测）：
 *   - github.com 的 443 端口在本机不可达 → `git clone` 不可用（实测 3 次仅 1 次成功）；
 *   - codeload.github.com / raw.githubusercontent.com / api.github.com 可达。
 *   因此不再用 git，改为：
 *     主通道：codeload zipball 整包下载（不消耗 API 额度，且自带完整文件清单），
 *             流式写盘并按字节上限截断，避免超大仓库打满磁盘/带宽；
 *     兜底  ：仓库体积超限时，用 1 次 git/trees API 取完整清单，再从 raw.githubusercontent.com
 *             只拉美术文件（额度 1 次/仓库，可跨小时续采）。
 *
 * 目标：对每个候选仓库回答三个问题
 *   1) 有哪些美术资源（图/音频/模型描述），各自格式、字节数、sha256；
 *   2) 哪些「未加密、可直接解码」，哪些「加密/专有/仅 LFS 指针（不可解码）」；
 *   3) 许可情况（仓库级 LICENSE + 资源目录级许可 + README 中的资源授权声明）。
 *
 * 用法：
 *   node scripts/research/github-pet-assets.mjs [--pool=stars|relevant] [--top=70]
 *        [--concurrency=4] [--cap-mb=500] [--only=a/b,c/d] [--force]
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
const CACHE = path.join(ROOT, '.pet-research');
const RAW = path.join(CACHE, 'raw');
const SCRATCH = process.env.PET_ASSET_SCRATCH || 'E:\\pet-asset-scratch';
const REPOS_DIR = path.join(SCRATCH, 'repos');
const ZIP_DIR = path.join(SCRATCH, 'zips');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const POOL = arg('pool', 'stars');
const TOP = Number(arg('top', '70'));
const CONCURRENCY = Number(arg('concurrency', '4'));
const CAP_MB = Number(arg('cap-mb', '500'));
const CAP_BYTES = CAP_MB * 1024 * 1024;
// 仓库体积超过该阈值时直接走 trees+raw（避免为超大仓库白下几百 MB 再截断）
const ZIP_ONLY_BELOW_MB = Number(arg('zip-only-below-mb', '600'));
// trees+raw 兜底通道的总量上限（控制带宽/磁盘；超限部分记入 notes）
const RAW_CAP_MB = Number(arg('raw-cap-mb', '250'));
const RAW_MAX_FILES = Number(arg('raw-max-files', '4000'));
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const FORCE = argv.includes('--force');
const UA = 'desktop-pet-asset-research/1.0 (local, non-commercial research)';

// 宠物领域相关性（用于 --pool=relevant：只跳过与宠物无关的 pet* 命中，如 petals/petite-vue/petclinic）
// 与 rank-report.mjs 的 PET_DOMAIN_RE 保持同一口径，避免「清点池」与「入选判定」口径不一致。
const PET_RELEVANT_RE = /(desktop[ -]?pet|virtual[ -]?pet|digital[ -]?pet|tamagotchi|shimeji|桌宠|桌面宠物|虚拟宠物|电子宠物|宠物|mascot|pet[ -]?(game|simulator|companion|robot|project|assistant)|pets?\b)/i;
const PET_TOPIC_SET = new Set(['pet', 'pets', 'desktop-pet', 'virtual-pet', 'digital-pet', 'tamagotchi', 'shimeji', 'pet-game', 'virtual-pet-game', 'desktop-pets', 'desktoppet']);

// ---------------------------------------------------------------------------
// 文件分类
// ---------------------------------------------------------------------------
const RASTER_EXT = new Set(['.png', '.gif', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp', '.avif', '.tif', '.tiff', '.ico', '.apng']);
const VECTOR_EXT = new Set(['.svg']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.opus', '.oga']);
const PROPRIETARY_EXT = new Set(['.moc3', '.moc', '.cmo3', '.skel', '.atlas', '.dat', '.bin', '.enc', '.pak', '.unity3d', '.assetbundle', '.bytes', '.pb', '.z']);
const DOC_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.xml', '.plist', '.csv']);
const ART_EXT = new Set([...RASTER_EXT, ...VECTOR_EXT]);
const LICENCE_NAME_RE = /(^|\/)(licen[cs]e|copying|notice|unlicense|authors|third[-_]?party|copyright)(\.[a-z0-9]+)?$/i;
const SKIP_PATH_RE = /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__|\.next|\.nuxt|coverage|\.github)(\/|$)/i;

const KEEP_EXTS = new Set([...ART_EXT, ...AUDIO_EXT, ...PROPRIETARY_EXT, ...DOC_EXT, '.xml', '.plist', '.skel', '.atlas']);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, timeoutMs = 60_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 流式下载 zipball，超上限立即截断；返回字节数或错误标记 */
async function downloadZip(fullName, branch, dstZip) {
  const url = `https://codeload.github.com/${fullName}/zip/refs/heads/${branch}`;
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA }, redirect: 'follow' }, 90_000);
  if (!res.ok) return { ok: false, status: res.status, note: `codeload HTTP ${res.status}` };
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > CAP_BYTES) {
    return { ok: false, status: 413, note: `archive ${(declared / 1048576).toFixed(1)}MB 超过上限 ${CAP_MB}MB` };
  }
  const out = fs.createWriteStream(dstZip);
  let received = 0;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > CAP_BYTES) {
        out.destroy();
        await once(out, 'close').catch(() => {});
        fs.rmSync(dstZip, { force: true });
        return { ok: false, status: 413, note: `archive 超过上限 ${CAP_MB}MB（已截断）` };
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
    fs.rmSync(dstZip, { force: true });
    return { ok: false, status: 0, note: `下载中断：${e.message}` };
  }
  return { ok: true, status: 200, bytes: received };
}

/** 兜底：git/trees API 取完整清单（1 次额度，落盘缓存） */
async function listTreeViaApi(fullName, branch) {
  const cacheFile = path.join(RAW, `tree-${fullName.replace('/', '__')}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const r = await fetchWithTimeout(
    `https://api.github.com/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' } },
    45_000,
  ).catch((e) => ({ ok: false, status: 0, error: e.message }));
  if (!r.ok) return { ok: false, status: r.status ?? 0, error: r.error || `HTTP ${r.status}` };
  const json = await r.json();
  const out = { ok: true, truncated: !!json.truncated, entries: (json.tree ?? []).map((t) => ({ path: t.path, size: t.size ?? 0, type: t.type })) };
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

/** 从 raw.githubusercontent.com 拉单个文件（额度外，用量无限制） */
async function fetchRaw(fullName, branch, relPath, capBytes = 24 * 1024 * 1024) {
  const url = `https://raw.githubusercontent.com/${fullName}/${branch}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA }, redirect: 'follow' }, 45_000);
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > capBytes) return { ok: false, status: 413, note: `单文件 ${(buf.length / 1048576).toFixed(1)}MB 超过上限` };
  return { ok: true, buf };
}

/** 魔数嗅探：返回真实格式与「可解码性」判定 */
function sniff(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { format: 'unreadable', decodable: false, note: String(e.message) };
  }
  const b = buf.subarray(0, 64);
  const hex = b.toString('hex');
  const ascii = buf.subarray(0, 16).toString('latin1');
  const common = { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };

  if (buf.subarray(0, 60).toString('latin1').startsWith('version https://git-lfs.github.com/spec/v1')) {
    return { format: 'lfs-pointer', decodable: false, ...common, note: 'Git LFS 指针（真身在 LFS 对象库，zipball 不含）' };
  }
  if (hex.startsWith('89504e470d0a1a0a')) {
    const isApng = buf.includes(Buffer.from('acTL', 'latin1'));
    return { format: isApng ? 'png/apng' : 'png', decodable: true, ...common, note: isApng ? 'APNG 动图（可逐帧解码）' : 'PNG' };
  }
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { format: 'gif', decodable: true, ...common, note: 'GIF 动图' };
  if (hex.startsWith('ffd8ff')) return { format: 'jpeg', decodable: true, ...common, note: 'JPEG' };
  if (ascii.startsWith('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { format: 'webp', decodable: true, ...common, note: 'WebP（可能为动图）' };
  if (ascii.startsWith('BM')) return { format: 'bmp', decodable: true, ...common, note: 'BMP' };
  if (buf.subarray(4, 12).toString('latin1').startsWith('ftypavif')) return { format: 'avif', decodable: true, ...common, note: 'AVIF' };
  if (buf.subarray(0, 4).toString('latin1') === 'II*\0' || buf.subarray(0, 4).toString('latin1') === 'MM\0*') return { format: 'tiff', decodable: true, ...common, note: 'TIFF' };
  if (/\<svg[\s>]/i.test(buf.subarray(0, 1024).toString('utf-8'))) return { format: 'svg', decodable: true, ...common, note: 'SVG 矢量' };
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3')) return { format: 'mp3', decodable: true, ...common, note: 'MP3' };
  if (ascii.startsWith('OggS')) return { format: 'ogg', decodable: true, ...common, note: 'Ogg' };
  if (ascii.startsWith('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WAVE') return { format: 'wav', decodable: true, ...common, note: 'WAV' };
  if (ascii.startsWith('fLaC')) return { format: 'flac', decodable: true, ...common, note: 'FLAC' };
  if (buf.subarray(0, 4).toString('latin1') === 'MOC3') return { format: 'live2d-moc3', decodable: false, ...common, note: 'Live2D 专有格式（需专有运行库）' };
  if (ascii.startsWith('PK')) return { format: 'zip-container', decodable: false, ...common, note: 'ZIP/压缩容器' };
  if (ascii.startsWith('UnityFS') || ascii.startsWith('UnityWeb')) return { format: 'unity-assetbundle', decodable: false, ...common, note: 'Unity 资源包' };

  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let printable = 0;
  const freq = new Array(256).fill(0);
  for (const byte of sample) {
    if (byte >= 32 && byte < 127) printable++;
    freq[byte]++;
  }
  let entropy = 0;
  for (const f of freq) if (f) {
    const p = f / sample.length;
    entropy -= p * Math.log2(p);
  }
  return { format: 'unknown', decodable: false, ...common, note: `未识别格式（可打印率 ${((printable / sample.length) * 100).toFixed(0)}%，熵 ${entropy.toFixed(2)}）` };
}

function guessLicence(text) {
  const t = text.toLowerCase();
  const hits = [];
  const table = [
    ['CC0-1.0', /(cc0|creative commons zero|public domain dedication)/],
    ['CC-BY-4.0', /(cc[ -]?by[ -]?4|creative commons attribution 4)/],
    ['CC-BY-SA-4.0', /(cc[ -]?by[ -]?sa|share[ -]?alike)/],
    ['CC-BY-NC', /(non[ -]?commercial|cc[ -]?by[ -]?nc)/],
    ['MIT', /(mit license|permission is hereby granted, free of charge)/],
    ['Apache-2.0', /(apache license|apache-2\.0)/],
    ['BSD-3-Clause', /(bsd 3-clause|redistribution and use in source and binary forms)/],
    ['GPL-3.0', /(gnu general public license|gpl-3|gplv3)/],
    ['AGPL-3.0', /(affero general public license|agpl)/],
    ['LGPL-3.0', /(lesser general public license|lgpl)/],
    ['MPL-2.0', /(mozilla public license)/],
    ['Unlicense', /(this is free and unencumbered software released into the public domain)/],
    ['OFL-1.1', /(sil open font license)/],
    ['Proprietary', /(all rights reserved)/],
    ['NoDerivatives', /(no ?derivative|禁止改编|禁止二次创作)/],
    ['NonCommercial', /(非商用|禁止商用|不得用于商业)/],
    ['EducationalOnly', /(仅供学习|仅供交流|学习交流使用|不得用于任何商业)/],
  ];
  for (const [id, re] of table) if (re.test(t)) hits.push(id);
  return hits;
}

const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git') continue;
      walk(full, base, out);
    } else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 单仓库
// ---------------------------------------------------------------------------
async function processRepo(repo) {
  const [owner, name] = repo.fullName.split('/');
  const dst = path.join(REPOS_DIR, `${owner}__${name}`);
  fs.mkdirSync(dst, { recursive: true });
  const out = {
    fullName: repo.fullName,
    stars: repo.stars,
    searchLicense: repo.license || '',
    sizeKb: repo.sizeKb ?? null,
    defaultBranch: repo.defaultBranch || 'main',
    cloneDir: dst,
    source: { kind: '', branch: '', archiveBytes: 0, note: '' },
    clone: { ok: false, reused: false, note: '' },
    filesInArchive: 0,
    filesListed: 0,
    materialised: 0,
    art: { count: 0, bytes: 0, byFormat: {} },
    audio: { count: 0, bytes: 0, byFormat: {} },
    proprietary: { count: 0, byFormat: {} },
    opaque: [],
    artByExt: {},
    artFiles: [],
    licenceFiles: [],
    manifestHints: {},
    notes: [],
  };

  const branch = repo.defaultBranch || 'main';
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const zipPath = path.join(ZIP_DIR, `${owner}__${name}.zip`);

  // --- 取源：优先 zipball（超大仓库直接走 trees+raw，避免白下几百 MB 再截断）---
  let archiveOk = false;
  let usedBranch = branch;
  const repoMb = (repo.sizeKb ?? 0) / 1024;
  let dl = {
    ok: false,
    status: 0,
    note: repoMb > ZIP_ONLY_BELOW_MB ? `仓库体积 ${repoMb.toFixed(0)}MB > ${ZIP_ONLY_BELOW_MB}MB，直接走 trees+raw` : '未尝试 zipball',
  };
  if (repoMb <= ZIP_ONLY_BELOW_MB) {
    try {
      dl = await downloadZip(repo.fullName, branch, zipPath);
    } catch (e) {
      dl = { ok: false, status: 0, note: `zipball 异常：${e.message}` };
    }
    if (!dl.ok && (dl.status === 404 || dl.status === 400)) {
      const alt = branch === 'main' ? 'master' : 'main';
      try {
        const dl2 = await downloadZip(repo.fullName, alt, zipPath);
        if (dl2.ok) {
          dl = dl2;
          usedBranch = alt;
        }
      } catch (e) {
        dl = { ok: false, status: 0, note: `zipball(备用分支) 异常：${e.message}` };
      }
    }
  }

  if (dl.ok) {
    archiveOk = true;
    out.source = { kind: 'zipball', branch: usedBranch, archiveBytes: dl.bytes, note: 'codeload zipball（不消耗 API 额度）' };
    // 选择性解包：只落盘美术/音频/专有/许可/清单类文件
    const allEntries = [];
    try {
      const zip = new AdmZip(zipPath);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const parts = entry.entryName.split('/');
        const rel = parts.slice(1).join('/'); // 去掉 <repo>-<branch>/ 前缀
        if (!rel || SKIP_PATH_RE.test(rel)) continue;
        allEntries.push({ path: rel, size: entry.header.size });
        const ext = path.extname(rel).toLowerCase();
        const base = path.basename(rel).toLowerCase();
        if (!KEEP_EXTS.has(ext) && !LICENCE_NAME_RE.test(rel) && base !== 'license' && base !== 'copying' && !/\.md$/i.test(rel)) continue;
        try {
          const data = entry.getData();
          const target = path.join(dst, rel.split('/').join(path.sep));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
        } catch (e) {
          out.notes.push(`解包失败 ${rel}：${e.message}`);
        }
      }
      out.filesInArchive = allEntries.length;
      fs.writeFileSync(path.join(dst, '.archive-listing.json'), JSON.stringify({ fullName: repo.fullName, branch: usedBranch, entries: allEntries.slice(0, 200_000) }));
    } catch (e) {
      out.notes.push(`zip 解析失败：${e.message}`);
      archiveOk = false;
    }
    fs.rmSync(zipPath, { force: true }); // 归档只是运输载体，解包后删除以控制磁盘
  } else {
    out.notes.push(`zipball 不可用：${dl.note}`);
  }

  // --- 兜底：trees API + raw（仓库过大或 zipball 失败时）---
  if (!archiveOk) {
    try {
      const tree = await listTreeViaApi(repo.fullName, branch);
      if (!tree.ok) {
        out.notes.push(`git/trees API 失败：${tree.error}`);
        out.clone = { ok: false, reused: false, note: `取源失败：zipball(${dl.note})；trees(${tree.error})` };
        return out;
      }
      out.source = { kind: 'trees+raw', branch, archiveBytes: 0, note: `git/trees API 清单（truncated=${tree.truncated}）+ raw 单文件下载` };
      const files = tree.entries.filter((e) => e.type === 'blob' && !SKIP_PATH_RE.test(e.path));
      out.filesListed = files.length;
      const wantedAll = files
        .filter((e) => {
          const ext = path.extname(e.path).toLowerCase();
          const base = path.basename(e.path).toLowerCase();
          return KEEP_EXTS.has(ext) || LICENCE_NAME_RE.test(e.path) || base === 'license' || base === 'copying' || /\.md$/i.test(e.path);
        })
        .sort((a, b) => {
          const ca = PET_RELEVANT_RE.test(a.path) || /(assets?|images?|img|sprites?|characters?|pets?|live2d|model)/i.test(a.path) ? 0 : 1;
          const cb = PET_RELEVANT_RE.test(b.path) || /(assets?|images?|img|sprites?|characters?|pets?|live2d|model)/i.test(b.path) ? 0 : 1;
          return ca - cb || a.path.localeCompare(b.path);
        });
      // 兜底通道总量控制：优先角色美术，达到文件数/字节上限即停止，剩余记入 notes（不静默丢弃）
      const wanted = [];
      let rawBytes = 0;
      let rawSkipped = 0;
      const rawCapBytes = RAW_CAP_MB * 1024 * 1024;
      for (const item of wantedAll) {
        if (wanted.length >= RAW_MAX_FILES || rawBytes + (item.size || 0) > rawCapBytes) {
          rawSkipped++;
          continue;
        }
        rawBytes += item.size || 0;
        wanted.push(item);
      }
      if (rawSkipped) {
        out.notes.push(`trees+raw 兜底达上限（${RAW_MAX_FILES} 文件 / ${RAW_CAP_MB}MB）：跳过 ${rawSkipped} 个候选文件`);
      }
      out.rawWanted = wanted.length;
      out.rawSkipped = rawSkipped;
      let done = 0;
      const workers = Array.from({ length: 6 }, async () => {
        while (done < wanted.length) {
          const item = wanted[done++];
          let r;
          try {
            r = await fetchRaw(repo.fullName, branch, item.path);
          } catch (e) {
            out.notes.push(`raw 异常 ${item.path}：${e.message}`);
            continue;
          }
          if (!r.ok) {
            out.notes.push(`raw 失败 ${item.path}：HTTP ${r.status}`);
            continue;
          }
          const target = path.join(dst, item.path.split('/').join(path.sep));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, r.buf);
        }
      });
      await Promise.all(workers);
      out.filesInArchive = files.length;
      fs.writeFileSync(path.join(dst, '.archive-listing.json'), JSON.stringify({ fullName: repo.fullName, branch, entries: files.slice(0, 200_000) }));
    } catch (e) {
      // 兜底通道自身失败：记录可复核的原因，而不是把异常抛到上层丢掉上下文
      out.notes.push(`trees+raw 兜底异常：${e.message}`);
      out.clone = { ok: false, reused: false, note: `取源失败：zipball(${dl.note})；trees+raw(${e.message})` };
      return out;
    }
  }

  // --- 嗅探已落盘文件 ---
  const files = walk(dst).filter((f) => !f.startsWith('.'));
  out.materialised = files.length;
  out.filesListed = out.filesListed || out.filesInArchive;

  for (const rel of files) {
    if (SKIP_PATH_RE.test(rel)) continue;
    const full = path.join(dst, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const ext = path.extname(rel).toLowerCase();
    const isArt = ART_EXT.has(ext);
    const isAudio = AUDIO_EXT.has(ext);
    const isProp = PROPRIETARY_EXT.has(ext);
    const isDoc = DOC_EXT.has(ext) || LICENCE_NAME_RE.test(rel) || path.basename(rel).toLowerCase() === 'license';
    if (!isArt && !isAudio && !isProp && !isDoc) continue;

    const info = sniff(full);

    if (LICENCE_NAME_RE.test(rel) || /^licen[cs]e/i.test(path.basename(rel))) {
      const head = fs.readFileSync(full).subarray(0, 6000).toString('utf-8');
      out.licenceFiles.push({ path: rel, spdxHints: guessLicence(head), firstLine: head.split('\n').find((l) => l.trim())?.trim().slice(0, 160) ?? '' });
    }

    if (isArt) {
      out.art.count++;
      out.art.bytes += info.size;
      out.art.byFormat[info.format] = (out.art.byFormat[info.format] ?? 0) + 1;
      out.artByExt[ext] = (out.artByExt[ext] ?? 0) + 1;
      if (!info.decodable) out.opaque.push({ path: rel, format: info.format, note: info.note });
      if (out.artFiles.length < 8000) out.artFiles.push({ path: rel, format: info.format, bytes: info.size, sha256: info.sha256, decodable: info.decodable });
    } else if (isAudio) {
      out.audio.count++;
      out.audio.bytes += info.size;
      out.audio.byFormat[info.format] = (out.audio.byFormat[info.format] ?? 0) + 1;
    } else if (isProp) {
      out.proprietary.count++;
      out.proprietary.byFormat[info.format] = (out.proprietary.byFormat[info.format] ?? 0) + 1;
      out.opaque.push({ path: rel, format: info.format, note: `专有/加密容器：${info.note}` });
    }

    if (/readme/i.test(rel) && /\.md$/i.test(rel)) {
      const text = fs.readFileSync(full).subarray(0, 200_000).toString('utf-8');
      const assetMentions = text
        .split(/\n{2,}/)
        .filter((p) => /(asset|sprite|art|素材|美术|立绘|图标|音效|license|licence|版权|授权)/i.test(p) && /(licen|licence|版|授权|CC0|CC[ -]?BY|MIT|All rights|非商用|禁止)/i.test(p))
        .slice(0, 6)
        .map((p) => p.replace(/\s+/g, ' ').trim().slice(0, 300));
      if (assetMentions.length) out.notes.push(...assetMentions.map((m) => `README 资源授权线索：${m}`));
      const hints = guessLicence(text);
      if (hints.length) out.notes.push(`README 许可关键词：${hints.join(', ')}`);
    }
  }

  for (const cand of ['package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py']) {
    const full = path.join(dst, cand);
    if (fs.existsSync(full)) {
      const text = fs.readFileSync(full).subarray(0, 20_000).toString('utf-8');
      const nameMatch = text.match(/"(?:name|productName)"\s*:\s*"([^"]+)"/) || text.match(/^\s*name\s*=\s*"([^"]+)"/m);
      out.manifestHints[cand] = { name: nameMatch?.[1] ?? '', licenceHints: guessLicence(text) };
    }
  }

  out.clone = { ok: true, reused: false, note: `取源成功（${out.source.kind}）` };
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  fs.mkdirSync(RAW, { recursive: true });
  const candFile = path.join(CACHE, 'candidates.json');
  if (!fs.existsSync(candFile)) throw new Error(`缺少 ${candFile}`);
  const cand = JSON.parse(fs.readFileSync(candFile, 'utf-8'));

  let pool = cand.candidates.filter((c) => !c.fork && !c.disabled && !c.archived);
  if (POOL === 'relevant') {
    pool = pool.filter(
      (c) =>
        PET_RELEVANT_RE.test(`${c.name} ${c.description} ${(c.topics || []).join(' ')}`) ||
        (c.topics || []).some((t) => PET_TOPIC_SET.has(String(t).toLowerCase())),
    );
  }
  if (ONLY.length) pool = pool.filter((c) => ONLY.includes(c.fullName));
  else pool = pool.slice(0, TOP);

  const invFile = path.join(CACHE, 'assets-inventory.json');
  const prev = fs.existsSync(invFile) ? JSON.parse(fs.readFileSync(invFile, 'utf-8')) : { repos: [] };
  const prevBy = new Map((prev.repos ?? []).map((r) => [r.fullName, r]));

  const todo = pool.filter((r) => FORCE || !prevBy.get(r.fullName)?.clone?.ok);
  console.log(`清点池：${pool.length}（pool=${POOL}），已完成 ${pool.length - todo.length}，本次处理 ${todo.length}，并发 ${CONCURRENCY}，单包上限 ${CAP_MB}MB`);

  const fresh = [];
  const byName = new Map(prevBy);
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const repo = todo[cursor++];
      const label = `[${cursor}/${todo.length}] ${repo.fullName}`;
      try {
        const rec = await processRepo(repo);
        byName.set(rec.fullName, rec);
        fresh.push(rec);
        console.log(
          `${label} 图 ${rec.art.count}（${(rec.art.bytes / 1048576).toFixed(1)}MB ${Object.entries(rec.art.byFormat).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}）` +
            ` 音 ${rec.audio.count} 专有 ${rec.proprietary.count} 不可解码 ${rec.opaque.length} [${rec.source.kind || '失败'}]`,
        );
      } catch (e) {
        console.error(`${label} 异常：${e.message}`);
        byName.set(repo.fullName, { fullName: repo.fullName, stars: repo.stars, error: String(e.message), clone: { ok: false, note: String(e.message) } });
      }
      // 增量落盘，便于中断后续采
      const snapshot = [...byName.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
      fs.writeFileSync(invFile, JSON.stringify({ generatedAt: new Date().toISOString(), scratch: SCRATCH, method: 'codeload zipball（流式限字节）→ 选择性解包 → 魔数嗅探；超限仓库回退 git/trees API + raw.githubusercontent.com', count: snapshot.length, repos: snapshot }, null, 2));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, todo.length)) }, worker));

  const all = [...byName.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  fs.writeFileSync(invFile, JSON.stringify({ generatedAt: new Date().toISOString(), scratch: SCRATCH, method: 'codeload zipball（流式限字节）→ 选择性解包 → 魔数嗅探；超限仓库回退 git/trees API + raw.githubusercontent.com', count: all.length, repos: all }, null, 2));

  const ok = all.filter((r) => r.clone?.ok);
  const withArt = ok.filter((r) => r.art?.count > 0);
  const withDecodable = ok.filter((r) => (r.artFiles ?? []).some((f) => f.decodable));
  console.log(`\n=== 汇总 ===`);
  console.log(`成功取源 ${ok.length}/${all.length}；含美术 ${withArt.length}；含可解码美术 ${withDecodable.length}`);
  for (const r of [...withArt].sort((a, b) => b.art.count - a.art.count).slice(0, 20)) {
    console.log(`  ${String(r.art.count).padStart(6)} 图 ${(r.art.bytes / 1048576).toFixed(1).padStart(8)}MB ${String(r.audio.count).padStart(4)} 音  ${r.fullName}  ${Object.keys(r.art.byFormat).join(',')}`);
  }
  console.log(`\n产物：${path.relative(ROOT, invFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
