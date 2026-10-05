/**
 * 动作配额（主进程与渲染端共用的**纯常量 + 纯函数**）
 * ===========================================================================
 * 为什么单独放一份：配额要同时被主进程（`src/main/config.ts` 的校验）与渲染端
 * （动作面板/发布表单的计数与禁用态）使用，而 `src/main/config.ts` 依赖 `electron`，
 * 渲染端不能 import 它——否则把主进程模块拖进渲染包。
 *
 * 口径（2026-10 由「全应用动作总数 ≤ 15」改为按归属分别计数）：
 *  - 用户自建动作（手动上传 / AI 生成，无归属字段）→ {@link PET_ACTIONS_MAX_USER}
 *  - 宠物自带动作（内置演示宠物 / 平台安装宠物，带 `builtinPetId` / `petAssetId`）→ {@link PET_ACTIONS_MAX_PER_PET}
 * 两者互不挤占：修掉「用户已有 13 个动作时内置宠物装不上」的旧问题。
 * 该上限与内存/IPC/包体无关，纯属配额口径（见 `.trae/documents/pet-video-actions-and-per-pet-cap.md`）。
 */

/** 无归属动作的归属键（= 用户自建动作） */
export const ACTIONS_OWNER_USER = 'user';

/** 用户自建动作数量上限 */
export const PET_ACTIONS_MAX_USER = 15;

/** 单只宠物自带动作数量上限（每只宠物各算各的） */
export const PET_ACTIONS_MAX_PER_PET = 128;

/** 判定归属所需的最小结构（`PetAction` 天然满足） */
export interface ActionOwnerRef {
  builtinPetId?: string;
  petAssetId?: string;
}

/** 动作归属键：宠物自带动作归该宠物，其余归用户 */
export function actionOwnerKey(action: ActionOwnerRef): string {
  return action.builtinPetId ?? action.petAssetId ?? ACTIONS_OWNER_USER;
}

/** 某个归属键对应的上限 */
export function actionQuotaLimit(owner: string): number {
  return owner === ACTIONS_OWNER_USER ? PET_ACTIONS_MAX_USER : PET_ACTIONS_MAX_PER_PET;
}

/** 归属的中文标签（UI 用） */
export function actionOwnerLabel(owner: string, petName?: string | null): string {
  if (owner === ACTIONS_OWNER_USER) return '我的动作';
  return petName ? `${petName} 动作` : '宠物动作';
}
