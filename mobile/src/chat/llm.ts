/**
 * 手机端直连用户 LLM API（OpenAI 兼容 /chat/completions，非流式）。
 * 档案从云同步的 config 来（Key 由服务端解密下发）；人设 = 已安装智能体 + 宠物自我描述。
 */
import { useAppStore } from '../store/appStore';
import type { ChatMsg, LlmProfile, PetState } from '../types';

const DEFAULT_SYSTEM = '你是一只可爱的桌面宠物，说话简短活泼、口语化，单次回复尽量不超过 80 字。';

/** 宠物状态 → 自然语言描述（与桌面端 describePetState 同规则），空串表示状态平淡 */
function describePetState(state: PetState): string {
  const parts: string[] = [];
  if (state.hunger < 30) parts.push('现在有点饿了');
  else if (state.hunger > 80) parts.push('吃得很饱');
  if (state.mood < 30) parts.push('心情不太好');
  else if (state.mood > 80) parts.push('心情很好');
  if (state.energy < 30) parts.push('有点累了想休息');
  else if (state.energy > 80) parts.push('精力充沛');
  if (state.affection > 80) parts.push('和主人很亲近');
  else if (state.affection < 20) parts.push('还不太熟悉主人');
  return parts.join('，');
}

export function activeProfile(): LlmProfile | null {
  const { llmProfiles, llmActiveProfileId } = useAppStore.getState();
  return llmProfiles.find((p) => p.id === llmActiveProfileId) ?? llmProfiles[0] ?? null;
}

export function isConfigured(): boolean {
  const profile = activeProfile();
  return !!(profile?.apiKey && profile?.baseUrl && profile?.model);
}

function buildSystemPrompt(): string {
  const { installedAgent, petSelfDescription, petName, userNickname, showThinking, thinkingLang } = useAppStore.getState();
  // API 档案里的系统提示词（与桌面端 getLLMConfig 一致：填了即作为人格主体，没填才用默认宠物人格）
  const profilePrompt = activeProfile()?.systemPrompt?.trim();
  const parts: string[] = [];
  parts.push(profilePrompt || DEFAULT_SYSTEM);
  // 已安装智能体人设（若有）追加生效；与档案提示词相同时跳过（安装时已写入档案，避免重复拼接）
  const agentPrompt = installedAgent?.systemPrompt ? String(installedAgent.systemPrompt).trim() : '';
  if (agentPrompt && agentPrompt !== profilePrompt) parts.push(agentPrompt);
  if (petName && petName !== '小宠') parts.push(`你的名字叫「${petName}」，用户会用这个名字称呼你。`);
  if (userNickname.trim()) parts.push(`请用「${userNickname.trim()}」来称呼用户。`);
  if (petSelfDescription) parts.push(`你的形象：${petSelfDescription}`);
  // 宠物状态实装：状态注入提示词，智能体语气随状态变化（开关关闭时三项固定 80，好感度始终真实）
  const { petState, petStateEnabled } = useAppStore.getState();
  const effectiveState = petStateEnabled ? petState : { ...petState, hunger: 80, mood: 80, energy: 80 };
  const stateDesc = describePetState(effectiveState);
  parts.push(`你当前的状态：${stateDesc || '平静正常'}（饱足/心情/精力/好感会影响你的语气，可自然融入回复，不要生硬罗列数值）`);
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

/** 流中断（切后台/网络抖动/网关 5xx）：区别于普通报错，触发一次自动重试 */
export class StreamInterruptError extends Error {
  constructor(message = '网络连接中断，请重试') {
    super(message);
    this.name = 'StreamInterruptError';
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

export async function requestChat(history: ChatMsg[]): Promise<ChatResult> {
  const profile = activeProfile();
  if (!profile) {
    throw new Error('尚未配置聊天 API：点聊天页顶部「未配置聊天 API」打开档案管理，在手机上直接创建（或桌面端创建后登录同一账号自动同步）');
  }
  if (!profile.apiKey || !profile.baseUrl) {
    throw new Error(`API 档案「${profile.name}」缺少 Key 或接口地址，请在桌面端补全后重新同步`);
  }
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history.slice(-20)];
  applyThinkingLang(messages);
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

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
}

/**
 * 流式聊天（OpenAI 兼容 SSE）。RN 的 fetch 不支持 response.body 流，
 * 这里用 XMLHttpRequest onprogress 增量读取 responseText 并解析 SSE：
 * 思考（reasoning_content）与正文（content）逐字回调，慢模型也有实时反馈。
 * 若接口拒绝流式（非 200）或在收到任何数据前出错，自动降级为非流式 requestChat。
 */
export async function streamChat(history: ChatMsg[], cb: StreamCallbacks): Promise<ChatResult> {
  const profile = activeProfile();
  if (!profile) {
    throw new Error('尚未配置聊天 API：点聊天页顶部「未配置聊天 API」打开档案管理，在手机上直接创建（或桌面端创建后登录同一账号自动同步）');
  }
  if (!profile.apiKey || !profile.baseUrl) {
    throw new Error(`API 档案「${profile.name}」缺少 Key 或接口地址，请在桌面端补全后重新同步`);
  }
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history.slice(-20)];
  applyThinkingLang(messages);
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
        // 其他 4xx（如接口不支持流式/参数被拒）：降级非流式，由 requestChat 透传真实错误
        settled = true;
        requestChat(history).then(resolve, reject);
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
