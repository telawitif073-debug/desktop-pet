import { useEffect, useState } from 'react';
import { DEFAULT_VITALS } from '@pet/domain';
import { toPetWindowView } from '../../renderer/pet/petView';
import type { PetRuntimeState } from '../../global.d';
import PetStage from './PetStage';

/** 宠物尚未就绪时的空状态（渲染兜底表情与默认四维） */
const EMPTY_STATE: PetRuntimeState = { vitals: { ...DEFAULT_VITALS }, ready: false, current: null };

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
 * 桌宠窗口根组件（渲染端 `#/pet` 路由）：读取主进程宠物状态、订阅状态广播，
 * 并提供喂食 / 玩耍 / 休息三个互动入口。骨架实现——形象渲染见 PetStage。
 */
const PetWindow = () => {
  const [state, setState] = useState<PetRuntimeState>(EMPTY_STATE);

  useEffect(() => {
    const pet = window.electronAPI?.pet;
    if (!pet) return;
    let alive = true;
    void pet.getState().then((next) => {
      if (alive && next) setState(next);
    });
    const off = pet.onState((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const interact = async (kind: 'feed' | 'play' | 'rest') => {
    const pet = window.electronAPI?.pet;
    if (!pet) return;
    const result = await pet.action(kind);
    if (result?.vitals) setState((prev) => ({ ...prev, vitals: result.vitals! }));
  };

  const view = toPetWindowView(state);

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
        {view.petName}
      </div>
      <PetStage view={view} />
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
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
      <div style={{ fontSize: 11, color: '#8b8f96', marginTop: 6, textAlign: 'center' }}>{view.hint}</div>
    </div>
  );
};

export default PetWindow;
