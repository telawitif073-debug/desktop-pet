# 宠物功能模块（`pet/`）

本目录是「宠物」功能模块的**唯一根目录**。所有与宠物相关的**跨端共享代码**都在这里，
四端（桌面 Electron / 移动 RN / 平台前端 Web / 后端 NestJS）通过各自的机制引用本目录。

> 历史：上一阶段的旧宠物系统（散落在 `packages/pet-domain`、`src/pet/**`、`platform/backend/src/pet-packs`、
> 移动端 `src/pet/**`）已被整体移除；本模块是按新架构**从头重建**的实现，领域层（`domain/`）
> 沿用经单测钉住的既有纯逻辑，契约与目录结构按新分层重排。

## 目录与分层

```
pet/
├── domain/      纯逻辑层：零 IO / 零依赖（禁 fs·path·crypto·react·react-native·electron）
├── api/         契约层：仅类型 / 常量 / 路径 / 限额（可引用 domain 的类型）
├── ui/          展示逻辑层：框架无关的「数据 → 展示数据」映射（可引用 domain 与 api）
├── resources/   资源：upstream/（第三方素材，本地保留、不入库）+ builtin/（自产演示宠物，入库）
└── tools/       离线 Node 脚本（不参与任何端构建）
```

**依赖方向铁律**：

```
domain  ←  api  ←  ui
```

- 只允许左向依赖：`api` 可 import `domain`，`ui` 可 import `domain`/`api`；反向禁止。
- `pet/` 任意层**禁止** import 任何端内代码（`src/**`、`mobile/**`、`platform/**`）。
- `pet/` 任意层**禁止** import 任何 `node_modules`（本模块零第三方依赖）。
- 一切 IO（读文件、ziп 解包、sha256、窗口、渲染、平台调用、存储）留在**各端适配层**。

## 四端引用机制

| 端 | 机制 | 关键配置 |
|---|---|---|
| 桌面（仓库根） | vite `resolve.alias` `@pet` → `<root>/pet`；`src/pet/index.ts` 为再导出 shim | `vite.{main,preload,renderer}.config.ts` 三份 alias 必须一致；根 `tsconfig.json` 的 `include` 含 `pet`、`paths` 含 `@pet/*` |
| 平台前端 | vite alias `@pet` + `server.fs.allow`（本目录在 frontend root 之外） | `platform/frontend/vite.config.ts`、`platform/frontend/tsconfig.json` |
| 移动 | Metro `watchFolders` 指向本目录；`mobile/src/pet/domain.ts` 为 shim | `mobile/metro.config.js`、`mobile/tsconfig.json` |
| 平台后端 | `node pet/tools/sync-to-backend.mjs` 复制到 `platform/backend/src/pet-domain/` | 生成物**入库**，用 `node pet/tools/verify-sync.mjs` 守一致 |

后端之所以用「复制同步」而非直接引用：`nest build` 受 `rootDir` 约束、且项目硬约束「后端不引第三方依赖 / 不改依赖拓扑」。

## 资源与许可

- `resources/upstream/`：第三方 **PC2005-cloud/dsh-pet** 的素材副本（106 段 webm 动作、26 张表情包、1 个字体）。
  - 上游许可：**代码 MIT；素材「禁止商用」+ 二创分发须署名 <https://github.com/PC2005-cloud/dsh-pet>**。
  - 因体积（~60 MiB）与许可，**素材不入 git**（见根 `.gitignore`），仅本机保留用于本地调试。
  - 仓库只保留 `resources/upstream-manifest.json`（138 个文件的 path/bytes/sha256 索引）作为可追溯与署名留档；
    由 `node pet/tools/build-resource-manifest.mjs` 生成（确定性、可按需重建）。
- `resources/builtin/`：本项目**自产**的内置演示宠物（SVG/PNG + JSON，无 webm），随仓库入库。

## 常用命令

```bash
node pet/tools/build-resource-manifest.mjs   # 重建上游素材索引
node pet/tools/sync-to-backend.mjs           # 同步后端副本（生成物入库）
node pet/tools/verify-sync.mjs               # 校验后端副本与本源一致
npx tsc --noEmit -p pet/tsconfig.json        # 本模块自检
npx vitest run pet                           # 本模块单测（根 vitest）
```
