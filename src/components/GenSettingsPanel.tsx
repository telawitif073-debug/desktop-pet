import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import type { AiGenJobSnapshot } from '../global.d';

/** 与主进程 prompts.ts PAINT_STYLES 同款画风列表（渲染端镜像，避免主进程模块被打进渲染包） */
const GEN_STYLES = [
  { id: '', label: '默认可爱' },
  { id: 'pixel', label: '像素复古' },
  { id: 'dreamy', label: '梦幻唯美' },
  { id: 'guofeng', label: '国风唯美' },
  { id: 'aidrama', label: 'AI 短剧写真' },
];

const STAGE_LABELS: Record<string, string> = {
  base: '生成基准图',
  video: '生成动作视频',
  frames: '视频截帧',
  assemble: '拼合精灵表',
  layers: 'See-through 拆层',
  rig: 'PSD2Live 建模',
  pack: '打包模型',
};

type GenPath = 'sprite' | 'live2d';

/** AI 生成宠物（本地生成，用户自备 Key）：Key 配置 + 描述生成 + 进度轮询 + 安装切换 */
const GenSettingsPanel = () => {
  const { config, saveConfig } = useChatStore();
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (text: string, isError = false) => {
    setNotice(text);
    setNoticeError(isError);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  };

  const [keysForm, setKeysForm] = useState({
    dashscopeKey: config?.aiGen?.dashscopeKey || '',
    arkKey: config?.aiGen?.arkKey || '',
    zhipuKey: config?.aiGen?.zhipuKey || '',
  });
  const [description, setDescription] = useState('');
  const [style, setStyle] = useState('');
  const [genPath, setGenPath] = useState<GenPath>('sprite');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<AiGenJobSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [genName, setGenName] = useState('');

  const hasApi = !!window.electronAPI?.aiGen;

  // 任务轮询：2s 一次，done/failed 自动停止
  useEffect(() => {
    if (!jobId || !hasApi) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snapshot = await window.electronAPI!.aiGen.jobStatus(jobId);
        if (cancelled) return;
        setJob(snapshot);
        if (snapshot?.status === 'done') {
          setGenName(snapshot.result?.name || '');
          showNotice('生成完成，可安装到桌面');
        } else if (snapshot?.status === 'failed') {
          showNotice(`生成失败：${snapshot.error || '未知错误'}`, true);
        }
      } catch {
        // 轮询异常忽略，下轮重试
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, hasApi]);

  const handleSaveKeys = async () => {
    await saveConfig({ aiGen: keysForm });
    showNotice('Key 已保存（仅存本机 config.json）');
  };

  const startGenerate = async () => {
    const desc = description.trim();
    if (!desc) {
      showNotice('请先填写宠物描述', true);
      return;
    }
    if (genPath === 'sprite' && !keysForm.dashscopeKey.trim()) {
      showNotice('精灵表路径需要万相 Key（阿里云百炼 DashScope），请先填写并保存', true);
      return;
    }
    if (!keysForm.arkKey.trim() && !keysForm.zhipuKey.trim()) {
      showNotice('需要图像生成 Key：推荐填写免费的智谱 Key（CogView-3-Flash）', true);
      return;
    }
    setSubmitting(true);
    setJob(null);
    setGenName('');
    try {
      if (genPath === 'sprite') {
        const { jobId: id } = await window.electronAPI!.aiGen.generateSprite(desc, style || undefined);
        setJobId(id);
        showNotice('任务已启动，生成约需 5-25 分钟（可离开页面，回来查看进度）');
      } else {
        const res = await window.electronAPI!.aiGen.generateLive2d(desc, style || undefined);
        if (!res.ok || !res.jobId) {
          showNotice(res.error || 'Live2D 环境未配置', true);
          return;
        }
        setJobId(res.jobId);
        showNotice('Live2D 任务已启动（拆层+建模约 5-25 分钟）');
      }
    } catch (e) {
      showNotice(`任务启动失败：${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleInstall = async () => {
    if (!jobId || job?.status !== 'done') return;
    setInstalling(true);
    try {
      const res = await window.electronAPI!.aiGen.install(jobId);
      showNotice(`已安装并切换为当前宠物：${res.name}`);
    } catch (e) {
      showNotice(`安装失败：${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setInstalling(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #555',
    borderRadius: '4px',
    background: '#2a2a2a',
    color: '#eee',
    fontSize: '12px',
    boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '11px',
    color: '#aaa',
    marginBottom: '3px',
    marginTop: '8px',
  };
  const btnStyle: React.CSSProperties = {
    flex: 1,
    padding: '6px',
    border: 'none',
    borderRadius: '4px',
    background: '#4a9eff',
    color: 'white',
    fontSize: '12px',
    cursor: 'pointer',
  };
  const progressPct = job ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const stageText = job
    ? `${STAGE_LABELS[job.stage] || job.stage}${job.current && job.stage !== 'base' ? `（${job.current}）` : ''}`
    : '';

  if (!hasApi) {
    return (
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#eee' }}>AI 生成宠物</div>
        <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>当前环境不支持（需在桌面客户端中使用）。</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
      <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#eee' }}>AI 生成宠物（本地生成，Key 仅存本机）</div>

      {notice && (
        <div style={{
          padding: '5px 8px', marginTop: '8px', borderRadius: '4px', fontSize: '11px',
          background: noticeError ? '#4a2b2b' : '#2b3a4a',
          color: noticeError ? '#ff9f9f' : '#9fd0ff',
        }}>
          {notice}
        </div>
      )}

      {/* Key 配置 */}
      <label style={labelStyle}>万相 Key（DashScope，精灵表路径必需）</label>
      <input
        type="password"
        value={keysForm.dashscopeKey}
        onChange={(e) => setKeysForm({ ...keysForm, dashscopeKey: e.target.value })}
        placeholder="sk-...（阿里云百炼）"
        style={inputStyle}
      />
      <label style={labelStyle}>智谱 Key（免费出图 CogView + 提示词细化）</label>
      <input
        type="password"
        value={keysForm.zhipuKey}
        onChange={(e) => setKeysForm({ ...keysForm, zhipuKey: e.target.value })}
        placeholder="...（open.bigmodel.cn）"
        style={inputStyle}
      />
      <label style={labelStyle}>火山方舟 Key（可选，Seedream 出图更稳定）</label>
      <input
        type="password"
        value={keysForm.arkKey}
        onChange={(e) => setKeysForm({ ...keysForm, arkKey: e.target.value })}
        placeholder="...（ark.cn-beijing.volces.com）"
        style={inputStyle}
      />
      <button type="button" onClick={handleSaveKeys} style={{ ...btnStyle, marginTop: '8px', background: '#333', border: '1px solid #555', color: '#ccc' }}>
        保存 Key
      </button>

      {/* 生成表单 */}
      <label style={labelStyle}>宠物描述（人物或动物均可）</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="例如：一只圆滚滚的橘猫，头顶有一撮呆毛"
        rows={2}
        style={{ ...inputStyle, resize: 'none' }}
      />
      <label style={labelStyle}>画风</label>
      <select value={style} onChange={(e) => setStyle(e.target.value)} style={inputStyle}>
        {GEN_STYLES.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
        {([
          ['sprite', '精灵表（五状态动画）'],
          ['live2d', 'Live2D（需本机部署工具）'],
        ] as Array<[GenPath, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setGenPath(id)}
            style={{
              flex: 1,
              padding: '6px 4px',
              fontSize: '11px',
              borderRadius: '4px',
              cursor: 'pointer',
              border: genPath === id ? '1px solid #4a9eff' : '1px solid #555',
              background: genPath === id ? '#2b3a4a' : '#333',
              color: genPath === id ? '#9fd0ff' : '#ccc',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" onClick={startGenerate} disabled={submitting} style={{ ...btnStyle, marginTop: '8px', opacity: submitting ? 0.6 : 1 }}>
        {submitting ? '启动中...' : '开始生成'}
      </button>

      {/* 进度与结果 */}
      {jobId && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '11px', color: '#aaa' }}>
            {job?.status === 'done' ? '生成完成' : job?.status === 'failed' ? '生成失败' : `${stageText || '排队中'} ${progressPct}%`}
          </div>
          <div style={{ height: '4px', background: '#3a3a3a', borderRadius: '2px', marginTop: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: job?.status === 'failed' ? '#e05555' : '#4a9eff', transition: 'width 1s' }} />
          </div>
          {job?.result?.previewDataUrl && (
            <img
              src={job.result.previewDataUrl}
              alt="预览"
              style={{ width: '100%', marginTop: '8px', borderRadius: '4px', border: '1px solid #444', imageRendering: 'pixelated' }}
            />
          )}
          {job?.status === 'done' && (
            <button type="button" onClick={handleInstall} disabled={installing} style={{ ...btnStyle, marginTop: '8px' }}>
              {installing ? '安装中...' : `安装到桌面${genName ? `（${genName}）` : ''}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default GenSettingsPanel;
