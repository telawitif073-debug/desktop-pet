import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AbortedError,
  StreamInterruptError,
  applyThinkingLang,
  applyThinkingParams,
  createLLMService,
  extractDelta,
  thinkingLangSuffix,
} from './llmService';
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
    await expect(service.chat({ messages: [] })).rejects.toThrow('尚未配置聊天 API');
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

describe('思考参数按供应商分流（口径对齐手机端 llm.ts）', () => {
  it('DeepSeek：开启思考传 enabled，关闭时必须显式传 disabled', () => {
    expect(applyThinkingParams({}, 'https://api.deepseek.com/v1', 'deepseek-chat', true).thinking).toEqual({
      type: 'enabled',
    });
    expect(applyThinkingParams({}, 'https://api.deepseek.com/v1', 'deepseek-v4-pro', false).thinking).toEqual({
      type: 'disabled',
    });
  });

  it('智谱 GLM：仅在开启思考时注入 thinking', () => {
    expect(
      applyThinkingParams({}, 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', true).thinking
    ).toEqual({ type: 'enabled' });
    expect(
      applyThinkingParams({}, 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', false).thinking
    ).toBeUndefined();
  });

  it('OpenAI o 系列 / gpt-5：开启思考时注入 reasoning_effort', () => {
    expect(applyThinkingParams({}, 'https://api.openai.com/v1', 'o3-mini', true).reasoning_effort).toBe('medium');
    expect(applyThinkingParams({}, 'https://api.openai.com/v1', 'o3-mini', false).reasoning_effort).toBeUndefined();
  });

  it('未知供应商不注入任何思考参数（避免接口 400）', () => {
    const body = applyThinkingParams({}, 'https://api.test/v1', 'base-model', true);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('思考语言后缀（auto/zh/en）', () => {
  it('关闭思考或跟随模型时不追加任何内容', () => {
    expect(thinkingLangSuffix(false, 'zh')).toBe('');
    expect(thinkingLangSuffix(true, 'auto')).toBe('');
    expect(thinkingLangSuffix(true, undefined)).toBe('');
  });

  it('指定语言时追加到末条 user 消息，且不改动调用方数组', () => {
    const original = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: '你好' },
    ];
    const zh = applyThinkingLang(original, true, 'zh');
    expect(zh[1].content).toContain('内部思考过程 reasoning 必须从头到尾全程使用简体中文');
    expect(original[1].content).toBe('你好');
    const en = applyThinkingLang(original, true, 'en');
    expect(en[1].content).toContain('internal reasoning must be written entirely in English');
    // system 消息不变，只作用于末条 user
    expect(zh[0].content).toBe('sys');
  });

  it('多模态 user 消息：后缀追加到 text 段而非丢弃图像', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '看图' },
          { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,xx' } },
        ],
      },
    ];
    const out = applyThinkingLang(messages, true, 'zh');
    const parts = out[0].content as Array<{ type: string; text?: string; image_url?: unknown }>;
    expect(parts[0].text).toContain('全程使用简体中文');
    expect(parts[1].type).toBe('image_url');
  });
});

describe('reasoning 与正文分流（extractDelta / 流式回调）', () => {
  it('extractDelta 同时支持 delta 与 message 形态', () => {
    expect(
      extractDelta({ choices: [{ delta: { reasoning_content: '想', content: '答' } }] })
    ).toEqual({ reasoning: '想', content: '答' });
    expect(
      extractDelta({ choices: [{ delta: { reasoning: 'thinking' } }] })
    ).toEqual({ reasoning: 'thinking', content: '' });
    expect(
      extractDelta({ choices: [{ message: { content: '非流式正文' } }] })
    ).toEqual({ reasoning: '', content: '非流式正文' });
    expect(extractDelta(null)).toEqual({ reasoning: '', content: '' });
  });

  it('流式响应：思考与正文分别走 onReasoning / onChunk，返回值只含正文', async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一下' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '，再回答' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '，主人' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)));
    const reasonings: string[] = [];
    const contents: string[] = [];
    const service = createLLMService(() => makeConfig());
    const result = await service.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (c) => contents.push(c),
      onReasoning: (r) => reasonings.push(r),
    });
    expect(reasonings).toEqual(['先想一下', '，再回答']);
    expect(contents).toEqual(['你好', '，主人']);
    expect(result).toBe('你好，主人');
  });

  it('收数后被掐断：抛 StreamInterruptError（可自动重试）', async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          sent += 1;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半句' } }] })}\n\n`)
          );
          return;
        }
        controller.error(new Error('socket hang up'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const service = createLLMService(() => makeConfig());
    await expect(service.chat({ messages: [] })).rejects.toBeInstanceOf(StreamInterruptError);
  });

  it('401/403/404 直接透传错误，不降级非流式', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid api key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createLLMService(() => makeConfig());
    await expect(service.chat({ messages: [] })).rejects.toThrow(/接口返回 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('其他错误码：尚无数据时降级非流式，由非流式请求透传真实错误', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return new Response('stream not supported', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '降级成功' } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = createLLMService(() => makeConfig());
    await expect(service.chat({ messages: [] })).resolves.toBe('降级成功');
    expect(bodies[0].stream).toBe(true);
    expect(bodies[1].stream).toBe(false);
  });

  it('signal 已中止：抛 AbortedError（不重试、不标错）', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new Error('aborted');
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = createLLMService(() => makeConfig());
    await expect(service.chat({ messages: [], signal: controller.signal })).rejects.toBeInstanceOf(
      AbortedError
    );
  });
});
