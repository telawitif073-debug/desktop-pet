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
  llm: LLMConfig;
  platform: {
    baseUrl: string;
    frontendUrl: string;
    accessToken: string;
    refreshToken: string;
    user: { id: string; username: string; email: string; role: 'user' | 'admin' } | null;
  };
  petAssetPath?: string;
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

declare global {
  interface Window {
    electronAPI: {
      moveWindow: (data: {
        screenX: number;
        screenY: number;
        offsetX: number;
        offsetY: number;
      }) => void;

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
        getInstalledPet: () => Promise<{ path: string; dataUrl: string } | null>;
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

      window: {
        toggleChat: (open: boolean) => Promise<{ success: boolean; isChatOpen: boolean }>;
        isChatOpen: () => Promise<boolean>;
      };

      onChatChunk: (callback: (chunk: string) => void) => (() => void);
      onGreetingTrigger: (callback: () => void) => (() => void);
    };
  }
}
