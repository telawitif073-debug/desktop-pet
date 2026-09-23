import React, { useEffect } from 'react';
import { Alert, AppState, StatusBar } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { useAppStore } from './src/store/appStore';
import { flushAllOnQuit } from './src/api/sync';
import { reportCrash } from './src/diagnostics/crashReport';

/**
 * 全局未处理 JS 错误捕获（非致命）：把崩溃栈写入 last-crash + 弹窗提示用户，
 * 但【不再调用原 handler 终止进程】——App 保持存活，错误留在屏幕上可截图反馈。
 * 这样「崩溃 → 自愈回滚 → 再次推送更新」死循环从机制上被消灭。
 * 同一错误 3 秒内只弹一次，避免渲染死循环导致弹窗风暴。
 */
const crashAlertDedupe: { msg: string; at: number } = { msg: '', at: 0 };
ErrorUtils.setGlobalHandler((error, isFatal) => {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  const full = `${msg}\n${stack}`;
  // 崩溃自动上报云端（crash.log），排查时直接读服务器记录，无需用户手抄错误
  reportCrash(msg, stack);
  try {
    void AsyncStorage.setItem('last-crash', `${new Date().toISOString()}\n${full}`.slice(0, 4000));
  } catch {
    // 捕获器自身异常不影响主流程
  }
  const now = Date.now();
  if (msg !== crashAlertDedupe.msg || now - crashAlertDedupe.at > 3000) {
    crashAlertDedupe.msg = msg;
    crashAlertDedupe.at = now;
    try {
      Alert.alert('应用运行异常', `${msg}\n\n（App 保持运行，请截图本提示发送给我们以便修复）`);
    } catch {
      // Alert 异常时忽略
    }
  }
});

let crashAlertShown = false;

export default function App(): React.JSX.Element {
  useEffect(() => {
    // 上次异常退出信息：启动时浮出一次（含错误栈），用户可直接截图反馈；同时补发云端未上报成功的记录
    void (async () => {
      try {
        if (crashAlertShown) return;
        const raw = await AsyncStorage.getItem('last-crash');
        if (raw) {
          crashAlertShown = true;
          const firstLine = raw.split('\n')[1] ?? raw;
          reportCrash(`[launch-resend] ${firstLine}`, raw.slice(200));
          Alert.alert('上次异常退出信息', `${raw.slice(0, 1500)}\n\n（可截图发送给我们以便修复）`);
        }
      } catch {
        // 忽略读取失败
      }
    })();
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
