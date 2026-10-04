#!/usr/bin/env node
/**
 * 组装 dsh-pet 宠物包（本体 GIF + 106 段 webm 视频动作）
 * ===========================================================================
 * 为什么用脚本而不是手工压 zip：包内布局、动作清单（权重不变量）、许可文件
 * 「随包分发」都是硬约束，必须可复现、可复核、可重跑。
 *
 * 包内布局（见 `.trae/documents/pet-store-successor-design.md` §四 第 4 步）：
 *   pet/body.gif                      本体（体态动画的预览 GIF；dsh-pet 无角色立绘）
 *   pet/actions.json                  actionModel schemaVersion 3 快照
 *   pet/actions/<动作名>/clip.webm    106 段透明视频动作（frame_*.png 走的是帧图动作）
 *   LICENSE-UPSTREAM.md               上游许可原文 + 二创署名要求（随包分发，勿删）
 *
 * 许可要点（E 层「开源非商用」，见 docs/upstream-pet-assets.md §3.1）：
 *   - 上游客源代码 MIT，但**素材（动画/提示词/源视频）禁止商用**；
 *   - 二创作品须在任何介绍/展示/分发处署名原作者地址；
 *   - 按既定口径走「宠物包 + 商店按需下载」，**不随安装包内置**；
 *   - 许可标识写 `SourceAvailable-NonCommercial`，**绝不沿用上游代码的 MIT**。
 *
 * 用法：
 *   node scripts/pets/build-dsh-pet-pack.mjs
 *   node scripts/pets/build-dsh-pet-pack.mjs --src <dsh-pet 目录> --out <zip 路径>
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const SRC = path.resolve(argOf('--src') || path.join(ROOT, 'Environment', 'downloads', 'github', 'dsh-pet', 'dsh-pet'));
const OUT = path.resolve(argOf('--out') || path.join(ROOT, 'Environment', 'store-packs', 'dsh-pet.zip'));

const WEBM_DIR = path.join(SRC, 'assets', 'webm');
const BODY_GIF = path.join(SRC, 'assets', 'preview', 'daiji-huxi-xiuxian.gif');
/** 待机动作名（= 本体 GIF 对应的那段 webm） */
const IDLE_NAME = '待机呼吸休闲';
/** 交互归池（按中文名关键词；其余进「手动上传」分类） */
const INTERACTION_RULES = [
  ['feed', /吃|喝|涮火锅|大口|零食|早餐|午餐|晚餐|夜宵/],
  ['rest', /睡|休息|小憩|哈欠|打瞌睡|沉眠|发呆/],
  ['play', /玩|游戏|扑克|魔方|五子棋|三球|跳舞|摇摆|踢毽|陀螺|风筝|烟花|孔明灯|河灯|雪人|福字|礼物|红包|撸猫|镜子|水枪|气球|魔术/],
];
const WEIGHTS = { idle: 10, turn: 5, move: 5 };

/**
 * 包内动作目录名必须与**安装端**的 `actionPayloadDirName()`（packages/pet-domain）同口径。
 * 该函数对「无需转义的名字」返回原名——dsh-pet 的动作名全是中文，属此情形。
 * 这里显式校验这一点：一旦将来出现需要转义的素材名，脚本**直接失败**，
 * 而不是产出一个安装端找不到帧图的包。
 */
function assertDirNameIsIdentity(name) {
  const needsEscape = /[<>:"/\\|?*\u0000-\u001f]/.test(name);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
  const badTail = /[. ]$/.test(name);
  if (!name || needsEscape || reserved || badTail || name.length > 40) {
    throw new Error(
      `动作名「${name}」需要转义，与 actionPayloadDirName() 不再等价；` +
        `请改用共享函数派生目录名后再打包（当前脚本只支持原名即目录名的情形）`,
    );
  }
}

function main() {
  if (!fs.existsSync(WEBM_DIR)) throw new Error(`找不到 webm 目录：${WEBM_DIR}（用 --src 指定 dsh-pet 目录）`);
  if (!fs.existsSync(BODY_GIF)) throw new Error(`找不到本体预览图：${BODY_GIF}`);

  const webms = fs
    .readdirSync(WEBM_DIR)
    .filter((f) => f.toLowerCase().endsWith('.webm'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (!webms.length) throw new Error('webm 目录为空');

  const zip = new AdmZip();
  zip.addFile('pet/body.gif', fs.readFileSync(BODY_GIF));

  const actions = {};
  const manual = [];
  const pools = { feed: [], rest: [], play: [] };
  for (const file of webms) {
    const name = path.basename(file, path.extname(file)).trim();
    assertDirNameIsIdentity(name);
    const rel = `pet/actions/${name}/clip.webm`;
    zip.addFile(rel, fs.readFileSync(path.join(WEBM_DIR, file)));
    const hit = INTERACTION_RULES.find(([, re]) => re.test(name));
    const interaction = name === IDLE_NAME ? 'none' : hit ? hit[0] : 'none';
    actions[name] = {
      ref: name,
      kind: 'video',
      videoFile: rel,
      loop: false,
      holdLeadSec: 0,
      holdTailSec: 0,
      interaction,
      priority: 0,
      noMirror: false,
    };
    if (interaction === 'none') manual.push(name);
    else pools[interaction].push(name);
  }
  if (!actions[IDLE_NAME]) throw new Error(`缺少待机动作「${IDLE_NAME}」`);

  const categories = [];
  const manualWeight = 100 - WEIGHTS.idle - WEIGHTS.turn - WEIGHTS.move;
  if (manual.length) categories.push({ id: '手动上传', weight: manualWeight, actions: manual });
  const model = {
    schemaVersion: 3,
    idle: [IDLE_NAME],
    interaction: pools,
    clicks: [],
    drag: [],
    moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [] },
    categories,
    events: {},
    weights: { ...WEIGHTS },
    actions,
  };
  zip.addFile('pet/actions.json', Buffer.from(`${JSON.stringify(model, null, 2)}\n`, 'utf8'));

  zip.addFile(
    'LICENSE-UPSTREAM.md',
    Buffer.from(
      `# 上游许可原文（随包分发，请勿删除）

- 来源仓库：PC2005-cloud/dsh-pet（https://github.com/PC2005-cloud/dsh-pet）
- 许可分层：E（受限 · 非商用）
- 许可标识：**SourceAvailable-NonCommercial**（上游只对**代码**给 MIT，素材另有条款，不得写作 MIT）

## 上游 README §许可（原文摘录）

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
- **二次创作（二创）约定**：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，
  须附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>

## 分发约束（四项硬约束）

1. 仅限**开源 / 非商用**使用，禁止商用；
2. 二创与分发处须署名原作者地址（https://github.com/PC2005-cloud/dsh-pet）；
3. 本包按「宠物包 + 商店按需下载」分发，**不随桌面端安装包内置**；
4. 本文件随包分发，**不得删除**。

## 本包内容

- 本体：\`pet/body.gif\`（上游 \`assets/preview/daiji-huxi-xiuxian.gif\`）
- 动作：\`pet/actions/<动作名>/clip.webm\` 共 ${webms.length} 段（上游 \`assets/webm/*.webm\`）
- 清单：\`pet/actions.json\`（本项目 actionModel schemaVersion 3）
`,
      'utf8',
    ),
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  zip.writeZip(OUT);
  const size = fs.statSync(OUT).size;
  console.log(
    `[dsh-pet-pack] ${path.relative(ROOT, OUT)}：本体 1 + 动作 ${webms.length}（idle=${model.idle.length} feed=${pools.feed.length} rest=${pools.rest.length} play=${pools.play.length} manual=${manual.length}），` +
      `权重合计 ${WEIGHTS.idle + WEIGHTS.turn + WEIGHTS.move + (categories[0]?.weight ?? 0)}，${(size / 1024 / 1024).toFixed(1)}MB`,
  );
}

main();
