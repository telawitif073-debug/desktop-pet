/**
 * 应用内更新推送（游戏式）：启动时请求平台 GET /api/app-update 清单，
 * versionCode 大于本机内置值时把更新信息写入 store，由 UpdateModal 弹出游戏风格更新面板，
 * 面板内进度条下载完成后自动拉起系统安装器。
 * 发布新版本：build.gradle versionCode/Name 与这里同步 +1，并更新 backend/app-update.json。
 */
import { Alert } from 'react-native';
import { useAppStore } from '../store/appStore';

export const APP_VERSION_CODE = 17;
export const APP_VERSION_NAME = '1.3.3';

export async function checkAppUpdate(silent = true): Promise<void> {
  try {
    const base = useAppStore.getState().baseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/app-update`);
    if (!res.ok) {
      if (!silent) Alert.alert('检查失败', `服务器返回 ${res.status}`);
      return;
    }
    const data = (await res.json()) as {
      versionCode?: number;
      versionName?: string;
      apkUrl?: string;
      notes?: string;
      /** 最低可用版本：低于此值强制更新（更新面板不可关闭） */
      minVersionCode?: number;
    };
    const remote = data.versionCode ?? 0;
    if (remote <= APP_VERSION_CODE) {
      if (!silent) Alert.alert('已是最新版本', `当前版本 ${APP_VERSION_NAME}`);
      return;
    }
    if (!data.apkUrl) {
      if (!silent) Alert.alert('暂不可更新', '更新包地址未配置，请稍后再试');
      return;
    }
    // 版本低于最低可用版本 → 强制更新（直接弹不可关闭的面板）；否则安静模式：
    // 只记录 updateAvailable，由顶部轻量横幅提醒（同一版本关闭后 24h 内不再打扰），点击横幅才打开面板
    const forced = APP_VERSION_CODE < (data.minVersionCode ?? 0);
    const info = {
      versionName: data.versionName || `v${remote}`,
      notes: data.notes || '新版本已发布',
      apkUrl: data.apkUrl,
      forced,
    };
    const known = useAppStore.getState().updateAvailable;
    if (known && known.versionName === info.versionName) {
      // 已发现过同一新版本：静默检查不打扰；手动检查或强制更新才打开面板
      if (forced && !useAppStore.getState().updatePanelVisible) {
        useAppStore.getState().patch({ updatePanelVisible: true });
      } else if (!silent) {
        useAppStore.getState().patch({ updatePanelVisible: true });
      }
      return;
    }
    useAppStore.getState().patch({
      updateAvailable: info,
      // 静默检测：非强制只出横幅不弹面板；手动检查：直接打开面板
      updatePanelVisible: forced || !silent,
    });
  } catch (e) {
    if (!silent) Alert.alert('检查更新失败', e instanceof Error ? e.message : '网络不可达，请检查服务器地址');
  }
}
