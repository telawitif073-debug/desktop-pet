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

export async function requestChat(history: ChatMsg[]): Promise<ChatResult> {
  const store = useAppStore.getState();
  const profile = activeProfile();
  if (!profile) {
    throw new Error('尚未配置聊天 API：点聊天页顶部「未配置聊天 API」打开档案管理，在手机上直接创建（或桌面端创建后登录同一账号自动同步）');
  }
  if (!profile.apiKey || !profile.baseUrl) {
    throw new Error(`API 档案「${profile.name}」缺少 Key 或接口地址，请在桌面端补全后重新同步`);
  }
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history.slice(-20)];
  const body: Record<string, unknown> = { model: profile.model, messages, stream: false, temperature: 0.8, max_tokens: 2048 };
  // 显示思考过程：thinking 参数仅智谱 GLM 系列支持（未知参数会导致部分接口 400）；
  // DeepSeek-R1（deepseek-reasoner）等推理模型原生返回 reasoning_content，无需传参
  if (store.showThinking && /bigmodel|zhipu|glm/i.test(profile.baseUrl + ' ' + profile.model)) {
    body.thinking = { type: 'enabled' };
  }
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
