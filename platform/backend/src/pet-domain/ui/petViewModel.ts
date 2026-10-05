/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物展示视图模型（pet view model）—— 框架无关的纯逻辑
 * ---------------------------------------------------------------------------
 * 只做「领域数据 → 展示数据」的映射：React / React Native / 未来任何端都消费同一份，
 * 因此**不 import React、不 import RN、不 touch DOM**，输入输出都是纯数据。
 */
import {
  describeVital,
  VITAL_ALERT_THRESHOLD,
  VITAL_KEYS,
  type PetVitals,
  type VitalKey,
} from '../domain/vitals';

/** 头像状态视图 */
export interface PetAvatarView {
  /** 综合档位（取四维最低） */
  level: 'low' | 'mid' | 'high';
  /** 中文状态词 */
  label: string;
  /** 表情符号（无图形资源时的兜底展示） */
  emoji: string;
  /** 主题色（accent） */
  accent: string;
}

const AVATAR: Record<'low' | 'mid' | 'high', { label: string; emoji: string; accent: string }> = {
  low: { label: '需要照顾', emoji: '😟', accent: '#ff9f9f' },
  mid: { label: '还行', emoji: '🙂', accent: '#ffd479' },
  high: { label: '状态很好', emoji: '😄', accent: '#7ddc8a' },
};

/** 综合状态 = 四维最低档（任一维度告急即反映到头像） */
export function toPetAvatarView(v: PetVitals): PetAvatarView {
  const level = describeVital(Math.min(v.hunger, v.mood, v.energy, v.affection));
  return { level, ...AVATAR[level] };
}

/** 单条状态行视图 */
export interface VitalsRow {
  key: VitalKey;
  label: string;
  value: number;
  /** 0–100，直接给进度条用 */
  percent: number;
  level: 'low' | 'mid' | 'high';
  /** 是否低于告警阈值 */
  alert: boolean;
}

const VITAL_LABELS: Record<VitalKey, string> = {
  hunger: '饱腹',
  mood: '心情',
  energy: '精力',
  affection: '好感',
};

/** 四维状态行（顺序固定为 hunger/mood/energy/affection） */
export function vitalsRows(v: PetVitals): VitalsRow[] {
  return VITAL_KEYS.map((key) => {
    const value = v[key];
    return {
      key,
      label: VITAL_LABELS[key],
      value,
      percent: Math.max(0, Math.min(100, Math.round(value))),
      level: describeVital(value),
      alert: value < VITAL_ALERT_THRESHOLD,
    };
  });
}

/** 互动提示文案：按最低维度给出建议（都健康时提示闲聊） */
export function interactionHint(v: PetVitals): string {
  const lowest = VITAL_KEYS.reduce((a, b) => (v[a] <= v[b] ? a : b));
  if (v[lowest] >= VITAL_ALERT_THRESHOLD) return '陪它说说话吧';
  if (lowest === 'hunger') return '它好像饿了，去喂点吃的';
  if (lowest === 'energy') return '它有点累了，让它休息一会儿';
  if (lowest === 'mood') return '它心情一般，陪它玩会儿';
  return '它想和你亲近，摸摸它吧';
}
