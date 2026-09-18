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
  };
  petFeatures: {
    feedEnabled: boolean;
    restEnabled: boolean;
    playEnabled: boolean;
    affectionEnabled: boolean;
  };
  petActions: PetAction[];
  petActionBindings?: { feed?: string; rest?: string; play?: string };
  llm: LLMConfig;
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
  /** 动作生成专用 AI 覆盖（可选） */
  actionLLM?: { model?: string; baseUrl?: string; temperature?: number };
  /** 智能体主动对话配置 */
  agentProactive?: { enabled: boolean; intervalMinutes: number };
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
  kind: 'transform' | 'frames' | 'clip';
  source: 'ai' | 'manual' | 'platform';
  transform?: {
    loop: boolean;
    duration: number;
    keyframes: Array<{ t: number; dx: number; dy: number; rotation: number; scale: number; view?: 'front' | 'side' | 'back' }>;
  };
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
        send: (message: string) => Promise<ChatResult>;
        clear: () => Promise<{ success: boolean }>;
        greet: () => Promise<ChatResult>;
        getHistory: () => Promise<{
          success: boolean;
          history: Array<{ role: 'user' | 'assistant'; content: string }>;
        }>;
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
      };

      actions: {
        generate: (name: string) => Promise<{ success: boolean; action?: PetAction; error?: string }>;
        addFrames: (
          name: string,
          files: Array<{ filename: string; data: Uint8Array }>
        ) => Promise<{ success: boolean; action?: PetAction; error?: string }>;
        remove: (id: string) => Promise<{ success: boolean; error?: string }>;
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
    };
  }
}
