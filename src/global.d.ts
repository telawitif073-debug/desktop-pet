export {};

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
