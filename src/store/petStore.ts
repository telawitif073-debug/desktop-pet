import { create } from 'zustand';
import {
  vitalsDualRun,
  normalizeVitals,
  serializeVitals,
  vitalsEqual,
  VITALS_STORAGE_KEY,
  HUNGER_ALERT_THRESHOLD,
  type PetVitals,
  type VitalGates,
} from '../pet';

// 宠物状态接口
interface PetState extends PetVitals {
  // 瞬时字段（不持久化）：精灵表五状态动画的绑定依据
  lastFeedAt: number;  // 最近一次喂食时间戳（eating 动画播放 4s）
  lastPlayAt: number;  // 最近一次玩耍时间戳（playing 动画播放 4s）
  lastRestAt: number;  // 最近一次休息时间戳（resting 动画播放 6s）
  moving: boolean;     // 主进程 wander 漫步进行中（moving 动画）
  // 操作方法
  feed: () => void;    // 喂食
  play: () => void;    // 玩耍
  rest: () => void;    // 休息
  decay: (gates?: VitalGates) => void; // 自然衰减（定时调用），gates 为 false 的项冻结不衰减
  /** 功能开关关闭时把对应数值锁定回默认 80（幂等，历史低值一并归位）：feed=饥饿 play=心情 rest=精力 */
  resetVitals: (gates: VitalGates) => void;
  load: (state: Partial<PetState>) => void; // 加载持久化数据
  setMoving: (v: boolean) => void; // 漫步状态回报（pet:wander-state）
  /** 聊天联动：按情绪词调整心情（±8），随 localStorage 持久化 */
  adjustMood: (delta: number) => void;
  /** 聊天联动：有效回复好感 +1（与喂食/玩耍同口径的固定增长） */
  addAffection: (amount: number) => void;
}

// 从 localStorage 读取初始状态。
// 迁移说明：四维的解析/兜底默认值已收归 `src/pet`（宠物主体功能模块）的 normalizeVitals，
// 本文件只负责「读存储」这一 IO 责任，不再自己重写默认值。
const loadPersistedVitals = (): PetVitals => {
  try {
    const saved = localStorage.getItem(VITALS_STORAGE_KEY);
    return normalizeVitals(saved ? JSON.parse(saved) : {});
  } catch {
    return normalizeVitals({});
  }
};

/** 从 store 状态里取出四维（瞬时字段不参与宠物主体逻辑） */
const vitalsOf = (s: PetState): PetVitals => ({
  hunger: s.hunger,
  mood: s.mood,
  energy: s.energy,
  affection: s.affection,
});

/** 四维数值落盘（增量调整与互动复用；写入失败忽略，不影响内存状态） */
const persistVitals = (v: PetVitals): void => {
  try {
    localStorage.setItem(VITALS_STORAGE_KEY, serializeVitals(v));
  } catch {
    /* 存储不可用时忽略 */
  }
};

const initial = loadPersistedVitals();

export const usePetStore = create<PetState>((set) => ({
  hunger: initial.hunger,
  mood: initial.mood,
  energy: initial.energy,
  affection: initial.affection,
  lastFeedAt: 0,
  lastPlayAt: 0,
  lastRestAt: 0,
  moving: false,

  feed: () => set((s) => {
    // 好感度增长与功能开关无关（开关只控制显隐）：喂食固定 +2
    const next = vitalsDualRun.feed(vitalsOf(s));
    persistVitals(next);
    return { ...s, ...next, lastFeedAt: Date.now() };
  }),

  play: () => set((s) => {
    // 好感度增长与功能开关无关（开关只控制显隐）：玩耍固定 +5
    const next = vitalsDualRun.play(vitalsOf(s));
    persistVitals(next);
    return { ...s, ...next, lastPlayAt: Date.now() };
  }),

  rest: () => set((s) => {
    const next = vitalsDualRun.rest(vitalsOf(s));
    persistVitals(next);
    return { ...s, ...next, lastRestAt: Date.now() };
  }),

  decay: (gates) => set((s) => {
    const next = vitalsDualRun.decay(vitalsOf(s), gates);
    // 每10次decay才保存一次，避免频繁写localStorage
    if (Math.random() < 0.1) persistVitals(next);
    return { ...s, ...next };
  }),

  resetVitals: (gates) => set((s) => {
    const current = vitalsOf(s);
    const next = vitalsDualRun.resetVitals(current, gates);
    // 全部已归位：返回原 state，避免每 5s 触发订阅更新
    if (vitalsEqual(current, next)) return s;
    persistVitals(next);
    return { ...s, ...next };
  }),

  load: (state) => set((s) => ({ ...s, ...state })),

  setMoving: (v) => set((s) => (s.moving === v ? s : { ...s, moving: v })),

  adjustMood: (delta) => set((s) => {
    const next = vitalsDualRun.adjustMood(vitalsOf(s), delta);
    persistVitals(next);
    return { ...s, ...next };
  }),

  addAffection: (amount) => set((s) => {
    const next = vitalsDualRun.addAffection(vitalsOf(s), amount);
    persistVitals(next);
    return { ...s, ...next };
  }),
}));

/** 状态条「饱腹过低」的统一阈值（UI 口径集中，避免组件里再写魔法数） */
export const PET_HUNGER_ALERT_THRESHOLD = HUNGER_ALERT_THRESHOLD;
