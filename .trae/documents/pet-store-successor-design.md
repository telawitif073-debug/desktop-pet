# 新宠物商店承接方案（设计）

> 背景：Phase 4.1 已删除平台侧旧宠物商店（表 `pet_assets` / `action_assets` 与后端 `pets`/`actions` 模块），
> 因此宠物资源「发布 / 浏览 / 下载 / 安装」在平台侧**目前没有任何承接方**，跨端相关入口会 404。
> 本文设计承接方案，供决策后再实施。
>
> 关联：`.trae/documents/pet-domain-rebuild.md`（分阶段重建方案）、
> `src/pet/resource.ts`（宠物本体资源分类标准）、`Environment/build/backups/RESTORE.md`（已导出数据）。

---

## 一、问题定义

要回答的只有一句：**旧商店下线后，「一只宠物」在平台侧由谁存储与分发？**

设计前必须先看清旧模型错在哪，否则新方案会重蹈覆辙。

### 1.1 旧模型（已删）的实际形态

| 位置 | 形态 | 被删时的真实数据（已导出留档） |
|---|---|---|
| `pet_assets` | `format` 枚举 + **单个 `file_url`** + 可选 `preview_url`/`background_url` | 16 行，**全部 `format=image`、`file_url` 全空**；其中 10 行名为「E2E测试宠物…」 |
| `action_assets` | 独立表，`pet_id` 外键 | 0 行 |
| `reviews` / `download_records` | 多态 `(asset_type, asset_id)` | pet 评价 9 条、pet 下载记录 65 条 |

**根本缺陷**：旧模型把「一只宠物」定义成**一个文件**（`file_url`）。
这正是上一轮反复修的那个 bug 的来源——单文件无法表达「这是宠物本体」，
只能靠文件名 glob 猜（`main.*` → 任意图片 → 取目录里第一个文件），于是图标/背景/键帽
都能被当成本体装进去。

### 1.2 新标准要求什么

`src/pet/resource.ts` 已经确立：一个宠物**必须是一个资源包**，且包内**至少有一个「够格本体」**
（`body-model` / `body-animation` / `body-still`），否则整个包判 `invalid`（fail-closed）；
动作是包内的一部分（`pet/actions.json`，见 `actionModel.ts` 的 v2 模型），不再是一张独立表。

### 1.3 已确认的客户端形态

发布载荷已经是多文件形态（`src/global.d.ts` 的 `PublishPayload`）：
`{ type, fields, file?, preview?, actionFiles?[], actionsMeta?[] }`。
也就是说**客户端早就在为「包」做准备了，是服务端把它压扁成了单个 `file_url`**。

---

## 二、设计决策（含建议）

| # | 决策点 | 建议 | 理由 |
|---|---|---|---|
| **D1** | 分发单位 | **宠物包（zip）**，不是单文件 | 本体判定需要多文件上下文；单文件模型正是旧缺陷根源 |
| **D2** | 分类标准的归属 | `src/pet/resource.ts` 为**唯一**标准；服务端复用同一份代码 | 已经吃过一次「两份实现口径分裂」的亏（Python 与 TS 目录归一化不一致）；再抄一份必然重演 |
| **D3** | 服务端是否自行判定 | **是**：上传即解包跑 `evaluatePetPack`，不合格直接拒绝并回传 `errors`/`rejected` | 把「只收本体资源」从客户端自觉升级为服务端强制 |
| **D4** | 动作存储 | **不建动作表**：动作进包内 `actions.json` | 动作本就是包的一部分；独立表还会诱使"动作可脱离宠物存在" |
| **D5** | 表名 | **新建 `pet_packs`**，不复用 `pet_assets` | 语义已变（包 ≠ 单文件）；旧名/旧枚举刚删干净，复用会造成新旧混淆 |
| **D6** | 评价/下载记录的资源类型 | 落地时**回补 `'pet'` 枚举值**（+1 条 migration） | 语义没变，只是载体从"文件"变"包"；见 §六 的顺序教训 |
| **D7** | 旧数据迁移 | **不迁移**（当前库） | 证据：`file_url` 全空 + 10/16 是 E2E 测试数据（见 §1.1）。生产库需另行人工评估 |
| **D8** | 是否保留商店 | **保留**（本方案前提） | 若决定不要商店，直接走 §五 的「方案 C」并跳过本设计 |

---

## 三、推荐方案（方案 A：包即资源）

### 3.1 数据模型

```
pet_packs
  id             uuid  PK
  name           varchar(100)
  description    text
  author_id      uuid  FK users(id) ON DELETE CASCADE
  category       varchar(50)
  tags           jsonb          -- string[]
  pack_url       varchar(255)   NOT NULL   -- 宠物包 zip（唯一必填载体）
  pack_sha256    varchar(64)    NOT NULL   -- 完整性校验（下载/安装两侧都比对）
  pack_bytes     integer
  pack_schema_version  integer  DEFAULT 1  -- 包格式版本，便于将来迁移
  manifest       jsonb          -- 包内清单快照：pet/actions.json + 资源角色分类结果
  body_kinds     text[]         -- 包内合格本体类型（body-model/animation/still），供筛选
  preview_url    varchar(255)   -- 商店卡片（= 包内 body-cover，可选）
  version        varchar(20)    DEFAULT '1.0.0'
  downloads      integer        DEFAULT 0
  rating         double precision DEFAULT 0
  status         enum(pending/approved/rejected) DEFAULT 'pending'
  created_at, updated_at
```

要点：
- `pack_url` **取代** `file_url`：商店不再接受"一张图当宠物"。
- `body_kinds` 是**从校验结果派生**的（不是用户填的），因此可以拿它做「只看 Live2D / 只看像素动画」这类筛选。
- `manifest` 存的是**校验时的快照**，审核页与商店详情直接展示，无需重新解包。
- `preview_url` 只是卡片图，**不参与本体判定**（避免又出现"封面当宠物"）。

### 3.2 服务端流程（发布）

```
POST /pet-packs (multipart: pack.zip, 可选 preview.png, + 文本字段)
  → 写入临时目录（沿用 uploads/storage.service.ts 的 local/S3 抽象）
  → 解包，构造 ResourceEntry[]（复用主进程同款头部探测思路；服务端用肩部读取宽高/帧数/alpha）
  → evaluatePetPack(entries)            ← 与客户端同一份 src/pet/resource.ts
        ├─ invalid → 400，返回 { errors, rejected[] }（逐条给出角色与理由），落盘文件清理
        └─ valid  → 取 entry + body kinds + 角色统计
  → 存包到 storage，写 pet_packs（status=pending，manifest 带上校验摘要）
```

审核端（`admin`）动作类型仍只有 `agent` / `voice`，新增 `pet_pack`；审核页展示：
包内本体入口、合格本体清单、被拒资源与理由（**审核者看到的是标准判定结果，而不是一张图**）。

### 3.3 客户端流程

| 环节 | 行为 |
|---|---|
| 发布（宠工坊） | 用户选**一个宠物目录/zip** → 客户端**先本地跑 `evaluatePetPack`**（提前失败，避免白传）→ 生成 `pet/actions.json` → 打包上传 |
| 浏览 | 商店宠物页展示 `preview_url` + `body_kinds` + `pack_bytes` + 版本 |
| 安装 | 下载 → 校验 `pack_sha256` → 解包 → **再跑一次 `evaluatePetPack`**（不信任服务端）→ 沿用现有 `petPack.ts` / `petActions.ts` 落盘到 `userData` |
| 卸载 | 沿用现有 `clearPlatformActions` + 清形象字段 |

**双重校验是刻意的**：服务端校验是门禁（保护商店），客户端校验是安全边界（保护本机），
两者共用同一份标准，因此不会出现"服务端说合格、客户端装不上"。

### 3.4 标准如何被服务端复用（D2 的落地选项）

| 选项 | 做法 | 评价 |
|---|---|---|
| **b（推荐）** | 抽成独立包 `packages/pet-domain`（含 `resource/actionModel/playback/vitals`），桌面、移动、后端三方都以依赖方式引用 | 最干净；一次到位，彻底消除"第三份实现"的可能。代价：要引入 workspace 结构与构建调整 |
| a（退路） | 后端 `tsconfig.json` 加 `paths` 映射到 `../../src/pet/*` | 改动小、ts-node 可用；但 `nest build` 受 `rootDir` 限制，需额外处理产物布局，属技术债 |
| c（不推荐） | 后端再实现一份 | 已证明会口径分裂（Python ⇄ TS 那次目录归一化不一致），不再重犯 |

建议：**先用 a 落地跑通，再单独一个提交升级为 b**（与本次"分阶段"的一贯做法一致）。
> 实施结果（见 §四 第 1 条）：评估后**直接采用 b**——a 的 `paths` 只解决解析，
> 解决不了 `nest build` 的产物布局，最终仍要落到 b 的机制上。

---

## 四、实施清单（按依赖顺序）

1. **抽象共享包**（选 a 或 b）→ 后端可 `import { evaluatePetPack } from '@pet/resource'`。
   **【已完成，直接采用 b】**：落地为 `packages/pet-domain/`（源）＋ 桌面 `src/pet/**` 再导出 shim
   ＋ 移动端 metro `watchFolders` 增加 `packages/` ＋ 后端 `platform/backend/src/pet-domain/`
   （由 `scripts/sync-pet-domain.mjs` 生成、已 gitignore）。
   跳过了 §3.4 的「先 a 后 b」：a 的 `paths` 方案仍解决不了 `nest build` 的 `rootDir` 产物布局问题，
   等于白做一遍；直接 b 的同步复制已在后端 `tsc`/`jest`/`nest build`/3199 冷启动上验证通过。
2. **后端**：`pet_packs` 实体 + module/service/controller + DTO；`admin` 支持 `pet_pack` 审核；
   `reviews` / `download_records` 枚举回补 `'pet'`；配套 migration（建表 + 枚举回补 + 索引）。
   **【已完成】**：migration `1791041000000-AddPetPacks`（建表 + 可逆的双枚举重建）；
   新增 `src/pet-packs/**`（entity/dto/service/controller/module）；
   `admin` 审核类型增加 `pet_pack`；`reviews` 侧接入 PetPack 仓库（存在性校验 / 评分回写 / 已下载列表）。
   两点实施取舍：
   - **刻意不开放 `POST /pet-packs`（发布）**：发布必须「上传即解包跑 `evaluatePetPack`」并拒绝不合格包（D3），
     该能力属第 3 步。在服务端校验落地前留一个「什么文件都能当宠物发布」的入口，
     等于把 §1.1 的旧缺陷重新引进来——因此宁可在第 2 步先不上发布路由。
   - `admin` 的 `type=pet_pack`（载体名）与 `asset_type='pet'`（评价域资源类型）**刻意不同名**，
     后者沿用旧值以保持跨端与历史数据口径；已在两处代码注释中标注。
   验证：`tsc` 0 错；`jest` 2 套件 / 5 用例全绿；`nest build` 后产物布局不变；
   真库执行 migration 后 `migration:generate` 报告「No changes in database schema were found」（实体↔库零漂移）；
   3199 冷启动后**接口级 20 项断言全过**（待审包对公众不可见 / 管理员可见并能审核 /
   `bodyKind` 与关键词筛选 / 下载返回 `sha256` 且写 `download_records(asset_type='pet')` /
   评价写 `reviews(asset_type='pet')` 并回写 `rating` / 已下载列表带回宠物包实体 / 删除与 404 边界），
   验证数据已清理、行数与验证前一致。
3. **服务端包校验**：新增 `pack-inspection.ts`（解包 + 肩部探测 + 调 `evaluatePetPack`），
   与 `uploads/upload-validation.ts`（字节级安全校验）叠加使用。
4. **桌面端**：`platformClient` 的 pet 分支改为 pack 流程（上传/下载/安装/校验），
   `PetPublishForm` 改成"选择宠物包"（而非选一张主图），`PetResources` 商店入口恢复。
5. **平台前端**：`ResourceListPage` / `ResourceDetailPage` / `ProfilePage` / `WorkshopPage`
   的宠物分支改为展示包信息与校验摘要。
6. **移动端**：`api/platform.ts` 的 `'pet'` 恢复为 pack 语义，`StoreDrawer` 宠物 tab 恢复。
7. **测试**：服务端用**真实宠物包**做「合格包通过 / 只有图标的包被拒」的接口级用例；
   客户端保留现有 `petResource.spec.ts` 作为同一标准的回归。

---

## 五、备选方案

- **方案 B：沿用单文件 + 附属**——改动最小，但直接违反新标准（单文件无法证明本体），
  会把上一轮修好的 bug 重新引入。**否决**。
- **方案 C：不做平台分发**——商店宠物板块永久下线，宠物只来自「随包内置」+「上游素材库」+「本地导入」。
  代价：失去用户间分享与云端恢复（换设备要重新导入）。若不需要分享，这是**成本最低**的选择，
  且能立刻消除 404。**若选 C，则 Phase 4.1 已完成即收尾，不需要本方案的任何实施。**

---

## 六、风险与教训

1. **顺序教训（重要）**：Phase 4.1 是在**替换方案尚未设计**的情况下执行的，
   结果就是：刚把 `'pet'` 从 `asset_type` 枚举里剔除，本设计又要求把它加回来（D6）。
   成本很小（+1 个枚举值），但它说明**破坏性删除应当排在"替代设计定稿"之后**——
   这条应写进后续 Phase 5/6 的执行前提。
2. **老客户端**：新商店的接口与资源形态都变了，旧版本客户端调用会 404/校验失败。
   若要兼容，需要版本门槛（`minVersionCode`）或保留只读的旧接口一段时间。
3. **包体积**：从"一张图"变成"一个包"，上传/下载体积显著增大（现内置宠物平均 ~2 MB/只，
   资源库单图上限 384px）。需要定包体积上限与超限提示。
4. **审核成本**：审核对象从一张图变成若干文件的包，审核页必须**展示自动校验摘要**，
   否则人工无从判断——这是 D3 必须配套做审核页的原因。
5. **`body_kinds` 的派生一致性**：若将来标准升级（新增角色），历史行的 `body_kinds` 会过期；
   需记录 `pack_schema_version` 并允许重算（重新解包校验）。

---

## 七、需要决策的点

| # | 问题 | 选项 |
|---|---|---|
| Q1 | 是否保留平台侧宠物商店？ | **保留（走方案 A，推荐）** / 不保留（走方案 C，立即收尾） |
| Q2 | 共享标准的落地方式 | **先 a 后 b（推荐）** / 直接 b / a 为止 |
| Q3 | 当前这 16 行旧数据 | **不迁移（推荐，证据见 §1.1）** / 人工挑选后重新打包上传 |
| Q4 | 实施时机 | 现在做 / 与 Phase 5-6 一起做 / 暂不做（先只清 404 入口） |
