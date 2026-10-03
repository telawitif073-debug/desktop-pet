import { screen, type Rectangle } from 'electron';

// 多显示器窗口几何工具：所有「宠物当前所在显示器」相关的定位/钳制统一走这里，
// 避免拖拽、漫步、面板开合、截屏各自写死主显示器导致副屏行为跳变。

/** 以窗口矩形中心点判定其所在（最近）显示器的工作区 */
export function workAreaForRect(rect: { x: number; y: number; width: number; height: number }): Rectangle {
  return screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  }).workArea;
}

/** 将窗口左上角钳制在其中心所在显示器的工作区内：整窗不出屏，允许贴边。
 * 跨显示器拖拽时以窗口中心归属的屏幕为准，越过屏幕中线即平滑切换。 */
export function clampRectToWorkArea(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const wa = workAreaForRect({ x, y, width, height });
  // 窗口比工作区更宽/高时（极小分辨率）max* 可能小于 wa.x，优先取上缘对齐
  const maxX = wa.x + wa.width - width;
  const maxY = wa.y + wa.height - height;
  return {
    x: Math.min(maxX, Math.max(wa.x, Math.round(x))),
    y: Math.min(maxY, Math.max(wa.y, Math.round(y))),
  };
}

/**
 * 固定大小透明窗内的视觉矩形钳制：视觉内容在窗内水平居中、底边对齐
 * （窗口 winW×winH 恒定，视觉矩形 petW×petH ≤ 窗口，缩放只改内容大小）。
 * 以「视觉矩形不出所在显示器工作区」为准反算窗口左上角；
 * 拖拽/漫步移动的是窗口，边界语义因此始终围绕可见内容而非透明留白。
 */
export function clampPetWindow(
  winX: number,
  winY: number,
  winW: number,
  winH: number,
  petW: number,
  petH: number,
): { x: number; y: number } {
  const padX = (winW - petW) / 2;
  const padTop = winH - petH;
  const c = clampRectToWorkArea(winX + padX, winY + padTop, petW, petH);
  return { x: Math.round(c.x - padX), y: Math.round(c.y - padTop) };
}
