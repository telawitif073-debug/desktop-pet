import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoActionPlayer } from './videoActionPlayer';

/**
 * 视频动作播放器的**行为契约**：播一次即结束、结束才回调、stop() 不回调且必须清理元素、
 * 出错/自动播放被拒也要回调（否则调用方不恢复静态形象，宠物窗会空着）。
 * 这里用最小假 DOM（不引入 jsdom/happy-dom），只覆盖模块真正用到的那几个 API。
 */
class FakeVideo {
  src = '';
  muted = false;
  autoplay = false;
  playsInline = false;
  loop = true;
  style = { cssText: '' };
  error: { message?: string; code?: number } | null = null;
  playResult: Promise<void> = Promise.resolve();

  paused = false;
  loaded = false;
  removed = false;
  played = false;
  removedSrcAttr = false;
  private listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeAttribute(name: string) {
    if (name === 'src') {
      this.removedSrcAttr = true;
      this.src = '';
    }
  }
  load() { this.loaded = true; }
  remove() { this.removed = true; }
  pause() { this.paused = true; }
  play() { this.played = true; return nextPlayResult; }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

let created: FakeVideo[] = [];
let appended: FakeVideo[] = [];
/** 下一次 play() 的返回值：必须在创建播放器**之前**设置（否则先产生一个无人处理的 rejection） */
let nextPlayResult: Promise<void> = Promise.resolve();

beforeEach(() => {
  created = [];
  appended = [];
  nextPlayResult = Promise.resolve();
  vi.stubGlobal('document', {
    createElement: () => {
      const el = new FakeVideo();
      created.push(el);
      return el;
    },
    body: { appendChild: (el: FakeVideo) => { appended.push(el); } },
  } as unknown as Document);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const make = (over: Partial<Parameters<typeof createVideoActionPlayer>[0]> = {}) =>
  createVideoActionPlayer({
    url: 'petaction://local/clip.webm?p=%2Fx%2Fclip.webm',
    width: 320,
    height: 240,
    ...over,
  });

describe('视频动作播放器（DOM <video>）', () => {
  it('创建即静音自动播放、不循环，按窗口尺寸 contain 铺满并挂到 body', () => {
    const h = make();
    const v = created[0];
    expect(v.src).toBe('petaction://local/clip.webm?p=%2Fx%2Fclip.webm');
    expect(v.muted).toBe(true); // 自动播放策略要求静音
    expect(v.autoplay).toBe(true);
    expect(v.playsInline).toBe(true);
    expect(v.loop).toBe(false); // 与帧序列一致：播一次
    expect(v.played).toBe(true);
    expect(v.style.cssText).toContain('width: 320px');
    expect(v.style.cssText).toContain('height: 240px');
    expect(v.style.cssText).toContain('object-fit: contain');
    expect(appended).toEqual([v]);
    expect(h.element).toBe(v);
  });

  it('播完（ended）→ 先清理元素再回调一次', () => {
    const onComplete = vi.fn();
    const h = make({ onComplete });
    const v = created[0];
    v.emit('ended');
    v.emit('ended'); // 重复事件不应重复回调
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(v.paused).toBe(true);
    expect(v.removedSrcAttr).toBe(true); // 释放解码器
    expect(v.loaded).toBe(true);
    expect(v.removed).toBe(true);
    expect(h.element).toBe(v);
  });

  it('stop() 立即中断并清理，且**不**触发 onComplete（换动作/删动作的语义）', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const h = make({ onComplete, onError });
    const v = created[0];
    h.stop();
    expect(v.paused).toBe(true);
    expect(v.removed).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    // 幂等：再停一次不重复清理
    h.stop();
    expect(created).toHaveLength(1);
  });

  it('解码/加载失败 → 清理元素并回调 onError（调用方据此恢复静态形象）', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    make({ onComplete, onError });
    const v = created[0];
    v.error = { code: 4, message: 'DEMUXER_ERROR' };
    v.emit('error');
    expect(onError).toHaveBeenCalledWith('DEMUXER_ERROR');
    expect(onComplete).not.toHaveBeenCalled();
    expect(v.removed).toBe(true);
  });

  it('play() 被拒（自动播放受限）→ 同样走 onError 兜底，避免宠物窗空着', async () => {
    const onError = vi.fn();
    nextPlayResult = Promise.reject(new Error('NotAllowedError'));
    make({ onError, onComplete: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('NotAllowedError');
    expect(created[0].removed).toBe(true);
  });

  it('stop() 之后再来的 ended/error 事件不再回调（防迟到事件把形象显隐拉回错误状态）', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const h = make({ onComplete, onError });
    h.stop();
    created[0].emit('ended');
    created[0].emit('error');
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
