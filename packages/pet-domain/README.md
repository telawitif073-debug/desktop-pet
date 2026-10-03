# @pet/domain —— 宠物领域共享包

宠物相关**纯逻辑**的唯一事实来源：生命体征（vitals）、宠物本体资源分类（resource）、
动作配置模型（actionModel）、动作播放决策（playback）。

包内不含任何 IO：不读文件系统、不用 IPC、不依赖 React/DOM/Node 内置、不写存储。

## 目录

```
packages/pet-domain/
├─ src/
│  ├─ index.ts        统一出口（facade）：只做再导出，不含逻辑
│  ├─ vitals.ts       四维规则/钳制/默认/序列化/归一化
│  ├─ resource.ts     宠物本体资源识别与包级判定（fail-closed）
│  ├─ actionModel.ts  动作配置模型 schemaVersion 2
│  ├─ playback.ts     动作播放决策（可注入随机源）
│  └─ *.spec.ts       对应单测（由仓库根的 vitest 统一执行）
├─ package.json
└─ tsconfig.json
```

## 三方如何消费（本仓库无 npm workspaces，全部走源码路径）

| 消费方 | 方式 | 入口 |
|---|---|---|
| 桌面端（Electron） | `src/pet/**` 是**再导出 shim**，相对路径指向本包 | `import { ... } from '../pet'` |
| 移动端（RN） | `mobile/metro.config.js` 的 `watchFolders` 含 `packages/` | `import { ... } from '../../../src/pet/vitals'` |
| 平台后端（NestJS） | **同步复制**到 `platform/backend/src/pet-domain/`（生成物，已 gitignore） | `import { ... } from './pet-domain'` |

后端为何用「同步复制」而不是直接相对 import：`platform/backend/tsconfig.json` 的 `include`
只有 `src`/`scripts`，一旦跨目录 import 本包，TS 会把 common root 上移到仓库根，
产物变成 `dist/platform/backend/src/main.js`，`node dist/main.js` 直接失效。
复制到后端 `src/` 之下则产物布局不变（`dist/main.js` 保持原位）。

复制动作由 `scripts/sync-pet-domain.mjs` 完成，并通过 `platform/backend/package.json`
的 `pre*` 钩子挂在 `build` / `start:dev` / `test` / `seed` / `migration:*` 之前，因此
**不要手工编辑 `platform/backend/src/pet-domain/`**（会被覆盖）。

## 修改须知

1. 只在这里改逻辑；改完跑仓库根 `npm test`（vitest 会拾取本目录的 `*.spec.ts`）。
2. 若新增/删除本包内的文件，检查 `scripts/sync-pet-domain.mjs` 的复制范围是否仍合适。
3. 后端如需用到新能力，先同步再在 `platform/backend/src/**` 里 import。
