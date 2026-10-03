#!/usr/bin/env node
/**
 * 阶段 6：汇总为人类可读报告（并复制机读产物到 docs/，因为 .pet-research 是 gitignore 的）
 * ---------------------------------------------------------------------------
 * 输入：.pet-research/{ranking.json,ranking.csv,ranking.md,downloads.json,assets-inventory.json,import-report.json}
 * 输出：docs/upstream-pet-assets/report.md ＋ 同名目录下的 ranking.csv / import-report.json 副本
 *
 * 报告必须回答四个问题：
 *   1) 按「星标 + 下载频次」排出来的名次是什么（含指标定义与覆盖度）；
 *   2) 哪些项目入选、哪些被排除、各自理由（许可/相关性/无美术/取源失败）；
 *   3) 取得的素材都去哪了（逐文件利用率账本，必须 100% 覆盖）；
 *   4) 怎么复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.pet-research');
const OUT_DIR = path.join(ROOT, 'docs', 'upstream-pet-assets');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null);

const ranking = read(path.join(CACHE, 'ranking.json'));
if (!ranking) throw new Error('缺少 .pet-research/ranking.json，请先运行 rank-report.mjs');
const downloads = read(path.join(CACHE, 'downloads.json'));
const inventory = read(path.join(CACHE, 'assets-inventory.json'));
const importReport = read(path.join(CACHE, 'import-report.json'));

fs.mkdirSync(OUT_DIR, { recursive: true });
const rows = ranking.rows;
const importedByRepo = new Map((importReport?.projects ?? []).map((p) => [p.fullName, p]));

// --- 排除分类统计 ---
const buckets = {
  '未声明许可（B 层，只登记不复制）': rows.filter((r) => r.petRelevant && r.inventoried && r.licenceTier === 'B'),
  '传染性许可 GPL/AGPL（C 层，不打包）': rows.filter((r) => r.petRelevant && r.inventoried && r.licenceTier === 'C'),
  '资源级受限（D 层，不打包）': rows.filter((r) => r.petRelevant && r.inventoried && r.licenceTier === 'D'),
  '宠物无关（pet 仅为子串）': rows.filter((r) => r.inventoried && !r.petRelevant),
  '宠物相关但无可解码美术': rows.filter((r) => r.petRelevant && r.inventoried && !r.hasDecodableArt),
  '未清点（下载量/资源未采集）': rows.filter((r) => !r.inventoried),
};
// E 层是「放行」而非「排除」，故不进上面的排除桶，单独列在下面
const nonCommercialApproved = rows.filter((r) => r.petRelevant && r.inventoried && r.licenceTier === 'E');

const md = [];
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '—'));

md.push('# GitHub「pet」项目美术资源导入报告', '');
md.push(`生成时间：${new Date().toISOString().slice(0, 10)}｜方法说明见 [../upstream-pet-assets.md](../upstream-pet-assets.md)`, '');

// ---- 1. 结论摘要 ----
md.push('## 1. 结论摘要', '');
const eligible = rows.filter((r) => r.eligible);
const t = importReport?.totals ?? {};
md.push(`- 检索候选：**${fmt(ranking.counts.candidates)}** 个仓库（13 组查询，关键字 \`pet\` 主检索 + 桌宠/虚拟宠物/电子宠物等扩展检索）`);
md.push(`- 资源清点：**${fmt(ranking.counts.inventoried)}** 个仓库已取源并逐文件嗅探，其中含可解码美术 **${fmt(ranking.counts.withDecodableArt)}** 个`);
md.push(`- 宠物语义相关且有可解码美术：**${fmt(ranking.counts.relevantWithArt)}** 个；其中许可可打包（A 层）**${fmt(eligible.length)}** 个`);
md.push(`- 实际导入项目：**${fmt(t.projects ?? 0)}** 个（按综合分名次自上而下逐名下探，只有含「够格宠物本体」的仓库入选；已清点的候选池到此穷尽）`);
md.push(`- 产出内置宠物：**${fmt(t.pets ?? 0)}** 只 / 动作 **${fmt(t.actions ?? 0)}** 个 / 帧 **${fmt(t.frames ?? 0)}** 帧；上游静态资源库 **${fmt(t.library ?? 0)}** 张`);
const nonBody = t['excluded:non-body'] ?? 0;
const caps = (t['excluded:cap-pets'] ?? 0) + (t['excluded:cap-frames'] ?? 0) + (t['excluded:cap-library'] ?? 0);
const inScope = (t.considered ?? 0) - nonBody;
md.push(`- 逐文件处置：扫描到可解码美术 **${fmt(t.considered ?? 0)}** 个 → 按分类标准判为**非宠物本体** ${fmt(nonBody)} 个（**这正是标准的目的：不入包**）、进入「宠物本体」范围 **${fmt(inScope)}** 个`);
md.push(`- 本体范围内：使用 **${fmt(t.used ?? 0)}**（${pct(t.used ?? 0, inScope)}）｜因体量上限未纳入 ${fmt(caps)}（可调参数）｜解码失败 ${fmt(t['excluded:undecodable'] ?? 0)}｜账本未覆盖 **${fmt(t.unaccounted ?? 0)}**（必须为 0）`);
md.push('');

// ---- 2. 指标与口径 ----
md.push('## 2. 指标与筛选口径', '');
md.push(`- 综合分：\`${ranking.metric.combined}\``);
md.push(`- 下载量：${ranking.metric.downloads}`);
md.push(`- 下载量覆盖度：${ranking.metric.downloadsCoverage}`);
md.push(`- 入选条件：${ranking.metric.eligibility}`);
md.push(`- 许可层级分布（全部候选）：${Object.entries(ranking.counts.byTier).map(([k, v]) => `${k}=${v}`).join('、')}`);
md.push('');

// ---- 3. 入选项目（Top 20）----
md.push(`## 3. 入选项目（A 层许可 + 宠物相关 + 含可解码美术，按综合分排序）`, '');
md.push('| # | 项目 | ★ | 下载量 | 综合分 | 许可 | 可解码美术 | 导入宠物 | 动作 | 帧 | 资源库 | 入选依据（相关性） |');
md.push('|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|');
for (const r of eligible.slice(0, importReport?.config?.projects ?? 20)) {
  const p = importedByRepo.get(r.fullName);
  md.push(
    `| ${r.rank} | [${r.fullName}](https://github.com/${r.fullName}) | ${fmt(r.stars)} | ${r.downloadsKnown ? fmt(r.downloads) : '—'} | ${r.combined.toFixed(4)} | ${r.license || '—'} | ${fmt(r.decodableArt)} | ` +
      `${p ? p.pets.length : '—'} | ${p ? p.pets.reduce((s, x) => s + x.actions.length, 0) : '—'} | ${p ? p.pets.reduce((s, x) => s + x.frameCount, 0) : '—'} | ${p ? p.library.length : '—'} | ${r.relevanceReason ?? ''} |`,
  );
}
md.push('');
md.push('> 「入选依据」列是该项目的宠物语义判定理由；许可层级与判定理由（含资源级/根级许可证据）见 `ranking.csv` 与本文第 4 节。');
md.push('> 说明：部分项目本身是 AI 助手/桌面应用，其简介或主题明确包含「desktop pet / 桌宠」并随包分发宠物美术资源，因此按规则入选；');
md.push('> 判定完全基于公开的名称/简介/主题字段，规则见 [../upstream-pet-assets.md](../upstream-pet-assets.md) 第 4 节，可逐条复核。');
md.push('');

// ---- 4. 综合排序 Top 40 ----
md.push('## 4. 综合排序 Top 40（含未入选者与理由）', '');
md.push('| # | 项目 | ★ | 下载量 | 综合分 | 许可 | 层 | 宠物相关 | 可解码美术 | 入选 | 未入选原因 |');
md.push('|---:|---|---:|---:|---:|---|---|:--:|---:|:--:|---|');
for (const r of rows.slice(0, 40)) {
  const reason = r.eligible
    ? ''
    : !r.petRelevant
      ? '宠物无关（pet 仅为子串）'
      : !r.inventoried
        ? '未清点（超出本次取源池）'
        : !r.hasDecodableArt
          ? '无可解码美术（含 LFS 指针/加密格式）'
          : r.licenceTier === 'B'
            ? '未声明许可'
            : r.licenceTier === 'C'
              ? '传染性许可'
              : r.licenceTier === 'D'
                ? '资源级受限声明'
                : '未入选';
  md.push(
    `| ${r.rank} | [${r.fullName}](https://github.com/${r.fullName}) | ${fmt(r.stars)} | ${r.downloadsKnown ? fmt(r.downloads) : '—'} | ${r.combined.toFixed(4)} | ${r.license || '—'} | ${r.licenceTier} | ${r.petRelevant ? '✔' : ''} | ${r.decodableArt ?? '—'} | ${r.eligible ? '✔' : ''} | ${reason} |`,
  );
}
md.push('');

// ---- 5. 排除统计 ----
md.push('## 5. 排除分类统计（已清点范围内）', '');
md.push('| 分类 | 数量 | 代表项目 |');
md.push('|---|---:|---|');
for (const [label, list] of Object.entries(buckets)) {
  const names = list.slice(0, 6).map((r) => r.fullName).join('、') || '—';
  md.push(`| ${label} | ${list.length} | ${names}${list.length > 6 ? ' 等' : ''} |`);
}
md.push('');
md.push('> 未声明许可（B）的项目**不是因为没有价值**，而是不能在 MIT 项目里再分发其美术资源。');
md.push('> 若需使用，请先向作者取得授权，再用同一脚本（`--only=owner/repo --write`）导入。');
md.push('');
if (nonCommercialApproved.length) {
  md.push('### 5.1 「开源非商用」（E 层）已批准项目', '');
  md.push('这些项目**允许开源使用但禁止商用**，属逐仓白名单放行。放行前提是四项硬约束同时成立：');
  md.push('**① 本项目永久非商用；② 逐文件署名原作者；③ 随包附上游许可原文；④ 一旦商业化必须在发布前移除。**');
  md.push('硬约束与决议出处见 [../upstream-pet-assets.md](../upstream-pet-assets.md) §3。');
  md.push('');
  md.push('| 项目 | ★ | 可解码美术 | 放行依据 |');
  md.push('|---|---:|---:|---|');
  for (const r of nonCommercialApproved) {
    md.push(`| [${r.fullName}](https://github.com/${r.fullName}) | ${fmt(r.stars)} | ${r.decodableArt ?? '—'} | ${r.licenceReason ?? ''} |`);
  }
  md.push('');
}

// ---- 5.2 包级门槛：因「没有够格本体」被跳过的名次 ----
const skipped = importReport?.skipped ?? [];
if (skipped.length) {
  md.push('### 5.2 因「没有够格的宠物本体」被跳过的项目（按名次下探）');
  md.push('');
  md.push('分类标准要求资源包内至少有一个**够格本体**：模型（Live2D/3D）、动画（帧序列/动图/视频），');
  md.push('或尺寸 ≥128px 且有 alpha 的静帧。只含界面件/表情包/品牌/文档图/过小图标的项目一律跳过，继续下探名次。');
  md.push('');
  md.push('| 名次 | 项目 | 角色分布 | 抽样（路径 → 角色 → 判定依据） |');
  md.push('|---:|---|---|---|');
  for (const s of skipped.slice(0, 25)) {
    const roles = Object.entries(s.roleStats ?? {}).map(([k, v]) => `${k}×${v}`).join('、') || '—';
    const sample = (s.samples ?? []).slice(0, 2).map((x) => `\`${x.path}\` → ${x.role}（${x.because}）`).join('<br>') || '—';
    md.push(`| ${s.rank ?? '—'} | ${s.fullName} | ${roles} | ${sample} |`);
  }
  md.push('');
}

// ---- 6. 利用率账本 ----
if (importReport) {
  md.push('## 6. 逐文件利用率账本（每个取得的文件恰好一个处置）', '');
  md.push('| 处置 | 数量 | 含义 |');
  md.push('|---|---:|---|');
  const meaning = {
    'used:action': '进入某只宠物的动作帧（已归一化为统一画布）',
    'used:library': '进入上游资源库（可设为形象 / 加为动作）',
    'used:library-vector': 'SVG 矢量素材进入资源库（可预览；栅格化后可作形象/动作）',
    'used:dedup': '与已入库素材内容相同（sha256 去重，内容仍可用）',
    'excluded:non-body': '非宠物本体（界面件/表情包/品牌/文档图等，按分类标准排除）',
    'excluded:policy': '路径策略排除（旧口径，分类标准升级前的记录）',
    'excluded:cap-pets': '超过单仓库宠物数上限',
    'excluded:cap-frames': '超过单仓库动作帧上限',
    'excluded:cap-library': '超过单仓库资源库上限',
    'excluded:undecodable': '解码失败（含 LFS 指针 / 专有格式 / 尺寸不一致）',
    unaccounted: '账本未覆盖（异常，应为 0）',
  };
  for (const [k, v] of Object.entries(importReport.totals)) {
    if (k in meaning) md.push(`| \`${k}\` | ${fmt(v)} | ${meaning[k]} |`);
  }
  md.push('');
  md.push(`> 口径说明：\`excluded:non-body\` 是**分类标准主动排除**的结果（界面件/表情包/品牌/文档图/无法判定），`);
  md.push('> 不是利用率损失——被排除的东西本来就不该进宠物资源包。真正影响覆盖度的是 `excluded:cap-*`（体量上限），');
  md.push('> 它们由 `--max-frames-per-repo` / `--max-pets-per-repo` / `--max-library-per-repo` 控制，按需调大即可纳入更多。');
  md.push('');
  md.push('### 逐项目账本', '');
  md.push('| 项目 | 取得 | 使用 | 排除 | 宠物 | 帧 | 资源库 | 账本覆盖 |');
  md.push('|---|---:|---:|---:|---:|---:|---:|:--:|');
  for (const p of importReport.projects) {
    const l = p.ledger ?? { considered: 0, used: 0, excluded: 0, accounted: false };
    md.push(`| ${p.fullName} | ${l.considered} | ${l.used} | ${l.excluded} | ${p.pets.length} | ${p.pets.reduce((s, x) => s + x.frameCount, 0)} | ${p.library.length} | ${l.accounted ? '✔' : '✘'} |`);
  }
  md.push('');
}

// ---- 7. 复现与合规 ----
md.push('## 7. 复现命令', '');
md.push('```bash');
md.push('node scripts/research/github-pet-rank.mjs --force');
md.push('node scripts/research/github-pet-downloads.mjs --top=60');
md.push('node scripts/research/github-pet-assets.mjs --pool=relevant --top=120 --concurrency=4');
md.push('node scripts/research/rank-report.mjs --top=40');
md.push('python scripts/pets/import_pet_assets.py --dry-run');
md.push('python scripts/pets/import_pet_assets.py --write --projects 20');
md.push('node scripts/pets/write-report.mjs');
md.push('npm test        # 含 src/main/importedPets.spec.ts：真实解析器 + sha256 + 帧尺寸一致性校验');
md.push('npm run package # 打包，验证 extraResource 把资源带进产物');
md.push('node scripts/pets/verify-package.mjs   # 打包产物与源资源逐文件 sha256 比对');
md.push('```');
md.push('');
md.push('## 8. 合规与限制', '');
md.push('- 仅再分发 A 层（宽松许可）项目的美术资源，并在 `resources/builtin-pets/ATTRIBUTION.md` 逐项目标注来源、许可、原始路径与修改方式。');
md.push('- B/C/D 层项目的美术资源**不落盘**，仅在报告中登记（含理由）。');
md.push('- 加密 / 专有 / Git LFS 指针类素材判定为不可解码，不计入导入。');
md.push('- 本机 `github.com:443` 不可达，取源采用 codeload zipball（无 API 额度消耗）；超大仓库回退 trees+raw，个别仓库（如 VPet、Mate-Engine）在本网络下取源失败，已在账本中标记为未清点。');
md.push('- Release 下载量受未认证 API 额度限制，仅对进入清点池的仓库采集；未采集者按 0 计并在 CSV 中标注 `downloadsKnown=false`。');
md.push('');

fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\n'));
for (const f of ['ranking.csv', 'ranking.md', 'import-report.json', 'downloads.json']) {
  const src = path.join(CACHE, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
}

const used = t.used ?? 0;
const considered = t.considered ?? 0;
const unaccounted = t.unaccounted ?? 0;
console.log(`报告已写入：${path.relative(ROOT, path.join(OUT_DIR, 'report.md'))}`);
console.log(`候选 ${ranking.counts.candidates}｜已清点 ${ranking.counts.inventoried}｜相关且有美术 ${ranking.counts.relevantWithArt}｜可打包 ${eligible.length}`);
console.log(`利用率：取得 ${considered} 用 ${used}（${pct(used, considered)}）排除 ${t.excluded ?? 0} 未覆盖 ${unaccounted}`);
console.log(unaccounted === 0 && considered > 0 ? 'LEDGER PASS' : 'LEDGER FAIL');
