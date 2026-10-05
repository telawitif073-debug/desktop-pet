import { describe, expect, it } from 'vitest';
import { petDisplayName, toPetWindowView } from './petView';
import type { PetRuntimeState } from '../../global.d';

/** 构造运行时状态（默认：整体健康 + 已选用「小咪」） */
const state = (over: Partial<PetRuntimeState> = {}): PetRuntimeState => ({
  vitals: { hunger: 80, mood: 80, energy: 80, affection: 90 },
  ready: true,
  current: { id: 'p1', name: '小咪', format: 'image', installedAt: 1 },
  ...over,
});

describe('桌宠窗口视图（复用 @pet/ui 的展示逻辑）', () => {
  it('整体健康 → 头像档位 high（综合档位取四维最低）', () => {
    const view = toPetWindowView(state());
    expect(view.avatar.level).toBe('high');
    expect(view.avatar.emoji).toBe('😄');
    expect(view.avatar.accent).toBe('#7ddc8a');
  });

  it('任一维度告急即拉低综合档位（饱腹 10 → low）', () => {
    const view = toPetWindowView(state({ vitals: { hunger: 10, mood: 90, energy: 90, affection: 90 } }));
    expect(view.avatar.level).toBe('low');
    expect(view.avatar.label).toBe('需要照顾');
  });

  it('四维状态行固定顺序 hunger/mood/energy/affection，且带告警位', () => {
    const view = toPetWindowView(state({ vitals: { hunger: 20, mood: 80, energy: 80, affection: 50 } }));
    expect(view.vitals.map((row) => row.key)).toEqual(['hunger', 'mood', 'energy', 'affection']);
    expect(view.vitals.map((row) => row.label)).toEqual(['饱腹', '心情', '精力', '好感']);
    expect(view.vitals[0].alert).toBe(true);
    expect(view.vitals[1].alert).toBe(false);
  });

  it('当前宠物名与就绪态透传；未选用/名为空时回落占位文案', () => {
    expect(toPetWindowView(state()).petName).toBe('小咪');
    expect(toPetWindowView(state()).ready).toBe(true);
    expect(toPetWindowView(state({ current: null })).petName).toBe('未选择宠物');
    expect(petDisplayName({ id: 'x', name: '   ', format: '', installedAt: 1 })).toBe('未选择宠物');
    expect(petDisplayName(undefined)).toBe('未选择宠物');
  });

  it('互动建议：饱腹最低时提示喂食', () => {
    const view = toPetWindowView(state({ vitals: { hunger: 5, mood: 80, energy: 80, affection: 50 } }));
    expect(view.hint).toContain('饿');
  });
});
