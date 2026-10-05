import type { PublishFilePayload } from '../global.d';

/** 渲染端 File → IPC 载荷（读成字节传给主进程；文件内容不进渲染内存之外的持久层） */
export async function toPayloadFile(file: File): Promise<PublishFilePayload> {
  const buffer = await file.arrayBuffer();
  return { name: file.name, type: file.type, bytes: new Uint8Array(buffer) };
}