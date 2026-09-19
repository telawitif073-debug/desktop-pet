/**
 * 聊天感知意图：用户在聊天中要求宠物「看桌面/看摄像头」时，自动调用对应感知能力。
 * - 权限已开：截屏/拍帧作为图像附件随消息发送（视觉模型理解后回答）；
 * - 权限未开：返回对应 hint，聊天面板显示引导提示（不入聊天历史）。
 * 关键词本地判定（免 LLM 调用，零延迟）；语音对话走同一入口，同样生效。
 */

export type SenseIntent = 'screen' | 'screen-record' | 'camera' | null;

export interface SenseResolveResult {
  /** 自动抓取的图像附件（jpeg dataUrl，录屏为多帧） */
  images: string[];
  /** 权限未开时的引导类型 */
  hint?: 'screen' | 'camera';
  /** 抓取失败原因 */
  error?: string;
}

const SCREEN_INTENT_RE = /(看|瞧|瞅|截|获取|识别|观察|查看).{0,8}(桌面|屏幕|电脑)|截图|我的桌面|屏幕上|screen|desktop/i;
const SCREEN_RECORD_INTENT_RE = /录屏|录(制)?(一?段)?(视频|屏幕|桌面)|屏幕.{0,4}(录制|录下)|观察一(段|会)|看一(段|会|会儿)|record/i;
const CAMERA_INTENT_RE = /摄像头|拍(一?张)?照|拍我|看看我|看我(一?眼|长|现在)|长什么(样|模)|拍照|camera/i;

export function detectSenseIntent(text: string): SenseIntent {
  if (CAMERA_INTENT_RE.test(text)) return 'camera';
  if (SCREEN_RECORD_INTENT_RE.test(text)) return 'screen-record';
  if (SCREEN_INTENT_RE.test(text)) return 'screen';
  return null;
}

export const PERMISSION_HINTS: Record<'screen' | 'camera', string> = {
  screen: '我还没有「查看桌面」权限呢～请到资源商店的「设置 → 感知能力」开启「持续查看桌面」，我就能看你的屏幕啦。',
  camera: '我还没有「查看摄像头」权限呢～请到资源商店的「设置 → 感知能力」开启「持续查看摄像头」，我就能看到你啦。',
};

/** 摄像头拍一帧（短暂开启设备，拍完立即释放） */
async function snapCamera(): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 350)); // 等待曝光稳定
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** 录屏抽帧：录 durationMs 毫秒，均匀抽 frames 帧（视觉模型按多图理解「过程」） */
export async function recordScreenFrames(durationMs = 4800, frames = 4): Promise<string[]> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 } });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    const out: string[] = [];
    const interval = durationMs / frames;
    for (let i = 0; i < frames; i += 1) {
      await new Promise((r) => setTimeout(r, interval));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1024;
      canvas.height = video.videoHeight || 576;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/jpeg', 0.7));
    }
    return out;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** 按用户消息解析感知意图并抓取图像（senses 传当前 petSenses 开关；无意图/未开权限时 images 为空） */
export async function resolveSenseImages(
  text: string,
  senses?: { screen?: boolean; camera?: boolean },
): Promise<SenseResolveResult> {
  const intent = detectSenseIntent(text);
  if (!intent) return { images: [] };
  if (intent === 'screen' || intent === 'screen-record') {
    if (!senses?.screen) return { images: [], hint: 'screen' };
    try {
      if (intent === 'screen-record') {
        const frames = await recordScreenFrames();
        if (frames.length) return { images: frames };
        return { images: [], error: '录屏失败' };
      }
      const res = await window.electronAPI?.sense?.captureScreen();
      if (res?.success && res.dataUrl) return { images: [res.dataUrl] };
      return { images: [], error: res?.error || '截屏失败' };
    } catch {
      return { images: [], error: '录屏被取消或不支持' };
    }
  }
  if (!senses?.camera) return { images: [], hint: 'camera' };
  if (!navigator.mediaDevices?.getUserMedia) return { images: [], error: '当前环境不支持摄像头' };
  try {
    return { images: [await snapCamera()] };
  } catch {
    return { images: [], error: '摄像头不可用或未授权' };
  }
}
