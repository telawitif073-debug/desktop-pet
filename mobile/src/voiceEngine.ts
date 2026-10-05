/**
 * 音色引擎统一入口：对话朗读 / 设置试听 / 商店试听都走这里。
 *
 * 两条链路：
 * 1. 系统音色（engine=system，或未选云音色）→ Android 原生 TextToSpeech（离线、机械感）
 * 2. 云音色（engine=cloud）→ OpenAI 兼容 POST {base}/audio/speech 合成 mp3
 *    → 隐藏 WebView 的 HTMLAudio 播放（热更无法加原生音频模块，故借 WebView）
 *
 * 云合成任何失败都自动降级系统 TTS（用户至少能听到声音）。
 * API Key 只来自用户自填的全局 ttsCloudConfig，音色配置本身不含 Key（防发布者投毒/泄露）。
 */
import { speak as sysSpeak, stopSpeak as sysStop, type SpeakOptions } from './native/Voice';
import { playVoice, stopVoice } from './components/VoicePlayer';
import { useAppStore } from './store/appStore';
import type { InstalledVoice, VoiceConfig } from './types';

/** 云 TTS 单句最大字符数（超了截断；OpenAI 系上限 4096，这里控制流量与首字延迟） */
const MAX_SPEAK_CHARS = 600;
const DEFAULT_PREVIEW_TEXT = '你好呀，这是一段语音试听，今天也要开心哦！';

/** 当前生效的云音色（选中 id 命中已安装列表且为云引擎 cloud/gptsovits），否则 null */
export function currentCloudVoice(): InstalledVoice | null {
  const s = useAppStore.getState();
  const v = s.downloadedVoices.find((x) => x.id === s.activeCloudVoiceId);
  return v && v.config.engine !== 'system' ? v : null;
}

/** 该云音色是否已具备调用条件：cloud=端点+Key+voiceId；gptsovits=端点+参考音频路径（无需 Key） */
export function cloudVoiceReady(v: InstalledVoice | null = currentCloudVoice()): boolean {
  if (!v) return false;
  const s = useAppStore.getState();
  const base = (v.config.baseUrl || s.ttsCloudConfig.baseUrl).trim();
  if (v.config.engine === 'gptsovits') {
    return !!base && !!(v.config.refAudioPath || '').trim();
  }
  return !!base && !!s.ttsCloudConfig.apiKey.trim() && !!v.config.voiceId.trim();
}

/** 去掉不适合朗读的符号并截断 */
function normalizeSpeechText(text: string): string {
  return text
    .replace(/\[\[\s*(SEARCH|WEATHER|STOCK|FOOTBALL)\s*[|｜][\s\S]*?\]\]/gi, '')
    .replace(/[#*`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

/** 合成超时：GPT-SoVITS 无 GPU 时 CPU 合成较慢，放宽到 60s（OpenAI 系一般几秒内返回） */
const SYNTH_TIMEOUT_MS = 60 * 1000;

/** fetch 带 60s 超时；返回原始 Response（含 ok=false 情形，由调用方处理错误文案） */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GPT-SoVITS api_v2 合成：POST {base}/tts（JSON 参数，返回音频二进制；无需任何 Key） */
async function synthGptsovits(v: InstalledVoice, text: string, speed?: number): Promise<string> {
  const s = useAppStore.getState();
  const c = v.config;
  const base = (c.baseUrl || s.ttsCloudConfig.baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('未配置 GPT-SoVITS 引擎地址');
  if (!(c.refAudioPath || '').trim()) throw new Error('音色配置缺少参考音频（refAudioPath）');
  const body: Record<string, unknown> = {
    text,
    text_lang: c.textLang || 'zh',
    ref_audio_path: c.refAudioPath!.trim(),
    prompt_text: c.promptText || '',
    prompt_lang: c.promptLang || 'zh',
    media_type: 'wav',
    streaming_mode: false,
  };
  if (typeof speed === 'number' && speed > 0) body.speed_factor = Math.min(5, Math.max(0.5, speed));

  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? '合成超时（60s），无 GPU 时长文本会较慢' : '无法连接 GPT-SoVITS 引擎，请检查地址与防火墙';
    throw new Error(msg);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GPT-SoVITS 合成失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('合成音频读取失败'));
    fr.readAsDataURL(blob);
  });
}

/** 调用云 TTS 合成，返回可直接给 audio 播放的 data URL */
async function synthCloud(v: InstalledVoice, text: string, speed?: number): Promise<string> {
  if (v.config.engine === 'gptsovits') return synthGptsovits(v, text, speed);
  const s = useAppStore.getState();
  const c = v.config;
  const base = (c.baseUrl || s.ttsCloudConfig.baseUrl).replace(/\/+$/, '');
  const key = s.ttsCloudConfig.apiKey.trim();
  if (!base) throw new Error('未配置云 TTS 服务地址');
  if (!key) throw new Error('未配置云 TTS 服务 Key');
  if (!c.voiceId.trim()) throw new Error('音色配置缺少 voiceId');
  const body: Record<string, unknown> = {
    model: (c.model || s.ttsCloudConfig.model || 'tts-1').trim(),
    voice: c.voiceId.trim(),
    input: text,
    response_format: 'mp3',
  };
  if (typeof speed === 'number' && speed > 0) body.speed = Math.min(4, Math.max(0.25, speed));
  if (c.instructions?.trim()) body.instructions = c.instructions.trim();

  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'AbortError' ? '云 TTS 合成超时（60s）' : '云 TTS 服务连接失败');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`云 TTS 合成失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('合成音频读取失败'));
    fr.readAsDataURL(blob);
  });
}

/** 用指定云音色把文本合成并播放（设置页/商店试听用）；缺配置时抛错由 UI 提示 */
export async function speakWithCloudVoice(v: InstalledVoice, text: string, speed?: number): Promise<void> {
  const clean = normalizeSpeechText(text) || DEFAULT_PREVIEW_TEXT;
  const dataUrl = await synthCloud(v, clean, speed);
  return await new Promise<void>((resolve) => {
    playVoice(dataUrl, () => resolve());
  });
}

/** 直接播放音频直链（商店发布者上传的试听样本） */
export function playSampleUrl(url: string): void {
  playVoice(url);
}

/** 停止一切朗读（云音频 + 系统 TTS） */
export function stopAllVoice(): void {
  stopVoice();
  void sysStop();
}

/**
 * 尝试用指定「已安装音色」朗读（智能体专属音色 / 试听共用）：
 * - system：直接走系统 TTS（用音色自带 voiceName）
 * - cloud/gptsovits：未就绪或合成失败返回 null，由调用方降级全局/系统
 * @returns 实际链路；null=该音色此次无法发声
 */
async function trySpeakInstalled(v: InstalledVoice, text: string): Promise<'cloud' | 'system' | null> {
  const s = useAppStore.getState();
  if (v.config.engine === 'system') {
    await sysSpeak(text, {
      rate: s.speechRate,
      pitch: s.speechPitch,
      voice: v.config.voiceName || undefined,
    });
    return 'system';
  }
  if (!cloudVoiceReady(v)) return null;
  try {
    const dataUrl = await synthCloud(v, text, s.speechRate);
    stopVoice();
    await new Promise<void>((resolve) => {
      playVoice(dataUrl, () => resolve());
    });
    return 'cloud';
  } catch (e) {
    console.warn('[voiceEngine] 云音色合成失败，准备降级：', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 智能体回答朗读（对话主入口）：
 * 1) 当前智能体绑定了专属音色 → 优先用它（编辑页「朗读音色」配置）
 * 2) 未绑定 / 绑定音色已删除 / 云音色未就绪或合成失败 → 降级全局音色（设置页选择）
 * @param profileId 指定智能体 id；undefined=当前激活智能体；显式 null=强制全局（设置页试听）
 * @returns 'cloud' | 'system' 实际走的链路（供调用方埋点/提示）
 */
export async function speakReply(rawText: string, profileId?: string | null): Promise<'cloud' | 'system'> {
  const s = useAppStore.getState();
  const text = normalizeSpeechText(rawText);
  if (!text) return 'system';

  // ── 1) 智能体专属音色优先 ──
  if (profileId !== null) {
    const pid = profileId ?? s.llmActiveProfileId;
    const boundId = pid ? s.llmProfiles.find((p) => p.id === pid)?.boundVoiceId : undefined;
    const bound = boundId ? s.downloadedVoices.find((v) => v.id === boundId) ?? null : null;
    if (bound) {
      const kind = await trySpeakInstalled(bound, text);
      if (kind) return kind;
      // 绑定音色无法发声：云音色停掉可能在播的残留，继续降级到全局
      stopVoice();
    }
  }

  // ── 2) 全局音色（设置页配置）──
  const cloud = currentCloudVoice();
  if (cloud && cloudVoiceReady(cloud)) {
    const kind = await trySpeakInstalled(cloud, text);
    if (kind) return kind;
    stopVoice();
  }
  const opts: SpeakOptions = { rate: s.speechRate, pitch: s.speechPitch };
  // 云音色不可用时退回系统音色选择（speechVoice 为空=系统默认）
  if (s.speechVoice) opts.voice = s.speechVoice;
  await sysSpeak(text, opts);
  return 'system';
}

/**
 * 试听任意音色配置（设置页音色行 / 商店详情）：
 * - 云音色有样本音频 → 直接放样本（发布者真实效果）
 * - 云音色无样本 → 用本机凭证现场合成
 * - 系统音色 → 系统 TTS 念固定文案
 * 缺云 Key 时抛出带指引的错误。
 */
export async function previewInstalled(v: InstalledVoice): Promise<'cloud' | 'sample' | 'system'> {
  stopAllVoice();
  const text = (v.config.sampleText || '').trim() || DEFAULT_PREVIEW_TEXT;
  if (v.config.engine === 'cloud' || v.config.engine === 'gptsovits') {
    if (v.sampleUrl) {
      playVoice(v.sampleUrl);
      return 'sample';
    }
    if (!cloudVoiceReady(v)) {
      throw new Error(
        v.config.engine === 'gptsovits'
          ? '该音色由 GPT-SoVITS 引擎合成：请先在「设置 → 语音朗读 → 云 TTS 服务配置」把服务地址填成你电脑上 GPT-SoVITS 的地址（如 http://192.168.1.5:9880），且音色需带参考音频'
          : '该云音色需要先在「设置 → 语音朗读 → 云 TTS 服务配置」填入你自己的服务地址和 Key 才能试听',
      );
    }
    await speakWithCloudVoice(v, text);
    return 'cloud';
  }
  const s = useAppStore.getState();
  await sysSpeak(text, {
    rate: s.speechRate,
    pitch: s.speechPitch,
    voice: v.config.voiceName || undefined,
  });
  return 'system';
}

/** 系统音色试听（设置页系统列表） */
export async function previewSystemVoice(voiceName: string | undefined): Promise<void> {
  stopAllVoice();
  const s = useAppStore.getState();
  await sysSpeak(DEFAULT_PREVIEW_TEXT, {
    rate: s.speechRate,
    pitch: s.speechPitch,
    voice: voiceName || undefined,
  });
}

/** 供发布/导入页校验音色配置 JSON */
export function validateVoiceConfig(cfg: unknown): { ok: boolean; error?: string; config?: VoiceConfig } {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '配置必须是 JSON 对象' };
  const c = cfg as Record<string, unknown>;
  if (c.engine !== 'system' && c.engine !== 'cloud' && c.engine !== 'gptsovits') {
    return { ok: false, error: 'engine 只能是 "system"、"cloud" 或 "gptsovits"' };
  }
  if (typeof c.voiceId !== 'string') {
    return { ok: false, error: '缺少 voiceId（音色 ID）' };
  }
  if (c.engine === 'system') {
    if (!c.voiceId.trim()) return { ok: false, error: '缺少 voiceId（音色 ID）' };
    return {
      ok: true,
      config: {
        engine: 'system',
        voiceId: c.voiceId.trim(),
        voiceName: typeof c.voiceName === 'string' ? c.voiceName : c.voiceId,
        sampleText: typeof c.sampleText === 'string' ? c.sampleText : undefined,
      },
    };
  }
  if (c.engine === 'gptsovits') {
    // GPT-SoVITS：参考音频即音色本体，voiceId 可留空
    if (typeof c.refAudioPath !== 'string' || !c.refAudioPath.trim()) {
      return { ok: false, error: '缺少 refAudioPath（引擎所在机器上的参考音频路径）' };
    }
    return {
      ok: true,
      config: {
        engine: 'gptsovits',
        voiceId: typeof c.voiceId === 'string' ? c.voiceId.trim() : '',
        baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl.trim() : '',
        refAudioPath: c.refAudioPath.trim(),
        promptText: typeof c.promptText === 'string' ? c.promptText.trim() : '',
        promptLang: typeof c.promptLang === 'string' ? c.promptLang.trim() : 'zh',
        textLang: typeof c.textLang === 'string' ? c.textLang.trim() : 'zh',
        sampleText: typeof c.sampleText === 'string' ? c.sampleText.trim() : '',
      },
    };
  }
  if (!c.voiceId.trim()) {
    return { ok: false, error: '缺少 voiceId（音色 ID）' };
  }
  const config: VoiceConfig = {
    engine: 'cloud',
    voiceId: c.voiceId.trim(),
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl.trim() : '',
    model: typeof c.model === 'string' ? c.model.trim() : '',
    instructions: typeof c.instructions === 'string' ? c.instructions.trim() : '',
    sampleText: typeof c.sampleText === 'string' ? c.sampleText.trim() : '',
  };
  return { ok: true, config };
}

/**
 * GPT-SoVITS 引擎连通性测试（设置页「连接测试」按钮）：
 * 向 {base}/tts 发一次最小请求——只要引擎返回任何 HTTP 状态即视为在线；
 * 网络层失败（无法连接/超时）才算不通。
 */
export async function testGptsovitsEngine(baseUrl: string): Promise<{ online: boolean; message: string }> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return { online: false, message: '请先填写引擎地址' };
  if (!/^https?:\/\//i.test(base)) return { online: false, message: '地址需以 http:// 或 https:// 开头' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试', text_lang: 'zh', ref_audio_path: '', prompt_text: '', prompt_lang: 'zh', media_type: 'wav' }),
      signal: ctrl.signal,
    });
    // 引擎应答（参数不完整通常 400/422）= 在线；200 = 直接合成成功
    return { online: true, message: res.ok ? '引擎在线，接口正常' : `引擎在线（HTTP ${res.status}，音色还需配置参考音频）` };
  } catch (e) {
    return { online: false, message: e instanceof Error && e.name === 'AbortError' ? '连接超时（8s）' : '无法连接，请检查地址、防火墙与手机是否在同一局域网' };
  } finally {
    clearTimeout(timer);
  }
}
