import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudVoiceReady, synthVoice, testGptsovitsEngine } from './ttsCloud';
import type { TtsCloudConfig, VoiceConfig } from './config';

const globalOpenAI: TtsCloudConfig = {
  engine: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'tts-1',
};
const emptyGlobal: TtsCloudConfig = { engine: 'openai', baseUrl: '', apiKey: '', model: '' };

function voice(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return { engine: 'cloud', voiceId: 'alloy', ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cloudVoiceReady 云音色就绪判定（T9）', () => {
  it('cloud：需要端点 + Key + voiceId（三者缺一即不就绪）', () => {
    expect(cloudVoiceReady(voice(), globalOpenAI)).toBe(true);
    expect(cloudVoiceReady(voice(), emptyGlobal)).toBe(false);
    expect(cloudVoiceReady(voice(), { ...globalOpenAI, apiKey: '' })).toBe(false);
    expect(cloudVoiceReady(voice({ voiceId: '' }), globalOpenAI)).toBe(false);
  });

  it('音色自带 baseUrl 时可脱离全局地址', () => {
    expect(cloudVoiceReady(voice({ baseUrl: 'https://tts.test/v1' }), emptyGlobal)).toBe(false); // 仍缺 Key
    expect(cloudVoiceReady(voice({ baseUrl: 'https://tts.test/v1' }), { ...emptyGlobal, apiKey: 'k' })).toBe(true);
  });

  it('gptsovits：只需端点 + 参考音频路径（无需 Key）', () => {
    const gpts = voice({ engine: 'gptsovits', voiceId: '', refAudioPath: '/data/ref.wav' });
    expect(cloudVoiceReady(gpts, emptyGlobal)).toBe(false); // 缺端点
    expect(cloudVoiceReady(gpts, { ...emptyGlobal, baseUrl: 'http://192.168.1.5:9880' })).toBe(true);
    expect(
      cloudVoiceReady(voice({ engine: 'gptsovits', refAudioPath: '' }), {
        ...emptyGlobal,
        baseUrl: 'http://192.168.1.5:9880',
      }),
    ).toBe(false);
  });

  it('system 引擎无需任何云配置', () => {
    expect(cloudVoiceReady(voice({ engine: 'system', voiceId: 'Tingting' }), emptyGlobal)).toBe(true);
  });
});

describe('synthVoice 参数校验与请求构造（T9）', () => {
  it('缺少云 TTS Key 时抛出中文指引且不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      synthVoice(voice({ baseUrl: 'https://tts.test/v1' }), emptyGlobal, '你好'),
    ).rejects.toThrow('未配置云 TTS 服务 Key');
    await expect(synthVoice(voice(), emptyGlobal, '你好')).rejects.toThrow('未配置云 TTS 服务地址');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAI 兼容链路：POST {base}/audio/speech，带 Bearer 与 response_format=mp3', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthVoice(voice({ instructions: '温柔一点' }), globalOpenAI, '你好', 1.2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'tts-1',
      voice: 'alloy',
      input: '你好',
      response_format: 'mp3',
      speed: 1.2,
      instructions: '温柔一点',
    });
    expect(result.dataUrl.startsWith('data:audio/mpeg;base64,')).toBe(true);
  });

  it('GPT-SoVITS 链路：POST {base}/tts，无 Authorization，返回 wav data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([9, 9]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config: VoiceConfig = {
      engine: 'gptsovits',
      voiceId: '',
      baseUrl: 'http://192.168.1.5:9880',
      refAudioPath: '/data/ref.wav',
      promptText: '参考音频的话',
      promptLang: 'zh',
      textLang: 'zh',
    };
    const result = await synthVoice(config, emptyGlobal, '你好', 1.1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.5:9880/tts');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: '你好',
      ref_audio_path: '/data/ref.wav',
      prompt_text: '参考音频的话',
      media_type: 'wav',
      streaming_mode: false,
      speed_factor: 1.1,
    });
    expect(result.dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('GPT-SoVITS 缺参考音频时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      synthVoice({ engine: 'gptsovits', voiceId: '', baseUrl: 'http://x:9880', refAudioPath: ' ' }, emptyGlobal, 'hi'),
    ).rejects.toThrow('参考音频');
  });

  it('HTTP 非 2xx 时错误含状态码与响应片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 })),
    );
    await expect(synthVoice(voice(), globalOpenAI, '你好')).rejects.toThrow('HTTP 429');
  });
});

describe('testGptsovitsEngine 连通性测试（T9）', () => {
  it('地址为空或格式不对时直接提示，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await testGptsovitsEngine('')).online).toBe(false);
    expect((await testGptsovitsEngine('192.168.1.5:9880')).message).toContain('http://');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('引擎有应答（含 4xx）即视为在线', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad params', { status: 422 })));
    const res = await testGptsovitsEngine('http://192.168.1.5:9880/');
    expect(res.online).toBe(true);
    expect(res.message).toContain('422');
  });

  it('网络层失败视为离线并给出排查提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await testGptsovitsEngine('http://192.168.1.5:9880');
    expect(res.online).toBe(false);
    expect(res.message).toContain('无法连接');
  });
});