/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 桌面客户端（Electron）注入的桥接 API；浏览器环境下不存在
interface Window {
  electronAPI?: {
    platform?: {
      install: (type: 'agent', id: string) => Promise<{ success: boolean; type: string; id: string; path: string }>;
      uninstall: (type: 'agent', id: string) => Promise<{ success: boolean }>;
      getInstalledAgent: () => Promise<{ id: string | null; type: string; configPath: string | null; config: unknown }>;
      /** 登录/续期后把令牌同步给桌面主进程（桌面端下载/安装/上传共用同一登录态） */
      syncAuth?: (tokens: { accessToken: string; refreshToken?: string; user?: unknown }) => Promise<unknown>;
      clearAuth?: () => Promise<unknown>;
      /** 读取桌面端已保存的令牌（本窗口没有登录态时沿用） */
      authTokens?: () => Promise<{ accessToken: string; refreshToken: string }>;
      authStatus?: () => Promise<{ loggedIn: boolean; baseUrl: string }>;
    };
    /** 资源工坊：内嵌到本窗口内容区（主进程把桌面端工坊视图挂到这里，不再新开窗口） */
    workshop?: {
      embed: (payload: {
        visible: boolean;
        rect?: { x: number; y: number; width: number; height: number };
        tab?: 'agents' | 'voices';
      }) => Promise<{ success: boolean }>;
    };
    config?: {
      get: () => Promise<Record<string, unknown>>;
      set: (partial: Record<string, unknown>) => Promise<unknown>;
    };
  };
}
