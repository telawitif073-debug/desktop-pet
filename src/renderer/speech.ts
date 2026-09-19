/**
 * 宠物语音朗读：默认走 Edge TTS（微软神经网络音色，免费无需 Key，音质自然），
 * 主进程合成 mp3 后回传播放；网络失败自动回退系统 Web Speech API（离线可用）。
 * 音色 voice 字段：'' / 'edge:ShortName' → Edge；'sys:voiceURI' → 系统；旧 voiceURI 数据兼容迁移。
 */

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

/** 朗读前清洗：剥 markdown 符号/链接/代码，长文本截断（气泡内容与回复都以短句为主） */
function cleanForSpeech(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '，代码略，')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 300);
}

/** Edge TTS 当前播放的音频（新消息打断上一段） */
let currentAudio: HTMLAudioElement | null = null;

/** 用 Edge 合成的 mp3 base64 播放 */
function playEdgeAudio(base64: string): void {
  stopSpeaking();
  const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
  currentAudio = audio;
  audio.addEventListener('ended', () => {
    if (currentAudio === audio) currentAudio = null;
  });
  void audio.play().catch(() => {
    // 自动播放被拒等异常：静默（气泡文本仍在展示）
    if (currentAudio === audio) currentAudio = null;
  });
}

/** 系统 Web Speech 朗读（离线兜底） */
function speakWithSystem(content: string, cfg: SpeechSettings, tone: (typeof TONE_PRESETS)[number]): void {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.rate = Math.min(2, Math.max(0.5, cfg.rate * tone.rate));
  utterance.pitch = Math.min(2, Math.max(0, cfg.pitch * tone.pitch));
  utterance.volume = Math.min(1, Math.max(0, cfg.volume));
  const v = normalizeVoice(cfg);
  if (v.startsWith('sys:')) {
    const voice = speechSynthesis.getVoices().find((item) => item.voiceURI === v.slice(4));
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/** 朗读一段文本：Edge TTS 优先（失败自动回退系统），enabled=false 或环境不支持时静默跳过 */
export function speak(text: string, settings?: SpeechSettings): void {
  const cfg = settings ?? DEFAULT_SPEECH;
  if (!cfg.enabled) return;
  const content = cleanForSpeech(text);
  if (!content) return;
  const tone = TONE_PRESETS.find((t) => t.id === cfg.tone) ?? TONE_PRESETS[0];
  const voice = normalizeVoice(cfg);

  if (voice.startsWith('edge:')) {
    // Edge TTS：主进程合成 mp3（免费在线神经网络音色），失败回退系统
    void window.electronAPI?.tts
      .speak({
        text: content,
        voice: voice.slice(5) || EDGE_DEFAULT_VOICE,
        tone: cfg.tone,
        rate: cfg.rate,
        pitch: cfg.pitch,
        volume: cfg.volume,
      })
      .then((base64) => {
        if (base64) playEdgeAudio(base64);
        else speakWithSystem(content, cfg, tone);
      })
      .catch(() => speakWithSystem(content, cfg, tone));
    return;
  }
  speakWithSystem(content, cfg, tone);
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
