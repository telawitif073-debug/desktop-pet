/**
 * 应用内更新下载（系统级后台）：交给系统 DownloadManager 执行，
 * 切后台/杀进程都继续下载，通知栏显示进度；进度事件 PetUpdateProgress，
 * 结束事件 PetUpdateFinished { ok, message }；成功自动拉起系统安装器。
 */
import { Alert, DeviceEventEmitter, NativeModules } from 'react-native';

const PetUpdate = NativeModules.PetUpdate as {
  download(url: string, version: string): Promise<'started' | 'busy' | 'permission'>;
  installPending(): Promise<'installing' | 'permission'>;
} | undefined;

export interface UpdateProgress {
  received: number;
  total: number;
}

export function isUpdateSupported(): boolean {
  return !!PetUpdate;
}

/**
 * 发起后台下载（系统 DownloadManager），成功完成会自动拉起安装器。
 * version 用于任务标题去重：新版本发起时会自动取消并清除其他版本的下载任务与通知。
 * 返回 'permission' 表示需要先授权安装未知应用；'busy' 表示同版本任务已在下载。
 */
export async function downloadAndInstall(url: string, version: string): Promise<'started' | 'busy' | 'permission'> {
  if (!PetUpdate) throw new Error('当前环境不支持应用内更新');
  return PetUpdate.download(url, version);
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

/** 订阅下载结束（成功后已自动拉起安装器） */
export function subscribeUpdateFinished(cb: (r: { ok: boolean; message: string }) => void): () => void {
  const sub = DeviceEventEmitter.addListener('PetUpdateFinished', (e: { ok?: boolean; message?: string }) =>
    cb({ ok: !!e?.ok, message: e?.message ?? '' }),
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
