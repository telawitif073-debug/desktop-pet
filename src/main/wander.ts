import { BrowserWindow } from 'electron';
import { clampPetWindow } from './windowGeometry';

// 宠物随机漫步：主进程窗口左右平移动画。
// 固定窗模型：宠物态窗口物理尺寸恒 winW×winH（650x690），视觉宠物 petSide 在窗内
// 水平居中、底边对齐；边界按「视觉矩形不出工作区」钳制，窗口透明留白允许伸出屏缘。
// 与拖拽同一防膨胀模式：每次 setBounds 都写回固定窗口尺寸（缩放屏上反复 setPosition
// 会因 DIP↔物理像素舍入使窗口外框逐帧撑大），尺寸恒定 ⇒ 只可能产生 WM_MOVE，不触发
// 透明窗 resize 同步问题。互斥（拖拽/面板展开/重复触发）由调用方在 IPC 入口校验。

let timer: NodeJS.Timeout | null = null;
let active = false;

export function isWandering(): boolean {
  return active;
}

export function stopWander(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  active = false;
}

/** 从当前位置水平平移 dx 像素（DIP），easeOutQuad 缓动；结束后回调 onDone。
 *  winW/winH 固定窗口尺寸，petSide 当前视觉边长（决定本体可移动范围）。 */
export function startWander(
  win: BrowserWindow,
  dx: number,
  durationMs: number,
  winW: number,
  winH: number,
  petSide: number,
  onDone?: () => void,
): void {
  stopWander();
  if (win.isDestroyed()) return;
  const [sx, sy] = win.getPosition();
  // 目标位置按视觉矩形钳制在「宠物当前所在显示器」工作区内（垂直位置不变）
  const targetX = clampPetWindow(sx + dx, sy, winW, winH, petSide, petSide).x;
  const totalDx = targetX - sx;
  if (totalDx === 0) return;

  active = true;
  const start = Date.now();
  timer = setInterval(() => {
    if (win.isDestroyed()) {
      stopWander();
      return;
    }
    const f = Math.min(1, (Date.now() - start) / durationMs);
    const ease = 1 - (1 - f) * (1 - f); // easeOutQuad
    win.setBounds({
      x: Math.round(sx + totalDx * ease),
      y: sy,
      width: winW,
      height: winH,
    });
    if (f >= 1) {
      stopWander();
      onDone?.();
    }
  }, 16);
}
