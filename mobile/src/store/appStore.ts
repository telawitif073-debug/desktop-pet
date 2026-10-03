/**
 * 全局状态：账号 / 平台地址 / LLM 档案（=智能体，绑定形象+独立对话）/ 宠物状态 / 当前宠物。
 * 持久化到 AsyncStorage（手动白名单序列化，any 变更 1.5s 防抖落盘）。
 *
 * 核心模型：**LlmProfile = 智能体**，每个档案自带人设(systemPrompt)+绑定形象(petAssetId)+独立对话。
 * 切换档案就是切换智能体，同时自动切换宠物形象与对话记录。
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
// 宠物主体功能模块（与桌面端共用同一份纯逻辑；mobile/metro.config.js 已把它加入 watchFolders）。
// 这里只引 `pet/vitals` 而不是模块门面 `pet`：门面还导出 resource/actionModel/playback，
// 移动端目前用不到，引门面会把它们一并打进 RN 包体（无谓体积）。何时需要那些能力再从门面引。
import {
  feed as petFeed,
  play as petPlay,
  rest as petRest,
  decay as petDecay,
  adjustMood as petAdjustMood,
  addAffection as petAddAffection,
  LOCKED_VALUE,
  AFFECTION_GAIN,
} from '../../../src/pet/vitals';
import {
  DEFAULT_PET_STATE,
  type ChatMsg,
  type InstalledVoice,
  type LlmProfile,
  type PetFormat,
  type PetState,
  type PetTask,
  type PlatformUser,
  type TtsCloudConfig,
} from '../types';
import { sanitizePetTasks } from '../petTasks';

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
  /** 刷新令牌（7d）：access token 12h 过期后用它静默换新，避免使用中被踢回登录页 */
  refreshToken: string;
  baseUrl: string;
  // 云同步数据
  llmProfiles: LlmProfile[];
  llmActiveProfileId: string;
  petSelfDescription: string;
  /** 按档案（=智能体）隔离的对话记录；messages 始终是当前激活档案的消息（UI 响应式） */
  profileMessages: Record<string, ChatMsg[]>;
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
  /** 已安装音色（商店「音色」板块安装 / JSON 导入；空数组=没有云音色） */
  downloadedVoices: InstalledVoice[];
  /** 当前选中的云音色 id（空=用系统音色 speechVoice；命中 downloadedVoices 时走云合成） */
  activeCloudVoiceId: string;
  /** 云 TTS 服务凭证（OpenAI 兼容 /audio/speech；用户自己的 Key，云同步加密落库） */
  ttsCloudConfig: TtsCloudConfig;
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
  /** 最近一次成功应用的热更（用于崩溃自愈回滚检测；持久化） */
  hotApply: { version: number; ts: number } | null;
  /** 曾「启动异常被自动回滚」的热更版本黑名单（不再重复推送，防止更新死循环；持久化） */
  hotRolledBack: number[];
  /** 宠物定时任务（用户让宠物在指定时间做的事，到点由智能体主动发消息；持久化） */
  petTasks: PetTask[];
  /** 用户最近一次发言时间戳（主动搭话避让用；不持久化，冷启动清零） */
  lastUserMsgAt: number;
  /** 宠物最近一次主动消息（到点任务/自主搭话）时间戳：自主搭话据此重新计时，避免连环打扰（不持久化） */
  lastAgentMsgAt: number;
  // actions
  setAuth: (user: PlatformUser, token: string, refreshToken?: string) => void;
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
  /** 切换激活档案（=智能体）：保存当前消息、加载目标档案消息、同时切换绑定的宠物形象 */
  switchProfile: (id: string) => void;
  /** 启停智能体：停用当前激活档案时自动切到第一个启用档案并切形象；返回新激活 id（未变返回空串） */
  toggleProfileEnabled: (id: string, next: boolean) => string;
  /** 复制智能体：新 id、name 加「副本」、apiKey 一并复制，加入列表并设为激活 */
  duplicateProfile: (id: string) => void;
  setOverlayEnabled: (enabled: boolean) => void;
  setTtsEnabled: (enabled: boolean) => void;
  /** 新增定时任务（去重不处理，同一诉求允许多条） */
  addPetTask: (task: PetTask) => void;
  /** 批量局部更新任务（按 id；状态流转/顺延下一次触发时间） */
  patchPetTasks: (patches: Array<Partial<PetTask> & { id: string }>) => void;
  /** 到点消息落地：写入该智能体的对话存档；仅当它是当前激活档案时才同时更新顶层 messages */
  pushPetTaskMessage: (profileId: string, msg: ChatMsg) => void;
  hydrate: () => Promise<void>;
}

type PersistState = Omit<
  AppStore,
  'hydrated' | 'setAuth' | 'logout' | 'setBaseUrl' | 'patch' | 'feed' | 'play' | 'rest' | 'decay' | 'appendMessages' | 'patchMessage' | 'appendMessageChunk' | 'clearMessages' | 'setOverlayEnabled' | 'setTtsEnabled' | 'hydrate' | 'setMoodFromChat' | 'adjustMood' | 'setPetStateEnabled' | 'addAffection' | 'removeMessage' | 'switchProfile' | 'toggleProfileEnabled' | 'duplicateProfile' | 'addPetTask' | 'patchPetTasks' | 'pushPetTaskMessage'
>;

const PERSIST_KEYS: Array<keyof PersistState> = [
  'user',
  'token',
  'refreshToken',
  'baseUrl',
  'llmProfiles',
  'llmActiveProfileId',
  'petSelfDescription',
  'profileMessages',
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
  'downloadedVoices',
  'activeCloudVoiceId',
  'ttsCloudConfig',
  'chatClearConfirm',
  'updateSnooze',
  'hotApply',
  'hotRolledBack',
  'petTasks',
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
  refreshToken: '',
  baseUrl: DEFAULT_BASE_URL,
  llmProfiles: [],
  llmActiveProfileId: '',
  petSelfDescription: '',
  profileMessages: {},
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
  downloadedVoices: [],
  activeCloudVoiceId: '',
  ttsCloudConfig: { engine: 'openai', baseUrl: '', apiKey: '', model: '' },
  chatClearConfirm: true,
  updateAvailable: null,
  updateHot: null,
  updatePanelVisible: false,
  updateSnooze: null,
  hotApply: null,
  hotRolledBack: [],
  petTasks: [],
  lastUserMsgAt: 0,
  lastAgentMsgAt: 0,

  setAuth: (user, token, refreshToken) =>
    set((s) => ({ user, token, refreshToken: refreshToken !== undefined ? refreshToken : s.refreshToken })),
  logout: () => set({ user: null, token: '', refreshToken: '' }),
  setBaseUrl: (url) => set({ baseUrl: url.replace(/\s+/g, '').replace(/\/$/, '') }),
  patch: (partial) => set(partial),

  // 数值规则来自宠物主体功能模块（src/pet/vitals），与桌面端**同一份实现**。
  //
  // 平台差异（重要，故意保留在调用点而不下沉到共享模块）：
  //  · 移动端：开关关闭时对互动**短路**（饱腹/心情/精力全部不改，仅好感度继续累积），
  //    因为移动端没有「每 tick 归位」的兜底；
  //  · 桌面端：互动不做短路，而由 App 每 5s 的 resetVitals 把关闭项锁定回 80。
  //  两者稳态一致，但机制不同——统一策略属 Phase 3 的决策，本阶段只统一「数学」。
  feed: () =>
    set((s) => ({
      petState: s.petStateEnabled ? petFeed(s.petState) : petAddAffection(s.petState, AFFECTION_GAIN.feed),
    })),
  play: () =>
    set((s) => ({
      petState: s.petStateEnabled ? petPlay(s.petState) : petAddAffection(s.petState, AFFECTION_GAIN.play),
    })),
  rest: () =>
    set((s) => (s.petStateEnabled ? { petState: petRest(s.petState) } : s)),
  decay: () =>
    set((s) => (s.petStateEnabled ? { petState: petDecay(s.petState) } : s)), // 开关关闭：三项不衰减（返回原 state）
  setPetStateEnabled: (next) =>
    set((s) => ({
      petStateEnabled: next,
      // 关闭时三项立即归位（与桌面端 resetVitals 的锁定值同源），开启时维持原值
      petState: next
        ? s.petState
        : { ...s.petState, hunger: LOCKED_VALUE, mood: LOCKED_VALUE, energy: LOCKED_VALUE },
    })),
  addAffection: (delta) => set((s) => ({ petState: petAddAffection(s.petState, delta) })),
  setMoodFromChat: (next) => set({ moodFromChat: next }),
  adjustMood: (delta) =>
    set((s) => {
      // 状态功能关闭时三项必须恒定（防御性门控：任何调用路径都不允许改动）
      if (!s.petStateEnabled) return s;
      return { petState: petAdjustMood(s.petState, delta) };
    }),

  // 消息操作：始终作用于当前激活档案的 messages，并同步归档到 profileMessages[当前档案]
  // （保证持久化/云同步/切档时的存档与顶层一致，避免「退出后台重进」读回空存档导致记录消失）
  appendMessages: (msgs) =>
    set((s) => {
      const messages = [...s.messages, ...msgs];
      // 用户发言打点：自主主动搭话避让用（助手/到点消息不算用户活跃）
      const spoke = msgs.some((m) => m.role === 'user');
      return {
        messages,
        ...(spoke ? { lastUserMsgAt: Date.now() } : {}),
        ...(s.llmActiveProfileId ? { profileMessages: { ...s.profileMessages, [s.llmActiveProfileId]: messages } } : {}),
      };
    }),
  patchMessage: (id, partial) =>
    set((s) => {
      const messages = s.messages.map((m) => (m.id === id ? { ...m, ...partial } : m));
      return { messages, ...(s.llmActiveProfileId ? { profileMessages: { ...s.profileMessages, [s.llmActiveProfileId]: messages } } : {}) };
    }),
  appendMessageChunk: (id, chunk) =>
    set((s) => {
      const messages = s.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              reasoning: chunk.reasoningDelta ? (m.reasoning ?? '') + chunk.reasoningDelta : m.reasoning,
              content: chunk.contentDelta ? m.content + chunk.contentDelta : m.content,
            }
          : m,
      );
      return { messages, ...(s.llmActiveProfileId ? { profileMessages: { ...s.profileMessages, [s.llmActiveProfileId]: messages } } : {}) };
    }),
  clearMessages: () =>
    set((s) => ({
      messages: [],
      profileMessages: { ...s.profileMessages, ...(s.llmActiveProfileId ? { [s.llmActiveProfileId]: [] } : {}) },
    })),
  removeMessage: (id) =>
    set((s) => {
      const messages = s.messages.filter((m) => m.id !== id);
      return { messages, ...(s.llmActiveProfileId ? { profileMessages: { ...s.profileMessages, [s.llmActiveProfileId]: messages } } : {}) };
    }),

  // ── 宠物定时任务（到点由智能体主动发消息，见 petTaskScheduler.ts）──
  addPetTask: (task) => set((s) => ({ petTasks: [...s.petTasks, task] })),
  patchPetTasks: (patches) =>
    set((s) => {
      if (!patches.length) return s;
      const map = new Map(patches.map((p) => [p.id, p]));
      return { petTasks: s.petTasks.map((k) => (map.has(k.id) ? { ...k, ...map.get(k.id) } : k)) };
    }),
  pushPetTaskMessage: (profileId, msg) =>
    set((s) => {
      // 消息始终归档到任务归属智能体的对话；仅当它正是当前激活档案时才更新顶层 messages（实时可见）
      const archived = [...(s.profileMessages[profileId] ?? []), msg];
      const profileMessages = { ...s.profileMessages, [profileId]: archived };
      // 宠物主动消息打点：自主搭话据此重新计时（到点任务优先，不与搭话连环打扰）
      const stamped = { lastAgentMsgAt: Date.now() };
      if (s.llmActiveProfileId === profileId) {
        return { messages: [...s.messages, msg], profileMessages, ...stamped };
      }
      return { profileMessages, ...stamped };
    }),

  /**
   * 切换档案（=智能体）：
   * 1. 把当前 messages 存到 profileMessages[当前ID]
   * 2. 更新 llmActiveProfileId
   * 3. 从 profileMessages[新ID] 加载 messages（没有则空数组）
   * 4. 自动切换宠物形象到新档案绑定的 petAssetId
   */
  switchProfile: (id) =>
    set((s) => {
      if (!id || id === s.llmActiveProfileId) return s;
      const target = s.llmProfiles.find((p) => p.id === id);
      // 已停用的智能体不可切换（enabled false）
      if (target && target.enabled === false) return s;
      // 严格绑定：未配置形象 / 绑定形象未下载的智能体无法使用，禁止切换
      const boundPet = target?.petAssetId ? s.downloadedPets.find((p) => p.id === target.petAssetId) : null;
      if (!target?.petAssetId || !boundPet) return s;
      // 保存当前消息
      const profileMessages = { ...s.profileMessages, ...(s.llmActiveProfileId ? { [s.llmActiveProfileId]: s.messages } : {}) };
      // 加载目标档案的消息
      const messages = profileMessages[id] ?? [];
      // 切换宠物形象到目标档案绑定的（严格跟随，不做松动保留）
      return {
        llmActiveProfileId: id,
        profileMessages,
        messages,
        petAsset: boundPet,
      };
    }),

  /** 启停：停用当前激活档案时自动切到第一个启用档案（清空聊天的停用即 ui 已拦截） */
  toggleProfileEnabled: (id, next) => {
    let newActiveId = '';
    set((s) => {
      const llmProfiles = s.llmProfiles.map((p) => (p.id === id ? { ...p, enabled: next } : p));
      if (!next && id === s.llmActiveProfileId) {
        // 停用当前激活：切到第一个启用档案
        const nextActive = llmProfiles.find((p) => p.id !== id && p.enabled !== false) ?? null;
        newActiveId = nextActive?.id ?? '';
        if (!nextActive) return s; // 全停用了，保持现状（UI 应拦截）
        const profileMessages = { ...s.profileMessages, ...{ [s.llmActiveProfileId]: s.messages } };
        const messages = profileMessages[nextActive.id] ?? [];
        const petAsset = nextActive.petAssetId
          ? s.downloadedPets.find((p) => p.id === nextActive.petAssetId) ?? null
          : s.petAsset;
        return {
          llmProfiles,
          llmActiveProfileId: nextActive.id,
          profileMessages,
          messages,
          ...(petAsset ? { petAsset } : {}),
        };
      }
      return { llmProfiles };
    });
    return newActiveId;
  },

  /** 复制档案：新 id、name 加「副本」、apiKey 一并复制，加入列表并设为激活 */
  duplicateProfile: (id) =>
    set((s) => {
      const src = s.llmProfiles.find((p) => p.id === id);
      if (!src) return s;
      const copy: LlmProfile = {
        ...src,
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: src.name ? `${src.name} 副本` : '未命名副本',
        enabled: true,
      };
      const llmProfiles = [...s.llmProfiles, copy];
      // 严格绑定：复制品继承源档案绑定的形象；仅当形象已下载时才激活复制品，否则只加入列表
      const petAsset = copy.petAssetId
        ? s.downloadedPets.find((p) => p.id === copy.petAssetId) ?? null
        : null;
      if (!petAsset) return { llmProfiles };
      const profileMessages = { ...s.profileMessages, ...(s.llmActiveProfileId ? { [s.llmActiveProfileId]: s.messages } : {}) };
      const messages = profileMessages[copy.id] ?? [];
      return {
        llmProfiles,
        llmActiveProfileId: copy.id,
        profileMessages,
        messages,
        petAsset,
      };
    }),

  setOverlayEnabled: (enabled) => set({ overlayEnabled: enabled }),
  setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as Record<string, unknown>;
        // 服务器地址已内置固定（阿里云）；旧版持久化的隧道过渡地址直接归位
        const legacy = typeof data.baseUrl === 'string' && /trycloudflare\.com/i.test(data.baseUrl);
        // 旧版迁移：installedAgents/agentMessages → llmProfiles/profileMessages
        // 旧版 AgentConfig.systemPrompt 合入 LlmProfile.systemPrompt
        const oldAgents = Array.isArray(data.installedAgents) ? (data.installedAgents as Array<{ id: string; name?: string; systemPrompt?: string; petAssetId?: string }>) : undefined;
        const oldActiveAgentId = data.activeAgentId as string | undefined;
        const oldAgentMsgs = (data.agentMessages ?? {}) as Record<string, unknown>;

        // llmProfiles：优先用新版，旧版 installedAgents 有 systemPrompt 时合入对应档案
        let llmProfiles = Array.isArray(data.llmProfiles) ? (data.llmProfiles as LlmProfile[]) : [];
        if (oldAgents?.length && llmProfiles.length) {
          // 尝试把旧版 agent 的 systemPrompt/petAssetId 合入 llmProfiles
          llmProfiles = llmProfiles.map((p) => {
            // 旧版 agent id 可能和 profile id 不同（agent id 带 "a-" 前缀）
            // 用 name 模糊匹配 + activeAgentId 指向来关联
            const matched = oldAgents.find((a) => {
              if (a.id === p.id) return true;
              if (a.name && p.name && a.name.includes(p.name)) return true;
              return false;
            });
            if (matched) {
              return {
                ...p,
                systemPrompt: p.systemPrompt?.trim() || matched.systemPrompt?.trim(),
                petAssetId: p.petAssetId || matched.petAssetId,
              };
            }
            return p;
          });
        }

        // llmActiveProfileId：旧版用 activeAgentId 指向的档案
        let llmActiveProfileId = (data.llmActiveProfileId as string | undefined) ?? '';
        if (!llmActiveProfileId && oldActiveAgentId && llmProfiles.length) {
          // 尝试匹配旧版 agent id 到 profile id
          const directMatch = llmProfiles.find((p) => p.id === oldActiveAgentId);
          llmActiveProfileId = directMatch?.id ?? llmProfiles[0]?.id ?? '';
        }
        if (!llmActiveProfileId && llmProfiles.length) {
          llmActiveProfileId = llmProfiles[0].id;
        }

        // profileMessages：合并新版 + 旧版 agentMessages
        const profileMessages: Record<string, ChatMsg[]> = {};
        if (data.profileMessages && typeof data.profileMessages === 'object') {
          for (const [k, v] of Object.entries(data.profileMessages as Record<string, unknown>)) {
            profileMessages[k] = sanitizeMessages(v);
          }
        }
        if (oldAgentMsgs && typeof oldAgentMsgs === 'object') {
          for (const [k, v] of Object.entries(oldAgentMsgs)) {
            // 旧版 agent id 转 profile id（用上面匹配过的）
            const matchedProfile = llmProfiles.find((p) => p.id === k || oldAgents?.some((a) => a.id === k));
            const targetId = matchedProfile?.id ?? k;
            if (!profileMessages[targetId]) {
              profileMessages[targetId] = sanitizeMessages(v);
            }
          }
        }
        // 顶层 messages 始终是「当前激活档案的最后快照」（发送/流式只更新 messages，不回写存档）。
        // 恢复策略：非空的最新快照回填当前档案存档，保证「退出后台重进」不因存档缺失/陈旧而读回空记录
        // （兼容旧版迁移：老数据只有顶层 messages，也一并归入当前档案）
        const activeMessages = sanitizeMessages(data.messages);
        if (llmActiveProfileId && activeMessages.length) {
          profileMessages[llmActiveProfileId] = activeMessages;
        }

        // petAsset：严格绑定 —— 激活智能体已绑定且已下载形象时，一律以绑定形象为准（含旧版历史数据归位）
        let petAsset = (data.petAsset as PetAssetRef | undefined) ?? null;
        const downloadedList = Array.isArray(data.downloadedPets) ? (data.downloadedPets as PetAssetRef[]) : [];
        if (llmActiveProfileId) {
          const p = llmProfiles.find((x) => x.id === llmActiveProfileId);
          if (p?.petAssetId) {
            petAsset = downloadedList.find((x) => x.id === p.petAssetId) ?? petAsset;
          }
        }

        // 宠物状态水合：旧版（热更 v62 前）关闭开关时三项不归位，脏存档可能是
        // petStateEnabled=false 但 hunger/mood/energy=0 → 关闭状态下强制三项 80（好感度保留）
        const hydratedEnabled = (data.petStateEnabled as boolean | undefined) ?? true;
        const hydratedRaw = { ...DEFAULT_PET_STATE, ...((data.petState as Partial<PetState> | undefined) ?? {}) };
        const hydratedState: PetState = hydratedEnabled
          ? hydratedRaw
          : { ...hydratedRaw, hunger: 80, mood: 80, energy: 80 };

        set({
          user: (data.user as PlatformUser | undefined) ?? null,
          token: (data.token as string | undefined) ?? '',
          refreshToken: (data.refreshToken as string | undefined) ?? '',
          baseUrl: legacy || !data.baseUrl ? DEFAULT_BASE_URL : (data.baseUrl as string),
          llmProfiles,
          llmActiveProfileId,
          petSelfDescription: (data.petSelfDescription as string | undefined) ?? '',
          profileMessages,
          petState: hydratedState,
          petStateReady: (data.petStateReady as boolean | undefined) ?? false,
          petStateEnabled: (data.petStateEnabled as boolean | undefined) ?? true,
          moodFromChat: (data.moodFromChat as boolean | undefined) ?? true,
          petAsset,
          downloadedPets: (() => {
            const list = Array.isArray(data.downloadedPets)
              ? (data.downloadedPets as PetAssetRef[])
              : petAsset
                ? [petAsset]
                : [];
            return petAsset && !list.some((p) => p.id === petAsset.id) ? [...list, petAsset] : list;
          })(),
          // messages = 当前激活档案的消息（activeMessages 已回填其存档，此处直接取存档恢复）
          messages: llmActiveProfileId ? profileMessages[llmActiveProfileId] ?? [] : activeMessages,
          overlayEnabled: (data.overlayEnabled as boolean | undefined) ?? false,
          ttsEnabled: (data.ttsEnabled as boolean | undefined) ?? false,
          petName: (data.petName as string | undefined) ?? '小宠',
          userNickname: (data.userNickname as string | undefined) ?? '',
          showThinking: (data.showThinking as boolean | undefined) ?? false,
          thinkingLang: data.thinkingLang === 'zh' || data.thinkingLang === 'en' ? data.thinkingLang : 'auto',
          speechRate: typeof data.speechRate === 'number' ? data.speechRate : 1.0,
          speechPitch: typeof data.speechPitch === 'number' ? data.speechPitch : 1.0,
          speechVoice: (data.speechVoice as string | undefined) ?? '',
          downloadedVoices: Array.isArray(data.downloadedVoices) ? (data.downloadedVoices as InstalledVoice[]) : [],
          activeCloudVoiceId: (data.activeCloudVoiceId as string | undefined) ?? '',
          ttsCloudConfig: (() => {
            const c = data.ttsCloudConfig as Partial<TtsCloudConfig> | undefined;
            return { baseUrl: c?.baseUrl ?? '', apiKey: c?.apiKey ?? '', model: c?.model ?? '' };
          })(),
          chatClearConfirm: (data.chatClearConfirm as boolean | undefined) ?? true,
          updateSnooze: (data.updateSnooze as { versionName: string; until: number } | null | undefined) ?? null,
          hotApply: (data.hotApply as { version: number; ts: number } | null | undefined) ?? null,
          hotRolledBack: Array.isArray(data.hotRolledBack) ? (data.hotRolledBack as number[]) : [],
          petTasks: sanitizePetTasks(data.petTasks),
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
