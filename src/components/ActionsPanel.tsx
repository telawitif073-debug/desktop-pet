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

/** 动作管理面板：AI 生成变换动画 / 手动上传帧序列 / 播放 / 删除（上限 15 个）
 * 含动作生成专用 AI 配置（可与聊天/智能体不同的模型，如非推理模型） */
const ActionsPanel = ({ onClose, onPlay }: Props) => {
  const [actions, setActions] = useState<PetAction[]>([]);
  const [aiName, setAiName] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // 动作生成专用 AI 覆盖（model/baseUrl/temperature，留空沿用全局）
  const [cfgForm, setCfgForm] = useState({ model: '', baseUrl: '', temperature: '' });
  const [cfgActive, setCfgActive] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
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
      const o = config?.actionLLM;
      setCfgForm({
        model: o?.model || '',
        baseUrl: o?.baseUrl || '',
        temperature: typeof o?.temperature === 'number' ? String(o.temperature) : '',
      });
      setCfgActive(!!(o?.model || o?.baseUrl || typeof o?.temperature === 'number'));
    } catch { /* 非电子环境忽略 */ }
  };

  useEffect(() => {
    reload();
    const cleanup = window.electronAPI?.onPetActionsChanged(() => reload());
    return cleanup;
  }, []);

  const handleGenerate = async () => {
    if (!aiName.trim()) { showNotice('请先填写动作名称'); return; }
    setBusy(true);
    try {
      const res = await window.electronAPI?.actions.generate(aiName.trim());
      if (res?.success) {
        showNotice(`动作「${aiName.trim()}」生成成功`);
        setAiName('');
        reload();
      } else {
        showNotice(res?.error || '生成失败');
      }
    } finally {
      setBusy(false);
    }
  };

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

  const handleSaveCfg = async () => {
    const t = parseFloat(cfgForm.temperature);
    const override: { model?: string; baseUrl?: string; temperature?: number } = {};
    if (cfgForm.model.trim()) override.model = cfgForm.model.trim();
    if (cfgForm.baseUrl.trim()) override.baseUrl = cfgForm.baseUrl.trim();
    if (!Number.isNaN(t)) override.temperature = Math.min(2, Math.max(0, t));
    setBusy(true);
    try {
      await window.electronAPI?.config.set({ actionLLM: override });
      showNotice(override.model || override.baseUrl || override.temperature !== undefined
        ? '动作生成 AI 配置已保存（生成动作时生效）'
        : '已恢复使用全局聊天模型');
      setCfgActive(!!(override.model || override.baseUrl || override.temperature !== undefined));
      reload();
    } catch {
      showNotice('保存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleClearCfg = async () => {
    setBusy(true);
    try {
      await window.electronAPI?.config.set({ actionLLM: undefined });
      showNotice('已清除，恢复使用全局聊天模型');
      setCfgForm({ model: '', baseUrl: '', temperature: '' });
      setCfgActive(false);
    } catch {
      showNotice('清除失败');
    } finally {
      setBusy(false);
    }
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
        <div style={{ fontSize: '12px', color: '#aaa', marginBottom: '6px' }}>AI 生成动作（输入名称，如：吃饭 / 走路 / 休息 / 玩耍）</div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            value={aiName}
            onChange={(e) => setAiName(e.target.value)}
            placeholder="动作名称"
            style={inputStyle}
          />
          <button type="button" onClick={handleGenerate} disabled={busy} style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}>
            {busy ? '生成中' : '生成'}
          </button>
        </div>

        {/* 动作生成专用 AI 配置（折叠） */}
        <div style={{ margin: '10px 0 6px', padding: '8px', background: '#222', borderRadius: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: cfgActive ? '#7ec8ff' : '#aaa' }}>
              生成 AI：{cfgActive ? '专用配置' : '跟随全局聊天模型'}
            </span>
            <button type="button" onClick={() => setCfgOpen(!cfgOpen)} style={{ ...ghostBtnStyle, padding: '2px 8px' }}>
              {cfgOpen ? '收起' : '配置'}
            </button>
          </div>
          {cfgOpen && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: '#888', marginBottom: '6px' }}>
                仅影响"生成动作"。推理类模型思维链会耗尽输出额度，建议填 deepseek-chat 等非推理模型；留空沿用全局。
              </div>
              <input value={cfgForm.model} onChange={(e) => setCfgForm({ ...cfgForm, model: e.target.value })} placeholder="模型名（如 deepseek-chat）" style={{ ...inputStyle, marginBottom: '6px' }} />
              <input value={cfgForm.baseUrl} onChange={(e) => setCfgForm({ ...cfgForm, baseUrl: e.target.value })} placeholder="接口地址（可选，默认官方）" style={{ ...inputStyle, marginBottom: '6px' }} />
              <input value={cfgForm.temperature} onChange={(e) => setCfgForm({ ...cfgForm, temperature: e.target.value })} placeholder="温度 0~2（可选）" style={{ ...inputStyle, marginBottom: '6px' }} />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button type="button" onClick={handleSaveCfg} disabled={busy} style={btnStyle}>保存配置</button>
                <button type="button" onClick={handleClearCfg} disabled={busy} style={ghostBtnStyle}>恢复全局</button>
              </div>
            </div>
          )}
        </div>

        <div style={{ fontSize: '12px', color: '#aaa', margin: '10px 0 6px' }}>手动上传帧序列（多张图片按顺序播放）</div>
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
            还没有动作，先生成一个或上传帧图
          </div>
        )}
        {actions.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', marginBottom: '6px', background: '#252525', borderRadius: '4px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: '11px', color: '#888' }}>
                {a.source === 'ai' ? 'AI 生成' : a.source === 'platform' ? `资源库（${a.frameFiles?.length || 0} 帧）` : `手动上传（${a.frameFiles?.length || 0} 帧）`} · {a.kind === 'transform' ? '变换动画' : '帧序列'}
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
