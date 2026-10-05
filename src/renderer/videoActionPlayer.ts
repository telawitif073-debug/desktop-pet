/**
 * 视频动作播放（渲染端）
 * ===========================================================================
 * 为什么用 DOM `<video>` 而不是 PIXI 视频纹理：PIXI v8 的视频纹理在透明视频上 alpha 不可靠，
 * 而浏览器的合成对 VP9 alpha 是原生支持的（P0 spike 已实测：解码层 alpha 直方图为 ≈83% 全透明 +
 * ≈16% 实心 + 边缘 0.1% 半透明，合成层透明处正确露出背景而非压成黑底）。
 * 宠物窗本身是透明窗口，DOM 层与 PIXI 画布同样能透出。
 *
 * 与帧序列播放语义对齐：
 *  - 播**一次**（loop=false），播完回调 `onComplete`，由调用方恢复静态形象；
 *  - `stop()` 立即中断并移除元素（换动作 / 删动作 / 卸载时调用），此时**不**触发 `onComplete`。
 *
 * 元素样式贴在 `document.body` 上按窗口尺寸铺满并用 `object-fit: contain` 居中——
 * 与帧序列播放的「等比缩放进窗口」口径一致（帧路径留 60px 边距，这里用 contain，差异极小）。
 */
export interface VideoActionHandle {
  /** 立即停止并移除元素（不触发 onComplete） */
  stop(): void;
  /** 暴露元素便于调试/测试断言 */
  readonly element: HTMLVideoElement;
}

export interface VideoActionOptions {
  /** 视频地址（petaction://local/<文件名>?p=<编码后的绝对路径>） */
  url: string;
  /** 宠物窗宽高（CSS 像素） */
  width: number;
  height: number;
  /** 播完一次后回调（调用方负责恢复静态形象） */
  onComplete?: () => void;
  /** 解码/加载失败回调（调用方同样应恢复静态形象，避免宠物消失） */
  onError?: (message: string) => void;
}

export function createVideoActionPlayer(options: VideoActionOptions): VideoActionHandle {
  const { url, width, height, onComplete, onError } = options;
  const video = document.createElement('video');
  video.src = url;
  video.muted = true; // 自动播放策略要求静音（视频动作本就不出声）
  video.autoplay = true;
  video.playsInline = true;
  video.loop = false; // 与帧序列一致：播一次即结束
  video.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'pointer-events: none',
    'background: transparent',
    `width: ${width}px`,
    `height: ${height}px`,
    'object-fit: contain',
  ].join(';');
  document.body.appendChild(video);

  let stopped = false;
  const cleanup = () => {
    video.pause();
    video.removeAttribute('src');
    // 释放解码器（触发 abort，此时 stopped 已为 true，不会再回调）
    video.load();
    video.remove();
  };

  video.addEventListener('ended', () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    onComplete?.();
  });
  video.addEventListener('error', () => {
    if (stopped) return;
    stopped = true;
    const message = video.error?.message || `视频加载失败（code=${String(video.error?.code ?? '?')}）`;
    cleanup();
    onError?.(message);
  });
  void video.play().catch((e: unknown) => {
    // 播放被拒（极少见，已静音）时也要恢复静态形象，不能让宠物窗空着
    if (stopped) return;
    stopped = true;
    cleanup();
    onError?.(e instanceof Error ? e.message : String(e));
  });

  return {
    element: video,
    stop() {
      if (stopped) return;
      stopped = true;
      cleanup();
    },
  };
}
