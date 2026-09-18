/**
 * AI 检测智能体（独立文件，与绘图智能体 painting-agent.ts / 抠图智能体 cutout-agent.ts 构成完整链路）。
 * 职责：在「生成智能体」与「抠图智能体」之后各做一次质量把关，不合格项反馈给生成端自动重试。
 *   ① kind='generated'：检查原始立绘——单主体、构图完整（全身/半身）、正面朝向、
 *      纯色平涂背景（无场景/阴影/光晕/渐变）、无水印文字、主体未触边截断；
 *   ② kind='cutout'：检查透明成品——背景完全透明无残留色块、主体完整无破洞、
 *      无水印文字残留、边缘干净无绿边。
 * 视觉模型：智谱 glm-4v-flash（免费档），模型可用 AI_DETECT_MODEL 覆盖。
 * 未配置 ZHIPU_API_KEY 时跳过视觉判定（pass=true + skipped），链路不中断。
 */

import { PNG } from 'pngjs';

export type DetectKind = 'generated' | 'cutout';

export interface DetectResult {
  /** 是否合格（视觉判定与程序化预检全部通过） */
  pass: boolean;
  /** 未配置视觉模型时为 true（视为合格放行） */
  skipped: boolean;
  /** 不合格项描述（喂回绘图智能体作为下一稿修正要求） */
  issues: string[];
  /** 逐项检查结果 */
  checks: Record<string, boolean>;
}

/** 从 LLM/VLM 原始输出中提取 JSON 对象（容忍代码块与思维链包裹） */
function parseAgentJson(content: string): Record<string, unknown> {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('检测智能体输出中未找到 JSON');
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

/** dataUrl → { mime, buffer }（mime 按魔数复核） */
function parseDataUrl(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  const buffer = Buffer.from(match ? match[2] : dataUrl, 'base64');
  const magic = buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8
    ? 'image/jpeg'
    : buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : '';
  return { buffer, mime: magic || (match ? match[1] : 'image/png') };
}

/** 透明 PNG → 白底合成 dataUrl（VLM 对透明像素的理解不稳定，合成后目视即成品效果） */
function compositeOnWhite(dataUrl: string): string {
  const { buffer, mime } = parseDataUrl(dataUrl);
  if (mime !== 'image/png') return dataUrl;
  const png = PNG.sync.read(buffer);
  const out = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255;
    out.data[i] = Math.round(png.data[i] * a + 255 * (1 - a));
    out.data[i + 1] = Math.round(png.data[i + 1] * a + 255 * (1 - a));
    out.data[i + 2] = Math.round(png.data[i + 2] * a + 255 * (1 - a));
    out.data[i + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(out).toString('base64')}`;
}

/** 透明 PNG 程序化预检：透明占比须在合理区间（过少=背景没抠动，过多=主体被误删） */
function transparentRatioOf(dataUrl: string): number {
  const { buffer, mime } = parseDataUrl(dataUrl);
  if (mime !== 'image/png') return -1;
  const png = PNG.sync.read(buffer);
  let transparent = 0;
  const total = png.width * png.height;
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] < 16) transparent += 1;
  }
  return (transparent / total) * 100;
}

/** 生成稿检测清单（framing 决定构图判定标准） */
function generatedChecklist(framing: 'full' | 'half'): string {
  const composition = framing === 'half'
    ? '"compositionOk"：构图是否为半身（腰部以上、头面清晰）'
    : '"compositionOk"：构图是否为完整全身（头到脚、双脚与鞋完整可见，任何部位都没有被画面边缘截断）';
  return [
    '你是桌宠平台的 AI 检测导演（检测智能体），负责对一张 AI 生成的角色立绘原图做质量验收。只输出一个 JSON 对象，禁止输出任何其他文字。',
    '逐项检查并给出布尔结论：',
    '{"singleSubject"：画面是否只有一个角色（无分屏/拼格/多视图/参考线稿/第二个主体），',
    composition + '，',
    '"frontFacing"：角色是否正面朝向观众/镜头，',
    '"plainBackdrop"：背景是否为均匀纯色平涂画布（允许浅绿/浅白等任意纯色），无场景/道具/地面/文字，无阴影/影子/椭圆暗块，无光晕/发光/径向渐变/笔触纹理，',
    '"noWatermark"：画面是否完全没有水印、"AI生成"角标或任何文字，',
    '"marginOk"：主体与画面四边是否留有空隙（头发/尾巴/裙摆等没有任何部位贴边或被裁切）}。',
    '输出格式：{"pass":布尔,"issues":["不合格项的具体描述（合格则为空数组）"],"checks":{"singleSubject":布尔,"compositionOk":布尔,"frontFacing":布尔,"plainBackdrop":布尔,"noWatermark":布尔,"marginOk":布尔}}',
    '判定要严格：任何一项不满足则 pass=false，issues 中用一句中文描述每个问题（将反馈给绘图端修正）。',
  ].join('\n');
}

/** 抠图成品检测清单 */
const CUTOUT_CHECKLIST = [
  '你是桌宠平台的 AI 检测导演（检测智能体），负责对一张「去背后的角色透明成品图」（已合成到白色底上展示）做质量验收。只输出一个 JSON 对象，禁止输出任何其他文字。',
  '逐项检查并给出布尔结论：',
  '{"transparentBg"：背景是否完全干净（展示图上主体之外应为纯白，没有任何残留色块/绿色斑块/阴影/渐变底），',
  '"subjectIntact"：主体是否完整（没有缺失的部位/破洞/被误删的肢体或尾巴，主体本身未被背景色侵蚀），',
  '"noWatermark"：主体内外是否完全没有水印、"AI生成"角标或任何文字残留，',
  '"cleanEdges"：主体边缘是否干净（无明显绿色描边/杂色镶边/大片毛糙锯齿）}。',
  '输出格式：{"pass":布尔,"issues":["不合格项的具体描述（合格则为空数组）"],"checks":{"transparentBg":布尔,"subjectIntact":布尔,"noWatermark":布尔,"cleanEdges":布尔}}',
  '判定要严格：任何一项不满足则 pass=false，issues 中用一句中文描述每个问题。',
].join('\n');

/**
 * 运行检测智能体。
 * @param kind generated=生成智能体产出的原始立绘；cutout=抠图智能体产出的透明成品
 * @param dataUrl 待检图像（cutout 传透明 PNG，内部会合成白底再送视觉模型）
 * @param opts.framing 构图标准（generated 专用）
 * @param opts.transparentPct 抠图端自检透明占比（cutout 专用，程序化预检）
 */
export async function runDetectAgent(
  kind: DetectKind,
  dataUrl: string,
  opts: { framing?: 'full' | 'half'; transparentPct?: number } = {},
): Promise<DetectResult> {
  const apiKey = process.env.ZHIPU_API_KEY;
  const issues: string[] = [];
  const checks: Record<string, boolean> = {};

  // 程序化预检（与视觉判定互补，不依赖 Key）
  if (kind === 'cutout' && typeof opts.transparentPct === 'number') {
    const pct = opts.transparentPct;
    checks.transparentPct = pct >= 20 && pct <= 98;
    if (!checks.transparentPct) {
      issues.push(pct < 20 ? `透明占比仅 ${pct.toFixed(1)}%，背景清除不完整` : `透明占比高达 ${pct.toFixed(1)}%，主体疑似被过度清除`);
    }
  }

  if (!apiKey) return { pass: issues.length === 0, skipped: true, issues, checks };

  const model = process.env.AI_DETECT_MODEL || 'glm-4v-flash';
  const baseUrl = (process.env.AI_BASE_ZHIPU || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const prompt = kind === 'generated' ? generatedChecklist(opts.framing === 'half' ? 'half' : 'full') : CUTOUT_CHECKLIST;
  const imageUrl = kind === 'cutout' ? compositeOnWhite(dataUrl) : dataUrl;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`检测智能体请求失败(${res.status}): ${text.slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';
    const raw = parseAgentJson(content);
    const vlmPass = raw.pass === true;
    const vlmIssues = Array.isArray(raw.issues) ? (raw.issues as unknown[]).map((s) => String(s)) : [];
    const vlmChecks = (raw.checks && typeof raw.checks === 'object' ? raw.checks : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(vlmChecks)) checks[k] = v === true;
    // 程序化预检不合格时，无论视觉结论如何都不放行
    const programmaticFail = issues.length > 0;
    return {
      pass: vlmPass && !programmaticFail,
      skipped: false,
      issues: [...issues, ...vlmIssues].slice(0, 8),
      checks,
    };
  } catch (err) {
    // 视觉模型不可用（Key 失效/限流/输出异常）：只按程序化预检结论放行，并在 issues 中注明
    const msg = err instanceof Error ? err.message : String(err);
    return { pass: issues.length === 0, skipped: true, issues: [...issues, `视觉检测跳过：${msg}`].slice(0, 8), checks };
  }
}
