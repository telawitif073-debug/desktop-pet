import type { PetWindowView } from '../../renderer/pet/petView';

/**
 * 桌宠舞台：渲染头像（表情 + 主题色）与四维状态条。
 * 骨架实现——真实形象资源（图片 / 帧序列 / Live2D）后续接入，这里先用 `@pet/ui` 的兜底表情。
 */
const PetStage = ({ view }: { view: PetWindowView }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 12 }}>
    <div
      title={view.avatar.label}
      style={{ fontSize: 64, lineHeight: 1, filter: view.ready ? 'none' : 'grayscale(1)' }}
    >
      {view.avatar.emoji}
    </div>
    <div style={{ fontSize: 12, color: view.avatar.accent }}>{view.avatar.label}</div>
    <div style={{ width: 150 }}>
      {view.vitals.map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
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

export default PetStage;
