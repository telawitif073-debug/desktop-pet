import { create } from 'zustand';
import type { ChatMessage, AppConfig } from '../global.d';
import { speak } from '../renderer/speech';
import { resolveSenseImages, PERMISSION_HINTS } from '../renderer/senseIntent';

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  config: AppConfig | null;
  showSettings: boolean;

  sendMessage: (text: string, images?: string[]) => Promise<void>;
  /** 只清空对话框显示：后台聊天历史（持久化文件与 LLM 上下文）完整保留 */
  clearScreen: () => void;
  /** 清空对话框 + 后台聊天记录（chat-history.json 与 LLM 上下文） */
  clearMessages: () => Promise<void>;
  loadHistory: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: (partial: Partial<AppConfig>) => Promise<void>;
  toggleSettings: () => void;
  triggerGreeting: () => Promise<void>;
  setStreamingContent: (chunk: string) => void;
}

let streamingMessageId: string | null = null;
let streamingContent = '';
let chunkCleanup: (() => void) | null = null;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isLoading: false,
  isStreaming: false,
  error: null,
  config: null,
  showSettings: false,

  setStreamingContent: (chunk: string) => {
    streamingContent += chunk;
    if (streamingMessageId) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === streamingMessageId ? { ...m, content: streamingContent } : m
        ),
      }));
    }
  },

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
      streaming: true,
    };

    streamingMessageId = assistantMsg.id;
    streamingContent = '';

    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      isLoading: true,
      isStreaming: true,
      error: null,
    }));

    // Set up chunk listener if not already active
    if (!chunkCleanup) {
      chunkCleanup = window.electronAPI?.onChatChunk((chunk: string) => {
        get().setStreamingContent(chunk);
      });
    }

    try {
      const result = await window.electronAPI?.chat.send(text.trim(), allImages.length ? allImages : undefined);

      if (!result?.success) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: result?.error || '发送失败', streaming: false } : m
          ),
          error: result?.error || '发送失败',
        }));
      } else {
        const finalText = result.text || '';
        // Final text from result (in case streaming missed some chunks)
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: finalText || m.content, streaming: false } : m
          ),
        }));
        // 宠物语音：回复完成后朗读（配置在设置面板，enabled=false 时静默）
        if (finalText) speak(finalText, get().config?.speech);
      }
    } catch (err) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === streamingMessageId ? { ...m, content: '网络错误，请重试', streaming: false } : m
        ),
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      streamingMessageId = null;
      streamingContent = '';
      set({ isLoading: false, isStreaming: false });
    }
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
        })),
      };
    });
  },

  triggerGreeting: async () => {
    if (get().isLoading) return;

    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };

    streamingMessageId = assistantMsg.id;
    streamingContent = '';

    set((state) => ({
      messages: [...state.messages, assistantMsg],
      isLoading: true,
      isStreaming: true,
    }));

    if (!chunkCleanup) {
      chunkCleanup = window.electronAPI?.onChatChunk((chunk: string) => {
        get().setStreamingContent(chunk);
      });
    }

    try {
      const result = await window.electronAPI?.chat.greet();
      if (!result?.success) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: '', streaming: false } : m
          ),
        }));
      } else {
        const finalText = result.text || '';
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: finalText || m.content, streaming: false } : m
          ),
        }));
        // 宠物语音：问候语同样朗读
        if (finalText) speak(finalText, get().config?.speech);
      }
    } catch {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === streamingMessageId ? { ...m, content: '', streaming: false } : m
        ),
      }));
    } finally {
      streamingMessageId = null;
      streamingContent = '';
      set({ isLoading: false, isStreaming: false });
    }
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
}));
