/**
 * 宠物自主主动搭话（能力来自「智能体自己」：导入 JSON 声明的 active_execution + 用户导入时的选择）：
 * App 前台期间每 60s 检查一次，满足全部条件才让宠物主动开口：
 * - 当前智能体启用了「主动发起对话」能力（档案 capabilities.enabled 含 proactive）且已配置直连对话 API
 * - 落在该智能体自己的搭话时段内（JSON waking_hours，缺省 8:00–22:00）
 * - 距上次宠物开口 ≥ 该智能体自己的间隔（JSON interval_minutes，缺省 30 分钟，下限 5 分钟）
 * - 用户 2 分钟内发过消息则跳过本轮（不和用户抢话）
 * - 冷启动 / 回到前台后重新计时，避免刚打开 App 就被搭话
 * 消息落到该智能体对话（与定时任务同一落地通道），生成失败静默跳过（不发模板）。
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAppStore } from './store/appStore';
import { generateActiveMessage, proactiveStateHint } from './petActiveMessage';
import { DEFAULT_WAKING_HOURS, isWithinHours, normalizeIntervalMinutes, shouldFireProactive } from './petProactiveGate';

/** 检查周期 */
const CHECK_MS = 60000;

/** 自主主动搭话调度器：挂在主壳（与定时任务调度器并列） */
export function usePetProactive(): void {
  const hydrated = useAppStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    // 首次计时从进入前台开始算（避免一启动就开口），用户活跃时间同样以进入前台为起点
    let lastFiredAt = Date.now();
    let foregroundAt = Date.now();
    let inFlight = false;

    const fire = async (profileId: string): Promise<void> => {
      const st = useAppStore.getState();
      const profile = st.llmProfiles.find((p) => p.id === profileId);
      if (!profile) return;
      const stateHint = st.petStateEnabled ? proactiveStateHint(st.petState) : '';
      const text = await generateActiveMessage(profile, { stateHint });
      lastFiredAt = Date.now();
      useAppStore.getState().pushPetTaskMessage(profileId, {
        id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'assistant',
        content: text,
      });
    };

    const tick = async (): Promise<void> => {
      if (inFlight) return;
      const st = useAppStore.getState();
      const profile = st.llmProfiles.find((p) => p.id === st.llmActiveProfileId);
      const configured = !!(profile?.apiKey && profile?.baseUrl && profile?.model);
      // 能力来自智能体本身：未启用「主动发起对话」的智能体不主动开口
      const caps = profile?.capabilities;
      const enabled = !!caps?.enabled?.includes('proactive');
      const hours = caps?.spec.wakingHours ?? DEFAULT_WAKING_HOURS;
      const intervalMs = normalizeIntervalMinutes(caps?.spec.intervalMinutes) * 60000;
      const now = Date.now();
      const canFire = shouldFireProactive({
        enabled,
        configured,
        wakingHour: isWithinHours(now, hours),
        // 计时基准 = 最近一次搭话 与 最近一次宠物主动消息（到点任务）取较晚者：
        // 到点任务优先，发完任务消息后搭话重新计时，避免连环打扰
        sinceLastFireMs: now - Math.max(lastFiredAt, st.lastAgentMsgAt),
        sinceUserActiveMs: now - Math.max(foregroundAt, st.lastUserMsgAt),
        intervalMs,
      });
      if (!canFire || !profile) return;
      inFlight = true;
      try {
        await fire(profile.id);
      } catch {
        // 单轮失败静默（LLM 不可用/网络异常），下一轮再试
      } finally {
        inFlight = false;
      }
    };

    const id = setInterval(() => void tick(), CHECK_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') foregroundAt = Date.now();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [hydrated]);
}