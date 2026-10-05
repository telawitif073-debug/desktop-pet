import { describe, it, expect, vi, beforeEach } from 'vitest';

// 双显示器布局：主屏 1920x1080（workArea 高 1040）居左，副屏 1080x1920 竖屏居右
const SCREENS = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1080, height: 1920 },
];

/** 近似 Electron screen.getDisplayNearestPoint：点在屏内取该屏；都不在取矩形距离最近者 */
function nearestDisplay(point: { x: number; y: number }) {
  let best = SCREENS[0];
  let bestDist = Infinity;
  for (const wa of SCREENS) {
    const dx = Math.max(wa.x - point.x, 0, point.x - (wa.x + wa.width));
    const dy = Math.max(wa.y - point.y, 0, point.y - (wa.y + wa.height));
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = wa;
    }
  }
  return { workArea: { ...best } };
}

vi.mock('electron', () => ({
  screen: { getDisplayNearestPoint: nearestDisplay },
}));

const { clampRectToWorkArea, workAreaForRect, clampPetWindow } = await import('./windowGeometry');

describe('workAreaForRect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('按窗口中心判定所在显示器', () => {
    expect(workAreaForRect({ x: 100, y: 100, width: 300, height: 300 }).x).toBe(0);
    expect(workAreaForRect({ x: 2000, y: 100, width: 300, height: 300 }).x).toBe(1920);
  });
});

describe('clampRectToWorkArea', () => {
  it('主屏：向左/上甩不出屏（贴边为 0）', () => {
    expect(clampRectToWorkArea(-500, -80, 300, 300)).toEqual({ x: 0, y: 0 });
  });

  it('主屏：向右/下甩贴住主屏 workArea 右下缘（中心仍在主屏）', () => {
    // raw(1700,900) 中心 (1850,1050)：距主屏(仅 y 越 10px)近于副屏 → 归主屏，双轴贴缘
    expect(clampRectToWorkArea(1700, 900, 300, 300)).toEqual({
      x: 1920 - 300,
      y: 1040 - 300,
    });
  });

  it('副屏：钳制使用副屏 workArea（x 下限 1920，可贴副屏右缘）', () => {
    // 窗口中心已在副屏（x=2000 + 150 = 2150）
    const r = clampRectToWorkArea(2000, 50, 300, 300);
    expect(r.x).toBe(2000);
    expect(clampRectToWorkArea(4000, 4000, 300, 300)).toEqual({
      x: 1920 + 1080 - 300,
      y: 1920 - 300,
    });
  });

  it('副屏：试图把窗口拖回主屏但中心仍在副屏时，整窗不出副屏左缘', () => {
    // raw x=1800，中心 1950 > 1920 归副屏 → x 钳到副屏左缘 1920
    expect(clampRectToWorkArea(1800, 100, 300, 300).x).toBe(1920);
  });

  it('跨屏交界：中心越线即平滑切换归属屏（无第三屏假设）', () => {
    // raw x=1700，中心 1850 < 1920 归主屏 → 主屏右缘 1620
    expect(clampRectToWorkArea(1700, 100, 300, 300).x).toBe(1620);
    // raw x=1771，中心 1921 越过交界归副屏 → 吸附副屏左缘（避开 tie 边界点）
    expect(clampRectToWorkArea(1771, 100, 300, 300).x).toBe(1920);
  });

  it('漫步级大窗口（650x450 面板）在主屏同样完全不出 workArea', () => {
    const r = clampRectToWorkArea(-10, 900, 650, 450);
    expect(r).toEqual({ x: 0, y: 1040 - 450 });
  });
});

describe('clampPetWindow（固定 650x690 透明窗 + 居中底边对齐的视觉矩形）', () => {
  it('视觉 600x600（最大尺寸，padX=25/padTop=90）：本体贴缘时窗口留白可伸出', () => {
    // 视觉 (-475,10,600)：x 钳到 0 ⇒ winX=-25；y=10 已在屏内 winY=-80 不动
    expect(clampPetWindow(-500, -80, 650, 690, 600, 600)).toEqual({ x: -25, y: -80 });
    // 视觉 (2025,140,600) 完全落在副屏内 ⇒ 窗口位置不动
    expect(clampPetWindow(2000, 50, 650, 690, 600, 600)).toEqual({ x: 2000, y: 50 });
  });

  it('小尺寸内容（300）：视觉矩形贴主屏左/上缘时透明留白伸出屏外，本体不出屏', () => {
    // padX=175、padTop=390：视觉 (-725,-510,300) 钳到 (0,0) ⇒ win(-175,-390)
    expect(clampPetWindow(-900, -900, 650, 690, 300, 300)).toEqual({ x: -175, y: -390 });
  });

  it('小尺寸内容（200）：本体贴主屏右/下缘时，透明窗缘可伸出 workArea', () => {
    // padX=225、padTop=490：视觉 (1775,890,200) 右缘 1975/底 1090 越界，
    // 钳到 (1720,840) ⇒ win(1495,350)（窗右缘 2145 伸出主屏 225px）
    expect(clampPetWindow(1550, 400, 650, 690, 200, 200)).toEqual({ x: 1495, y: 350 });
  });

  it('面板态（视觉 650x450 在 650x690 窗内贴底，padTop=240）：顶部透明带允许伸出屏上缘', () => {
    // 视觉 (-100,-660,650,450)：x 钳 0；y 钳 0 ⇒ winY=-240
    expect(clampPetWindow(-100, -900, 650, 690, 650, 450)).toEqual({ x: 0, y: -240 });
    // 副屏右缘：视觉宽=窗宽，贴副屏右缘 winX=3000-650=2350
    expect(clampPetWindow(3000, 400, 650, 690, 650, 450).x).toBe(1920 + 1080 - 650);
  });

  it('归属屏按视觉矩形中心判定（= 窗口中心，与内边距无关）', () => {
    // 窗口中心在交界上：650 窗宽中心 x=winX+325=1920 ⇒ winX=1595，归主屏（距离相等取首个）
    expect(clampPetWindow(1595, 100, 650, 690, 300, 300).x).toBeLessThan(1920);
  });
});
