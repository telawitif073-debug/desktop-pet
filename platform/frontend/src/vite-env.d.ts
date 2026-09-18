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
    };
    config?: {
      get: () => Promise<{
        petWindow?: { width: number; height: number; opacity: number };
        petFeatures?: { feedEnabled: boolean; restEnabled: boolean; playEnabled: boolean; affectionEnabled: boolean };
        randomMoveEnabled?: boolean;
      } & Record<string, unknown>>;
      set: (partial: Record<string, unknown>) => Promise<unknown>;
    };
  };
}
