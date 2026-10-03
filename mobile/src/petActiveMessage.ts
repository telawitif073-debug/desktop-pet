/**
 * 「智能体主动开口」消息生成（定时任务到点 / 自主主动搭话共用）：
 * 按智能体人设 + 实时时间 + 语境（到点正事 / 纯闲聊 / 宠物状态提示）调用该档案的 LLM，
 * 生成一句自然的主动开场。非流式、60s 超时；失败由调用方降级（任务）或跳过（自主搭话）。
 */
import type { LlmProfile } from './types';
import { buildProactivePrompt } from './petCapabilities';

/** 宠物状态 → 主动搭话提示（饥饿/心情/精力偏低时围绕状态自然开口） */
export function proactiveStateHint(state: { hunger: number; mood: number; energy: number }): string {
  const hints: string[] = [];
  if (state.hunger < 30) hints.push('你现在很饿，自然地提一句想让主人喂你');
  if (state.energy < 30) hints.push('你现在有点困/累，自然地说想休息');
  if (state.mood < 30) hints.push('你现在心情低落，自然地想找主人陪你玩');
  return hints.join('；');
}

export interface ActiveMessageContext {
  /** 到点要说的正事（提醒内容或搭话话题）；为空表示纯闲聊 */
  topic?: string;
  /** 用户当时的原话（有话题时附上，帮助模型理解语境） */
  rawText?: string;
  /** 任务类别：reminder=到点提醒 ta 做某事；active_chat=到点按话题搭话 */
  kind?: 'reminder' | 'active_chat';
  /** 宠物状态提示（自主搭话用），可为空 */
  stateHint?: string;
}

/** 生成主动消息正文（失败抛错，由调用方决定降级/跳过） */
export async function generateActiveMessage(profile: LlmProfile, ctx: ActiveMessageContext): Promise<string> {
  if (!profile.apiKey || !profile.baseUrl || !profile.model) throw new Error('该智能体未配置对话 API');
  const lines = personaBase(profile);
  if (ctx.topic) {
    lines.push(
      ctx.kind === 'active_chat'
        ? `【这是你主动来找用户搭话的时刻。话题：${ctx.topic}${ctx.rawText ? `（用户当时的原话：「${ctx.rawText}」）` : ''}】`
        : `【到点了，这是你主动来找用户说话的时刻。要做的事：${ctx.topic}${ctx.rawText ? `（用户当时的原话：「${ctx.rawText}」）` : ''}】`,
    );
  } else {
    lines.push('【这是你主动来找用户搭话的时刻：没有特别的事，就是想 ta 了，自然地说点关心/日常/打趣的短句】');
  }
  if (ctx.stateHint) lines.push(`【你现在的状态（可自然融入，别生硬罗列）：${ctx.stateHint}】`);
  // 该智能体自带「主动发起对话」能力时，把能力要求（含它自己的时段约束）一并合成进提示词
  if (profile.capabilities?.enabled?.includes('proactive')) {
    lines.push(buildProactivePrompt(profile.capabilities.spec));
  }
  lines.push(
    '要求：用你的人设口吻主动开场，自然地对用户说 1~2 句话；不要提到系统、任务、设置、提醒功能这些字眼，不要解释你在执行指令。',
  );
  return callPersonaLlm(profile, lines, '（到点了，主动和我说点什么）');
}

/** 人设基础段落：人设主体 + 实时时间 + 角色/风格（与其他对话入口保持一致） */
function personaBase(profile: LlmProfile): string[] {
  const now = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const lines = [
    profile.systemPrompt?.trim() || '你是一只可爱的桌面宠物，说话简短活泼、口语化，单次回复不超过 80 字。',
    `【现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${wd} ${hh}:${mm}】`,
  ];
  if (profile.role?.trim()) lines.push(`你的角色是：${profile.role.trim()}。`);
  if (profile.style?.trim()) lines.push(`你的说话风格：${profile.style.trim()}。请全程保持该风格。`);
  return lines;
}

/** 单轮非流式人设调用（非流式、60s 超时；失败抛错） */
async function callPersonaLlm(profile: LlmProfile, lines: string[], userMsg: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages: [
      { role: 'system', content: lines.join('\n') },
      { role: 'user', content: userMsg },
    ],
    stream: false,
    max_tokens: 300,
  };
  // DeepSeek 系列：这类短回复追求快，显式关闭思考
  if (/deepseek/i.test(profile.baseUrl + profile.model)) body.thinking = { type: 'disabled' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`接口返回 ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) throw new Error('接口未返回内容');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 「把一件事实」用该智能体自己的人设口吻说出来（定时任务的确认/查询/取消/能力提示等本地动作都用它）。
 * 本地动作由 App 执行，措辞必须由该智能体自己产出，避免出现「系统口径」的模板句子；
 * 无 API 或调用失败时抛错，由调用方回退中性文案（离线可用性优先）。
 */
export async function generatePersonaReply(profile: LlmProfile, fact: string): Promise<string> {
  if (!profile.apiKey || !profile.baseUrl || !profile.model) throw new Error('该智能体未配置对话 API');
  const lines = personaBase(profile);
  lines.push(
    '【场景】你正在和用户对话，刚才这件事由你替 ta 办好了（或需要告知 ta），请把下面的事实用你自己的口吻说给 ta 听。',
    `【事实】${fact}`,
    '要求：1~2 句、不超过 60 字；必须保留事实里的时间与事项；不要提「系统」「设置」「功能」「任务」「排期」「接口」这类字眼，不要解释你在执行指令，不要输出任何方括号指令或 JSON；不要反问多余的问题；如果事实里带有 「某某 → 某某」这样的界面路径，请原样保留。',
  );
  return callPersonaLlm(profile, lines, '（把这件事用你的口吻告诉用户）');
}