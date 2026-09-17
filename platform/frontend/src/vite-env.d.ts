/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 桌面宠物客户端（Electron）注入的桥接 API；浏览器环境下不存在
interface Window {
  electronAPI?: {
    platform?: {
      install: (type: 'pet' | 'agent', id: string) => Promise<{ success: boolean; type: string; id: string; path: string }>;
      uninstall: (type: 'pet' | 'agent', id: string) => Promise<{ success: boolean }>;
      getInstalledPet: () => Promise<{ path: string; dataUrl: string } | null>;
      getInstalledAgent: () => Promise<{ id: string | null; type: string; configPath: string | null; config: unknown }>;
    };
    config?: {
      get: () => Promise<{
        petWindow?: { width: number; height: number; opacity: number };
        petFeatures?: { feedEnabled: boolean; restEnabled: boolean; playEnabled: boolean; affectionEnabled: boolean };
      } & Record<string, unknown>>;
      set: (partial: Record<string, unknown>) => Promise<unknown>;
    };
  };
}
