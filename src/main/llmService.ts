import type { LLMConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LLMService {
  chat(options: ChatOptions): Promise<string>;
  isConfigured(): boolean;
}

async function streamChat(
  config: LLMConfig,
  options: ChatOptions
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: config.model,
    messages: options.messages,
    stream: true,
    temperature: 0.8,
    max_tokens: 1024,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body from LLM API');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

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

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          options.onChunk?.(delta);
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  return fullText;
}

async function nonStreamChat(
  config: LLMConfig,
  options: ChatOptions
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: config.model,
    messages: options.messages,
    stream: false,
    temperature: 0.8,
    max_tokens: 1024,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || '';
  options.onChunk?.(content);
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
      if (!config.apiKey) {
        throw new Error('LLM API key not configured. Please set it in settings.');
      }

      // Try streaming first, fall back to non-streaming
      try {
        return await streamChat(config, options);
      } catch (err) {
        // If streaming fails due to non-streaming endpoint, try non-streaming
        if (err instanceof Error && err.message.includes('stream')) {
          return await nonStreamChat(config, options);
        }
        throw err;
      }
    },
  };
}
