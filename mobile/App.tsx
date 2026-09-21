import React, { useEffect } from 'react';
import { AppState, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { useAppStore } from './src/store/appStore';
import { flushAllOnQuit } from './src/api/sync';

export default function App(): React.JSX.Element {
  useEffect(() => {
    void useAppStore.getState().hydrate();
    // 退到后台时 flush 待上传的同步数据（与桌面端 before-quit 对应）
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushAllOnQuit();
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
