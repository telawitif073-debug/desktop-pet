/**
 * 宠物语音朗读统一入口（三引擎，对齐手机端 voiceEngine.speakReply 的优先级）：
 *   1) 智能体专属音色（档案 boundVoiceId）→ 2) 全局云音色（activeCloudVoiceId）
 *   → 3) 桌面 Edge 神经音色（免费在线）→ 4) 系统 Web Speech（离线兜底）
 * 云音色合成在主进程 ttsCloud.ts（API Key 留在主进程）；任何一级失败自动降级下一级，
 * 保证「至少能听到声音」。清理规则：剥工具指令/markdown，单句上限 600 字。
 */

import type { InstalledVoice } from '../global.d';

/** 语音配置结构（与 main/config.ts SpeechSettings 保持一致，禁止 import 主进程模块的运行时值） */
export interface SpeechSettings {
  enabled: boolean;
  voice?: string;
  /** @deprecated 旧系统音色字段，读取时兼容迁移 */
  voiceURI?: string;
  tone: 'natural' | 'happy' | 'gentle' | 'serious' | 'lazy';
  rate: number;
  pitch: number;
  volume: number;
}

/** 语音配置默认值：默认 Edge 晓晓（比系统 SAPI 自然得多） */
export const DEFAULT_SPEECH: SpeechSettings = {
  enabled: true,
  voice: '',
  tone: 'natural',
  rate: 1,
  pitch: 1,
  volume: 1,
};

/** Edge TTS 默认音色（ShortName） */
export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** Edge 神经音色清单（设置面板下拉用；与主进程 tts.ts 的默认音色保持一致） */
export const EDGE_VOICES: Array<{ name: string; label: string }> = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温暖自然）' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊（女·年轻活泼）' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女·东北口音）' },
  { name: 'zh-TW-HsiaoChenNeural', label: '曉臻（女·台湾腔）' },
  { name: 'zh-HK-HiuMaanNeural', label: '曉曼（女·粤语）' },
  { name: 'zh-CN-YunxiNeural', label: '云希（男·阳光少年）' },
  { name: 'zh-CN-YunjianNeural', label: '云健（男·浑厚磁性）' },
  { name: 'zh-CN-YunyangNeural', label: '云扬（男·专业播音）' },
  { name: 'en-US-AriaNeural', label: 'Aria（女·英语）' },
  { name: 'en-US-GuyNeural', label: 'Guy（男·英语）' },
  { name: 'ja-JP-NanamiNeural', label: '七海（女·日语）' },
];

/** 单句朗读上限（OpenAI 系上限 4096，这里控制流量与首字延迟） */
export const MAX_SPEAK_CHARS = 600;

/** 试听默认文案（音色未带 sampleText 时用） */
export const DEFAULT_PREVIEW_TEXT = '你好呀，我是你的桌面小宠，今天也要开开心心的哦！';

/**
 * 归一化音色：'' → 'edge:'（Edge 默认）；旧 voiceURI（无前缀非 edge 名）→ 'sys:' 前缀。
 */
function normalizeVoice(cfg: SpeechSettings): string {
  const v = (cfg.voice || '').trim();
  if (v) return v;
  const legacy = (cfg.voiceURI || '').trim();
  if (legacy && !legacy.includes('Neural')) return `sys:${legacy}`;
  return 'edge:';
}

/** 语气预设：在用户基准 rate/pitch 上做乘数微调 */
export const TONE_PRESETS: Array<{ id: SpeechSettings['tone']; label: string; rate: number; pitch: number }> = [
  { id: 'natural', label: '自然', rate: 1, pitch: 1 },
  { id: 'happy', label: '开心', rate: 1.12, pitch: 1.3 },
  { id: 'gentle', label: '温柔', rate: 0.92, pitch: 1.15 },
  { id: 'serious', label: '严肃', rate: 0.9, pitch: 0.8 },
  { id: 'lazy', label: '慵懒', rate: 0.8, pitch: 0.9 },
];

/** 系统可用音色列表（中文优先排序） */
export function listVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  const voices = speechSynthesis.getVoices();
  return [...voices].sort((a, b) => {
    const aZh = a.lang.toLowerCase().startsWith('zh') ? 0 : 1;
    const bZh = b.lang.toLowerCase().startsWith('zh') ? 0 : 1;
    return aZh - bZh || a.name.localeCompare(b.name);
  });
}

/** 朗读前清洗：剥工具指令/markdown 符号/链接/代码，长文本截断 */
function cleanForSpeech(text: string): string {
  const stripped = text
    .replace(/\[\[\s*(SEARCH|WEATHER|STOCK|FOOTBALL)\s*[|｜][\s\S]*?\]\]/gi, '')
    .replace(/```[\s\S]*?```/g, '，代码略，')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, MAX_SPEAK_CHARS);
}

// ── 朗读上下文与优先级计划 ────────────────────────────────────────────────

/** 朗读上下文：语音基础配置 + 音色库（由调用方从 config 组装） */
export interface SpeakContext {
  speech?: SpeechSettings;
  /** 已安装音色（云音色库） */
  downloadedVoices?: InstalledVoice[];
  /** 全局音色选择（downloadedVoices[].id） */
  activeCloudVoiceId?: string;
  /** 当前智能体的专属音色 id（档案 boundVoiceId） */
  boundVoiceId?: string;
}

/** 单条朗读候选链路 */
export type SpeakPlanStep =
  /** 已安装音色（智能体专属） */
  | { kind: 'installed'; voiceId: string }
  /** 已安装音色（全局选择） */
  | { kind: 'global-cloud'; voiceId: string }
  /** 桌面 Edge 神经音色 */
  | { kind: 'edge'; voice: string }
  /** 系统 Web Speech（voiceURI 为空 = 系统默认） */
  | { kind: 'system'; voice: string };

/**
 * 组装按优先级排列的朗读计划（纯函数，供单测覆盖降级顺序）：
 * 智能体专属音色 → 全局云音色 → Edge → 系统音色。
 * 同一音色不重复入队；engine=system 的已安装音色由执行器走系统 TTS。
 */
export function resolveSpeakPlan(ctx: SpeakContext): SpeakPlanStep[] {
  const cfg = ctx.speech ?? DEFAULT_SPEECH;
  const voices = ctx.downloadedVoices ?? [];
  const plan: SpeakPlanStep[] = [];

  const bound = ctx.boundVoiceId ? voices.find((v) => v.id === ctx.boundVoiceId) : undefined;
  if (bound) plan.push({ kind: 'installed', voiceId: bound.id });

  const globalVoice = voices.find((v) => v.id === ctx.activeCloudVoiceId);
  if (globalVoice && globalVoice.id !== bound?.id) {
    plan.push({ kind: 'global-cloud', voiceId: globalVoice.id });
  }

  const raw = normalizeVoice(cfg);
  if (raw.startsWith('edge:')) plan.push({ kind: 'edge', voice: raw.slice(5) || EDGE_DEFAULT_VOICE });
  // 最终兜底：系统音色（sys: 选择或系统默认）
  plan.push({ kind: 'system', voice: raw.startsWith('sys:') ? raw.slice(4) : '' });
  return plan;
}

/**
 * 由配置组装朗读上下文（当前智能体的 boundVoiceId 取自生效档案；
 * 生效档案 = llmActiveProfileId 指向且未停用，否则首个未停用档案）
 */
export function speakContextFromConfig(
  config:
    | {
        speech?: SpeechSettings;
        downloadedVoices?: InstalledVoice[];
        activeCloudVoiceId?: string;
        llmProfiles?: Array<{ id: string; enabled?: boolean; boundVoiceId?: string }>;
        llmActiveProfileId?: string;
      }
    | null
    | undefined,
): SpeakContext {
  const profiles = config?.llmProfiles ?? [];
  const active = profiles.find((p) => p.id === config?.llmActiveProfileId);
  const resolved = active && active.enabled !== false ? active : profiles.find((p) => p.enabled !== false);
  return {
    speech: config?.speech,
    downloadedVoices: config?.downloadedVoices,
    activeCloudVoiceId: config?.activeCloudVoiceId,
    boundVoiceId: resolved?.boundVoiceId,
  };
}

// ── 播放 ────────────────────────────────────────────────────────────────

/** 当前播放的音频（Edge / 云音色共用，新消息打断上一段） */
let currentAudio: HTMLAudioElement | null = null;

/** 播放可访问的音频地址（data URL / http(s) 直链） */
function playAudioUrl(url: string): void {
  stopSpeaking();
  const audio = new Audio(url);
  currentAudio = audio;
  audio.addEventListener('ended', () => {
    if (currentAudio === audio) currentAudio = null;
  });
  void audio.play().catch(() => {
    // 自动播放被拒等异常：静默（气泡文本仍在展示）
    if (currentAudio === audio) currentAudio = null;
  });
}

/** 系统 Web Speech 朗读（离线兜底；voiceURI 为空 = 系统默认音色） */
function speakWithSystem(
  content: string,
  cfg: SpeechSettings,
  tone: (typeof TONE_PRESETS)[number],
  voiceURI: string,
): void {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.rate = Math.min(2, Math.max(0.5, cfg.rate * tone.rate));
  utterance.pitch = Math.min(2, Math.max(0, cfg.pitch * tone.pitch));
  utterance.volume = Math.min(1, Math.max(0, cfg.volume));
  if (voiceURI) {
    const voice = speechSynthesis.getVoices().find((item) => item.voiceURI === voiceURI);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/** 云音色合成并播放（失败抛错，由调用方降级） */
async function speakWithInstalledVoice(
  voice: InstalledVoice,
  content: string,
  cfg: SpeechSettings,
): Promise<void> {
  const res = await window.electronAPI?.tts.cloudSpeak({
    text: content,
    config: voice.config,
    speed: Math.min(2, Math.max(0.5, cfg.rate)),
  });
  if (!res?.success || !res.dataUrl) throw new Error(res?.error || '云音色合成失败');
  playAudioUrl(res.dataUrl);
}

/** 依次尝试计划中的候选链路，成功即停 */
async function runPlan(
  plan: SpeakPlanStep[],
  content: string,
  cfg: SpeechSettings,
  ctx: SpeakContext,
): Promise<void> {
  const tone = TONE_PRESETS.find((t) => t.id === cfg.tone) ?? TONE_PRESETS[0];
  for (const step of plan) {
    if (step.kind === 'installed' || step.kind === 'global-cloud') {
      const voice = (ctx.downloadedVoices ?? []).find((v) => v.id === step.voiceId);
      if (!voice) continue;
      // engine=system 的已安装音色：直接走系统 TTS（无需网络/Key）
      if (voice.config.engine === 'system') {
        speakWithSystem(content, cfg, tone, voice.config.voiceName || '');
        return;
      }
      try {
        await speakWithInstalledVoice(voice, content, cfg);
        return;
      } catch (e) {
        console.warn('[speech] 云音色合成失败，降级下一级：', e instanceof Error ? e.message : e);
        stopSpeaking();
        continue;
      }
    }
    if (step.kind === 'edge') {
      // Edge TTS：主进程合成 mp3（免费在线神经网络音色），失败降级系统
      const base64 = await window.electronAPI?.tts
        .speak({
          text: content,
          voice: step.voice,
          tone: cfg.tone,
          rate: cfg.rate,
          pitch: cfg.pitch,
          volume: cfg.volume,
        })
        .catch(() => null);
      if (base64) {
        playAudioUrl(`data:audio/mpeg;base64,${base64}`);
        return;
      }
      continue;
    }
    speakWithSystem(content, cfg, tone, step.voice);
    return;
  }
}

/** 朗读一段文本（回复/主动消息主入口）；enabled=false 时静默跳过 */
export function speak(text: string, ctx?: SpeakContext): void {
  const cfg = ctx?.speech ?? DEFAULT_SPEECH;
  if (!cfg.enabled) return;
  const content = cleanForSpeech(text);
  if (!content) return;
  void runPlan(resolveSpeakPlan(ctx ?? {}), content, cfg, ctx ?? {});
}

/** 试听任意已安装音色：系统音色走系统 TTS、有样本放样本、否则用本机凭证现场合成（缺配置抛错提示） */
export async function previewInstalled(voice: InstalledVoice, text?: string): Promise<void> {
  stopSpeaking();
  const cfg = DEFAULT_SPEECH;
  const content =
    cleanForSpeech((text ?? '').trim() || voice.config.sampleText || DEFAULT_PREVIEW_TEXT) ||
    DEFAULT_PREVIEW_TEXT;
  if (voice.config.engine === 'system') {
    speakWithSystem(content, cfg, TONE_PRESETS[0], voice.config.voiceName || '');
    return;
  }
  if (voice.sampleUrl) {
    playAudioUrl(voice.sampleUrl);
    return;
  }
  try {
    await speakWithInstalledVoice(voice, content, cfg);
  } catch (e) {
    const hint =
      voice.config.engine === 'gptsovits'
        ? '（GPT-SoVITS 音色：请在「云 TTS 服务配置」填引擎地址，且音色需带参考音频）'
        : '（云音色：请在「云 TTS 服务配置」填入你自己的服务地址与 Key）';
    throw new Error(`${e instanceof Error ? e.message : String(e)}${hint}`);
  }
}

/** 系统音色试听 */
export function previewSystemVoice(voiceURI?: string, speech?: SpeechSettings): void {
  stopSpeaking();
  const cfg = speech ?? DEFAULT_SPEECH;
  const tone = TONE_PRESETS.find((t) => t.id === cfg.tone) ?? TONE_PRESETS[0];
  speakWithSystem(DEFAULT_PREVIEW_TEXT, cfg, tone, voiceURI || '');
}

/** 是否正在朗读（持续语音监听防自听：宠物说话期间麦克风识别忽略输入） */
export function isSpeaking(): boolean {
  if (currentAudio) return true;
  return typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking;
}

/** 停止朗读（清空面板/切换音色试听时调用） */
export function stopSpeaking(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}