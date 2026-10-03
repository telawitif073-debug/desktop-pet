/**
 * 【临时·迁移期】旧 vitals 实现的冻结副本
 * ===========================================================================
 * 来源：`src/store/petStore.ts`（2026-10-03 迁移前版本）逐字摘录的纯函数化版本。
 * 存在的**唯一目的**是让「双跑（dual-run）」有可比对的基准：新模块 `../vitals` 与这里
 * 同时计算，结果必须一致；不一致即打点告警（见 `dualRunVitals.ts`）。
 *
 * 删除时机：Phase 3「切换并删除旧实现」——当 `src/pet/dualRun.ts` 的 divergence 计数
 * 连续多日/多轮回归为 0，且 `petStore` 已直连新模块后，本文件与 `dualRunVitals.ts`
 * 一并删除。在此之前**禁止修改本文件**（改了基准就失去意义）。
 */
import type { PetVitals, VitalGates } from '../vitals';

const clamp = (n: number): number => Math.min(100, Math.max(0, n));

/** 旧：喂食 hunger+15 / affection+2 */
export function feedLegacy(v: PetVitals): PetVitals {
  return { ...v, hunger: Math.min(100, v.hunger + 15), affection: Math.min(100, v.affection + 2) };
}

/** 旧：玩耍 mood+20 / energy-10 / affection+5 */
export function playLegacy(v: PetVitals): PetVitals {
  return { ...v, mood: Math.min(100, v.mood + 20), energy: Math.max(0, v.energy - 10), affection: Math.min(100, v.affection + 5) };
}

/** 旧：休息 energy+30 / hunger-5 */
export function restLegacy(v: PetVitals): PetVitals {
  return { ...v, energy: Math.min(100, v.energy + 30), hunger: Math.max(0, v.hunger - 5) };
}

/** 旧：decay（缺省门闸全开） */
export function decayLegacy(v: PetVitals, gates: VitalGates = { feed: true, play: true, rest: true }): PetVitals {
  return {
    ...v,
    hunger: gates.feed ? Math.max(0, v.hunger - 0.5) : v.hunger,
    mood: gates.play ? Math.max(0, v.mood - 0.2) : v.mood,
    energy: gates.rest ? Math.max(0, v.energy - 0.1) : v.energy,
  };
}

/** 旧：resetVitals（无需归位时返回原引用） */
export function resetVitalsLegacy(v: PetVitals, gates: VitalGates): PetVitals {
  const needHunger = !gates.feed && v.hunger !== 80;
  const needMood = !gates.play && v.mood !== 80;
  const needEnergy = !gates.rest && v.energy !== 80;
  if (!needHunger && !needMood && !needEnergy) return v;
  return {
    ...v,
    hunger: needHunger ? 80 : v.hunger,
    mood: needMood ? 80 : v.mood,
    energy: needEnergy ? 80 : v.energy,
  };
}

/** 旧：adjustMood（钳制到 [0,100]） */
export function adjustMoodLegacy(v: PetVitals, delta: number): PetVitals {
  return { ...v, mood: clamp(v.mood + delta) };
}

/** 旧：addAffection（钳制到 [0,100]） */
export function addAffectionLegacy(v: PetVitals, amount: number): PetVitals {
  return { ...v, affection: clamp(v.affection + amount) };
}

/** 旧：读取持久化数据时的兜底默认值（80/80/80/50） */
export function loadVitalsLegacy(raw: unknown): PetVitals {
  const src = (raw ?? {}) as Partial<PetVitals>;
  return {
    hunger: typeof src.hunger === 'number' ? src.hunger : 80,
    mood: typeof src.mood === 'number' ? src.mood : 80,
    energy: typeof src.energy === 'number' ? src.energy : 80,
    affection: typeof src.affection === 'number' ? src.affection : 50,
  };
}
