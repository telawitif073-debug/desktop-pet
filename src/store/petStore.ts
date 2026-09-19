import { create } from 'zustand';

// 宠物状态接口
interface PetState {
  hunger: number;      // 饥饿值 0-100，100为饱
  mood: number;        // 心情值 0-100，100为极好
  energy: number;      // 精力值 0-100，100为充沛
  affection: number;   // 好感度 0-100
  // 瞬时字段（不持久化）：精灵表五状态动画的绑定依据
  lastFeedAt: number;  // 最近一次喂食时间戳（eating 动画播放 4s）
  lastPlayAt: number;  // 最近一次玩耍时间戳（playing 动画播放 4s）
  lastRestAt: number;  // 最近一次休息时间戳（resting 动画播放 6s）
  moving: boolean;     // 主进程 wander 漫步进行中（moving 动画）
  // 操作方法
  feed: () => void;    // 喂食
  play: () => void;    // 玩耍
  rest: () => void;    // 休息
  decay: (gates?: { feed: boolean; play: boolean; rest: boolean }) => void; // 自然衰减（定时调用），gates 为 false 的项冻结不衰减
  /** 功能开关关闭时把对应数值锁定回默认 80（幂等，历史低值一并归位）：feed=饥饿 play=心情 rest=精力 */
  resetVitals: (gates: { feed: boolean; play: boolean; rest: boolean }) => void;
  load: (state: Partial<PetState>) => void; // 加载持久化数据
  setMoving: (v: boolean) => void; // 漫步状态回报（pet:wander-state）
}

// 从 localStorage 读取初始状态
const loadPersistedState = (): Partial<PetState> => {
  try {
    const saved = localStorage.getItem('pet-state');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
};

const initialPersisted = loadPersistedState();

export const usePetStore = create<PetState>((set) => ({
  hunger: initialPersisted.hunger ?? 80,
  mood: initialPersisted.mood ?? 80,
  energy: initialPersisted.energy ?? 80,
  affection: initialPersisted.affection ?? 50,
  lastFeedAt: 0,
  lastPlayAt: 0,
  lastRestAt: 0,
  moving: false,

  feed: () => set((s) => {
    // 好感度增长与功能开关无关（开关只控制显隐）：喂食固定 +2
    const newState = { ...s, hunger: Math.min(100, s.hunger + 15), affection: Math.min(100, s.affection + 2), lastFeedAt: Date.now() };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  play: () => set((s) => {
    // 好感度增长与功能开关无关（开关只控制显隐）：玩耍固定 +5
    const newState = { ...s, mood: Math.min(100, s.mood + 20), energy: Math.max(0, s.energy - 10), affection: Math.min(100, s.affection + 5), lastPlayAt: Date.now() };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  rest: () => set((s) => {
    const newState = { ...s, energy: Math.min(100, s.energy + 30), hunger: Math.max(0, s.hunger - 5), lastRestAt: Date.now() };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  decay: (gates) => set((s) => {
    const g = gates ?? { feed: true, play: true, rest: true };
    const newState = {
      ...s,
      hunger: g.feed ? Math.max(0, s.hunger - 0.5) : s.hunger,
      mood: g.play ? Math.max(0, s.mood - 0.2) : s.mood,
      energy: g.rest ? Math.max(0, s.energy - 0.1) : s.energy,
    };
    // 每10次decay才保存一次，避免频繁写localStorage
    if (Math.random() < 0.1) {
      localStorage.setItem('pet-state', JSON.stringify({
        hunger: newState.hunger,
        mood: newState.mood,
        energy: newState.energy,
        affection: newState.affection,
      }));
    }
    return newState;
  }),

  resetVitals: (gates) => set((s) => {
    const needHunger = !gates.feed && s.hunger !== 80;
    const needMood = !gates.play && s.mood !== 80;
    const needEnergy = !gates.rest && s.energy !== 80;
    // 全部已归位：返回原 state，避免每 5s 触发订阅更新
    if (!needHunger && !needMood && !needEnergy) return s;
    const newState = {
      ...s,
      hunger: needHunger ? 80 : s.hunger,
      mood: needMood ? 80 : s.mood,
      energy: needEnergy ? 80 : s.energy,
    };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  load: (state) => set((s) => ({ ...s, ...state })),

  setMoving: (v) => set((s) => (s.moving === v ? s : { ...s, moving: v })),
}));
