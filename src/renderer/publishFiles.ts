import type { PublishFilePayload } from '../global.d';

/** 渲染端 File → IPC 载荷（读成字节传给主进程；文件内容不进渲染内存之外的持久层） */
export async function toPayloadFile(file: File): Promise<PublishFilePayload> {
  const buffer = await file.arrayBuffer();
  return { name: file.name, type: file.type, bytes: new Uint8Array(buffer) };
}

/** IPC 载荷 → Blob（预览、画布处理用；MIME 缺失时用兜底值） */
export function payloadBlob(file: PublishFilePayload, fallbackType = 'application/octet-stream'): Blob {
  return new Blob([file.bytes], { type: file.type || fallbackType });
}

/** 扩展名（小写含点；无扩展名返回 ''） */
export function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

/** 扣图/裁剪后的新文件名（保持可被后端 MIME 白名单识别，统一输出 .png） */
export function cutFileName(name: string, suffix: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base}${suffix}.png`;
}

/** 宠物主文件是否图片（主体扣取面板只在单图时显示） */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

/** 主文件是否需要额外预览图（多图包 / Live2D / 3D 模型在商店列表里无法直接展示） */
export function needsPreview(name: string): boolean {
  return /\.(zip|glb|gltf)$/i.test(name);
}