# 宠物本体资源系统：参考项目分析与重构方案

> 输入：① 任务要求（修正「非宠物本体资源被加进宠物资源包」的缺陷；以
> `https://github.com/PC2005-cloud/dsh-pet/tree/main/dsh-pet` 为参考重构宠物本体资源系统）；
> ② 参考项目源码（已取到 `Environment/downloads/github/dsh-pet/`，MIT，commit 见 `.fetch.json`）；
> ③ 本项目 git 历史（23 次提交）与既有 `.trae` 设计文档。
>
> 范围边界：**仅宠物本体**。不涉及智能体系统、音色/TTS 配置、资源商店页面。

---

## 一、结论摘要

1. **缺陷根因不是「判断写错」，而是「判断能力被删掉了」**：
   `58efaedf` 曾引入语义化资源识别（`platform/backend/src/ai/detect-agent.ts` 184 行 + cutout /
   spritesheet / psd2live / seethrough 管线）；`7aa21190`（"remove AI pet generation"）把
   **整条管线连同检测能力一起删除**。此后安装资源包唯一剩下的识别逻辑是
   `src/main/platformClient.ts` 的**文件名 glob + 「取目录里第一个文件」兜底**：
   `if (!installedPath) installedPath = findFirstFile(installDir, () => true);`
   —— 只有目录为空才报错，因此一个只含 `README.md`/`LICENSE` 的包也会「安装成功」，
   并把非宠物本体的图（图标/背景/截图/表情包）当成宠物形象。
2. **参考项目的做法正好相反且可借鉴**：资源**角色由目录与注册表显式声明**、注册表与文件
   **互相校验**、配置是**唯一事实来源**且**缺失即报错、绝不静默兜底**、动作按**语义分池**
   （待机/转向/拖拽/点击回应/移动/随机分类/事件档位）、播放决策是**纯函数层双端共用**。
3. **重构方向**：建立显式的「宠物本体资源分类标准」（角色枚举 + 判定顺序 + 证据记录 +
   fail-closed），把动作配置标准化为**分池 + 权重 + 参数 + 不变量校验**，把播放控制收敛为
   **纯决策层（触发条件 / 优先级 / 不连播 / 镜像门 / 首尾停顿 / 结束回待机）**。

---

## 二、参考项目 dsh-pet 资源系统分析

### 2.1 资源识别与分类机制（对应任务 2a）

| 机制 | 具体做法 | 对我们的启示 |
| --- | --- | --- |
| **目录即角色** | `assets/webm/`＝动画载荷（唯一可渲染格式）；`assets/preview/`＝同名 GIF 预览（列表/设置页用）；`assets/memes/`＝表情包（对话配图）；`assets/pic/`＝光标与通知图标（**界面件**）；`assets/logo.png`、`assets/fonts/`＝品牌资源 | 分类不能靠扩展名猜测，要**按声明的角色分目录**；界面件/表情包/品牌资源与本体会被天然分开 |
| **注册表 ↔ 文件互校** | `config.jsonc` 的 `memes`：键必须与 `assets/memes/<键>.png` **一一对应**，「文件缺失即该条失效并告警」；动画名必须与 `webm/<名>.webm` 一致 | 资源清单不是装饰，而是**校验契约**；缺文件要**显式报错**而不是忽略 |
| **配置是唯一事实来源** | 「任何字段缺失/写错都会在加载层显式报错（控制台可见），**不做静默兜底**」 | 我们现在的「取第一张图」正是静默兜底的反面教材 |
| **素材根严格作用域** | 文件宠物（`pet/<素材根>-animation/`）**只查自己的目录，绝不回落**到包内共享池 | 防止 A 宠物的资源被 B 宠物误用（跨包污染） |
| **多实例共享 + 标记** | `assetRoot` = 配置条目 key（多实例共享同一素材目录）；`extra: true` 标记文件定义宠物（设置页不可编辑、保存时排除） | 素材归属与实例解耦，避免「一只宠物一份拷贝」 |

### 2.2 动作配置方案（对应任务 2b）

`config.jsonc` 的 `animations` 段是一套**语义化动作池**，每个池的语义写进注释并被菜单/播放两端共用：

- `idle: string[]`、`turn: string[]`、`drag: string[]`、`clicks: string[]` —— 等概率池；
  且**对内容有语义要求**：`turn` 的每一项「必须是播完会翻转朝向的动画」，`drag` 必须是「被无形抓起悬空」的姿势。
- `moves: { default: {minDist,maxDist,margin,leadSec,tailSec}, actions: [{name, params?}] }` ——
  **默认参数 + 逐动作覆盖**；距离以「基准宠物宽 462px」为准、运行时按 `实际size/462` 等比缩放；
  `leadSec/tailSec` = 动画首尾各几秒原地不动（对齐位移与动画时长）。
- `categories: [{id, weight, noMirror?, actions[]}]` —— 随机小动作**按分类加权**；
  `noMirror`（带文字、镜像会颠倒）在 `facing === 'right'` 时整类被排除，**剩余权重自动归一化**。
- `events: Record<string, (string|string[])[]>` —— **档位数组**：索引即档位（`balance` 按用量百分比分档；
  `workStatus` 按会话事件 0..5 档），槽位可以是单名（固定播）或候选数组（档内随机、避免连续重复）；
  并明确「**不进随机链**，只由代码显式触发」「新档只可追加到末尾，否则档位含义错位」。
- `animationWeights: {idle,turn,move}` —— 与各分类 weight **合计恒为 100**，注释里写明当前算式
  （10+5+5+80=100）与 `fixedEnabled` 时 turn/move 按 0 算、份额自然并入随机动作。

**参数与状态的边界很清楚**：池＝可点播集合；weight＝随机链概率；`noMirror`＝状态相关门控；
`events`＝事件驱动、按索引当状态档位；`fixedEnabled`＝状态开关（只影响随机链，不影响用户主动触发）。

### 2.3 动作播放逻辑（对应任务 2c）

- **触发源与优先级**（由配置与菜单结构共同定义）：
  1. 显式点播：右键菜单三级树（`buildMenuTree` 由 `animations` 推导，**唯一事实来源**）与
     `/anim` 接口 → 都走同一个动作处理函数；
  2. 事件动画：`events.<名>[档位]`，只由代码显式触发，不进随机链；
  3. 交互驱动：`clicks`（点按）、`drag`（拖拽悬空）；
  4. 随机链：定时按 `rollKind` 掷骰 → `idle | turn | move | action`。
- **随机链决策是纯函数**：`rollKind(roll, weights, {fixed})` —— `topEnd=(idle+turn+move)/100`，
  余量归 `action`；`fixed` 把 turn/move 权重按 0 算且**不做归一化**（idle 的绝对概率原样保留，
  退化配置也自然）。浏览器与桌面**共用同一个函数**，两端行为严格一致。
- **非连播与档内轮换**：`pick(pool, exclude)` / `pickSlot(slot, exclude)` 优先排除当前动画；
  排除后池空则**退回原池**（"宁可重复，也不要返回 undefined"）。
  `nextWorkStatusAnim(pool, current)`：多候选档位在动画 `ended` 时自动轮换到下一候选（长时间状态不单段重复）。
- **权重抽取**：`pickWeightedCategory(categories, facing)` 过滤 `actions` 为空的分类、按 `noMirror`
  过滤、**对剩余权重归一化**；全部被过滤则退回未过滤集合；无分类则退回 idle 池。
- **守卫在决策层，不在播放层**：`decideAnim` 先校验「名字必须在菜单能点到的集合里」，
  失败返回**显式原因**（`bad-request` / `unknown-pet` / `unknown-animation`），
  因为「播放端名字即文件名，播不存在的动画没有兜底（404 → 点了没反应）」。
- **镜像与文字**：`isNoMirrorAnimation(categories, anim)` —— 朝右（镜像）时点播前强制朝左，避免文字颠倒。

### 2.4 可直接借鉴的工程约定

1. 配置带注释、**显式声明不变量**（权重和 = 100、档位顺序不可插入、素材名必须与文件名一致）。
2. **校验失败即报错**，不静默兜底；失败原因**可枚举、可测试**。
3. **纯决策层 + 双端薄壳**：选择/权重/档位逻辑不依赖 DOM，可离线单测，两端共用同一份源码。
4. 把「允许集合」定义为**菜单可达集合**，一处改动两端同步（并有守卫测试钉住口径）。
5. 语义写进字段名与注释（`noMirror`、`leadSec/tailSec`、`fixedEnabled`），而不是散落在播放代码里。

### 2.5 许可与边界

参考项目为 **MIT**（`LICENSE` 已核验，`Copyright (c) 2026 PC2005-cloud`）。
本次为**设计层面的学习与自研实现**：不拷贝其代码、不引入其美术资源（`assets/webm`、`preview`、
`memes`、`pic`、字体一律不进本项目，仅作为分析对象留在 `Environment/downloads/`）。

---

## 三、本项目「修改前」架构与缺陷取证

### 3.1 历史沿革（commit 证据）

| 提交 | 与资源识别的关系 |
| --- | --- |
| `2619fe89 complete desktop pet platform` | 首次出现 `findFirstFile` 式入口选择（glob 兜底） |
| `2b26c53d add action system, AI pet generation…` | 动作系统诞生（帧序列 + clip），识别仍是 glob |
| `58efaedf add painting/cutout/**detect** agent pipeline` | **引入语义识别**：`detect-agent.ts`(184) + cutout/painting/spritesheet/psd2live/seethrough + `IMAGE_EXTS` |
| `92654b25 rebuild AI pet generation with sprite-sheet and Live2D pipelines` | 重建生成管线，识别仍未回归到安装链路 |
| `7aa21190 add voice interaction stack and **remove AI pet generation**` | **删除整条识别/生成管线**（`platform/backend/src/ai/*`、`src/main/aiGen/*`、`AiPetStudioPanel.tsx`、`GenSettingsPanel.tsx`） |
| `70cd00c3 / mobile…` | 手机端对齐，桌面安装链路未再补分类 |

### 3.2 根因

安装资源包时**没有任何「宠物本体」定义**：`src/main/platformClient.ts` 的
`resolveFormat` + `pickers` 只做文件名 glob，最后以「目录里第一个文件」兜底（`() => true`）。
于是：
- 包内只有图标/背景/截图/README 时，也会「安装成功」，宠物窗显示的是**非本体资源**；
- 包内有本体但命名不叫 `main.*` 时，可能**先命中背景图**（目录序在前的图片）；
- 其余资源类别（预览图 / 表情包 / 界面件 / 品牌 / 文档图）**没有分类**，全部混在同一个平铺目录里，
  既无法校验也无法在 UI 上区分。

### 3.3 缺陷清单（现象 → 代码位置 → 后果）

| # | 缺陷 | 位置 | 后果 |
| --- | --- | --- | --- |
| D1 | 「任意文件」兜底当宠物形象 | `platformClient.ts` 安装分支 `findFirstFile(installDir, () => true)` | 非图片（README/JSON）也能被选为形象 |
| D2 | 图片选择无角色语义 | 同上 `pickers`：`main.*` → `IMAGE_EXTS` | 背景/图标/表情包被当成本体 |
| D3 | 无「必须存在本体」前置校验 | 同上 | 非宠物包可安装成功 |
| D4 | 上传动作不校验本体性 | `petActions.addFramesAction`（仅校验扩展名 ≤30 帧） | 任意图都能变成「宠物动作」 |
| D5 | 资源库无分类标准 | `resources/pet-asset-library` + 我的导入器 `CHARACTER_DIR_RE/NOISE_RE` | 把 PCB 示意图、启动图标、截图当「宠物资源」收进库（上一轮实测可见：`pcb-pcb-dimension`、`schematic-bom`、`ui-graphics-pic-ui`、`presentation/src/main/res/mipmap-*ic_launcher*`、`art/event_detail.png`） |
| D6 | 动作模型无状态/优先级/权重 | `PetAction{kind:'frames'|'clip', interaction, frameRate}` | 只有「帧序列 / 模型 clip」两种形态；无待机/点击/拖拽池、无权重、无档位、无过渡规则 |
| D7 | 无清单↔文件互校 | `builtinPets.parseBuiltinPetManifest` 校验 manifest 结构，但不校验「资源类别」 | 清单里写什么就装什么，无类别白名单 |

---

## 四、重构设计（仅宠物本体范围）

### 4.1 资源分类标准（Task 1 交付物）

新增纯逻辑模块 `src/shared/petResource.ts`，定义**角色枚举 + 判定顺序 + 证据记录 + fail-closed**：

```ts
export type PetResourceRole =
  | 'body-animation'   // 本体动画：帧序列 / 动图 / 视频 —— 可作动作
  | 'body-still'       // 本体静帧：角色单图（抠像立绘） —— 可作形象
  | 'body-model'       // 本体模型：Live2D / 3D —— 走既有形态分支
  | 'body-cover'       // 本体派生：预览/封面（列表用，不当作独立动作）
  | 'ui'               // 界面件：光标、通知图标、按钮
  | 'meme'             // 表情包 / 对话配图
  | 'branding'         // logo / 字体 / 宣传图 / 社交预览
  | 'document'         // 截图 / 示意图 / PCB / 文档插图
  | 'audio'            // 音效 / 语音（非美术本体）
  | 'unknown';         // 无法判定 → 不入包（fail-closed）
```

**判定顺序（首个命中即定性，全部记录证据）**：
1. **显式声明**（manifest/注册表声明角色）——最高信任，但需与磁盘文件互校（存在 + 可选 sha256）。
2. **目录角色**（`pet|body|character|sprite|frames|actions|anims|animations` → 本体；
   `preview|thumbs|covers` → 派生；`memes|stickers` → 表情包；`ui|icons|cursors|notify|chrome` → 界面件；
   `branding|logo|fonts|social` → 品牌；`docs|screenshots|schematics|pcb|hardware` → 文档）。
3. **文件名语义**（`cursor-*`/`notify-*`/`ic_launcher*`/`favicon*`/`logo*`/`banner*`/`screenshot*`/
   `pcb*`/`schematic*`/`bom*`/`dimension*` → 非本体；`cover*`/`preview*` → 派生）。
4. **内容与几何启发式**（需调用方提供探测结果）：帧数 > 1 → 本体动画；alph α 有效 + 边长 ≥ 64
   且宽高比 < 2.5 → 本体静帧；无 alpha 或极端长宽比或 < 48px → 文档/界面件；视频扩展名 → 本体动画。
5. 其余 → `unknown`（**不入包**，记录原因）。

**包级规则（关键修复）**：`evaluatePetPack(entries)` 要求包内**至少 1 个 `body-*`**；
仅有 `body-cover`/`unknown`/非本体者一律 **invalid** 并给出显式原因与逐条证据；
返回选中的本体入口（`body-model` > `body-animation` > `body-still` 优先级），供安装链路直接使用。
判定纯函数、无 IO，文件探测结果由调用方注入（便于单测与在渲染端复用）。

### 4.2 动作配置标准（Task 2b）

新增 `src/shared/petActionModel.ts` + `pet-actions.schema.json`（版本化、可迁移）：

```jsonc
{
  "schemaVersion": 2,
  "pools": {
    "idle":    ["..."],           // 等概率
    "feed":    ["..."], "rest": ["..."], "play": ["..."],  // 互动池（右键喂食/休息/玩耍）
    "clicks":  ["..."],           // 点按回应
    "drag":    ["..."],           // 拖拽悬空
    "moves":   { "default": { "minDist": 60, "maxDist": 240, "margin": 20, "leadSec": 0.4, "tailSec": 0.4 },
                 "actions": [{ "name": "...", "params": { } }] },
    "categories": [{ "id": "小动作", "weight": 20, "noMirror": false, "actions": ["..."] }],
    "events":  { "workStatus": ["..."] }   // 索引 = 档位；不进随机链
  },
  "weights": { "idle": 10, "feed": 0, "rest": 0, "play": 0, "turn": 5, "move": 5 },
  "actions": { "<动作名>": { "frameRate": 8, "loop": false, "holdLeadSec": 0.4, "holdTailSec": 0.4,
                             "interaction": "none|feed|rest|play", "priority": 0, "noMirror": false } }
}
```

**不变量（加载即校验，失败报错不兜底）**：
- `Σweights + Σcategories[].weight === 100`（容差 0）；
- 每个池/分类/事件槽位引用的动作名**必须存在于 `actions` 且帧文件齐备**（清单↔文件互校）；
- `events.*` 为档位数组，槽位类型只允许 `string | string[]`，空串/空数组非法；
- `frameRate ∈ [1,24]`；`interaction` 白名单；`priority` 为非负整数；
- 旧格式（`PetAction[]`）→ 提供 `migrateLegacyActions()`，把 `interaction` 映射为对应互动池，
  其余进 `idle`/`categories`，并保留原 `frameRate`。

### 4.3 播放控制（Task 2c）

新增 `src/shared/petPlayback.ts`（纯函数，双端共用）：

- `rollKind(roll, weights, {fixed})` —— 随机链掷骰；`fixed` 时把 `turn/move` 权重按 0 算、不归一化。
- `pick(pool, exclude)` / `pickSlot(slot, exclude)` —— 非连播，池空退回原池。
- `pickWeightedCategory(categories, facing)` —— `noMirror` 在镜像时过滤 + 剩余权重归一化。
- `resolveTrigger(state, input)` —— **优先级**：显式点播 > 事件 > 交互（clicks/drag）> 随机链；
  给出 `{ kind, action, reason }`，与参考项目一致地返回**显式失败原因**（`unknown-action` 等）。
- `nextEventAnim(pool, current)` —— 长状态档内轮换（`ended` 后换候选）。
- `applyHold(action, params)` —— `leadSec/tailSec` 首尾停顿与位移参数缩放（`size/基准宽`）。
- 播放结束统一**回到 idle 池**（非事件动画）；事件动画结束按 `nextEventAnim` 决定续播或回 idle。

### 4.4 配置与目录规范

- 宠物包目录：`<pack>/pet/body/<action>/frame_*.png`（本体）、`<pack>/pet/cover.png`（派生）、
  `<pack>/pet/actions.json`（§4.2 清单）；非本体资源**不得**出现在 `<pack>/pet/` 下（校验即拒绝）。
- `resources/builtin-pets/<id>/`：manifest 增加 `resourceRoles`（每文件角色）与 `schemaVersion: 2`，
  安装链路按角色取入口（不再 glob）。
- 配置文件更新：`src/main/config.ts` 增加 `petActionModel?`（版本化）、迁移函数与清洗；
  `PetAction` 保留向后兼容（旧字段仍读，写回时升级）。

### 4.5 兼容与边界

- 兼容：既有 `builtin-pets`（3 只自产 + 导入）、旧 `PetAction[]`、`petActionBindings` 语义不变。
- 不碰：智能体（agent/`agentPort`/`conversationManager`）、音色/TTS（`tts*`、`voicePublish`）、
  资源商店页面（`platform` 前端、`ResourceListPage` 等）。
- 导入管线（`scripts/pets/*`）：分类替换为与 `petResource.ts` **同一套口径**（同规则、同角色枚举），
  并对 `resources/pet-asset-library` 做一次重分类清理。

---

## 五、测试与验收

1. **分类器**：表格驱动用例，覆盖真实失败样本（PCB 尺寸图、原理图、`ic_launcher*`、
   `presentation/.../mipmap`、`art/event_detail.png`、`cursor-grab.png`、`notify-done.png`、
   `memes/*.png`、`logo.png`、字体）→ 必须判为**非本体**；真实本体样本（帧序列目录、
   动图、`pet/body/...`、Live2D `model3.json`）→ 必须判为**本体**；歧义样本 → `unknown` 且不入包。
2. **包级规则**：只有图标的包必须 **invalid**；只有封面无本体的包必须 **invalid**；
   本体 + 干扰项混合包必须只选本体为入口。
3. **动作模型**：权重和 ≠ 100、引用不存在的动作、空事件槽位 → 必须**报错**（不是兜底）；
   旧格式迁移后语义等价（互动绑定保留）。
4. **播放决策**：优先级顺序、非连播、`fixed` 权重按 0、`noMirror` 镜像门、档内轮换、
   `unknown-action` 显式失败。
5. **端到端**：`npx tsc --noEmit`、`npm test`、`npm run package` +
   `node scripts/pets/verify-package.mjs`（打包产物与源资源逐文件 sha256 一致）。

---

## 六、实测驱动的标准细化（含反例证据）

第一版内容启发式（「带 alpha 的达标大图即本体」）在真实语料上被证伪。逐仓库打印角色判定后，
拿到下列反例，据此把标准收紧为**两种证据策略**：

| 反例（真实文件） | 第一版误判 | 收紧后的规则 |
| --- | --- | --- |
| `BongoCat/resources/models/*/resources/left-keys/DpadUp.png`（键盘键帽精灵） | body-still | 严格模式：无强本体目录声明的孤立静帧 → unknown |
| `BongoCat/.../demomodel3.1024/texture_00..02.png`（Live2D 贴图集，编号连号） | body-animation（被当成帧序列） | 编号序列需「本体目录」或「透明通道」作为结构性证据 |
| `openpets/apps/desktop/build/appx/LargeTile.png`、`android-chrome-512x512.png`（磁贴/图标） | body-still | 同上；`appx/chrome` 类图标另有文件名/目录标记 |
| `openpets/assets/manage-pets.png`（带透明的营销截图 2322×1562） | body-still | 严格模式：孤立静帧不作本体 |
| `Theatre/art/sample.gif`（91 帧透明**录屏**） | body-animation | 单条动画证据不足 → 仓库级要求「≥2 个够格本体，或有模型」 |
| `Bjorn/resources/images/status/IDLE/IDLE*.bmp`（机器人状态帧，非透明 BMP） | body-animation（`IDLE/` 命中状态目录） | 本体目录分**强标记**（pet/body/sprite/frames/角色…）与**弱标记**（idle/walk/drag…）；弱标记需透明通道补充证据 |
| `TamaFi/Ui Graphics/pic/*`（界面图，编号连号） | body-animation | 目录名归一化（去空格）后 `Ui Graphics` → `uigraphics` 命中界面件目录 |
| `qqpet_automation/.../img_res/commodity/*.gif`、`VPet/.../image/food/*`（商品/喂食物品图标） | body-animation | 新增 `prop` 角色（道具/物品，非本体） |

**结论（写进标准的理由）**：批量抓取第三方仓库时，只能采信**结构性证据**——
清单声明、强本体目录、模型扩展名，或「透明通道」证明的真精灵动画；
不得用「任意带 alpha 的大图」推断本体。用户显式选中的资源包/主动上传仍走宽松策略
（显式意图本身就是证据），两条策略共用同一套判定顺序与常量。

**该轮成果（账本 0 缺口）**：17 个项目 / 53 只宠物 / 161 个动作 / 960 帧 /
289 张本体静态素材；扫描 10082 个可解码美术文件中，按标准判为非本体 5574 个（界面件、
表情包、道具、贴图、品牌、文档图、无法判定）、体量上限未纳入 3143 个、解码失败 8 个。
被排除的名次（如 MerZlin/dsh-pet-indesktop、cifertech/TamaFi、ntd4996/agentpet、
IdreesInc/Pocket-Bird 等）在报告 5.1 节逐条列出角色分布与判定依据。

> **⚠ 事后订正（2026-10-03）**：上述 53 只里**仍有 24 只不是本体**——`ayangweb/BongoCat` 的
> 键盘键帽、qqpet 的登录面板/系统设置/帮助/状态信息/药品、VPet 的 README 截图、MonsterEOS 的
> 前端场景图都被判成了 body-animation。也就是说，本节的「透明通道证明的精灵动画」这一条
> 在当时的标准里**可以单独成立**，从而被界面件稳定利用。真正的修复见第 8 节。

---

## 七、动作配置与播放控制重构（Task 2 落地）

### 7.1 配置标准：`src/shared/petActionModel.ts`（schemaVersion 2）

| 参考项目做法 | 本项目落地 |
| --- | --- |
| 语义化动作池（idle/turn/drag/clicks/moves/categories/events） | 同名同构：`idle` / `interaction{feed,rest,play}` / `clicks` / `drag` / `moves{default,actions[]}` / `categories[{id,weight,noMirror,actions}]` / `events{档位数组}` |
| 权重不变量 Σ=100 | `validatePetActionModel()` 校验 `idle+turn+move+Σcategories === 100`，不满足即报错（附当前合计） |
| 名字即契约、清单↔文件互校 | 池内按**动作名**引用；校验器要求名字唯一、且必须能在 `actions` 定义表中找到；找不到即 `池内引用了未定义的动作：…` |
| 缺失即报错、不静默兜底 | 帧率 1~24、停顿非负、priority 非负整数、interaction 白名单、事件槽位非空——逐条进 `errors[]` |
| 旧配置兼容 | `modelFromActions(actions)` 无损迁移：interaction 归池 → 历史同名约定（吃饭/休息/玩耍）归池并记说明 → clip 进 `modelClips` → 其余进「手动上传」分类（权重复原到 100） |

落盘：`AppConfig.petActionModel?`；`loadConfig` 对已写入的模型**先校验再用**，
失败则丢弃该字段并 `console.error` 列出所有错误（运行期回退到按 `petActions` 现场迁移，
行为与旧配置等价）。测试覆盖 16 个用例，含「迁移产物必须通过校验」这一关键性质。

### 7.2 播放控制：`src/shared/petPlayback.ts`

纯函数决策层（可注入随机源，离线可测），把参考项目的选择逻辑按本项目语义实现：

- **优先级**：显式点播 → 事件档位 → 互动（喂食/休息/玩耍）→ 点击回应 → 拖拽 → 随机链
  （`rollKind` 掷骰 idle/turn/move/action；`fixed` 时 turn/move 权重按 0 算、不归一化）；
- **不连播**：`pickFromPool/pickSlot` 优先排除当前动作，排除后池空则退回原池
  （宁可重复也不返回 undefined —— 避免"点了没反应"）；
- **镜像门控**：`noMirror` 动作/分类在朝右时排除，`pickWeightedCategory` 对剩余权重重新归一化；
- **档位轮换**：`nextEventAnim` 让长时事件的多候选档位播完自动换候选；
- **显式失败原因**：`unknown-action` / `unknown-event` / `tier-out-of-range` / `no-action` / `all-filtered`；
- **参数解析**：`moveParamsFor`（默认+逐动作覆盖）、`holdSecondsFor`（首尾停顿）。

渲染端接入：`App.tsx` 的 `autoPlayAction` 改为调用 `resolveInteractionTrigger`
（**绑定优先** → 标准互动池 → 池内不连播 → 失败时 `console.warn` 记录原因），
保留了"用户显式绑定（petActionBindings）永远优先"的既有语义，同时把过去的
"硬编码 吃饭/休息/玩耍 同名回退"变成**显式的池成员关系**（由迁移规则确定）。测试覆盖 24 个用例。

### 7.3 环境收拢（Task 0）

`Environment/` 下分 `toolchains/`（node_modules、android-sdk、jdk17）、`build/`（out、dist-share）、
`caches/`（.pet-research）、`downloads/`（upstream 批量抓取 + github 参考项目快照）、`logs/`、`tmp/`；
被移动的组件在**原路径保留 junction**，因此 npm/forge/gradle/java 及项目内写死的绝对路径全部继续有效
（详见 `Environment/README.md`）。工作区外部的 3.1GB 抓取目录已迁入。

### 7.4 已知取舍（诚实记录）

1. **严格模式下合格项目已降到 12 个（修复前 17 个）、候选池已穷尽**：更严的标准必然筛掉更多仓库；
   要继续凑数需先扩大清点范围（`github-pet-assets.mjs --pool=relevant --top=250`）。
2. **严格模式暂不接受 SVG 作为本体**：矢量素材难以与矢量图标/logo 可靠区分，
   因此抓取侧不纳入；运行期的矢量资源库通道（`petLibrary.ts` 支持 `.svg` 预览）保持不变。
3. **体量上限仍是主要覆盖度限制**（修复后 1022 个本体范围内文件未纳入，参数可调）。

---

## 八、缺陷修复（2026-10-03）：透明通道不能再单独作证

### 8.1 现象与取证

对已入库的 53 只「宠物」逐只回读 `manifest.origin.coverSource` 与 `actionSources`，发现 24 只的
源路径根本不是角色美术。用当前标准直接分类这些**真实文件**（`scripts/pets/classify_probe.py`），
在 `in_sequence=True, strict=True` 下全部被判成 `body-animation`：

| 源路径 | 实际是什么 | 旧判定 | 新判定 |
| --- | --- | --- | --- |
| `BongoCat/resources/models/keyboard/resources/left-keys/Num0.png` | 键盘键帽精灵（输入层） | body-animation | `ui` |
| `qqpet…/assets/iconList/LoginPanel/l1.gif` | 登录面板图标 | body-animation | `ui` |
| `qqpet…/assets/iconList/OnlineQuitPrompt/Button_exit_00.png` | 退出确认按钮 | body-animation | `ui` |
| `qqpet…/assets/sysSeting/{VolumeBtn,fangxuankuang,guanbi,moren,queding,quxiao,tuodonganniu,xiala}00.png` | 系统设置控件（按钮/下拉/方框/圆框/页签） | body-animation | `ui` |
| `qqpet…/assets/help/{anniu,guanbi}00.png` | 帮助页按钮 | body-animation | `ui` |
| `qqpet…/assets/stateInfo/{dengji,shuaxin,tiexinbaobei}*.png` | 等级/刷新/状态信息图标 | body-animation | `ui` |
| `qqpet…/assets/img_res/medicine/{10001,20001,30001,40001}.gif` | 药品/道具图标 | body-animation | `prop` |
| `VPet/README.assets/ss4.gif` | README 录屏 GIF（375 帧） | body-animation | `document` |
| `VPet/…/Tutorial.assets/CN/ss15.gif` | 教程截图 GIF | body-animation | `document` |
| `MonsterEOS/monstereos/services/frontend/…/arenas/1.png` | 前端场景/竞技场背景 | body-animation | `document` |

**根因（两处）**：

- 第 5 步（帧序列成员）写作 `if not strict or dir_ok or transparent`，第 7 步（无目录声明的动画）
  写作 `if not strict or transparent` —— 两处都让 **strict 模式下的 `transparent` 单独就能放行**。
  键帽/按钮三态/贴图集恰好满足「同目录同前缀 + 尺寸一致 + 天然带 alpha」，于是被稳定地认成
  「帧序列动画」。第 6 节把「透明通道证明的精灵动画」列为结构性证据时，没有意识到它会与
  「编号序列」叠加成一条**无条件的**放行通道。
- 目录词表覆盖不到**复合目录名**：`iconList → iconlist`、`sysSeting → sysseting`、`README.assets →
  readmeassets`、`left-keys → leftkeys`、`img_res → imgres` 都不等于词表里的精确词，于是连
  「界面件目录」这一层都拦不住它们。

两处叠加的结果：界面件既不被目录词拦住，又被透明通道放行。

### 8.2 修复内容

1. **收紧序列规则**（`pet_roles.py` 第 5 步）：strict 下改为 `if not strict or dir_ok` ——
   编号序列必须落在本体目录，或弱状态目录且带透明通道；**透明通道不再能单独成立**。
2. **补齐复合目录名标记**（`NON_BODY_DIR_SUBSTR`，Python ⇄ TS 同表）：
   `readme / tutorial / arenas / iconlist / loginpanel / onlinequitprompt / sysseting / syssetting /
   stateinfo / leftkeys / rightkeys / medicine / imgres`，外加精确词条 `help`。
   之所以需要「子串」而非「精确词」：真实目录名常是复合词（`README.assets`、`Tutorial.assets`、
   `Ui Graphics`、`img_res`、`left-keys`），归一化后与精确词表不相等。
3. **消除孪生分裂**：TS 侧此前缺 `uigraphics/uikit/iconfont`，且**没有做目录名归一化**
   （`Ui Graphics` 在 Python 判 `ui`、在 TS 判 `document`）。已补齐词表并引入与 Python 逐字对应的
   `normDir()`，两处 evidence 也统一回填**原始目录名**便于人工复核。

### 8.3 验证

- **单元测试**：`petResource.spec.ts` 新增 12 个真实失败样本 + 1 组「修复后仍必须保留的真实本体」
  （`pets/` 目录的 oc-claw、`assets/pet/` 的 dafeiyu、VPet 的 `mod/…/pet/…`），共 64 项通过。
- **探针**：`classify_probe.py` 覆盖 20 个真实文件 × `in_sequence∈{False,True}` 共 40 次判定，0 失败。
- **整表重建**：`import_pet_assets.py --clean --write --projects 20`：
  **12 个项目 / 29 只宠物 / 71 个动作 / 636 帧 / 286 张资源库 / 账本未覆盖 0**。
  24 只错误宠物全部消失（残留检查为空），3 只自产演示宠物保留。
- **端到端自审**：`scripts/pets/audit-builtin-pets.py` 回读**每一只已入库宠物** manifest 的
  `origin.coverSource` / `actionSources[].sourcePath`，在与导入器完全相同的上下文（该仓库全部
  可解码美术重建帧序列 + `strict=True`）下重新分类：**100 个源文件 / 0 违例**。
  注意：该自审必须用「整仓」序列上下文；若只喂 manifest 里被引用的那几个文件，
  `active/play/duolaoshu00.png` 这类 28×28 像素画会因脱离序列而落到静帧门槛被判 unknown
  （这正是「序列成员免静帧门槛」这条规则的用途，见 `groupFrameSequences` 的注释）。
- **回归**：`npx tsc --noEmit` 通过；`npm test` 285 项全绿（含 `importedPets.spec.ts` 对
  重建产物做真实解析 + sha256 + 帧尺寸一致性校验）。

### 8.4 取舍（诚实记录）

修复走**精度优先 / fail-closed**，代价是召回下降，已确认并接受：

1. **`readme` 一律当文档**。于是 `legeling/awesome-codex-pet`（角色 GIF 恰好都放在
   `assets/readme/`）整仓落选、`HanaAyane/remielle-codex-pet` 的 `assets/readme/animations/*`
   被排除（该仓仍保留 `gif/*` 的那只宠物）。这是「README 素材不可信」的直接代价。
2. **弱状态目录表未扩张**。`kk43994/kkclaw` 的 `assets/{happy,talking,thinking}/` 与
   `QCYTSN/dsh-dafeiyu` 的 `legacy/dafeiyu/{idle_blink,walk_side,talk,happy,…}/` 因目录词
   不在弱状态表内而被排除（dafeiyu 的新版 `assets/pet/*` 已保留，属**被取代的旧版重复**；
   kkclaw 的 happy/talking/thinking 则是真实召回损失）。
   若要找回，应扩 `WEAK_STATE_DIRS`（配合「透明通道」门槛）；本轮为压低误收风险没有扩表。
3. **BongoCat 整仓落选**：它的可渲染美术只有 Live2D 贴图页 + 键帽精灵，确实没有「够格的独立本体」。
