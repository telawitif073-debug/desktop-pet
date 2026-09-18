/**
 * 客户端本地出图 / 图生视频封装（用户自备 Key，从 config.aiGen 传入而非环境变量）：
 *   - generateSubjectImage：火山方舟 Seedream（可选）→ 智谱 CogView-3-Flash（免费）兜底
 *   - imageToVideo：通义万相 wan2.2-i2v-flash（DashScope 异步任务制，精灵表路径必需）
 */

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
const I2V_MODEL = 'wan2.2-i2v-flash';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** 用户自备 Key（config.aiGen） */
export interface AiGenKeys {
  dashscopeKey?: string;
  arkKey?: string;
  zhipuKey?: string;
}

export interface GeneratedImage {
  dataUrl: string;
  provider: 'seedream' | 'cogview';
}

interface TaskResponse {
  output?: { task_id?: string; task_status?: string; video_url?: string };
  message?: string;
  code?: string;
}

/** 提交图生视频任务并轮询至完成，返回视频 MP4 Buffer */
export async function imageToVideo(imgDataUrl: string, prompt: string, keys: AiGenKeys): Promise<Buffer> {
  const apiKey = keys.dashscopeKey?.trim();
  if (!apiKey) throw new Error('未配置万相 Key（阿里云百炼 DashScope），无法生成动作视频——请在设置中填写');
  const base = DASHSCOPE_BASE;

  // ① 提交异步任务
  const submitRes = await fetch(`${base}/api/v1/services/aigc/image2video/video-synthesis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: I2V_MODEL,
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

/** 下载图片并按魔数修正 mime 转 dataUrl（CDN 的 content-type 可能与真实字节不符） */
async function downloadAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片下载失败(${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
    : buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
      : (res.headers.get('content-type') || 'image/png').split(';')[0];
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 火山方舟 Seedream（可选渠道） */
async function seedreamGenerate(apiKey: string, prompt: string): Promise<GeneratedImage> {
  const baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
  const model = 'doubao-seedream-4-0-250828';
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size: '1024x1024', response_format: 'url', watermark: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Seedream 生成失败(${res.status}): ${text.slice(0, 160)}`);
  }
  const data = (await res.json()) as { data?: Array<{ url?: string }> };
  const url = data.data?.[0]?.url;
  if (!url) throw new Error('Seedream 接口未返回图片地址');
  return { provider: 'seedream', dataUrl: await downloadAsDataUrl(url) };
}

/** 智谱 CogView-3-Flash（免费兜底渠道；免费档有并发/频率限制，429 退避重试两次） */
async function cogviewGenerate(apiKey: string, prompt: string): Promise<GeneratedImage> {
  const baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt));
    res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'cogview-3-flash', prompt, size: '1024x1024' }),
    });
    if (res.status !== 429) break;
  }
  if (!res) throw new Error('图像生成请求未发出');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`图像生成失败(${res.status}): ${text.slice(0, 160)}`);
  }
  const data = (await res.json()) as { data?: Array<{ url?: string }> };
  const url = data.data?.[0]?.url;
  if (!url) throw new Error('图像生成接口未返回图片地址');
  return { provider: 'cogview', dataUrl: await downloadAsDataUrl(url) };
}

/** 生成原始立绘（纯色浅绿底，未抠图）：Seedream 可用则优先，失败或未配置自动落回 CogView */
export async function generateSubjectImage(prompt: string, keys: AiGenKeys): Promise<GeneratedImage> {
  const arkKey = keys.arkKey?.trim();
  if (arkKey) {
    try {
      return await seedreamGenerate(arkKey, prompt);
    } catch {
      // Seedream 失败（Key 无效/欠费/模型名不符）：落回 CogView
    }
  }
  const zhipuKey = keys.zhipuKey?.trim();
  if (zhipuKey) return cogviewGenerate(zhipuKey, prompt);
  throw new Error('未配置图像生成 Key：请在设置中填写智谱 Key（免费 CogView）或火山方舟 Key（Seedream）');
}
