import type { PetVitals } from '@pet/domain';

export {};

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | 'none';
  }
}

export interface ChatResult {
  success: boolean;
  text?: string;
  /** 本次思考过程（开启 showThinking 时才有） */
  reasoning?: string;
  error?: string;
  /** 收数后被网关/网络掐断：界面清空占位、1.2 秒后自动重试一次 */
  interrupted?: boolean;
  /** 用户主动停止生成：保留已生成内容，不标错 */
  aborted?: boolean;
}

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}

export interface UserProfile {
  name: string;
  preferences: Record<string, unknown>;
}

// ── 智能体档案（镜像 src/main/config.ts LlmProfile；LlmProfile = 智能体）──────

export interface LlmProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  /** 头像（emoji 或文字，不填默认取 name 首字符） */
  avatar?: string;
  intro?: string;
  domainTags?: string[];
  role?: string;
  style?: string;
  /** 欢迎语（切换/新会话时展示） */
  greeting?: string;
  exampleQuestions?: string[];
  /** 启停：false 时不参与激活选择，聊天不可用该档案 */
  enabled?: boolean;
  /** 多智能体编排配置（含外部依赖与凭证引用） */
  multiConfig?: AgentMultiConfig;
  /** 智能体自带能力（导入 JSON 的能力声明 + 用户勾选） */
  capabilities?: AgentCapabilities;
  /** 专属朗读音色：已安装音色 id；缺省或音色已删除 = 跟随全局音色 */
  boundVoiceId?: string;
}

export type AgentCapabilityKind = 'tasks' | 'proactive' | 'web' | 'weather' | 'stock' | 'football';
export type WebSearchProvider = 'bocha' | 'serper' | 'tavily';

export interface WebSearchSpec {
  provider: WebSearchProvider;
  apiKey: string;
  endpoint?: string;
}

export interface AgentCapabilitySpec {
  web?: WebSearchSpec;
  intervalMinutes?: number;
  wakingHours?: [number, number];
  exampleTasks?: string[];
  maxActiveTasksPerDay?: number;
  detectedAt?: number;
  source?: 'import' | 'manual';
}

export interface AgentCapabilities {
  enabled: AgentCapabilityKind[];
  spec: AgentCapabilitySpec;
}

export type MultiAgentDepType = 'model' | 'agent_api' | 'tool_api' | 'memory' | 'other';
export type MultiAgentDepProtocol = 'openai' | 'rest' | 'a2a' | 'mcp' | 'other';
export type MultiAgentDepAuth = 'api_key' | 'bearer' | 'oauth' | 'none';

export interface MultiAgentDependency {
  key: string;
  type: MultiAgentDepType;
  protocol: MultiAgentDepProtocol;
  auth: MultiAgentDepAuth;
  usage: string;
  example: string;
  ref: string;
}

export interface AgentMultiConfig {
  raw: string;
  format: 'yaml' | 'json';
  deps: MultiAgentDependency[];
  credentials: Record<string, string>;
}

// ── 音色（镜像 src/main/config.ts）─────────────────────────────────────────

/** 音色引擎配置（system 系统音色 / cloud OpenAI 兼容云合成 / gptsovits 自建 GPT-SoVITS） */
export interface VoiceConfig {
  engine: 'system' | 'cloud' | 'gptsovits';
  voiceName?: string;
  baseUrl?: string;
  model?: string;
  voiceId: string;
  instructions?: string;
  sampleText?: string;
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  textLang?: string;
}

/** 已安装到本机的音色（商店资产或本机自建，随 config 云同步） */
export interface InstalledVoice {
  id: string;
  name: string;
  description?: string;
  config: VoiceConfig;
  sampleUrl?: string | null;
  version?: string;
  installedAt: number;
  fromStore?: boolean;
}

/** 用户自配的云 TTS 服务凭证（全局共享） */
export interface TtsCloudConfig {
  engine?: 'openai' | 'gptsovits';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 会话历史消息（按档案隔离存储） */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
}

// ── 宠物（镜像 src/main/config.ts 的 PetSettings）────────────────────────────

/** 宠物动作定义（帧序列 / 模型内置 clip / 视频） */
export interface PetActionConfig {
  id: string;
  name: string;
  kind: 'frames' | 'clip' | 'video';
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  frameRate?: number;
  frameFiles?: string[];
  clipName?: string;
  videoFile?: string;
  petAssetId?: string;
  builtinPetId?: string;
}

/** 互动绑定：feed/rest/play → 动作 id */
export type PetActionBindings = Partial<Record<'feed' | 'rest' | 'play', string>>;

/** 已安装到本机的宠物（资源包 / 内置形象） */
export interface InstalledPet {
  id: string;
  name: string;
  format: string;
  localPath?: string;
  version?: string;
  installedAt: number;
  fromStore?: boolean;
}

/** 宠物窗口外观 */
export interface PetWindowSettings {
  width: number;
  height: number;
  /** 0~1 透明度 */
  opacity: number;
}

/** 宠物功能开关（喂食/玩耍/休息） */
export interface PetFeatureSettings {
  feedEnabled: boolean;
  playEnabled: boolean;
  restEnabled: boolean;
}

/** 宠物系统设置（与 pet/api 的 12 个配置键对应 + 窗口/开关等本机偏好） */
export interface PetSettings {
  petAssetPath: string;
  petAssetName: string;
  petAssetId: string;
  petAssetFormat: string;
  builtinPet: string;
  petActions: PetActionConfig[];
  petActionBindings: PetActionBindings;
  petState: PetVitals;
  petStateReady: boolean;
  petSelfDescription: string;
  currentPet: string;
  downloadedPets: InstalledPet[];
  petWindow: PetWindowSettings;
  petFeatures: PetFeatureSettings;
  petSystemEnabled: boolean;
  moodFromChat: boolean;
}

/** 宠物运行时状态（主进程 → 宠物窗口） */
export interface PetRuntimeState {
  vitals: PetVitals;
  ready: boolean;
  /** 当前选用的宠物（无则 null） */
  current: InstalledPet | null;
}

export interface AppConfig {
  agentType: string;
  userProfile: UserProfile;
  platform: {
    baseUrl: string;
    frontendUrl: string;
    accessToken: string;
    refreshToken: string;
    user: { id: string; username: string; email: string; role: 'user' | 'admin' } | null;
  };
  /** 智能体主动对话配置 */
  agentProactive?: { enabled: boolean; intervalMinutes: number };
  /** 语音朗读配置（Edge TTS 免费 Neural 音色优先，系统 Web Speech 兜底） */
  speech?: {
    enabled: boolean;
    /** 音色：'' 或 'edge:ShortName'（Edge 神经音色）| 'sys:voiceURI'（系统声音）；空 = Edge 默认晓晓 */
    voice?: string;
    /** @deprecated 旧系统音色字段，读取时兼容迁移 */
    voiceURI?: string;
    /** 语气预设：natural=自然 happy=开心 gentle=温柔 serious=严肃 lazy=慵懒 */
    tone: 'natural' | 'happy' | 'gentle' | 'serious' | 'lazy';
    /** 语速 0.5~2 */
    rate: number;
    /** 声线（音调）0~2 */
    pitch: number;
    /** 音量 0~1 */
    volume: number;
  };
  /** 多 API 配置档案 = 智能体：各档案同级、选中即生效；对话与定时任务按档案隔离 */
  llmProfiles?: LlmProfile[];
  /** 当前生效的档案 id */
  llmActiveProfileId?: string;
  /** 各档案的聊天记录（按档案 id 隔离） */
  profileMessages?: Record<string, StoredChatMessage[]>;
  /** 已安装音色（本机音色库；不含任何 API Key） */
  downloadedVoices?: InstalledVoice[];
  /** 全局音色选择（downloadedVoices[].id）；空 = 用桌面 Edge/系统音色 */
  activeCloudVoiceId?: string;
  /** 云 TTS 服务凭证（全局共享） */
  ttsCloudConfig?: TtsCloudConfig;
  /** 是否显示思考过程（DeepSeek 风格思考卡） */
  showThinking?: boolean;
  /** 思考语言：auto=跟随模型 zh/en=提示模型用对应语言思考 */
  thinkingLang?: 'auto' | 'zh' | 'en';
  /** 清空对话前是否弹确认：ask=每次询问（默认） never=直接清空 */
  chatClearConfirm?: 'ask' | 'never';
  agentConfigPath?: string;
  installedAgentId?: string;
  installedAgentConfig?: unknown;
  /** 宠物系统设置（与共享模块 pet/api 的 12 个配置键对应，另含窗口/开关等本机偏好） */
  pet?: PetSettings;
}

/** 平台账号用户（镜像 AppConfig.platform.user） */
export type AccountUser = AppConfig['platform']['user'];

/** 平台账号状态（创作中心「上传/发布」据此显示登录卡） */
export interface PlatformAuthState {
  loggedIn: boolean;
  user: AccountUser;
  baseUrl: string;
}

/** 创作中心工作区 id */
export type StudioWorkspaceTab = 'agents' | 'voices' | 'pets';

/** 待上传文件：渲染端读成字节随 IPC 传给主进程（结构化克隆，不经文件系统） */
export interface PublishFilePayload {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

/** 发布载荷（智能体 → POST /agents，音色 → POST /voices） */
export interface PublishPayload {
  type: 'agent' | 'voice';
  /** 纯文本字段（tags/configSchema/dependencies 等由渲染端序列化） */
  fields: Record<string, string>;
  /** 资源文件（智能体配置 JSON 等） */
  file?: PublishFilePayload;
  preview?: PublishFilePayload;
}

/** 发布成功返回的资源摘要 */
export interface PublishedAsset {
  id?: string;
  name?: string;
  status?: string;
}

/** 界面会话消息（渲染端内存态；持久化形态见 StoredChatMessage） */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（仅开启 showThinking 的模型会返回；随回复持久化） */
  reasoning?: string;
  /** 思考用时（秒）：首个思考增量 → 首个正文增量；非流式降级退回整请求耗时 */
  thinkSeconds?: number;
  /** 已发出、尚未产出任何内容的等待态（Trae 式「正在思考」+ 圆点） */
  pending?: boolean;
  streaming?: boolean;
  /** 本条为失败气泡：显示错误文案，点击重试 */
  error?: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      chat: {
        send: (message: string, images?: string[]) => Promise<ChatResult>;
        /** 重试失败回复：不重复写入用户消息，用历史里的末条问题重新补全 */
        retry: () => Promise<ChatResult>;
        clear: () => Promise<{ success: boolean }>;
        getHistory: () => Promise<{
          success: boolean;
          history: Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string }>;
        }>;
      };

      config: {
        get: () => Promise<AppConfig>;
        set: (partial: Partial<AppConfig>) => Promise<AppConfig>;
      };

      platform: {
        search: (type: 'agent' | 'voice', query: string, page?: number) => Promise<unknown>;
        getDetail: (type: 'agent' | 'voice', id: string) => Promise<unknown>;
        download: (type: 'agent' | 'voice', id: string) => Promise<unknown>;
        install: (type: 'agent' | 'voice', id: string) => Promise<unknown>;
        uninstall: (type: 'agent' | 'voice', id: string) => Promise<{ success: boolean }>;
        getInstalledAgent: () => Promise<unknown>;
        login: (identifier: string, password: string) => Promise<unknown>;
        logout: () => Promise<{ success: boolean }>;
        openStore: () => Promise<{ success: boolean }>;
        /** 发布资源（创作中心「上传/发布」工作区） */
        upload: (payload: PublishPayload) => Promise<{ success: boolean; asset?: PublishedAsset; error?: string }>;
        /** 平台账号状态 */
        authStatus: () => Promise<PlatformAuthState>;
        /** 本机保存的平台令牌（平台 Web 窗口启动时沿用桌面端登录态） */
        authTokens: () => Promise<{ accessToken: string; refreshToken: string }>;
        /** 平台 Web 窗口登录/续期后同步令牌到主进程 */
        syncAuth: (tokens: {
          accessToken: string;
          refreshToken?: string;
          user?: AccountUser | null;
        }) => Promise<PlatformAuthState>;
        clearAuth: () => Promise<{ loggedIn: boolean }>;
      };

      /** 宠物窗口 / 宠物库（桌宠功能模块） */
      pet: {
        /** 宠物运行时状态（四维 + 就绪态 + 当前宠物） */
        getState: () => Promise<PetRuntimeState>;
        /** 打开桌宠悬浮窗 */
        open: () => Promise<{ success: boolean }>;
        /** 关闭桌宠悬浮窗 */
        close: () => Promise<{ success: boolean }>;
        /** 互动动作：feed / play / rest，返回互动后的四维 */
        action: (kind: 'feed' | 'play' | 'rest') => Promise<{ success: boolean; vitals?: PetVitals }>;
        /** 安装宠物（资源包 id） */
        install: (id: string) => Promise<{ success: boolean; pet?: InstalledPet }>;
        /** 卸载宠物 */
        uninstall: (id: string) => Promise<{ success: boolean }>;
        /** 主进程广播宠物状态变化 */
        onState: (callback: (state: PetRuntimeState) => void) => (() => void);
        /** 主进程投递宠物消息（主动搭话等） */
        onMessage: (callback: (message: string) => void) => (() => void);
      };

      /** 创作中心：内嵌在资源中心窗口内容区（不再单独开窗） */
      workshop: {
        /** 资源中心页面测量内容区后上报；visible=false 摘掉视图 */
        embed: (payload: {
          visible: boolean;
          rect?: { x: number; y: number; width: number; height: number };
          tab?: StudioWorkspaceTab;
        }) => Promise<{ success: boolean }>;
      };

      /** 导出文本文件（智能体配置 .json 等）：系统保存对话框 → 写盘 */
      files: {
        saveText: (args: { defaultFileName: string; content: string; title?: string }) => Promise<{
          saved: boolean;
          path?: string;
          error?: string;
        }>;
      };

      tts: {
        /** Edge 神经音色合成（免费在线），失败返回 null 由渲染端回退系统 TTS */
        speak: (args: {
          text: string;
          voice?: string;
          tone?: string;
          rate?: number;
          pitch?: number;
          volume?: number;
        }) => Promise<string | null>;
        /** 云音色合成（OpenAI 兼容 /audio/speech 或自建 GPT-SoVITS）：Key 留在主进程 */
        cloudSpeak: (args: { text: string; config: VoiceConfig; speed?: number }) => Promise<{
          success: boolean;
          /** data:audio/...;base64,... 可直接作为 audio.src */
          dataUrl?: string;
          error?: string;
        }>;
        /** GPT-SoVITS 引擎连通性测试 */
        testGptsovits: (baseUrl: string) => Promise<{ online: boolean; message: string }>;
      };

      onChatChunk: (callback: (chunk: string) => void) => (() => void);
      /** 思考过程增量（reasoning_content/reasoning；与正文分流） */
      onChatReasoning: (callback: (chunk: string) => void) => (() => void);
      /** 智能体主动对话消息（主进程定时投递） */
      onAgentMessage: (callback: (message: string) => void) => (() => void);
      /** 创作中心窗口切换工作区（入口指定落地页） */
      onStudioWorkspace: (callback: (tab: StudioWorkspaceTab) => void) => (() => void);
      /** 配置广播：其他窗口改动配置后同步刷新本窗口 */
      onConfigChanged: (callback: (config: AppConfig) => void) => (() => void);
    };
  }
}
