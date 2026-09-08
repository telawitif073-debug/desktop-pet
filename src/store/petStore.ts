import { create } from 'zustand';

// 宠物状态接口
interface PetState {
  hunger: number;      // 饥饿值 0-100，100为饱
  mood: number;        // 心情值 0-100，100为极好
  energy: number;      // 精力值 0-100，100为充沛
  affection: number;   // 好感度 0-100
  // 操作方法
  feed: () => void;    // 喂食
  play: () => void;    // 玩耍
  rest: () => void;    // 休息
  decay: () => void;   // 自然衰减（定时调用）
  load: (state: Partial<PetState>) => void; // 加载持久化数据
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

  feed: () => set((s) => {
    const newState = { ...s, hunger: Math.min(100, s.hunger + 15), affection: Math.min(100, s.affection + 2) };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  play: () => set((s) => {
    const newState = { ...s, mood: Math.min(100, s.mood + 20), energy: Math.max(0, s.energy - 10), affection: Math.min(100, s.affection + 5) };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  rest: () => set((s) => {
    const newState = { ...s, energy: Math.min(100, s.energy + 30), hunger: Math.max(0, s.hunger - 5) };
    localStorage.setItem('pet-state', JSON.stringify({
      hunger: newState.hunger,
      mood: newState.mood,
      energy: newState.energy,
      affection: newState.affection,
    }));
    return newState;
  }),

  decay: () => set((s) => {
    const newState = {
      ...s,
      hunger: Math.max(0, s.hunger - 0.5),
      mood: Math.max(0, s.mood - 0.2),
      energy: Math.max(0, s.energy - 0.1),
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

  load: (state) => set((s) => ({ ...s, ...state })),
}));
