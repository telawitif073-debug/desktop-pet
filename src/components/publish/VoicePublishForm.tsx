import { useState } from 'react';
import { C, inputStyle, labelStyle, smallBtn } from '../studioTheme';
import { ChoiceRow, PublishLayout, usePublish } from './common';
import {
  VOICE_TEMPLATES,
  buildVoiceConfig,
  containsSecretFields,
  parseVoiceConfigJson,
  validateSampleUrl,
  validateVoiceConfig,
  type PublishableVoiceConfig,
  type VoicePublishMode,
} from '../../renderer/voicePublish';
import type { PublishPayload } from '../../global.d';

/**
 * 「发布音色」：音色发布（口径与手机端 PublishVoiceModal 一致）。
 * - OpenAI 兼容 / GPT-SoVITS：结构化字段够配置，天然不含 Key
 * - 粘贴 JSON：可导入他人分享的配置，解析后走同一套校验与白名单清洗
 * - 试听样本：填 http(s) 直链（后端代拉，≤5MB）或留空由安装者现场合成
 * 发布前二次拦截任何疑似 Key/secret/token 字段（配置会公开给所有安装者）。
 */
const VoicePublishForm = ({ onNotify }: { onNotify: (text: string) => void }) => {
  const pub = usePublish();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<VoicePublishMode>('cloud');
  const [voiceId, setVoiceId] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [refAudioPath, setRefAudioPath] = useState('');
  const [promptText, setPromptText] = useState('');
  const [textLang, setTextLang] = useState('zh');
  const [sampleText, setSampleText] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [sampleUrl, setSampleUrl] = useState('');

  const fields = { voiceId, model, instructions, refAudioPath, promptText, textLang, sampleText };
  /** 当前的配置校验结果（表单模式走 buildVoiceConfig，JSON 模式走解析） */
  const check = ((): { ok: boolean; error?: string; config?: PublishableVoiceConfig } => {
    if (mode === 'json') {
      if (!configJson.trim()) return { ok: false, error: '' };
      return parseVoiceConfigJson(configJson);
    }
    return validateVoiceConfig(buildVoiceConfig(mode, fields));
  })();

  const submit = async () => {
    const fail = (text: string) => pub.setResult({ ok: false, text });
    if (!name.trim()) return fail('请填写音色名称');
    if (!check.ok || !check.config) return fail(check.error || '请先完成音色配置');
    if (containsSecretFields(check.config)) {
      return fail('安全拦截：音色配置不能包含 API Key / secret / token——配置会公开给所有安装者，请删除后再发布');
    }
    const urlCheck = validateSampleUrl(sampleUrl);
    if (!urlCheck.ok) return fail(urlCheck.error || '试听样本地址不合法');

    const payload: PublishPayload = {
      type: 'voice',
      fields: {
        name: name.trim(),
        description: description.trim(),
        version: version.trim() || '1.0.0',
        configSchema: JSON.stringify(check.config),
        ...(sampleUrl.trim() ? { sampleUrl: sampleUrl.trim() } : {}),
      },
    };
    if (await pub.submit(payload, name.trim())) {
      onNotify('音色已提交，等待管理员审核');
      setName('');
      setConfigJson('');
      setSampleUrl('');
    }
  };

  return (
    <PublishLayout
      pub={pub}
      title="发布音色"
      description="把音色配置（OpenAI 兼容云音色 / GPT-SoVITS 零样本克隆 / 粘贴分享配置）提交到资源中心；审核通过后所有客户端都能浏览、试听并安装。配置里不要包含任何 API Key。"
      submitLabel="提交审核"
      submitHint="审核通过后音色会出现在资源中心的音色板块；安装者可用自己的服务凭证合成试听与朗读。"
      onSubmit={() => void submit()}
    >
      <label style={labelStyle}>音色名称（必填）</label>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如：元气猫娘音" style={inputStyle} />

      <label style={labelStyle}>版本号</label>
      <input value={version} onChange={(event) => setVersion(event.target.value)} maxLength={20} placeholder="1.0.0" style={inputStyle} />

      <label style={labelStyle}>描述</label>
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        placeholder="适合什么人设、声音特点、推荐用法…"
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      <ChoiceRow
        label="音色引擎（必填）"
        value={mode}
        options={[
          { value: 'cloud' as VoicePublishMode, label: 'OpenAI 兼容' },
          { value: 'gptsovits' as VoicePublishMode, label: 'GPT-SoVITS' },
          { value: 'json' as VoicePublishMode, label: '粘贴 JSON' },
        ]}
        onChange={setMode}
      />

      {mode === 'cloud' && (
        <>
          <label style={labelStyle}>音色 ID（voiceId，必填）</label>
          <input value={voiceId} onChange={(event) => setVoiceId(event.target.value)} placeholder="alloy / nova / 服务商给的克隆音色 ID" style={inputStyle} />
          <label style={labelStyle}>模型名（选填）</label>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="tts-1 / gpt-4o-mini-tts / cosyvoice-v2" style={inputStyle} />
          <label style={labelStyle}>风格指令（选填）</label>
          <input value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={200} placeholder="温柔的大姐姐声线，语速稍慢，带笑意" style={inputStyle} />
        </>
      )}

      {mode === 'gptsovits' && (
        <>
          <label style={labelStyle}>参考音频路径（refAudioPath，必填）</label>
          <input value={refAudioPath} onChange={(event) => setRefAudioPath(event.target.value)} placeholder="引擎电脑上的路径，如 D:/GPT-SoVITS/refs/demo.wav" style={inputStyle} />
          <label style={labelStyle}>参考音频说的话（promptText）</label>
          <input value={promptText} onChange={(event) => setPromptText(event.target.value)} maxLength={200} placeholder="与音频内容一字不差，决定克隆效果" style={inputStyle} />
          <label style={labelStyle}>待合成文本语言（textLang）</label>
          <input value={textLang} onChange={(event) => setTextLang(event.target.value)} maxLength={8} placeholder="zh / en / ja / ko / yue" style={inputStyle} />
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.7 }}>
            零样本克隆：3~10 秒干净参考音频即可，无需训练、无需 API Key；安装者需自建 GPT-SoVITS 引擎并在设置里填地址。
          </div>
        </>
      )}

      {mode === 'json' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>音色配置 JSON（必填）</label>
            <div style={{ flex: 1 }} />
            <button type="button" style={smallBtn()} onClick={() => setConfigJson(VOICE_TEMPLATES.cloud)}>
              OpenAI 示例
            </button>
            <button type="button" style={smallBtn()} onClick={() => setConfigJson(VOICE_TEMPLATES.gptsovits)}>
              SoVITS 示例
            </button>
          </div>
          <textarea
            value={configJson}
            onChange={(event) => setConfigJson(event.target.value)}
            rows={8}
            placeholder='{"engine":"cloud","voiceId":"nova"}'
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'Consolas, monospace', lineHeight: 1.6 }}
          />
          {configJson.trim() ? (
            <div style={{ fontSize: 11, color: check.ok ? C.ok : C.danger, marginBottom: 10, lineHeight: 1.7 }}>
              {check.ok ? '✓ 配置格式正确（发布前会再次做白名单清洗与 Key 拦截）' : `✗ ${check.error}`}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.7 }}>
              可从他人分享的配置文本直接粘贴导入；配置中不要包含 API Key。
            </div>
          )}
        </>
      )}

      {mode !== 'json' && (
        <>
          <label style={labelStyle}>推荐试听文案（选填）</label>
          <input value={sampleText} onChange={(event) => setSampleText(event.target.value)} maxLength={200} placeholder="安装者点试听时优先念这句" style={inputStyle} />
        </>
      )}

      <label style={labelStyle}>试听样本直链（可选）</label>
      <input value={sampleUrl} onChange={(event) => setSampleUrl(event.target.value)} placeholder="https://…/sample.mp3（≤5MB）" style={inputStyle} />
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.7 }}>
        mp3 / m4a / aac / wav；没有样本可留空，安装者会用自己的服务现场合成试听。
      </div>
    </PublishLayout>
  );
};

export default VoicePublishForm;