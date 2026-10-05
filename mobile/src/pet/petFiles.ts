/**
 * 宠物文件本地化工具：
 * - normalizeFileUrl：把历史遗留的绝对 URL 归一为 /uploads/... 相对路径，
 *   下载时经 assetUrl() 动态拼接当前服务器地址，换服务器不失效
 * - unzipPetPack：宠物包 zip 下载并解压到 `pets/<id>/`（重装先清旧目录）
 * - listImages：递归列出目录内的栅格图（自然序），供帧序列播放用
 * - removePetFiles：删除某只宠物的全部本地文件（解压目录 + 残留 zip）
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import { unzip } from 'react-native-zip-archive';
import { assetUrl } from '../api/platform';

const UPLOADS_MARKER = '/uploads/';
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export function normalizeFileUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    const i = url.indexOf(UPLOADS_MARKER);
    if (i >= 0) return url.slice(i);
  }
  return url;
}

/** 递归列出目录内的栅格图（按文件名自然序：frame_2 在 frame_10 之前） */
export async function listImages(dir: string): Promise<string[]> {
  const entries = await RNFS.readDir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await listImages(entry.path)));
    else if (IMAGE_RE.test(entry.name)) files.push(entry.path);
  }
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * 宠物包：下载 zip 并解压到 `pets/<id>/`，返回解压目录。
 * 每次安装/补装都先清掉旧目录，避免换包后残留上一只宠物的帧图。
 */
export async function unzipPetPack(petId: string, packUrl: string): Promise<string> {
  const root = `${RNFS.DocumentDirectoryPath}/pets`;
  const dir = `${root}/${petId}`;
  const zipPath = `${root}/${petId}.zip`;
  await RNFS.mkdir(root).catch(() => undefined);
  await RNFS.downloadFile({ fromUrl: assetUrl(normalizeFileUrl(packUrl)), toFile: zipPath }).promise;
  await RNFS.unlink(dir).catch(() => undefined);
  await unzip(zipPath, dir);
  await RNFS.unlink(zipPath).catch(() => undefined);
  return dir;
}

/** 删除宠物本地文件（解压目录与残留 zip），不存在时静默忽略 */
export async function removePetFiles(petId: string): Promise<void> {
  await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/pets/${petId}`).catch(() => undefined);
  await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/pets/${petId}.zip`).catch(() => undefined);
}
