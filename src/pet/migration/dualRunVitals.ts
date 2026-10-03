/**
 * 【临时·迁移期】vitals 双跑比对器
 * ===========================================================================
 * 迁移策略是「新模块双跑 → 验证等价 → 再切换删除旧实现」。本文件是双跑的落点：
 * 每个操作**同时**跑新实现（`../vitals`）与冻结的旧实现（`./vitalsLegacy`），
 * 比较结果并记录分歧，返回**新实现**的结果。因此：
 *  - 行为上已经走新模块（Phase 2 的语义），但旧实现仍在跑 → 任何不一致都能被立刻发现；
 *  - Phase 3 只要把确定性结论落地（分歧计数长期为 0），删掉本文件与 `vitalsLegacy.ts` 即可。
 *
 * 分歧不会抛错或改变行为（避免迁移期影响用户），只做：
 *  - 计数 + 最近 N 条明细（`getVitalsDivergences`）
 *  - 可选的 reporter 回调（主进程可挂日志、测试可挂断言）
 */
import * as next from '../vitals';
import * as legacy from './vitalsLegacy';
import type { PetVitals, VitalGates } from '../vitals';

export interface VitalsDivergence {
  /** 发生分歧的操作名 */
  op: string;
  /** 入参快照（便于复现） */
  input: unknown;
  /** 新实现结果 */
  actual: PetVitals;
  /** 旧实现结果 */
  expected: PetVitals;
}

const MAX_RECORDS = 50;
const records: VitalsDivergence[] = [];
let count = 0;
let reporter: ((d: VitalsDivergence) => void) | undefined;

/** 挂接分歧上报（主进程日志 / 测试断言）；传 undefined 取消 */
export function setVitalsDivergenceReporter(fn: ((d: VitalsDivergence) => void) | undefined): void {
  reporter = fn;
}

export function getVitalsDivergences(): readonly VitalsDivergence[] {
  return records;
}

export function getVitalsDivergenceCount(): number {
  return count;
}

export function resetVitalsDivergences(): void {
  records.length = 0;
  count = 0;
}

const equalVitals = (a: PetVitals, b: PetVitals): boolean =>
  a.hunger === b.hunger && a.mood === b.mood && a.energy === b.energy && a.affection === b.affection;

function compare(op: string, input: unknown, actual: PetVitals, expected: PetVitals): PetVitals {
  if (!equalVitals(actual, expected)) {
    count += 1;
    const d: VitalsDivergence = { op, input, actual, expected };
    records.push(d);
    if (records.length > MAX_RECORDS) records.shift();
    if (reporter) {
      try {
        reporter(d);
      } catch {
        /* 上报失败不影响主流程 */
      }
    } else {
      // 迁移期默认可见：控制台告警（Electron 渲染端 dev 与打包后都能看到）
      console.warn('[pet/vitals dual-run] 新旧实现结果不一致', d);
    }
  }
  return actual;
}

/** 以下 API 与 `../vitals` 同名同签名，调用方只需改 import 路径即可接入双跑 */
export const feed = (v: PetVitals): PetVitals => compare('feed', v, next.feed(v), legacy.feedLegacy(v));

export const play = (v: PetVitals): PetVitals => compare('play', v, next.play(v), legacy.playLegacy(v));

export const rest = (v: PetVitals): PetVitals => compare('rest', v, next.rest(v), legacy.restLegacy(v));

export const decay = (v: PetVitals, gates?: VitalGates): PetVitals =>
  compare('decay', { v, gates }, next.decay(v, gates), legacy.decayLegacy(v, gates));

export const resetVitals = (v: PetVitals, gates: VitalGates): PetVitals =>
  compare('resetVitals', { v, gates }, next.resetVitals(v, gates), legacy.resetVitalsLegacy(v, gates));

export const adjustMood = (v: PetVitals, delta: number): PetVitals =>
  compare('adjustMood', { v, delta }, next.adjustMood(v, delta), legacy.adjustMoodLegacy(v, delta));

export const addAffection = (v: PetVitals, amount: number): PetVitals =>
  compare('addAffection', { v, amount }, next.addAffection(v, amount), legacy.addAffectionLegacy(v, amount));

export const normalizeVitals = (raw: unknown): PetVitals =>
  compare('normalizeVitals', raw, next.normalizeVitals(raw), legacy.loadVitalsLegacy(raw));
