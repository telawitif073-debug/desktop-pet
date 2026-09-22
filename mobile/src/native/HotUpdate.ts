/**
 * JS Bundle 热更新（无需重装 APK）：
 * 流程 = 下载 bundle zip（RNFS）→ 解压（react-native-zip-archive）→ 原生 setCurrent 登记
 * → 原生 restartApp 重启 → MainApplication 的 ReactNativeHost 按登记优先加载热更 bundle。
 * 崩溃自愈由原生完成（连崩两次自动回滚内置 bundle），JS 侧无需参与。
 */
import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { unzip } from 'react-native-zip-archive';

interface PetHotUpdateNative {
  /** 当前生效的热更版本；未热更过返回 null */
  getApplied(): Promise<{ version: number; file: string } | null>;
  /** 校验 dir 内存在 index.android.bundle 并登记为当前热更 */
  setCurrent(version: number, dir: string): Promise<string>;
  /** 清除热更登记（回滚内置 bundle） */
  reset(): Promise<boolean>;
  /** 重启应用使热更生效 */
  restartApp(): Promise<boolean>;
}

const native = NativeModules.PetHotUpdate as PetHotUpdateNative | undefined;

export const isHotUpdateSupported = !!native;

/** 当前生效的热更版本；未热更过返回 0 */
export async function appliedBundleVersion(): Promise<number> {
  if (!native) return 0;
  try {
    const applied = await native.getApplied();
    return applied?.version ?? 0;
  } catch {
    return 0;
  }
}

export function resetHotUpdate(): Promise<boolean> {
  return native ? native.reset() : Promise.resolve(false);
}

export function restartApp(): Promise<boolean> {
  if (!native) return Promise.reject(new Error('热更新模块不可用'));
  return native.restartApp();
}

/**
 * 应用热更新包：下载 zip → 解压 → 原生登记。onProgress 回传 (received, total)。
 * 成功后需调用 restartApp() 重启生效。
 */
export async function applyBundleUpdate(
  zipUrl: string,
  version: number,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  if (!native) throw new Error('热更新模块不可用');
  const dir = `${RNFS.DocumentDirectoryPath}/hotupdate`;
  const bundlesDir = `${dir}/bundles`;
  const zipPath = `${dir}/bundle-${version}.zip`;
  const targetDir = `${bundlesDir}/${version}`;
  await RNFS.mkdir(bundlesDir).catch(() => undefined);

  // 下载（复用旧文件可断点？RNFS downloadFile 无断点续传，直接全量下载）
  const job = RNFS.downloadFile({
    fromUrl: zipUrl,
    toFile: zipPath,
    progressInterval: 300,
    progress: (res) => onProgress?.(res.bytesWritten, res.contentLength),
  });
  const result = await job.promise;
  if (result.statusCode && (result.statusCode < 200 || result.statusCode >= 300)) {
    await RNFS.unlink(zipPath).catch(() => undefined);
    throw new Error(`下载失败（HTTP ${result.statusCode}）`);
  }

  // 解压到版本目录（存在则先清掉旧目录避免新旧混杂）
  await RNFS.unlink(targetDir).catch(() => undefined);
  await unzip(zipPath, targetDir);
  await RNFS.unlink(zipPath).catch(() => undefined);

  // 原生校验并登记
  await native.setCurrent(version, targetDir);
}
