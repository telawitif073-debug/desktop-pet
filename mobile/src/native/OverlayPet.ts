/**
 * 悬浮窗宠物原生模块 TS 封装：
 * - checkPermission / requestPermission / startOverlay / stopOverlay
 * - buildOverlayUrl：根据宠物资源与平台根 URL 生成 overlay.html 渲染地址
 *
 * 桥接 Android 侧 OverlayPetModule（包名 com.mobilepet.OverlayPet）。
 * 平台根 URL 用于让 overlay.html 内的相对资源 URL 自动补全为完整平台地址。
 */
import { NativeModules, Platform } from 'react-native';
import { assetUrl } from '../api/platform';
import { normalizeFileUrl } from '../pet/petFiles';
import { useAppStore, type PetAssetRef } from '../store/appStore';

const { OverlayPet } = NativeModules;

export interface OverlayHandle {
  supported: boolean;
}

const ANDROID = Platform.OS === 'android';

export function isOverlaySupported(): boolean {
  return ANDROID && !!OverlayPet;
}

export function checkOverlayPermission(): Promise<boolean> {
  if (!OverlayPet) return Promise.resolve(false);
  return OverlayPet.checkPermission();
}

export function requestOverlayPermission(): Promise<boolean> {
  if (!OverlayPet) return Promise.resolve(false);
  return OverlayPet.requestPermission();
}

/**
 * 构造 overlay.html 的加载 URL（带 query 参数）：
 * - image/gif：直接走 src 资源 URL
 * - pack：传 manifest URL（指向平台打包的帧清单 JSON；当前若平台未提供 manifest 则降级为图片占位）
 * - live2d/model3d：走 model URL（在 WebView 内部加载 CDN 库渲染）
 */
export function buildOverlayUrl(asset: PetAssetRef | null): string {
  const base = useAppStoreBaseUrlRoot();
  const qs = new URLSearchParams();
  qs.set('base', base);
  if (!asset) {
    return `file:///android_asset/overlay.html?${qs.toString()}`;
  }
  qs.set('name', asset.name || '小宠');
  qs.set('format', asset.format);
  if (asset.format === 'pack') {
    // 平台尚未提供帧包清单 JSON：降级为图片占位（first-frame-less）
    // 后续平台补 /pets/:id/manifest 接口后即可直接生效，无需改这里
    qs.set('manifest', `${base}/api/pets/${asset.id}/manifest`);
  } else if (asset.format === 'live2d' || asset.format === 'model3d') {
    qs.set('model', assetUrl(normalizeFileUrl(asset.fileUrl)));
  } else if (asset.localPath) {
    // 本地缓存优先：离线/换服务器都显示（Service 已开启 allowFileAccess）
    qs.set('src', `file://${asset.localPath}`);
  } else {
    qs.set('src', assetUrl(normalizeFileUrl(asset.fileUrl)));
  }
  return `file:///android_asset/overlay.html?${qs.toString()}`;
}

export async function startOverlay(asset: PetAssetRef | null): Promise<boolean> {
  if (!OverlayPet) return false;
  const url = buildOverlayUrl(asset);
  return OverlayPet.startOverlay(url);
}

export async function stopOverlay(): Promise<boolean> {
  if (!OverlayPet) return false;
  return OverlayPet.stopOverlay();
}

/** 取 baseUrl 去掉 /api 后的根（用于 overlay.html 内相对 URL 补全） */
function useAppStoreBaseUrlRoot(): string {
  const baseUrl = useAppStore.getState().baseUrl as string;
  return baseUrl.replace(/\/api\/?$/, '');
}
