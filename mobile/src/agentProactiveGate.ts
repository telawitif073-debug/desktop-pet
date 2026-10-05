/**
 * 自主主动搭话·判定层（纯逻辑，不依赖 React Native，可直接被 Node 单测）。
 * 触发条件：开关开 + 当前智能体已配置直连 API + 唤醒时段内 + 距上次搭话 ≥ 间隔 + 用户近期未发言。
 * 调度与消息落地见 agentProactive.ts。
 */

/** 间隔下限（防止 JSON/设置被写成 0 导致刷屏） */
export const MIN_PROACTIVE_MINUTES = 5;
/** 默认搭话时段（智能体 JSON 未声明时兜底） */
export const DEFAULT_WAKING_HOURS: [number, number] = [8, 22];
/** 默认搭话间隔（分钟） */
export const DEFAULT_PROACTIVE_MINUTES = 30;
/** 用户活跃窗口：窗口内发过消息就不打扰 */
export const USER_ACTIVE_WINDOW_MS = 2 * 60000;

/** 是否落在 [start, end) 时段内（支持跨零点的时段，如 [22, 7]） */
export function isWithinHours(at: number, hours: [number, number] = DEFAULT_WAKING_HOURS): boolean {
  const [start, end] = hours;
  const h = new Date(at).getHours();
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

export function isWakingHour(at: number = Date.now()): boolean {
  return isWithinHours(at, DEFAULT_WAKING_HOURS);
}

/** 归一化间隔（分钟）：非法/过小一律夹到下限 */
export function normalizeIntervalMinutes(v?: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_PROACTIVE_MINUTES;
  return Math.max(MIN_PROACTIVE_MINUTES, n > 0 ? n : DEFAULT_PROACTIVE_MINUTES);
}

export interface ProactiveGate {
  /** 设置开关 */
  enabled: boolean;
  /** 当前智能体是否具备直连对话 API */
  configured: boolean;
  wakingHour: boolean;
  /** 距上次主动搭话的毫秒数 */
  sinceLastFireMs: number;
  /** 距用户上次发言（或本次回到前台）的毫秒数 */
  sinceUserActiveMs: number;
  intervalMs: number;
}

/** 是否可以主动搭话（纯函数，便于单测） */
export function shouldFireProactive(g: ProactiveGate): boolean {
  if (!g.enabled || !g.configured || !g.wakingHour) return false;
  if (g.sinceLastFireMs < g.intervalMs) return false;
  if (g.sinceUserActiveMs < USER_ACTIVE_WINDOW_MS) return false;
  return true;
}