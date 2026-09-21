export {};

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | 'none';
  }
}

export interface ChatResult {
  success: boolean;
  text?: string;
  error?: string;
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
  foodSystemEnabled: boolean;
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
  /** 多 API 配置档案：聊天 API 全部由用户在客户端配置（平台不提供），各档案同级、选中即生效 */
  llmProfiles?: Array<{
    id: string;
    name: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    /** 档案级系统提示词；空 = 使用内置默认人格 */
    systemPrompt?: string;
  }>;
  /** 当前生效的档案 id */
  llmActiveProfileId?: string;
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
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
  /** 互动绑定（feed/rest/play） */
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  createdAt: number;
}

declare global {
  interface Window {
    electronAPI: {
      chat: {
        send: (message: string, images?: string[]) => Promise<ChatResult>;
        clear: () => Promise<{ success: boolean }>;
        greet: () => Promise<ChatResult>;
        getHistory: () => Promise<{
          success: boolean;
          history: Array<{ role: 'user' | 'assistant'; content: string }>;
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
        setBubbleExpand: (on: boolean) => Promise<number>;
        onBubbleExpandChanged: (callback: (extra: number) => void) => (() => void);
      };

      actions: {
        addFrames: (
          name: string,
          files: Array<{ filename: string; data: Uint8Array }>
        ) => Promise<{ success: boolean; action?: PetAction; error?: string }>;
        remove: (id: string) => Promise<{ success: boolean; error?: string }>;
      };

      tts: {
        speak: (args: {
          text: string;
          voice?: string;
          tone?: string;
          rate?: number;
          pitch?: number;
          volume?: number;
        }) => Promise<string | null>;
      };

      window: {
        toggleChat: (open: boolean) => Promise<{ success: boolean; isChatOpen: boolean }>;
        toggleActions: (open: boolean) => Promise<{ success: boolean }>;
        isChatOpen: () => Promise<boolean>;
        setIgnoreMouseEvents: (ignore: boolean) => void;
        beginDrag: () => void;
        dragMove: (delta: { dx: number; dy: number }) => void;
        endDrag: () => void;
        showContextMenu: () => void;
      };

      onChatChunk: (callback: (chunk: string) => void) => (() => void);
      onGreetingTrigger: (callback: () => void) => (() => void);
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
