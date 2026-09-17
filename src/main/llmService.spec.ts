import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMService } from './llmService';
import type { LLMConfig } from './config';

function makeConfig(over: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.test/v1',
    model: 'base-model',
    systemPrompt: '',
    ...over,
  };
}

// 构造 SSE 流式响应（llmService 按 "data: {...}" 行解析）
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const sseBody = (content: string): string[] => [
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  'data: [DONE]\n\n',
];

describe('llmService 智能体 temperature 生效', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未配置 apiKey 时 isConfigured 为 false 且 chat 抛出配置错误', async () => {
    const service = createLLMService(() => makeConfig({ apiKey: '' }));
    expect(service.isConfigured()).toBe(false);
    await expect(service.chat({ messages: [] })).rejects.toThrow(
      'LLM API key not configured'
    );
  });

  it('未设置 temperature 时请求体使用默认 0.8，并正确拼接流式内容', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([...sseBody('你好'), ...sseBody('，主人')]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(() => makeConfig());
    const result = await service.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toBe('你好，主人');
    expect(bodies[0].temperature).toBe(0.8);
    expect(bodies[0].model).toBe('base-model');
    expect(bodies[0].stream).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('智能体提供的 temperature 覆盖默认值', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse(sseBody('ok'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = createLLMService(() => makeConfig({ temperature: 0.3 }));
    await service.chat({ messages: [] });

    expect(bodies[0].temperature).toBe(0.3);
  });

  it('isConfigured 要求 apiKey / model / baseUrl 齐全', () => {
    expect(createLLMService(() => makeConfig()).isConfigured()).toBe(true);
    expect(
      createLLMService(() => makeConfig({ model: '' })).isConfigured()
    ).toBe(false);
    expect(
      createLLMService(() => makeConfig({ baseUrl: '' })).isConfigured()
    ).toBe(false);
  });
});
