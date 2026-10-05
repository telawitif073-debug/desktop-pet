/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物主体功能域（pet domain）· 共享包统一入口
 * ===========================================================================
 * 本包是「宠物」领域纯逻辑的**唯一事实来源**，被三方共同消费：
 *
 *   - 桌面端：`src/pet/index.ts` 是再导出 shim（`export * from '../../pet/domain'`）；
 *   - 移动端：经 `mobile/metro.config.js` 的 watchFolders 引用（`mobile/src/pet/domain.ts` shim）；
 *   - 平台前端：vite alias `@pet`（+ `server.fs.allow`）引用；
 *   - 平台后端：`pet/tools/sync-to-backend.mjs` 把本目录同步复制到
 *     `platform/backend/src/pet-domain/`（后端构建受 `rootDir` 限制，不能跨目录直接 import）。
 *
 * 模块构成：
 *  - `./vitals`       生命体征（饱腹/心情/精力/好感）——纯函数。
 *  - `./resource`     宠物本体资源识别与包级判定（角色枚举 + 判定顺序 + fail-closed）。
 *  - `./probe`        图片/视频「肩部」头部探测（宽高/帧数/alpha）——桌面与服务端共用。
 *  - `./actionModel`  动作配置模型（schemaVersion 2：动作池/权重/事件档位/旧格式迁移）。
 *  - `./playback`     动作播放决策（优先级/不连播/镜像门控/档位轮换，可注入随机源）。
 *  - `./pack`         宠物包清单模型（解析/校验/条目摘要串）——不读文件、不算 hash。
 *
 * 边界原则：包内**只有纯逻辑**——不读文件系统、不用 IPC、不依赖 React/DOM/Node 内置、
 * 不写存储；IO（探测、落盘、窗口、渲染、平台调用）全部留在各自的适配层。
 */

// ── 主体：生命体征 ──────────────────────────────────────────────────────────
export * from './vitals';

// ── 形象：宠物本体资源识别与包级判定 ────────────────────────────────────────
export * from './resource';

// ── 形象：图片/视频头部探测（读字节得宽高/帧数/alpha，桌面与服务端共用）──────
export * from './probe';

// ── 动作：配置模型与播放决策 ────────────────────────────────────────────────
export * from './actionModel';
export * from './playback';

// ── 分发：宠物包清单 ────────────────────────────────────────────────────────
export * from './pack';
