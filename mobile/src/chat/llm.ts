/**
 * 手机端直连用户 LLM API（OpenAI 兼容 /chat/completions，非流式）。
 * 档案从云同步的 config 来（Key 由服务端解密下发）；人设 = 已安装智能体 + 宠物自我描述。
 */
import { useAppStore } from '../store/appStore';
import type { ChatMsg, LlmProfile } from '../types';

const DEFAULT_SYSTEM = '你是一只可爱的桌面宠物，说话简短活泼、口语化，单次回复尽量不超过 80 字。';

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
  const parts: string[] = [];
  if (installedAgent?.systemPrompt) parts.push(String(installedAgent.systemPrompt));
  else parts.push(DEFAULT_SYSTEM);
  if (petName && petName !== '小宠') parts.push(`你的名字叫「${petName}」，用户会用这个名字称呼你。`);
  if (userNickname.trim()) parts.push(`请用「${userNickname.trim()}」来称呼用户。`);
  if (petSelfDescription) parts.push(`你的形象：${petSelfDescription}`);
  // 思考过程语言（DeepSeek 风格设置）：跟随回复=不干预；指定语言时约束内部推理书写语言，
  // 措辞上明确「人设与要求仍优先约束正文」，避免与用户设置的系统提示词冲突
  if (showThinking && thinkingLang === 'zh') {
    parts.push('补充要求：正文回复仍完全遵循上述人设与要求；仅内部思考过程（reasoning）请用中文书写。');
  }
  if (showThinking && thinkingLang === 'en') {
    parts.push(
      'Additional requirement: the reply text must fully follow the persona above; only your internal reasoning (thinking) should be written in English.',
    );
  }
  return parts.join('\n');
}

export interface ChatResult {
  content: string;
  reasoning?: string;
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
  const body = buildRequestBody(profile, messages, true);

  return new Promise<ChatResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${profile.apiKey}`);
    xhr.timeout = 120000;

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
      if (!content && !reasoning) {
        reject(new Error('接口未返回内容'));
        return;
      }
      resolve({ content, reasoning: reasoning.trim() || undefined });
    };

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish();
      } else if (!receivedAny) {
        // 流式被拒绝（如接口不支持）：降级非流式
        settled = true;
        requestChat(history).then(resolve, reject);
      } else {
        reject(new Error(`流式请求中断（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = (): void => {
      if (!receivedAny) {
        settled = true;
        requestChat(history).then(resolve, reject);
      } else {
        reject(new Error('网络连接中断，请重试'));
      }
    };
    xhr.ontimeout = (): void => {
      reject(new Error('响应超时，请重试'));
    };
    xhr.send(JSON.stringify(body));
  });
}
