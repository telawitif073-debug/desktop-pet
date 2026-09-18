/**
 * 通义万相图生视频封装（阿里云百炼 DashScope，异步任务制）：
 *   POST /api/v1/services/aigc/image2video/video-synthesis（X-DashScope-Async: enable）
 *   → task_id → 轮询 GET /api/v1/tasks/{task_id} → video_url → 下载视频 Buffer。
 * 模型 wan2.2-i2v-flash：480P、5s 固定、30fps；输入图支持 dataUrl Base64。
 */

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
const MODEL = process.env.DASHSCOPE_I2V_MODEL || 'wan2.2-i2v-flash';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

export function dashscopeKey(): string | null {
  return process.env.DASHSCOPE_API_KEY || null;
}

interface TaskResponse {
  output?: { task_id?: string; task_status?: string; video_url?: string };
  message?: string;
  code?: string;
}

/** 提交图生视频任务并轮询至完成，返回视频 MP4 Buffer */
export async function imageToVideo(imgDataUrl: string, prompt: string): Promise<Buffer> {
  const apiKey = dashscopeKey();
  if (!apiKey) throw new Error('后端未配置 DASHSCOPE_API_KEY，无法使用图生视频');
  const base = (process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');

  // ① 提交异步任务
  const submitRes = await fetch(`${base}/api/v1/services/aigc/image2video/video-synthesis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: MODEL,
      input: { prompt, img_url: imgDataUrl },
    }),
  });
  const submitData = (await submitRes.json().catch(() => ({}))) as TaskResponse;
  const taskId = submitData.output?.task_id;
  if (!submitRes.ok || !taskId) {
    throw new Error(`图生视频任务提交失败(${submitRes.status}): ${submitData.message || submitData.code || '未知错误'}`);
  }

  // ② 轮询任务状态
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new Error('图生视频任务轮询超时（15 分钟）');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const pollData = (await pollRes.json().catch(() => ({}))) as TaskResponse;
    const status = pollData.output?.task_status || 'UNKNOWN';
    if (status === 'SUCCEEDED') {
      const videoUrl = pollData.output?.video_url;
      if (!videoUrl) throw new Error('图生视频任务成功但未返回视频地址');
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error(`视频下载失败(${videoRes.status})`);
      return Buffer.from(await videoRes.arrayBuffer());
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(`图生视频任务失败（${status}）: ${pollData.message || pollData.code || '无错误信息'}`);
    }
    // PENDING / RUNNING：继续等待
  }
}
