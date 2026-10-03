#!/usr/bin/env node
/**
 * 阶段 4：合并「星标/收藏」与「下载频次」→ 综合排序，并给出可用性判定
 * ---------------------------------------------------------------------------
 * 指标定义（全部显式记录，便于复核）：
 *   favourites = stars（GitHub 星标即「收藏」；同时保留 forks 作为次级信号，不参与打分）
 *   downloads  = GitHub Release 资源下载量合计 + npm 月下载量 + PyPI 月下载量
 *                （三源相加；缺失记为 0 并打 downloadsKnown=false，绝不臆造数值）
 *   归一化     = log1p 压缩长尾，再除以本池最大值，映射到 0~1
 *   综合分     = 0.5 × norm(stars) + 0.5 × norm(downloads)   ← 星标与下载量等权
 *   并列打破   = stars 降序 → downloads 降序 → fullName
 *
 * 许可分层（决定「能否把资源打包进本项目」）：
 *   A 可打包：宽松许可（MIT/Apache/BSD/ISC/CC0/CC-BY/CC-BY-SA/MPL/OFL/Unlicense…），
 *             且未被资源级线索降级；
 *   B 未声明：无 LICENSE / NOASSERTION → 只能登记不可复制（默认不打包）；
 *   C 传染性：GPL/AGPL/LGPL → 会污染本 MIT 项目，不打包；
 *   D 受限  ：All rights reserved / 非商用 / 禁止改编 / 仅供学习 → 不打包。
 *   注意：资源级线索（assets/LICENSE、README 授权段落）优先级高于仓库级 LICENSE。
 *
 * 用法：node scripts/research/rank-report.mjs [--top=40] [--eligible-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.pet-research');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const TOP = Number(arg('top', '40'));
const ELIGIBLE_ONLY = argv.includes('--eligible-only');

const PERMISSIVE = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0',
  'CC-BY-4.0', 'CC-BY-3.0', 'CC-BY-SA-4.0', 'MPL-2.0', 'OFL-1.1', 'Zlib', 'WTFPL', 'Python-2.0',
  'BSL-1.0', 'PostgreSQL', 'Artistic-2.0', 'CC-BY-4.0-Intl',
]);
const COPYLEFT = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'GPL-2.0-only', 'GPL-3.0-only', 'AGPL-3.0-only', 'EUPL-1.2']);
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null);

const RESTRICTED_HINTS = ['Proprietary', 'NonCommercial', 'NoDerivatives', 'EducationalOnly'];

/**
 * 宠物领域相关性：用于把「pet 只是子串」的项目（petl / pettingzoo / HotPEToolBox(WinPE) / petit-dom …）
 * 排除在入选之外。判据是「宠物/桌宠」语义，而不是出现字母 p-e-t。
 * 注意 \b 边界：petl、PettingZoo、petit 都不会命中 pets?\b。
 */
// 明确宠物语义短语（不含裸词 pet，避免 knqyf263/pet（命令行片段管理器）这类同名项目混入）
const PET_PHRASE_RE = /(desktop[ -]?pet|virtual[ -]?pet|digital[ -]?pet|pocket[ -]?pet|tamagotchi|shimeji|桌宠|桌面宠物|虚拟宠物|电子宠物|宠物|mascot|pet[ -]?(game|simulator|companion|robot|project|assistant))/i;
// 简介里出现宠物/角色语境（配合「名字里确实是 pet 词元」一起用）
const PET_CONTEXT_RE = /(desktop|screen|virtual|digital|tamagotchi|mascot|character|animat|sprite|cat|dog|companion|friend|robot|宠物|桌宠|卡通|立绘)/i;
// 主题标签白名单：保留 pets，但不含裸词 pet（后者常被非宠物项目当普通标签用）
const PET_TOPIC_SET = new Set(['pets', 'desktop-pet', 'virtual-pet', 'digital-pet', 'tamagotchi', 'shimeji', 'pet-game', 'virtual-pet-game', 'desktop-pets', 'desktoppet']);

function isPetRelevant(cand) {
  const name = String(cand.name ?? '');
  const desc = String(cand.description ?? '');
  const topics = (cand.topics || []).map((t) => String(t).toLowerCase());
  if (PET_PHRASE_RE.test(`${name} ${desc}`)) return { relevant: true, reason: '名称/简介命中宠物语义短语' };
  const topicHit = topics.filter((t) => PET_TOPIC_SET.has(t));
  if (topicHit.length) return { relevant: true, reason: `主题标签命中宠物语义（${topicHit.join(',')}）` };
  const wholeWordPet = /(^|[^a-z0-9])pets?([^a-z0-9]|$)/i.test(name);
  if (wholeWordPet && PET_CONTEXT_RE.test(desc))
    return { relevant: true, reason: '名称含 pet 词元且简介含宠物/角色语境' };
  return { relevant: false, reason: '命中「pet」子串但并非宠物/桌宠项目（按语义排除）' };
}

/**
 * 许可判定（严格版）——只采信「仓库根目录」与「资源目录」两处的许可证据：
 *   - 仓库根 LICENSE/COPYING/LICENSE.md …
 *   - 资源目录内 LICENSE（如 resources/LICENSE、assets/LICENSE）
 *   - 根 README 中的资源授权段落
 * 绝不采信依赖目录里第三方库的 LICENSE（否则会把无许可项目误判为可打包，
 * 或把有 MIT 许可的项目误判为受限），这是本阶段最关键的许可风险点。
 */
function classifyLicence(searchLicence, inventory) {
  const rootHints = new Set();
  const assetHints = new Set();
  const readmeHints = new Set();
  const evidence = { root: [], asset: [], readme: [] };

  const ASSET_LEVEL_RE = /(^|\/)(assets?|images?|img|sprites?|sprite|arts?|artwork|resources?|media|gfx|graphics|characters?|pets?|gallery|illustrations?|textures?|live2d|models?)\//i;
  // 依赖/打包目录里的 LICENSE 属于第三方库，不能作为「本项目资源的许可证据」
  const VENDORED_RE = /(^|\/)(vendor|node_modules|third[_-]?party|lib|libs|deps|bower_components|packages)\//i;
  const artDirs = new Set((inventory?.artFiles ?? []).map((f) => path.posix.dirname(String(f.path))));
  for (const lf of inventory?.licenceFiles ?? []) {
    const rel = String(lf.path);
    const dir = path.posix.dirname(rel);
    const isRoot = !rel.includes('/');
    // 资源级证据必须同时满足：在资源目录内、层级 ≤2、非依赖目录，且该目录/其子目录确实含美术文件
    const depth = dir === '.' ? 0 : dir.split('/').filter(Boolean).length;
    const isAssetLevel =
      ASSET_LEVEL_RE.test(rel) &&
      depth <= 2 &&
      !VENDORED_RE.test(rel) &&
      (artDirs.has(dir) || [...artDirs].some((d) => d.startsWith(`${dir}/`)));
    const target = isRoot ? rootHints : isAssetLevel ? assetHints : null;
    if (!target) continue;
    for (const h of lf.spdxHints ?? []) target.add(h);
    (isRoot ? evidence.root : evidence.asset).push({ path: lf.path, hints: lf.spdxHints });
  }
  for (const note of inventory?.notes ?? []) {
    const m = note.match(/README 许可关键词：(.+)$/);
    if (m) {
      for (const h of m[1].split(',').map((s) => s.trim())) readmeHints.add(h);
      evidence.readme.push(m[1]);
    }
  }

  const all = new Set([...rootHints, ...assetHints, ...readmeHints]);
  const restricted = RESTRICTED_HINTS.filter((h) => all.has(h));
  if (restricted.length)
    return { tier: 'D', reason: `资源级/根级受限线索：${restricted.join(', ')}`, hints: [...all], evidence };

  const spdx = (searchLicence || '').trim();
  if (spdx && PERMISSIVE.has(spdx)) return { tier: 'A', reason: `仓库级宽松许可 ${spdx}`, hints: [...all], evidence };
  if (spdx && COPYLEFT.has(spdx)) return { tier: 'C', reason: `传染性许可 ${spdx}（会污染 MIT 项目）`, hints: [...all], evidence };

  const rootOrAssetPermissive = [...new Set([...rootHints, ...assetHints])].filter((h) => PERMISSIVE.has(h));
  if (rootOrAssetPermissive.length) {
    // 只有在「根目录或资源目录」确有宽松许可文件时才认定 A；依赖目录里的许可证不算
    const where = rootHints.size && rootOrAssetPermissive.some((h) => rootHints.has(h)) ? '根目录' : '资源目录';
    return { tier: 'A', reason: `仓库级未声明，但${where}许可文件为宽松许可：${rootOrAssetPermissive.join(', ')}`, hints: [...all], evidence };
  }
  const rootOrAssetCopyleft = [...new Set([...rootHints, ...assetHints])].filter((h) => COPYLEFT.has(h));
  if (rootOrAssetCopyleft.length)
    return { tier: 'C', reason: `根目录/资源目录为传染性许可：${rootOrAssetCopyleft.join(', ')}`, hints: [...all], evidence };
  if (!spdx || /NOASSERTION|OTHER/i.test(spdx))
    return { tier: 'B', reason: '未声明许可（无根级/资源级 LICENSE 且 API 无 SPDX）', hints: [...all], evidence };
  return { tier: 'B', reason: `无法判定的许可标识：${spdx}`, hints: [...all], evidence };
}

function main() {
  const cand = read(path.join(CACHE, 'candidates.json'));
  const dl = read(path.join(CACHE, 'downloads.json'));
  const inv = read(path.join(CACHE, 'assets-inventory.json'));
  if (!cand) throw new Error('缺少 candidates.json');

  const dlByRepo = new Map((dl?.results ?? []).map((r) => [r.fullName, r]));
  const invByRepo = new Map((inv?.repos ?? []).map((r) => [r.fullName, r]));

  const rows = cand.candidates.map((c) => {
    const d = dlByRepo.get(c.fullName);
    const a = invByRepo.get(c.fullName);
    const releaseDownloads = typeof d?.releases?.downloads === 'number' ? d.releases.downloads : null;
    const npmMonthly = typeof d?.npm?.monthly === 'number' ? d.npm.monthly : null;
    const pypiMonthly = typeof d?.pypi?.monthly === 'number' ? d.pypi.monthly : null;
    const downloads = (releaseDownloads ?? 0) + (npmMonthly ?? 0) + (pypiMonthly ?? 0);
    const downloadsKnown = releaseDownloads !== null || npmMonthly !== null || pypiMonthly !== null;
    const decodableArt = (a?.artFiles ?? []).filter((f) => f.decodable).length;
    const licence = classifyLicence(c.license, a);
    const relevance = isPetRelevant(c, a);
    return {
      fullName: c.fullName,
      stars: c.stars,
      forks: c.forks,
      language: c.language,
      sizeMb: +(c.sizeKb / 1024).toFixed(1),
      license: c.license || '',
      licenceTier: licence.tier,
      licenceReason: licence.reason,
      licenceHints: licence.hints,
      petRelevant: relevance.relevant,
      relevanceReason: relevance.reason,
      inPrimaryKeyword: c.tiers?.includes('primary') ?? false,
      matchedQueries: c.matchedQueries ?? [],
      fork: c.fork,
      archived: c.archived,
      releaseDownloads,
      npmMonthly,
      pypiMonthly,
      downloads,
      downloadsKnown,
      artCount: a?.art?.count ?? null,
      artBytes: a?.art?.bytes ?? null,
      decodableArt: a ? decodableArt : null,
      artFormats: a?.art?.byFormat ?? null,
      audioCount: a?.audio?.count ?? null,
      proprietaryCount: a?.proprietary?.count ?? null,
      inventoried: !!a,
      hasDecodableArt: !!a && decodableArt > 0,
      // 入选条件：宠物领域相关 + 有可解码美术资源 + 许可 A（可打包）
      eligible: !!a && decodableArt > 0 && licence.tier === 'A' && relevance.relevant && !c.fork && !c.archived,
    };
  });

  const maxStars = Math.max(1, ...rows.map((r) => r.stars));
  const maxDownloads = Math.max(1, ...rows.map((r) => r.downloads));
  for (const r of rows) {
    r.starsNorm = Math.log1p(r.stars) / Math.log1p(maxStars);
    r.downloadsNorm = Math.log1p(r.downloads) / Math.log1p(maxDownloads);
    r.combined = +(0.5 * r.starsNorm + 0.5 * r.downloadsNorm).toFixed(6);
  }
  rows.sort((a, b) => b.combined - a.combined || b.stars - a.stars || a.fullName.localeCompare(b.fullName));
  rows.forEach((r, i) => (r.rank = i + 1));

  const eligible = rows.filter((r) => r.eligible);
  eligible.forEach((r, i) => (r.eligibleRank = i + 1));

  const out = {
    generatedAt: new Date().toISOString(),
    metric: {
      favourites: 'GitHub stars',
      downloads: 'GitHub Release asset download_count (paged/cached) + npm last-month + PyPI last-month',
      combined: '0.5 * norm(log1p(stars)) + 0.5 * norm(log1p(downloads)), norm(x)=x/max over this pool',
      maxStars,
      maxDownloads,
      downloadsCoverage: `${rows.filter((r) => r.downloadsKnown).length}/${rows.length} 个候选取得下载量`,
      eligibility: '宠物领域相关（语义判定）且有可解码美术资源（魔数嗅探通过）且许可分层为 A（可打包）',
    },
    counts: {
      candidates: rows.length,
      inventoried: rows.filter((r) => r.inventoried).length,
      petRelevant: rows.filter((r) => r.petRelevant).length,
      withDecodableArt: rows.filter((r) => r.hasDecodableArt).length,
      relevantWithArt: rows.filter((r) => r.petRelevant && r.hasDecodableArt).length,
      eligible: eligible.length,
      byTier: rows.reduce((acc, r) => ((acc[r.licenceTier] = (acc[r.licenceTier] ?? 0) + 1), acc), {}),
    },
    rows,
    eligibleTop: eligible.slice(0, 40).map((r) => ({ rank: r.rank, eligibleRank: r.eligibleRank, fullName: r.fullName, stars: r.stars, downloads: r.downloads, combined: r.combined, license: r.license, decodableArt: r.decodableArt })),
  };
  fs.writeFileSync(path.join(CACHE, 'ranking.json'), JSON.stringify(out, null, 2));

  // CSV（全量，便于外部复核）
  const cols = ['rank', 'fullName', 'stars', 'releaseDownloads', 'npmMonthly', 'pypiMonthly', 'downloads', 'downloadsKnown', 'combined', 'license', 'licenceTier', 'petRelevant', 'inPrimaryKeyword', 'inventoried', 'artCount', 'decodableArt', 'audioCount', 'proprietaryCount', 'eligible', 'sizeMb', 'language'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(path.join(CACHE, 'ranking.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');

  const md = [];
  md.push('# GitHub「pet」项目综合排序（星标 + 下载频次）');
  md.push('');
  md.push(`生成时间：${out.generatedAt}`);
  md.push('');
  md.push(`- 指标：${out.metric.combined}`);
  md.push(`- 下载量来源：${out.metric.downloads}`);
  md.push(`- 下载量覆盖：${out.metric.downloadsCoverage}`);
  md.push(`- 候选总数：${rows.length}；已清点资源：${out.counts.inventoried}；含可解码美术：${out.counts.withDecodableArt}；可打包（A 层）：${eligible.length}`);
  md.push('');
  md.push('| # | 项目 | ★ | 下载量 | 综合分 | 许可 | 层级 | 可解码美术 | 入选 |');
  md.push('|---:|---|---:|---:|---:|---|---|---:|---|');
  for (const r of rows.slice(0, TOP)) {
    md.push(`| ${r.rank} | ${r.fullName} | ${r.stars} | ${r.downloadsKnown ? r.downloads : '—'} | ${r.combined.toFixed(4)} | ${r.license || '—'} | ${r.licenceTier} | ${r.decodableArt ?? '—'} | ${r.eligible ? '✔' : ''} |`);
  }
  md.push('');
  fs.writeFileSync(path.join(CACHE, 'ranking.md'), md.join('\n'));

  // 控制台输出
  console.log(`候选 ${rows.length}｜已清点 ${out.counts.inventoried}｜宠物语义相关 ${out.counts.petRelevant}｜含可解码美术 ${out.counts.withDecodableArt}｜相关且有美术 ${out.counts.relevantWithArt}｜可打包入选 ${eligible.length}`);
  console.log(`许可分层：${Object.entries(out.counts.byTier).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`\n综合排序 Top ${TOP}：`);
  console.log('  #  项目                                      ★      下载量    综合分  许可          层  图(可解码) 入选');
  const list = ELIGIBLE_ONLY ? eligible.slice(0, TOP) : rows.slice(0, TOP);
  for (const r of list) {
    console.log(
      `  ${String(r.eligible ? r.eligibleRank : r.rank).padStart(3)} ${r.fullName.padEnd(40)} ${String(r.stars).padStart(7)} ${String(r.downloadsKnown ? r.downloads : '—').padStart(10)} ` +
        `${r.combined.toFixed(4)} ${(r.license || '—').padEnd(13)} ${r.licenceTier}  ${String(r.decodableArt ?? '—').padStart(6)}   ${r.eligible ? '✔' : ''}`,
    );
  }
  console.log(`\n产物：.pet-research/ranking.{json,csv,md}`);
}

main();
