/**
 * 键盘高度 hook：监听 keyboardDidShow/Hide 返回当前键盘高度（DIP）。
 * RN 0.87 边到边模式下系统不再为 IME 收缩窗口，需要 JS 自行给底部留白，
 * 让输入栏始终贴在键盘上方（微信效果）。键盘收起时返回 0。
 */
import { useEffect, useState } from 'react';
import { Keyboard, KeyboardEvent, Platform } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onShow = (e: KeyboardEvent): void => setHeight(e.endCoordinates.height);
    const onHide = (): void => setHeight(0);
    const showSub = Keyboard.addListener('keyboardDidShow', onShow);
    const hideSub = Keyboard.addListener('keyboardDidHide', onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}
