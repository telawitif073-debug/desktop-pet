import { useState } from 'react';
import type { AgentCapabilityKind, AgentCapabilitySpec, InstalledVoice, LlmProfile } from '../global.d';
import { capabilityDesc, capabilityLabel, detectCapabilities } from '../renderer/petCapabilities';
import { isPersonaCard, parseConfigText, personaCardToAgent } from '../renderer/agentPort';
import { composeAgentPrompt } from '../shared/agentPrompt';

/**
 * 智能体全字段编辑器（创作中心右栏，T4）：
 * 手机端 ProfileManager 的全部字段 + 能力与规格 + 绑定形象/专属音色 + 单条导入 + 实时预览。
 * 表单状态由父级用 key={profile.id} 强制重建，切换智能体即重新初始化（不做跨档残留）。
 */

const DOMAIN_TAG_PRESETS = ['医疗', '训练', '内容', '陪伴', '电商'];
const ROLE_PRESETS = ['医生', '训练师', '经纪人', '管家', '老师', '朋友'];
const STYLE_PRESETS = ['温柔', '毒舌', '专业', '搞笑', '简短'];
const CAPABILITY_ORDER: AgentCapabilityKind[] = ['proactive', 'tasks', 'web', 'weather', 'stock', 'football'];
const INTERVAL_OPTIONS = [10, 30, 60, 120];

const C = {
  panel: '#252526',
  panelAlt: '#2a2a2c',
  border: '#3a3b3d',
  text: '#d6d7d9',
  sub: '#8b8f96',
  accent: '#4a9eff',
  warn: '#ffd479',
  danger: '#ffbdbd',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  marginBottom: 8,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  background: C.panelAlt,
  color: C.text,
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: C.sub,
  marginBottom: 4,
};

function smallBtn(active = false): React.CSSProperties {
  return {
    padding: '3px 9px',
    border: `1px solid ${active ? C.accent : '#555'}`,
    borderRadius: 4,
    background: active ? 'rgba(74,158,255,.15)' : '#333',
    color: active ? C.accent : '#ccc',
    fontSize: 11,
    cursor: 'pointer',
  };
}

/** chip 选择行：点选切换，已选高亮 */
function ChipRow({
  presets,
  selected,
  onToggle,
}: {
  presets: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {presets.map((preset) => (
        <button key={preset} type="button" onClick={() => onToggle(preset)} style={smallBtn(selected.includes(preset))}>
          {preset}
        </button>
      ))}
    </div>
  );
}

const AgentEditor = ({
  profile,
  petAsset,
  voices,
  onSave,
  onNotify,
}: {
  profile: LlmProfile;
  petAsset: { id?: string; name?: string } | null;
  voices: InstalledVoice[];
  onSave: (patch: Partial<LlmProfile>) => Promise<void>;
  onNotify: (message: string) => void;
}) => {
  const [form, setForm] = useState({
    name: profile.name ?? '',
    avatar: profile.avatar ?? '',
    intro: profile.intro ?? '',
    apiKey: profile.apiKey ?? '',
    baseUrl: profile.baseUrl ?? '',
    model: profile.model ?? '',
    systemPrompt: profile.systemPrompt ?? '',
    greeting: profile.greeting ?? '',
    exampleQuestions: (profile.exampleQuestions ?? []).join('\n'),
  });
  const [tags, setTags] = useState<string[]>(profile.domainTags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [role, setRole] = useState(profile.role ?? '');
  const [style, setStyle] = useState(profile.style ?? '');
  const [bindPetId, setBindPetId] = useState(profile.petAssetId ?? '');
  const [bindVoiceId, setBindVoiceId] = useState(profile.boundVoiceId ?? '');
  const [caps, setCaps] = useState<AgentCapabilityKind[]>(profile.capabilities?.enabled ?? []);
  const [capSpec, setCapSpec] = useState<AgentCapabilitySpec>(profile.capabilities?.spec ?? {});
  const [webSpec, setWebSpec] = useState({
    provider: (profile.capabilities?.spec.web?.provider ?? 'bocha') as 'bocha' | 'serper' | 'tavily',
    apiKey: profile.capabilities?.spec.web?.apiKey ?? '',
    endpoint: profile.capabilities?.spec.web?.endpoint ?? '',
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [capHint, setCapHint] = useState('');

  const toggleCap = (kind: AgentCapabilityKind) =>
    setCaps((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]));
  const toggleTag = (tag: string) =>
    setTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));
  const addTagDraft = () => {
    const value = tagDraft.trim();
    if (!value) return;
    setTags((cur) => (cur.includes(value) ? cur : [...cur, value]));
    setTagDraft('');
  };

  const save = async () => {
    const patch: Partial<LlmProfile> = {
      name: form.name.trim() || profile.name,
      avatar: form.avatar.trim(),
      intro: form.intro.trim(),
      apiKey: form.apiKey,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      systemPrompt: form.systemPrompt,
      greeting: form.greeting.trim(),
      exampleQuestions: form.exampleQuestions
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      domainTags: tags,
      role: role.trim(),
      style: style.trim(),
      petAssetId: bindPetId,
      boundVoiceId: bindVoiceId,
      capabilities:
        caps.length || Object.keys(capSpec).length
          ? {
              enabled: caps,
              spec: {
                ...capSpec,
                ...(caps.includes('web')
                  ? { web: { provider: webSpec.provider, apiKey: webSpec.apiKey.trim(), endpoint: webSpec.endpoint.trim() } }
                  : {}),
                source: capSpec.source ?? 'manual',
              },
            }
          : undefined,
    };
    await onSave(patch);
    onNotify(`已保存「${patch.name}」：配置已落盘并触发云同步`);
  };

  /** 表单内单条导入（口径同手机端）：拒绝多智能体编排、多条配置引导去列表批量导入 */
  const doImport = () => {
    const parsed = parseConfigText(importText);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    const value = parsed.value;
    const s = (x: unknown): string => (x == null ? '' : String(x).trim());
    const toArr = (x: unknown): string[] =>
      Array.isArray(x) ? x.map(String) : typeof x === 'string' ? x.split(/[\n,，]/) : [];
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).profiles)
        ? ((value as Record<string, unknown>).profiles as unknown[])
        : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).llmProfiles)
          ? ((value as Record<string, unknown>).llmProfiles as unknown[])
          : [value];
    const isOrchestration = list.some((item) => {
      const o = item as Record<string, unknown> | null;
      return !!o && typeof o === 'object' && (o.multi_agent || o.multiAgent || o.orchestrator || o.workflow || o.kind === 'multi_agent');
    });
    if (isOrchestration) {
      setImportError('不再支持多智能体编排配置。请粘贴单个智能体的配置（name / baseUrl / model / systemPrompt 等）或人设卡（agent_name / persona）');
      return;
    }
    if (list.length > 1) {
      setImportError(`识别到 ${list.length} 条智能体配置：请改用左侧「批量导入」，本编辑器只能回填一个智能体`);
      return;
    }
    const raw = (list[0] ?? {}) as Record<string, unknown>;
    const card = isPersonaCard(raw) ? personaCardToAgent(raw) : null;
    const name = s(raw.name) || card?.name || '';
    const systemPrompt = s(raw.systemPrompt ?? raw.system_prompt ?? raw.prompt ?? raw.system) || card?.systemPrompt || '';
    const nextRole = s(raw.role) || card?.role || '';
    const nextStyle = s(raw.style) || card?.style || '';
    const greeting = s(raw.greeting) || card?.greeting || '';
    const nextTags = [...new Set(toArr(raw.domainTags ?? raw.tags).map((t) => t.trim()).filter(Boolean))];
    const questions =
      toArr(raw.exampleQuestions ?? raw.questions).map((t) => t.trim()).filter(Boolean).join('\n') ||
      (card?.exampleQuestions ?? []).join('\n');
    const apiKey = s(raw.apiKey ?? raw.api_key);
    const baseUrl = s(raw.baseUrl ?? raw.base_url);
    const model = s(raw.model);
    if (![name, systemPrompt, nextRole, nextStyle, greeting, questions, apiKey, baseUrl, model].some((x) => x.length > 0)) {
      setImportError('未能识别配置字段：请粘贴智能体配置（name / baseUrl / model / systemPrompt 等），或人设卡（agent_name / persona）');
      return;
    }
    setForm((prev) => ({
      ...prev,
      name,
      avatar: s(raw.avatar),
      intro: s(raw.intro),
      apiKey,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      model,
      systemPrompt,
      greeting,
      exampleQuestions: questions,
    }));
    setTags(nextTags);
    setRole(nextRole);
    setStyle(nextStyle);
    const detection = detectCapabilities(raw);
    if (detection.kinds.length) {
      setCaps(detection.kinds);
      setCapSpec(detection.spec);
      setCapHint(
        `检测到该智能体声明了这些能力${detection.reasons.length ? `（${detection.reasons.join('；')}）` : ''}，已为你勾选，可在此调整`,
      );
    }
    setImportOpen(false);
    setImportText('');
    setImportError('');
    onNotify(`已导入「${name || '未命名'}」到表单，检查确认后保存即可`);
  };

  const preview = composeAgentPrompt({
    systemPrompt: form.systemPrompt,
    role,
    style,
  });
  const questions = form.exampleQuestions
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{form.name.trim() || '(未命名)'}</div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setImportOpen((open) => !open)} style={smallBtn(importOpen)}>
          从文本导入
        </button>
        <button
          type="button"
          onClick={() => void save()}
          style={{ ...smallBtn(), padding: '4px 14px', background: C.accent, borderColor: C.accent, color: '#fff' }}
        >
          保存
        </button>
      </div>

      {importOpen && (
        <div style={{ padding: 10, marginBottom: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
          <label style={labelStyle}>
            粘贴单个智能体的 JSON / YAML（兼容数组与 profiles / llmProfiles 形状、支持人设卡 agent_name / persona、可带代码块包裹）
          </label>
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            rows={5}
            placeholder='{"name":"医疗助手","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}'
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={doImport} style={smallBtn(true)}>
              解析并回填
            </button>
            <span style={{ fontSize: 11, color: C.danger }}>{importError}</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 3 }}>
          <label style={labelStyle}>智能体名称</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：医疗助手" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>头像（emoji/字）</label>
          <input value={form.avatar} onChange={(e) => setForm({ ...form, avatar: e.target.value })} placeholder="🐱" style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>简介</label>
      <textarea
        value={form.intro}
        onChange={(e) => setForm({ ...form, intro: e.target.value })}
        rows={2}
        placeholder="一句话说明它是谁、能帮上什么忙"
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      <label style={labelStyle}>领域标签（点选或自填，回车添加）</label>
      <ChipRow presets={DOMAIN_TAG_PRESETS} selected={tags} onToggle={toggleTag} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTagDraft();
          }}
          placeholder="自定义标签"
          style={{ ...inputStyle, marginBottom: 0 }}
        />
        <button type="button" onClick={addTagDraft} style={smallBtn()}>
          添加
        </button>
      </div>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {tags.map((tag) => (
            <button key={tag} type="button" onClick={() => toggleTag(tag)} title="点击移除" style={smallBtn(true)}>
              {tag} ✕
            </button>
          ))}
        </div>
      )}

      <label style={labelStyle}>角色（提升为拟人身份）</label>
      <ChipRow presets={ROLE_PRESETS} selected={role ? [role] : []} onToggle={(value) => setRole(role === value ? '' : value)} />
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="角色（可自填，如：营养顾问）" style={inputStyle} />

      <label style={labelStyle}>风格（约束说话口吻）</label>
      <ChipRow presets={STYLE_PRESETS} selected={style ? [style] : []} onToggle={(value) => setStyle(style === value ? '' : value)} />
      <input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="风格（可自填）" style={inputStyle} />

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>API Key（导出不含，导入需补全）</label>
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>模型</label>
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" style={inputStyle} />
        </div>
      </div>
      <label style={labelStyle}>Base URL</label>
      <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" style={inputStyle} />

      <label style={labelStyle}>系统提示词（人设主体；角色/风格会按下方预览追加）</label>
      <textarea
        value={form.systemPrompt}
        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        rows={6}
        placeholder="你是……"
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      <label style={labelStyle}>欢迎语（切换/新会话时展示）</label>
      <input value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="你好呀，我是你的医疗助手～" style={inputStyle} />

      <label style={labelStyle}>示例问题（每行一条，最多展示 4 条）</label>
      <textarea
        value={form.exampleQuestions}
        onChange={(e) => setForm({ ...form, exampleQuestions: e.target.value })}
        rows={4}
        placeholder={'头疼该挂什么科？\n感冒和过敏怎么区分？'}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>绑定宠物形象</label>
          <select value={bindPetId} onChange={(e) => setBindPetId(e.target.value)} style={inputStyle}>
            <option value="">跟随本机当前形象{petAsset?.name ? `（${petAsset.name}）` : ''}</option>
            {petAsset?.id && <option value={petAsset.id}>{petAsset.name || petAsset.id}（本机已安装）</option>}
            {bindPetId && bindPetId !== petAsset?.id && (
              <option value={bindPetId}>{bindPetId}（不在本机，切到该形象需先安装）</option>
            )}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>朗读音色</label>
          <select value={bindVoiceId} onChange={(e) => setBindVoiceId(e.target.value)} style={inputStyle}>
            <option value="">跟随全局音色</option>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}（{voice.config.engine === 'gptsovits' ? 'GPT-SoVITS' : voice.config.engine === 'system' ? '系统' : '云 TTS'}）
              </option>
            ))}
          </select>
        </div>
      </div>

      <label style={labelStyle}>智能体能力（勾选后该档案才注入对应协议/调度）</label>
      {capHint && <div style={{ fontSize: 11, color: C.warn, marginBottom: 6, lineHeight: 1.6 }}>{capHint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {CAPABILITY_ORDER.map((kind) => (
          <label key={kind} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={caps.includes(kind)} onChange={() => toggleCap(kind)} style={{ marginTop: 2 }} />
            <span>
              {capabilityLabel(kind)}
              <span style={{ color: C.sub, fontSize: 11, display: 'block', lineHeight: 1.6 }}>{capabilityDesc(kind)}</span>
            </span>
          </label>
        ))}
      </div>

      {(caps.includes('proactive') || caps.includes('tasks')) && (
        <div style={{ padding: 8, marginBottom: 8, border: `1px solid ${C.border}`, borderRadius: 4, background: C.panel, fontSize: 11, color: C.sub, lineHeight: 1.8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>搭话间隔</span>
            <button
              type="button"
              onClick={() => {
                const cur = capSpec.intervalMinutes ?? 30;
                const idx = INTERVAL_OPTIONS.indexOf(cur);
                setCapSpec((prev) => ({ ...prev, intervalMinutes: INTERVAL_OPTIONS[(idx + 1) % INTERVAL_OPTIONS.length] }));
              }}
              style={smallBtn()}
            >
              每 {capSpec.intervalMinutes ?? 30} 分钟（点击切换）
            </button>
          </div>
          {capSpec.wakingHours && (
            <div>搭话时段（该智能体 JSON 声明）：{capSpec.wakingHours[0]}:00–{capSpec.wakingHours[1]}:00</div>
          )}
          {capSpec.maxActiveTasksPerDay ? <div>每日任务上限（JSON 声明）：{capSpec.maxActiveTasksPerDay} 个</div> : null}
          {capSpec.exampleTasks?.length ? <div>沿用场景表达：{capSpec.exampleTasks.slice(0, 3).join('、')}</div> : null}
        </div>
      )}

      {caps.includes('web') && (
        <div style={{ padding: 8, marginBottom: 8, border: `1px solid ${C.border}`, borderRadius: 4, background: C.panel }}>
          <label style={labelStyle}>联网搜索服务（用户自配 Key）</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select
              value={webSpec.provider}
              onChange={(e) => setWebSpec({ ...webSpec, provider: e.target.value as typeof webSpec.provider })}
              style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
            >
              <option value="bocha">博查 Bocha</option>
              <option value="serper">Serper</option>
              <option value="tavily">Tavily</option>
            </select>
            <input
              type="password"
              value={webSpec.apiKey}
              onChange={(e) => setWebSpec({ ...webSpec, apiKey: e.target.value })}
              placeholder="搜索服务 API Key"
              style={{ ...inputStyle, marginBottom: 0, flex: 2 }}
            />
          </div>
          <input
            value={webSpec.endpoint}
            onChange={(e) => setWebSpec({ ...webSpec, endpoint: e.target.value })}
            placeholder="自定义接口地址（留空用提供商默认）"
            style={{ ...inputStyle, marginBottom: 0 }}
          />
        </div>
      )}

      {/* 实时预览：与运行时注入一致（src/shared/agentPrompt.ts） */}
      <div style={{ marginTop: 4, padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>
          预览：实际生效的人设（系统提示词 + 角色 + 风格），随字段实时变化
        </div>
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: C.panelAlt,
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.7,
            color: C.text,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {preview || '(未填写系统提示词：将沿用默认宠物人格)'}
        </pre>
        {form.greeting.trim() && (
          <div style={{ marginTop: 8, padding: 8, background: C.panelAlt, borderRadius: 4, fontSize: 11 }}>
            欢迎语卡片：{form.greeting.trim()}
          </div>
        )}
        {questions.length > 0 && (
          <div style={{ marginTop: 6, padding: 8, background: C.panelAlt, borderRadius: 4, fontSize: 11, lineHeight: 1.8 }}>
            示例问题（展示前 4 条）：
            {questions.slice(0, 4).map((question) => (
              <div key={question}>· {question}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentEditor;