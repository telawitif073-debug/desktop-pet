/**
 * 全局状态：账号 / 平台地址 / 同步数据（LLM 档案、宠物状态、聊天记录）/ 当前宠物与智能体。
 * 持久化到 AsyncStorage（手动白名单序列化，any 变更 1.5s 防抖落盘）。
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_PET_STATE,
  type AgentConfig,
  type ChatMsg,
  type LlmProfile,
  type PetFormat,
  type PetState,
  type PlatformUser,
} from '../types';

const STORAGE_KEY = 'mobile-pet-store';
/** 默认走阿里云 ECS 常驻服务（7×24）；Android 模拟器可在设置中改为 http://10.0.2.2:3001/api */
export const DEFAULT_BASE_URL = 'http://39.105.178.6/api';

export interface PetAssetRef {
  id: string;
  name: string;
  format: PetFormat;
  /** /uploads/... 相对路径（渲染时按当前服务器地址动态拼接，换隧道不失效） */
  fileUrl: string;
  /** image/gif 形象的本地缓存文件（离线可用；pack 帧目录按 id 约定无需存） */
  localPath?: string;
}

interface AppStore {
  hydrated: boolean;
  // 账号与平台
  user: PlatformUser | null;
  token: string;
  baseUrl: string;
  // 云同步数据
  llmProfiles: LlmProfile[];
  llmActiveProfileId: string;
  petSelfDescription: string;
  installedAgent: AgentConfig | null;
  petState: PetState;
  /** 是否已从云端拉取过宠物状态（本地默认值与真实状态的区分标记） */
  petStateReady: boolean;
  /** 宠物状态功能开关：关闭时隐藏状态条，饥饿/心情/精力固定 80 不再衰减；好感度仍累积但不显示 */
  petStateEnabled: boolean;
  /** 心情与对话关联：开启后按智能体回复的情绪自动增减心情值（需 petStateEnabled 开启） */
  moodFromChat: boolean;
  // 本地数据
  petAsset: PetAssetRef | null;
  /** 已下载到本机的宠物列表（可在宠物页切换/删除） */
  downloadedPets: PetAssetRef[];
  messages: ChatMsg[];
  /** 悬浮窗宠物开关（仅 Android 生效，iOS 不支持悬浮窗） */
  overlayEnabled: boolean;
  /** 语音朗读回复开关（TTS 读出助手消息） */
  ttsEnabled: boolean;
  /** 宠物名字（与桌面端 config.petName 同义，本地保存，默认「小宠」） */
  petName: string;
  /** 智能体对用户的称呼（空=不指定，本地保存） */
  userNickname: string;
  /** 聊天是否请求并显示模型思考过程（智谱 GLM thinking） */
  showThinking: boolean;
  /** 思考过程语言：auto=跟随回复，zh=中文，en=English */
  thinkingLang: 'auto' | 'zh' | 'en';
  /** TTS 语速（0.5-2.0，默认 1.0） */
  speechRate: number;
  /** TTS 音调（0.5-2.0，默认 1.0） */
  speechPitch: number;
  /** TTS 音色（listVoices 的 name，空=系统默认） */
  speechVoice: string;
  /** 清空对话前是否询问（对齐桌面端「清空对话前询问」开关） */
  chatClearConfirm: boolean;
  /** 检测到的新版本信息（安静模式：只显示顶部横幅，点击才打开更新面板；不持久化） */
  updateAvailable: { versionCode: number; versionName: string; notes: string; apkUrl: string; forced: boolean } | null;
  /** 检测到的热更新（JS Bundle，无需重装 APK，重启生效；不持久化） */
  updateHot: { version: number; url: string; notes: string } | null;
  /** 更新面板是否打开（强制更新时自动打开且不可关闭） */
  updatePanelVisible: boolean;
  /** 用户关闭横幅后对同一版本的静默期（24h 内不再横幅提醒；持久化） */
  updateSnooze: { versionName: string; until: number } | null;
  // actions
  setAuth: (user: PlatformUser, token: string) => void;
  logout: () => void;
  setBaseUrl: (url: string) => void;
  patch: (partial: Partial<Omit<AppStore, 'actions'>>) => void;
  feed: () => void;
  play: () => void;
  rest: () => void;
  decay: () => void;
  /** 互动功能开关变更：关闭时把饥饿/心情/精力归位 80（幂等） */
  setPetStateEnabled: (next: boolean) => void;
  /** 心情随对话开关 */
  setMoodFromChat: (next: boolean) => void;
  /** 心情增减（对话情绪联动，clamp 0-100） */
  adjustMood: (delta: number) => void;
  /** 好感度增减（聊天/互动实装：不受开关影响，开关只控制显隐） */
  addAffection: (delta: number) => void;
  appendMessages: (msgs: ChatMsg[]) => void;
  /** 按消息 id 局部更新（流式结束时清除 pending/streaming 等） */
  patchMessage: (id: string, partial: Partial<ChatMsg>) => void;
  /** 流式增量：把 reasoning/content 增量拼接到指定消息 */
  appendMessageChunk: (id: string, chunk: { reasoningDelta?: string; contentDelta?: string }) => void;
  /** 按消息 id 从列表移除（互动回应失败时静默丢弃占位消息） */
  removeMessage: (id: string) => void;
  clearMessages: () => void;
  setOverlayEnabled: (enabled: boolean) => void;
  setTtsEnabled: (enabled: boolean) => void;
  hydrate: () => Promise<void>;
}

type PersistState = Omit<
  AppStore,
  'hydrated' | 'setAuth' | 'logout' | 'setBaseUrl' | 'patch' | 'feed' | 'play' | 'rest' | 'decay' | 'appendMessages' | 'patchMessage' | 'appendMessageChunk' | 'clearMessages' | 'setOverlayEnabled' | 'setTtsEnabled' | 'hydrate' | 'setMoodFromChat' | 'adjustMood' | 'setPetStateEnabled' | 'addAffection' | 'removeMessage'
>;

const PERSIST_KEYS: Array<keyof PersistState> = [
  'user',
  'token',
  'baseUrl',
  'llmProfiles',
  'llmActiveProfileId',
  'petSelfDescription',
  'installedAgent',
  'petState',
  'petStateReady',
  'petStateEnabled',
  'moodFromChat',
  'petAsset',
  'downloadedPets',
  'messages',
  'overlayEnabled',
  'ttsEnabled',
  'petName',
  'userNickname',
  'showThinking',
  'thinkingLang',
  'speechRate',
  'speechPitch',
  'speechVoice',
  'chatClearConfirm',
  'updateSnooze',
];

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 消息消毒：持久化/云端数据里可能残留流式中断的脏状态
 * （pending/streaming 卡死、纯空白思考/正文的高空气泡），统一清洗：
 * 空白 assistant 消息直接丢弃，其余剥离 pending/streaming 只留成品。
 */
export function sanitizeMessages(list: unknown): ChatMsg[] {
  if (!Array.isArray(list)) return [];
  const out: ChatMsg[] = [];
  for (const m of list as ChatMsg[]) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'user') {
      if (!content.trim()) continue;
      out.push({ id: m.id, role: 'user', content });
      continue;
    }
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
    if (!content.trim() && !reasoning.trim()) continue;
    out.push({
      id: m.id,
      role: 'assistant',
      content,
      ...(reasoning.trim() ? { reasoning } : {}),
      ...(typeof m.thinkSeconds === 'number' && m.thinkSeconds > 0 ? { thinkSeconds: m.thinkSeconds } : {}),
      ...(m.error ? { error: true } : {}),
    });
  }
  return out;
}

function persistSoon(state: AppStore): void {
  if (!state.hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot: Record<string, unknown> = {};
    for (const key of PERSIST_KEYS) snapshot[key] = state[key];
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => undefined);
  }, 1500);
}

export const useAppStore = create<AppStore>((set) => ({
  hydrated: false,
  user: null,
  token: '',
  baseUrl: DEFAULT_BASE_URL,
  llmProfiles: [],
  llmActiveProfileId: '',
  petSelfDescription: '',
  installedAgent: null,
  petState: { ...DEFAULT_PET_STATE },
  petStateReady: false,
  petStateEnabled: true,
  moodFromChat: true,
  petAsset: null,
  downloadedPets: [],
  messages: [],
  overlayEnabled: false,
  ttsEnabled: false,
  petName: '小宠',
  userNickname: '',
  showThinking: false,
  thinkingLang: 'auto',
  speechRate: 1.0,
  speechPitch: 1.0,
  speechVoice: '',
  chatClearConfirm: true,
  updateAvailable: null,
  updateHot: null,
  updatePanelVisible: false,
  updateSnooze: null,

  setAuth: (user, token) => set({ user, token }),
  logout: () => set({ user: null, token: '' }),
  setBaseUrl: (url) => set({ baseUrl: url.replace(/\s+/g, '').replace(/\/$/, '') }),
  patch: (partial) => set(partial),

  // 数值规则与桌面端 petStore 一致；功能开关关闭时对应项冻结（好感度增长与开关无关）
  feed: () =>
    set((s) => ({
      petState: {
        ...s.petState,
        ...(s.petStateEnabled ? { hunger: Math.min(100, s.petState.hunger + 15) } : {}),
        affection: Math.min(100, s.petState.affection + 2),
      },
    })),
  play: () =>
    set((s) => ({
      petState: {
        ...s.petState,
        ...(s.petStateEnabled
          ? { mood: Math.min(100, s.petState.mood + 20), energy: Math.max(0, s.petState.energy - 10) }
          : {}),
        affection: Math.min(100, s.petState.affection + 5),
      },
    })),
  rest: () =>
    set((s) => ({
      petState: {
        ...s.petState,
        ...(s.petStateEnabled
          ? { energy: Math.min(100, s.petState.energy + 30), hunger: Math.max(0, s.petState.hunger - 5) }
          : {}),
      },
    })),
  decay: () =>
    set((s) => {
      if (!s.petStateEnabled) return s; // 开关关闭：三项固定 80 不衰减（返回原 state 避免无效订阅更新）
      return {
        petState: {
          ...s.petState,
          hunger: Math.max(0, s.petState.hunger - 0.5),
          mood: Math.max(0, s.petState.mood - 0.2),
          energy: Math.max(0, s.petState.energy - 0.1),
        },
      };
    }),
  setPetStateEnabled: (next) =>
    set((s) => ({
      petStateEnabled: next,
      // 关闭时三项立即归位 80（与桌面端 resetVitals 一致），开启时维持 80 起步
      petState: next ? s.petState : { ...s.petState, hunger: 80, mood: 80, energy: 80 },
    })),
  addAffection: (delta) =>
    set((s) => ({
      petState: { ...s.petState, affection: Math.min(100, Math.max(0, s.petState.affection + delta)) },
    })),
  setMoodFromChat: (next) => set({ moodFromChat: next }),
  adjustMood: (delta) =>
    set((s) => ({
      petState: { ...s.petState, mood: Math.min(100, Math.max(0, s.petState.mood + delta)) },
    })),

  appendMessages: (msgs) => set((s) => ({ messages: [...s.messages, ...msgs] })),
  patchMessage: (id, partial) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...partial } : m)),
    })),
  appendMessageChunk: (id, chunk) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              reasoning: chunk.reasoningDelta ? (m.reasoning ?? '') + chunk.reasoningDelta : m.reasoning,
              content: chunk.contentDelta ? m.content + chunk.contentDelta : m.content,
            }
          : m,
      ),
    })),
  clearMessages: () => set({ messages: [] }),
  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  setOverlayEnabled: (enabled) => set({ overlayEnabled: enabled }),
  setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as Partial<PersistState>;
        // 服务器地址已内置固定（阿里云）；旧版持久化的隧道过渡地址直接归位
        const legacy = typeof data.baseUrl === 'string' && /trycloudflare\.com/i.test(data.baseUrl);
        set({
          user: data.user ?? null,
          token: data.token ?? '',
          baseUrl: legacy || !data.baseUrl ? DEFAULT_BASE_URL : data.baseUrl,
          llmProfiles: Array.isArray(data.llmProfiles) ? data.llmProfiles : [],
          llmActiveProfileId: data.llmActiveProfileId ?? '',
          petSelfDescription: data.petSelfDescription ?? '',
          installedAgent: data.installedAgent ?? null,
          petState: { ...DEFAULT_PET_STATE, ...(data.petState ?? {}) },
          petStateReady: data.petStateReady ?? false,
          petStateEnabled: data.petStateEnabled ?? true,
          moodFromChat: data.moodFromChat ?? true,
          petAsset: data.petAsset ?? null,
          // 旧版本只有 petAsset：迁移为已下载列表的初始成员；petAsset 始终保证在列表内（修复「我的宠物（0）」）
          downloadedPets: (() => {
            const list = Array.isArray(data.downloadedPets) ? data.downloadedPets : data.petAsset ? [data.petAsset] : [];
            const asset = data.petAsset;
            return asset && !list.some((p) => p.id === asset.id) ? [...list, asset] : list;
          })(),
          messages: sanitizeMessages(data.messages),
          overlayEnabled: data.overlayEnabled ?? false,
          ttsEnabled: data.ttsEnabled ?? false,
          petName: data.petName ?? '小宠',
          userNickname: data.userNickname ?? '',
          showThinking: data.showThinking ?? false,
          thinkingLang: data.thinkingLang === 'zh' || data.thinkingLang === 'en' ? data.thinkingLang : 'auto',
          speechRate: typeof data.speechRate === 'number' ? data.speechRate : 1.0,
          speechPitch: typeof data.speechPitch === 'number' ? data.speechPitch : 1.0,
          speechVoice: data.speechVoice ?? '',
          chatClearConfirm: data.chatClearConfirm ?? true,
          updateSnooze: data.updateSnooze ?? null,
        });
      }
    } catch {
      // 数据损坏时按默认状态启动
    } finally {
      set({ hydrated: true });
    }
  },
}));

// 持久化订阅：任何状态变化都安排防抖落盘
useAppStore.subscribe((state) => persistSoon(state));
