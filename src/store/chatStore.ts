import { create } from 'zustand';
import type { ChatMessage, AppConfig } from '../global.d';

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  config: AppConfig | null;
  showSettings: boolean;

  sendMessage: (text: string) => Promise<void>;
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

  sendMessage: async (text: string) => {
    if (!text.trim() || get().isLoading) return;

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
      chunkCleanup = window.electronAPI.onChatChunk((chunk: string) => {
        get().setStreamingContent(chunk);
      });
    }

    try {
      const result = await window.electronAPI.chat.send(text.trim());

      if (!result.success) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: result.error || '发送失败', streaming: false } : m
          ),
          error: result.error || '发送失败',
        }));
      } else {
        // Final text from result (in case streaming missed some chunks)
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: result.text || m.content, streaming: false } : m
          ),
        }));
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

  clearMessages: async () => {
    await window.electronAPI.chat.clear();
    set({ messages: [], error: null });
  },

  loadHistory: async () => {
    const result = await window.electronAPI.chat.getHistory();
    if (!result.success || result.history.length === 0) return;
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
      chunkCleanup = window.electronAPI.onChatChunk((chunk: string) => {
        get().setStreamingContent(chunk);
      });
    }

    try {
      const result = await window.electronAPI.chat.greet();
      if (!result.success) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: '', streaming: false } : m
          ),
        }));
      } else {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamingMessageId ? { ...m, content: result.text || m.content, streaming: false } : m
          ),
        }));
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
    const config = await window.electronAPI.config.get();
    set({ config });
  },

  saveConfig: async (partial: Partial<AppConfig>) => {
    const updated = await window.electronAPI.config.set(partial);
    set({ config: updated });
  },

  toggleSettings: () => {
    set((state) => ({ showSettings: !state.showSettings }));
  },
}));
