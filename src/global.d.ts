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
  /** 绑定的宠物形象 ID（一个智能体必须且只能绑定一个宠物形象） */
  petAssetId?: string;
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

/** 宠物定时任务（按档案隔离） */
export interface PetTask {
  id: string;
  profileId: string;
  kind: 'reminder' | 'active_chat';
  rawText: string;
  content: string;
  timeLabel: string;
  due: number;
  repeat: 'none' | 'daily' | 'weekly';
  status: 'pending' | 'paused' | 'done' | 'canceled';
  createdAt: number;
  firedAt?: number;
}

/** 会话历史消息（按档案隔离存储） */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
}

/** 云端语音识别接口配置（镜像 src/main/config.ts VoiceAsrApiConfig） */
export interface VoiceAsrApiConfig {
  /** transcribe=OpenAI 兼容转写接口；chat=多模态聊天模型转写 */
  mode: 'transcribe' | 'chat';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 语言提示（仅 transcribe 生效，默认 zh） */
  language?: string;
}

export interface AppConfig {
  petSystemEnabled: boolean;
  randomMoveEnabled: boolean;
  agentType: string;
  userProfile: UserProfile;
  petState: {
    hunger: number;
    mood: number;
    energy: number;
    affection: number;
  };
  petWindow: {
    width: number;
    height: number;
    opacity: number;
    /** 是否置顶显示，默认 true */
    alwaysOnTop?: boolean;
  };
  petFeatures: {
    feedEnabled: boolean;
    restEnabled: boolean;
    playEnabled: boolean;
    affectionEnabled: boolean;
  };
  petActions: PetAction[];
  petActionBindings?: { feed?: string; rest?: string; play?: string };
  platform: {
    baseUrl: string;
    frontendUrl: string;
    accessToken: string;
    refreshToken: string;
    user: { id: string; username: string; email: string; role: 'user' | 'admin' } | null;
  };
  petAssetPath?: string;
  petAssetName?: string;
  /** 当前安装宠物资源 id（platform 动作挂靠归属） */
  petAssetId?: string;
  /** 宠物形态：单图(含GIF)/多图包/Live2D/3D模型 */
  petAssetFormat?: 'image' | 'pack' | 'live2d' | 'model3d';
  /** 当前使用的内置演示宠物 id（离线可用）；与 petAsset* 互斥 */
  builtinPet?: string;
  /** 智能体主动对话配置 */
  agentProactive?: { enabled: boolean; intervalMinutes: number };
  /** 宠物语音朗读配置（Edge TTS 免费 Neural 音色优先，系统 Web Speech 兜底） */
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
  /** 聊天是否联动宠物心情 */
  moodFromChat?: boolean;
  /** 宠物定时任务（按档案隔离） */
  petTasks?: PetTask[];
  /** 清空对话前是否弹确认：ask=每次询问（默认） never=直接清空 */
  chatClearConfirm?: 'ask' | 'never';
  /** 感知能力开关（隐私敏感，默认全关） */
  petSenses?: { screen: boolean; mic: boolean; camera: boolean };
  /** 宠物名字（语音唤醒词） */
  petName?: string;
  /** 唤醒后对话模式：once=每次对话后需重新叫名字（默认） continuous=连续对话 */
  voiceWakeMode?: 'once' | 'continuous';
  /** 语音唤醒模型包来源（本地 zip 路径或下载 URL），由用户在聊天设置中配置导入 */
  voiceModelSource?: string;
  /** 宠物「听懂说话」来源：本地模型包 / 在线接口 / 智能体自带（镜像 VoiceAsrConfig） */
  voiceAsr?: {
    source?: 'local' | 'api' | 'agent';
    api?: VoiceAsrApiConfig;
    /** 智能体自带识别时替换成自己的 Key（可选） */
    agentApiKey?: string;
  };
  /** 宠物自我形象描述（更换形象/智能体时多模态 LLM 识别生成，注入对话 system prompt） */
  petSelfDescription?: string;
  /** 上次形象识别的指纹（资产标识+agentId），变化时才重新识别 */
  selfImageFingerprint?: string;
  agentConfigPath?: string;
  installedAgentId?: string;
  installedAgentConfig?: unknown;
}

/** 平台账号用户（镜像 AppConfig.platform.user） */
export type AccountUser = AppConfig['platform']['user'];

/** 平台账号状态（宠工坊「上传/发布」据此显示登录卡） */
export interface PlatformAuthState {
  loggedIn: boolean;
  user: AccountUser;
  baseUrl: string;
}

/** 宠工坊工作区 id（主进程按入口指定落地页；动作已并入宠物资源） */
export type StudioWorkspaceTab = 'pets' | 'agents' | 'voices';

/** 待上传文件：渲染端读成字节随 IPC 传给主进程（结构化克隆，不经文件系统） */
export interface PublishFilePayload {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

/** 发布载荷（对应平台 POST /pets、POST /agents、POST /voices） */
export interface PublishPayload {
  type: 'pet' | 'agent' | 'voice';
  /** 纯文本字段（tags/actionsMeta/configSchema/dependencies 等由渲染端序列化） */
  fields: Record<string, string>;
  file?: PublishFilePayload;
  preview?: PublishFilePayload;
  /** 帧图 zip（顺序须与 actionsMeta 中需要文件的项一致） */
  actionFiles?: PublishFilePayload[];
  actionsMeta?: Array<{ name: string; interaction?: 'none' | 'feed' | 'rest' | 'play'; clipName?: string }>;
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

/** 宠物动作（渲染端镜像 src/main/config.ts 的 PetAction） */
export interface PetAction {
  id: string;
  name: string;
  kind: 'frames' | 'clip';
  source: 'ai' | 'manual' | 'platform';
  frameFiles?: string[];
  frameRate?: number;
  /** kind=clip 时的模型内置动画名称 */
  clipName?: string;
  /** 所属宠物资源 id（platform 来源动作，随宠物安装/清除） */
  petAssetId?: string;
  /** 所属内置演示宠物 id（内置演示宠物安装产生的动作，用于精确识别/清理） */
  builtinPetId?: string;
  /** 互动绑定（feed/rest/play） */
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  createdAt: number;
}

/** 内置演示宠物摘要（渲染端镜像 src/main/builtinPets.ts 的 BuiltinPetSummary） */
export interface BuiltinPetSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  actionCount: number;
  frameCount: number;
  /** 当前是否正在使用 */
  active: boolean;
}

/** 上游美术资源库条目（渲染端镜像 src/main/petLibrary.ts 的 PetLibrarySummary） */
export interface PetLibrarySummary {
  /** 相对资源库根的路径，library.read/apply/addAction 都用它 */
  file: string;
  sha256?: string;
  bytes?: number;
  /** raster=已归一化 PNG（可设为形象/动作）；svg=矢量素材（仅预览） */
  format?: string;
  repo: string;
  repoUrl: string;
  license: string;
  originalPath: string;
  /** 磁盘上确实存在（索引与实际文件不一致时为 false） */
  available: boolean;
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

      // Sense（感知能力，商店设置中开启后可用）
      sense: {
        /** 截取屏幕画面（需开启「查看桌面」） */
        captureScreen: () => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
        /** 摄像头定时帧上送（持续感知） */
        cameraFrame: (dataUrl: string) => Promise<{ success: boolean; error?: string }>;
      };

      // sherpa-onnx 离线语音识别（语音唤醒）：模型由用户在聊天设置导入，平台不内置
      sherpa: {
        getModel: () => Promise<{ ok: boolean; path?: string }>;
        importModel: (source: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      };

      // 云端语音识别（在线来源）：渲染端只传音频，接口配置与 Key 留在主进程
      asr: {
        transcribe: (payload: { wavBase64: string }) =>
          Promise<{ ok: boolean; text?: string; error?: string }>;
      };

      // 宠物自我形象识别（更换形象/智能体后识别自己并记住）
      self: {
        recognize: (dataUrl: string) =>
          Promise<{ ok: boolean; skipped?: boolean; description?: string; error?: string }>;
      };

      config: {
        get: () => Promise<AppConfig>;
        set: (partial: Partial<AppConfig>) => Promise<AppConfig>;
      };

      platform: {
        search: (type: 'pet' | 'agent', query: string, page?: number) => Promise<unknown>;
        getDetail: (type: 'pet' | 'agent', id: string) => Promise<unknown>;
        download: (type: 'pet' | 'agent', id: string) => Promise<unknown>;
        install: (type: 'pet' | 'agent', id: string) => Promise<unknown>;
        uninstall: (type: 'pet' | 'agent', id: string) => Promise<{ success: boolean }>;
        getInstalledPet: () => Promise<{ path: string; dataUrl: string | null } | null>;
        getInstalledAgent: () => Promise<unknown>;
        login: (identifier: string, password: string) => Promise<unknown>;
        logout: () => Promise<{ success: boolean }>;
        openStore: () => Promise<{ success: boolean }>;
        /** 发布资源（宠工坊「上传/发布」工作区） */
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

      /** 宠工坊：内嵌在资源中心窗口内容区（不再单独开窗） */
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

      pet: {
        stateUpdate: (state: {
          hunger: number;
          mood: number;
          energy: number;
          affection: number;
        }) => Promise<{ success: boolean }>;
        wanderStart: (opts: {
          dx: number;
          durationMs: number;
        }) => Promise<{ ok: boolean; reason?: string }>;
        onWanderState: (callback: (moving: boolean) => void) => (() => void);
        onZoomChanged: (callback: (side: number) => void) => (() => void);
      };

      actions: {
        addFrames: (
          name: string,
          files: Array<{ filename: string; data: Uint8Array }>
        ) => Promise<{ success: boolean; action?: PetAction; error?: string }>;
        remove: (id: string) => Promise<{ success: boolean; error?: string }>;
        /** 播放动作（转交宠物窗渲染） */
        play: (id: string) => Promise<{ success: boolean }>;
      };

      /** 内置演示宠物（离线可用，随包分发） */
      builtin: {
        list: () => Promise<{ success: boolean; pets: BuiltinPetSummary[]; error?: string }>;
        apply: (id: string) => Promise<{ success: boolean; error?: string; actionIds?: string[] }>;
        reset: () => Promise<{ success: boolean; error?: string }>;
      };

      /** 上游美术资源库（GitHub「pet」项目导入的静态素材）：设为形象 / 加为动作 */
      library: {
        list: () => Promise<{ success: boolean; assets: PetLibrarySummary[]; error?: string }>;
        read: (file: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
        apply: (
          file: string,
          name?: string
        ) => Promise<{ success: boolean; path?: string; error?: string }>;
        addAction: (
          file: string,
          name?: string
        ) => Promise<{ success: boolean; action?: PetAction; error?: string }>;
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

      window: {
        toggleChat: (open: boolean) => Promise<{ success: boolean; isChatOpen: boolean }>;
        toggleActions: (open: boolean) => Promise<{ success: boolean }>;
        isChatOpen: () => Promise<boolean>;
        setIgnoreMouseEvents: (ignore: boolean) => void;
        beginDrag: () => void;
        dragMove: (delta: { dx: number; dy: number }) => void;
        endDrag: () => void;
        zoomPet: (direction: number) => Promise<{ success: boolean; width?: number; height?: number }>;
        showContextMenu: () => void;
      };

      onChatChunk: (callback: (chunk: string) => void) => (() => void);
      /** 思考过程增量（reasoning_content/reasoning；与正文分流） */
      onChatReasoning: (callback: (chunk: string) => void) => (() => void);
      /** 宠工坊窗口切换工作区（入口指定落地页） */
      onStudioWorkspace: (callback: (tab: StudioWorkspaceTab) => void) => (() => void);
      /** 配置广播：其他窗口改动配置后同步刷新本窗口 */
      onConfigChanged: (callback: (config: AppConfig) => void) => (() => void);
      onPetSettingsChanged: (callback: (settings: AppConfig['petWindow']) => void) => (() => void);
      onPetFeaturesChanged: (callback: (features: AppConfig['petFeatures']) => void) => (() => void);
      onPetAssetChanged: (callback: () => void) => (() => void);
      onPetContextAction: (callback: (action: string) => void) => (() => void);
      onPetActionsChanged: (callback: () => void) => (() => void);
      onPlayAction: (callback: (actionId: string) => void) => (() => void);
      onToggleActions: (callback: () => void) => (() => void);
      onAgentMessage: (callback: (message: string) => void) => (() => void);
      /** 智能体变更通知：宠物重新「看一眼」自己（导出画布并请求形象识别） */
      onSelfieRequest: (callback: () => void) => (() => void);
    };
  }
}
