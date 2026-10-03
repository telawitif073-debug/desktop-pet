# 宠物视频动作 + 每宠动作上限 + dsh-pet 素材导入（实施方案）

> 状态：待批准（Plan）
> 关联：`.trae/documents/pet-store-successor-design.md`（宠物包商店，§四 第 3~4 步是本方案 Phase 6 的前置）、
> `.trae/documents/pet-domain-rebuild.md`（宠物功能域重建）、`docs/upstream-pet-assets.md`（许可分层与导入管线）
> 目标素材：`PC2005-cloud/dsh-pet`（MIT 代码 / **素材「允许开源使用、禁止商用」**）的 106 段透明 VP9 `.webm` 动画，同一角色，合计 ≈52 MB，规格 **640×360**（P0 实测；早先记的 462×260 来自另一处用例，已更正）

---

## 一、Context（为什么做）

三件事凑到一起，必须一次设计清楚，否则会连环返工：

1. **想导入的动画装不进现有模型**。`dsh-pet` 的 106 段动画属于**同一个角色**，而本项目把「内置宠物」定义为
   「形象 + 动作集」，且动作总量被 `PET_ACTIONS_MAX = 15` 卡死
   （`src/main/config.ts:296`；强制点 `src/main/petActions.ts:47,95`、`src/main/builtinPets.ts:261`）。
   该常量**没有任何工程论据**（无内存/IPC/包体注释），只有产品口径记录在
   `.trae/documents/builtin-demo-pets.md:81,187`（「不改上限」「用户已有 ≥13 个动作时 apply 会失败」）。
2. **帧序列路线已被实测否决**。把 106 段转成现有 `actions/<aid>/frame_NNN.png` 格式，按实测均值
   119.5 KB/帧、512 画布、每动作 16 帧计，需 **≈198–364 MB**，是 webm（52 MB）的 4–7 倍，而当前随包资源
   已有 110.7 MB（`forge.config.ts:16` 的 `extraResource`）。故**改为直接播 webm**。
3. **分类层早就支持视频，只缺渲染与动作层**。`packages/pet-domain/src/resource.ts` 的 `ANIM_EXTS`/`VIDEO_EXTS`
   已含 `.webm` 并归为 `body-animation`；`src/main/petPack.ts:163,192` 已按魔数 `1a45dfa3` 识别视频。
   缺的是：动作模型没有 video 种类、渲染端没有任何 `<video>` 播放能力。

**已定的三项决策**（用户明确选择）：
- 动作上限改为 **每宠上限 + 用户自建动作独立计数**（顺带修掉「用户已有 13 个动作时内置宠装不上」）；
- 动画以 **视频动作（直接播 webm）** 落地；
- 106 段通过 **宠物包（pet pack）走平台商店按需下载**，不随安装包内置。

**预期产出**：桌面端可安装/播放「视频动作」的宠物；动作配额语义清晰且不再互相挤占；
`dsh-pet` 的 106 段动画可作为 pet pack 在商店分发；合规层可追溯。

---

## 二、三个不能省的前置事实（已核实，不是估计）

1. **导入器 `--write` 是全局破坏性的**：`scripts/pets/import_pet_assets.py:339-364` 会删除**所有**
   `provider==='github'` 的宠物目录并 `rmtree` 整个 `pet-asset-library`（只保留 `KEEP_PET_IDS` 的 3 只自产），
   而 `:806-820` 的资源库索引**只按本次运行的项目重建**、`import_pet_assets.py` **没有任何与既有索引的合并逻辑**。
   即：`--write --only PC2005-cloud/dsh-pet` 会清空既有 6 个来源 / 286 张库图。**必须先改成增量合并**。
2. **合规层当前不完整**：许可分层在 `scripts/research/rank-report.mjs:45`（`RESTRICTED_HINTS` 含 `NonCommercial`）
   与 `:115-117`（受限优先 → D）、准入闸门在 `:187`（`eligible = ... && tier==='A'`）；
   `dsh-pet` 的 D 来自 README「素材…禁止商用」（`:220` 正则），`assets-inventory.json` 里已留证
   （`licenceReason: "资源级/根级受限线索：NonCommercial"`）。新增层需要同时改
   `rank-report.mjs` + `import_pet_assets.py:260-279`（许可标识/文案）+ `:823-846`（ATTRIBUTION），
   并**新增「随包附上游许可原文」的复制逻辑（当前完全缺失）**。
3. **测试约束**：`src/main/importedPets.spec.ts:125-144` 强制「同一宠物所有帧尺寸一致」，且要求 `license` 非空。
   视频动作必须绕开「同尺寸」校验，改为校验 webm 魔数 + sha256 一致 + 体积上限。

---

## 三、阶段计划

| 阶段 | 目标 | 关键文件 | 验证 | 回滚点 |
|---|---|---|---|---|
| **P0** ✅ | **去风险 spike**：确认 Electron 44 里透明 VP9 webm 真能出 alpha | 临时 spike 脚本（不入库） | **已通过**，结论见 §六 风险 1 | 无改动，零成本 |
| **P1** | 合规层：新增「开源非商用」层 + 四项硬约束 + 许可原文随包；导入器改**增量合并** | `scripts/research/rank-report.mjs`、`scripts/pets/import_pet_assets.py`、`docs/upstream-pet-assets.md` | `--dry-run` + 前后 sha256 清单比对，证明既有 6 来源/286 张**零变动** | tag + 备份 |
| **P2** ✅ | **每宠动作上限**语义重构（128/15 分账）+ UI 分组、子菜单与提示词裁剪、安装失败不再静默 | 见 §四 P2 | `tsc` 0 错；vitest **306 全绿**（+3 配额用例） | tag `pet-actions-per-pet-cap-done` |
| **P3** | 动作模型支持 `kind:'video'`（共享包 schemaVersion 2→3 + 迁移 + 校验） | `packages/pet-domain/src/actionModel.ts`(+spec)、`src/main/config.ts`、`src/main/importedPets.spec.ts` | vitest：v2→v3 迁移、video 校验、webm 导入用例 | 同 P2 |
| **P4** | 视频文件存储与协议（`petaction://` 支持 Range + `video/webm`） | `src/main.ts`（协议段）、`src/main/petActions.ts`（新 `addVideoAction`）、`src/main/petPack.ts` | 手工：`<video>` 可 seek、大文件流式响应 | 同 P2 |
| **P5** | 渲染端播放视频动作（与帧动作统一接口） | `src/App.tsx`、新增 `src/renderer/videoActionPlayer.ts` | 手工 smoke：播一次/循环/镜像/结束回 idle/不连播 | 同 P2 |
| **P6** | 回到商店主线：step 3 服务端包校验 → step 4 桌面 pack 流程 → 组装并发布 dsh-pet pet pack | 见 `pet-store-successor-design.md` §四 第 3~4 步 + 本方案 P1 的导入器 | 服务端 `evaluatePetPack` 通过、客户端安装后可播、sha256 一致 | 独立阶段，各自 tag |

**推荐顺序**：`P0 →（用户口径的「先提上限」）P2 → P3 → P4 → P5 → P1 → P6`。
P1 与桌面端改动彼此独立，可并行或提前；P6 依赖商店主线 step 3/4。
若 P0 结论为「alpha 拿不到」，则 P3–P5 需改走回退方案（见 §六 风险 1），届时重新评估。

---

## 四、关键实现要点

### P2 · 每宠动作上限（不迁移数据、按 owner 计数）

- **数据形态保持不变**：继续用**同一条扁平 `config.petActions`**，不改成桶。理由是 owner 信息已经在数据里
  （`PetAction.builtinPetId` / `petAssetId`，见 `src/main/config.ts:286-289`），而所有读点都是按数组操作
  （`src/App.tsx:383-385` 全量加载、绑定、清理），分桶会牵动全部读写点并需写迁移。
- **新增常量与纯函数**：`PET_ACTIONS_MAX_USER = 15`（原 `PET_ACTIONS_MAX` 保留为 deprecated 别名指向它）、
  `PET_ACTIONS_MAX_PER_PET = 128`；`ownerKeyOf(a) = a.builtinPetId ?? a.petAssetId ?? '__user__'`；
  `assertActionQuota(actions, incoming)` 按 owner 分别计数。
- **改写 3 个强制点**：`petActions.ts:47`（addFrames）与 `:95`（addClip）改调 `assertActionQuota`；
  `builtinPets.ts:261` 拆成两条不变量（`keep` 的用户动作 ≤ 15；`manifest.actions` 同 owner ≤ 128），
  错误文案带上具体数字与「我的动作 / 该宠物动作」。
- **UI 与文案去字面量**：`ActionsPanel.tsx:24,89` 按 owner 分组（「我的动作 n/15」+「<宠物名> 动作 n/128」）；
  `PetResources.tsx:383`、`PetPublishForm.tsx:148,150` 的计数与 `disabled` 改用**用户动作计数**
  （发布侧 15 是平台约束，保持不变）；`main.ts:1485` 的 E2E 正则放宽为 `/动作（\d+\/\d+）/`。
- **收口三处会被 106 项撑坏的地方**：`main.ts:1277-1291` 右键子菜单改为「先列 feed/rest/play 绑定动作，
  再按 createdAt 截断到 20，末尾「更多动作…」」；`main.ts:168-175` 的 LLM 提示词改为
  「绑定动作全量 + 最近 K=30 个名字 + 等共 N 个」；`src/App.tsx:494-556` 的 `PIXI.Assets` 无淘汰问题
  在本阶段只记录（视频动作不走这条路径，见 P5）。
- **顺带修 bug**：`platformClient.ts:341-375` 不再静默吞错——收集 `failures: {name, reason}[]`，
  `installPetActions` 返回 `{installed, failures}`，调用方弹出「N 个动作未安装」的可读告警
  （现状是第 16 条起抛错被 `:373` 吞掉，安装**静默缩水**）。

### P3 · 视频动作模型

- `packages/pet-domain/src/actionModel.ts`：`PetActionLike.kind` 增加 `'video'` 与 `videoFile?: string`；
  `PetActionSpec` 增加 `kind?: 'frames' | 'clip' | 'video'`（可选，缺省 frames）与 `videoFile?: string`；
  **`ACTION_MODEL_SCHEMA_VERSION` 2→3**，新增 `migrateActionModel(raw)`（v2→v3 只补默认 `kind`），
  `validatePetActionModel` 同时接受 2/3，v3 时校验 video 必须有 `videoFile`。
- **两套表示必须同步**：`src/main/config.ts:280` 的 `PetAction.kind` 与共享包 `PetActionLike.kind` 是两个并行
  定义，同时加 `'video'`，并加一个编译期断言/类型用例钉住二者一致。
- `resource.ts` **不新增角色**：`.webm` 已是 `body-animation`；只在「导入宠物包」路径按扩展名把
  `actions/` 下的 webm 判为 `kind:'video'`。
- `importedPets.spec.ts` 增 video 分支：跳过 PNG IHDR 与「全帧同尺寸」，改校验 webm 魔数、sha256、体积上限。

### P4 · 存储与协议

- 落盘：平台/导入的 webm → `userData/pet-actions/<id>/clip.webm`；内置包保留在
  `resources/builtin-pets/<petId>/actions/<aid>/clip.webm`（与帧同口径，记录绝对路径）。
- `petaction://`（`src/main.ts:1375-1425`）当前用 `net.fetch`，**对本地文件不支持 Range**，
  视频 seek 会失败 → 需解析 `Range` 头并用 `fs.createReadStream(path,{start,end})` 回 206 +
  `Content-Range` + `Accept-Ranges: bytes` + `Content-Type: video/webm`，保留既有白名单前缀校验。

### P5 · 渲染

- **用 DOM `<video>` 而非 PIXI 视频纹理**（PIXI v8 的视频纹理 alpha 不可靠；DOM 合成对 VP9 alpha 原生支持）。
  新增 `src/renderer/videoActionPlayer.ts`，接口与帧路径对齐：
  `play(actionId, { loop, signal, onComplete, mirror })`。
- `src/App.tsx` 的播放分支增加 `action.kind === 'video'`（排在 frames 之前），复用现有
  `removeActionSprite` / `stopActionSprite` / `isNoMirrorAction`（镜像用 CSS `transform: scaleX(-1)`），
  语义与帧一致：播一次 → `onended` 回 idle、`loop` 用 `loop=true`、不连播照旧。
- **决策层 `packages/pet-domain/src/playback.ts` 完全不用改**（它只输出动作名，不关心载体）。

### P6 · 与商店主线的关系

`pet_packs` 的包内 `pet/actions.json` 允许含 `kind:'video'` 动作；服务端包校验（step 3）需把 webm 视为
合法动作载荷（按魔数 `1a45dfa3` 识别，而非依赖扩展名）；体积上限按设计文档 §六 风险 3 一并定。

---

## 五、验证方式

每个阶段都实跑，不接受"应该没问题"：

| 阶段 | 命令 / 动作 |
|---|---|
| P0 | spike 窗口 `capturePage()` 取像素，比对背景色判断 alpha 是否透出（一半小时级） |
| P1 | `python scripts/pets/import_pet_assets.py --dry-run --only PC2005-cloud/dsh-pet`；导入前后对 `resources/**` 做 sha256 清单比对，断言**既有 6 来源 / 286 张零变动**；`npm test` |
| P2 | `npx tsc --noEmit`、`npx vitest run`（改 `builtinPets.spec.ts:185-203`，新增 `petActions` 的 owner/配额用例）；手工：安装内置宠物、删除动作、右键菜单与计数文案 |
| P3 | `npx tsc --noEmit`、`npx vitest run`（v2→v3 迁移、video 校验、webm 导入用例）；`platform/backend` 侧需重跑同步脚本则同步验证 |
| P4 | 手工：`<video>` 拖动 seek、大文件分段响应、协议白名单仍拦截越权路径 |
| P5 | 实机冒烟：播一次 / 循环 / 镜像 / 结束回 idle / 不连播；目视检查 alpha（无黑底/白底） |
| P6 | 服务端 `evaluatePetPack` 对真实 pet pack 判 valid；客户端安装后能播；下载/安装两侧 sha256 一致 |

移动端（`mobile/`）**本方案不改**：它只有 `PetAction='feed'|'play'|'rest'`，无动作模型；
共享包只是新增可选字段与 schema 版本，属纯增量。仅需在改动共享包后重跑
`node scripts/sync-pet-domain.mjs` 并验证后端 `tsc`。

---

## 六、风险与待验证假设

1. ~~**最大不确定项：Electron 44 的 DOM `<video>` 能否保住 VP9 alpha**。P0 先定论。~~
   **【P0 已通过，2026-10-03，Electron 44.1.1 / Chromium 152】**：对 3 个不同片段实测，
   解码层（`canvas.getImageData`）alpha 直方图一致为 `0–31 档 ≈83%`（背景全透）、`224–255 档 ≈16%`（角色实心）、
   中间各档 ≈0.1%（仅边缘抗锯齿）；合成层（不透明洋红底 + `capturePage`）洋红占比 **89.7%**、纯黑 **0.01%**
   → 透明处确实露出背景而非被压成黑底。**主线方案不变，不需要回退**。
   回退顺序（备而不用）：(a) `webPreferences`/启动参数微调；(b) 该 kind 退回"少量动作用 PNG 帧序列"；
   (c) canvas 逐帧 + alpha 掩膜自绘。
   附：真实片段规格为 **640×360**，时长 4.9–10.0 s，单支 194–565 KB。
2. **`petaction://` 的 Range 支持**是 P4 的主要工作量，`net.fetch` 对本地文件不支持 Range，
   必须换成 `createReadStream` 分支，且不能破坏既有白名单校验。
3. `PetFormat`（`src/main/config.ts:272` = `image|pack|live2d|model3d`）是否需新增 `'video'`：
   倾向**不新增**，仍记为 `pack`（目录 + manifest + cover + actions/clip.webm），仅动作层区分 kind。
4. 52 MB 是否全部驻留 `userData`：倾向**按需下载**（由 pet pack 走商店），不在安装时全量落盘。
5. 平台侧的发布上限（`PetPublishForm` 的 15）是否随 pet pack 放宽：本方案**不动**，留待 step 3 决策。
6. `--max-actions-per-pet 8`（导入器默认）需与本方案的新常量对齐，避免"导入器能生成、客户端装不上"。
