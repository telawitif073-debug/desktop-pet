/**
 * 应用内更新下载（游戏式）：原生流式下载 APK，进度事件 PetUpdateProgress，
 * 完成后自动拉起系统安装器；未授权「安装未知应用」时返回 permission 并跳系统设置。
 */
import { Alert, DeviceEventEmitter, NativeModules } from 'react-native';

const PetUpdate = NativeModules.PetUpdate as {
  download(url: string): Promise<'installing' | 'permission'>;
  installPending(): Promise<'installing' | 'permission'>;
} | undefined;

export interface UpdateProgress {
  received: number;
  total: number;
}

export function isUpdateSupported(): boolean {
  return !!PetUpdate;
}

/** 下载并自动拉起安装；返回 'permission' 表示需要用户先授权安装未知应用 */
export async function downloadAndInstall(url: string): Promise<'installing' | 'permission'> {
  if (!PetUpdate) throw new Error('当前环境不支持应用内更新');
  return PetUpdate.download(url);
}

/** 授权后继续安装已下载的更新包 */
export async function installPendingApk(): Promise<'installing' | 'permission'> {
  if (!PetUpdate) throw new Error('当前环境不支持应用内更新');
  return PetUpdate.installPending();
}

/** 订阅下载进度，返回取消订阅函数 */
export function subscribeUpdateProgress(cb: (p: UpdateProgress) => void): () => void {
  const sub = DeviceEventEmitter.addListener('PetUpdateProgress', (e: UpdateProgress) =>
    cb({ received: e?.received ?? 0, total: e?.total ?? 0 }),
  );
  return () => sub.remove();
}

/** 引导用户去系统设置授权安装未知应用 */
export function guideInstallPermission(): void {
  Alert.alert(
    '需要安装权限',
    '更新需要允许本应用「安装未知应用」。已在系统设置页为你打开开关入口，授权后回到应用再点一次「立即更新」即可完成安装。',
    [{ text: '知道了' }],
  );
}
