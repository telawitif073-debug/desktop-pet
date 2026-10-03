# 宠物功能域重建（Pet Domain Rebuild）· 分阶段实施方案

> 输入（用户已确认）：
> 1. **替代范围 = 整个宠物功能**（含宠物状态/互动/主动搭话/定时任务/悬浮窗/各渲染形态，
>    以及平台后端 `pets`/`actions` 与商店宠物页）；
> 2. **删除边界 = 全选**：旧代码与配置项、美术资源文件、数据库表与数据、移动端产物与热更包；
> 3. **实施策略 = 分阶段：新模块双跑 → 验证等价 → 再切换删除**。
>
> 前置：当前版本已完整归档到 `https://github.com/telawitif073-debug/desktop-pet`（`main` = `b3e396c7`），
> 因此任何一步都可用 git 历史回滚。**破坏性步骤之前必须再打一个 tag。**

---

## 一、目标与不变量

**目标**：把「宠物」从一个散落在四端、职责交叉的功能，重建成一个**边界清晰、单一事实来源**的功能域，
并让旧实现彻底退场（无遗留组件）。

**必须守住的不变量**（重建过程中逐条验证，不得回退）：
- I1 四维数值（饱腹/心情/精力/好感）规则与体感不变：喂食 +15/+2、玩耍 +20/-10/+5、休息 +30/-5、
  衰减 0.5/0.2/0.1 每 5s、好感只增不减、开关只冻结/锁定 80。
- I2 「只添加宠物本体资源」的分类标准不变（`petResource` 的 12 角色 + fail-closed + 包级至少 1 个本体）。
- I3 动作配置/播放语义不变（权重和 100、优先级、不连播、镜像门、档位轮换）。
- I4 跨端契约不变：云同步键 `pet-state`/`pet_state`、`currentPet={id,name,format}`、
  `LlmProfile.petAssetId`、`petActionBindings`。
- I5 用户可见行为不回归：`npm test`、`npx tsc --noEmit`、以及手工冒烟清单全绿。

---

## 二、现状盘点（重建的对象）

> 完整逐文件清单见本方案附录 A（由代码考古得出，含 IPC/配置/实体/状态/渲染/发布六条链路）。

四端耦合点概览：

| 端 | 宠物域核心文件（节选） | 备注 |
|---|---|---|
| 桌面主进程 | `src/main/petActions.ts`、`petPack.ts`、`petLibrary.ts`、`builtinPets.ts`、`platformClient.ts`(宠物安装)、`wander.ts`、`main.ts`(窗口/IPC 装配) | 输出 `pet:*`、`actions:*`、`builtin:*`、`library:*`、`platform:*` IPC |
| 桌面共享/渲染 | `src/shared/pet{Resource,ActionModel,Playback}.ts`、`src/store/petStore.ts`、`src/App.tsx`(五形态渲染)、`src/renderer/moodLink.ts` | 状态与渲染逻辑集中处 |
| 移动端 | `mobile/src/pet/*`、`petTasks*`、`petProactive*`、`petActiveMessage.ts`、`store/appStore.ts`、`native/OverlayPet*`、`android/.../overlay.html` | 与桌面**重复实现**了四维规则与动作语义 |
| 平台后端 | `pets/*`、`actions/*`、`reviews/*`、`sync/*` | 表：`pet_assets`、`action_assets`、`reviews`、`download_records`、`user_sync_data` |
| 平台前端 | `ResourceListPage/ResourceDetailPage/ProfilePage/WorkshopPage` | 商店宠物页与宠工坊 |
| 资源 | `resources/builtin-pets/*`(32)、`resources/pet-asset-library/*`(286) | 随包 `extraResource` |

**已知的重复/腐化点（重建的主要收益）**：
1. 四维规则在 `src/store/petStore.ts` 与 `mobile/src/store/appStore.ts` **各写一遍**（DRY 违规，易漂移）。
2. 默认值在 `src/main/config.ts` 与 `petStore` 各写一遍（80/80/80/50）。
3. `config.ts` 存在疑似遗留开关 `foodSystemEnabled`（全仓无读取点）。
4. 宠物能力散落在 `src/renderer` 与 `src/main` 两侧，无统一门面。

---

## 三、新模块设计：`src/pet/`

单一入口，对外只暴露一条 import 路径：`import { feed, evaluatePetPack, resolvePlayback } from '../pet'`。

**最终结构（Phase 3 完成后，即当前仓库实况）**：

```
src/pet/
├─ index.ts          统一出口（facade）：只做再导出，不含逻辑
├─ vitals.ts         四维：规则/钳制/默认/序列化/归一化（唯一事实来源，桌面与移动共用）
├─ resource.ts       宠物本体资源识别与包级判定（原 src/shared/petResource.ts）
├─ actionModel.ts    动作配置模型（原 src/shared/petActionModel.ts）
├─ playback.ts       动作播放决策（原 src/shared/petPlayback.ts）
└─ *.spec.ts         对应单测（随实现一起搬迁）
```

两点与初版设计的出入（记录取舍）：
1. 计划里的 `appearance.ts` / `actions.ts` 改名未做——`resource.ts` / `actionModel.ts` / `playback.ts`
   与内部概念一一对应、语义更准，改名只增加 diff 不增价值；门面已提供统一入口，命名不是关键。
2. 计划里的 `ports.ts`（依赖倒置接口）**没有建**——实施下来 IO 天然留在适配层
   （`petPack`/`petActions`/`petStore`/移动端 store），模块内本就无 IO，再抽一层端口属过度设计。

**边界原则**
- 模块内**只放纯逻辑**（无 fs / 无 IPC / 无 React / 无 localStorage）；IO 全部留在适配层。
- 桌面主进程、渲染端、移动端**共用同一份纯逻辑**：移动端经 `mobile/metro.config.js` 的
  `watchFolders: ['../src']` 直接引用（已验证进包，见 Phase 2）。
- 渲染、IPC、存储属于「适配层」，不进入本模块。

---

## 四、分阶段计划

### Phase 0 — 归档与安全网 【已完成】
- 全量提交并推送到 GitHub；**建议**随后 `git tag pet-domain-pre-rebuild`（本方案执行时补打）。
- 退出条件：远端 `main` 与本地一致，工作区干净。

### Phase 1 — 新模块骨架 + 双跑接入 【本次已交付】
- 新建 `src/pet/{vitals,index}.ts` 与 `migration/{vitalsLegacy,dualRunVitals}.ts`。
- `src/store/petStore.ts` 改为走新模块的双跑包装（行为已切到新实现，旧的仍在跑并比对）。
- 新增 `src/pet/vitals.spec.ts`（20 用例）：规则用例 + **全边界矩阵等价性** + **比对器非空跑反证**。
- 退出条件：`npx tsc --noEmit` 0 错；`npm test` 305 全绿；双跑分歧计数 = 0（除已声明的
  `normalizeVitals` 消毒差异）。
- **本阶段不删任何东西。**

### Phase 2 — 调用方逐个改走新模块（仍不删）【已完成 2026-10-03】

实际改动（全部为**等价迁移**，不改行为）：

| 调用点 | 改动 |
|---|---|
| `src/App.tsx` | `./shared/petPlayback` → `./pet`；`hunger < 30` → `HUNGER_ALERT_THRESHOLD`；`stateRef` 初值 `{...DEFAULT_VITALS}` |
| `src/main/petPack.ts` | `../shared/petResource` → `../pet` |
| `src/main/petActions.ts` | 同上 |
| `src/main/config.ts` | `../shared/petActionModel` → `../pet` |
| `src/main/agentProactive.ts` | 三处 `30` → `VITAL_ALERT_THRESHOLD`（新增的通用阈值常量，`HUNGER_ALERT_THRESHOLD` 变为其语义别名） |
| `src/main.ts` | `currentPetState` 初值 → `{...DEFAULT_VITALS}` |
| `src/pet/vitals.ts` | 新增 `AFFECTION_GAIN`（喂食 2 / 玩耍 5 / 聊天 1）常量，替掉调用点的魔法数 |
| **移动端** `mobile/metro.config.js` | 新增 `watchFolders: ['../src']`，让 Metro 能解析 mobile 之外的共享纯逻辑 |
| **移动端** `mobile/src/store/appStore.ts` | 四维运算改用 `src/pet/vitals`（与桌面同一份实现） |

验证（实跑）：
- 桌面：`npx tsc --noEmit` 0 错；`npm test` **305 全绿**。
- 移动：`npx tsc --noEmit -p tsconfig.json` 0 错；
  `react-native bundle`（dev 与 release 各一次）**打包成功**，并在 dev bundle 中核出
  `src/pet/vitals` 路径 11 处、`AFFECTION_GAIN` 6 处、`DEFAULT_VITALS` 7 处 → 共享模块确实进入依赖图；
  反向核对 `vitalsDualRun`/`vitalsLegacy` 命中 **0**（迁移期代码未被打进 RN 包）。
- 全仓复核：`src/pet` 之外已无任何消费者 import 旧路径（除模块自身的 `index.ts` 再导出与三个自测文件）。

**本阶段发现的重要差异（必须记录，不能默默统一）**：
桌面与移动的「功能开关」门控**机制不同**——
- 移动端：开关关闭时对互动**短路**（饱腹/心情/精力都不改，仅好感度继续累积）；
- 桌面端：互动不短路，而由 `App.tsx` 每 5s 的 `resetVitals` 把关闭项锁定回 80。

两者**稳态一致**（关闭期间三项都停在 80），但若把任一端的门控直接换成另一端，会出现
「关闭期间喂食后数值不再归位（移动端）／关闭期间数值被冻结读取（桌面端）」的偏差。
因此本阶段只统一「数学」，**门控策略仍留在各自调用点**；是否统一为同一个策略，是 Phase 3 的决策。
另外移动端为不把迁移期双跑代码打进包体，只从 `pet/vitals` 直接导入（而非模块门面）。

**平台后端：无调用点可迁移**（已核实）。后端 `uploads/upload-validation.ts` 做的是
扩展名/MIME/魔数**文件安全校验**，与「宠物本体分类」是两个不同关注点；
`pets/actions` 也不做本体判定。故 Phase 2 在后端无改动，后端的表结构/配置面已由 Phase 4.0 覆盖。

### Phase 3 — 删除旧实现【已完成 2026-10-03】
回滚点：tag `pet-domain-phase2-done`。按依赖倒序执行：

| # | 动作 | 结果 |
|---|---|---|
| 1 | 删除 `src/pet/migration/**`（`vitalsLegacy.ts` 旧实现冻结副本 + `dualRunVitals.ts` 双跑比对器），并从门面移除 `vitalsDualRun` 导出 | 已删 |
| 2 | `src/store/petStore.ts` 由双跑包装改直连 `src/pet/vitals` 的新实现（行为不变，去掉了比对开销） | 已改 |
| 3 | 用 `git mv` 把三个实现连同单测迁入模块（保留 git 历史）：`shared/petResource.ts→pet/resource.ts`、`shared/petActionModel.ts→pet/actionModel.ts`、`shared/petPlayback.ts→pet/playback.ts`（+ 对应 `.spec.ts`） | 已迁 |
| 4 | 修正模块内相对 import（`playback.ts`→`./actionModel`；三个 spec 的导入；`playback.spec.ts:200` 的内联 `import('./petActionModel')` 类型） | 已改 |
| 5 | 删除无引用配置字段 `foodSystemEnabled`（`config.ts` 接口 + 默认值、`global.d.ts` 镜像、`conversationManager.spec.ts` fixture）；真正的开关是 `petFeatures.feedEnabled` | 已删 |
| 6 | `vitals.spec.ts`：等价性用例随旧实现退场，改为**不变量断言**（全边界矩阵下四维必须落在 [0,100]、好感不衰减、`resetVitals` 幂等），并保留迁移期发现的「损坏数据消毒」加固用例 | 已改 |
| 7 | 同步文档里的旧路径引用（`Environment/README.md`、`docs/upstream-pet-assets.md`；历史设计文档加「路径迁移提示」而非改写留痕） | 已改 |

验证（实跑）：
- `npx tsc --noEmit`：0 错（tsc 期间抓出 `playback.spec.ts` 的一处内联 `import('./petActionModel')` 类型残留——vitest 因 esbuild 剥离类型而没报，说明**类型检查不能只靠测试**）。
- `npm test`：**303 项全绿**（305 → 303：移除双跑/等价性用例 2 项净减；`vitals.spec` 由 20 → 18）。
- 移动端 `npx tsc --noEmit -p tsconfig.json`：0 错；`react-native bundle` 打包成功（跨项目共享未受影响）。
- 全仓复核：`vitalsLegacy` / `dualRunVitals` / `vitalsDualRun` / `foodSystemEnabled` / 旧 `shared/pet*` 导入 **全部 0 命中**。

**仍未做（属 Phase 5/6）**：`mobile/metro.config.js` 之外的构建配置同步、`src/assets/pet.png` 等旧演示资源、
`resources/` 随包资源、`scripts/pets/*` 资源流水线、以及历史设计文档的整体归档。

### Phase 4 — 平台与数据库（不可逆，需独立审批 + 备份）

#### 4.0 前置加固【已完成 2026-10-03】
把「删实体 = 静默 DROP TABLE」这颗雷先拆掉，再谈删表：

1. **全量备份 + 恢复演练**：`pg_dump` 自定义格式 + 纯文本各一份，落在
   `Environment/build/backups/`（不入库，恢复步骤见同目录 `RESTORE.md`）。
   已**实际恢复到临时库**校验：表数 12/12、`user_sync_data` 行数 13→13 一致。
2. **显式 migration 基础设施**（新增）：
   - `platform/backend/src/data-source.ts`：应用与 TypeORM CLI **共用的唯一 DB 配置事实来源**
     （此前 host/port/database 默认值在 `app.module.ts` 一处写死、无 CLI 可用配置）。
   - `platform/backend/src/migrations/1791030967094-InitSchema.ts`：基线 migration，
     在空库上可完整重建 10 张实体表（已验证：列结构、FK/UNIQUE 约束 12/12、索引全部一致）。
   - `app.module.ts`：`synchronize: true` → **永久关闭**，改 `migrationsRun: true`
     （启动自动执行未落库的 migration）。
   - `package.json` 新增 `migration:generate|run|revert|show` 四个脚本。
   - 既有库已「打基线」：写入 `migrations` 记录 `InitSchema1791030967094`，
     启动不会重复建表（已用 `migration:show` 与实机启动双重确认）。
3. **验证**：backend `tsc` 0 错；`jest` 3 套件 / 7 用例全绿；另起 3199 实例冷启动成功、
   接口 200、日志无迁移与报错、真实库表数不变（12 + `migrations`）。
4. **顺带发现的历史遗留**：库里有 2 张**无实体、无代码引用**的孤儿表
   `ai_image_providers`、`ai_style_presets`（来自已删除的「AI 生成宠物」功能，commit `7aa21190`）。
   它们正是 Phase 4 要清的「旧宠物功能遗留组件」，因不在实体集合内，删代码不会自动清理，
   需要一条显式 `DROP TABLE` migration。

#### 4.1 正式删除（待执行）
1. 生产库同样先执行 4.0 的备份 + 基线（阿里云 ECS）。
2. `pet_assets` / `action_assets` / `download_records`(asset_type='pet') / `reviews`(asset_type='pet')
   的数据导出与迁移；`user_sync_data` 中 `pet_state` 的兼容读取。
3. 删除模型/实体/模块：`platform/backend/src/{pets,actions}`、`app.module.ts` 引用、
   `scripts/seed.ts` 的示例宠物；前端 `ResourceList/Detail/Profile/Workshop` 的宠物分支。
4. 新增 migration 显式删表（含 4.0 发现的 2 张孤儿表），**不再依赖 synchronize**。
5. 退出条件：平台后端启动无孤儿引用；商店不再展示宠物类目；移动端/桌面端无 404 调用。

### Phase 5 — 资源与移动产物清理
1. 删除 `resources/builtin-pets`、`resources/pet-asset-library` 与 `forge.config.ts` 的 `extraResource` 项
   （仅在「新模块不再需要随包资产」这一前提下；若新模块仍需要，改为新目录并在 Phase 1 设计里定名）。
2. 清理 `Environment/build/dist-share/` 下的 `pet-bundle-*.zip`、`MobilePet-*.apk`（保留最近一个可用版本）。
3. 清理 `scripts/pets/*`、`scripts/research/github-pet-*`、`scripts/build-builtin-pets.mjs`（资源流水线）。
4. 同步更新 `docs/upstream-pet-assets*`、`.trae/documents/pet-*.md`、`ATTRIBUTION.md` 的失效引用。
- 退出条件：`npm run package` 成功且产物不再包含已删资源；`npm test` 全绿。

### Phase 6 — 收尾
- 删除 `.trae/documents/ai-pet-animation-rebuild.md`、`builtin-demo-pets.md`、
  `pet-bound-actions-refactor.md`、`pet-resource-system-refactor.md` 等已失效设计文档。
- 全仓 `grep -ri "pet"` 复核「非宠物域误删/漏删」清单（见附录 A 的 G 节白名单）。
- 打发布 tag，更新提交说明。

---

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| 误删**非**宠物域但含 "pet" 的文件（`PetInfoModule`/`HotUpdate`/`com.mobilepet` 包名/`deploy/nginx-pet.conf`） | 附录 A 的 G 节白名单，删除前逐条比对 |
| TypeORM `synchronize:true` 导致删实体即 DROP 表 | Phase 4 强制 `pg_dump`；并建议先切到显式 migration |
| 跨端契约漂移（`petAssetId`、`currentPet`） | I4 不变量 + 双跑 + 云端兼容读取（不认识的字段保留而非丢弃） |
| 移动端与桌面共享 TS 源码的构建约束（RN Metro 不认 `src/` 路径） | Phase 2 第 4 步先验证路径方案（`metro.config.js` extraNodeModules / 抽独立包），验证不过则移动端保留薄适配层 |
| 大重构中途不可用 | 分阶段 + 双跑 + 每阶段可独立回滚；破坏性阶段前打 tag |

---

## 六、验收标准（整体）

1. 全仓不存在任何旧宠物实现组件（代码/配置/资源/表/产物），`grep` 可证。
2. `npx tsc --noEmit` 0 错；`npm test` 全绿且用例数不少于当前 305。
3. 桌面端五形态（image/gif/pack/live2d/model3d）渲染与互动冒烟通过；移动端悬浮窗与商店宠物流程冒烟通过；
   平台后端启动、商店不再有宠物类目、存量用户数据已迁移或明确废弃。
4. 云端兼容：老客户端写入的 `pet-state`/`currentPet` 仍可被新版本安全读取（不崩、不丢）。

---

## 附录 A — 逐文件盘点、IPC/配置/实体/测试清单

（内容较长，采用独立章节维护：IPC 接口面、配置键、数据库实体、宠物状态模型、渲染路径、
商店发布流程、**含 "pet" 但非宠物域的白名单**、以及钉住宠物行为的测试文件清单。
该盘点已随本方案输出，Phase 2 起作为迁移对照表使用。）
