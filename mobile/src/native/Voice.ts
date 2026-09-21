/**
 * 语音（系统原生能力）：TTS 朗读（音色/语速/音调）+ 按住说话识别。
 * 原生事件经 DeviceEventEmitter 回传（PetVoiceStart/Partial/Result/Error）。
 */
import { DeviceEventEmitter, NativeModules } from 'react-native';

export interface SpeakOptions {
  /** 语速 0.5-2.0，默认 1.0 */
  rate?: number;
  /** 音调 0.5-2.0，默认 1.0 */
  pitch?: number;
  /** 音色名称（listVoices 返回的 name，空=系统默认） */
  voice?: string;
}

const PetVoice = NativeModules.PetVoice as {
  speak(text: string, options?: SpeakOptions): Promise<boolean>;
  stopSpeak(): Promise<boolean>;
  listVoices(): Promise<Array<{ name: string; label: string }>>;
  isSpeechAvailable(): Promise<boolean>;
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
} | undefined;

export interface VoiceEvents {
  onStart?: () => void;
  onPartial?: (text: string) => void;
  onResult?: (text: string) => void;
  onError?: (message: string) => void;
}

export function isSpeechAvailable(): boolean {
  return !!PetVoice;
}

export async function checkRecognizerAvailable(): Promise<boolean> {
  try {
    return (await PetVoice?.isSpeechAvailable()) ?? false;
  } catch {
    return false;
  }
}

/** 设备可用中文音色列表 */
export async function listVoices(): Promise<Array<{ name: string; label: string }>> {
  try {
    return (await PetVoice?.listVoices()) ?? [];
  } catch {
    return [];
  }
}

export async function speak(text: string, opts?: SpeakOptions): Promise<void> {
  await PetVoice?.speak(text, opts ?? {}).catch(() => undefined);
}

export async function stopSpeak(): Promise<void> {
  await PetVoice?.stopSpeak().catch(() => undefined);
}

export async function startListening(): Promise<void> {
  if (!PetVoice) throw new Error('当前环境不支持语音识别');
  await PetVoice.startListening();
}

export async function stopListening(): Promise<void> {
  await PetVoice?.stopListening().catch(() => undefined);
}

/** 订阅识别事件，返回取消订阅函数 */
export function subscribeVoice(events: VoiceEvents): () => void {
  const subs = [
    events.onStart ? DeviceEventEmitter.addListener('PetVoiceStart', () => events.onStart?.()) : null,
    events.onPartial ? DeviceEventEmitter.addListener('PetVoicePartial', (e: { text?: string }) => events.onPartial?.(e?.text ?? '')) : null,
    events.onResult ? DeviceEventEmitter.addListener('PetVoiceResult', (e: { text?: string }) => events.onResult?.(e?.text ?? '')) : null,
    events.onError ? DeviceEventEmitter.addListener('PetVoiceError', (e: { message?: string }) => events.onError?.(e?.message ?? '识别失败')) : null,
  ].filter(Boolean) as Array<{ remove: () => void }>;
  return () => subs.forEach((s) => s.remove());
}
