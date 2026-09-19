/**
 * 云端语音识别引擎（渲染端）：宠物「听懂说话」的在线来源。
 * 与 speech-asr（本地模型）接口对齐（init/start/stop/isReady），ambientSense 可无缝分流：
 * - getUserMedia 采集 16kHz 音频，能量 VAD 切分语句（不依赖本地模型，无 Silero）
 * - 宠物朗读期间丢弃音频帧（防「自听」），切句后编码 WAV 经主进程调上游转写
 *   （接口配置与 Key 留在主进程，见 main.ts asr:transcribe）
 * - 云端无流式 partial：「叫名字立刻回应」降级为说完一句后回应（唤醒词逻辑不变）
 */

import { isSpeaking } from './speech';

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
/** RMS 高于此值视为在说话（0~1，正常说话约 0.02~0.3；环境噪声误识别只会多一次上游调用，文本不含名字仍会被过滤） */
const RMS_SPEECH_THRESHOLD = 0.015;
/** 语音后连续静音多久切句 */
const SILENCE_END_MS = 800;
/** 一段语音最短长度（过滤单帧噪声误触发） */
const MIN_SPEECH_MS = 400;
/** 单段最长时长（一直说话也强制切句发送） */
const MAX_SEGMENT_MS = 15000;
/** 错误回调节流（网络持续不可用时避免刷屏） */
const ERROR_THROTTLE_MS = 30_000;

export interface ApiAsrOptions {
  /** 一句转写完成（走 ambientSense 唤醒词逻辑） */
  onResult: (text: string) => void;
  onError: (message: string) => void;
}

/** Uint8Array → base64（FileReader 分块免栈溢出，比 btoa 拼接稳） */
function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = () => reject(new Error('音频编码失败'));
    reader.readAsDataURL(new Blob([bytes]));
  });
}

/** 把分段 PCM 合并编码为 16bit 单声道 WAV（base64，可直接作为 input_audio/转写文件） */
async function encodeWavBase64(chunks: Float32Array[], sampleRate: number): Promise<string> {
  let total = 0;
  for (const c of chunks) total += c.length;
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      pcm[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (pos: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return bytesToBase64(new Uint8Array(buffer));
}

export class ApiAsr {
  isReady = false;
  private opts: ApiAsrOptions;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;

  // --- 能量 VAD 状态 ---
  private segment: Float32Array[] = [];
  private segmentMs = 0; // 当前分段累计时长
  private silenceMs = 0; // 末尾连续静音时长
  private inFlight = false;
  private pending: Float32Array[] | null = null; // 发送中产生的下一段（仅保留最新，防堆积）
  private lastErrorAt = 0;

  constructor(opts: ApiAsrOptions) {
    this.opts = opts;
  }

  /** 无需加载模型，标记就绪；接口配置是否可用由主进程转写时校验 */
  async init(): Promise<void> {
    this.isReady = true;
  }

  async start(): Promise<void> {
    if (!this.isReady) throw new Error('ASR not initialized. Call init() first.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
    source.connect(this.processor);
    // 经零增益节点连 destination（ScriptProcessor 必须接到图上才工作，但不能真播放出来）
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.audioCtx.destination);
    this.resetSegment();
  }

  stop(): void {
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close().catch(() => {});
    this.processor = null;
    this.stream = null;
    this.audioCtx = null;
  }

  private resetSegment(): void {
    this.segment = [];
    this.segmentMs = 0;
    this.silenceMs = 0;
  }

  private onAudio(samples: Float32Array): void {
    if (!this.audioCtx) return;
    if (isSpeaking()) {
      // 宠物自己说话（TTS 播放）期间丢弃并重置分段，防止把自己的声音送出去
      this.resetSegment();
      return;
    }
    const frameMs = (samples.length / SAMPLE_RATE) * 1000; // 4096/16000 = 256ms
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const speaking = Math.sqrt(sum / samples.length) >= RMS_SPEECH_THRESHOLD;
    if (speaking) {
      this.segment.push(samples.slice());
      this.segmentMs += frameMs;
      this.silenceMs = 0;
      if (this.segmentMs >= MAX_SEGMENT_MS) void this.finishSegment();
    } else if (this.segment.length) {
      // 语音段尾部的短暂静音一并保留（自然停顿），连续静音超阈值即切句
      this.segment.push(samples.slice());
      this.segmentMs += frameMs;
      this.silenceMs += frameMs;
      if (this.silenceMs >= SILENCE_END_MS) void this.finishSegment();
    }
  }

  private finishSegment(): void {
    const chunks = this.segment;
    const durationMs = this.segmentMs;
    this.resetSegment();
    if (durationMs < MIN_SPEECH_MS) return;
    if (this.inFlight) {
      this.pending = chunks;
      return;
    }
    void this.transcribe(chunks);
  }

  private async transcribe(chunks: Float32Array[]): Promise<void> {
    this.inFlight = true;
    try {
      const wavBase64 = await encodeWavBase64(chunks, SAMPLE_RATE);
      const res = await window.electronAPI?.asr?.transcribe({ wavBase64 });
      if (res?.ok && res.text) this.opts.onResult(res.text);
      else this.emitError(res?.error || '语音识别不可用');
    } catch (err) {
      this.emitError(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        void this.transcribe(next);
      }
    }
  }

  private emitError(message: string): void {
    const now = Date.now();
    if (now - this.lastErrorAt < ERROR_THROTTLE_MS) return;
    this.lastErrorAt = now;
    this.opts.onError(message);
  }
}
