/**
 * 悬浮窗宠物原生模块 TS 封装：
 * - checkPermission / requestPermission / startOverlay / stopOverlay
 * - buildOverlayUrl：根据宠物资源与平台根 URL 生成 overlay.html 渲染地址
 *
 * 桥接 Android 侧 OverlayPetModule（包名 com.mobilepet.OverlayPet）。
 * 平台根 URL 用于让 overlay.html 内的相对资源 URL 自动补全为完整平台地址。
 */
import { NativeModules, Platform } from 'react-native';
import { useAppStore } from '../store/appStore';
import type { PetAssetRef } from '../types';

const { OverlayPet } = NativeModules;

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
 * - live2d/model3d：走 `model`（宠物包内已解压的本地模型入口，overlay 用 file:// 读取其相对资源）
 * - image / pack ：走 `src`（本体入口解压后的本地文件；pack 的入口即帧序列首帧，作为一个静态帧显示）
 * 本体入口来自服务端校验快照 `manifest.entry`（见 PetAssetRef.entryPath），
 * 因此**不会**再去请求任何「单图/清单」远端接口。
 */
export function buildOverlayUrl(asset: PetAssetRef | null): string {
  const base = baseUrlRoot();
  const qs = new URLSearchParams();
  qs.set('base', base);
  if (!asset) {
    return `file:///android_asset/overlay.html?${qs.toString()}`;
  }
  qs.set('name', asset.name || '小宠');
  qs.set('format', asset.format);
  if (asset.format === 'live2d' || asset.format === 'model3d') {
    qs.set('model', asset.localPath ? `file://${asset.localPath}` : '');
  } else if (asset.localPath) {
    // 已解压：本地文件优先（离线可用、换服务器也不失效；Service 已开启 allowFileAccess）
    qs.set('src', `file://${asset.localPath}`);
  }
  // 未解压时不给 src/model：overlay 会显示提示，而不是去取一个 zip
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
function baseUrlRoot(): string {
  const baseUrl = useAppStore.getState().baseUrl;
  return baseUrl.replace(/\/api\/?$/, '');
}
