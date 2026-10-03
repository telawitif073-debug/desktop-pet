#!/usr/bin/env node
/**
 * 阶段 1：GitHub「pet」项目系统性检索与排序（星标 + 下载频次）
 * ---------------------------------------------------------------------------
 * 产物（默认写入 <repo>/.pet-research/）：
 *   raw/<queryId>-p<N>.json  —— 搜索 API 原始响应（可复现，重跑不重复请求）
 *   candidates.json          —— 去重后的候选项目（含星标/许可/体积/主题等）
 *   harvest-report.json      —— 本次检索的查询清单、速率限制与统计
 *
 * 设计要点：
 *  - 只用 search API（未认证 10 次/分钟），每次 per_page=100，最大化信息/请求比；
 *  - 主检索严格使用关键字 "pet"（GitHub 默认字段 + in:name/description/topics 三种限定），
 *    扩展检索（topic:desktop-pet 等）仅在按名次下探仍不足 20 个可用项目时启用；
 *  - 全部响应落盘缓存，重跑命中缓存不发请求，保证可复现且不滥用 API；
 *  - fork 标记但不参与最终入选（避免与上游重复的美术资源）。
 *
 * 用法：node scripts/research/github-pet-rank.mjs [--force] [--max-search-calls=N]
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
const FORCE = argv.includes('--force');
const maxCallsArg = argv.find((a) => a.startsWith('--max-search-calls='));
const MAX_SEARCH_CALLS = maxCallsArg ? Number(maxCallsArg.split('=')[1]) : 24;

/**
 * 检索矩阵。
 * tier=primary ：严格关键字 "pet"（默认字段 / name / description / topics）
 * tier=extended：同义或相关限定（桌面宠物/虚拟宠物/桌宠等），用于按名次下探补足 20 个
 */
const QUERIES = [
  { id: 'kw-default-p1', q: 'pet', pages: [1], tier: 'primary', note: '关键字 pet（GitHub 默认字段 name/description/readme）' },
  { id: 'kw-default-p2', q: 'pet', pages: [2], tier: 'primary', note: '同上，第 2 页' },
  { id: 'kw-name', q: 'pet in:name', pages: [1, 2], tier: 'primary', note: '仓库名含 pet' },
  { id: 'kw-desc', q: 'pet in:description', pages: [1, 2], tier: 'primary', note: '简介含 pet' },
  { id: 'kw-topic', q: 'pet in:topics', pages: [1], tier: 'primary', note: '主题标签含 pet' },
  { id: 'tp-desktop-pet', q: 'topic:desktop-pet', pages: [1], tier: 'extended', note: '主题 desktop-pet' },
  { id: 'tp-virtual-pet', q: 'topic:virtual-pet', pages: [1], tier: 'extended', note: '主题 virtual-pet' },
  { id: 'tp-shimeji', q: 'topic:shimeji', pages: [1], tier: 'extended', note: '主题 shimeji（桌宠）' },
  { id: 'kw-desktop-pet', q: '"desktop pet"', pages: [1], tier: 'extended', note: '短语 desktop pet' },
  { id: 'kw-virtual-pet', q: '"virtual pet"', pages: [1], tier: 'extended', note: '短语 virtual pet' },
  { id: 'kw-tamagotchi', q: 'tamagotchi', pages: [1], tier: 'extended', note: '电子宠物' },
  { id: 'kw-pet-game', q: 'pet game in:name,description', pages: [1], tier: 'extended', note: '宠物游戏' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let searchCalls = 0;
let budgetStopped = false;

function ensureDirs() {
  fs.mkdirSync(RAW, { recursive: true });
}

async function fetchJson(url, { cacheFile, allowCache = true } = {}) {
  if (allowCache && !FORCE && cacheFile && fs.existsSync(cacheFile)) {
    return { json: JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), cached: true };
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (res.status === 200) {
      const json = await res.json();
      if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(json, null, 2));
      return { json, cached: false };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const waitMs = reset > Date.now() ? Math.min(reset - Date.now() + 2000, 70_000) : 15_000 * attempt;
      console.error(`  ! HTTP ${res.status}（${body.slice(0, 120)}）→ 等待 ${Math.round(waitMs / 1000)}s 后重试`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 200)}`);
  }
  throw new Error(`重试耗尽：${url}`);
}

async function runQuery(spec) {
  const items = [];
  for (const page of spec.pages) {
    if (searchCalls >= MAX_SEARCH_CALLS) {
      budgetStopped = true;
      console.error(`  ! 达到本次 search 调用上限 ${MAX_SEARCH_CALLS}，跳过 ${spec.id} 剩余页`);
      break;
    }
    const q = encodeURIComponent(spec.q);
    const url = `${API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`;
    const cacheFile = path.join(RAW, `${spec.id}-p${page}.json`);
    const { json, cached } = await fetchJson(url, { cacheFile });
    if (!cached) {
      searchCalls++;
      // 未认证 search：10 次/分钟 —— 主动限速，避免触发二级限流
      await sleep(6500);
    }
    const batch = Array.isArray(json.items) ? json.items : [];
    console.log(`  ${spec.id} p${page}${cached ? '（缓存）' : ''}：${batch.length} 条 / 共 ${json.total_count ?? '?'} 条命中`);
    items.push(...batch);
  }
  return items;
}

function normalize(item) {
  return {
    fullName: item.full_name,
    owner: item.owner?.login ?? '',
    name: item.name,
    htmlUrl: item.html_url,
    description: item.description ?? '',
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    watchers: item.watchers_count ?? 0,
    openIssues: item.open_issues_count ?? 0,
    sizeKb: item.size ?? 0,
    language: item.language ?? '',
    license: item.license ? (item.license.spdx_id || item.license.name || '') : '',
    licenseName: item.license?.name ?? '',
    topics: Array.isArray(item.topics) ? item.topics : [],
    fork: !!item.fork,
    archived: !!item.archived,
    disabled: !!item.disabled,
    defaultBranch: item.default_branch ?? '',
    createdAt: item.created_at ?? '',
    pushedAt: item.pushed_at ?? '',
    updatedAt: item.updated_at ?? '',
    homepage: item.homepage ?? '',
  };
}

async function main() {
  ensureDirs();
  const byRepo = new Map();
  const perQuery = [];

  for (const spec of QUERIES) {
    console.log(`\n[${spec.tier}] ${spec.id} :: q=${JSON.stringify(spec.q)} —— ${spec.note}`);
    let items = [];
    try {
      items = await runQuery(spec);
    } catch (e) {
      console.error(`  ! 查询失败：${e.message}`);
      perQuery.push({ id: spec.id, q: spec.q, tier: spec.tier, error: String(e.message), count: 0 });
      continue;
    }
    let added = 0;
    for (const item of items) {
      const rec = normalize(item);
      if (!rec.fullName) continue;
      const prev = byRepo.get(rec.fullName);
      if (prev) {
        prev.matchedQueries = [...new Set([...prev.matchedQueries, spec.id])];
        prev.tiers = [...new Set([...prev.tiers, spec.tier])].sort();
        // 同一仓库多次命中时取较大值（不同响应理论上一致，这里做防御性合并）
        prev.stars = Math.max(prev.stars, rec.stars);
        prev.forks = Math.max(prev.forks, rec.forks);
        if (!prev.license && rec.license) prev.license = rec.license;
      } else {
        byRepo.set(rec.fullName, { ...rec, matchedQueries: [spec.id], tiers: [spec.tier] });
        added++;
      }
    }
    perQuery.push({ id: spec.id, q: spec.q, tier: spec.tier, note: spec.note, count: items.length, newRepos: added });
  }

  const candidates = [...byRepo.values()].sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName));
  const out = {
    generatedAt: new Date().toISOString(),
    keyword: 'pet',
    apiNote: 'GitHub search API, sort=stars, per_page=100；未认证限速 10 次/分钟',
    searchCallsMade: searchCalls,
    searchBudget: MAX_SEARCH_CALLS,
    budgetStopped,
    queries: perQuery,
    totalUniqueRepos: candidates.length,
    candidates,
  };
  fs.writeFileSync(path.join(CACHE, 'candidates.json'), JSON.stringify(out, null, 2));

  const forks = candidates.filter((c) => c.fork).length;
  const withLicense = candidates.filter((c) => c.license).length;
  console.log(`\n=== 汇总 ===`);
  console.log(`唯一仓库：${candidates.length}（fork ${forks}，带许可 ${withLicense}）`);
  console.log(`search 调用：${searchCalls}/${MAX_SEARCH_CALLS}${budgetStopped ? '（已触顶，可重跑继续）' : ''}`);
  console.log(`星标前 15：`);
  for (const c of candidates.slice(0, 15)) {
    console.log(`  ${String(c.stars).padStart(7)} ★  ${c.fullName.padEnd(42)} ${(c.license || 'NO-LICENSE').padEnd(14)} ${String(c.sizeKb).padStart(8)}KB  ${c.language}`);
  }
  console.log(`\n产物：${path.relative(ROOT, path.join(CACHE, 'candidates.json'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
