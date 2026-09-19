/**
 * 持续感知（渲染端侧）：麦克风语音持续识别 + 摄像头定时取帧。
 * 桌面持续感知在主进程（desktopCapturer），三路均由商店设置的 petSenses 开关控制。
 * - 麦克风：按 config.voiceAsr.source 分流识别引擎——local=sherpa-onnx 本地 WASM 模型
 *   （speech-asr SDK：zipformer 中文流式 + Silero VAD，模型包用户在聊天设置导入）；
 *   api=用户自配在线识别接口；agent=已安装智能体自带识别（后两者走 apiAsr.ts，能量
 *   VAD 切句，说完才出结果）。识别到一句完整语音（≥2 字）交给唤醒词逻辑或手动监听者；
 *   宠物朗读期间忽略输入，防止「自听循环」。
 * - 摄像头：getUserMedia 常驻流，每 15 分钟抓一帧经主进程视觉理解后触发主动评论。
 */

import { SpeechASR, type ModelPaths } from 'speech-asr';
import { ApiAsr } from './apiAsr';
import { useChatStore } from '../store/chatStore';
import { isSpeaking, speak } from './speech';

const CAMERA_SENSE_MS = 15 * 60 * 1000;
/** 唤醒后聆听需求的时间窗口 */
const AWAKE_WINDOW_MS = 8000;
/** 连续对话模式：每次说完需求后继续聆听的窗口（超时自动结束） */
const CONTINUOUS_WINDOW_MS = 30_000;
/** 唤醒回应（随机抽一句） */
const WAKE_REPLIES = ['哎~我在呢！', '我在听~', '嗯？叫我呀？', '来啦来啦~', '我在这儿呢'];
/** 主进程 sherpa 模型目录在 petaction:// 协议下的路径段（与 main.ts SHERPA_DIR_NAME 对应） */
const SHERPA_MODEL_URL_DIR = 'sherpa-asr';

/** 手动语音监听（聊天面板按钮）：设置后最终识别文本直接回调（不走唤醒词） */
let manualListener: ((text: string) => void) | null = null;
/** 持续聆听开关（商店设置 petSenses.mic） */
let senseMicWanted = false;
/** 手动监听开关（聊天面板按钮按下） */
let manualWanted = false;

/** 识别引擎：local=SpeechASR（本地模型）；api/agent=ApiAsr（云端转写，接口见 apiAsr.ts） */
type AsrEngine = SpeechASR | ApiAsr;
/** 识别来源（config.voiceAsr.source，默认 local）；切换后旧实例作废重建 */
function currentAsrSource(): 'local' | 'api' | 'agent' {
  return useChatStore.getState().config?.voiceAsr?.source || 'local';
}

let asr: AsrEngine | null = null;
let asrSource: 'local' | 'api' | 'agent' = 'local';
let asrInitPromise: Promise<AsrEngine | null> | null = null;
let asrRunning = false;

let cameraStream: MediaStream | null = null;
let cameraVideo: HTMLVideoElement | null = null;
let cameraTimer: number | null = null;
let cameraFirstTimer: number | null = null;

let awakeUntil = 0;
/** 最近一次唤醒回应的文本与时间（用于过滤 TTS 回声被麦克风再次识别） */
let lastWakeReply = '';
let lastWakeReplyAt = 0;

const stripSymbols = (s: string) => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

/** 随机抽一句唤醒回应并记录（回声过滤用） */
function wakeReplyText(): string {
  const t = WAKE_REPLIES[Math.floor(Math.random() * WAKE_REPLIES.length)];
  lastWakeReply = t;
  lastWakeReplyAt = Date.now();
  return t;
}

/**
 * 流式识别中检测到名字：立刻回应并开启聆听窗（不等说完，体验「叫名字立刻回应」）。
 * 连名带事进行中（名字后已有实质内容）不回应，等 final 直接发送，
 * 避免回应 TTS 播放期间吞掉需求识别（isSpeaking 拦截）。
 */
function wakeOnPartial(clean: string): void {
  if (clean.length < 2 || isSpeaking() || manualListener) return;
  if (Date.now() < awakeUntil) return; // 已唤醒，不重复回应
  const { config } = useChatStore.getState();
  const name = (config?.petName || '小宠').trim();
  const idx = clean.indexOf(name);
  if (idx === -1) return;
  const rest = clean.slice(idx + name.length).replace(/^[，,。！!、\s]+/, '');
  if (rest.length >= 2) return;
  console.log(`[voice] wake on partial (name="${name}")`);
  awakeUntil = Date.now() + AWAKE_WINDOW_MS;
  void speak(wakeReplyText(), config?.speech);
}

/**
 * 唤醒词处理：听到自己名字才回应，然后聆听需求。
 * - 待唤醒时：文本含宠物名字 → 若名字后还有实质内容（≥3 字）连名带事直接发送；
 *   否则 TTS 回应一声并开启 8 秒聆听窗口（正常已在 partial 阶段回应，此处兜底）。
 * - 聆听窗口内：本句话即为需求（纯名字尾巴/太短语气词/TTS 回声忽略）。
 * - 未含名字的语音一律忽略（过滤环境噪音/电视声等误触）。
 */
function handleFinalVoice(text: string): void {
  // 中文输出可能带词间空白（部分模型分词输出），先去空白再匹配
  const clean = text.trim().replace(/\s+/g, '');
  console.log(`[voice] final: "${clean}"`);
  if (clean.length < 2 || isSpeaking()) return;
  if (manualListener) {
    manualListener(clean);
    return;
  }
  const { config, sendMessage } = useChatStore.getState();
  const name = (config?.petName || '小宠').trim();
  // 对话模式：once=每次说完需重新叫名字；continuous=叫一次名字后连续对话，超时自动结束
  const mode = config?.voiceWakeMode || 'once';
  const awake = Date.now() < awakeUntil;
  console.log(`[voice] name="${name}" awake=${awake} mode=${mode}`);
  if (!awake) {
    const idx = clean.indexOf(name);
    if (idx === -1) return;
    const rest = clean.slice(idx + name.length).replace(/^[，,。！!、\s]+/, '');
    if (rest.length >= 3) {
      // 连名带事一句话：直接作为需求发送（不回应，避免 TTS 播放吞掉后续识别）
      awakeUntil = mode === 'continuous' ? Date.now() + CONTINUOUS_WINDOW_MS : 0;
      void sendMessage(clean);
      return;
    }
    // 只叫了名字：回应并聆听（partial 未抢先时兜底）
    awakeUntil = Date.now() + AWAKE_WINDOW_MS;
    void speak(wakeReplyText(), config?.speech);
    return;
  }
  // 聆听窗口内：
  // 1) TTS 回声（宠物刚说的回应被识别）→ 忽略（限回应后 5 秒内）
  const reply = Date.now() - lastWakeReplyAt < 5000 ? stripSymbols(lastWakeReply) : '';
  if (reply && (clean === reply || reply.startsWith(clean) || clean.startsWith(reply))) return;
  // 2) 名字开头的短句（唤醒句尾巴，如「小爱」「小爱呀」）→ 忽略，窗口保持等下一句
  if (clean.startsWith(name)) {
    const rest = clean.slice(name.length).replace(/^[，,。！!、\s]+/, '');
    if (rest.length < 3) return;
  } else if (clean.length < 3) {
    return; // 太短（「嗯」「啊」）不算需求
  }
  // 3) 本句话即为需求；连续模式刷新窗口继续听，单次模式结束唤醒
  awakeUntil = mode === 'continuous' ? Date.now() + CONTINUOUS_WINDOW_MS : 0;
  void sendMessage(clean);
}

/** 确保识别引擎就绪（按来源分流：本地模型经 petaction:// 加载，在线来源配置在主进程；实例进程内缓存复用） */
function ensureAsr(): Promise<AsrEngine | null> {
  const source = currentAsrSource();
  if (asr && asrSource === source) return Promise.resolve(asr);
  if (!asrInitPromise || asrSource !== source) {
    asrSource = source;
    asrInitPromise = (async () => {
      if (source === 'local') {
        // 平台不内置模型：未导入时放弃（主进程节流气泡提示用户去聊天设置导入）
        const res = await window.electronAPI?.sherpa?.getModel();
        if (!res?.ok) throw new Error('MODEL_NOT_IMPORTED');
        const instance = new SpeechASR({
          vadMode: 'silero',
          // SDK 实现支持 m_path（模型目录自动拼接文件），但 1.1.6 的类型声明未同步
          modelPaths: { m_path: `petaction://local/${SHERPA_MODEL_URL_DIR}` } as unknown as ModelPaths,
          onReady: () => console.log('[voice] sherpa asr ready'),
          onResult: (text: string) => handleFinalVoice(text),
          onPartial: (text: string) => {
            const clean = text.trim().replace(/\s+/g, '');
            console.log(`[voice] partial: "${clean}"`);
            wakeOnPartial(clean);
          },
          onError: (err: { message?: string }) => console.log('[voice] asr error:', err?.message || err),
        });
        console.log('[voice] init sherpa asr…');
        await instance.init();
        asr = instance;
        console.log('[voice] sherpa asr initialized');
        return instance;
      }
      // 在线来源：api=用户自配识别接口 / agent=智能体自带（配置与 Key 留在主进程，说完一句出结果）
      const instance = new ApiAsr({
        onResult: (text) => handleFinalVoice(text),
        onError: (msg) => console.log('[voice] api asr error:', msg),
      });
      console.log(`[voice] init api asr (source=${source})…`);
      await instance.init();
      asr = instance;
      return instance;
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('[voice] asr init fail:', msg);
      // 重置初始化缓存：导入模型/补全配置后可重试
      asrInitPromise = null;
      return null;
    });
  }
  return asrInitPromise;
}

async function refreshMic(): Promise<void> {
  const source = currentAsrSource();
  // 识别来源切换：停掉旧引擎（实例由 ensureAsr 按新来源重建）
  if (asr && asrSource !== source && asrRunning) {
    try {
      asr.stop();
    } catch {
      // 已停止
    }
    asrRunning = false;
    console.log('[voice] asr engine switched, old instance stopped');
  }
  if (senseMicWanted || manualWanted) {
    const instance = await ensureAsr();
    // 初始化失败/加载期间已被关闭
    if (!instance || !(senseMicWanted || manualWanted)) return;
    if (!asrRunning) {
      try {
        await instance.start();
        asrRunning = true;
        console.log('[voice] recognition started');
      } catch (err) {
        console.log('[voice] mic 获取失败（无麦克风或未授权）:', err);
      }
    }
  } else if (asr && asrRunning) {
    try {
      asr.stop();
    } catch {
      // 已停止
    }
    asrRunning = false;
    console.log('[voice] recognition stopped');
  }
}

async function cameraTick(): Promise<void> {
  const video = cameraVideo;
  if (!video || video.readyState < 2) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  await window.electronAPI?.sense?.cameraFrame(dataUrl);
}

async function startCamera(): Promise<void> {
  if (cameraStream) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
  } catch {
    // 无摄像头/未授权：静默放弃（开关关闭再开会重试）
    return;
  }
  const video = document.createElement('video');
  video.srcObject = cameraStream;
  video.muted = true;
  try {
    await video.play();
  } catch {
    stopCamera();
    return;
  }
  cameraVideo = video;
  // 启动 20 秒后先看一眼，此后每 15 分钟一帧
  cameraFirstTimer = window.setTimeout(() => void cameraTick(), 20_000);
  cameraTimer = window.setInterval(() => void cameraTick(), CAMERA_SENSE_MS);
}

function stopCamera(): void {
  if (cameraTimer) {
    window.clearInterval(cameraTimer);
    cameraTimer = null;
  }
  if (cameraFirstTimer) {
    window.clearTimeout(cameraFirstTimer);
    cameraFirstTimer = null;
  }
  cameraVideo = null;
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
}

/** 按商店设置同步三路持续感知（config 变化时调用；幂等） */
export function syncAmbientSenses(senses?: { screen?: boolean; mic?: boolean; camera?: boolean }): void {
  senseMicWanted = !!senses?.mic;
  void refreshMic();
  if (senses?.camera) void startCamera();
  else stopCamera();
}

/** 手动语音监听（聊天面板按钮）：回调最终识别文本；返回是否成功进入聆听 */
export async function startManualVoice(cb: (text: string) => void): Promise<boolean> {
  manualWanted = true;
  manualListener = cb;
  await refreshMic();
  return asrRunning;
}

export function stopManualVoice(): void {
  manualWanted = false;
  manualListener = null;
  void refreshMic();
}

/** 持续聆听是否激活（聊天面板据此隐藏手动语音按钮，避免双来源冲突） */
export function isMicAmbientActive(): boolean {
  return senseMicWanted;
}
