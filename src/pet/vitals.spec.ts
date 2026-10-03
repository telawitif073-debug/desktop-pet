import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_VITALS,
  LOCKED_VALUE,
  DECAY_PER_TICK,
  HUNGER_ALERT_THRESHOLD,
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
import * as legacy from './migration/vitalsLegacy';
import {
  setVitalsDivergenceReporter,
  getVitalsDivergences,
  getVitalsDivergenceCount,
  resetVitalsDivergences,
  feed as feedDual,
  play as playDual,
  rest as restDual,
  decay as decayDual,
  resetVitals as resetVitalsDual,
  adjustMood as adjustMoodDual,
  addAffection as addAffectionDual,
  normalizeVitals as normalizeVitalsDual,
  type VitalsDivergence,
} from './migration/dualRunVitals';

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
  it('默认值与旧实现一致（80/80/80/50），锁定值为 80', () => {
    expect(DEFAULT_VITALS).toEqual({ hunger: 80, mood: 80, energy: 80, affection: 50 });
    expect(LOCKED_VALUE).toBe(80);
    expect(parseFloat('0')).toBe(0);
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
    const next = decay(V(0, 0, 0, 0), { feed: true, play: true, rest: true });
    expect(next).toEqual(V(0, 0, 0, 0));
  });

  it('resetVitals：关闭的维度锁定回 80，开启的维度保持原值', () => {
    const next = resetVitals(V(12, 34, 56, 78), { feed: false, play: true, rest: false });
    expect(next).toEqual(V(80, 34, 80, 78));
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

describe('宠物主体模块 · 新旧实现等价性（双跑基准）', () => {
  beforeEach(() => {
    resetVitalsDivergences();
    setVitalsDivergenceReporter(undefined as unknown as (d: VitalsDivergence) => void);
  });

  it('feed / play / rest 在全边界矩阵上逐值等价', () => {
    for (const h of VALUES) {
      for (const m of VALUES) {
        const v = V(h, m, m, h);
        expect(feed(v)).toEqual(legacy.feedLegacy(v));
        expect(play(v)).toEqual(legacy.playLegacy(v));
        expect(rest(v)).toEqual(legacy.restLegacy(v));
      }
    }
  });

  it('decay 在全边界矩阵 × 全门闸组合上逐值等价', () => {
    for (const g of GATES) {
      for (const h of VALUES) {
        for (const m of VALUES) {
          const v = V(h, m, m, h);
          expect(decay(v, g)).toEqual(legacy.decayLegacy(v, g));
        }
      }
    }
  });

  it('resetVitals 在全边界矩阵 × 全门闸组合上逐值等价（含引用恒等的场景）', () => {
    for (const g of GATES) {
      for (const h of VALUES) {
        const v = V(h, 44, h, 50);
        expect(resetVitals(v, g)).toEqual(legacy.resetVitalsLegacy(v, g));
        // 引用恒等也一致：无需归位时两边都返回入参
        expect(resetVitals(v, g) === v).toBe(legacy.resetVitalsLegacy(v, g) === v);
      }
    }
  });

  it('adjustMood / addAffection / normalizeVitals 等价', () => {
    for (const m of VALUES) {
      for (const d of [-100, -8, -0.5, 0, 0.5, 8, 100]) {
        expect(adjustMood(V(0, m, 0, 0), d)).toEqual(legacy.adjustMoodLegacy(V(0, m, 0, 0), d));
      }
    }
    for (const a of VALUES) {
      for (const amt of [-50, -1, 0, 1, 5, 200]) {
        expect(addAffection(V(0, 0, 0, a), amt)).toEqual(legacy.addAffectionLegacy(V(0, 0, 0, a), amt));
      }
    }
    for (const raw of [undefined, {}, { hunger: 10 }, { hunger: 55, mood: 44, energy: 33, affection: 22 }]) {
      expect(normalizeVitals(raw)).toEqual(legacy.loadVitalsLegacy(raw));
    }
  });

  /**
   * 有意差异（由双跑比对器真实抓出来的，不是遗漏）：旧 `load` 只判断 `typeof === 'number'`，
   * 于是损坏的 localStorage（`NaN` / 越界值）会被原样带进内存——`NaN` 一旦进入状态，
   * 后续所有 Math.min/max 都是 NaN，状态条永久变成 "NaN" 且衰减再也回不来。
   * 新模块 `normalizeVitals` 统一消毒（非有限数回落默认、越界钳制），这是**刻意的加固**，
   * 因此它不纳入「必须等价」的比对集合，而是用本用例显式钉住。
   */
  it('有意差异：normalizeVitals 对损坏数据消毒（旧实现会带进 NaN / 越界值）', () => {
    const corrupted = { hunger: NaN, mood: 'x', energy: null, affection: 200 };
    expect(legacy.loadVitalsLegacy(corrupted)).toEqual(V(NaN, 80, 80, 200)); // 旧：原样保留
    expect(normalizeVitals(corrupted)).toEqual(V(80, 80, 80, 100));          // 新：消毒
    expect(normalizeVitals({ affection: -5 }).affection).toBe(0);            // 新：负值钳制
  });

  it('双跑比对器：正确实现下不产生任何分歧记录', () => {
    const report: VitalsDivergence[] = [];
    setVitalsDivergenceReporter((d) => report.push(d));

    for (const g of GATES) {
      for (const h of VALUES) {
        const v = V(h, 60, h, 40);
        feedDual(v);
        playDual(v);
        restDual(v);
        decayDual(v, g);
        resetVitalsDual(v, g);
        adjustMoodDual(v, 8);
        addAffectionDual(v, 1);
      }
    }
    normalizeVitalsDual({ hunger: 1 });

    expect(report).toHaveLength(0);
    expect(getVitalsDivergenceCount()).toBe(0);
    expect(getVitalsDivergences()).toHaveLength(0);
  });

  it('双跑比对器确实在工作：喂入损坏数据必须被抓成 1 条分歧', () => {
    // 反向验证「比对器不是空跑」——否则上面的 0 分歧毫无说服力
    const report: VitalsDivergence[] = [];
    setVitalsDivergenceReporter((d) => report.push(d));

    normalizeVitalsDual({ hunger: NaN });

    expect(report).toHaveLength(1);
    expect(report[0].op).toBe('normalizeVitals');
    expect(report[0].actual.hunger).toBe(80);   // 新：消毒为默认
    expect(Number.isNaN(report[0].expected.hunger)).toBe(true); // 旧：原样 NaN
    expect(getVitalsDivergenceCount()).toBe(1);
  });
});
