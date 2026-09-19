/**
 * Edge TTS（微软 Edge 朗读服务，神经网络音色）：完全免费、无需注册任何 Key，
 * 音质远优于系统 SAPI 引擎，音色列表社区使用最广（晓晓/云希等）。
 * 主进程封装：渲染端经 IPC tts:speak 传文本与参数，返回 mp3 base64（渲染端 Audio 播放）。
 * 网络失败/超时返回 null，渲染端自动回退系统 Web Speech。
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

/** 默认音色（完整清单见渲染端 renderer/speech.ts EDGE_VOICES，仅 UI 展示用） */
export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 语气预设与渲染端 TONE_PRESETS 同 id：Edge 侧的语速/音调乘数 */
const EDGE_TONES: Record<string, { rate: number; pitch: number }> = {
  natural: { rate: 1, pitch: 1 },
  happy: { rate: 1.12, pitch: 1.3 },
  gentle: { rate: 0.92, pitch: 1.15 },
  serious: { rate: 0.9, pitch: 0.8 },
  lazy: { rate: 0.8, pitch: 0.9 },
};

export interface EdgeSpeakArgs {
  text: string;
  /** Edge 音色 ShortName，空 = 晓晓 */
  voice?: string;
  /** 语气 id（与渲染端 TONE_PRESETS 对应，可选） */
  tone?: string;
  /** 用户基准语速 0.5~2 */
  rate?: number;
  /** 用户基准音调 0~2 */
  pitch?: number;
  /** 音量 0~1 */
  volume?: number;
}

/** 相对百分比字符串（SSML 要求带符号） */
function relPct(value: number): string {
  const pct = Math.round((value - 1) * 100);
  if (pct === 0) return '+0%';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** 合成一段文本并返回 mp3 base64；任何失败返回 null（调用方回退系统 TTS） */
export async function edgeSpeak(args: EdgeSpeakArgs): Promise<string | null> {
  let tts: MsEdgeTTS | null = null;
  try {
    const tone = EDGE_TONES[args.tone || 'natural'] ?? EDGE_TONES.natural;
    const rate = Math.min(2, Math.max(0.5, (args.rate || 1) * tone.rate));
    const pitch = Math.min(2, Math.max(0, (args.pitch || 1) * tone.pitch));
    tts = new MsEdgeTTS();
    await tts.setMetadata(args.voice || EDGE_DEFAULT_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const tmpDir = app.getPath('temp');
    const { audioFilePath } = await tts.toFile(tmpDir, args.text, {
      rate: relPct(rate),
      pitch: relPct(pitch),
      volume: Math.round(Math.min(1, Math.max(0, args.volume ?? 1)) * 100),
    });
    const buf = fs.readFileSync(audioFilePath);
    fs.rmSync(audioFilePath, { force: true });
    return buf.length > 0 ? buf.toString('base64') : null;
  } catch {
    return null;
  } finally {
    tts?.close();
  }
}
