/**
 * 键盘高度 hook：返回当前键盘高度（DIP）与可见性，供输入区留白使用。
 *
 * 背景：本应用开启 edge-to-edge（gradle.properties edgeToEdgeEnabled=true），
 * 系统不再为输入法收缩窗口，必须由 JS 自行在底部留出键盘高度的空白。
 *
 * 关键设计——看门狗校正（解决历史顽疾）：
 * keyboardDidHide 在部分机型 / 收起方式（下滑收起、切换输入法、切后台再回来）下会丢失，
 * 事件一旦丢失，kbHeight 会残留一个键盘高度的值，把输入区顶到半屏：
 * 聊天列表被压成只剩上半屏、下方留出一大片既点不动也滚不动的空白。
 * 因此除事件外，另用原生 IME 真实状态（Keyboard.isVisible / metrics）每 500ms 校正一次：
 * 连续两次探测到「不可见」才归零，避免弹出动画期间的瞬时误判造成底栏抖动。
 * 只要原生状态正确，无论事件是否送达，最终都能收敛到正确留白。
 */
import { useEffect, useState } from 'react';
import { AppState, Dimensions, Keyboard, KeyboardEvent, Platform } from 'react-native';

/** 键盘高度上限：杜绝任何异常大值把底栏推到屏幕外 */
const MAX_RATIO = 0.55;
/** 看门狗轮询间隔 */
const WATCH_MS = 500;

export function useKeyboardHeight(): { kbHeight: number; kbVisible: boolean } {
  const [kbHeight, setKbHeight] = useState(0);
  const [kbVisible, setKbVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const maxH = Math.round(Dimensions.get('window').height * MAX_RATIO);
    const apply = (h: number, visible: boolean): void => {
      setKbHeight(visible ? Math.min(h, maxH) : 0);
      setKbVisible(visible);
    };
    const hide = (): void => apply(0, false);

    // 主信号：键盘事件（响应最快，弹出即时给出准确高度）
    const showSub = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => {
      apply(e.endCoordinates.height, true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', hide);

    // 后台切回前台强制清零：后台期间系统收掉键盘，事件可能不送达
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') hide();
    });

    // 兜底信号：以原生 IME 状态为准做校正，事件丢失时自动归零
    let missCount = 0;
    const timer = setInterval(() => {
      let visible: boolean;
      let h = 0;
      try {
        visible = Keyboard.isVisible();
        h = Keyboard.metrics()?.height ?? 0;
      } catch {
        return; // 该 RN 版本无此 API：退回纯事件驱动
      }
      if (visible) {
        missCount = 0;
        if (h > 0) apply(h, true);
      } else {
        missCount += 1;
        if (missCount >= 2) hide();
      }
    }, WATCH_MS);

    return () => {
      clearInterval(timer);
      showSub.remove();
      hideSub.remove();
      appSub.remove();
    };
  }, []);

  return { kbHeight, kbVisible };
}
