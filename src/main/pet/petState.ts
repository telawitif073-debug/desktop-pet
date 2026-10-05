/**
 * 宠物状态（四维）读写、衰减与互动（主进程适配层）
 * ---------------------------------------------------------------------------
 * 纯逻辑（衰减 / 喂食 / 玩耍 / 休息 / 门闸归位）全部来自共享模块 `@pet/domain`，
 * 本模块只负责「读 config → 调纯函数 → 写回 config」这一层 IO 编排，外加：
 *  - 5 秒一次的**衰减定时器**（内存态逐帧衰减；每 6 次落盘一次并触发 config 云同步）；
 *  - `buildPetRuntimeState` 供 pet:get-state 与广播（始终读内存态，保证衰减可见）。
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
import { scheduleUpload } from '../cloudSync';
import type { PetRuntimeState } from '../../global.d';

/** 互动种类（与右键菜单一致） */
export type PetInteractionKind = 'feed' | 'play' | 'rest';

/** 每 5s 衰减一次（与共享模块 DECAY_PER_TICK 口径一致） */
const DECAY_TICK_MS = 5000;
/** 每 6 次 tick（30s）落盘一次，避免频繁写盘 */
const PERSIST_EVERY_TICKS = 6;

/** 内存态四维：定时衰减期间以避免每 tick 读盘漂移（null = 未启动衰减，读 config） */
let liveVitals: PetVitals | null = null;
let ticksSincePersist = 0;
let decayTimer: NodeJS.Timeout | null = null;

/** 功能开关 → 衰减门闸（关闭的维度冻结） */
export function petGates(features: PetFeatureSettings): VitalGates {
  return { feed: features.feedEnabled, play: features.playEnabled, rest: features.restEnabled };
}

/** 读取当前四维（损坏数据经共享模块消毒） */
export function loadPetState(): PetVitals {
  return normalizeVitals(loadConfig().pet?.petState);
}

/** 当前生效的四维（优先内存态） */
function currentVitals(): PetVitals {
  return liveVitals ?? loadPetState();
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

/** 执行一次互动并落盘 + 触发云同步（供 pet:action IPC 直接调用） */
export function interactPetState(kind: PetInteractionKind): PetVitals {
  const next = applyInteraction(currentVitals(), kind);
  liveVitals = next;
  ticksSincePersist = 0;
  savePetState(next);
  scheduleUpload('config');
  return next;
}

/**
 * 启动衰减定时器（幂等）：每 5s 衰减一次内存态四维，onTick 收到新值（供主进程广播）；
 * 每 30s 落盘一次并调度 config 云同步。宠物总开关关闭时不衰减。
 */
export function startPetStateDecay(onTick?: (vitals: PetVitals) => void): void {
  if (decayTimer) return;
  liveVitals = loadPetState();
  decayTimer = setInterval(() => {
    const pet = loadConfig().pet;
    if (pet && pet.petSystemEnabled === false) return;
    if (!liveVitals) liveVitals = loadPetState();
    liveVitals = tickPetState(liveVitals, pet?.petFeatures ?? DEFAULT_PET_SETTINGS.petFeatures);
    ticksSincePersist += 1;
    if (ticksSincePersist >= PERSIST_EVERY_TICKS) {
      ticksSincePersist = 0;
      savePetState(liveVitals);
      scheduleUpload('config');
    }
    onTick?.(liveVitals);
  }, DECAY_TICK_MS);
}

/** 停止衰减定时器（退出时调用） */
export function stopPetStateDecay(): void {
  if (decayTimer) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
}

/** 组装宠物运行时状态（四维 + 就绪态 + 当前宠物），供 pet:get-state 与广播使用 */
export function buildPetRuntimeState(): PetRuntimeState {
  const pet = loadConfig().pet;
  const currentId = pet?.currentPet ?? '';
  const current = pet?.downloadedPets?.find((p) => p.id === currentId) ?? null;
  return {
    vitals: currentVitals(),
    ready: pet?.petStateReady === true,
    current,
  };
}
