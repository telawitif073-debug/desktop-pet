import { useEffect, useRef } from 'react';
import { Empty, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';

/** 允许的落地工作区（与桌面端 StudioWorkspaceTab 一致；动作已并入宠物资源） */
const TAB_KEYS = ['pets', 'agents', 'voices'] as const;
type WorkshopTab = (typeof TAB_KEYS)[number];
/** 历史入口（上传/发布、动作）统一落到「宠物资源」页 */
const LEGACY_TABS: Record<string, WorkshopTab> = { publish: 'pets', actions: 'pets' };

/**
 * 资源中心内的「宠工坊」页：内容区交给主进程嵌入的宠工坊视图（同一份桌面渲染包），
 * 本站顶栏/导航常驻，不再新开独立窗口。页面只负责测量内容区并把矩形上报给主进程。
 * 浏览器环境（没有 Electron 桥）下给出说明，不显示空白。
 */
export default function WorkshopPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') ?? '';
  const tab: WorkshopTab | undefined = TAB_KEYS.includes(tabParam as WorkshopTab)
    ? (tabParam as WorkshopTab)
    : LEGACY_TABS[tabParam];
  const bridge = window.electronAPI?.workshop;

  useEffect(() => {
    const container = containerRef.current;
    if (!bridge || !container) return;

    // 内嵌视图贴的是窗口坐标，页面滚动会让矩形漂移：进入宠工坊期间禁掉页面滚动
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.scrollTo(0, 0);

    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = container.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      if (visibleHeight < 80) {
        void bridge.embed({ visible: false });
        return;
      }
      void bridge.embed({
        visible: true,
        tab,
        rect: {
          x: Math.max(rect.left, 0),
          y: Math.max(rect.top, 0),
          width: rect.width,
          height: visibleHeight,
        },
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };

    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener('resize', schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.body.style.overflow = previousOverflow;
      void bridge.embed({ visible: false });
    };
  }, [bridge, tab]);

  return (
    <div className="workshop-page">
      <div ref={containerRef} className="workshop-embed-area">
        {!bridge && (
          <div className="workshop-embed-fallback">
            <Empty
              description={
                <span>
                  宠工坊在桌面宠物客户端中打开
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    这个页面会把宠工坊（智能体 / 动作 / 音色 / 上传发布）嵌进资源中心窗口的内容区，需要桌面客户端环境。
                  </Typography.Paragraph>
                </span>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}