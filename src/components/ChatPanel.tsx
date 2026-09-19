import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { TONE_PRESETS, EDGE_VOICES, listVoices, speak } from '../renderer/speech';
import { isMicAmbientActive, startManualVoice, stopManualVoice, syncAmbientSenses } from '../renderer/ambientSense';
import { recordScreenFrames } from '../renderer/senseIntent';
import type { SpeechSettings, LlmProfile, VoiceAsrApiConfig } from '../main/config';

// 从 config.installedAgentConfig 中解析当前生效的智能体信息
function resolveAgent(config: { installedAgentConfig?: unknown } | null) {
  const cfg = config?.installedAgentConfig;
  if (!cfg || typeof cfg !== 'object') return null;
  const fields = cfg as { name?: unknown; systemPrompt?: unknown; asr?: unknown };
  return {
    name: typeof fields.name === 'string' && fields.name ? fields.name : '自定义智能体',
    systemPrompt: typeof fields.systemPrompt === 'string' ? fields.systemPrompt : '',
    isCustom: fields.name === '自定义智能体',
    // 智能体自带语音识别（上传者可选配置）：存在时设置面板可选「智能体自带」
    asr:
      fields.asr && typeof fields.asr === 'object'
        ? (fields.asr as VoiceAsrApiConfig)
        : null,
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
    petName: config?.petName || '小宠',
    voiceWakeMode: (config?.voiceWakeMode || 'once') as 'once' | 'continuous',
    voiceModelSource: config?.voiceModelSource || '',
    // 识别来源三选：local=本地模型包（默认） api=在线接口 agent=智能体自带
    voiceAsrSource: (config?.voiceAsr?.source || 'local') as 'local' | 'api' | 'agent',
    voiceAsrMode: (config?.voiceAsr?.api?.mode || 'transcribe') as 'transcribe' | 'chat',
    voiceAsrBaseUrl: config?.voiceAsr?.api?.baseUrl || '',
    voiceAsrApiKey: config?.voiceAsr?.api?.apiKey || '',
    voiceAsrModel: config?.voiceAsr?.api?.model || '',
    voiceAsrLanguage: config?.voiceAsr?.api?.language || 'zh',
    agentAsrKey: config?.voiceAsr?.agentApiKey || '',
    proactiveEnabled: config?.agentProactive?.enabled ?? true,
    proactiveInterval: config?.agentProactive?.intervalMinutes ?? 30,
    speechEnabled: config?.speech?.enabled ?? true,
    clearAsk: config?.chatClearConfirm !== 'never',
    voice: config?.speech?.voice || (config?.speech?.voiceURI ? `sys:${config.speech.voiceURI}` : ''),
    tone: (config?.speech?.tone || 'natural') as SpeechSettings['tone'],
    speechRate: config?.speech?.rate ?? 1,
    speechPitch: config?.speech?.pitch ?? 1,
    speechVolume: config?.speech?.volume ?? 1,
  });

  // 当前智能体信息（含是否自带语音识别），「智能体自带」选项据此显隐
  const agentInfo = resolveAgent(config);
  const agentAsr = agentInfo?.asr || null;
  const asrSourceOptions: Array<{ value: 'local' | 'api' | 'agent'; label: string; disabled?: boolean }> = [
    { value: 'local', label: '本地语音模型（离线可用）' },
    { value: 'api', label: '在线识别接口（自己填地址）' },
    { value: 'agent', label: '智能体自带', disabled: !agentAsr },
  ];

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

  // 语音唤醒模型包导入：平台不内置模型，用户填本地 zip 路径或下载 URL 后手动导入
  const [importingVoice, setImportingVoice] = useState(false);
  const importVoiceModel = async () => {
    const src = form.voiceModelSource.trim();
    if (!src) {
      showNotice('请先填写模型包的本地路径或下载 URL');
      return;
    }
    setImportingVoice(true);
    showNotice('正在导入语音识别模型，请稍候…');
    try {
      const res = await window.electronAPI?.sherpa?.importModel(src);
      if (res?.ok) {
        showNotice('语音识别模型导入成功，语音唤醒已可用');
        // 持续聆听若已开启，重新同步使识别链路立即生效
        void syncAmbientSenses(useChatStore.getState().config?.petSenses);
      } else {
        showNotice(`模型导入失败：${res?.error || '未知错误'}`);
      }
    } catch (e) {
      showNotice(`模型导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportingVoice(false);
    }
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
      // 宠物名字（语音唤醒词，与商店设置共用同一配置）
      petName: form.petName.trim().slice(0, 12) || '小宠',
      // 唤醒后对话模式：once=每次对话后需重新叫名字；continuous=连续对话（约30秒无说话自动结束）
      voiceWakeMode: form.voiceWakeMode,
      // 语音唤醒模型包来源（仅保存配置，导入动作由「导入模型包」按钮执行）
      voiceModelSource: form.voiceModelSource.trim(),
      // 识别来源：本地模型包 / 在线接口 / 智能体自带（api/agent 配置见 VoiceAsrConfig）
      voiceAsr: {
        source: form.voiceAsrSource,
        ...(form.voiceAsrSource === 'api'
          ? {
              api: {
                mode: form.voiceAsrMode,
                baseUrl: form.voiceAsrBaseUrl.trim(),
                apiKey: form.voiceAsrApiKey.trim(),
                model: form.voiceAsrModel.trim(),
                language: form.voiceAsrLanguage.trim() || undefined,
              },
            }
          : {}),
        ...(form.voiceAsrSource === 'agent' ? { agentApiKey: form.agentAsrKey.trim() || undefined } : {}),
      },
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
      // 宠物语音朗读配置（回复/问候/主动消息统一走 speech.ts）
      speech: {
        enabled: form.speechEnabled,
        voice: form.voice || undefined,
        tone: form.tone,
        rate: Number(form.speechRate) || 1,
        pitch: Number(form.speechPitch) || 1,
        volume: Number(form.speechVolume) || 1,
      },
      // 清空对话前是否询问（"以后不再询问"后可在此重新开启）
      chatClearConfirm: form.clearAsk ? 'ask' : 'never',
    });
    // 本地档案列表同步（改名/改配置后下拉立即显示新内容，无需重开面板）
    setProfiles(profilesPayload);
    // 识别来源可能变化：同步感知链（持续聆听开着时立即切换识别引擎）
    void syncAmbientSenses(useChatStore.getState().config?.petSenses);
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
              {agent ? `${agent.name}（已生效）` : '默认宠物人格（未启用智能体）'}
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

      {/* 宠物名字（语音唤醒词）：与商店设置 → 宠物信息共用同一配置 */}
      <label style={{ ...labelStyle, marginTop: '12px' }}>宠物名字（语音唤醒词）</label>
      <input
        value={form.petName}
        onChange={(e) => setForm({ ...form, petName: e.target.value })}
        maxLength={12}
        placeholder="小宠"
        style={inputStyle}
      />
      <div style={{ fontSize: '10px', color: '#777', marginTop: '2px' }}>
        开启持续聆听语音后，叫这个名字宠物会回应并聆听需求（建议 2 字以上）
      </div>
      {/* 唤醒后对话模式：连续对话=叫一次名字后可持续说，超时自动结束；默认每次对话后需重新叫名字 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer', marginTop: 6 }}>
        <input
          type="checkbox"
          checked={form.voiceWakeMode === 'continuous'}
          onChange={(e) => setForm({ ...form, voiceWakeMode: e.target.checked ? 'continuous' : 'once' })}
        />
        唤醒后连续对话（叫一次名字可持续说）
      </label>
      <div style={{ fontSize: '10px', color: '#777', marginTop: '2px' }}>
        {form.voiceWakeMode === 'continuous'
          ? '叫一次名字后可持续对话，停止说话约 30 秒自动结束'
          : '每次对话后需重新叫名字才会继续聆听'}
      </div>

      {/* 识别来源三选：本地模型包（离线）/ 在线接口 / 智能体自带（平台不内置资源，全部由用户/上传者提供） */}
      <div style={{ marginTop: '8px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'block', fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>
          宠物怎么听懂你说话（语音识别方式）
        </label>
        {asrSourceOptions.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd',
              cursor: opt.disabled ? 'not-allowed' : 'pointer', marginTop: 4, opacity: opt.disabled ? 0.5 : 1,
            }}
          >
            <input
              type="radio"
              name="voiceAsrSource"
              checked={form.voiceAsrSource === opt.value}
              disabled={opt.disabled}
              onChange={() => setForm({ ...form, voiceAsrSource: opt.value })}
            />
            {opt.label}
          </label>
        ))}

        {/* 本地语音模型：导入 zip 模型包后离线识别 */}
        {form.voiceAsrSource === 'local' && (
          <>
            <label style={{ ...labelStyle, marginTop: '8px' }}>语音模型包（本地 zip 路径或下载 URL）</label>
            <input
              type="text"
              value={form.voiceModelSource}
              onChange={(e) => setForm({ ...form, voiceModelSource: e.target.value })}
              placeholder="D:\models\sherpa-onnx-wasm-asr-1pass.zip 或 https://..."
              style={inputStyle}
            />
            <div style={{ fontSize: '10px', color: '#777', marginTop: '4px', lineHeight: 1.5 }}>
              中文识别模型包（zip 约 243MB），下载一次后不用联网也能识别。
              可从 hf-mirror.com/anyshu/sherpa-onnx-wasm-main-asr.data 下载 sherpa-onnx-wasm-asr-1pass.zip。
              未导入时语音唤醒与麦克风识别不生效。
            </div>
            <button
              type="button"
              onClick={importVoiceModel}
              disabled={importingVoice}
              style={{
                width: '100%', padding: '6px', marginTop: '6px', borderRadius: '4px', fontSize: '12px',
                cursor: importingVoice ? 'wait' : 'pointer',
                border: '1px solid #555', background: importingVoice ? '#333' : '#4a9eff', color: 'white',
              }}
            >
              {importingVoice ? '导入中…' : '导入模型包'}
            </button>
          </>
        )}

        {/* 在线识别接口：转写接口或支持听音频的聊天模型，配置与 Key 存主进程 */}
        {form.voiceAsrSource === 'api' && (
          <>
            <label style={labelStyle}>接口类型</label>
            <select
              value={form.voiceAsrMode}
              onChange={(e) => setForm({ ...form, voiceAsrMode: e.target.value as 'transcribe' | 'chat' })}
              style={inputStyle}
            >
              <option value="transcribe">语音转写接口（如 whisper-1）</option>
              <option value="chat">能听音频的聊天模型（如 gpt-4o-audio）</option>
            </select>
            <label style={labelStyle}>接口地址</label>
            <input
              type="text"
              value={form.voiceAsrBaseUrl}
              onChange={(e) => setForm({ ...form, voiceAsrBaseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              style={inputStyle}
            />
            <label style={labelStyle}>API Key</label>
            <input
              type="password"
              value={form.voiceAsrApiKey}
              onChange={(e) => setForm({ ...form, voiceAsrApiKey: e.target.value })}
              placeholder="sk-..."
              style={inputStyle}
            />
            <label style={labelStyle}>模型名</label>
            <input
              type="text"
              value={form.voiceAsrModel}
              onChange={(e) => setForm({ ...form, voiceAsrModel: e.target.value })}
              placeholder={form.voiceAsrMode === 'chat' ? 'gpt-4o-audio' : 'whisper-1'}
              style={inputStyle}
            />
            {form.voiceAsrMode === 'transcribe' && (
              <>
                <label style={labelStyle}>语言（可选，默认中文）</label>
                <input
                  type="text"
                  value={form.voiceAsrLanguage}
                  onChange={(e) => setForm({ ...form, voiceAsrLanguage: e.target.value })}
                  placeholder="zh"
                  style={inputStyle}
                />
              </>
            )}
            <div style={{ fontSize: '10px', color: '#777', marginTop: '4px', lineHeight: 1.5 }}>
              填一个支持语音识别的接口地址，不用下载模型包，但要联网。填好后点下方「保存」生效。
            </div>
          </>
        )}

        {/* 智能体自带：已安装智能体携带识别配置时可选，Key 可替换 */}
        {form.voiceAsrSource === 'agent' && agentAsr && (
          <>
            <div style={{ fontSize: '10px', color: '#777', marginTop: '6px', lineHeight: 1.5 }}>
              当前智能体「{agentInfo?.name}」自带听懂说话的能力，选它就不用任何额外配置
              （方式：{agentAsr.mode === 'chat' ? '聊天模型' : '转写接口'} · 模型：{agentAsr.model} · 地址：{agentAsr.baseUrl}）。
            </div>
            <label style={{ ...labelStyle, marginTop: '8px' }}>替换成自己的 Key（可选）</label>
            <input
              type="password"
              value={form.agentAsrKey}
              onChange={(e) => setForm({ ...form, agentAsrKey: e.target.value })}
              placeholder="智能体自带的密钥不可用时再填"
              style={inputStyle}
            />
            <div style={{ fontSize: '10px', color: '#777', marginTop: '2px' }}>
              智能体自带的密钥用完或不可用时，可填自己的，点「保存」生效。
            </div>
          </>
        )}
        {form.voiceAsrSource === 'agent' && !agentAsr && (
          <div style={{ fontSize: '10px', color: '#777', marginTop: '6px', lineHeight: 1.5 }}>
            当前智能体没有自带语音识别。可以先在商店安装一个自带的智能体，或改用上面两种方式。
          </div>
        )}
      </div>

      {/* 智能体主动发起对话：定时气泡（状态低值提醒），仅唤醒时段 8-22 点 */}
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.proactiveEnabled}
            onChange={(e) => setForm({ ...form, proactiveEnabled: e.target.checked })}
          />
          允许宠物主动发起对话（气泡消息）
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

      {/* 宠物语音：回复/问候/主动消息朗读（系统免费 TTS，离线可用），音色/语气/声线/语速可调 */}
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.speechEnabled}
            onChange={(e) => setForm({ ...form, speechEnabled: e.target.checked })}
          />
          宠物语音朗读（回复与主动消息）
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
            <label style={labelStyle}>音色（Edge 神经音色免费在线更自然，系统声音离线兜底）</label>
            <select
              value={form.voice}
              onChange={(e) => setForm({ ...form, voice: e.target.value })}
              style={inputStyle}
            >
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
              onClick={() => speak('你好呀，我是你的桌面宠物，很高兴见到你！', {
                enabled: true,
                voice: form.voice || undefined,
                tone: form.tone,
                rate: Number(form.speechRate) || 1,
                pitch: Number(form.speechPitch) || 1,
                volume: Number(form.speechVolume) || 1,
              })}
              style={{ width: '100%', marginTop: '8px', padding: '6px', border: '1px solid #555', borderRadius: '4px', background: '#333', color: '#ccc', fontSize: '12px', cursor: 'pointer' }}
            >
              试听
            </button>
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

const MessageBubble = ({ message }: { message: { role: string; content: string; streaming?: boolean } }) => {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '6px',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '6px 10px',
          borderRadius: '10px',
          fontSize: '13px',
          lineHeight: '1.4',
          wordBreak: 'break-word',
          background: isUser ? '#4a9eff' : '#3a3a3a',
          color: isUser ? 'white' : '#eee',
          borderBottomRightRadius: isUser ? '2px' : '10px',
          borderBottomLeftRadius: isUser ? '10px' : '2px',
        }}
      >
        {message.content || (message.streaming ? '...' : '')}
        {message.streaming && message.content && (
          <span style={{ opacity: 0.5 }}>▎</span>
        )}
      </div>
    </div>
  );
};

const ChatPanel = ({ onClose }: { onClose: () => void }) => {
  const { messages, isLoading, showSettings, sendMessage, clearMessages, clearScreen, toggleSettings, loadConfig, loadHistory, saveConfig, config } = useChatStore();
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

  // ---- 感知能力（商店设置开启后显示对应按钮；截图/拍照随消息发给聊天模型）----
  const senses = config?.petSenses;
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [senseNotice, setSenseNotice] = useState('');

  const addImage = (dataUrl: string) => {
    setPendingImages((cur) => (cur.length >= 4 ? cur : [...cur, dataUrl]));
    setSenseNotice('');
  };

  /** 查看桌面：主进程 desktopCapturer 截屏（需「查看桌面」开关） */
  const handleCaptureScreen = async () => {
    try {
      const res = await window.electronAPI?.sense?.captureScreen();
      if (res?.success && res.dataUrl) addImage(res.dataUrl);
      else setSenseNotice(res?.error || '截屏失败');
    } catch {
      setSenseNotice('截屏失败');
    }
  };

  /** 录屏抽帧：录约 5 秒抽 4 帧，让宠物看到屏幕上「发生的过程」 */
  const [recording, setRecording] = useState(false);
  const handleRecordScreen = async () => {
    setRecording(true);
    try {
      const frames = await recordScreenFrames();
      frames.forEach((f) => addImage(f));
      if (!frames.length) setSenseNotice('录屏失败');
    } catch {
      setSenseNotice('录屏被取消或不支持');
    } finally {
      setRecording(false);
    }
  };

  /** 摄像头拍照：getUserMedia 抓一帧后立即释放设备（需「摄像头」开关） */
  const handleCameraSnap = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setSenseNotice('当前环境不支持摄像头');
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 350)); // 等待曝光稳定
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      addImage(canvas.toDataURL('image/jpeg', 0.8));
    } catch {
      setSenseNotice('摄像头不可用或未授权');
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  };

  /** 麦克风语音输入：vosk 本地识别，识别文本追加进输入框（需「麦克风」开关） */
  const toggleMic = () => {
    if (listening) {
      stopManualVoice();
      setListening(false);
      return;
    }
    void startManualVoice((text) => {
      setInput((cur) => (cur ? `${cur} ${text}` : text));
    }).then((ok) => {
        if (ok) setListening(true);
        else {
          const source = useChatStore.getState().config?.voiceAsr?.source || 'local';
          setSenseNotice(
            source === 'local'
              ? '语音识别模型未导入，请在设置中「宠物怎么听懂你说话」处导入模型包或改用其他方式'
              : '语音识别没有启动成功，请检查设置中「宠物怎么听懂你说话」的配置'
          );
        }
      });
  };

  // 面板卸载时停止手动语音监听，释放麦克风
  useEffect(() => () => {
    stopManualVoice();
  }, []);

  const handleSend = async () => {
    if ((!input.trim() && !pendingImages.length) || isLoading) return;
    const text = input.trim() || '（看图说话）';
    const images = pendingImages;
    setInput('');
    setPendingImages([]);
    await sendMessage(text, images);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isConfigured = !!config?.llmProfiles?.some((p) => p.apiKey);
  const agent = resolveAgent(config);

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
                  title="清空对话框显示，宠物仍记得之前的对话内容"
                  style={{ flex: 1, padding: '5px', border: '1px solid #4a9eff', borderRadius: '4px', background: '#2b3a4a', color: '#9fd0ff', fontSize: '12px', cursor: 'pointer' }}
                >
                  保留对话记录
                </button>
                <button
                  type="button"
                  onClick={() => void confirmClearAll()}
                  title="清空对话框并删除后台聊天记录（宠物不再记得之前内容）"
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
              <div
                style={{
                  textAlign: 'center',
                  color: '#666',
                  fontSize: '12px',
                  marginTop: '40px',
                }}
              >
                {isConfigured
                  ? '和宠物说点什么吧～'
                  : '请点击「设置」配置 API Key 后开始聊天'}
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          {senseNotice && (
            <div style={{ padding: '4px 10px', background: '#4a2b2b', color: '#ff9f9f', fontSize: '11px' }}>{senseNotice}</div>
          )}
          {pendingImages.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', padding: '6px 8px 0', flexWrap: 'wrap' }}>
              {pendingImages.map((img, idx) => (
                <div key={`${idx}-${img.slice(-20)}`} style={{ position: 'relative' }}>
                  <img src={img} alt={`附件${idx + 1}`} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: '4px', border: '1px solid #555' }} />
                  <button
                    onClick={() => setPendingImages((cur) => cur.filter((_, i) => i !== idx))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: '#c05050', color: 'white', fontSize: '10px', lineHeight: '16px', cursor: 'pointer', padding: 0 }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            style={{
              padding: '8px',
              background: '#252525',
              borderTop: '1px solid #333',
              display: 'flex',
              gap: '6px',
            }}
          >
            {senses?.mic && !isMicAmbientActive() && (
              <button
                onClick={toggleMic}
                title={listening ? '停止语音输入' : '语音输入（说话转文字）'}
                style={{
                  padding: '6px 8px', border: '1px solid #444', borderRadius: '6px', fontSize: '13px', cursor: 'pointer',
                  background: listening ? '#c05050' : '#333', color: listening ? 'white' : '#ccc',
                }}
              >
                🎙️
              </button>
            )}
            {senses?.screen && (
              <button onClick={() => void handleCaptureScreen()} title="查看桌面（截取屏幕发给宠物）" style={{ padding: '6px 8px', border: '1px solid #444', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', background: '#333', color: '#ccc' }}>
                🖥️
              </button>
            )}
            {senses?.screen && (
              <button
                onClick={() => void handleRecordScreen()}
                disabled={recording}
                title={recording ? '正在录屏约 5 秒...' : '录屏 5 秒（抽 4 帧发给宠物，可看到过程）'}
                style={{
                  padding: '6px 8px', border: '1px solid #444', borderRadius: '6px', fontSize: '13px',
                  cursor: recording ? 'wait' : 'pointer', background: recording ? '#c05050' : '#333',
                  color: recording ? 'white' : '#ccc', opacity: recording ? 0.8 : 1,
                }}
              >
                🎬
              </button>
            )}
            {senses?.camera && (
              <button onClick={() => void handleCameraSnap()} title="摄像头拍照发给宠物" style={{ padding: '6px 8px', border: '1px solid #444', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', background: '#333', color: '#ccc' }}>
                📷
              </button>
            )}
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
              disabled={isLoading || (!input.trim() && !pendingImages.length) || !isConfigured}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderRadius: '6px',
                background: isLoading || (!input.trim() && !pendingImages.length) || !isConfigured ? '#333' : '#4a9eff',
                color: isLoading || (!input.trim() && !pendingImages.length) || !isConfigured ? '#666' : 'white',
                fontSize: '12px',
                cursor: isLoading || (!input.trim() && !pendingImages.length) || !isConfigured ? 'not-allowed' : 'pointer',
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
