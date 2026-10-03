#!/usr/bin/env node
/**
 * 阶段 2：为候选项目补充「下载频次」指标
 * ---------------------------------------------------------------------------
 * 三类来源（全部落盘缓存，可复现；失败不抛错，只记 null 并说明）：
 *   1) GitHub Releases 资源下载量：GET /repos/{o}/{r}/releases（core API，未认证 60 次/小时）
 *      —— 主动读取 /rate_limit（该端点不计额度）并在额度耗尽时等待重置，绝不硬撞 403；
 *   2) npm 月下载量：registry.npmjs.org + api.npmjs.org/downloads（无需令牌）
 *      —— 只有当 registry 里该包的 repository 字段确实指向本仓库时才采纳，避免同名误配；
 *   3) PyPI 月下载量：pypi.org + pypistats.org（无需令牌，可能不可达）
 *
 * 用法：
 *   node scripts/research/github-pet-downloads.mjs [--top=60] [--releases-only] [--max-wait-min=70]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.pet-research');
const RAW = path.join(CACHE, 'raw');
const API = 'https://api.github.com';
const UA = 'desktop-pet-asset-research/1.0 (local, non-commercial research)';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const TOP = Number(arg('top', '60'));
const RELEASES_ONLY = argv.includes('--releases-only');
const MAX_WAIT_MIN = Number(arg('max-wait-min', '70'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(RAW, { recursive: true });
}

/** 轻量 JSON 抓取：返回 {ok, json|status}；不抛错（除网络异常） */
async function getJson(url, { headers = {}, timeoutMs = 30_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      signal: ctl.signal,
    });
    if (res.status === 404) return { ok: false, status: 404 };
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 core 额度（/rate_limit 不消耗额度） */
async function coreRate() {
  const r = await getJson(`${API}/rate_limit`);
  if (!r.ok) return null;
  const c = r.json?.resources?.core;
  return c ? { limit: c.limit, remaining: c.remaining, reset: c.reset * 1000 } : null;
}

/** 额度不足时等待到重置（最多 MAX_WAIT_MIN 分钟） */
async function waitForQuota(need = 2) {
  const rate = await coreRate();
  if (!rate) return;
  if (rate.remaining > need) return;
  const waitMs = Math.max(0, rate.reset - Date.now()) + 5000;
  if (waitMs > MAX_WAIT_MIN * 60_000) {
    console.log(`  ! core 额度剩 ${rate.remaining}，重置需等 ${Math.round(waitMs / 60000)} 分钟（超过上限 ${MAX_WAIT_MIN} 分钟），跳过 GitHub Releases 补充`);
    throw new Error('QUOTA_WAIT_TOO_LONG');
  }
  console.log(`  ~ core 额度剩 ${rate.remaining}，等待 ${Math.round(waitMs / 1000)}s 到重置……`);
  await sleep(waitMs);
}

/**
 * 汇总某个仓库所有 release 的资源下载量。
 * 额度经济性：未认证 core 仅 60 次/小时，因此默认只取第 1 页（per_page=100，覆盖绝大多数仓库）；
 * 只有当第 1 页正好满 100 条且当前额度仍宽裕（>15）时才继续翻页，避免为极少数仓库耗尽整小时额度。
 */
async function releaseDownloads(fullName) {
  const cacheFile = path.join(RAW, `releases-${fullName.replace('/', '__')}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  await waitForQuota(2);
  const releases = [];
  let truncated = false;
  for (let page = 1; page <= 3; page++) {
    const r = await getJson(`${API}/repos/${fullName}/releases?per_page=100&page=${page}`);
    if (!r.ok) {
      if (r.status === 403 || r.status === 429) {
        await waitForQuota(2);
        page--; // 重试本页
        continue;
      }
      return { fullName, error: `HTTP ${r.status}`, releases: 0, assets: 0, downloads: 0, fetchedAt: nowIso() };
    }
    const batch = Array.isArray(r.json) ? r.json : [];
    releases.push(...batch);
    if (batch.length < 100) break;
    const rate = await coreRate();
    if (!rate || rate.remaining <= 15) {
      truncated = batch.length === 100;
      break;
    }
  }
  let downloads = 0;
  let assets = 0;
  for (const rel of releases) {
    for (const a of rel.assets ?? []) {
      downloads += Number(a.download_count ?? 0) || 0;
      assets++;
    }
  }
  const out = {
    fullName,
    releases: releases.length,
    assets,
    downloads,
    truncated,
    note: truncated ? 'release 数 ≥100，仅统计第 1 页（额度保护，误差仅影响下载量绝对值）' : '',
    latestTag: releases[0]?.tag_name ?? '',
    latestPublishedAt: releases[0]?.published_at ?? '',
    fetchedAt: nowIso(),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

/** npm 月下载量（仅当 registry 中 repository 指向同一仓库时采纳） */
async function npmDownloads(fullName) {
  const cacheFile = path.join(RAW, `npm-${fullName.replace('/', '__')}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const pkgName = fullName.split('/')[1].toLowerCase();
  const out = { fullName, package: pkgName, monthly: null, weekly: null, verified: false, note: '' };

  const meta = await getJson(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
  if (!meta.ok) {
    out.note = `registry HTTP ${meta.status}`;
  } else {
    const repoUrl = String(meta.json?.repository?.url ?? meta.json?.repository ?? '').toLowerCase();
    const homepage = String(meta.json?.homepage ?? '').toLowerCase();
    const lc = fullName.toLowerCase();
    out.verified = repoUrl.includes(lc) || homepage.includes(lc);
    if (!out.verified) out.note = 'registry 中的 repository 字段与本仓库不匹配，不采纳';
    else {
      const m = await getJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkgName)}`);
      if (m.ok) out.monthly = Number(m.json?.downloads ?? 0) || 0;
      const w = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkgName)}`);
      if (w.ok) out.weekly = Number(w.json?.downloads ?? 0) || 0;
      out.note = 'npm registry 校验通过';
    }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

/** PyPI 月下载量（best effort） */
async function pypiDownloads(fullName) {
  const cacheFile = path.join(RAW, `pypi-${fullName.replace('/', '__')}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const pkgName = fullName.split('/')[1].toLowerCase().replace(/_/g, '-');
  const out = { fullName, package: pkgName, monthly: null, verified: false, note: '' };
  const meta = await getJson(`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`);
  if (!meta.ok) out.note = `pypi HTTP ${meta.status}`;
  else {
    const urls = JSON.stringify(meta.json?.info?.project_urls ?? {}) + String(meta.json?.info?.home_page ?? '');
    out.verified = urls.toLowerCase().includes(fullName.toLowerCase());
    if (!out.verified) out.note = 'pypi 项目链接与本仓库不匹配，不采纳';
    else {
      const st = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(pkgName)}/recent`);
      if (st.ok) out.monthly = Number(st.json?.data?.last_month ?? 0) || 0;
      out.note = 'pypi 校验通过';
    }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  ensureDirs();
  const candFile = path.join(CACHE, 'candidates.json');
  if (!fs.existsSync(candFile)) throw new Error(`缺少 ${candFile}，请先运行 github-pet-rank.mjs`);
  const cand = JSON.parse(fs.readFileSync(candFile, 'utf-8'));
  const pool = cand.candidates.filter((c) => !c.fork && !c.disabled).slice(0, TOP);

  console.log(`候选池：${pool.length} 个（按星标取前 ${TOP}，已排除 fork/disabled）`);
  const results = [];
  let quotaBlocked = false;

  for (const [i, repo] of pool.entries()) {
    const rec = { fullName: repo.fullName, stars: repo.stars, license: repo.license };
    // npm / PyPI 先做（不消耗 GitHub 额度），即使 releases 被额度挡住也能拿到部分下载量
    if (!RELEASES_ONLY) {
      try {
        rec.npm = await npmDownloads(repo.fullName);
      } catch (e) {
        rec.npm = { fullName: repo.fullName, monthly: null, note: `异常 ${e.message}` };
      }
      try {
        rec.pypi = await pypiDownloads(repo.fullName);
      } catch (e) {
        rec.pypi = { fullName: repo.fullName, monthly: null, note: `异常 ${e.message}` };
      }
    }
    if (!quotaBlocked) {
      try {
        rec.releases = await releaseDownloads(repo.fullName);
      } catch (e) {
        if (String(e.message).includes('QUOTA_WAIT_TOO_LONG')) {
          quotaBlocked = true;
          rec.releases = { fullName: repo.fullName, downloads: null, note: 'GitHub core 额度不足且等待超时；可稍后重跑本脚本续采' };
        } else {
          rec.releases = { fullName: repo.fullName, downloads: null, note: `异常 ${e.message}` };
        }
      }
    } else {
      rec.releases = { fullName: repo.fullName, downloads: null, note: '同批次前序仓库触发额度等待上限，未采集' };
    }
    results.push(rec);
    const rel = rec.releases?.downloads;
    console.log(
      `[${i + 1}/${pool.length}] ${repo.fullName.padEnd(40)} ★${String(repo.stars).padStart(7)} ` +
        `rel=${rel === null || rel === undefined ? '—' : rel} npm=${rec.npm?.monthly ?? '—'} pypi=${rec.pypi?.monthly ?? '—'} ` +
        `lic=${repo.license || 'NO-LICENSE'}`,
    );
    if (quotaBlocked) break;
  }

  // 合并既有结果（增量续采）
  const outFile = path.join(CACHE, 'downloads.json');
  let merged = { generatedAt: nowIso(), top: TOP, quotaBlocked, results: [] };
  if (fs.existsSync(outFile)) {
    const prev = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    const byName = new Map(prev.results.map((r) => [r.fullName, r]));
    for (const r of results) byName.set(r.fullName, r);
    merged.results = [...byName.values()];
  } else {
    merged.results = results;
  }
  merged.generatedAt = nowIso();
  merged.quotaBlocked = quotaBlocked;
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));

  const withRel = merged.results.filter((r) => typeof r.releases?.downloads === 'number');
  console.log(`\n=== 汇总 ===`);
  console.log(`已补充下载量：${withRel.length}/${merged.results.length}（quotaBlocked=${quotaBlocked}）`);
  const topRel = [...withRel].sort((a, b) => b.releases.downloads - a.releases.downloads).slice(0, 15);
  for (const r of topRel) console.log(`  rel=${String(r.releases.downloads).padStart(10)}  ★${String(r.stars).padStart(7)}  ${r.fullName}`);
  console.log(`\n产物：${path.relative(ROOT, outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
