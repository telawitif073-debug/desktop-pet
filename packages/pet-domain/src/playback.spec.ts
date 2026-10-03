import { describe, expect, it } from 'vitest';
import {
  holdSecondsFor,
  isNoMirrorAction,
  moveParamsFor,
  nextEventAnim,
  pickFromPool,
  pickSlot,
  pickWeightedCategory,
  resolveInteractionTrigger,
  resolvePlayback,
  rollKind,
  type Rng,
} from './playback';
import { ACTION_MODEL_SCHEMA_VERSION, DEFAULT_WEIGHTS, type PetActionModel } from './actionModel';

/** 确定性随机源：按给定序列循环取值，便于断言"抽到了哪一个" */
const seq = (values: number[]): Rng => {
  let i = 0;
  return () => values[i++ % values.length];
};

const spec = (ref: string, extra: Partial<PetActionModel['actions'][string]> = {}) => ({
  ref,
  frameRate: 6,
  loop: false,
  holdLeadSec: 0,
  holdTailSec: 0,
  interaction: 'none' as const,
  priority: 0,
  noMirror: false,
  ...extra,
});

function model(): PetActionModel {
  const names = ['待机A', '待机B', '吃饭', '休息', '玩耍', '点击A', '拖拽A', '小动作A', '小动作B', '文字动作', '走路'];
  const actions: PetActionModel['actions'] = {};
  for (const n of names) actions[n] = spec(n);
  actions['文字动作'] = spec('文字动作', { noMirror: true });
  return {
    schemaVersion: ACTION_MODEL_SCHEMA_VERSION,
    idle: ['待机A', '待机B'],
    interaction: { feed: ['吃饭'], rest: ['休息'], play: ['玩耍'] },
    clicks: ['点击A'],
    drag: ['拖拽A'],
    moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [{ name: '走路', params: { minDist: 120, maxDist: 320 } }] },
    categories: [
      { id: '小动作', weight: 60, actions: ['小动作A', '小动作B'] },
      { id: '文字', weight: 20, noMirror: true, actions: ['文字动作'] },
    ],
    events: { workStatus: ['待机A', ['小动作A', '小动作B'], [] as unknown as string[]] },
    weights: { ...DEFAULT_WEIGHTS }, // 10 + 5 + 5 + 60 + 20 = 100
    actions,
  };
}

describe('选择原语（不连播 / 兜底不返回 undefined）', () => {
  it('pickFromPool 优先排除当前动作', () => {
    expect(pickFromPool(['a', 'b'], 'a', seq([0]))).toBe('b');
  });

  it('pickFromPool 池内只有一个且正好是当前动作 → 宁可重复，也不返回 null', () => {
    expect(pickFromPool(['only'], 'only', seq([0]))).toBe('only');
  });

  it('pickFromPool 空池 / 非法条目 → null', () => {
    expect(pickFromPool([], undefined, seq([0]))).toBeNull();
    expect(pickFromPool(['', '   '], undefined, seq([0]))).toBeNull();
  });

  it('pickSlot：字符串槽位原样返回；数组槽位避开当前', () => {
    expect(pickSlot('固定', '固定', seq([0]))).toBe('固定');
    expect(pickSlot(['x', 'y'], 'x', seq([0]))).toBe('y');
    expect(pickSlot([], undefined, seq([0]))).toBeNull();
  });

  it('pickWeightedCategory：noMirror 分类在镜像时被排除，剩余权重重新归一化', () => {
    const cats = model().categories;
    // 朝左：权重 60/20 → roll=0.9 落在第二个分类（文字）
    expect(pickWeightedCategory(cats, 'left', seq([0.9]))?.id).toBe('文字');
    // 朝右：文字类被排除，只剩小动作
    expect(pickWeightedCategory(cats, 'right', seq([0.9]))?.id).toBe('小动作');
    expect(pickWeightedCategory([], 'left', seq([0]))).toBeNull();
  });

  it('rollKind：区间边界与 fixed（turn/move 权重按 0 算、不归一化）', () => {
    const w = DEFAULT_WEIGHTS; // idle 10, turn 5, move 5 → top 20
    expect(rollKind(0.0, w)).toBe('idle');
    expect(rollKind(0.09, w)).toBe('idle');
    expect(rollKind(0.12, w)).toBe('turn');
    expect(rollKind(0.17, w)).toBe('move');
    expect(rollKind(0.5, w)).toBe('action');
    // fixed：0.12 不再落 turn
    expect(rollKind(0.12, w, { fixed: true })).toBe('action');
    expect(rollKind(0.05, w, { fixed: true })).toBe('idle');
  });

  it('isNoMirrorAction 同时识别动作级与分类级标记', () => {
    const m = model();
    expect(isNoMirrorAction(m, '文字动作')).toBe(true);
    expect(isNoMirrorAction(m, '待机A')).toBe(false);
  });

  it('nextEventAnim：多候选档位轮换到不同候选；单候选/不在池中返回 null', () => {
    const pool = model().events.workStatus;
    expect(nextEventAnim(pool, '小动作A', seq([0]))).toBe('小动作B');
    expect(nextEventAnim(pool, '待机A', seq([0]))).toBeNull(); // 单值档位
    expect(nextEventAnim(pool, '不存在', seq([0]))).toBeNull();
    expect(nextEventAnim(undefined, 'x', seq([0]))).toBeNull();
  });
});

describe('触发优先级与显式失败原因', () => {
  it('显式点播：命中返回动作名；未定义 → unknown-action', () => {
    const m = model();
    expect(resolvePlayback({ trigger: 'explicit', actionName: '吃饭' }, m).actionName).toBe('吃饭');
    const bad = resolvePlayback({ trigger: 'explicit', actionName: '不存在' }, m);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('unknown-action');
    expect(bad.evidence.join(' ')).toContain('清单↔定义互校失败');
  });

  it('显式点播 noMirror 动作且朝右 → all-filtered（不静默播错方向）', () => {
    const r = resolvePlayback({ trigger: 'explicit', actionName: '文字动作', facing: 'right' }, model());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('all-filtered');
  });

  it('事件触发：档位越界 → tier-out-of-range；事件未配置 → unknown-event', () => {
    const m = model();
    expect(resolvePlayback({ trigger: 'event', eventName: 'workStatus', tier: 0 }, m).actionName).toBe('待机A');
    const oob = resolvePlayback({ trigger: 'event', eventName: 'workStatus', tier: 9 }, m);
    expect(oob.reason).toBe('tier-out-of-range');
    const unknown = resolvePlayback({ trigger: 'event', eventName: '不存在' }, m);
    expect(unknown.reason).toBe('unknown-event');
  });

  it('互动触发：从对应池取且避开当前动作；空池 → no-action', () => {
    const m = model();
    const r = resolvePlayback({ trigger: 'feed', currentAction: '吃饭' }, m, seq([0]));
    expect(r.actionName).toBe('吃饭'); // 池内仅一个 → 宁可重复
    const empty = resolvePlayback({ trigger: 'rest' }, { ...m, interaction: { feed: [], rest: [], play: [] } });
    expect(empty.reason).toBe('no-action');
    expect(empty.evidence.join(' ')).toContain('互动池 rest 为空');
  });

  it('点击/拖拽触发走各自池', () => {
    const m = model();
    expect(resolvePlayback({ trigger: 'click' }, m).pool).toBe('click');
    expect(resolvePlayback({ trigger: 'drag' }, m).pool).toBe('drag');
  });

  it('随机链：idle 命中；掷到 action 时走加权分类', () => {
    const m = model();
    const idle = resolvePlayback({ trigger: 'random' }, m, seq([0.0, 0.0]));
    expect(idle.pool).toBe('idle');
    const cat = resolvePlayback({ trigger: 'random' }, m, seq([0.5, 0.0, 0.0]));
    expect(cat.ok).toBe(true);
    expect(cat.pool).toMatch(/^category:/);
  });

  it('随机链掷到 move：从 moves.actions 取；为空则退回 idle 并说明', () => {
    const m = model();
    const move = resolvePlayback({ trigger: 'random' }, m, seq([0.18, 0.0]));
    expect(move.actionName).toBe('走路');
    expect(move.pool).toBe('move');
    const noMoves = { ...m, moves: { ...m.moves, actions: [] } };
    const fallback = resolvePlayback({ trigger: 'random' }, noMoves, seq([0.18, 0.0]));
    expect(fallback.pool).toBe('idle');
    expect(fallback.evidence.join(' ')).toContain('退回 idle');
  });

  it('确定性：相同随机序列 → 相同决策', () => {
    const m = model();
    const a = resolvePlayback({ trigger: 'random' }, m, seq([0.5, 0.1, 0.2]));
    const b = resolvePlayback({ trigger: 'random' }, m, seq([0.5, 0.1, 0.2]));
    expect(a).toEqual(b);
  });

  it('全空模型不抛错，给出 no-action', () => {
    const empty: PetActionModel = {
      schemaVersion: ACTION_MODEL_SCHEMA_VERSION,
      idle: [],
      interaction: { feed: [], rest: [], play: [] },
      clicks: [],
      drag: [],
      moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [] },
      categories: [],
      events: {},
      weights: { idle: 100, turn: 0, move: 0 },
      actions: {},
    };
    const r = resolvePlayback({ trigger: 'random' }, empty, seq([0.0]));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-action');
  });
});

describe('互动触发整合（绑定优先 → 标准池回退）', () => {
  const act = (id: string, name: string, extra: Partial<import('./actionModel').PetActionLike> = {}) => ({
    id,
    name,
    kind: 'frames' as const,
    frameFiles: ['/tmp/f.png'],
    frameRate: 6,
    ...extra,
  });

  it('绑定优先：绑定 id 对应动作可播 → 直接用绑定', () => {
    const actions = [act('id1', '自定义吃饭', { interaction: 'feed' }), act('id2', '别的动作')];
    const r = resolveInteractionTrigger({ kind: 'feed', boundActionId: 'id2', actions });
    expect(r.ok).toBe(true);
    expect(r.actionId).toBe('id2');
    expect(r.pool).toBe('binding');
  });

  it('无绑定时按标准模型的互动池选（含按 interaction 归池的动作）', () => {
    const actions = [act('id1', '吃饭', { interaction: 'feed' })];
    const r = resolveInteractionTrigger({ kind: 'feed', actions });
    expect(r.ok).toBe(true);
    expect(r.actionId).toBe('id1');
    expect(r.pool).toBe('interaction:feed');
  });

  it('历史同名回退仍有效：未标 interaction 但名为「休息」→ 走 rest 池', () => {
    const actions = [act('id9', '休息')];
    const r = resolveInteractionTrigger({ kind: 'rest', actions });
    expect(r.ok).toBe(true);
    expect(r.actionId).toBe('id9');
    expect(r.evidence.join(' ')).toContain('互动池');
  });

  it('绑定指向的动作没有可播资源 → 回退池子并说明原因', () => {
    const actions = [act('id1', '吃饭', { interaction: 'feed' }), act('id2', '空动作', { frameFiles: [] })];
    const r = resolveInteractionTrigger({ kind: 'feed', boundActionId: 'id2', actions });
    expect(r.ok).toBe(true);
    expect(r.actionId).toBe('id1');
    expect(r.evidence.join(' ')).toContain('无可播资源');
  });

  it('无任何可用动作 → 显式 no-action（不静默什么都不做）', () => {
    const r = resolveInteractionTrigger({ kind: 'play', actions: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-action');
    expect(r.evidence.join(' ')).toContain('互动池 play 为空');
  });
});

describe('参数解析（默认 + 逐动作覆盖）', () => {
  it('moveParamsFor 合并默认值与动作覆盖', () => {
    const m = model();
    expect(moveParamsFor(m, '走路')).toMatchObject({ minDist: 120, maxDist: 320, margin: 20, leadSec: 2, tailSec: 2 });
    expect(moveParamsFor(m, '待机A')).toMatchObject({ minDist: 60, maxDist: 240 });
  });

  it('holdSecondsFor 返回动作的首尾停顿，缺省为 0', () => {
    const m = model();
    m.actions['吃饭'] = { ...m.actions['吃饭'], holdLeadSec: 0.5, holdTailSec: 0.75 };
    expect(holdSecondsFor(m, '吃饭')).toEqual({ lead: 0.5, tail: 0.75 });
    expect(holdSecondsFor(m, '不存在')).toEqual({ lead: 0, tail: 0 });
  });
});
