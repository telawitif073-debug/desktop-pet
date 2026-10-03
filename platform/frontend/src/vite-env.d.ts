/// <reference types="vite/client" />

// gifenc（GIF 编码器）未随包发布类型声明
declare module 'gifenc' {
  export function GIFEncoder(opt?: { auto?: boolean; initialCapacity?: number }): {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; first?: boolean },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    bytesView: () => Uint8Array;
    reset: () => void;
  };
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}

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
      /** 登录/续期后把令牌同步给桌面主进程（桌面端下载/安装/上传共用同一登录态） */
      syncAuth?: (tokens: { accessToken: string; refreshToken?: string; user?: unknown }) => Promise<unknown>;
      clearAuth?: () => Promise<unknown>;
      /** 读取桌面端已保存的令牌（本窗口没有登录态时沿用） */
      authTokens?: () => Promise<{ accessToken: string; refreshToken: string }>;
      authStatus?: () => Promise<{ loggedIn: boolean; baseUrl: string }>;
    };
    /** 宠工坊：内嵌到本窗口内容区（主进程把桌面端宠工坊视图挂到这里，不再新开窗口） */
    workshop?: {
      embed: (payload: {
        visible: boolean;
        rect?: { x: number; y: number; width: number; height: number };
        tab?: 'pets' | 'agents' | 'voices' | 'actions' | 'publish';
      }) => Promise<{ success: boolean }>;
    };
    config?: {
      get: () => Promise<{
        petWindow?: { width: number; height: number; opacity: number; alwaysOnTop?: boolean };
        petFeatures?: { feedEnabled: boolean; restEnabled: boolean; playEnabled: boolean; affectionEnabled: boolean };
        randomMoveEnabled?: boolean;
      } & Record<string, unknown>>;
      set: (partial: Record<string, unknown>) => Promise<unknown>;
    };
  };
}
