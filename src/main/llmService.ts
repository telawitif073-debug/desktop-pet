import type { LLMConfig } from './config';

/** 视觉消息的图像段（OpenAI vision 兼容格式，透传给 API） */
export type MessageImage = { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本；附带图像时为多模态数组（text + image_url） */
  content: string | Array<{ type: 'text'; text: string } | MessageImage>;
}

export interface ChatOptions {
  messages: ChatMessage[];
  /** 正文（content）增量回调 */
  onChunk?: (chunk: string) => void;
  /** 思考过程（reasoning_content / reasoning）增量回调；与正文分流 */
  onReasoning?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LLMService {
  chat(options: ChatOptions): Promise<string>;
  isConfigured(): boolean;
}

/** 流中断（网关 5xx、连接被掐断）：区别于普通报错，调用方可自动重试一次 */
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

export type ThinkingLang = 'auto' | 'zh' | 'en';

/**
 * 思考语言指令：注入到最后一条用户消息（模型对最新用户消息的遵从度远高于 system，双保险之一）。
 * 口径与手机端 mobile/src/chat/llm.ts 完全一致：跟随（auto）或未开启思考时不干预。
 */
export function thinkingLangSuffix(showThinking: boolean, lang: ThinkingLang | undefined): string {
  if (!showThinking || lang === 'auto' || !lang) return '';
  if (lang === 'zh') {
    return '\n\n（系统强制要求：本次回复的内部思考过程 reasoning 必须从头到尾全程使用简体中文书写，每一句都用中文，严禁出现英文句子。此要求仅约束内部思考，正文不受影响。）';
  }
  return '\n\n(System requirement: your internal reasoning must be written entirely in English from start to finish. This applies only to reasoning; the reply is unaffected.)';
}

/**
 * 思考语言的系统提示词版本（与末条用户消息后缀构成「双保险」，口径对齐手机端 buildSystemPrompt）。
 * 措辞上明确「人设与要求仍优先约束正文」，避免与用户自定义系统提示词冲突。
 */
export function thinkingLangSystemPrompt(
  showThinking: boolean,
  lang: ThinkingLang | undefined
): string {
  if (!showThinking) return '';
  if (lang === 'zh') {
    return '【语言要求·最高优先级】你的内部思考过程（reasoning）必须从头到尾全程使用简体中文书写：每一句思考都用中文，除无法翻译的专有名词（如模型名、API 名）外，严禁出现英文单词、英文句子或其他任何语言的文字。此要求只约束内部思考；正文回复不受影响，仍完全遵循上述人设与要求。';
  }
  if (lang === 'en') {
    return '[LANGUAGE REQUIREMENT - HIGHEST PRIORITY] Your internal reasoning (thinking) must be written entirely in English from start to finish: every sentence of reasoning in English, with no words or sentences in any other language except untranslatable proper nouns (such as model or API names). This applies only to internal reasoning; the visible reply is unaffected and must fully follow the persona above.';
  }
  return '';
}

/** 把思考语言指令追加到最后一条 user 消息（不改动调用方数组，仅请求时生效、不落库） */
export function applyThinkingLang(
  messages: ChatMessage[],
  showThinking: boolean,
  lang: ThinkingLang | undefined
): ChatMessage[] {
  const suffix = thinkingLangSuffix(showThinking, lang);
  if (!suffix) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content =
      typeof msg.content === 'string'
        ? msg.content + suffix
        : msg.content.map((part) =>
            part.type === 'text' ? { ...part, text: part.text + suffix } : part
          );
    const next = messages.slice();
    next[i] = { ...msg, content };
    return next;
  }
  return messages;
}

/**
 * 思考参数按供应商分流（未知参数会导致部分接口 400，因此只在匹配时注入）。
 * 口径与手机端 llm.ts buildRequestBody 一致：
 * - 智谱 GLM：showThinking 时 thinking={type:'enabled'}；
 * - DeepSeek V4 系列：thinking 默认开启，必须显式传 disabled 才真的不思考；
 * - OpenAI o 系列 / gpt-5：reasoning_effort='medium'（仅 showThinking）；
 * - deepseek-reasoner 等原生推理模型无需传参（原生返回 reasoning_content）。
 */
export function applyThinkingParams(
  body: Record<string, unknown>,
  baseUrl: string,
  model: string,
  showThinking: boolean
): Record<string, unknown> {
  const target = `${baseUrl} ${model}`;
  if (showThinking && /bigmodel|zhipu|glm/i.test(target)) {
    body.thinking = { type: 'enabled' };
  }
  if (/deepseek/i.test(target)) {
    body.thinking = { type: showThinking ? 'enabled' : 'disabled' };
  }
  if (showThinking && /openai\.com/i.test(baseUrl) && /(^|[-._])o[1-9]|gpt-5/i.test(model)) {
    body.reasoning_effort = 'medium';
  }
  return body;
}

/** 单条 SSE delta 的增量分流（reasoning_content / reasoning / content），非流式 message 亦可复用 */
export function extractDelta(payload: unknown): { reasoning: string; content: string } {
  const node = payload as {
    choices?: Array<{
      delta?: { content?: string; reasoning_content?: string; reasoning?: string };
      message?: { content?: string; reasoning_content?: string; reasoning?: string };
    }>;
  } | null;
  const choice = node?.choices?.[0];
  const part = choice?.delta ?? choice?.message;
  if (!part) return { reasoning: '', content: '' };
  const reasoning = part.reasoning_content ?? part.reasoning ?? '';
  return { reasoning, content: typeof part.content === 'string' ? part.content : '' };
}

/** 组装请求体（含 thinking 参数；messages 由调用方保证已应用思考语言后缀） */
function buildRequestBody(
  config: LLMConfig,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    temperature: config.temperature ?? 0.8,
    // 2048：推理模型的思维链会占用输出额度，过低会导致正式内容为空
    max_tokens: 2048,
  };
  return applyThinkingParams(body, config.baseUrl, config.model, config.showThinking === true);
}

async function streamChat(
  config: LLMConfig,
  options: ChatOptions,
  messages: ChatMessage[]
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify(buildRequestBody(config, messages, true));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw new AbortedError();
    // 连接从未建立：域名错误 / 地址路径不通 / TLS 失败 / 无网络。降级非流式只会再失败一次
    throw new Error(
      `无法连接到接口地址（${url}）：请检查接口地址是否填写正确（通常以 /v1 结尾、不带 /chat/completions 后缀），以及网络是否正常`
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // 401/403/404 是明确的配置错误（Key 无效 / 接口地址或模型名不对）：透传服务端原文，不降级、重试无意义
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(
        `接口返回 ${response.status}${errorText ? `：${errorText.slice(0, 200)}` : '（请检查 API Key、接口地址与模型名）'}`
      );
    }
    // 其他错误（接口不支持流式 / 参数被拒 / 网关 5xx）：尚无任何数据，降级非流式由 requestOnce 透传真实错误
    return await nonStreamChat(config, options, messages);
  }

  if (!response.body) {
    throw new Error('No response body from LLM API');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let reasoningText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 心跳 / 非 JSON 行忽略
        }
        const delta = extractDelta(json);
        if (delta.reasoning) {
          reasoningText += delta.reasoning;
          options.onReasoning?.(delta.reasoning);
        }
        if (delta.content) {
          fullText += delta.content;
          options.onChunk?.(delta.content);
        }
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throw new AbortedError();
    // 收到过数据后被网关/网络掐断：可重试
    throw new StreamInterruptError(
      `流式请求中断：${err instanceof Error ? err.message : String(err)}`
    );
  }

  return requireOutput(fullText, reasoningText);
}

/** 非流式单轮请求（流式降级路径与不支持流式的接口共用） */
async function nonStreamChat(
  config: LLMConfig,
  options: ChatOptions,
  messages: ChatMessage[]
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify(buildRequestBody(config, messages, false));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) throw new AbortedError();
    throw new Error(`无法连接到接口地址（${url}）：请检查接口地址与网络是否正常`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `接口返回 ${response.status}${errorText ? `：${errorText.slice(0, 200)}` : ''}`
    );
  }

  const json = (await response.json()) as unknown;
  const delta = extractDelta(json);
  if (delta.reasoning) options.onReasoning?.(delta.reasoning);
  if (delta.content) options.onChunk?.(delta.content);
  return requireOutput(delta.content, delta.reasoning);
}

/** 空回复判定：思维链也算输出（仅有 reasoning 时正文交由界面提示，不再当作错误） */
function requireOutput(content: string, reasoning: string): string {
  if (!content.trim() && !reasoning.trim()) {
    throw new Error('接口未返回内容');
  }
  return content;
}

export function createLLMService(getConfig: () => LLMConfig): LLMService {
  return {
    isConfigured() {
      const config = getConfig();
      return !!(config.apiKey && config.model && config.baseUrl);
    },

    async chat(options: ChatOptions): Promise<string> {
      const config = getConfig();
      // 未配置档案：API 全部由用户在客户端配置，给出明确指引而非 401 报错
      if (!config.apiKey || !config.baseUrl) {
        throw new Error('尚未配置聊天 API：请打开设置，在「API 配置」中新增并保存');
      }
      // 档案级思考开关/语言：只影响本次请求体与末条用户消息，不落库
      const messages = applyThinkingLang(
        options.messages,
        config.showThinking === true,
        config.thinkingLang
      );
      const result = await streamChat(config, options, messages);
      if (!result.trim()) {
        // 仅思维链、无正文：多数推理模型 max_tokens 被思考耗尽（已生成的思考过程界面仍会保留）
        throw new Error(
          'AI 返回内容为空：推理类模型（如 deepseek-reasoner）的思维链可能耗尽了输出额度，请换用非推理模型（如 deepseek-chat）后重试'
        );
      }
      return result;
    },
  };
}