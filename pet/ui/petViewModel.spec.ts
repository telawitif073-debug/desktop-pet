import { describe, expect, it } from 'vitest';
import { DEFAULT_VITALS, VITAL_ALERT_THRESHOLD, type PetVitals } from '../domain/vitals';
import { interactionHint, toPetAvatarView, vitalsRows } from './petViewModel';

const vitals = (p: Partial<PetVitals>): PetVitals => ({ ...DEFAULT_VITALS, ...p });

describe('toPetAvatarView', () => {
  it('四维皆低 → low 档且带告警色', () => {
    const view = toPetAvatarView(vitals({ hunger: 0, mood: 0, energy: 0, affection: 0 }));
    expect(view.level).toBe('low');
    expect(view.emoji).toBeTruthy();
  });

  it('四维皆满 → high 档', () => {
    const view = toPetAvatarView(vitals({ hunger: 100, mood: 100, energy: 100, affection: 100 }));
    expect(view.level).toBe('high');
  });

  it('取最低维度决定档位（一个好一个差 → 差）', () => {
    const view = toPetAvatarView(vitals({ hunger: 100, mood: 0, energy: 100, affection: 100 }));
    expect(view.level).toBe('low');
  });
});

describe('vitalsRows', () => {
  it('固定四行且顺序为 hunger/mood/energy/affection', () => {
    expect(vitalsRows(DEFAULT_VITALS).map((r) => r.key)).toEqual(['hunger', 'mood', 'energy', 'affection']);
  });

  it('percent 钳到 0–100、alert 与阈值一致', () => {
    const rows = vitalsRows(vitals({ hunger: -10, mood: 200, energy: VITAL_ALERT_THRESHOLD - 1, affection: 50 }));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.hunger.percent).toBe(0);
    expect(byKey.mood.percent).toBe(100);
    expect(byKey.energy.alert).toBe(true);
    expect(byKey.affection.alert).toBe(false);
  });
});

describe('interactionHint', () => {
  it('都健康时提示闲聊', () => {
    expect(interactionHint(DEFAULT_VITALS)).toContain('说说话');
  });

  it('饱腹最低时提示喂食', () => {
    expect(interactionHint(vitals({ hunger: 0, mood: 80, energy: 80, affection: 50 }))).toContain('饿');
  });
});
