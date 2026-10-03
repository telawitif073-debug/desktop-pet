import { describe, expect, it } from 'vitest';
import {
  VOICE_TEMPLATES,
  buildVoiceConfig,
  containsSecretFields,
  parseVoiceConfigJson,
  validateSampleUrl,
  validateVoiceConfig,
} from './voicePublish';

const baseFields = {
  voiceId: 'nova',
  model: 'tts-1',
  instructions: '活泼一点',
  refAudioPath: '',
  promptText: '',
  textLang: 'zh',
  sampleText: '你好呀',
};

describe('音色发布配置（口径对齐手机端 validateVoiceConfig）', () => {
  it('cloud：voiceId 必填，只保留白名单字段', () => {
    const built = buildVoiceConfig('cloud', baseFields);
    const result = validateVoiceConfig({ ...built, apiKey: 'sk-should-drop' });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      engine: 'cloud',
      voiceId: 'nova',
      baseUrl: '',
      model: 'tts-1',
      instructions: '活泼一点',
      sampleText: '你好呀',
    });
    expect(JSON.stringify(result.config)).not.toContain('sk-');
  });

  it('gptsovits：refAudioPath 必填、voiceId 可留空', () => {
    expect(validateVoiceConfig({ engine: 'gptsovits', refAudioPath: '  ' }).ok).toBe(false);
    const result = validateVoiceConfig({ engine: 'gptsovits', refAudioPath: 'D:/refs/a.wav', voiceId: '' });
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({ engine: 'gptsovits', refAudioPath: 'D:/refs/a.wav', textLang: 'zh' });
  });

  it('system 引擎亦被接受（粘贴 JSON 场景），未知 engine 被拒', () => {
    expect(validateVoiceConfig({ engine: 'system', voiceId: 'edge-x' }).ok).toBe(true);
    expect(validateVoiceConfig({ engine: 'other', voiceId: 'x' }).error).toContain('engine');
    expect(validateVoiceConfig('nope').ok).toBe(false);
    expect(validateVoiceConfig([]).ok).toBe(false);
  });

  it('粘贴 JSON：解析失败/缺字段给出可读错误，正常配置被清洗', () => {
    expect(parseVoiceConfigJson('').ok).toBe(false);
    expect(parseVoiceConfigJson('{oops}').error).toContain('JSON 格式有误');
    expect(parseVoiceConfigJson('{"engine":"cloud"}').error).toContain('voiceId');
    const parsed = parseVoiceConfigJson('{"engine":"cloud","voiceId":"alloy","token":"secret"}');
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toEqual({ engine: 'cloud', voiceId: 'alloy', baseUrl: '', model: '', instructions: '', sampleText: '' });
  });

  it('Key 兜底拦截：配置里出现任何疑似凭证字段即命中', () => {
    expect(containsSecretFields({ engine: 'cloud', apiKey: 'x' })).toBe(true);
    expect(containsSecretFields({ engine: 'cloud', API_KEY: 'x' })).toBe(true);
    expect(containsSecretFields({ engine: 'cloud', secret: 'x' })).toBe(true);
    expect(containsSecretFields({ engine: 'cloud', token: 'x' })).toBe(true);
    expect(containsSecretFields({ engine: 'cloud', voiceId: 'nova', instructions: '关键词' })).toBe(false);
  });

  it('内置模板是可直接发布的合法配置', () => {
    expect(validateVoiceConfig(JSON.parse(VOICE_TEMPLATES.cloud)).ok).toBe(true);
    expect(validateVoiceConfig(JSON.parse(VOICE_TEMPLATES.gptsovits)).ok).toBe(true);
  });

  it('试听样本只接受 http(s) 直链或留空', () => {
    expect(validateSampleUrl('').ok).toBe(true);
    expect(validateSampleUrl('https://a.com/x.mp3').ok).toBe(true);
    expect(validateSampleUrl('ftp://a.com/x.mp3').ok).toBe(false);
    expect(validateSampleUrl('D:/sample.mp3').error).toContain('http(s)');
  });
});