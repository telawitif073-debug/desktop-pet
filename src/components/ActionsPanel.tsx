import { useEffect, useRef, useState } from 'react';
import type { PetAction } from '../global.d';

interface Props {
  onClose: () => void;
  onPlay: (id: string) => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: '4px', fontSize: '12px',
  border: '1px solid #444', background: '#1e1e1e', color: '#eee', boxSizing: 'border-box',
};
const btnStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer',
  border: 'none', background: '#4a9eff', color: 'white', whiteSpace: 'nowrap',
};
const ghostBtnStyle: React.CSSProperties = {
  ...btnStyle, background: '#333', color: '#ccc', border: '1px solid #555',
};
const dangerBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle, color: '#ff8080', borderColor: '#6a3a3a', padding: '3px 8px',
};

/** 动作管理面板：手动上传帧序列 / 播放 / 删除（上限 15 个） */
const ActionsPanel = ({ onClose, onPlay }: Props) => {
  const [actions, setActions] = useState<PetAction[]>([]);
  const [uploadName, setUploadName] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3500);
  };

  const reload = async () => {
    try {
      const config = await window.electronAPI?.config.get();
      setActions((config?.petActions as PetAction[]) || []);
    } catch { /* 非电子环境忽略 */ }
  };

  useEffect(() => {
    reload();
    const cleanup = window.electronAPI?.onPetActionsChanged(() => reload());
    return cleanup;
  }, []);

  const handleFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
  };

  const handleUpload = async () => {
    if (!uploadName.trim()) { showNotice('请先填写动作名称'); return; }
    if (!selectedFiles.length) { showNotice('请先选择图片（可多选，按选择顺序播放）'); return; }
    setBusy(true);
    try {
      const payload = await Promise.all(
        selectedFiles.map(async (f) => ({ filename: f.name, data: new Uint8Array(await f.arrayBuffer()) }))
      );
      const res = await window.electronAPI?.actions.addFrames(uploadName.trim(), payload);
      if (res?.success) {
        showNotice(`动作「${uploadName.trim()}」上传成功（${selectedFiles.length} 帧）`);
        setUploadName('');
        setSelectedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        reload();
      } else {
        showNotice(res?.error || '上传失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (id: string, name: string) => {
    const res = await window.electronAPI?.actions.remove(id);
    showNotice(res?.success ? `已删除「${name}」` : res?.error || '删除失败');
  };

  return (
    <div style={{ width: 350, height: '100%', background: '#181818', borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', color: '#eee' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold', fontSize: '14px' }}>动作管理（{actions.length}/15）</span>
        <button type="button" onClick={onClose} style={{ ...ghostBtnStyle, padding: '2px 8px' }}>收起</button>
      </div>

      {notice && (
        <div style={{ margin: '8px 12px 0', padding: '6px 10px', borderRadius: '4px', background: '#2b3a4a', color: '#9fd0ff', fontSize: '12px' }}>
          {notice}
        </div>
      )}

      <div style={{ padding: '10px 12px', borderBottom: '1px solid #333' }}>
        <div style={{ fontSize: '12px', color: '#aaa', marginBottom: '6px' }}>手动上传帧序列（多张图片按顺序播放）</div>
        <input
          value={uploadName}
          onChange={(e) => setUploadName(e.target.value)}
          placeholder="动作名称"
          style={{ ...inputStyle, marginBottom: '6px' }}
        />
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.gif,.webp"
            onChange={handleFilesPicked}
            style={{ fontSize: '11px', color: '#aaa', flex: 1, minWidth: 0 }}
          />
          <button type="button" onClick={handleUpload} disabled={busy} style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}>
            {busy ? '上传中' : '上传'}
          </button>
        </div>
        {selectedFiles.length > 0 && (
          <div style={{ fontSize: '11px', color: '#7ec8ff', marginTop: '4px' }}>已选 {selectedFiles.length} 张图片</div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {actions.length === 0 && (
          <div style={{ fontSize: '12px', color: '#777', textAlign: 'center', marginTop: '20px' }}>
            还没有动作，先上传帧图
          </div>
        )}
        {actions.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', marginBottom: '6px', background: '#252525', borderRadius: '4px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: '11px', color: '#888' }}>
                {a.kind === 'clip' ? `模型动画（${a.clipName}）` : `帧序列（${a.frameFiles?.length || 0} 帧）`} · {a.source === 'ai' ? 'AI 生成' : a.source === 'platform' ? '资源库' : '手动上传'}
              </div>
            </div>
            <button type="button" onClick={() => onPlay(a.id)} style={{ ...ghostBtnStyle, padding: '3px 8px' }}>播放</button>
            <button type="button" onClick={() => handleRemove(a.id, a.name)} style={dangerBtnStyle}>删除</button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActionsPanel;
