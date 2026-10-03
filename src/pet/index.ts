/**
 * 宠物主体功能模块（pet domain）· 统一入口
 * ===========================================================================
 * 宠物能力过去散落在 `src/shared`、`src/main`、`src/store`、`src/renderer`，
 * 现在收敛为**一个自包含模块**，对外只暴露这一条 import 路径：
 *
 *   import { feed, evaluatePetPack, resolvePlayback } from '../pet';
 *
 * 模块构成：
 *  - `./vitals`       生命体征（饱腹/心情/精力/好感）——纯函数，唯一事实来源，
 *                     桌面与移动共用（移动端经 `mobile/metro.config.js` 的 watchFolders 引用）。
 *  - `./resource`     宠物本体资源识别与包级判定（角色枚举 + 判定顺序 + fail-closed）。
 *  - `./actionModel`  动作配置模型（schemaVersion 2：动作池/权重/事件档位/旧格式迁移）。
 *  - `./playback`     动作播放决策（优先级/不连播/镜像门控/档位轮换，纯函数可注入随机源）。
 *
 * 边界原则：模块内**只有纯逻辑**——不读文件系统、不用 IPC、不依赖 React、不写存储；
 * IO（探测、落盘、窗口、渲染、平台调用）全部留在各自的适配层（main / renderer / mobile）。
 *
 * 迁移状态：Phase 1（模块落地 + 双跑）→ Phase 2（调用方改走本模块）→ **Phase 3（删除旧实现）**
 * 均已完成：旧路径 `src/shared/pet*` 与迁移期双跑代码已删除，本模块即唯一实现。
 */

// ── 主体：生命体征 ──────────────────────────────────────────────────────────
export * from './vitals';

// ── 形象：宠物本体资源识别与包级判定 ────────────────────────────────────────
export * from './resource';

// ── 动作：配置模型与播放决策 ────────────────────────────────────────────────
export * from './actionModel';
export * from './playback';
