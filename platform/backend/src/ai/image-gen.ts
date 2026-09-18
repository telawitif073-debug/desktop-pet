/**
 * 图像生成路由（基准图链路）：把最终绘画提示词交给图像生成模型，返回原始立绘 dataUrl。
 * 渠道优先级：火山方舟 Seedream（ARK_API_KEY，即梦同源，watermark 关闭）→ 智谱 CogView-3-Flash（免费）兜底。
 */

export interface GeneratedImage {
  dataUrl: string;
  url: string;
  provider: 'seedream' | 'cogview';
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
  const baseUrl = (process.env.AI_BASE_ARK || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const model = process.env.AI_IMAGE_MODEL_ARK || 'doubao-seedream-4-0-250828';
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
  return { url, provider: 'seedream', dataUrl: await downloadAsDataUrl(url) };
}

/** 智谱 CogView-3-Flash（免费兜底渠道；免费档有并发/频率限制，429 退避重试两次） */
async function cogviewGenerate(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error('后端未配置图像生成 Key（ZHIPU_API_KEY 或 ARK_API_KEY），无法出图');
  const usedModel = process.env.AI_IMAGE_MODEL || 'cogview-3-flash';
  const baseUrl = (process.env.AI_BASE_ZHIPU || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt));
    res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: usedModel, prompt, size: '1024x1024' }),
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
  return { url, provider: 'cogview', dataUrl: await downloadAsDataUrl(url) };
}

/** 生成原始立绘（纯色浅绿底，未抠图）：Seedream 可用则优先，失败或未配置自动落回 CogView */
export async function generateSubjectImage(prompt: string): Promise<GeneratedImage> {
  const arkKey = process.env.ARK_API_KEY;
  if (arkKey) {
    try {
      return await seedreamGenerate(arkKey, prompt);
    } catch {
      // Seedream 失败（Key 无效/欠费/模型名不符）：落回 CogView
    }
  }
  return cogviewGenerate(prompt);
}
