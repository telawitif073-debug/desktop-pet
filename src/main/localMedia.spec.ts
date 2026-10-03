import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PETACTION_MEDIA_TYPES, serveLocalMediaRange } from './localMedia';

/**
 * 视频动作要在渲染端 `<video>` 里播放并拖动进度条，依赖这里返回的 206 分段响应。
 * Range 解析是 off-by-one 高发区，故把边界全钉住（Electron 的 net.fetch 不能测，故抽成本模块）。
 */
let dir = '';
let file = '';
const CONTENT = 'abcdefghij'; // 10 字节，便于按字节核对

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petaction-range-'));
  file = path.join(dir, 'clip.webm');
  fs.writeFileSync(file, CONTENT);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const body = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString('latin1');

describe('本地媒体 Range 响应（petaction:// 视频动作）', () => {
  it('开头截取 bytes=0-3 → 206 且只回这 4 个字节', async () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-3/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Type')).toBe('video/webm');
    expect(await body(res)).toBe('abcd');
  });

  it('开区间 bytes=7- → 从 7 到文件末尾', async () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=7-');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await body(res)).toBe('hij');
  });

  it('末尾越界时按文件大小钳制（bytes=5-999 → 5-9）', async () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=5-999');
    expect(res.headers.get('Content-Range')).toBe('bytes 5-9/10');
    expect(await body(res)).toBe('fghij');
  });

  it('后缀形式 bytes=-3 → 最后 3 个字节', async () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=-3');
    expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await body(res)).toBe('hij');
  });

  it('后缀超出文件大小 → 退化为整个文件', async () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=-999');
    expect(res.headers.get('Content-Range')).toBe('bytes 0-9/10');
    expect(await body(res)).toBe(CONTENT);
  });

  it('起点超出文件大小 / 起点大于终点 / 非法语法 → 416，且带上总长度', async () => {
    for (const bad of ['bytes=10-', 'bytes=10-12', 'bytes=6-3', 'bytes=', 'items=0-3']) {
      const res = serveLocalMediaRange(file, 'video/webm', bad);
      expect(res.status, bad).toBe(416);
      expect(res.headers.get('Content-Range'), bad).toBe('bytes */10');
    }
  });

  it('空文件任何 Range 都不可满足（416）', () => {
    const empty = path.join(dir, 'empty.webm');
    fs.writeFileSync(empty, '');
    const res = serveLocalMediaRange(empty, 'video/webm', 'bytes=0-');
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */0');
  });

  it('文件不存在 → 404', () => {
    const res = serveLocalMediaRange(path.join(dir, 'nope.webm'), 'video/webm', 'bytes=0-');
    expect(res.status).toBe(404);
  });

  it('额外的 CORS 头被透传（渲染端跨源取媒体需要）', () => {
    const res = serveLocalMediaRange(file, 'video/webm', 'bytes=0-0', { 'Access-Control-Allow-Origin': '*' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('媒体类型表覆盖视频动作需要的 webm', () => {
    expect(PETACTION_MEDIA_TYPES['.webm']).toBe('video/webm');
    expect(PETACTION_MEDIA_TYPES['.png']).toBeUndefined(); // 帧图不走 Range 分支
  });
});
