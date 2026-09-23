/**
 * 键盘高度 hook：返回当前键盘高度（DIP）与可见性。
 * RN 0.87 边到边模式下系统不再为 IME 收缩窗口，需要 JS 自行给底部留白，
 * 让输入栏始终贴在键盘上方（微信效果）。键盘收起时返回 0。
 *
 * 自愈设计（核心）：keyboardDidHide 在某些收起方式（下滑/切换输入法/后台切回）下可能不触发，
 * 若只靠它清零，kbHeight 会残留大值把输入区撑到半屏、聊天列表被压成只剩上半屏、下方出现
 * 一大片既点不动也滚不动的空白（用户此前反馈的两类界面问题均源于此）。
 * 因此采用多信号冗余，任何一路生效都能保证最终归零：
 *  1. keyboardDidShow/Hide：弹出即给高度，收起即清零（主信号）；
 *  2. 窗口高度变化（adjustResize）：键盘收起必然把窗口恢复回全高，据此强制清零（自愈）；
 *  3. AppState 回前台强制清零：后台期间系统收掉键盘但事件可能丢失。
 * 注：keyboardWillHide 仅 iOS 有效，Android 不触发，不使用。
 */
import { useEffect, useState } from 'react';
import { AppState, Dimensions, Keyboard, KeyboardEvent, Platform } from 'react-native';

/** 键盘高度上限：杜绝任何异常大值把底栏推到屏幕外 */
const MAX_RATIO = 0.55;

export function useKeyboardHeight(): { kbHeight: number; kbVisible: boolean } {
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const maxH = Math.round(Dimensions.get('window').height * MAX_RATIO);
    const reset = (): void => {
      setHeight(0);
      setVisible(false);
    };

    const showSub = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => {
      setHeight(Math.min(e.endCoordinates.height, maxH));
      setVisible(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', reset);

    // 窗口高度信号：adjustResize 下键盘弹出压缩窗口、收起恢复全高。
    // 以会话内最大窗口高为全高基准，窗口恢复到全高（差值 ≤40）即视为键盘收起 → 清零，
    // 从而在 keyboardDidHide 丢失时也能自愈。
    let maxWinH = Dimensions.get('window').height;
    const dimSub = Dimensions.addEventListener('change', ({ window }: { window: { height: number } }) => {
      if (window.height > maxWinH) maxWinH = window.height;
      const delta = maxWinH - window.height;
      if (delta > 80) {
        setHeight(Math.min(delta, maxH));
        setVisible(true);
      } else if (delta <= 40) {
        reset();
      }
    });

    // 后台切回前台强制清零（系统可能已收键盘但事件未发出）
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reset();
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      dimSub.remove();
      appSub.remove();
    };
  }, []);

  return { kbHeight: height, kbVisible: visible };
}