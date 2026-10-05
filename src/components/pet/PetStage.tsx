import { useEffect, useRef, useState } from 'react';
import type { PetRenderAction, PetRenderAsset } from '../../global.d';
import type { PetWindowView } from '../../renderer/pet/petView';
import { createVideoActionPlayer, type VideoActionHandle } from '../../renderer/videoActionPlayer';

/**
 * 桌宠舞台：渲染宠物形象（静态图 / 帧序列 / 透明 webm 视频）与四维状态条。
 * ---------------------------------------------------------------------------
 * 渲染载体由 `pet/domain` 的动作模型决定（主进程 pet:get-asset 已把绝对路径转成 petaction:// URL）：
 *  - kind=frames → 按 frameRate 逐帧切换 <img>，播完一轮回调 onActionEnd（恢复静态形象）；
 *  - kind=video  → DOM <video>（VP9 alpha 原生合成），播完/失败回调 onActionEnd；
 *  - 无动作播放时回落静态本体图（asset.imageUrl），再兜底 @pet/ui 的 emoji 表情。
 * 朝右（facing='right'）时整只宠物水平镜像。
 */

interface PetStageProps {
  view: PetWindowView;
  asset: PetRenderAsset | null;
  /** 当前正在播的动作（null = 显示静态形象） */
  playing: PetRenderAction | null;
  facing: 'left' | 'right';
  /** 单轮播放自然结束（帧序列播完 / 视频 ended） */
  onActionEnd: () => void;
}

/** 帧序列播放：按 fps 逐帧切换，播放一轮后回调（与视频「播一次」语义对齐） */
const FramePlayer = ({
  action,
  onEnd,
}: {
  action: PetRenderAction;
  onEnd: () => void;
}) => {
  const frames = action.frameUrls ?? [];
  const [index, setIndex] = useState(0);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    if (frames.length <= 1) {
      const timer = setTimeout(() => onEndRef.current(), 400);
      return () => clearTimeout(timer);
    }
    const fps = Math.max(1, Math.min(24, action.frameRate ?? 6));
    const step = Math.round(1000 / fps);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i >= frames.length) {
        clearInterval(timer);
        onEndRef.current();
        return;
      }
      setIndex(i);
    }, step);
    return () => clearInterval(timer);
  }, [frames, action.frameRate]);

  return (
    <img
      src={frames[Math.min(index, frames.length - 1)]}
      alt=""
      draggable={false}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', pointerEvents: 'none' }}
    />
  );
};

/** 视频动作播放：挂到 body 铺满窗口（含 Range 支持），播完/失败回调恢复静态形象 */
const VideoPlayer = ({
  url,
  onEnd,
}: {
  url: string;
  onEnd: () => void;
}) => {
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  useEffect(() => {
    let handle: VideoActionHandle | null = null;
    const done = () => onEndRef.current();
    try {
      handle = createVideoActionPlayer({
        url,
        width: window.innerWidth,
        height: window.innerHeight,
        onComplete: done,
        onError: done,
      });
    } catch {
      done();
    }
    return () => handle?.stop();
  }, [url]);
  return null;
};

const PetStage = ({ view, asset, playing, facing, onActionEnd }: PetStageProps) => {
  const mirror = facing === 'right' ? 'scaleX(-1)' : 'none';
  let sprite: React.ReactNode;
  if (playing?.kind === 'video' && playing.videoUrl) {
    sprite = <VideoPlayer url={playing.videoUrl} onEnd={onActionEnd} />;
  } else if (playing?.kind === 'frames' && playing.frameUrls?.length) {
    sprite = (
      <div style={{ transform: mirror, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <FramePlayer key={playing.id} action={playing} onEnd={onActionEnd} />
      </div>
    );
  } else if (asset?.imageUrl) {
    sprite = (
      <img
        src={asset.imageUrl}
        alt={asset.name}
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          transform: mirror,
          pointerEvents: 'none',
          filter: view.ready ? 'none' : 'grayscale(0.6)',
        }}
      />
    );
  } else {
    sprite = (
      <div
        title={view.avatar.label}
        style={{ fontSize: 64, lineHeight: 1, transform: mirror, filter: view.ready ? 'none' : 'grayscale(1)' }}
      >
        {view.avatar.emoji}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 8, flex: 1, minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {sprite}
      </div>
      <div style={{ fontSize: 11, color: view.avatar.accent }}>{view.avatar.label}</div>
      <div style={{ width: 150 }}>
        {view.vitals.map((row) => (
          <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <span style={{ width: 28, fontSize: 10, color: '#8b8f96' }}>{row.label}</span>
            <span style={{ flex: 1, height: 4, background: '#3a3b3d', borderRadius: 2, overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  width: `${row.percent}%`,
                  height: '100%',
                  background: row.alert ? '#ff9f9f' : view.avatar.accent,
                }}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PetStage;
