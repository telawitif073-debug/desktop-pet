/**
 * 智能体联网查询（用户自配搜索服务，属于该智能体自己的能力）。
 *
 * 设计：
 * - 不依赖模型是否支持 function calling：模型通过在正文里输出隐藏指令
 *   [[SEARCH|查询词]] 表示「我需要联网」，App 执行搜索后把结果作为资料回注，
 *   再让模型用自己的人格回答（见 chat/llm.ts 的两阶段回路）。
 * - 搜索服务由用户自己配置（博查 / Serper / Tavily），按各家的计费规则产生费用，
 *   因此编辑表单里会带一行代价提示；不开启能力的智能体完全不走网络搜索。
 */
import type { WebSearchSpec } from './types';

/** 单条搜索结果 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 来源站点名（博查 siteName 等），可帮助模型判断可信度 */
  siteName?: string;
  /** 页面发布/最近抓取日期（博查 dateLastCrawled），帮助模型判断时效性 */
  date?: string;
}

const PROVIDER_ENDPOINT: Record<WebSearchSpec['provider'], string> = {
  bocha: 'https://api.bochaai.com/v1/web-search',
  serper: 'https://google.serper.dev/search',
  tavily: 'https://api.tavily.com/search',
};

export const PROVIDER_LABEL: Record<WebSearchSpec['provider'], string> = {
  bocha: '博查（bochaai.com）',
  serper: 'Serper（google.serper.dev）',
  tavily: 'Tavily（tavily.com）',
};

/** 联网能力的代价提示（编辑表单里的一行小字） */
export const WEB_COST_HINT =
  '联网查询会调用你自己配置的搜索服务，按其计费规则按次产生费用（博查/Serper/Tavily 均有免费额度或按次付费）；不开启时智能体只用自身知识回答，不产生任何搜索费用。';

/** 隐藏指令：模型输出 [[SEARCH|查询词]] 表示需要联网（用户不可见，渲染时剥离） */
export const SEARCH_DIRECTIVE_RE = /\[\[\s*SEARCH\s*[|｜]\s*([\s\S]*?)\s*\]\]/gi;

/** 从模型回复里取出第一条查询词（同时返回剥离指令后的正文） */
export function extractSearchQuery(text: string): { clean: string; query: string } {
  let query = '';
  const clean = text.replace(
    new RegExp(SEARCH_DIRECTIVE_RE.source, 'gi'),
    (_raw, q: string) => {
      const t = String(q ?? '').trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '');
      if (!query && t) query = t.slice(0, 100);
      return '';
    },
  );
  // 未写完的指令尾巴（如「[[SEARCH|长春」）也清掉，避免闪现在气泡里
  const idx = clean.lastIndexOf('[[');
  const safe = idx >= 0 && /^\[\[\s*(SEARCH|sear|sea|se|s)?\s*[|｜]?/i.test(clean.slice(idx)) ? clean.slice(0, idx) : clean;
  return { clean: safe.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), query };
}

/** 合成「联网」能力提示词（只在启用该能力的智能体上下发） */
export function buildWebPrompt(): string {
  const lines = [
    '【联网查询】你有联网查询能力，但只在确实需要时使用：',
    '· 需要联网的情形：实时/最新信息（天气、新闻、股价、汇率、赛况、航班、路况）、你不确定或可能已过时的事实、用户明确让你「查一下/搜一下」',
    '· 需要时：正文只输出一行隐藏指令（用户看不到，也不要解释它）——[[SEARCH|查询关键词]]，然后停下等资料；App 会把搜索结果回给你，你再据此回答',
    '· 查询关键词的写法：用 2~6 个核心名词组合（如「长春 天气」「iPhone 17 发布 价格」），不要照抄用户整句话、不要带语气词和人称；涉及最新动态时在关键词里带上年份/月份',
    '· 不需要时：正常回答，绝不输出该指令（普通闲聊、常识、写作、情绪陪伴都不要查）',
    '· 拿到资料后：用你自己的人设口吻回答，数字/时间/地名要与资料一致，别编造；资料不足就直说没查到，最多再查一次',
  ];
  return lines.join('\n');
}

/** 把搜索结果拼成回注给模型的资料块（无结果时给出明确的「没查到」） */
export function buildSearchResultPrompt(query: string, list: WebSearchResult[], now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const head = `【联网查询结果】查询词：「${query}」，查询时间：${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hh}:${mm}`;
  if (!list.length) {
    return `${head}\n没有查到相关结果。请坦诚告诉用户你没查到，不要编造；也可以换个说法再输出一次 [[SEARCH|新的查询词]]（最多再查一次）。`;
  }
  const body = list
    .slice(0, 5)
    .map((r, i) => {
      const meta = [r.siteName, r.date].filter(Boolean).join(' · ');
      const lines = [`${i + 1}. ${r.title}${meta ? `（${meta}）` : ''}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      if (r.url) lines.push(`   来源：${r.url}`);
      return lines.join('\n');
    })
    .join('\n');
  return `${head}\n${body}\n请据此用你的人设口吻回答用户（内容要与资料一致，不要编造；资料没覆盖的点就说没查到；注意资料的日期，过时信息要说明）。如果仍然缺少关键信息，可以再输出一次 [[SEARCH|新的查询词]]（最多再查一次）。`;
}

function pick(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 博查日期字段统一截到 YYYY-MM-DD（原始是 ISO 时间戳，太长） */
function shortDate(v: unknown): string {
  const s = pick(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** 按提供商解析响应（各家字段不同，统一成 title/url/snippet/siteName/date） */
function parseResults(provider: WebSearchSpec['provider'], json: unknown): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const root = (json ?? {}) as Record<string, unknown>;
  const pushList = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      const o = (it ?? {}) as Record<string, unknown>;
      const title = pick(o.title ?? o.name);
      const url = pick(o.url ?? o.link);
      const snippet = pick(o.snippet ?? o.content ?? o.summary ?? o.description);
      if (title || snippet) {
        out.push({
          title: title || url || '（无标题）',
          url,
          snippet: snippet.slice(0, 600),
          siteName: pick(o.siteName ?? o.site_name ?? o.source) || undefined,
          date: shortDate(o.datePublished ?? o.dateLastCrawled ?? o.published ?? o.date) || undefined,
        });
      }
    }
  };
  if (provider === 'bocha') {
    // 博查响应：data.webPages.value[]；summary=true 时还有 data.webPages.summary（整体摘要，优先用）
    const data = (root.data ?? {}) as Record<string, unknown>;
    const pages = (data.webPages ?? data.web_pages ?? {}) as Record<string, unknown>;
    // 博查的整体摘要（summary=true 时返回）：比逐条 snippet 更连贯，作为第 0 条「综述」注入
    const overall = pick(pages.summary);
    if (overall) {
      out.push({ title: '搜索综述', url: '', snippet: overall.slice(0, 900) });
    }
    pushList(pages.value ?? pages.values);
  } else if (provider === 'serper') {
    // Serper 的答案框（answerBox）是最直接的答案，优先级最高
    pushList(root.answerBox ? [root.answerBox] : []);
    pushList(root.organic);
  } else {
    pushList(root.results);
  }
  return out.slice(0, 6);
}

/** 执行一次联网查询（失败抛错，由调用方决定是否降级为「没查到」） */
export async function runWebSearch(
  spec: WebSearchSpec | undefined,
  query: string,
  timeoutMs = 15000,
): Promise<WebSearchResult[]> {
  const key = spec?.apiKey?.trim();
  if (!key) throw new Error('该智能体还没配置搜索服务的 API Key');
  const provider = spec?.provider ?? 'bocha';
  const endpoint = spec?.endpoint?.trim() || PROVIDER_ENDPOINT[provider];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: Record<string, unknown>;
  if (provider === 'serper') {
    headers['X-API-KEY'] = key;
    body = { q: query, num: 10 };
  } else if (provider === 'tavily') {
    body = { api_key: key, query, max_results: 5, search_depth: 'basic' };
  } else {
    headers.Authorization = `Bearer ${key}`;
    body = { query, count: 10, summary: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`搜索服务返回 ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`);
    }
    return parseResults(provider, await res.json());
  } finally {
    clearTimeout(timer);
  }
}