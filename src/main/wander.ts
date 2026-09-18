import { BrowserWindow, screen } from 'electron';

// 宠物随机漫步：主进程窗口左右平移动画。
// 与拖拽同一防膨胀模式：每次 setBounds 同时写回固定尺寸（缩放屏上反复
// setPosition 会因 DIP↔物理像素舍入使窗口外框逐帧撑大）。
// 互斥（拖拽/面板展开/重复触发）由调用方在 IPC 入口校验。

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

/** 从当前位置水平平移 dx 像素（DIP），easeOutQuad 缓动；结束后回调 onDone */
export function startWander(win: BrowserWindow, dx: number, durationMs: number, onDone?: () => void): void {
  stopWander();
  if (win.isDestroyed()) return;
  const [sx, sy] = win.getPosition();
  const [w, h] = win.getSize();
  // 目标位置钳制在工作区内（整窗不出屏；垂直位置不变）
  const { workArea } = screen.getPrimaryDisplay();
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - w;
  const targetX = Math.min(maxX, Math.max(minX, sx + dx));
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
      width: w,
      height: h,
    });
    if (f >= 1) {
      stopWander();
      onDone?.();
    }
  }, 16);
}
