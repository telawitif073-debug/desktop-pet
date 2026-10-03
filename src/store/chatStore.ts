import { create } from 'zustand';
import type { ChatMessage, AppConfig, ChatResult } from '../global.d';
import { speak, speakContextFromConfig } from '../renderer/speech';
import { resolveSenseImages, PERMISSION_HINTS } from '../renderer/senseIntent';
import { moodDeltaFromText } from '../renderer/moodLink';
import { usePetStore } from './petStore';

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  config: AppConfig | null;
  showSettings: boolean;

  sendMessage: (text: string, images?: string[]) => Promise<void>;
  /** 失败气泡点击重试：不重复写入用户消息，用历史里的末条问题重新补全 */
  retryMessage: (id: string) => Promise<void>;
  /** 只清空对话框显示：后台聊天历史（持久化文件与 LLM 上下文）完整保留 */
  clearScreen: () => void;
  /** 清空对话框 + 后台聊天记录（按档案隔离的 profileMessages 与 LLM 上下文） */
  clearMessages: () => Promise<void>;
  loadHistory: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: (partial: Partial<AppConfig>) => Promise<void>;
  toggleSettings: () => void;
}

/** 流中断自动重试前留的网络恢复窗口（切网/网关抖动后立刻重连大概率再断） */
const INTERRUPT_RETRY_DELAY_MS = 1200;

// 流式会话的模块级累积状态（不放进 store，避免每个 chunk 触发无谓的浅比较开销）
let streamingMessageId: string | null = null;
let streamingContent = '';
let streamingReasoning = '';
/** 思考计时：首个思考增量 → 首个正文增量（非流式降级无增量则退回整请求耗时） */
let thinkStartedAt = 0;
let thinkEndedAt = 0;
let chunkCleanup: (() => void) | null = null;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useChatStore = create<ChatStore>((set, get) => {
  /** 监听流式增量：正文（chat:chunk）与思考过程（chat:reasoning）分流累积 */
  const ensureChunkListeners = () => {
    if (chunkCleanup) return;
    const offContent = window.electronAPI?.onChatChunk((chunk: string) => {
      if (!streamingMessageId) return;
      if (thinkStartedAt && !thinkEndedAt) thinkEndedAt = Date.now();
      streamingContent += chunk;
      const id = streamingMessageId;
      set((state) => ({
        messages: state.messages.map((m) => (m.id === id ? { ...m, content: streamingContent } : m)),
      }));
    });
    const offReasoning = window.electronAPI?.onChatReasoning((chunk: string) => {
      if (!streamingMessageId) return;
      if (!thinkStartedAt) thinkStartedAt = Date.now();
      streamingReasoning += chunk;
      const id = streamingMessageId;
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === id ? { ...m, reasoning: streamingReasoning } : m
        ),
      }));
    });
    chunkCleanup = () => {
      offContent?.();
      offReasoning?.();
    };
  };

  /** 局部更新某条消息（找不到 id 时原样返回，不产生无意义的新数组） */
  const patchMessage = (id: string, patch: Partial<ChatMessage>) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  };

  /** 重试/自动重试前复位占位气泡：清空正文与思考，重新回到等待态 */
  const resetBubble = (id: string) => {
    streamingMessageId = id;
    streamingContent = '';
    streamingReasoning = '';
    thinkStartedAt = 0;
    thinkEndedAt = 0;
    patchMessage(id, {
      pending: true,
      streaming: true,
      error: false,
      content: '',
      reasoning: undefined,
      thinkSeconds: undefined,
    });
  };

  /**
   * 执行一次助手补全：思考阶段单独计时；收数后被掐断自动重试一次；失败落地为可点击重试的错误气泡。
   * request 由调用方给出（首次发送走 chat.send，重试走 chat.retry）。
   */
  const runAssistant = async (
    messageId: string,
    request: () => Promise<ChatResult | undefined>,
    allowRetry: boolean
  ): Promise<void> => {
    const startedAt = Date.now();
    streamingMessageId = messageId;
    streamingContent = '';
    streamingReasoning = '';
    thinkStartedAt = 0;
    thinkEndedAt = 0;
    ensureChunkListeners();

    try {
      const result = await request();
      if (!result) throw new Error('聊天通道不可用，请重新加载页面');

      if (!result.success) {
        // 收数后被网关/网络掐断：清空占位，留 1.2 秒恢复窗口后自动重试（只一次）
        if (result.interrupted && allowRetry) {
          await new Promise((resolve) => setTimeout(resolve, INTERRUPT_RETRY_DELAY_MS));
          resetBubble(messageId);
          await runAssistant(messageId, () => window.electronAPI?.chat.retry() ?? Promise.resolve(undefined), false);
          return;
        }
        // 用户主动停止：保留已生成内容，不标错；什么都没生成就整条移除
        if (result.aborted) {
          const partial = streamingContent.trim() || streamingReasoning.trim();
          if (partial) {
            patchMessage(messageId, { pending: false, streaming: false });
          } else {
            set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }));
          }
          return;
        }
        patchMessage(messageId, {
          pending: false,
          streaming: false,
          error: true,
          content: `出错了：${result.error || '发送失败'}`,
        });
        set({ error: result.error || '发送失败' });
        return;
      }

      const finalText = result.text?.trim() ? result.text : streamingContent;
      const finalReasoning = streamingReasoning.trim() || result.reasoning?.trim() || undefined;
      const hasReasoning = !!finalReasoning;
      const thinkSeconds = thinkStartedAt
        ? Math.max(1, Math.round(((thinkEndedAt || Date.now()) - thinkStartedAt) / 1000))
        : hasReasoning
          ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          : undefined;
      patchMessage(messageId, {
        pending: false,
        streaming: false,
        error: false,
        content: finalText,
        reasoning: finalReasoning,
        thinkSeconds,
      });

      const config = get().config;
      // 宠物状态系统开启时：有效回复好感 +1；「聊天影响心情」开启时再按情绪词 ±8
      if (config?.petSystemEnabled !== false) {
        usePetStore.getState().addAffection(1);
        if (config?.moodFromChat !== false) {
          const delta = moodDeltaFromText(finalText);
          if (delta) usePetStore.getState().adjustMood(delta);
        }
      }
      // 宠物语音：回复完成后朗读（配置在设置面板，enabled=false 时静默）
      if (finalText.trim()) speak(finalText, speakContextFromConfig(config));
    } catch (err) {
      patchMessage(messageId, {
        pending: false,
        streaming: false,
        error: true,
        content: '网络错误，请重试',
      });
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      streamingMessageId = null;
      streamingContent = '';
      streamingReasoning = '';
      set({ isLoading: false, isStreaming: false });
    }
  };

  return {
    messages: [],
    isLoading: false,
    isStreaming: false,
    error: null,
    config: null,
    showSettings: false,

    sendMessage: async (text: string, images?: string[]) => {
      if ((!text.trim() && !images?.length) || get().isLoading) return;
      // 感知意图：「看桌面/拍我」类请求自动抓图随消息发送；权限未开显示引导提示（本地气泡，不入历史）
      const sense = await resolveSenseImages(text, get().config?.petSenses);
      if (sense.hint) {
        set({ messages: [...get().messages, { id: generateId(), role: 'assistant', content: PERMISSION_HINTS[sense.hint] }] });
        return;
      }
      if (sense.error) {
        set({ messages: [...get().messages, { id: generateId(), role: 'assistant', content: `没成功看到：${sense.error}` }] });
        return;
      }
      const allImages = [...(images ?? []), ...sense.images];

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: text.trim(),
      };
      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: '',
        pending: true,
        streaming: true,
      };

      set((state) => ({
        messages: [...state.messages, userMsg, assistantMsg],
        isLoading: true,
        isStreaming: true,
        error: null,
      }));

      await runAssistant(
        assistantMsg.id,
        () => window.electronAPI?.chat.send(text.trim(), allImages.length ? allImages : undefined) ?? Promise.resolve(undefined),
        true
      );
    },

    retryMessage: async (id: string) => {
      if (get().isLoading) return;
      set({ isLoading: true, isStreaming: true, error: null });
      resetBubble(id);
      await runAssistant(
        id,
        () => window.electronAPI?.chat.retry() ?? Promise.resolve(undefined),
        true
      );
    },

    clearScreen: () => {
      // 不调 IPC：主进程聊天历史与 LLM 上下文全部保留，仅清界面显示
      set({ messages: [], error: null });
    },

    clearMessages: async () => {
      await window.electronAPI?.chat.clear();
      set({ messages: [], error: null });
    },

    loadHistory: async () => {
      const result = await window.electronAPI?.chat.getHistory();
      if (!result?.success || result.history.length === 0) return;
      set((state) => {
        // Don't overwrite messages already shown in the current session
        if (state.messages.length > 0) return state;
        return {
          messages: result.history.map((m) => ({
            id: generateId(),
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
          })),
        };
      });
    },

    loadConfig: async () => {
      const config = (await window.electronAPI?.config.get()) ?? null;
      set({ config });
    },

    saveConfig: async (partial: Partial<AppConfig>) => {
      const updated = (await window.electronAPI?.config.set(partial)) ?? null;
      set({ config: updated });
    },

    toggleSettings: () => {
      set((state) => ({ showSettings: !state.showSettings }));
    },
  };
});