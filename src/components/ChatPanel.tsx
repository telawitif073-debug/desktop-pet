import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { TONE_PRESETS, EDGE_VOICES, listVoices, speak, previewInstalled, DEFAULT_PREVIEW_TEXT } from '../renderer/speech';
import MarkdownText from './MarkdownText';
import type { ChatMessage } from '../global.d';
import type { SpeechSettings, LlmProfile, VoiceConfig } from '../main/config';

// 从 config.installedAgentConfig 中解析当前生效的智能体信息
function resolveAgent(config: { installedAgentConfig?: unknown } | null) {
  const cfg = config?.installedAgentConfig;
  if (!cfg || typeof cfg !== 'object') return null;
  const fields = cfg as { name?: unknown; systemPrompt?: unknown };
  return {
    name: typeof fields.name === 'string' && fields.name ? fields.name : '自定义智能体',
    systemPrompt: typeof fields.systemPrompt === 'string' ? fields.systemPrompt : '',
    isCustom: fields.name === '自定义智能体',
  };
}

const SettingsPanel = () => {
  const { config, saveConfig, toggleSettings } = useChatStore();
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3000);
  };
  // 多 API 档案：API 全部由用户配置（平台不提供、无默认 API），列表内各档案同级、选中即生效
  const profilesInit = config?.llmProfiles || [];
  const activeInit = profilesInit.find((p) => p.id === config?.llmActiveProfileId) ?? profilesInit[0];
  const [profiles, setProfiles] = useState<LlmProfile[]>(profilesInit);
  const [activeId, setActiveId] = useState(activeInit?.id || '');

  const [form, setForm] = useState({
    profileName: activeInit?.name || '',
    apiKey: activeInit?.apiKey || '',
    baseUrl: activeInit?.baseUrl || '',
    model: activeInit?.model || '',
    systemPrompt: activeInit?.systemPrompt || '',
    userName: config?.userProfile.name || '',
    proactiveEnabled: config?.agentProactive?.enabled ?? true,
    proactiveInterval: config?.agentProactive?.intervalMinutes ?? 30,
    speechEnabled: config?.speech?.enabled ?? true,
    clearAsk: config?.chatClearConfirm !== 'never',
    voice: config?.speech?.voice || (config?.speech?.voiceURI ? `sys:${config.speech.voiceURI}` : ''),
    tone: (config?.speech?.tone || 'natural') as SpeechSettings['tone'],
    speechRate: config?.speech?.rate ?? 1,
    speechPitch: config?.speech?.pitch ?? 1,
    speechVolume: config?.speech?.volume ?? 1,
    // 全局音色选择：云音色库（downloadedVoices[].id）；空 = 用 Edge/系统音色
    cloudVoiceId: config?.activeCloudVoiceId || '',
    // 云 TTS 服务凭证（全局共享；Key 只落本机与云端加密库）
    ttsEngine: (config?.ttsCloudConfig?.engine || 'openai') as 'openai' | 'gptsovits',
    ttsBaseUrl: config?.ttsCloudConfig?.baseUrl || '',
    ttsModel: config?.ttsCloudConfig?.model || '',
    ttsApiKey: config?.ttsCloudConfig?.apiKey || '',
    // 对话体验：思考过程显示/思考语言
    showThinking: config?.showThinking === true,
    thinkingLang: (config?.thinkingLang || 'auto') as 'auto' | 'zh' | 'en',
  });

  /** 切换档案：载入对应档案内容到表单；未保存的修改会被放弃 */
  const switchProfile = (id: string) => {
    setActiveId(id);
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    setForm((prev) => ({
      ...prev,
      profileName: profile.name,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      systemPrompt: profile.systemPrompt || '',
    }));
  };

  const addProfile = () => {
    const id = `p_${Date.now().toString(36)}`;
    // 新档案从空白开始：清空 Key/模型/提示词，避免把上一个 API 的内容带进来；Base URL 保留便于同站多 Key
    const profile: LlmProfile = {
      id,
      name: `API ${profiles.length + 1}`,
      apiKey: '',
      baseUrl: form.baseUrl,
      model: '',
      systemPrompt: '',
    };
    setProfiles((cur) => [...cur, profile]);
    setActiveId(id);
    setForm((prev) => ({ ...prev, profileName: profile.name, apiKey: '', model: '', systemPrompt: '' }));
    showNotice('已新增 API 档案，填写 Key 与模型后点保存生效');
  };

  const removeProfile = () => {
    if (!activeId) return;
    const rest = profiles.filter((p) => p.id !== activeId);
    setProfiles(rest);
    const next = rest[0];
    setActiveId(next?.id || '');
    setForm((prev) => ({
      ...prev,
      profileName: next?.name || '',
      apiKey: next?.apiKey || '',
      baseUrl: next?.baseUrl || '',
      model: next?.model || '',
      systemPrompt: next?.systemPrompt || '',
    }));
    showNotice('已删除 API 档案，保存后生效');
  };

  // 系统音色列表：异步加载，voiceschanged 兜底（Chromium 首次 getVoices 可能为空）
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(listVoices());
    load();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', load);
      return () => speechSynthesis.removeEventListener('voiceschanged', load);
    }
  }, []);

  // ── 音色库（本机已安装云音色）与云 TTS 服务配置 ──
  const installedVoices = config?.downloadedVoices ?? [];
  const [ttsOpen, setTtsOpen] = useState(false);
  const [ttsTesting, setTtsTesting] = useState('');
  /** 当前表单对应的朗读基础配置（试听与正式朗读共用同一套语速/音调/音量） */
  const formSpeech = (): SpeechSettings => ({
    enabled: true,
    voice: form.voice || undefined,
    tone: form.tone,
    rate: Number(form.speechRate) || 1,
    pitch: Number(form.speechPitch) || 1,
    volume: Number(form.speechVolume) || 1,
  });
  const formTtsCloud = () => ({
    engine: form.ttsEngine,
    baseUrl: form.ttsBaseUrl.trim().replace(/\/+$/, ''),
    model: form.ttsModel.trim(),
    apiKey: form.ttsApiKey.trim(),
  });
  /** GPT-SoVITS 引擎连通性测试（需要引擎已在本机/局域网运行） */
  const testTtsEngine = async () => {
    setTtsTesting('正在测试连接…');
    const res = await window.electronAPI?.tts.testGptsovits(form.ttsBaseUrl.trim());
    setTtsTesting(res?.message || '测试失败');
  };
  /** 试听当前选择的音色：云音色先落盘云 TTS 凭证再现场合成；Edge/系统音色直接朗读 */
  const previewSelected = async () => {
    const selected = installedVoices.find((v) => v.id === form.cloudVoiceId);
    if (!selected) {
      speak(DEFAULT_PREVIEW_TEXT, { speech: formSpeech() });
      return;
    }
    try {
      await saveConfig({ ttsCloudConfig: formTtsCloud() });
      await previewInstalled(selected);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // ── 音色库管理（本机自建音色，local- 前缀；商店安装的音色在创作中心音色板块）──
  const [voiceMgrOpen, setVoiceMgrOpen] = useState(false);
  const [voiceForm, setVoiceForm] = useState({
    name: '',
    engine: 'cloud' as VoiceConfig['engine'],
    voiceId: '',
    model: '',
    refAudioPath: '',
  });
  const engineLabel = (engine: VoiceConfig['engine']): string =>
    engine === 'gptsovits' ? 'GPT-SoVITS' : engine === 'system' ? '系统音色' : '云 TTS';

  /** 手动添加本机音色（云 TTS voiceId / GPT-SoVITS 参考音频 / 系统音色名），添加后即设为全局音色 */
  const addLocalVoice = async () => {
    const name = voiceForm.name.trim();
    if (!name) {
      showNotice('请先填写音色名称');
      return;
    }
    if (voiceForm.engine === 'cloud' && !voiceForm.voiceId.trim()) {
      showNotice('云音色需要填写 voiceId（如 alloy，或平台克隆音色 id）');
      return;
    }
    if (voiceForm.engine === 'gptsovits' && !voiceForm.refAudioPath.trim()) {
      showNotice('GPT-SoVITS 音色需要填写引擎所在机器上的参考音频路径');
      return;
    }
    const id = `local-${Date.now().toString(36)}`;
    const voiceId = voiceForm.voiceId.trim();
    const config: VoiceConfig =
      voiceForm.engine === 'gptsovits'
        ? {
            engine: 'gptsovits',
            voiceId: '',
            baseUrl: '',
            refAudioPath: voiceForm.refAudioPath.trim(),
            promptText: '',
            promptLang: 'zh',
            textLang: 'zh',
            sampleText: '',
          }
        : voiceForm.engine === 'system'
          ? { engine: 'system', voiceId, voiceName: voiceId, sampleText: '' }
          : {
              engine: 'cloud',
              voiceId,
              baseUrl: '',
              model: voiceForm.model.trim(),
              instructions: '',
              sampleText: '',
            };
    await saveConfig({
      // 一并落盘云 TTS 服务配置与全局音色选择，添加后即可直接试听/朗读（与提示文案一致）
      ttsCloudConfig: formTtsCloud(),
      activeCloudVoiceId: id,
      downloadedVoices: [...installedVoices, { id, name, config, installedAt: Date.now(), fromStore: false }],
    });
    setForm((prev) => ({ ...prev, cloudVoiceId: id }));
    setVoiceForm({ name: '', engine: voiceForm.engine, voiceId: '', model: '', refAudioPath: '' });
    showNotice(`已添加音色「${name}」，已设为全局音色`);
  };

  /** 删除本机音色；若正是当前全局音色则同时清空选择（自动回退 Edge/系统音色） */
  const removeLocalVoice = async (id: string) => {
    const isActive = form.cloudVoiceId === id;
    await saveConfig({
      downloadedVoices: installedVoices.filter((v) => v.id !== id),
      ...(isActive ? { activeCloudVoiceId: '' } : {}),
    });
    if (isActive) setForm((prev) => ({ ...prev, cloudVoiceId: '' }));
    showNotice(isActive ? '已删除音色，朗读回退 Edge/系统音色' : '已删除音色');
  };

  // 将自定义提示词（连同模型/接口地址）一键生成自定义智能体，立即生效
  const generateAgent = async () => {
    const prompt = form.systemPrompt.trim();
    if (!prompt) {
      showNotice('请先在下方填写自定义提示词，再生成自定义智能体');
      return;
    }
    await saveConfig({
      installedAgentConfig: {
        name: '自定义智能体',
        systemPrompt: prompt,
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      },
    });
    showNotice('自定义智能体已生成并立即生效');
  };

  // 移除自定义智能体：其提示词回填到自定义提示词输入框，避免内容丢失
  const removeAgent = async () => {
    const agent = resolveAgent(config);
    await saveConfig({ installedAgentConfig: undefined });
    if (agent?.systemPrompt) {
      setForm((prev) => ({ ...prev, systemPrompt: agent.systemPrompt }));
    }
    showNotice('已移除自定义智能体，恢复默认人格');
  };

  const handleSave = async () => {
    const agent = resolveAgent(config);
    // API 全部由用户配置的档案组成（无默认 API）：必须先新增档案才能保存
    if (!activeId) {
      showNotice('请先点击「新增」创建 API 档案，再填写保存');
      return;
    }
    const profilesPayload: LlmProfile[] = profiles.map((p) =>
      p.id === activeId
        ? {
            ...p,
            name: form.profileName.trim() || p.name,
            apiKey: form.apiKey,
            baseUrl: form.baseUrl,
            model: form.model,
            systemPrompt: form.systemPrompt,
          }
        : p
    );
    await saveConfig({
      llmProfiles: profilesPayload,
      llmActiveProfileId: activeId,
      userProfile: { name: form.userName, preferences: config?.userProfile.preferences || {} },
      // 自定义智能体仅提供人设（平台不提供 API，不写入 model/baseUrl）
      ...(agent?.isCustom
        ? {
            installedAgentConfig: {
              name: '自定义智能体',
              systemPrompt: form.systemPrompt.trim(),
            },
          }
        : {}),
      agentProactive: {
        enabled: form.proactiveEnabled,
        intervalMinutes: Math.max(10, Number(form.proactiveInterval) || 30),
      },
      // 语音朗读配置（回复/主动消息统一走 speech.ts 三引擎链）
      speech: {
        enabled: form.speechEnabled,
        voice: form.voice || undefined,
        tone: form.tone,
        rate: Number(form.speechRate) || 1,
        pitch: Number(form.speechPitch) || 1,
        volume: Number(form.speechVolume) || 1,
      },
      // 全局音色选择（云音色库）与云 TTS 服务凭证（Key 只存本机，云同步时服务端加密）
      activeCloudVoiceId: form.cloudVoiceId || '',
      ttsCloudConfig: formTtsCloud(),
      // 清空对话前是否询问（"以后不再询问"后可在此重新开启）
      chatClearConfirm: form.clearAsk ? 'ask' : 'never',
      // 对话体验：思考过程显示/思考语言
      showThinking: form.showThinking,
      thinkingLang: form.thinkingLang,
    });
    // 本地档案列表同步（改名/改配置后下拉立即显示新内容，无需重开面板）
    setProfiles(profilesPayload);
    showNotice(`已保存：${profilesPayload.find((p) => p.id === activeId)?.name || 'API'}（当前生效）`);
    toggleSettings();
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

  return (
    <div style={{ padding: '12px', overflowY: 'auto', height: '100%' }}>
      {notice && (
        <div style={{ padding: '6px 10px', marginBottom: '10px', borderRadius: '4px', background: '#2b3a4a', color: '#9fd0ff', fontSize: '12px' }}>
          {notice}
        </div>
      )}
      <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', color: '#eee' }}>
        设置
      </div>

      {/* 当前生效的智能体状态 + 自定义智能体生成/移除操作 */}
      {(() => {
        const agent = resolveAgent(config);
        const btnStyle: React.CSSProperties = {
          width: '100%', padding: '6px', borderRadius: '4px', fontSize: '12px',
          cursor: 'pointer', marginTop: '8px',
          border: agent ? '1px solid #666' : 'none',
          background: agent ? '#333' : '#4a9eff',
          color: agent ? '#ccc' : 'white',
        };
        return (
          <div style={{ padding: '8px 10px', marginBottom: '10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
            <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>当前智能体</div>
            <div style={{ fontSize: '12px', color: agent ? '#7ec8ff' : '#888' }}>
              {agent ? `${agent.name}（已生效）` : '默认人格（未启用智能体）'}
            </div>
            {agent && !agent.isCustom && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                该智能体来自资源库安装，可在个人中心-已下载资源中卸载；其提示词与参数会覆盖下方手动配置。
              </div>
            )}
            {agent && agent.isCustom && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                由自定义提示词生成，模型/接口地址取自下方表单；移除后提示词会自动回填。
              </div>
            )}
            {!agent && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                填写下方自定义提示词后，可一键生成为自定义智能体（立即生效，无需上传审核）。
              </div>
            )}
            {!agent || agent.isCustom ? (
              <button
                type="button"
                onClick={agent?.isCustom ? removeAgent : generateAgent}
                style={btnStyle}
              >
                {agent?.isCustom ? '移除自定义智能体（恢复默认人格）' : '将自定义提示词生成为自定义智能体'}
              </button>
            ) : null}
          </div>
        );
      })()}

      {/* 多 API 配置档案：可保存多套 Key/模型，选中后修改表单并保存即生效 */}
      <div style={{ padding: '8px 10px', marginBottom: '10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>
          API 配置（全部由用户自行配置；选中的为当前生效 API）
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={activeId}
            onChange={(e) => switchProfile(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          >
            {profiles.length === 0 && <option value="">（尚未配置 API，点击「新增」创建）</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={addProfile}
            title="新增一个空白 API 档案（Key/模型需重新填写）"
            style={{ padding: '4px 10px', border: '1px solid #555', borderRadius: '4px', background: '#333', color: '#ccc', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
          >
            新增
          </button>
          {activeId && (
            <button
              type="button"
              onClick={removeProfile}
              title="删除当前选中的 API 档案"
              style={{ padding: '4px 10px', border: '1px solid #7a4444', borderRadius: '4px', background: '#3a2626', color: '#ff9f9f', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
            >
              删除
            </button>
          )}
        </div>
        {/* 宠工坊（智能体/动作/音色/上传发布）已收口到资源中心窗口内的页面：
            入口唯一，聊天设置里不再重复放按钮 */}
        {activeId && (
          <>
            <label style={{ ...labelStyle, marginTop: 6 }}>API 名称（可修改，保存后下拉显示新名称）</label>
            <input
              value={form.profileName}
              onChange={(e) => setForm({ ...form, profileName: e.target.value })}
              placeholder="API 名称（如：DeepSeek 官方）"
              style={inputStyle}
            />
          </>
        )}
      </div>

      <label style={labelStyle}>API Key</label>
      <input
        type="password"
        value={form.apiKey}
        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        placeholder="sk-..."
        style={inputStyle}
      />

      <label style={labelStyle}>API Base URL</label>
      <input
        type="text"
        value={form.baseUrl}
        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        placeholder="https://api.openai.com/v1"
        style={inputStyle}
      />

      <label style={labelStyle}>模型</label>
      <input
        type="text"
        value={form.model}
        onChange={(e) => setForm({ ...form, model: e.target.value })}
        placeholder="gpt-4o-mini"
        style={inputStyle}
      />

      <label style={labelStyle}>你的名字</label>
      <input
        type="text"
        value={form.userName}
        onChange={(e) => setForm({ ...form, userName: e.target.value })}
        placeholder="主人"
        style={inputStyle}
      />

      <label style={labelStyle}>自定义提示词（可选）</label>
      <textarea
        value={form.systemPrompt}
        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        placeholder="额外的性格设定..."
        rows={3}
        style={{ ...inputStyle, resize: 'none' }}
      />

      {/* 对话体验（DeepSeek 风格）：思考过程显示与思考语言 */}
      <div style={{ marginTop: '10px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>对话体验</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.showThinking}
            onChange={(e) => setForm({ ...form, showThinking: e.target.checked })}
          />
          显示思考过程（推理模型返回的思维链，可展开查看）
        </label>
        <label style={{ ...labelStyle, marginTop: 6 }}>思考语言</label>
        <select
          value={form.thinkingLang}
          onChange={(e) => setForm({ ...form, thinkingLang: e.target.value as 'auto' | 'zh' | 'en' })}
          disabled={!form.showThinking}
          style={inputStyle}
        >
          <option value="auto">跟随模型</option>
          <option value="zh">强制中文思考</option>
          <option value="en">强制英文思考</option>
        </select>
        <div style={{ fontSize: '10px', color: '#777', marginTop: '2px' }}>
          仅约束模型的内部思考，正文回复不受影响；关闭「显示思考过程」时不额外干预
        </div>
      </div>

      {/* 智能体主动发起对话：定时消息，仅唤醒时段 8-22 点 */}
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.proactiveEnabled}
            onChange={(e) => setForm({ ...form, proactiveEnabled: e.target.checked })}
          />
          允许智能体主动发起对话
        </label>
        {form.proactiveEnabled && (
          <>
            <label style={labelStyle}>主动发起间隔（分钟，最小 10）</label>
            <input
              type="number"
              min={10}
              value={form.proactiveInterval}
              onChange={(e) => setForm({ ...form, proactiveInterval: Number(e.target.value) })}
              style={inputStyle}
            />
          </>
        )}
      </div>

      {/* 语音朗读：回复/主动消息朗读（系统免费 TTS，离线可用），音色/语气/声线/语速可调 */}
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.speechEnabled}
            onChange={(e) => setForm({ ...form, speechEnabled: e.target.checked })}
          />
          语音朗读（回复与主动消息）
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={form.clearAsk}
            onChange={(e) => setForm({ ...form, clearAsk: e.target.checked })}
          />
          清空对话前询问（关闭后点「清空」直接执行）
        </label>
        {form.speechEnabled && (
          <>
            <label style={labelStyle}>音色（智能体专属音色 → 云音色 → Edge 神经音色 → 系统声音逐级降级）</label>
            <select
              value={form.cloudVoiceId ? `cloud:${form.cloudVoiceId}` : form.voice}
              onChange={(e) => {
                const value = e.target.value;
                // 云音色选择清空语音的基础音色（保留 Edge/系统选择便于随时切回）
                if (value.startsWith('cloud:')) setForm({ ...form, cloudVoiceId: value.slice(6) });
                else setForm({ ...form, voice: value, cloudVoiceId: '' });
              }}
              style={inputStyle}
            >
              {installedVoices.length > 0 && (
                <optgroup label="已安装音色（本机音色库）">
                  {installedVoices.map((v) => (
                    <option key={v.id} value={`cloud:${v.id}`}>
                      {v.name}（{engineLabel(v.config.engine)}）
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Edge 神经音色（推荐·免费在线）">
                <option value="">晓晓（默认·温暖自然）</option>
                {EDGE_VOICES.filter((v) => v.name !== 'zh-CN-XiaoxiaoNeural').map((v) => (
                  <option key={v.name} value={`edge:${v.name}`}>{v.label}</option>
                ))}
              </optgroup>
              {voices.length > 0 && (
                <optgroup label="系统声音（离线）">
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={`sys:${v.voiceURI}`}>{v.name}（{v.lang}）</option>
                  ))}
                </optgroup>
              )}
            </select>
            <label style={labelStyle}>语气</label>
            <select
              value={form.tone}
              onChange={(e) => setForm({ ...form, tone: e.target.value as SpeechSettings['tone'] })}
              style={inputStyle}
            >
              {TONE_PRESETS.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <label style={labelStyle}>语速：{Number(form.speechRate).toFixed(2)}x</label>
            <input
              type="range" min={0.5} max={2} step={0.05} value={form.speechRate}
              onChange={(e) => setForm({ ...form, speechRate: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <label style={labelStyle}>声线（音调）：{Number(form.speechPitch).toFixed(2)}</label>
            <input
              type="range" min={0} max={2} step={0.05} value={form.speechPitch}
              onChange={(e) => setForm({ ...form, speechPitch: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <label style={labelStyle}>音量：{Math.round(form.speechVolume * 100)}%</label>
            <input
              type="range" min={0} max={1} step={0.05} value={form.speechVolume}
              onChange={(e) => setForm({ ...form, speechVolume: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <button
              type="button"
              onClick={() => void previewSelected()}
              style={{ width: '100%', marginTop: '8px', padding: '6px', border: '1px solid #555', borderRadius: '4px', background: '#333', color: '#ccc', fontSize: '12px', cursor: 'pointer' }}
            >
              试听当前音色
            </button>

            {/* 云 TTS 服务配置：OpenAI 兼容 /audio/speech 或自建 GPT-SoVITS（用户自己的凭证） */}
            <button
              type="button"
              onClick={() => setTtsOpen((open) => !open)}
              style={{ width: '100%', marginTop: '8px', padding: '6px', border: '1px solid #555', borderRadius: '4px', background: '#2a2a2a', color: '#9ad', fontSize: '12px', cursor: 'pointer' }}
            >
              {ttsOpen ? '收起云 TTS 服务配置' : '云 TTS 服务配置（云音色 / GPT-SoVITS 需要）'}
            </button>
            {ttsOpen && (
              <>
                <div style={{ marginTop: 6, fontSize: 11, color: '#888', lineHeight: 1.6 }}>
                  云音色（商店下载或导入的音色）用你自己的服务合成：OpenAI 兼容接口需地址 + Key；
                  自建 GPT-SoVITS 只需地址（音色自带参考音频，零样本克隆）。
                </div>
                <label style={labelStyle}>引擎</label>
                <select
                  value={form.ttsEngine}
                  onChange={(e) => setForm({ ...form, ttsEngine: e.target.value as 'openai' | 'gptsovits' })}
                  style={inputStyle}
                >
                  <option value="openai">OpenAI 兼容（/audio/speech，需 Key）</option>
                  <option value="gptsovits">自建 GPT-SoVITS（api_v2，无需 Key）</option>
                </select>
                <label style={labelStyle}>服务地址</label>
                <input
                  value={form.ttsBaseUrl}
                  onChange={(e) => setForm({ ...form, ttsBaseUrl: e.target.value })}
                  placeholder={form.ttsEngine === 'gptsovits' ? 'http://192.168.1.5:9880' : 'https://api.openai.com/v1'}
                  style={inputStyle}
                />
                {form.ttsEngine === 'openai' ? (
                  <>
                    <label style={labelStyle}>模型（留空用 tts-1）</label>
                    <input
                      value={form.ttsModel}
                      onChange={(e) => setForm({ ...form, ttsModel: e.target.value })}
                      placeholder="tts-1 / gpt-4o-mini-tts / CosyVoice-300M-SFT"
                      style={inputStyle}
                    />
                    <label style={labelStyle}>API Key（只存本机，云同步时服务端加密）</label>
                    <input
                      type="password"
                      value={form.ttsApiKey}
                      onChange={(e) => setForm({ ...form, ttsApiKey: e.target.value })}
                      placeholder="sk-..."
                      style={inputStyle}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void testTtsEngine()}
                      style={{ width: '100%', marginTop: '8px', padding: '6px', border: '1px solid #555', borderRadius: '4px', background: '#2a2a2a', color: '#ccc', fontSize: '12px', cursor: 'pointer' }}
                    >
                      连接测试
                    </button>
                    {ttsTesting && (
                      <div style={{ marginTop: 6, fontSize: 11, color: ttsTesting.includes('在线') ? '#6c6' : '#c96' }}>
                        {ttsTesting}
                      </div>
                    )}
                  </>
                )}
                <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
                  提示：点「试听当前音色」会先把上面的服务配置保存到本机，再现场合成。
                </div>
              </>
            )}

            {/* 音色库管理：本机自建音色（local-）；商店音色安装见创作中心音色板块 */}
            <button
              type="button"
              onClick={() => setVoiceMgrOpen((open) => !open)}
              style={{ width: '100%', marginTop: '8px', padding: '6px', border: '1px solid #555', borderRadius: '4px', background: '#2a2a2a', color: '#9ad', fontSize: '12px', cursor: 'pointer' }}
            >
              {voiceMgrOpen ? '收起音色库管理' : `音色库管理（本机已装 ${installedVoices.length} 个）`}
            </button>
            {voiceMgrOpen && (
              <>
                {installedVoices.length === 0 ? (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
                    本机还没有音色：可在创作中心音色板块安装，或在下方手动添加（添加后即成为全局音色）。
                  </div>
                ) : (
                  installedVoices.map((v) => (
                    <div
                      key={v.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#ccc' }}
                    >
                      <span style={{ flex: 1 }}>
                        {v.name}（{engineLabel(v.config.engine)}）
                        {form.cloudVoiceId === v.id ? ' · 当前' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void previewInstalled(v).catch((e) => showNotice(e instanceof Error ? e.message : String(e)))
                        }
                        style={{ padding: '2px 8px', border: '1px solid #555', borderRadius: 3, background: '#333', color: '#ccc', fontSize: 11, cursor: 'pointer' }}
                      >
                        试听
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeLocalVoice(v.id)}
                        style={{ padding: '2px 8px', border: '1px solid #644', borderRadius: 3, background: '#3a2a2a', color: '#d99', fontSize: 11, cursor: 'pointer' }}
                      >
                        删除
                      </button>
                    </div>
                  ))
                )}
                <label style={labelStyle}>手动添加音色</label>
                <input
                  value={voiceForm.name}
                  onChange={(e) => setVoiceForm({ ...voiceForm, name: e.target.value })}
                  placeholder="音色名称（如：温柔客服）"
                  style={inputStyle}
                />
                <select
                  value={voiceForm.engine}
                  onChange={(e) =>
                    setVoiceForm({ ...voiceForm, engine: e.target.value as VoiceConfig['engine'] })
                  }
                  style={inputStyle}
                >
                  <option value="cloud">云 TTS（OpenAI 兼容，需 voiceId）</option>
                  <option value="gptsovits">GPT-SoVITS（参考音频克隆，无需 Key）</option>
                  <option value="system">系统音色（用系统已装语音）</option>
                </select>
                {voiceForm.engine === 'gptsovits' ? (
                  <input
                    value={voiceForm.refAudioPath}
                    onChange={(e) => setVoiceForm({ ...voiceForm, refAudioPath: e.target.value })}
                    placeholder="参考音频路径（3~10 秒干净人声，如 D:\ref\voice.wav）"
                    style={inputStyle}
                  />
                ) : voiceForm.engine === 'system' ? (
                  <select
                    value={voiceForm.voiceId}
                    onChange={(e) => setVoiceForm({ ...voiceForm, voiceId: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="">系统默认音色</option>
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name}（{v.lang}）
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      value={voiceForm.voiceId}
                      onChange={(e) => setVoiceForm({ ...voiceForm, voiceId: e.target.value })}
                      placeholder="voiceId（如 alloy / echo / 克隆音色 id）"
                      style={inputStyle}
                    />
                    <input
                      value={voiceForm.model}
                      onChange={(e) => setVoiceForm({ ...voiceForm, model: e.target.value })}
                      placeholder="模型（留空用云 TTS 配置里的模型）"
                      style={inputStyle}
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void addLocalVoice()}
                  style={{ width: '100%', marginTop: 6, padding: '6px', border: 'none', borderRadius: 4, background: '#3a6ea5', color: '#fff', fontSize: 12, cursor: 'pointer' }}
                >
                  添加并设为全局音色
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <button
          onClick={handleSave}
          style={{
            flex: 1,
            padding: '6px',
            border: 'none',
            borderRadius: '4px',
            background: '#4a9eff',
            color: 'white',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          保存
        </button>
        <button
          onClick={toggleSettings}
          style={{
            flex: 1,
            padding: '6px',
            border: '1px solid #555',
            borderRadius: '4px',
            background: '#333',
            color: '#ccc',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
};

/** 思考过程卡片：流式时自动展开并显示「深度思考中…」；结束后折叠为「已深度思考（用时 X 秒）」 */
const ThinkCard = ({
  reasoning,
  seconds,
  streaming,
}: {
  reasoning: string;
  seconds?: number;
  streaming?: boolean;
}) => {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? !!streaming;
  const title = streaming
    ? '深度思考中…'
    : `已深度思考${typeof seconds === 'number' && seconds > 0 ? `（用时 ${seconds} 秒）` : ''}`;
  return (
    <div className="think-card">
      <div className="think-header" onClick={() => setManual(!expanded)}>
        <span>{title}</span>
        <span className="think-chevron">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && <div className="think-body">{reasoning}</div>}
    </div>
  );
};

/** Trae 式等待指示：无气泡，「正在思考」+ 三个由浅到深的圆点波浪 */
const WaitingThink = () => (
  <div className="wait-wrap">
    <span className="wait-title">正在思考</span>
    <span className="wait-dots">
      <i /><i /><i />
    </span>
  </div>
);

const MessageBubble = ({
  message,
  showThinking,
  onRetry,
}: {
  message: ChatMessage;
  showThinking: boolean;
  onRetry: () => void;
}) => {
  const isUser = message.role === 'user';
  // 思考开关关闭时完全忽略 reasoning：既不显示思考卡，也不让「隐形思考期」误判为有内容
  const reasoning = showThinking ? message.reasoning : undefined;
  const hasReasoning = !!reasoning?.trim();
  const hasContent = !!message.content?.trim();
  const waiting = !!message.pending && !hasReasoning && !hasContent && !message.error;

  if (isUser) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <div
          style={{
            maxWidth: '85%',
            padding: '6px 10px',
            borderRadius: '10px',
            fontSize: '13px',
            lineHeight: '1.4',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            background: '#4a9eff',
            color: 'white',
            borderBottomRightRadius: '2px',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  if (!message.pending && !hasReasoning && !hasContent) return null;

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '6px' }}>
      {waiting ? (
        <WaitingThink />
      ) : (
        <div
          className={`bubble-theirs${message.error ? ' bubble-error' : ''}`}
          onClick={message.error ? onRetry : undefined}
          title={message.error ? '点击重试' : undefined}
          style={{ cursor: message.error ? 'pointer' : 'default' }}
        >
          {hasReasoning && reasoning && (
            <ThinkCard reasoning={reasoning} seconds={message.thinkSeconds} streaming={message.streaming} />
          )}
          {message.error ? (
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
          ) : (
            hasContent && (
              <MarkdownText
                content={message.content + (message.streaming ? ' ▍' : '')}
                className={hasReasoning ? 'md-after-think' : undefined}
              />
            )
          )}
          {message.error && <div className="retry-hint">点此重试</div>}
        </div>
      )}
    </div>
  );
};

const ChatPanel = ({ onClose }: { onClose: () => void }) => {
  const { messages, isLoading, showSettings, sendMessage, retryMessage, clearMessages, clearScreen, toggleSettings, loadConfig, loadHistory, saveConfig, config } = useChatStore();
  const [input, setInput] = useState('');
  const [clearAsk, setClearAsk] = useState(false); // 清空确认条
  const [clearNeverAsk, setClearNeverAsk] = useState(false); // 确认条内的"以后不再询问"
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 清空对话：选了"以后不再询问"则直接清空对话框（后台保留），否则先弹确认 */
  const handleClearClick = () => {
    if (config?.chatClearConfirm === 'never') {
      clearScreen();
      return;
    }
    setClearNeverAsk(false);
    setClearAsk(true);
  };

  /** 只清空对话框显示，后台聊天记录与 LLM 上下文保留；勾选"不再询问"时记忆偏好 */
  const confirmClearScreen = async () => {
    if (clearNeverAsk) await saveConfig({ chatClearConfirm: 'never' });
    setClearAsk(false);
    clearScreen();
  };

  /** 清空对话框 + 后台聊天记录（彻底重置）；勾选"不再询问"时同样记忆偏好 */
  const confirmClearAll = async () => {
    if (clearNeverAsk) await saveConfig({ chatClearConfirm: 'never' });
    setClearAsk(false);
    await clearMessages();
  };

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const text = input.trim();
    setInput('');
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isConfigured = !!config?.llmProfiles?.some((p) => p.apiKey);
  const agent = resolveAgent(config);
  const showThinking = config?.showThinking === true;
  // 空会话开场（DeepSeek 式）：当前生效智能体的欢迎语 + 最多 4 个示例问题（点击即发送）
  const activeProfile =
    config?.llmProfiles?.find((p) => p.id === config.llmActiveProfileId) ??
    config?.llmProfiles?.find((p) => p.enabled !== false);
  const emptyGreeting = activeProfile?.greeting?.trim()
    || (activeProfile ? `和${activeProfile.name}聊点什么吧` : isConfigured ? '说点什么吧～' : '');
  const exampleQuestions = (activeProfile?.exampleQuestions ?? []).slice(0, 4);

  return (
    <div
      style={{
        width: 350,
        height: '100%',
        background: '#1e1e1e',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        overflow: 'hidden',
        borderRight: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: '#252525',
          borderBottom: '1px solid #333',
...({ WebkitAppRegion: 'drag' } as React.CSSProperties),
        }}
      >
        <span style={{ fontSize: '13px', color: '#ddd', fontWeight: 600 }}>
          {showSettings ? '设置' : agent ? `聊天 · ${agent.name}` : '聊天'}
        </span>
        <div style={{ display: 'flex', gap: '4px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!showSettings && (
            <>
              <button
                onClick={handleClearClick}
                title="清空对话"
                style={headerBtnStyle}
              >
                清空
              </button>
              <button
                onClick={toggleSettings}
                title="设置"
                style={headerBtnStyle}
              >
                设置
              </button>
            </>
          )}
          {showSettings && (
            <button onClick={toggleSettings} style={headerBtnStyle}>
              返回
            </button>
          )}
          <button onClick={onClose} title="关闭" style={headerBtnStyle}>
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      {showSettings ? (
        <SettingsPanel />
      ) : (
        <>
          {/* 清空确认条：两种清空语义 + "以后不再询问"记忆偏好 */}
          {clearAsk && (
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #3a3a3a', background: '#2b2b2b', fontSize: '12px', color: '#ddd' }}>
              <div style={{ marginBottom: '6px' }}>确定要清空对话框吗？</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '8px', fontSize: '11px', color: '#aaa', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={clearNeverAsk}
                  onChange={(e) => setClearNeverAsk(e.target.checked)}
                />
                以后不再询问，直接清空对话框（可在设置中更改）
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  onClick={() => void confirmClearScreen()}
                  title="清空对话框显示，助手仍记得之前的对话内容"
                  style={{ flex: 1, padding: '5px', border: '1px solid #4a9eff', borderRadius: '4px', background: '#2b3a4a', color: '#9fd0ff', fontSize: '12px', cursor: 'pointer' }}
                >
                  保留对话记录
                </button>
                <button
                  type="button"
                  onClick={() => void confirmClearAll()}
                  title="清空对话框并删除后台聊天记录（助手不再记得之前内容）"
                  style={{ flex: 1, padding: '5px', border: 'none', borderRadius: '4px', background: '#c05050', color: 'white', fontSize: '12px', cursor: 'pointer' }}
                >
                  清空全部对话记录
                </button>
                <button
                  type="button"
                  onClick={() => setClearAsk(false)}
                  style={{ flex: 1, padding: '5px', border: '1px solid #555', borderRadius: '4px', background: '#333', color: '#ccc', fontSize: '12px', cursor: 'pointer' }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px',
            }}
          >
            {messages.length === 0 && (
              <div style={{ marginTop: '30px', textAlign: 'center' }}>
                <div style={{ color: '#8a8a8a', fontSize: '12px', lineHeight: 1.6 }}>
                  {isConfigured ? emptyGreeting : '请点击「设置」配置 API Key 后开始聊天'}
                </div>
                {isConfigured && exampleQuestions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '14px' }}>
                    {exampleQuestions.map((q) => (
                      <button
                        key={q}
                        type="button"
                        disabled={isLoading}
                        onClick={() => void sendMessage(q)}
                        style={{
                          padding: '6px 10px', border: '1px solid #444', borderRadius: '8px',
                          background: '#2a2a2a', color: '#bbb', fontSize: '12px',
                          textAlign: 'left', cursor: isLoading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                showThinking={showThinking}
                onRetry={() => void retryMessage(msg.id)}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: '8px',
              background: '#252525',
              borderTop: '1px solid #333',
              display: 'flex',
              gap: '6px',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConfigured ? '输入消息...' : '请先配置 API Key'}
              disabled={isLoading || !isConfigured}
              style={{
                flex: 1,
                padding: '6px 10px',
                border: '1px solid #444',
                borderRadius: '6px',
                background: '#1e1e1e',
                color: '#eee',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim() || !isConfigured}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderRadius: '6px',
                background: isLoading || !input.trim() || !isConfigured ? '#333' : '#4a9eff',
                color: isLoading || !input.trim() || !isConfigured ? '#666' : 'white',
                fontSize: '12px',
                cursor: isLoading || !input.trim() || !isConfigured ? 'not-allowed' : 'pointer',
              }}
            >
              发送
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const headerBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '1px solid #444',
  borderRadius: '4px',
  background: '#333',
  color: '#ccc',
  fontSize: '11px',
  cursor: 'pointer',
};

export default ChatPanel;
