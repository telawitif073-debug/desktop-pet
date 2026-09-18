/**
 * 提示词细化智能体：把用户的一句话描述加工为图像生成模型可直接使用的绘画提示词。
 *   ① 判别主体类型（人物 或 动物/幻想生物，两者均允许）；
 *   ② 产出角色名与细化文案；
 *   ③ 产出最终 imagePrompt（全身构图、浅绿 #E9FFEB 纯色幕底便于抠图、质感风格自适应）。
 * 提供商优先级：讯飞星火 lite（免费）→ 智谱 glm-4-flash（免费）→ 本地模板兜底（不阻断主流程）。
 * 图像生成本身由 image-gen.ts 完成。
 */

/** 可选画风（精绘专用，与普通聊天风格分离；图像模型对质感词敏感） */
export const PAINT_STYLES: Array<{ id: string; label: string; prompt: string }> = [
  { id: 'default', label: '默认可爱', prompt: '高质量数字插画质感，造型精致讨喜，细节丰富，柔和干净的光影，画面纯净' },
  { id: 'pixel', label: '像素复古', prompt: '复古像素游戏美术风格的单人角色立绘：角色本体以干净的像素块与像素画笔触绘制，轮廓清晰、色彩明快、细节像素化；严禁画成游戏场景截图，严禁出现房间、街道、桌椅、家具、地板、门窗、花草树木、UI 界面等任何场景元素' },
  { id: 'dreamy', label: '梦幻唯美', prompt: '梦幻唯美插画质感：主体柔和细腻的光影、轻盈飘逸的发丝与服饰细节、清透唯美的配色，主体清晰完整，画面干净不杂乱' },
  { id: 'guofeng', label: '国风唯美', prompt: '中国古风仙侠单人角色立绘质感：飘逸的汉元素服饰、精致的古典发饰、水墨晕染感的配色、工笔与唯美插画结合；严禁山水树林庭院等任何背景场景' },
  { id: 'aidrama', label: 'AI 短剧写真', prompt: '仿真人 AI 短剧写真质感：写实 CG 皮肤质感、水润大眼、精致五官、电影级柔光，主体完整清晰' },
];

export function stylePromptOf(style?: string): string | undefined {
  return PAINT_STYLES.find((s) => s.id === style && s.id !== 'default')?.prompt;
}

export interface PromptAgentResult {
  /** 角色名（用于表单填充与展示） */
  name: string;
  /** 主体类型：person=人物 animal=动物/幻想生物 */
  subjectType: 'person' | 'animal';
  /** 物种标签：'person' 或常见动物 id，仅用于前端展示 */
  species: string;
  /** 细化文案（补充画质细节，不改核心设定） */
  refined: string;
  /** 最终绘画提示词（直接交给图像生成模型） */
  imagePrompt: string;
}

/** 允许的物种标签（person 表示人物立绘） */
const SPECIES_IDS = ['cat', 'rabbit', 'bear', 'fox', 'panda', 'dragon', 'penguin', 'bird', 'slime', 'aquatic'];

/** 智能体人设与任务说明（示例字段一律用占位文本，防止模型照抄示例内容） */
const SYSTEM_PROMPT = [
  '你是桌宠平台的 AI 绘画导演，负责把用户的文字描述加工成图像生成模型可直接使用的绘画提示词。用户描述的主体可能是人物，也可能是动物/幻想生物，两者都允许。',
  '任务：',
  '1. 判断主体类型 subjectType：person（人物）或 animal（动物/幻想生物/吉祥物）。拟人角色（人形身体 + 兽耳/尾巴/兽爪等动物特征，如猫娘、狐娘、兔耳娘）一律判 person，species 按动物特征取 cat/fox/rabbit 等对应值；',
  '2. 起一个简短的中文角色名 name（10 字内）。',
  '3. 写出细化文案 refined：在用户描述基础上补充能提升画面质量的外观细节（人物的发型服饰饰品气质，或动物的毛发花纹配色神态），不改变用户设定的核心特征，120 字内。',
  '4. 产出最终绘画提示词 imagePrompt（中文，300 字内），必须包含：',
  '- 开头点明画面主题与主体类型（人物立绘或动物/幻想生物立绘）；',
  '- 版式：单人单像立绘，画面中只允许出现这一个角色，严禁分屏/拼格/多视图/正反面参考图/三视图/网格排版等任何多主体版式；',
  '- 构图：单角色全身立绘（头到脚完整、双脚与鞋完整可见）居中；视角：正面视角（角色面向观众/镜头，桌宠原始展示状态）；角色必须完整呈现在画面内，尾巴/发梢/翅膀/裙摆/饰品等所有延伸部位与画面四边都留出空白边距（每边约 5% 画布），严禁任何部位接触、截断或超出画面边缘；尾巴/翅膀/兽耳等待征部位必须清晰可见，画在身体侧面或上方轮廓之外，不得被服饰、身体或道具遮挡；',
  '- 背景：如证件照背景布一样完全平涂均匀的浅绿色单色画布（#E9FFEB，绿幕抠像专用底色），从画面四角到主体边缘颜色完全一致、无任何明暗变化；严禁一切阴影与光效（主体不投影子，脚下没有地面阴影/椭圆阴影/接触阴影，无光晕/发光/径向渐变/白色泛光/逆光/氛围光/笔触纹理），严禁场景/地面/道具/文字/水印（该浅绿底会在出图后被整体清除，成品只有主体）；imagePrompt 中禁止描写任何环境背景与光影氛围（云雾/山水/风景/室内/天空等），背景只能表述为浅绿色纯色平涂画布；',
  '- 质感画风跟随用户描述自适应：可爱卡通桌宠、唯美写实 CG 插画（精致五官、飘逸发丝、服饰纹理细节、柔和电影感光影）、国风仙侠古风、仿真人 AI 短剧写真（写实 CG 皮感、水润大眼、电影级柔光）等均可；',
  '- 人物要求五官精致、比例协调、气质鲜明，发丝分明、皮肤质感细腻、电影级光影；动物要求特征鲜明、造型讨喜；最终注明"高质量数字插画"。',
  '输出要求：只输出一个 JSON 对象，不要输出任何其他文字：',
  '{"name":"（此处填写角色名）","subjectType":"（person 或 animal）","species":"（person 或 cat/rabbit/bear/fox/panda/dragon/penguin/bird/slime/aquatic 之一）","refined":"（此处填写细化文案）","imagePrompt":"（此处填写绘画提示词）"}',
  '示例仅示意字段结构，所有字段内容必须来自用户描述，禁止照抄示例文案或代入未提及的特征。',
].join('\n');

/** 从 LLM 原始输出中提取 JSON 对象（容忍代码块与思维链包裹） */
function parseAgentJson(content: string): Record<string, unknown> {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('提示词智能体输出中未找到 JSON');
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

/** 场景/环境词表：立绘提示词中任何含这些词的句子都指向场景描写，整句剔除 */
const SCENE_WORDS = '山水|云雾|风景|画卷|室内|天空|树林|森林|竹林|竹叶|花园|庭院|宫殿|大殿|草原|花海|雪原|沙漠|溪流|河流|湖泊|湖畔|大海|海洋|街道|城市|村落|星空|瀑布|山谷|山顶|山间|山中|田野|原野|云海|仙山|环境|场景|林间|绿意|丛林|枝叶|树叶|花瓣|花丛|自然光|光斑|景深|虚化|朦胧|氛围|空气感';

/** 背景约束兜底：弱模型反复无视系统提示，在 imagePrompt 中段描写环境背景——先整句剔除含场景词的句子，再确保纯色背景约束存在 */
function enforceBackgroundClause(prompt: string): string {
  const stripped = prompt
    .replace(new RegExp(`[^。；]*(?:背景|站在|立于|置身|伫立|坐于|坐在|漫步|行走)[^。；]*(?:${SCENE_WORDS})[^。；]*[。；]?`, 'g'), '')
    .replace(new RegExp(`[^。；]*(?:${SCENE_WORDS})[^。；]*[。；]?`, 'g'), '')
    .replace(/。{2,}/g, '。')
    .replace(/。\s*$/, '')
    .trim();
  const base = stripped || prompt;
  if (/浅绿|绿幕|纯色|纯白/.test(base) && /无虚化|无景深|无光斑/.test(base)) return base;
  return `${base}。背景只允许是如证件照般平涂均匀的浅绿色单色画布（#E9FFEB，绿幕抠像底色），主体不投影子、脚下无地面阴影，无景深、无虚化、无光斑、无光晕、无渐变，严禁树林/绿植/山水/天空/环境/道具，无文字无水印`;
}

/** 字段钳制：保证智能体产出安全可用。stylePrompt 追加为确定性后缀——弱模型常把风格要求丢在一边，直接拼在末尾保证图像模型收到质感词 */
function clampResult(raw: Record<string, unknown>, description: string, stylePrompt?: string): PromptAgentResult {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const subjectType = str(raw.subjectType) === 'person' ? 'person' : 'animal';
  const rawSpecies = str(raw.species);
  const species = rawSpecies === 'person' || SPECIES_IDS.includes(rawSpecies) ? rawSpecies : subjectType === 'person' ? 'person' : 'cat';
  const refined = str(raw.refined) || description;
  let corePrompt = enforceBackgroundClause((str(raw.imagePrompt) || localImagePrompt(refined)).slice(0, 660));
  // 构图确定性兜底：弱模型常漏写构图词导致图像模型默认半身/特写，必须全身
  if (!/全身|头到脚/.test(corePrompt)) {
    corePrompt = `全身构图（头到脚完整、双脚与鞋完整可见）。${corePrompt}`;
  }
  // 末尾强制句：图像模型对末尾权重更敏感，全身要求再钉一次
  corePrompt = `${corePrompt}。务必输出完整全身立绘：头到脚完整、双脚与鞋完整可见，严禁半身或特写`;
  const styleSuffix = stylePrompt && !corePrompt.includes(stylePrompt.slice(0, 12)) ? `。画面质感与风格：${stylePrompt}` : '';
  return {
    // 弱模型偶发照抄系统提示里的占位文本（"（此处填写角色名）"），视为空串回退描述截取
    name: (str(raw.name).replace(/[（(]此处填写[^）)]*[）)]/g, '') || description.trim().slice(0, 10) || 'AI 角色').slice(0, 30),
    subjectType,
    species,
    refined: refined.slice(0, 800),
    imagePrompt: `${corePrompt}${styleSuffix}`.slice(0, 900),
  };
}

/** 本地兜底提示词拼装（LLM 不可用时保证出图不中断） */
function localImagePrompt(base: string): string {
  return `精致的角色立绘插画：${base}。单个角色全身构图（头到脚完整呈现）居中，正面视角（面向观众），尾巴/发梢/翅膀等所有延伸部位与画面四边留出空白边距、不得接触画面边缘，可以是人物或动物/幻想生物，五官与神态生动，造型精致讨喜，细节丰富，高质量数字插画。背景为如证件照般平涂均匀的浅绿色单色画布（#E9FFEB，绿幕抠像底色），主体不投影子、脚下无地面阴影、无光晕、无渐变，不要任何场景/道具/环境，无文字无水印。`;
}

/** 无 LLM 时的兜底结果（名称取描述前 10 字，主体类型按关键词粗判） */
function fallbackResult(description: string, stylePrompt?: string): PromptAgentResult {
  const personHit = /人|少女|少年|女孩|男孩|女子|男子|仙女|侠|公主|王子|美女|帅哥|角色/.test(description);
  const refined = stylePrompt ? `${description}\n画风：${stylePrompt}` : description;
  return {
    name: description.trim().slice(0, 10) || 'AI 角色',
    subjectType: personHit ? 'person' : 'animal',
    species: personHit ? 'person' : 'cat',
    refined: refined.slice(0, 800),
    imagePrompt: localImagePrompt(refined),
  };
}

/** 调用 OpenAI 兼容 /chat/completions 输出 JSON（星火与智谱协议一致） */
async function callProvider(baseUrl: string, apiKey: string, model: string, userPrompt: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      temperature: 0.8,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`提示词智能体请求失败(${res.status}): ${text.slice(0, 120)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseAgentJson(data.choices?.[0]?.message?.content || '');
}

/**
 * 运行提示词智能体：星火 lite → 智谱 glm-4-flash → 本地兜底。
 * @param description 用户原始描述
 * @param opts.stylePrompt 画风提示词（PAINT_STYLES，可空）
 */
export async function runPromptAgent(description: string, opts: { stylePrompt?: string } = {}): Promise<PromptAgentResult> {
  const userPrompt = [
    opts.stylePrompt ? `画风倾向：${opts.stylePrompt}` : '',
    `用户描述：${description}`,
  ].filter(Boolean).join('\n');

  const providers: Array<{ key: string | undefined; baseUrl: string; model: string }> = [
    { key: process.env.SPARK_API_KEY, baseUrl: process.env.AI_BASE_SPARK || 'https://spark-api-open.xf-yun.com/v1', model: process.env.AI_PAINT_AGENT_MODEL || 'lite' },
    { key: process.env.ZHIPU_API_KEY, baseUrl: process.env.AI_BASE_ZHIPU || 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ];
  for (const p of providers) {
    if (!p.key) continue;
    try {
      return clampResult(await callProvider(p.baseUrl, p.key, p.model, userPrompt), description, opts.stylePrompt);
    } catch {
      // 单家不可用（Key 失效/限流/输出异常）：尝试下一家
    }
  }
  return fallbackResult(description, opts.stylePrompt);
}
