/** 导航：未登录 → 登录页；已登录 → 底部 Tab（宠物/聊天/商店/审核/设置）。SafeAreaProvider 提供 edge-to-edge 安全区 */
import React, { useEffect } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import LoginScreen from '../screens/LoginScreen';
import PetScreen from '../screens/PetScreen';
import ChatScreen from '../screens/ChatScreen';
import StoreScreen from '../screens/StoreScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AdminScreen from '../screens/AdminScreen';
import { useAppStore } from '../store/appStore';
import { checkAppUpdate } from '../update/checkUpdate';
import UpdateModal from '../update/UpdateModal';
import UpdateBanner from '../update/UpdateBanner';

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

/** 启动/回前台例行检查：检测应用更新（服务器地址固定内置阿里云，无需发现流程） */
function runChecks(): void {
  void checkAppUpdate().catch(() => undefined);
}

function MainTabs(): React.JSX.Element {
  const isAdmin = useAppStore((s) => s.user?.role === 'admin');
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarLabelStyle: { fontSize: 12 },
        tabBarActiveTintColor: '#1C6EF2',
        // 不渲染默认占位图标（无图标库时会显示为方块乱码），仅保留文字
        tabBarIcon: () => null,
      }}>
      <Tabs.Screen name="Pet" component={PetScreen} options={{ tabBarLabel: '宠物' }} />
      <Tabs.Screen name="Chat" component={ChatScreen} options={{ tabBarLabel: '聊天' }} />
      <Tabs.Screen name="Store" component={StoreScreen} options={{ tabBarLabel: '商店' }} />
      {isAdmin && <Tabs.Screen name="Admin" component={AdminScreen} options={{ tabBarLabel: '审核' }} />}
      <Tabs.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: '设置' }} />
    </Tabs.Navigator>
  );
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

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {token ? <Stack.Screen name="Main" component={MainTabs} /> : <Stack.Screen name="Login" component={LoginScreen} />}
        </Stack.Navigator>
      </NavigationContainer>
      <UpdateModal />
      <UpdateBanner />
    </SafeAreaProvider>
  );
}
