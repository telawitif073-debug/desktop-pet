import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VITALS, resolvePlayback } from '@pet/domain';
import { toPetWindowView } from '../../renderer/pet/petView';
import { usePetStore } from '../../store/petStore';
import type { PetRenderAction, PetRenderAsset, PetRuntimeState } from '../../global.d';
import PetStage from './PetStage';

/** 宠物尚未就绪时的空状态（渲染兜底表情与默认四维） */
const EMPTY_STATE: PetRuntimeState = { vitals: { ...DEFAULT_VITALS }, ready: false, current: null };

/** 待机随机动作的间隔范围（毫秒） */
const IDLE_MIN_MS = 6000;
const IDLE_JITTER_MS = 6000;

const actionBtn: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid #555',
  borderRadius: 4,
  background: '#333',
  color: '#ccc',
  fontSize: 11,
  cursor: 'pointer',
  WebkitAppRegion: 'no-drag',
};

/**
 * 桌宠窗口根组件（渲染端 `#/pet` 路由）：读取主进程宠物状态与形象模型、订阅广播，
 * 驱动 `pet/domain` 的动作决策（resolvePlayback）完成待机随机 / 点击回应 / 拖拽 / 互动动作播放，
 * 并提供喂食 / 玩耍 / 休息入口（数值由主进程落盘 + 云同步）。
 */
const PetWindow = () => {
  const [state, setState] = useState<PetRuntimeState>(EMPTY_STATE);
  const [asset, setAsset] = useState<PetRenderAsset | null>(null);
  const [playing, setPlaying] = useState<PetRenderAction | null>(null);
  const [facing, setFacing] = useState<'left' | 'right'>('left');

  // 供定时器/事件读取最新值（避免闭包过期）
  const assetRef = useRef<PetRenderAsset | null>(null);
  const playingRef = useRef<PetRenderAction | null>(null);
  const facingRef = useRef<'left' | 'right'>('left');
  const dragMovedRef = useRef(false);
  const dragXRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadVitals = usePetStore((s) => s.loadVitals);
  const markInteraction = usePetStore((s) => s.markInteraction);

  assetRef.current = asset;
  playingRef.current = playing;
  facingRef.current = facing;

  /** 按动作名播出（clip 载体本项目 DOM 渲染层不支持，跳过） */
  const playByName = useCallback((name: string | undefined, nextFacing?: 'left' | 'right') => {
    if (!name) return;
    const action = assetRef.current?.actions.find((a) => a.name === name);
    if (!action || action.kind === 'clip') return;
    if (nextFacing) setFacing(nextFacing);
    setPlaying(action);
  }, []);

  /** 一次语义触发 → 决策 → 播放 */
  const trigger = useCallback(
    (request: Parameters<typeof resolvePlayback>[0]) => {
      const model = assetRef.current?.model;
      if (!model) return;
      const decision = resolvePlayback(
        { ...request, currentAction: playingRef.current?.name, facing: facingRef.current },
        model,
      );
      if (decision.ok) playByName(decision.actionName);
    },
    [playByName],
  );

  const refreshAsset = useCallback(() => {
    const pet = window.electronAPI?.pet;
    if (!pet) return;
    void pet.getAsset().then((next) => setAsset(next ?? null));
  }, []);

  useEffect(() => {
    const pet = window.electronAPI?.pet;
    if (!pet) return;
    let alive = true;
    void pet.getState().then((next) => {
      if (alive && next) setState(next);
    });
    refreshAsset();
    const offState = pet.onState((next) => setState(next));
    const offAsset = pet.onAssetChanged(() => refreshAsset());
    return () => {
      alive = false;
      offState();
      offAsset();
    };
  }, [refreshAsset]);

  // 主进程广播的四维 → 本地镜像
  useEffect(() => {
    loadVitals(state.vitals);
  }, [state.vitals, loadVitals]);

  // 待机随机动作：无动作在播时按决策模型随机抽一个
  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      const delay = IDLE_MIN_MS + Math.random() * IDLE_JITTER_MS;
      idleTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        if (!playingRef.current && assetRef.current) {
          const roll = Math.random();
          const nextFacing = roll < 0.2 ? 'right' : roll < 0.4 ? 'left' : undefined;
          trigger({ trigger: 'random' });
          if (nextFacing) setFacing(nextFacing);
        }
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [trigger]);

  const interact = async (kind: 'feed' | 'play' | 'rest') => {
    // 先按互动语义播动作（不连播当前动作），再落数值（主进程）
    trigger({ trigger: kind });
    markInteraction(kind);
    const pet = window.electronAPI?.pet;
    if (!pet) return;
    const result = await pet.action(kind);
    if (result?.vitals) setState((prev) => ({ ...prev, vitals: result.vitals! }));
  };

  const onPointerDown = (event: React.MouseEvent) => {
    dragMovedRef.current = false;
    dragXRef.current = event.clientX;
  };
  const onPointerMove = (event: React.MouseEvent) => {
    if (event.buttons !== 1) return;
    const dx = event.clientX - dragXRef.current;
    if (Math.abs(dx) > 6) {
      if (!dragMovedRef.current) trigger({ trigger: 'drag' });
      dragMovedRef.current = true;
      dragXRef.current = event.clientX;
      setFacing(dx < 0 ? 'right' : 'left');
    }
  };
  const onClick = () => {
    if (dragMovedRef.current) return;
    trigger({ trigger: 'click' });
  };

  const view = toPetWindowView(state);
  const displayName = asset?.name || view.petName;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        color: '#d6d7d9',
        fontFamily: "system-ui, 'Microsoft YaHei', sans-serif",
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* 顶部拖拽条：桌宠窗口无边框，靠它整体拖动 */}
      <div style={{ WebkitAppRegion: 'drag', width: '100%', textAlign: 'center', fontSize: 12, padding: '4px 0' }}>
        {displayName}
      </div>
      <div
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onClick={onClick}
        style={{ flex: 1, minHeight: 0, width: '100%', cursor: 'grab', WebkitAppRegion: 'no-drag', display: 'flex' }}
      >
        <PetStage view={view} asset={asset} playing={playing} facing={facing} onActionEnd={() => setPlaying(null)} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button type="button" style={actionBtn} onClick={() => void interact('feed')}>
          喂食
        </button>
        <button type="button" style={actionBtn} onClick={() => void interact('play')}>
          玩耍
        </button>
        <button type="button" style={actionBtn} onClick={() => void interact('rest')}>
          休息
        </button>
      </div>
      <div style={{ fontSize: 11, color: '#8b8f96', margin: '4px 0 6px', textAlign: 'center' }}>{view.hint}</div>
    </div>
  );
};

export default PetWindow;
