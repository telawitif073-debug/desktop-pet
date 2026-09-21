/**
 * 宠物文件本地化工具：
 * - normalizeFileUrl：把历史遗留的绝对 URL（旧隧道域名）归一为 /uploads/... 相对路径，
 *   渲染/下载时经 assetUrl() 动态拼接当前服务器地址，换隧道不失效
 * - cacheAssetFile：image/gif 宠物文件下载到本地（离线可用、不依赖隧道），已存在直接复用
 * - removePetFiles：删除某只宠物的全部本地文件（形象文件 + pack 帧目录）
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import { assetUrl } from '../api/platform';

const UPLOADS_MARKER = '/uploads/';
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

export function normalizeFileUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    const i = url.indexOf(UPLOADS_MARKER);
    if (i >= 0) return url.slice(i);
  }
  return url;
}

/** image/gif 宠物：下载到 DocumentDirectoryPath/pets/<id>/main.<ext>，返回本地路径 */
export async function cacheAssetFile(petId: string, fileUrl: string): Promise<string> {
  const rel = normalizeFileUrl(fileUrl);
  const ext = rel.match(IMAGE_EXT_RE)?.[0]?.toLowerCase() ?? '.png';
  const dest = `${RNFS.DocumentDirectoryPath}/pets/${petId}/main${ext}`;
  if (await RNFS.exists(dest)) return dest;
  await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/pets/${petId}`).catch(() => undefined);
  await RNFS.downloadFile({ fromUrl: assetUrl(rel), toFile: dest }).promise;
  return dest;
}

/** 删除宠物本地文件（形象文件目录与 pack 的 zip），目录不存在时静默忽略 */
export async function removePetFiles(petId: string): Promise<void> {
  await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/pets/${petId}`).catch(() => undefined);
  await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/pets/${petId}.zip`).catch(() => undefined);
}
