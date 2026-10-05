/**
 * petaction:// 本地媒体响应（Range 分段）
 * ===========================================================================
 * 为什么需要它：Electron 的 `net.fetch(file://)` 对本地文件**不支持 Range**（一律 200 全量），
 * 而视频动作要在渲染端 `<video>` 里播放并拖动进度条，就必须自己开流返回 `206 + Content-Range`。
 *
 * 只对 {@link PETACTION_MEDIA_TYPES} 列出的媒体扩展名走这条分支；帧图（png/gif/webp）、
 * Live2D/GLTF 模型、sherpa 语音模型仍走原来的 `net.fetch`，避免改动它们既有的 Content-Type 推断。
 *
 * 单独成模块（而不是写在 main.ts 里）的原因：Range 解析的边界（后缀形式、越界钳制、416）
 * 是 off-by-one 高发区，抽出来才能用单测钉住；留在主进程入口里只能靠手工拖动进度条验证。
 */
import fs from 'fs';

export const PETACTION_MEDIA_TYPES: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** 本地媒体文件的 Range 响应：206 + Content-Range；非法/不可满足的范围回 416；文件不存在回 404 */
export function serveLocalMediaRange(
  filePath: string,
  contentType: string,
  rangeHeader: string,
  extraHeaders: Record<string, string> = {},
): Response {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return new Response('not found', { status: 404, headers: extraHeaders });
  }
  const headers: Record<string, string> = { ...extraHeaders, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
  const unsatisfiable = () =>
    new Response('range not satisfiable', { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return unsatisfiable();

  let start: number;
  let end: number;
  if (!match[1]) {
    // 后缀形式：bytes=-N → 最后 N 字节
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return unsatisfiable();

  // 用 Web ReadableStream 包装 fs 流（而不是 `Readable.toWeb`）：本仓库 tsconfig 同时引入 DOM lib，
  // 全局 ReadableStream 与 node:stream 的类型在 asyncIterator 上互斥，`Readable.toWeb` 无法通过类型检查。
  const nodeStream = fs.createReadStream(filePath, { start, end });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
  return new Response(body, {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}
