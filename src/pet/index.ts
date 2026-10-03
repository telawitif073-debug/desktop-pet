/**
 * 宠物主体功能模块（pet domain）· 统一入口
 * ===========================================================================
 * 目标：把过去散落在 `src/shared`、`src/main`、`src/store`、`src/renderer` 的宠物能力
 * 收敛为**一个自包含模块**，对外只暴露这一条 import 路径：
 *
 *   import { feed, evaluatePetPack, resolvePlayback } from '../pet';
 *
 * 模块划分：
 *  - `./vitals`            宠物生命体征（饱腹/心情/精力/好感）——本次新建的**唯一**事实来源，
 *                          取代桌面 `store/petStore` 与移动 `store/appStore` 的两份复制实现。
 *  - `./appearance`        （见 `../shared/petResource`）宠物本体资源识别与包级判定。
 *  - `./actions`           （见 `../shared/petActionModel` + `../shared/petPlayback`）动作配置与播放决策。
 *  - `./migration/*`       【临时】双跑比对（Phase 3 删除）。
 *
 * 迁移阶段（与用户确认的「分阶段：新模块双跑后切换」一致）：
 *   Phase 1（本次）  新模块 + 双跑接入，旧实现保留且仍可比对；
 *   Phase 2          调用方逐个改走本模块，旧实现只作为比对基准；
 *   Phase 3          删除双跑与旧实现（`src/data/petResource`、`src/store/petStore` 旧公式等）；
 *   Phase 4          平台后端 / 移动端 / 数据库表与线上资源的替换与删除。
 * 详细清单见 `.trae/documents/pet-domain-rebuild.md`。
 */

// ── 主体：生命体征（新实现） ────────────────────────────────────────────────
export * from './vitals';

// ── 形象：宠物本体资源识别与包级判定 ────────────────────────────────────────
export * from '../shared/petResource';

// ── 动作：配置模型与播放决策 ────────────────────────────────────────────────
export * from '../shared/petActionModel';
export * from '../shared/petPlayback';

// ── 迁移期：双跑比对（Phase 3 删除） ────────────────────────────────────────
export * as vitalsDualRun from './migration/dualRunVitals';
