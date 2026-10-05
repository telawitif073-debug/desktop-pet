import { create } from 'zustand';
import {
  normalizeVitals,
  HUNGER_ALERT_THRESHOLD,
  type PetVitals,
  type VitalGates,
} from '@pet/domain';

/**
 * 桌宠渲染端的四维镜像（zustand）。
 * ---------------------------------------------------------------------------
 * 与旧实现的差异：**衰减与落盘的主责已上移到主进程**（`src/main/pet/petState.ts` 每 5s 衰减、
 * 每 30s 落盘并触发 config 云同步）。本 store 因此退化为「主进程广播状态的本地镜像」，
 * 只额外保留互动时间戳（用于播放吃饭/玩耍/休息动画）与漫步标记；数值本身不再本地重算。
 */
interface PetState extends PetVitals {
  // 瞬时字段（不持久化）：互动动画播放依据
  lastFeedAt: number; // 最近一次喂食时间戳（吃饭动画播放几秒）
  lastPlayAt: number; // 最近一次玩耍时间戳
  lastRestAt: number; // 最近一次休息时间戳
  moving: boolean; // 主进程漫步进行中
  /** 用主进程广播的四维覆盖本地镜像 */
  loadVitals: (vitals: PetVitals) => void;
  /** 记录一次互动（触发对应动画） */
  markInteraction: (kind: 'feed' | 'play' | 'rest') => void;
  /** 漫步状态回报（pet:wander-state） */
  setMoving: (v: boolean) => void;
  /** 功能开关关闭时把对应数值锁定回默认（本地镜像用；主进程同样会归位） */
  resetVitals: (gates: VitalGates) => void;
}

/** 从主进程状态取出四维（瞬时字段不参与） */
const vitalsOf = (s: PetState): PetVitals => ({
  hunger: s.hunger,
  mood: s.mood,
  energy: s.energy,
  affection: s.affection,
});

const initial = normalizeVitals({});

export const usePetStore = create<PetState>((set) => ({
  hunger: initial.hunger,
  mood: initial.mood,
  energy: initial.energy,
  affection: initial.affection,
  lastFeedAt: 0,
  lastPlayAt: 0,
  lastRestAt: 0,
  moving: false,

  loadVitals: (vitals) => set((s) => {
    const next = normalizeVitals(vitals);
    const same =
      s.hunger === next.hunger && s.mood === next.mood && s.energy === next.energy && s.affection === next.affection;
    return same ? s : { ...s, ...next };
  }),

  markInteraction: (kind) =>
    set((s) => {
      if (kind === 'feed') return { ...s, lastFeedAt: Date.now() };
      if (kind === 'play') return { ...s, lastPlayAt: Date.now() };
      return { ...s, lastRestAt: Date.now() };
    }),

  setMoving: (v) => set((s) => (s.moving === v ? s : { ...s, moving: v })),

  resetVitals: (gates) =>
    set((s) => {
      const v = vitalsOf(s);
      const needHunger = !gates.feed && v.hunger !== 80;
      const needMood = !gates.play && v.mood !== 80;
      const needEnergy = !gates.rest && v.energy !== 80;
      if (!needHunger && !needMood && !needEnergy) return s;
      return {
        ...s,
        hunger: needHunger ? 80 : s.hunger,
        mood: needMood ? 80 : s.mood,
        energy: needEnergy ? 80 : s.energy,
      };
    }),
}));

/** 状态条「饱腹过低」的统一阈值（UI 口径集中，避免组件里再写魔法数） */
export const PET_HUNGER_ALERT_THRESHOLD = HUNGER_ALERT_THRESHOLD;
