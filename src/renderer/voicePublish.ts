/**
 * 音色发布纯逻辑（口径对齐手机端 mobile/src/voiceEngine.ts 的 validateVoiceConfig 与 PublishVoiceModal）：
 * - 表单模式：按引擎填结构化字段，组装配置时只保留白名单字段（天然不含 Key）
 * - JSON 模式：粘贴他人分享的配置，解析后同样经白名单清洗
 * - 发布前二次拦截任何疑似 Key/secret/token 字段（配置会公开给所有安装者）
 */

export type VoicePublishMode = 'cloud' | 'gptsovits' | 'json';

export interface VoiceFormFields {
  voiceId: string;
  model: string;
  instructions: string;
  refAudioPath: string;
  promptText: string;
  textLang: string;
  sampleText: string;
}

/** 待发布音色配置（只含白名单字段，绝不含凭证） */
export type PublishableVoiceConfig = Record<string, string>;

export const VOICE_TEMPLATES: Record<'cloud' | 'gptsovits', string> = {
  cloud: JSON.stringify(
    {
      engine: 'cloud',
      voiceId: 'nova',
      model: 'tts-1',
      instructions: '像一只黏人的小猫娘，语速稍快，语气活泼',
      sampleText: '你好呀，我是你的桌面小宠，今天也要开心哦！',
    },
    null,
    2,
  ),
  gptsovits: JSON.stringify(
    {
      engine: 'gptsovits',
      voiceId: '',
      refAudioPath: 'D:/GPT-SoVITS/refs/demo.wav',
      promptText: '参考音频里说的这句话，一字不差地写在这里。',
      promptLang: 'zh',
      textLang: 'zh',
      sampleText: '你好呀，我是你的桌面小宠，今天也要开心哦！',
    },
    null,
    2,
  ),
};

/** 表单字段 → 配置对象（未校验；调用方接着走 validateVoiceConfig） */
export function buildVoiceConfig(mode: 'cloud' | 'gptsovits', fields: VoiceFormFields): Record<string, unknown> {
  if (mode === 'gptsovits') {
    return {
      engine: 'gptsovits',
      voiceId: fields.voiceId.trim(),
      refAudioPath: fields.refAudioPath.trim(),
      promptText: fields.promptText.trim(),
      promptLang: 'zh',
      textLang: fields.textLang.trim() || 'zh',
      sampleText: fields.sampleText.trim(),
    };
  }
  return {
    engine: 'cloud',
    voiceId: fields.voiceId.trim(),
    baseUrl: '',
    model: fields.model.trim(),
    instructions: fields.instructions.trim(),
    sampleText: fields.sampleText.trim(),
  };
}

/**
 * 校验并清洗音色配置：engine 只能是 system / cloud / gptsovits；
 * 返回的 config 只包含该引擎的白名单字段（apiKey 等一律丢弃）。
 */
export function validateVoiceConfig(
  cfg: unknown
): { ok: boolean; error?: string; config?: PublishableVoiceConfig } {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, error: '配置必须是 JSON 对象' };
  const c = cfg as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  if (c.engine !== 'system' && c.engine !== 'cloud' && c.engine !== 'gptsovits') {
    return { ok: false, error: 'engine 只能是 "system"、"cloud" 或 "gptsovits"' };
  }
  if (c.engine === 'system') {
    if (!text(c.voiceId)) return { ok: false, error: '缺少 voiceId（音色 ID）' };
    return {
      ok: true,
      config: {
        engine: 'system',
        voiceId: text(c.voiceId),
        voiceName: text(c.voiceName) || text(c.voiceId),
        ...(text(c.sampleText) ? { sampleText: text(c.sampleText) } : {}),
      },
    };
  }
  if (c.engine === 'gptsovits') {
    // GPT-SoVITS：参考音频即音色本体，voiceId 可留空
    if (!text(c.refAudioPath)) {
      return { ok: false, error: '缺少 refAudioPath（引擎所在机器上的参考音频路径）' };
    }
    return {
      ok: true,
      config: {
        engine: 'gptsovits',
        voiceId: text(c.voiceId),
        baseUrl: text(c.baseUrl),
        refAudioPath: text(c.refAudioPath),
        promptText: text(c.promptText),
        promptLang: text(c.promptLang) || 'zh',
        textLang: text(c.textLang) || 'zh',
        sampleText: text(c.sampleText),
      },
    };
  }
  if (!text(c.voiceId)) return { ok: false, error: '缺少 voiceId（音色 ID）' };
  return {
    ok: true,
    config: {
      engine: 'cloud',
      voiceId: text(c.voiceId),
      baseUrl: text(c.baseUrl),
      model: text(c.model),
      instructions: text(c.instructions),
      sampleText: text(c.sampleText),
    },
  };
}

/** 解析「粘贴 JSON」模式的文本：解析 + 校验 + 清洗 */
export function parseVoiceConfigJson(json: string): { ok: boolean; error?: string; config?: PublishableVoiceConfig } {
  const raw = json.trim();
  if (!raw) return { ok: false, error: '请粘贴音色配置 JSON' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON 格式有误，请检查括号与引号' };
  }
  return validateVoiceConfig(parsed);
}

/** 发布前安全兜底：配置里出现疑似 Key/secret/token 字段即拦截 */
export function containsSecretFields(cfg: unknown): boolean {
  return /"(apikey|api_key|key|secret|token)"\s*:/.test(JSON.stringify(cfg).toLowerCase());
}

/** 校验试听样本直链（后端代拉，限 http(s) 且 ≤5MB） */
export function validateSampleUrl(url: string): { ok: boolean; error?: string } {
  const value = url.trim();
  if (!value) return { ok: true };
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: '试听样本地址必须是 http(s) 直链' };
  return { ok: true };
}