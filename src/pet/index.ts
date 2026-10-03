/**
 * 宠物主体功能模块（pet domain）· 桌面端统一入口（facade）
 * ===========================================================================
 * 对外只暴露这一条 import 路径：
 *
 *   import { feed, evaluatePetPack, resolvePlayback } from '../pet';
 *
 * 实现已抽成共享包 `packages/pet-domain/`（桌面、移动、平台后端共用同一份纯逻辑），
 * 本文件是桌面侧的**再导出 shim**：只做转发，不含任何逻辑，也不改变既有调用点。
 *
 * 模块构成（实现见 packages/pet-domain/src/）：
 *  - `vitals`       生命体征（饱腹/心情/精力/好感）——纯函数，唯一事实来源。
 *  - `resource`     宠物本体资源识别与包级判定（角色枚举 + 判定顺序 + fail-closed）。
 *  - `actionModel`  动作配置模型（schemaVersion 2：动作池/权重/事件档位/旧格式迁移）。
 *  - `playback`     动作播放决策（优先级/不连播/镜像门控/档位轮换，可注入随机源）。
 *
 * 边界原则：模块内**只有纯逻辑**——不读文件系统、不用 IPC、不依赖 React、不写存储；
 * IO（探测、落盘、窗口、渲染、平台调用）全部留在各自的适配层（main / renderer / mobile）。
 */
export * from '../../packages/pet-domain/src';
