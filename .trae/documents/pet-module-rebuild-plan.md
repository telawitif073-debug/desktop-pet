# 宠物功能模块（`pet/`）全新重建 — 实施计划

## Context（为什么做）

上一阶段按用户确认把整套宠物系统**彻底移除**（10 个提交，`HEAD=1046017d`，tag `pet-removal-final`；含不可逆迁移 `1791100000000` 删表/收窄枚举）。随后用户改变方向，要求**以仓库根 `pet/` 为唯一根目录、从头重建一个低耦合高内聚的宠物功能模块**，覆盖四端（后端 NestJS / 桌面 Electron / 移动 RN / 平台前端 Web），并且**先出「骨架 + 接口契约」，评审通过后再实现功能**。

现状障碍：`pet/` 当前**未跟踪**且内容是上游 `PC2005-cloud/dsh-pet` 的**素材残缺拷贝**（138 文件 / 60.5 MiB，源码目录全空，素材许可「禁止商用 + 二创须署名」）；`Environment/` 下已有两份同源完整拷贝；另有我上轮删除后残留的空壳目录 `src/pet/`、`mobile/src/pet/`。因此必须先做一次**仓库清理与命名冲突处置**，再落骨架。

目标产出：一套可评审的契约层 + 四端可编译接入的骨架 → 迁移重建数据库 → 四端功能实现（**完整复刻旧能力**，含感知/ASR/形象自描述）。

## 已拍板决策（本次基线）

| 议题 | 决策 |
|---|---|
| 模块根 | 仓库根 `pet/` 为**唯一根**，内部分层 |
| 上游素材 | **本地保留在 `pet/resources/upstream/`**（移动过去 + `.gitignore`，本地可跑通、**不入 git**） |
| 许可 | 沿用「素材禁商用 + 二创署名」，署名落 `pet/resources/README.md` + 根 `THIRD-PARTY.md` |
| 功能范围 | **完整复刻旧能力**（vitals + 动作模型/播放 + 宠物包商店 + 桌面悬浮窗/感知/ASR/自描述 + 移动悬浮窗），契约一次性冻结、实现分阶段 |
| 后端共享 | **复制同步生成物入库**（`pet/tools/sync-to-backend.mjs` → `platform/backend/src/pet-domain/`，`verify-sync.mjs` 守一致） |
| 内置演示宠物 | **要**，仅自产小体积（`pet/resources/builtin/`，JSON + 少量 PNG，不含 webm） |
| DB | **新建可回滚迁移** `1791200000000-RebuildPetPacks` 重建 `pet_packs` 并重扩枚举 |
| 交付节奏 | 阶段 0 清理 → 阶段 1 骨架+契约（**评审门禁**）→ 阶段 2 迁移 → 阶段 3~6 四端功能 |

## 目标目录结构（`pet/`）

```
pet/                                  # 模块唯一根（源码入库；目标 < 1 MiB，不含 upstream）
├── README.md                         # 模块边界、分层依赖铁律、四端接入方式、许可与署名
├── package.json                      # private:true 源码包描述（main/types → domain/index.ts，无 dependencies）
├── tsconfig.json                     # noEmit + strict（供各端参考；不参与任何端 build）
├── domain/                           # 纯逻辑层：零 IO / 零依赖（禁 fs/path/crypto/react/react-native/electron）
│   ├── index.ts  vitals.ts  resource.ts  actionModel.ts  playback.ts  probe.ts  pack.ts
│   └── *.spec.ts                     # 根 vitest 跑
├── api/                              # 契约层：仅类型/常量/路径/限额
│   ├── index.ts  contract.ts  endpoints.ts  limits.ts  syncKeys.ts
├── ui/                               # 框架无关展示逻辑（纯数据进出）
│   ├── index.ts  petViewModel.ts  storeFilters.ts  *.spec.ts
├── resources/
│   ├── README.md                     # 素材来源/许可/署名/重建命令
│   ├── upstream-manifest.json        # 上游素材索引（name/bytes/sha256/source/license）—— 入库
│   ├── upstream/                     # 上游素材实体（dsh-pet 素材 + README/LICENSE/prompts）—— .gitignore
│   └── builtin/                      # 内置演示宠物（自产 SVG/PNG + JSON，无 webm）—— 入库
└── tools/                            # 离线 Node 脚本，不参与任何端构建
    ├── sync-to-backend.mjs           # 复制 domain/api/ui → platform/backend/src/pet-domain/
    ├── verify-sync.mjs               # 校验「同步副本 ≡ pet/ 源」（提交前/CI）
    └── build-resource-manifest.mjs   # 扫描 upstream/ 生成 upstream-manifest.json
```

**分层依赖铁律**（写入 `pet/README.md`，用 ESLint `no-restricted-imports` + review 守）：`api ← domain ← ui` 只允许左向依赖；端内适配层可 import `pet/` 任意层；`pet/` 任意层**禁止** import 端内代码或任何 `node_modules`。

## 跨端引用机制（按端分治）

| 端 | 机制 | 需改动的构建配置 |
|---|---|---|
| 桌面（仓库根） | vite `resolve.alias` `@pet` → `<root>/pet`；保留 `src/pet/index.ts` 转发 shim `export * from '../../pet/domain'` | `vite.main.config.ts` / `vite.preload.config.ts` / `vite.renderer.config.ts`（三份 alias 必须一致）；根 `tsconfig.json`：`include` 删 `"packages"` 加 `"pet"`、`paths` 加 `@pet/*` |
| 平台前端 | vite alias + `server.fs.allow`（`pet/` 在 root 之外，缺此 dev server 会 403） | `platform/frontend/vite.config.ts`、`platform/frontend/tsconfig.json`（`paths` + `include`） |
| 移动 | 恢复 `metro.config.js` 的 `watchFolders: [<root>/pet]` + `src/pet/domain.ts` shim | `mobile/metro.config.js`、`mobile/tsconfig.json`（`include` 加 `../pet/**/*.ts`） |
| 后端 | `pet/tools/sync-to-backend.mjs` 复制到 `platform/backend/src/pet-domain/`（注入「⚠ 生成物勿手改」头注释；**不复制 `*.spec.ts`**，避免被 jest 收集/污染覆盖率） | `platform/backend/tsconfig.json` **不改** |

**必须一并清理的失效残留**：根 `tsconfig.json` 的 `"packages"` include 与 `packages/**` glob、根 `vitest.config.ts` 的 `packages/**/*.spec.ts`（改为 `pet/**/*.spec.ts`）、空壳目录 `src/pet/`（含空 `migration/`）与 `mobile/src/pet/`。

**性能/隔离**：`pet/resources/upstream/**` 需加入 vite `server.watch.ignored`、metro `resolver.blockList`、tsconfig `exclude`，避免 60MB 素材被 dev server/打包器扫描。

## 接口契约（阶段 1 产出，完整复刻版）

> 契约文件只放类型/常量/纯函数签名；常量与纯函数**必须有真实实现**（支撑单测），有 IO/框架依赖的留 `TODO` 存根。

- `domain/vitals.ts`：`PetVitals{hunger,mood,energy,affection}`、`PetMood`、`DEFAULT_VITALS{80,80,80,50}`、`DEFAULT_DECAY`、`clampVitals`、`feed/play/rest/interact`、`decayVitals(v,elapsedMs,rate?)`、`resetVitals`、`moodOf`、`VITAL_ALERT_THRESHOLD=30`。
- `domain/resource.ts`：`PetResourceRole`(12 角色)、`PetResourceEntry`、`classifyPetResourcePath`、`isIgnoredPackPath`、`isActionPayloadPath`、`isQualifiedBody`、`evaluatePetPack(entries)`（fail-closed，返回 `{ok,errors,warnings,bodyKinds,resources}`）。
- `domain/actionModel.ts`：`ACTION_SCHEMA_VERSION=3`、`ACTION_PAYLOAD_DIR='pet/actions'`、`actionPayloadDirName()`、`PetActionKind='frames'|'clip'|'video'`、`PetActionSpec`、`PetActionBindings`、`PetActionModel`、`validatePetActionModel()`、`migrateActionModel()`（v1/v2→v3）。
- `domain/playback.ts`：`PlaybackTrigger='explicit'|'event'|'interact'|'click'|'drag'|'idle'`、`PlaybackRequest/Decision`、`resolvePlayback(model,req,random?)`（优先级 显式>事件>互动>点击>拖拽>随机；含不连播 + 镜像门控）。
- `domain/probe.ts`：纯头解析 `probeBytes(Uint8Array)`（PNG/GIF/WebP/JPEG/BMP，无 Node 内置）。
- `domain/pack.ts`：`PACK_MANIFEST_VERSION=1`、`PetPackManifest`、`parsePetPackManifest()`、`canonicalDigestEntries()`（sha256 由调用端做）；`actionQuota`（旧 `PET_ACTIONS_MAX_USER=15`/`PET_ACTIONS_MAX_PER_PET=128` + `ownerKey`）迁入本层。
- `api/limits.ts`：`PET_PACK_MAX_ARCHIVE_BYTES=134217728`、`PET_PACK_MAX_ENTRIES=3000`、`PET_PACK_MAX_ENTRY_BYTES=33554432`、`PET_PACK_MAX_UNCOMPRESSED_BYTES=268435456`、`PET_ASSET_TYPE='pet'`（评价/下载域）、`PET_ADMIN_CARRIER='pet_pack'`（admin 载体，**刻意不同名**）。
- `api/endpoints.ts`：`PET_PACK_API{list,mine,detail,approve,reject,download,review}`、`PET_PACK_UPLOAD_FIELDS`、`PET_SYNC_KIND='pet_state'`（DB 下划线）、`PET_SYNC_ROUTE='pet-state'`（REST 连字符）。
- `api/contract.ts`：`PetPackStatus`、`PetPackSummary/Detail`、`PetPackDownloadResult`、`Create/UpdatePetPackInput`、`ListPetPacksQuery`、`PET_PACK_ERRORS`。
- `api/syncKeys.ts`：`PET_CONFIG_KEYS`（12 键：`petAssetPath,petAssetName,petAssetId,petAssetFormat,builtinPet,petActions,petActionBindings,petState,petStateReady,petSelfDescription,currentPet,downloadedPets`）、`PetAssetRef{id,name,format,packUrl?,entryPath?,localPath?}`、`PetStatePayload`。
- `ui/petViewModel.ts`：`PetAvatarView`、`VitalsRow`、`toPetAvatarView`、`vitalsRows`、`interactionHint`。
- `ui/storeFilters.ts`：`PetPackSort`、`filterPetPacks`、`petPackStatusLabel`、`formatPackBytes`。

## DB 重建迁移

**文件**：`platform/backend/src/migrations/1791200000000-RebuildPetPacks.ts`（类名 `RebuildPetPacks1791200000000`；时间戳 > `1791100000000`）。

**`up()` 步骤**（全裸 SQL；**约束/索引名必须照抄旧 hash 名防 `migration:generate` 漂移**）：
1. 重建 `pet_packs`：`CREATE TYPE pet_packs_status_enum AS ENUM('pending','approved','rejected')` → 列定义照抄旧 `AddPetPacks1791041000000`（`pack_url`/`pack_sha256` NOT NULL、`body_kinds text[]`、`manifest jsonb`、`status`、`created_at/updated_at` 等）→ `CREATE INDEX IDX_8ec3883c97ce460097881670b8(status)` → `FK_a86418b08d1c0ab19dfa75a4547 (author_id)→users(id) ON DELETE CASCADE`。
2. `reviews.asset_type`：`('agent','voice')` → 扩为 `('agent','voice','pet')`（先 `DROP INDEX IDX_7a44ce3847f2132fd778b79fff` → RENAME 旧类型 → CREATE 新 → `ALTER COLUMN ... USING "asset_type"::"text"::...` → DROP 旧 → 回建索引）。**本次是扩枚举，现存行不回删**。
3. `download_records.asset_type`：同上（索引 `IDX_8d22c86c970ad4f47756bd177f`）。
4. `user_sync_data.kind`：扩为 `('config','chat_history','pet_state')`——**下划线** `pet_state`（写连字符会 `22P02`）。
5. config jsonb 的 12 个宠物键：**`up()` 不写任何行**（`sync.service.ts` 对 config 是 jsonb 透传、无键白名单，键由客户端首次写入自然出现）。

**`down()`（可回滚）**：删 `reviews/download_records` 中 `asset_type='pet'` 行 → 两枚举回 `('agent','voice')` → 删 `kind='pet_state'` 行并回 `('config','chat_history')` → `DROP pet_packs`（FK/索引/表/枚举）。注释声明：config 内 12 键**不回填**（原值不可知）。

**前置安全网（硬约束）**：① `pg_dump desktop_pet_platform > Environment/backups/before-pet-rebuild-<ts>.sql`；② 临时库 `dpp_dryrun` 恢复演练 → `migration:run` → 核对 `users/agents/voices/reviews/download_records/user_sync_data/pet_packs` 行数；③ 演练库 `migration:revert` 验证 `down()` 再 `run` 复原；④ 生产执行前 `migration:show` 确认。

## 四端接入点（骨架阶段 vs 功能阶段）

**后端 `platform/backend`**
- 骨架：新增 `src/pet-packs/{pet-pack.entity.ts, pet-packs.module.ts, pet-packs.controller.ts, pet-packs.service.ts(签名存根), dto/pet-pack.dto.ts}`；`src/app.module.ts` 注册；`src/pet-domain/**`（脚本生成）；改 `reviews/review.entity.ts` + `download-record.entity.ts`（`AssetType` 加 `'pet'`）、`reviews.service.ts`（`assertAssetExists/recomputeRating/listDownloaded` 加 pet 分支）、`reviews.controller.ts`（入参校验加 `'pet'`）、`admin/admin.controller.ts`（接受 `pet_pack`）、`sync/user-sync-data.entity.ts` + `sync.controller.ts`（`pet_state` 路由）；迁移见上。
- 功能：`src/pet-packs/zip-reader.ts`（**手写 zip central-directory 解析**，仅用 `node:zlib`，不引第三方）+ `pack-inspection.ts`（四限额 + sha256 + `evaluatePetPack` + `validatePetActionModel`）+ service 完整实现 + `pet-packs.service.spec.ts`。

**桌面 `src/`**
- 骨架：`src/main/config.ts`（`AppConfig` 加 `pet` 设置 + `normalize`）、`src/global.d.ts`（镜像 + `StudioWorkspaceTab` 不加宠物？→ 加 `'pets'`）、`src/preload.ts`（`electronAPI.pet.*` 通道骨架）、`src/main.ts`（`openPetWindow()` + `ipcMain.handle('pet:*')` + 菜单「宠物」）、`src/main/pet/*.ts`（`petWindow/petLibrary/petPack/petActions/petState` 签名）、`src/renderer/pet/petView.ts`(+spec)、`src/components/pet/{PetStage,PetWindow}.tsx`、`src/components/Studio.tsx`（工作区加 `'pets'`）、`src/main/platformClient.ts`（`PlatformAssetType` 加 `'pet'`，`apiPath='pet-packs'`）。
- 功能（完整复刻）：`src/main/pet/**` 完整（`adm-zip` 解包到 `userData/pets/<id>`、动作绑定持久化、定时衰减、`scheduleUpload('config')`、拖拽/点击互动）＋ **感知/ASR/自描述**：`src/main/pet/{ambientSense,senseIntent,apiAsr,moodLink}.ts`（对应旧 `src/renderer/{ambientSense,senseIntent,apiAsr,moodLink}` 与 `src/main/localMedia.ts`）、`selfImage`（`petSelfDescription`/`selfImageFingerprint`）、`src/components/pet/*` 完整（webm `<video>`、frames 序列、镜像、气泡台词）＋ `petPackPublish.ts`。

**平台前端 `platform/frontend`**
- 骨架：`src/types.ts`（`AssetType` 加 `'pet'` + 从 `@pet/api` re-export）、`src/api.ts`（`assetPath: pet→'pet-packs'`、`adminCarrierName: pet→'pet_pack'`、`listPetPacks/getPetPack/downloadPetPack/listMyPetPacks`）、新增 `src/pages/PetPacksPage.tsx`、`src/App.tsx` 加 `/pets` 路由（骨架**暂不加顶栏 nav**）。
- 功能：`ResourceListPage`/`ResourceDetailPage` 支持宠物包（评分/评论/下载）、`AdminPage` 审核 `pet_pack`、`ProfilePage` 已下载含宠物、`App.tsx` 顶栏加「宠物」。

**移动 `mobile`**
- 骨架：`metro.config.js`（恢复 `watchFolders`）、`tsconfig.json`、`src/pet/domain.ts`（shim）、`src/types.ts`（re-export）、`src/store/appStore.ts`（`petState/currentPet/downloadedPets` + `PERSIST_KEYS` + `hydrate` 迁移；`STORAGE_KEY='mobile-pet-store'` **不改**）、`src/api/platform.ts`、新增 `src/screens/PetScreen.tsx` 占位、`MainShell.tsx` 入口。
- 功能：`src/pet/{PetView,FloatingPet,petFiles}.tsx`（`react-native-zip-archive` + `@dr.pogodin/react-native-fs` 已有依赖）＋ 原生 `com.mobilepet.OverlayPet{Module,Package,Service}.kt`（`TYPE_APPLICATION_OVERLAY`）+ `MainApplication.kt` 注册（**原生模块名 `PetInfo/PetUpdate/PetVoice/HotUpdate` 一律不动**）＋ `src/api/sync.ts` 的 `pet_state` 往返。

## 阶段与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| **0 清理** | 上游素材移入 `pet/resources/upstream/` 并 gitignore；生成 `upstream-manifest.json`；删空壳 `src/pet/`、`mobile/src/pet/`；清 `tsconfig.json`/`vitest.config.ts` 的 `packages` 残留；补 `.gitignore` | `git status` 无噪声；根 `npx tsc --noEmit`、`npm test`（vitest 117 基线）通过 |
| **1 骨架+契约（评审门禁）** | `pet/{package.json,tsconfig.json,README.md}` + `domain/api/ui` 全部符号 + `resources/{README,builtin}` + `tools/*`；四端「骨架」列改动 | `npx vitest run pet` 通过；四端分别 `tsc --noEmit`（前端 `tsc -b`、后端 `nest build`）通过；每端一个「引用 @pet 常量」的临时调用点验证通路。**评审通过才进阶段 2** |
| **2 迁移** | `1791200000000-RebuildPetPacks.ts` + `pet-pack.entity.ts` | 备份 → 临时库 `migration:run`/`:show`/`:revert`/`:run`；`pg_enum` 与行数核对 |
| **3 后端功能** | zip-reader/pack-inspection/service 完整/reviews·admin·sync 接入 | `nest build` + `jest`；实机：`GET /api/pet-packs` 200、无 token `POST` 401、`GET /api/reviews?assetType=pet&assetId=<uuid>` 200、`POST /api/admin/approve/pet_pack/:id` 非 admin 403 |
| **4 平台前端功能** | 商店列表/详情/下载/评分 + AdminPage 审核 | `npm run build`；实机：上传→审核→浏览→下载→评价全流程 |
| **5 桌面功能** | `src/main/pet/**`、`src/components/pet/**`、感知/ASR/自描述、发布宠物包 | `tsc --noEmit` + `vitest run` + `npm start` 实机：悬浮窗/动作播放/拖拽/config 落盘/云同步往返 |
| **6 移动功能** | `mobile/src/pet/**` + 原生悬浮窗 + `pet_state` 同步 | `tsc --noEmit` + `jest` + `react-native start --reset-cache`（Metro 可能不自动重打包）+ 实机 APK |

## 风险与注意事项

- **迁移约束名漂移**：必须用旧 hash 名（`PK_b0751…`/`IDX_8ec3883…`/`FK_a8641…`），否则 `migration:generate` 会产出无意义 rename。
- **平台前端 vite root 外引用**：缺 `server.fs.allow` → dev server 403。
- **三份 vite config 的 alias 漂移**：桌面 main/preload/renderer 必须同源。
- **后端 zip 解析**：后端无 `adm-zip`，只能自研（`node:zlib` 属内置，不违反「不引第三方依赖」）。
- **Metro 跨目录**：改动 `pet/` 后需 `--reset-cache`。
- **许可**：上游素材禁商用 + 二创须署名；素材**不入 git**、运行时经商店按需下载；署名落 `pet/resources/README.md` + 根 `THIRD-PARTY.md`。
- **与既有决定一致**：应用品牌名、原生模块名、热更 URL `pet-bundle-*.zip`、存储键 `mobile-pet-store`、DB 名 `desktop_pet_platform`、评价域 `asset_type='pet'` vs admin 载体 `pet_pack` 的不同名——全部**沿用不变量**。

## 回滚

- 代码：阶段 0/1 新增文件可直接删除；阶段 2 迁移可 `migration:revert`（down 已实现）。
- 数据：`Environment/backups/before-pet-rebuild-<ts>.sql` 全量还原；历史回退点 tag `snapshot-before-pet-removal`。
