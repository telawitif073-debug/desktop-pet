/**
 * 云 TTS 合成（用户自配凭证）：与手机端 voiceEngine.ts 的 synthCloud/synthGptsovits 同契约。
 * - openai   ：OpenAI 兼容 POST {base}/audio/speech（model/voice/input/response_format/speed/instructions）
 * - gptsovits：自建 GPT-SoVITS api_v2 POST {base}/tts（ref_audio_path/prompt_text/... 无需 Key）
 *
 * API Key 只来自用户自填的 config.ttsCloudConfig，音色配置本身不含 Key（防发布者投毒/泄露）。
 * 返回可直接播放的 data URL；失败抛出带中文指引的错误，由渲染端 speech.ts 逐级降级。
 */

import type { TtsCloudConfig, VoiceConfig } from './config';

/** 合成超时：GPT-SoVITS 无 GPU 时 CPU 合成较慢，放宽到 60s（OpenAI 系一般几秒内返回） */
const SYNTH_TIMEOUT_MS = 60 * 1000;
/** 连通性测试超时 */
const TEST_TIMEOUT_MS = 8 * 1000;

export interface CloudSpeakResult {
  /** data:audio/xxx;base64,... 可直接作为 audio.src */
  dataUrl: string;
}

function trimBase(url: string | undefined): string {
  return (url || '').trim().replace(/\/+$/, '');
}

/** 带超时的 fetch：网络层异常统一转成中文可读错误（HTTP 非 2xx 由调用方处理） */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
  timeoutMessage: string,
  connectMessage: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(aborted ? timeoutMessage : connectMessage);
  } finally {
    clearTimeout(timer);
  }
}

/** 响应体转 data URL（音频体积可控：单句上限 600 字，mp3/wav 均远小于 base64 传输瓶颈） */
async function toDataUrl(res: Response, mime: string): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('合成返回空音频');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** GPT-SoVITS api_v2 合成：POST {base}/tts（JSON 参数，返回 wav 二进制；无需任何 Key） */
async function synthGptsovits(
  config: VoiceConfig,
  global: TtsCloudConfig,
  text: string,
  speed?: number,
): Promise<CloudSpeakResult> {
  const base = trimBase(config.baseUrl || global.baseUrl);
  if (!base) throw new Error('未配置 GPT-SoVITS 引擎地址');
  const refAudioPath = (config.refAudioPath || '').trim();
  if (!refAudioPath) throw new Error('音色配置缺少参考音频（refAudioPath）');

  const body: Record<string, unknown> = {
    text,
    text_lang: config.textLang || 'zh',
    ref_audio_path: refAudioPath,
    prompt_text: config.promptText || '',
    prompt_lang: config.promptLang || 'zh',
    media_type: 'wav',
    streaming_mode: false,
  };
  if (typeof speed === 'number' && speed > 0) body.speed_factor = Math.min(5, Math.max(0.5, speed));

  const res = await postJson(
    `${base}/tts`,
    body,
    {},
    SYNTH_TIMEOUT_MS,
    '合成超时（60s），无 GPU 时长文本会较慢',
    '无法连接 GPT-SoVITS 引擎，请检查地址与防火墙',
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GPT-SoVITS 合成失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  return { dataUrl: await toDataUrl(res, 'audio/wav') };
}

/** OpenAI 兼容云合成：POST {base}/audio/speech（Key 来自全局 ttsCloudConfig） */
async function synthOpenAI(
  config: VoiceConfig,
  global: TtsCloudConfig,
  text: string,
  speed?: number,
): Promise<CloudSpeakResult> {
  const base = trimBase(config.baseUrl || global.baseUrl);
  const key = (global.apiKey || '').trim();
  const voiceId = (config.voiceId || '').trim();
  if (!base) throw new Error('未配置云 TTS 服务地址');
  if (!key) throw new Error('未配置云 TTS 服务 Key');
  if (!voiceId) throw new Error('音色配置缺少 voiceId');

  const body: Record<string, unknown> = {
    model: (config.model || global.model || 'tts-1').trim(),
    voice: voiceId,
    input: text,
    response_format: 'mp3',
  };
  if (typeof speed === 'number' && speed > 0) body.speed = Math.min(4, Math.max(0.25, speed));
  if (config.instructions?.trim()) body.instructions = config.instructions.trim();

  const res = await postJson(
    `${base}/audio/speech`,
    body,
    { Authorization: `Bearer ${key}` },
    SYNTH_TIMEOUT_MS,
    '云 TTS 合成超时（60s）',
    '云 TTS 服务连接失败',
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`云 TTS 合成失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  return { dataUrl: await toDataUrl(res, 'audio/mpeg') };
}

/** 云音色合成入口（engine=system 由渲染端走系统 TTS，不会到这里） */
export function synthVoice(
  config: VoiceConfig,
  global: TtsCloudConfig,
  text: string,
  speed?: number,
): Promise<CloudSpeakResult> {
  return config.engine === 'gptsovits'
    ? synthGptsovits(config, global, text, speed)
    : synthOpenAI(config, global, text, speed);
}

/** 该云音色是否已具备调用条件：cloud=端点+Key+voiceId；gptsovits=端点+参考音频（无需 Key） */
export function cloudVoiceReady(config: VoiceConfig, global: TtsCloudConfig): boolean {
  const base = trimBase(config.baseUrl || global.baseUrl);
  if (config.engine === 'system') return true;
  if (config.engine === 'gptsovits') return !!base && !!(config.refAudioPath || '').trim();
  return !!base && !!(global.apiKey || '').trim() && !!(config.voiceId || '').trim();
}

/**
 * GPT-SoVITS 引擎连通性测试：向 {base}/tts 发一次最小请求——只要引擎返回任何 HTTP 状态即视为在线；
 * 网络层失败（无法连接/超时）才算不通。
 */
export async function testGptsovitsEngine(baseUrl: string): Promise<{ online: boolean; message: string }> {
  const base = trimBase(baseUrl);
  if (!base) return { online: false, message: '请先填写引擎地址' };
  if (!/^https?:\/\//i.test(base)) return { online: false, message: '地址需以 http:// 或 https:// 开头' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '测试',
        text_lang: 'zh',
        ref_audio_path: '',
        prompt_text: '',
        prompt_lang: 'zh',
        media_type: 'wav',
      }),
      signal: ctrl.signal,
    });
    // 引擎应答（参数不完整通常 400/422）= 在线；200 = 直接合成成功
    return {
      online: true,
      message: res.ok ? '引擎在线，接口正常' : `引擎在线（HTTP ${res.status}，音色还需配置参考音频）`,
    };
  } catch (e) {
    return {
      online: false,
      message:
        e instanceof Error && e.name === 'AbortError'
          ? '连接超时（8s）'
          : '无法连接，请检查地址、防火墙与引擎是否已启动',
    };
  } finally {
    clearTimeout(timer);
  }
}