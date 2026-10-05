import { useState } from 'react';
import { C, inputStyle, labelStyle, smallBtn } from '../studioTheme';
import { ChoiceRow, FileField, PublishLayout, usePublish } from './common';
import type { LlmProfile, PublishFilePayload, PublishPayload } from '../../global.d';

/**
 * 「发布智能体」：智能体发布（原通用发布表单的智能体部分）。
 * - 结构化配置：自动生成配置 JSON 作为资源文件，可用本机智能体预填（不含 API Key）
 * - 上传 JSON：直接提交现成配置文件
 * 音色的发布在「发布音色」页。
 */
interface AgentConfig {
  name: string;
  systemPrompt: string;
  temperature: number;
  model?: string;
  baseUrl?: string;
}

const AgentPublishForm = ({
  profiles,
  onNotify,
}: {
  profiles: LlmProfile[];
  onNotify: (text: string) => void;
}) => {
  const pub = usePublish();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [configMode, setConfigMode] = useState<'structured' | 'raw'>('structured');
  const [agentName, setAgentName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState('0.8');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [dependencies, setDependencies] = useState('');
  const [file, setFile] = useState<PublishFilePayload | null>(null);
  const [rawConfig, setRawConfig] = useState<Record<string, unknown> | null>(null);
  const [rawError, setRawError] = useState('');

  const structuredConfig = (): AgentConfig => ({
    name: agentName.trim() || name.trim(),
    systemPrompt: systemPrompt.trim(),
    temperature: Number(temperature) || 0,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  });

  const prefillFromProfile = (profile: LlmProfile) => {
    setAgentName(profile.name);
    setSystemPrompt(profile.systemPrompt ?? '');
    setModel(profile.model ?? '');
    setBaseUrl(profile.baseUrl ?? '');
    if (!name.trim()) setName(profile.name);
    onNotify(`已用「${profile.name}」预填（不含 API Key，发布后由安装者配置自己的 Key）`);
  };

  const handleRawFile = async (picked: PublishFilePayload | null) => {
    setFile(picked);
    setRawConfig(null);
    setRawError('');
    if (!picked) return;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(picked.bytes)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setRawError('JSON 顶层必须是一个对象（例如 {"systemPrompt":"..."}）');
        return;
      }
      setRawConfig(parsed as Record<string, unknown>);
    } catch {
      setRawError('文件不是合法 JSON，请检查格式');
    }
  };

  const submit = async () => {
    const fail = (text: string) => pub.setResult({ ok: false, text });
    if (!name.trim()) return fail('请填写资源名称');
    const depList = dependencies.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    let payload: PublishPayload;
    if (configMode === 'structured') {
      const config = structuredConfig();
      if (!config.systemPrompt && !config.model && !config.baseUrl) {
        return fail('请至少填写系统提示词 / 模型 / 接口地址中的一项，否则智能体不会有实际效果');
      }
      const fileName = `${String(config.name || 'agent').replace(/[\\/:*?"<>|]/g, '_')}.agent.json`;
      payload = {
        type: 'agent',
        fields: {
          name: name.trim(),
          description: description.trim(),
          configSchema: JSON.stringify(config),
          dependencies: JSON.stringify(depList),
        },
        file: {
          name: fileName,
          type: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(config, null, 2)),
        },
      };
    } else {
      if (!file) return fail('请先选择智能体配置 JSON 文件');
      if (rawError || !rawConfig) return fail('配置文件不是合法 JSON，无法提交');
      payload = {
        type: 'agent',
        fields: {
          name: name.trim(),
          description: description.trim(),
          configSchema: JSON.stringify(rawConfig),
          dependencies: JSON.stringify(depList),
        },
        file,
      };
    }
    if (await pub.submit(payload, name.trim())) onNotify('智能体已提交，等待管理员审核');
  };

  return (
    <PublishLayout
      pub={pub}
      title="发布智能体"
      description="把智能体（人设 + 参数）提交到资源中心；审核通过后所有客户端都能搜索、下载并安装。"
      submitLabel="提交审核"
      submitHint="审核通过后资源会出现在资源中心的智能体列表；系统提示词立即生效，温度/模型/接口地址会覆盖安装者的手动配置。"
      onSubmit={() => void submit()}
    >
      <ChoiceRow
        label="配置方式"
        value={configMode}
        options={[
          { value: 'structured' as const, label: '结构化配置（推荐）' },
          { value: 'raw' as const, label: '上传 JSON 文件' },
        ]}
        onChange={(next) => {
          setConfigMode(next);
          setFile(null);
          setRawConfig(null);
          setRawError('');
        }}
      />

      <label style={labelStyle}>资源名称（必填）</label>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如：傲娇猫娘助手" style={inputStyle} />

      <label style={labelStyle}>描述</label>
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        placeholder="它擅长什么？适合什么场景？"
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      {configMode === 'structured' ? (
        <>
          {profiles.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: C.sub }}>用本机智能体预填（不含 API Key）：</span>
              {profiles.slice(0, 6).map((profile) => (
                <button key={profile.id} type="button" style={smallBtn()} onClick={() => prefillFromProfile(profile)}>
                  {profile.name}
                </button>
              ))}
            </div>
          )}
          <label style={labelStyle}>智能体名称（留空与资源名称一致）</label>
          <input value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={30} placeholder="例如：傲娇猫娘助手" style={inputStyle} />

          <label style={labelStyle}>系统提示词</label>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="例如：你是一只傲娇的猫娘，说话简洁带一点傲娇，关心主人的情绪。"
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
          />

          <label style={labelStyle}>采样温度（0~2，越高越发散）</label>
          <input value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="0.8" style={inputStyle} />

          <label style={labelStyle}>指定模型（可选，留空用安装者自己的模型）</label>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如：deepseek-chat" style={inputStyle} />

          <label style={labelStyle}>指定接口地址（可选）</label>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="例如：https://api.deepseek.com/v1" style={inputStyle} />

          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.7 }}>
            提交时会自动生成配置 JSON 作为资源文件，无需手动上传。
          </div>
        </>
      ) : (
        <>
          <FileField
            label="配置文件（JSON，必填）"
            accept=".json,application/json"
            value={file}
            onChange={(next) => void handleRawFile(next)}
            hint="顶层需为对象，可包含 name / systemPrompt / temperature / model / baseUrl"
          />
          {rawError && <div style={{ fontSize: 11, color: C.danger, marginBottom: 8, lineHeight: 1.7 }}>{rawError}</div>}
          {rawConfig && (
            <div style={{ fontSize: 11, color: C.ok, marginBottom: 8, lineHeight: 1.7 }}>
              解析成功：包含字段 {Object.keys(rawConfig).join('、')}
            </div>
          )}
          <label style={labelStyle}>依赖（逗号分隔，可留空）</label>
          <input value={dependencies} onChange={(event) => setDependencies(event.target.value)} placeholder="用逗号分隔，可留空" style={inputStyle} />
        </>
      )}

      {configMode === 'structured' && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 11, color: C.sub, cursor: 'pointer' }}>查看提交的配置预览</summary>
          <pre
            style={{
              marginTop: 6, maxHeight: 200, overflow: 'auto', fontSize: 11, lineHeight: 1.6, background: C.panelAlt,
              border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap',
            }}
          >
            {JSON.stringify(structuredConfig(), null, 2)}
          </pre>
        </details>
      )}
    </PublishLayout>
  );
};

export default AgentPublishForm;