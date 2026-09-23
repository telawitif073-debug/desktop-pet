/** 导航：未登录 → 登录页；已登录 → MainShell（聊天单页 + 抽屉 + 设置弹层，DeepSeek 式结构） */
import React, { useEffect } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import LoginScreen from '../screens/LoginScreen';
import MainShell from './MainShell';
import AppErrorBoundary from '../diagnostics/AppErrorBoundary';
import { useAppStore } from '../store/appStore';
import { checkAppUpdate } from '../update/checkUpdate';
import UpdateModal from '../update/UpdateModal';
import UpdateBanner from '../update/UpdateBanner';

const Stack = createNativeStackNavigator();

/** 启动/回前台例行检查：检测应用更新（服务器地址固定内置阿里云，无需发现流程） */
function runChecks(): void {
  void checkAppUpdate().catch(() => undefined);
}

export default function RootNavigator(): React.JSX.Element {
  const hydrated = useAppStore((s) => s.hydrated);
  const token = useAppStore((s) => s.token);

  // 启动后检查（检测应用更新）
  useEffect(() => {
    if (hydrated) runChecks();
  }, [hydrated]);

  // 每次回到前台也自动执行（后台切回/解锁屏幕都会触发）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && hydrated) runChecks();
    });
    return () => sub.remove();
  }, [hydrated]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator />
      </View>
    );
  }

  // 错误边界包裹整个导航树：任何屏渲染/生命周期异常都会显示错误页而非闪退
  return (
    <AppErrorBoundary>
      <SafeAreaProvider>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            {token ? <Stack.Screen name="Main" component={MainShell} /> : <Stack.Screen name="Login" component={LoginScreen} />}
          </Stack.Navigator>
        </NavigationContainer>
        <UpdateModal />
        <UpdateBanner />
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
