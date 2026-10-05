/**
 * 桌宠悬浮窗创建（主进程）
 * ---------------------------------------------------------------------------
 * 与对话/创作中心窗口一致的 preload 安全基线（contextIsolation + 关 nodeIntegration），
 * 差异只在「透明 / 无边框 / 置顶 / 不进任务栏」这几个桌宠必备窗口属性，
 * 尺寸与透明度取自 config.pet.petWindow（渲染端设置面板可调）。
 */
import { BrowserWindow } from 'electron';
import { loadConfig } from '../config';

/** 渲染端入口（dev 用 Vite server，打包后用构建产物），由 main.ts 解析后注入 */
export type RendererTarget = { kind: 'url'; url: string } | { kind: 'file'; file: string; hash: string };

export interface PetWindowOptions {
  /** preload 脚本绝对路径（与其它窗口同一份 preload） */
  preloadPath: string;
  target: RendererTarget;
}

/** 创建桌宠悬浮窗（调用方负责持有引用并处理 closed 事件） */
export function createPetWindow(opts: PetWindowOptions): BrowserWindow {
  const size = loadConfig().pet?.petWindow;
  const win = new BrowserWindow({
    width: size?.width ?? 220,
    height: size?.height ?? 260,
    opacity: size?.opacity ?? 0.9,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    title: '宠物',
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 网页 title 不覆盖窗口标题：窗口/Taskbar 保持「宠物」
  win.on('page-title-updated', (event) => event.preventDefault());
  if (opts.target.kind === 'url') {
    void win.loadURL(opts.target.url);
  } else {
    void win.loadFile(opts.target.file, { hash: opts.target.hash.replace(/^#/, '') });
  }
  return win;
}
