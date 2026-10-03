import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VITALS,
  LOCKED_VALUE,
  DECAY_PER_TICK,
  HUNGER_ALERT_THRESHOLD,
  VITAL_MAX,
  VITAL_MIN,
  clampVital,
  normalizeVitals,
  serializeVitals,
  vitalsEqual,
  isDefaultVitals,
  feed,
  play,
  rest,
  decay,
  resetVitals,
  adjustMood,
  addAffection,
  describeVital,
  type PetVitals,
  type VitalGates,
} from './vitals';

const V = (hunger: number, mood: number, energy: number, affection: number): PetVitals => ({ hunger, mood, energy, affection });

const GATES: VitalGates[] = [
  { feed: true, play: true, rest: true },
  { feed: false, play: true, rest: true },
  { feed: true, play: false, rest: true },
  { feed: true, play: true, rest: false },
  { feed: false, play: false, rest: false },
];

/** 覆盖边界：0 / 极小 / 阈值 / 上界 / 非整数 */
const VALUES = [0, 1, 5, 29.5, 30, 79.5, 80, 99.9, 100];

describe('宠物主体模块 · 生命体征规则', () => {
  it('默认值为 80/80/80/50，锁定值为 80', () => {
    expect(DEFAULT_VITALS).toEqual({ hunger: 80, mood: 80, energy: 80, affection: 50 });
    expect(LOCKED_VALUE).toBe(80);
  });

  it('喂食：饱腹 +15、好感 +2，且全部钳制在 100', () => {
    expect(feed(V(50, 50, 50, 50))).toEqual(V(65, 50, 50, 52));
    expect(feed(V(95, 80, 80, 99))).toEqual(V(100, 80, 80, 100));
  });

  it('玩耍：心情 +20、精力 -10、好感 +5，钳制在 [0,100]', () => {
    expect(play(V(50, 50, 50, 50))).toEqual(V(50, 70, 40, 55));
    expect(play(V(50, 90, 5, 99))).toEqual(V(50, 100, 0, 100));
  });

  it('休息：精力 +30、饱腹 -5，钳制在 [0,100]', () => {
    expect(rest(V(50, 50, 50, 50))).toEqual(V(45, 50, 80, 50));
    expect(rest(V(3, 50, 90, 50))).toEqual(V(0, 50, 100, 50));
  });

  it('衰减只作用于饱腹/心情/精力，好感度永不衰减', () => {
    const next = decay(V(50, 50, 50, 50));
    expect(next.hunger).toBeCloseTo(50 - DECAY_PER_TICK.hunger, 10);
    expect(next.mood).toBeCloseTo(50 - DECAY_PER_TICK.mood, 10);
    expect(next.energy).toBeCloseTo(50 - DECAY_PER_TICK.energy, 10);
    expect(next.affection).toBe(50);
  });

  it('衰减门闸为 false 的维度冻结（不衰减）', () => {
    const next = decay(V(50, 50, 50, 50), { feed: false, play: true, rest: false });
    expect(next.hunger).toBe(50);
    expect(next.energy).toBe(50);
    expect(next.mood).toBeCloseTo(49.8, 10);
  });

  it('衰减不会跌破 0', () => {
    expect(decay(V(0, 0, 0, 0), { feed: true, play: true, rest: true })).toEqual(V(0, 0, 0, 0));
  });

  it('resetVitals：关闭的维度锁定回 80，开启的维度保持原值', () => {
    expect(resetVitals(V(12, 34, 56, 78), { feed: false, play: true, rest: false })).toEqual(V(80, 34, 80, 78));
  });

  it('resetVitals：无需归位时返回入参引用（保留 zustand 免渲染优化）', () => {
    const v = V(80, 44, 80, 50);
    expect(resetVitals(v, { feed: false, play: true, rest: false })).toBe(v);
  });

  it('adjustMood / addAffection：钳制在 [0,100]', () => {
    expect(adjustMood(V(0, 95, 0, 0), 8).mood).toBe(100);
    expect(adjustMood(V(0, 2, 0, 0), -8).mood).toBe(0);
    expect(addAffection(V(0, 0, 0, 99), 5).affection).toBe(100);
  });

  it('normalizeVitals：容错但不臆造（缺字段回落默认，非法值忽略，超界钳制）', () => {
    expect(normalizeVitals(undefined)).toEqual(DEFAULT_VITALS);
    expect(normalizeVitals({ hunger: 10 })).toEqual(V(10, 80, 80, 50));
    expect(normalizeVitals({ hunger: NaN, mood: 'x', energy: null, affection: 200 })).toEqual(V(80, 80, 80, 100));
    expect(normalizeVitals({ affection: -5 })).toEqual(V(80, 80, 80, 0));
  });

  it('serializeVitals 只落盘四维（不含瞬时字段）', () => {
    const parsed = JSON.parse(serializeVitals({ ...V(1, 2, 3, 4), lastFeedAt: 999 } as PetVitals & { lastFeedAt: number }));
    expect(parsed).toEqual(V(1, 2, 3, 4));
  });

  it('工具：clamp / vitalsEqual / isDefaultVitals / describeVital', () => {
    expect(clampVital(120)).toBe(100);
    expect(clampVital(-3)).toBe(0);
    expect(vitalsEqual(V(1, 2, 3, 4), V(1, 2, 3, 4))).toBe(true);
    expect(vitalsEqual(V(1, 2, 3, 4), V(1, 2, 3, 5))).toBe(false);
    expect(isDefaultVitals({ ...DEFAULT_VITALS })).toBe(true);
    expect(describeVital(HUNGER_ALERT_THRESHOLD - 1)).toBe('low');
    expect(describeVital(50)).toBe('mid');
    expect(describeVital(90)).toBe('high');
  });
});

/**
 * 迁移期（Phase 1）曾用「新实现 ⇄ 旧实现冻结副本」的全边界矩阵比对来证明等价；
 * Phase 3 已删除 `migration/`（旧实现与双跑比对器），那批「新旧逐值相等」的用例随之退场
 * （结论见 `.trae/documents/pet-domain-rebuild.md`）。
 *
 * 但边界矩阵本身的价值不能丢——这里把「与旧实现比对」换成「不变量断言」：
 * 不依赖任何对照实现，直接钉住四维在任何输入组合下都必须守住的约束。
 */
describe('宠物主体模块 · 全边界不变量（原双跑矩阵的等价替代）', () => {
  const inRange = (v: PetVitals): boolean =>
    [v.hunger, v.mood, v.energy, v.affection].every((n) => Number.isFinite(n) && n >= VITAL_MIN && n <= VITAL_MAX);

  it('feed/play/rest：任何边界输入下四维都落在 [0,100] 且不为 NaN', () => {
    for (const h of VALUES) {
      for (const m of VALUES) {
        const v = V(h, m, m, h);
        expect(inRange(feed(v))).toBe(true);
        expect(inRange(play(v))).toBe(true);
        expect(inRange(rest(v))).toBe(true);
      }
    }
  });

  it('decay：任何边界输入 × 任何门闸组合下都不会越界，且好感度恒定不变', () => {
    for (const g of GATES) {
      for (const h of VALUES) {
        for (const m of VALUES) {
          const v = V(h, m, m, h);
          const next = decay(v, g);
          expect(inRange(next)).toBe(true);
          expect(next.affection).toBe(v.affection);
        }
      }
    }
  });

  it('resetVitals：幂等（连做两次结果一致）且只在维度关闭时改动', () => {
    for (const g of GATES) {
      for (const h of VALUES) {
        const v = V(h, 44, h, 50);
        const once = resetVitals(v, g);
        expect(resetVitals(once, g)).toEqual(once); // 幂等
        if (g.feed) expect(once.hunger).toBe(v.hunger);
        else expect(once.hunger).toBe(LOCKED_VALUE);
        if (g.rest) expect(once.energy).toBe(v.energy);
        else expect(once.energy).toBe(LOCKED_VALUE);
        expect(once.affection).toBe(v.affection); // 好感度不受开关影响
      }
    }
  });

  it('adjustMood / addAffection：任何增量下都钳制在 [0,100]', () => {
    for (const m of VALUES) {
      for (const d of [-100, -8, -0.5, 0, 0.5, 8, 100]) {
        expect(inRange(adjustMood(V(0, m, 0, 0), d))).toBe(true);
      }
    }
    for (const a of VALUES) {
      for (const amt of [-50, -1, 0, 1, 5, 200]) {
        expect(inRange(addAffection(V(0, 0, 0, a), amt))).toBe(true);
      }
    }
  });

  /**
   * 迁移期由双跑比对器真实抓出、并**刻意保留**的加固行为：
   * 旧实现在读取持久化状态时只判断 `typeof === 'number'`，于是损坏的 localStorage
   * （`NaN` / 越界值）会被原样带进内存——`NaN` 一旦进入状态，后续所有 Math.min/max 都是 NaN，
   * 状态条永久显示 "NaN" 且衰减再也回不来。新实现统一消毒，此处显式钉住。
   */
  it('加固：损坏持久化数据必须被消毒（旧实现会带进 NaN / 越界值）', () => {
    expect(normalizeVitals({ hunger: NaN, mood: 'x', energy: null, affection: 200 })).toEqual(V(80, 80, 80, 100));
    expect(normalizeVitals({ affection: -5 }).affection).toBe(0);
    expect(normalizeVitals({ hunger: Infinity }).hunger).toBe(80);
    expect(normalizeVitals({ energy: 1e9 }).energy).toBe(100);
  });
});
