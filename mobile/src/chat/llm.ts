/**
 * 手机端直连用户 LLM API（OpenAI 兼容 /chat/completions，非流式）。
 * 档案从云同步的 config 来（Key 由服务端解密下发）；人设 = 已安装智能体档案。
 */
import { useAppStore } from '../store/appStore';
import type { ChatMsg, LlmProfile } from '../types';
import { ensureMultiSession, multiChatSend, toolFootball, toolStock, toolWeather } from '../api/platform';
import { buildTaskProtocolPrompt } from '../agentCapabilities';
import { buildSearchResultPrompt, buildWebPrompt, extractSearchQuery, runWebSearch } from '../webSearch';
import {
  buildSkillsPrompt,
  extractSkillCall,
  normalizeFootballDate,
  parseWeatherArg,
  SKILL_KINDS,
  stripSkillDirectives,
  stripUnclosedToolTail,
  type SkillCall,
  type SkillKind,
} from '../skills';

const DEFAULT_SYSTEM = '你是一个乐于助人的 AI 助手，说话简短自然、口语化，单次回复尽量不超过 80 字。';

export function activeProfile(): LlmProfile | null {
  const { llmProfiles, llmActiveProfileId } = useAppStore.getState();
  return llmProfiles.find((p) => p.id === llmActiveProfileId) ?? llmProfiles[0] ?? null;
}

export function isConfigured(): boolean {
  const profile = activeProfile();
  return !!(profile?.apiKey && profile?.baseUrl && profile?.model);
}

function buildSystemPrompt(): string {
  const { userNickname, showThinking, thinkingLang } = useAppStore.getState();
  // LlmProfile = 智能体，档案自带 systemPrompt（人设主体），没填才用默认人格
  const profile = activeProfile();
  const profilePrompt = profile?.systemPrompt?.trim();
  const parts: string[] = [];
  parts.push(profilePrompt || DEFAULT_SYSTEM);
  // 实时时间注入（智能体可「准确知道时间」：问日期/星期/时刻、用药与预约提醒都以它为基准）
  const now = new Date();
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  parts.push(
    `【实时时间】现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekday} ${hh}:${mm}（这是确切的当前时间，涉及日期/星期/时刻/提醒的问题请以此为准，不要编造）`,
  );
  // 智能体页面 P0：角色/风格注入人设（角色提升为拟人身份，风格约束说话口吻）
  if (profile?.role?.trim()) parts.push(`你的角色是：${profile.role.trim()}。`);
  if (profile?.style?.trim()) parts.push(`你的说话风格：${profile.style.trim()}。请全程保持该风格。`);
  if (userNickname.trim()) parts.push(`请用「${userNickname.trim()}」来称呼用户。`);
  // 智能体自带能力（来自它自己的 JSON + 用户导入时的选择）：只有启用「定时任务」的智能体才注入
  // 建任务协议，且用该智能体自己的示例任务/频率约束合成（见 agentCapabilities.ts）
  if (profile?.capabilities?.enabled?.includes('tasks')) {
    parts.push(buildTaskProtocolPrompt(profile.capabilities.spec));
  }
  // 联网能力（用户自配搜索服务）：只有启用后才下发「需要实时信息就先查」的协议
  if (profile?.capabilities?.enabled?.includes('web')) {
    parts.push(buildWebPrompt());
  }
  // 平台免费技能（天气/股票/足彩，无需用户配 Key，服务端代理）
  const enabledSkills = (profile?.capabilities?.enabled ?? []).filter((k): k is SkillKind =>
    (SKILL_KINDS as string[]).includes(k),
  );
  if (enabledSkills.length) parts.push(buildSkillsPrompt(enabledSkills));
  // 思考过程语言（DeepSeek 风格设置）：跟随回复=不干预；指定语言时强约束内部推理书写语言，
  // 措辞上明确「人设与要求仍优先约束正文」，避免与用户设置的系统提示词冲突
  if (showThinking && thinkingLang === 'zh') {
    parts.push(
      '【语言要求·最高优先级】你的内部思考过程（reasoning）必须从头到尾全程使用简体中文书写：每一句思考都用中文，除无法翻译的专有名词（如模型名、API 名）外，严禁出现英文单词、英文句子或其他任何语言的文字。此要求只约束内部思考；正文回复不受影响，仍完全遵循上述人设与要求。',
    );
  }
  if (showThinking && thinkingLang === 'en') {
    parts.push(
      '[LANGUAGE REQUIREMENT - HIGHEST PRIORITY] Your internal reasoning (thinking) must be written entirely in English from start to finish: every sentence of reasoning in English, with no words or sentences in any other language except untranslatable proper nouns (such as model or API names). This applies only to internal reasoning; the visible reply is unaffected and must fully follow the persona above.',
    );
  }
  return parts.join('\n');
}

/** 思考语言指令：注入到最后一条用户消息（模型对最新用户消息的遵从度远高于 system，双保险之一） */
function thinkingLangSuffix(): string {
  const { showThinking, thinkingLang } = useAppStore.getState();
  if (!showThinking || thinkingLang === 'auto') return '';
  if (thinkingLang === 'zh') {
    return '\n\n（系统强制要求：本次回复的内部思考过程 reasoning 必须从头到尾全程使用简体中文书写，每一句都用中文，严禁出现英文句子。此要求仅约束内部思考，正文不受影响。）';
  }
  return '\n\n(System requirement: your internal reasoning must be written entirely in English from start to finish. This applies only to reasoning; the reply is unaffected.)';
}

/** 把思考语言指令追加到消息列表的最后一条 user 消息上（不落库，仅请求时生效） */
function applyThinkingLang(messages: Array<{ role: string; content: string }>): void {
  const suffix = thinkingLangSuffix();
  if (!suffix) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      messages[i] = { ...messages[i], content: messages[i].content + suffix };
      return;
    }
  }
}

export interface ChatResult {
  content: string;
  reasoning?: string;
}

/**
 * 多智能体协同：档案配置了 multiConfig（外部依赖）时，聊天不走设备直连，
 * 而是发往平台后端编排接口（子智能体调用 / 路由 / 汇总由服务端执行，可查看协同轨迹）。
 * 需登录平台账号；子智能体的 API 在智能体配置中提供，档案自己的 Key 可缺省。
 */
async function orchestrateViaPlatform(history: ChatMsg[], cb: StreamCallbacks): Promise<ChatResult> {
  const { token } = useAppStore.getState();
  if (!token) {
    throw new Error('多智能体协同需要通过平台账号执行：请先在聊天页登录（右上角），登录后即可与「宠物管家团」式智能体对话');
  }
  const profile = activeProfile();
  if (!profile) throw new Error('当前没有可用的智能体档案');
  const session = await ensureMultiSession(profile.id, profile.name);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content?.trim() ?? '';
  if (!question) throw new Error('消息内容为空');
  const res = await multiChatSend(
    session.id,
    question,
    history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
  );
  const content = res.content ?? '';
  if (content) cb.onContent?.(content);
  return { content };
}

/** 该档案是否按多智能体模式走平台编排（有外部依赖占位符即认为需要） */
function isMultiAgentMode(profile: LlmProfile | null): boolean {
  return !!profile?.multiConfig && (profile.multiConfig.deps?.length ?? 0) > 0;
}

/** 当前档案是否具备聊天能力：已配置直连 API，或为多智能体协同（走平台编排，档案自己的 Key 可缺省） */
export function supportsChat(): boolean {
  return isConfigured() || isMultiAgentMode(activeProfile());
}

/** 流中断（切后台/网络抖动/网关 5xx）：区别于普通报错，触发一次自动重试 */
export class StreamInterruptError extends Error {
  constructor(message = '网络连接中断，请重试') {
    super(message);
    this.name = 'StreamInterruptError';
  }
}

/** 用户主动停止生成：区别于网络错误，不重试、不标错，保留已生成内容 */
export class AbortedError extends Error {
  constructor(message = '已停止生成') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** 组装请求体（模型思考参数按供应商分流，未知参数会导致部分接口 400） */
function buildRequestBody(profile: LlmProfile, messages: unknown[], stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream,
    temperature: 0.8,
    max_tokens: 2048,
  };
  const { showThinking } = useAppStore.getState();
  // 智谱 GLM：thinking 参数开启思考（流式/非流式均支持）
  if (showThinking && /bigmodel|zhipu|glm/i.test(profile.baseUrl + ' ' + profile.model)) {
    body.thinking = { type: 'enabled' };
  }
  // DeepSeek V4（deepseek-v4-pro / deepseek-flash）：thinking 默认开启，
  // 关闭开关时必须显式传 disabled 模型才真的不思考（否则照样思考、响应慢）
  if (/deepseek/i.test(profile.baseUrl + ' ' + profile.model)) {
    body.thinking = { type: showThinking ? 'enabled' : 'disabled' };
  }
  // OpenAI 官方推理模型（o 系列 / gpt-5）：reasoning_effort 参数
  if (showThinking && /openai\.com/i.test(profile.baseUrl) && /(^|[-._])o[1-9]|gpt-5/i.test(profile.model)) {
    body.reasoning_effort = 'medium';
  }
  // DeepSeek-R1（deepseek-reasoner）原生返回 reasoning_content，无需传参
  return body;
}

type WireMsg = { role: string; content: string };

/** 组装请求消息：人设系统提示词 + 最近 20 条历史 + 思考语言约束 */
function buildMessages(history: ChatMsg[]): WireMsg[] {
  const messages: WireMsg[] = [{ role: 'system', content: buildSystemPrompt() }, ...history.slice(-20)];
  applyThinkingLang(messages);
  return messages;
}

/** 单轮非流式请求 */
async function requestOnce(profile: LlmProfile, messages: WireMsg[]): Promise<ChatResult> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildRequestBody(profile, messages, false);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
  };
  const msg = data.choices?.[0]?.message;
  const content = msg?.content;
  if (!content) throw new Error('接口未返回内容');
  const reasoning = (msg?.reasoning_content ?? msg?.reasoning ?? '').trim() || undefined;
  return { content, reasoning };
}

/** 最多工具轮次（联网搜索 + 技能合计；避免模型反复调用） */
const MAX_TOOL_ROUNDS = 3;

/** 剥离一轮回复中的全部工具指令（SEARCH/WEATHER/STOCK/FOOTBALL，含流式未闭合尾巴） */
function cleanToolText(text: string): string {
  const noSearch = extractSearchQuery(text).clean;
  return stripUnclosedToolTail(stripSkillDirectives(noSearch))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 执行一条平台技能，把 JSON 资料包成回注文本；失败/未登录也返回字符串，不中断对话 */
async function runSkillTool(call: SkillCall): Promise<string> {
  try {
    if (call.kind === 'weather') {
      const { city, day } = parseWeatherArg(call.arg);
      if (!city) return '【天气查询】没有解析出城市名，请向用户确认要查哪个城市后重试。';
      const data = await toolWeather(city, day);
      return `【天气资料·${city}】\n${JSON.stringify(data)}`;
    }
    if (call.kind === 'stock') {
      const kw = call.arg.trim();
      if (!kw) return '【股票行情】没有解析出股票名称或代码，请向用户确认。';
      const data = await toolStock(kw);
      return `【股票行情资料】\n${JSON.stringify(data)}`;
    }
    const date = normalizeFootballDate(call.arg);
    const data = await toolFootball(date);
    return `【竞彩足球资料·${date}】\n${JSON.stringify(data)}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/登录/.test(msg)) {
      return '【技能不可用】使用天气/股票/足彩技能需要先登录平台账号（聊天页右上角登录）。请提示用户登录后再试，不要编造数据。';
    }
    return `【技能执行失败】${call.kind} 查询出错：${msg}。请如实告诉用户这次没查到，不要编造数据。`;
  }
}

/**
 * 工具回路：模型在正文里输出隐藏指令表示「需要外部数据」，App 执行后把资料回注，
 * 再让它用人设回答。支持：
 * - [[SEARCH|查询词]] 联网搜索（用户自配搜索服务，最多占用同一轮次预算）
 * - [[WEATHER|城市 明天]] / [[STOCK|名称]] / [[FOOTBALL|日期]] 平台免费技能
 * 合计最多 MAX_TOOL_ROUNDS 轮；未启用任何能力时完全不介入（单轮直连）。
 */
async function runWithWeb(
  profile: LlmProfile,
  history: ChatMsg[],
  round: (messages: WireMsg[]) => Promise<ChatResult>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const spec = profile.capabilities?.spec?.web;
  const webEnabled = !!profile.capabilities?.enabled?.includes('web') && !!spec?.apiKey?.trim();
  const skillEnabled = new Set(
    (profile.capabilities?.enabled ?? []).filter((k): k is SkillKind => (SKILL_KINDS as string[]).includes(k)),
  );
  let messages = buildMessages(history);
  let visible = '';
  let reasoning = '';
  let toolRounds = 0;
  for (;;) {
    if (signal?.aborted) throw new AbortedError();
    const res = await round(messages);
    if (res.reasoning) reasoning = reasoning ? `${reasoning}\n${res.reasoning}` : res.reasoning;
    const { query } = extractSearchQuery(res.content);
    const skillHit = extractSkillCall(res.content);
    const skill = skillHit && skillEnabled.has(skillHit.kind) ? skillHit : null;
    visible += cleanToolText(res.content);
    if (toolRounds >= MAX_TOOL_ROUNDS || (!skill && !(webEnabled && query))) {
      return { content: visible, reasoning: reasoning || undefined };
    }
    toolRounds++;
    let extra = '';
    if (skill) {
      // 专用技能优先于通用联网搜索（结构化数据更准）
      extra = await runSkillTool(skill);
    } else {
      try {
        const list = await runWebSearch(spec, query ?? '');
        extra = buildSearchResultPrompt(query ?? '', list);
      } catch (e) {
        // 搜索失败不打断对话：如实告诉模型没查到，让它用已有知识回答
        extra = `【联网查询失败】查询词：「${query}」，原因：${e instanceof Error ? e.message : String(e)}。请如实告诉用户这次没查到（不要编造实时数据），或直接用你已有的知识回答。`;
      }
    }
    messages = [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: extra }];
  }
}

export async function requestChat(history: ChatMsg[]): Promise<ChatResult> {
  const profile = activeProfile();
  if (!profile) {
    throw new Error('尚未配置聊天 API：点聊天页顶部「未配置聊天 API」打开档案管理，在手机上直接创建（或桌面端创建后登录同一账号自动同步）');
  }
  // 多智能体协同：走后端编排接口（子智能体由服务端按配置调用，档案 Key 可缺省）
  if (isMultiAgentMode(profile)) {
    return orchestrateViaPlatform(history, {});
  }
  if (!profile.apiKey || !profile.baseUrl) {
    throw new Error(`API 档案「${profile.name}」缺少 Key 或接口地址，请在桌面端补全后重新同步`);
  }
  return runWithWeb(profile, history, (messages) => requestOnce(profile, messages));
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
}

/**
 * 流式聊天（OpenAI 兼容 SSE）。RN 的 fetch 不支持 response.body 流，
 * 这里用 XMLHttpRequest onprogress 增量读取 responseText 并解析 SSE：
 * 思考（reasoning_content）与正文（content）逐字回调，慢模型也有实时反馈。
 * 若接口拒绝流式（非 200）或在收到任何数据前出错，自动降级为非流式 requestOnce。
 */
async function streamOnce(profile: LlmProfile, messages: WireMsg[], cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildRequestBody(profile, messages, true);

  return new Promise<ChatResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${profile.apiKey}`);
    xhr.timeout = 300000;

    let lastLen = 0;
    let buffer = '';
    let content = '';
    let reasoning = '';
    let receivedAny = false;
    let settled = false;

    // 用户主动停止：中止底层请求，以 AbortedError 收口（调用方保留已生成内容，不标错）
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try { xhr.abort(); } catch { /* 已结束 */ }
      reject(new AbortedError());
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleChunk = (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      // SSE 以行为单位；不完整的末行留在 buffer
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        line = line.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
          };
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content || delta.reasoning) {
            const r = delta.reasoning_content ?? delta.reasoning ?? '';
            reasoning += r;
            cb.onReasoning?.(r);
          }
          if (delta.content) {
            content += delta.content;
            cb.onContent?.(delta.content);
          }
        } catch {
          // 心跳/非 JSON 行忽略
        }
      }
    };

    xhr.onprogress = (): void => {
      const text = xhr.responseText ?? '';
      if (text.length <= lastLen) return;
      receivedAny = true;
      handleChunk(text.slice(lastLen));
      lastLen = text.length;
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      // 冲刷最后不完整的 SSE 行（部分服务末尾不带换行）
      if (buffer.trim()) handleChunk('\n');
      if (!content.trim() && !reasoning.trim()) {
        reject(new Error('接口未返回内容'));
        return;
      }
      resolve({ content, reasoning: reasoning.trim() || undefined });
    };

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish();
        return;
      }
      const respText = (xhr.responseText ?? '').slice(0, 200);
      // 401/403/404 是明确的配置错误（Key 无效 / 接口地址或模型名不对）：
      // 直接透传服务端原文，重试毫无意义，也不要降级非流式
      if (xhr.status === 401 || xhr.status === 403 || xhr.status === 404) {
        settled = true;
        reject(
          new Error(
            `接口返回 ${xhr.status}${respText ? `：${respText}` : '（请检查 API Key、接口地址与模型名）'}`,
          ),
        );
        return;
      }
      if (!receivedAny) {
        // 其他 4xx（如接口不支持流式/参数被拒）：降级非流式，由 requestOnce 透传真实错误
        settled = true;
        requestOnce(profile, messages).then(resolve, reject);
      } else {
        // 收到数据后被网关打断（502/503 等）：可重试
        reject(new StreamInterruptError(`流式请求中断（HTTP ${xhr.status}${respText ? `：${respText}` : ''}）`));
      }
    };
    xhr.onerror = (): void => {
      if (!receivedAny) {
        // 连接从未建立：域名错误 / 地址路径不通 / TLS 失败 / 手机无网络。
        // 不再降级非流式（连接层问题只会再失败一次并浪费时间），直接给出可操作的错误
        settled = true;
        reject(
          new Error(
            `无法连接到接口地址（${url}）：请检查接口地址是否填写正确（通常以 /v1 结尾、不带 /chat/completions 后缀），以及手机网络是否正常`,
          ),
        );
      } else {
        reject(new StreamInterruptError());
      }
    };
    xhr.ontimeout = (): void => {
      reject(new StreamInterruptError());
    };
    xhr.send(JSON.stringify(body));
  });
}

/** 流式聊天入口（含联网查询回路：模型请求联网时先搜索再回答） */
export async function streamChat(history: ChatMsg[], cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
  const profile = activeProfile();
  if (!profile) {
    throw new Error('尚未配置聊天 API：点聊天页顶部「未配置聊天 API」打开档案管理，在手机上直接创建（或桌面端创建后登录同一账号自动同步）');
  }
  // 多智能体协同：走后端编排接口（非流式，一次返回最终答复）
  if (isMultiAgentMode(profile)) {
    return orchestrateViaPlatform(history, cb);
  }
  if (!profile.apiKey || !profile.baseUrl) {
    throw new Error(`API 档案「${profile.name}」缺少 Key 或接口地址，请在桌面端补全后重新同步`);
  }
  return runWithWeb(profile, history, (messages) => streamOnce(profile, messages, cb, signal), signal);
}
