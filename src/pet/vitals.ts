/**
 * 宠物主体功能模块 · 四维生命体征（vitals）
 * ===========================================================================
 * 这是「新的宠物主体功能模块」的第一块：把过去**两处独立实现**（桌面 `src/store/petStore.ts`
 * 与移动 `mobile/src/store/appStore.ts`）的状态规则收敛为**唯一的纯函数事实来源**。
 *
 * 设计约束（与旧实现逐字等价，由 `vitals.spec.ts` 的等价性用例钉住）：
 *  - 全部函数为纯函数：输入 vitals（+ 可选参数）→ 返回新的 vitals，不做 IO、不读时钟、不写存储；
 *    「什么时候调用」「写不写 localStorage」「要不要 setState」由调用方决定。
 *  - 数值一律钳制在 [0, 100]；好感度只增不减（没有任何衰减路径）。
 *  - 好感度增长与功能开关**完全解耦**：开关只控制显隐与衰减冻结，不影响数值逻辑。
 *  - `resetVitals` 在「无需归位」时**返回入参引用本身**，保留旧实现里 zustand 免订阅更新的优化。
 */

/** 四维数值（饱腹 / 心情 / 精力 / 好感） */
export interface PetVitals {
  /** 饱腹（饥饿值）0-100，100 为饱 */
  hunger: number;
  /** 心情 0-100，100 为极好 */
  mood: number;
  /** 精力 0-100，100 为充沛 */
  energy: number;
  /** 好感度 0-100（只增不减） */
  affection: number;
}

/**
 * 功能开关门闸：`false` 表示对应维度**冻结**（不衰减、并被锁定回 {@link LOCKED_VALUE}）。
 * feed=饱腹 play=心情 rest=精力 —— 与旧实现（App.tsx 传参、petStore 消费）同口径。
 */
export interface VitalGates {
  feed: boolean;
  play: boolean;
  rest: boolean;
}

export const VITAL_MIN = 0;
export const VITAL_MAX = 100;

/** 新宠物的初始四维（与旧实现的默认值一致：80/80/80/50） */
export const DEFAULT_VITALS: Readonly<PetVitals> = Object.freeze({
  hunger: 80,
  mood: 80,
  energy: 80,
  affection: 50,
});

/** 开关关闭时对应维度的锁定值（历史上是 80，与 DEFAULT 同值但语义独立） */
export const LOCKED_VALUE = 80;

/** 桌面渲染端 localStorage 的持久化键（移动端走 AsyncStorage，不共用） */
export const VITALS_STORAGE_KEY = 'pet-state';

/** 每日衰减系数（每 5s tick 一次）：hunger -0.5 / mood -0.2 / energy -0.1 */
export const DECAY_PER_TICK: Readonly<{ hunger: number; mood: number; energy: number }> = Object.freeze({
  hunger: 0.5,
  mood: 0.2,
  energy: 0.1,
});

/** 数值钳制到 [0,100]（统一入口，避免各处 Math.min/Math.max 写法漂移） */
export const clampVital = (value: number): number => Math.min(VITAL_MAX, Math.max(VITAL_MIN, value));

/** 「偏低」告警阈值：渲染端把宠物调灰、主动搭话提示、状态条档位共用同一口径 */
export const VITAL_ALERT_THRESHOLD = 30;

/** 饱腹专用别名（语义化调用点：调灰看的是饱腹） */
export const HUNGER_ALERT_THRESHOLD = VITAL_ALERT_THRESHOLD;

/** 四个维度名（遍历/序列化/调试用） */
export const VITAL_KEYS = ['hunger', 'mood', 'energy', 'affection'] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

/** 把任意输入归一化成合法 vitals（用于读取持久化数据/云端数据，容错但不臆造） */
export function normalizeVitals(raw: unknown): PetVitals {
  const src = (raw ?? {}) as Partial<Record<VitalKey, unknown>>;
  const pick = (key: VitalKey, fallback: number): number => {
    const value = src[key];
    return typeof value === 'number' && Number.isFinite(value) ? clampVital(value) : fallback;
  };
  return {
    hunger: pick('hunger', DEFAULT_VITALS.hunger),
    mood: pick('mood', DEFAULT_VITALS.mood),
    energy: pick('energy', DEFAULT_VITALS.energy),
    affection: pick('affection', DEFAULT_VITALS.affection),
  };
}

/** 仅序列化四维（瞬时字段如 lastFeedAt 不落盘） */
export function serializeVitals(v: PetVitals): string {
  return JSON.stringify({ hunger: v.hunger, mood: v.mood, energy: v.energy, affection: v.affection });
}

/** 四维逐值相等（用于「无变化则返回原引用」的判定与双跑比对） */
export function vitalsEqual(a: PetVitals, b: PetVitals): boolean {
  return a.hunger === b.hunger && a.mood === b.mood && a.energy === b.energy && a.affection === b.affection;
}

/** 是否与默认值完全一致（用于测试与调试） */
export function isDefaultVitals(v: PetVitals): boolean {
  return (
    v.hunger === DEFAULT_VITALS.hunger &&
    v.mood === DEFAULT_VITALS.mood &&
    v.energy === DEFAULT_VITALS.energy &&
    v.affection === DEFAULT_VITALS.affection
  );
}

/** 好感度增量（固定值；与功能开关**完全解耦**——开关只控制显隐与冻结） */
export const AFFECTION_GAIN = Object.freeze({ feed: 2, play: 5, chatReply: 1 });

/** 喂食：饱腹 +15、好感 +2（好感与开关无关） */
export function feed(v: PetVitals): PetVitals {
  return { ...v, hunger: clampVital(v.hunger + 15), affection: clampVital(v.affection + AFFECTION_GAIN.feed) };
}

/** 玩耍：心情 +20、精力 -10、好感 +5（好感与开关无关） */
export function play(v: PetVitals): PetVitals {
  return { ...v, mood: clampVital(v.mood + 20), energy: clampVital(v.energy - 10), affection: clampVital(v.affection + AFFECTION_GAIN.play) };
}

/** 休息：精力 +30、饱腹 -5 */
export function rest(v: PetVitals): PetVitals {
  return { ...v, energy: clampVital(v.energy + 30), hunger: clampVital(v.hunger - 5) };
}

/**
 * 自然衰减（定时调用）：只作用于饱腹/心情/精力，好感度**不衰减**。
 * `gates` 缺省表示全部门闸打开（与旧实现一致）。
 */
export function decay(v: PetVitals, gates: VitalGates = { feed: true, play: true, rest: true }): PetVitals {
  return {
    ...v,
    hunger: gates.feed ? Math.max(VITAL_MIN, v.hunger - DECAY_PER_TICK.hunger) : v.hunger,
    mood: gates.play ? Math.max(VITAL_MIN, v.mood - DECAY_PER_TICK.mood) : v.mood,
    energy: gates.rest ? Math.max(VITAL_MIN, v.energy - DECAY_PER_TICK.energy) : v.energy,
  };
}

/**
 * 功能开关关闭时把对应维度锁定回 {@link LOCKED_VALUE}（幂等，历史低值一并归位）。
 * **无需归位时返回入参引用**，保留调用方（zustand）跳过无意义渲染的能力。
 */
export function resetVitals(v: PetVitals, gates: VitalGates): PetVitals {
  const needHunger = !gates.feed && v.hunger !== LOCKED_VALUE;
  const needMood = !gates.play && v.mood !== LOCKED_VALUE;
  const needEnergy = !gates.rest && v.energy !== LOCKED_VALUE;
  if (!needHunger && !needMood && !needEnergy) return v;
  return {
    ...v,
    hunger: needHunger ? LOCKED_VALUE : v.hunger,
    mood: needMood ? LOCKED_VALUE : v.mood,
    energy: needEnergy ? LOCKED_VALUE : v.energy,
  };
}

/** 聊天联动：按情绪词调整心情（±8 由 `moodLink` 决定，这里只负责钳制） */
export function adjustMood(v: PetVitals, delta: number): PetVitals {
  return { ...v, mood: clampVital(v.mood + delta) };
}

/** 聊天/互动联动：好感度增减（有效回复 +1、喂食 +2、玩耍 +5；无衰减） */
export function addAffection(v: PetVitals, amount: number): PetVitals {
  return { ...v, affection: clampVital(v.affection + amount) };
}

/** 四维的展示档位（状态条文案用；集中口径，避免组件各自判断） */
export function describeVital(value: number): 'low' | 'mid' | 'high' {
  if (value < VITAL_ALERT_THRESHOLD) return 'low';
  if (value < 70) return 'mid';
  return 'high';
}
