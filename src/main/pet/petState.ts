/**
 * 宠物状态（四维）读写、衰减与互动（主进程适配层）
 * ---------------------------------------------------------------------------
 * 纯逻辑（衰减 / 喂食 / 玩耍 / 休息 / 门闸归位）全部来自共享模块 `@pet/domain`，
 * 本模块只负责「读 config → 调纯函数 → 写回 config」这一层 IO 编排。
 */
import {
  DEFAULT_VITALS,
  decay,
  feed,
  normalizeVitals,
  play,
  resetVitals,
  rest,
  type PetVitals,
  type VitalGates,
} from '@pet/domain';
import {
  DEFAULT_PET_SETTINGS,
  loadConfig,
  saveConfig,
  type PetFeatureSettings,
  type PetSettings,
} from '../config';
import type { PetRuntimeState } from '../../global.d';

/** 互动种类（与右键菜单一致） */
export type PetInteractionKind = 'feed' | 'play' | 'rest';

/** 功能开关 → 衰减门闸（关闭的维度冻结） */
export function petGates(features: PetFeatureSettings): VitalGates {
  return { feed: features.feedEnabled, play: features.playEnabled, rest: features.restEnabled };
}

/** 读取当前四维（损坏数据经共享模块消毒） */
export function loadPetState(): PetVitals {
  return normalizeVitals(loadConfig().pet?.petState);
}

/** 写回四维（整体替换语义） */
export function savePetState(vitals: PetVitals): PetVitals {
  const current = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const next: PetSettings = { ...current, petState: normalizeVitals(vitals) };
  saveConfig({ pet: next });
  return next.petState;
}

/** 定时 tick：先按门闸衰减，再把关闭维度锁定回基准值（幂等） */
export function tickPetState(vitals: PetVitals, features: PetFeatureSettings): PetVitals {
  const gates = petGates(features);
  return resetVitals(decay(normalizeVitals(vitals), gates), gates);
}

/** 互动：喂食 / 玩耍 / 休息（好感度增长与功能开关解耦，由共享模块保证） */
export function applyInteraction(vitals: PetVitals, kind: PetInteractionKind): PetVitals {
  const v = normalizeVitals(vitals);
  if (kind === 'feed') return feed(v);
  if (kind === 'play') return play(v);
  return rest(v);
}

/** 执行一次互动并落盘（供 pet:action IPC 直接调用） */
export function interactPetState(kind: PetInteractionKind): PetVitals {
  const current = loadConfig().pet;
  return savePetState(applyInteraction(current?.petState ?? DEFAULT_VITALS, kind));
}

/** 组装宠物运行时状态（四维 + 就绪态 + 当前宠物），供 pet:get-state 与广播使用 */
export function buildPetRuntimeState(): PetRuntimeState {
  const pet = loadConfig().pet;
  const currentId = pet?.currentPet ?? '';
  const current = pet?.downloadedPets?.find((p) => p.id === currentId) ?? null;
  return {
    vitals: normalizeVitals(pet?.petState),
    ready: pet?.petStateReady === true,
    current,
  };
}
