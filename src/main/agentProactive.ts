import type { AppConfig } from './config';
import type { ChatMessage } from './llmService';

const MIN_INTERVAL_MINUTES = 10;
/** 用户最近发言窗口：窗口内发言视为正在聊天，跳过本轮主动发起 */
const USER_ACTIVE_WINDOW_MS = 2 * 60_000;
/** 唤醒时段（之外不打扰） */
const WAKING_HOUR_START = 8;
const WAKING_HOUR_END = 22;

export interface AgentProactiveOptions {
  getConfig: () => AppConfig;
  isConfigured: () => boolean;
  /** 用户 2 分钟内是否发过消息 */
  isUserActive: () => boolean;
  getSystemPrompt: () => string;
  getRecentHistory: (n: number) => ChatMessage[];
  /** 调用 LLM 生成主动消息 */
  generate: (messages: ChatMessage[]) => Promise<string>;
  /** 投递消息：写入聊天历史并通知渲染端（main.ts 侧实现） */
  deliver: (text: string) => void;
}

/**
 * 智能体主动发起对话定时器：按 intervalMinutes 周期触发（每轮重新读配置，开关/间隔实时生效）。
 * 触发条件：开关开启 + LLM 已配置 + 唤醒时段 + 距上次发起 ≥10 分钟 + 用户 2 分钟内未发言。
 * 结合最近 2 条历史自然开场。返回停止函数。
 */
export function startAgentProactive(o: AgentProactiveOptions): () => void {
  let timer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;

  const intervalMs = () => {
    const minutes = Math.max(
      MIN_INTERVAL_MINUTES,
      o.getConfig().agentProactive?.intervalMinutes ?? 30
    );
    return minutes * 60_000;
  };

  const fire = async () => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `${o.getSystemPrompt()}\n\n[主动对话]请结合当前时间与最近聊天内容自然地主动开启话题，` +
          '只说一两句简短自然的话，不要提及定时器或程序。',
      },
      ...o.getRecentHistory(2),
    ];
    const text = (await o.generate(messages))?.trim();
    if (text) {
      lastSentAt = Date.now();
      o.deliver(text);
    }
  };

  const tick = async () => {
    try {
      const hour = new Date().getHours();
      const waking = hour >= WAKING_HOUR_START && hour < WAKING_HOUR_END;
      const due =
        lastSentAt === 0 || Date.now() - lastSentAt >= MIN_INTERVAL_MINUTES * 60_000;
      if (
        (o.getConfig().agentProactive?.enabled ?? true) &&
        o.isConfigured() &&
        waking &&
        due &&
        !o.isUserActive()
      ) {
        await fire();
      }
    } catch {
      // 单轮失败静默（LLM 不可用/网络异常），下轮重试
    }
    timer = setTimeout(() => void tick(), intervalMs());
  };

  timer = setTimeout(() => void tick(), intervalMs());
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
