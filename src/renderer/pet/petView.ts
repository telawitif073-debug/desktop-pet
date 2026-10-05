/**
 * 桌宠窗口展示逻辑（纯函数，与 React 解耦，便于 vitest 覆盖）
 * ---------------------------------------------------------------------------
 * 领域数据 → 展示数据的映射全部来自共享模块 `@pet/ui`（toPetAvatarView / vitalsRows /
 * interactionHint），本模块只负责桌面端特有的编排：把四维 + 就绪态 + 当前宠物
 * 合成成一个窗口视图对象，供 React 组件直接渲染。
 */
import { interactionHint, toPetAvatarView, vitalsRows, type PetAvatarView, type VitalsRow } from '@pet/ui';
import type { InstalledPet, PetRuntimeState } from '../../global.d';

/** 桌宠窗口视图（React 组件按此渲染，不做任何领域判断） */
export interface PetWindowView {
  /** 头像状态（档位 / 表情 / 主题色） */
  avatar: PetAvatarView;
  /** 四维状态行（顺序固定 hunger/mood/energy/affection） */
  vitals: VitalsRow[];
  /** 互动建议文案 */
  hint: string;
  /** 当前宠物展示名（未选用时给出占位文案） */
  petName: string;
  /** 形象/状态是否就绪 */
  ready: boolean;
}

/** 当前宠物展示名：未选用或名为空时回落占位文案 */
export function petDisplayName(current: InstalledPet | null | undefined): string {
  return current?.name?.trim() || '未选择宠物';
}

/** 合成桌宠窗口视图 */
export function toPetWindowView(state: Pick<PetRuntimeState, 'vitals' | 'ready' | 'current'>): PetWindowView {
  return {
    avatar: toPetAvatarView(state.vitals),
    vitals: vitalsRows(state.vitals),
    hint: interactionHint(state.vitals),
    petName: petDisplayName(state.current),
    ready: state.ready,
  };
}
