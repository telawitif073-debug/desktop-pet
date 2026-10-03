/**
 * 智能体技能（平台免费提供，服务端代理，用户无需配 Key）。
 *
 * 与「联网查询」同一套隐藏指令思路（不依赖 function calling）：
 * - 模型在正文输出 [[WEATHER|城市 明天]] / [[STOCK|名称或代码]] / [[FOOTBALL|今天]]
 * - App 调平台 /api/tools/* 取回中文 JSON，作为资料回注
 * - 模型再以自己的人设口吻回答（见 chat/llm.ts 的工具回路）
 *
 * 数据时效与口径以服务端返回为准；本模块只负责指令协议、参数拆分与结果文案化。
 * 纯逻辑模块（禁止 import appStore / api/platform，node 单测直跑）；执行见 chat/llm.ts。
 */

export type SkillKind = 'weather' | 'stock' | 'football';

export const SKILL_KINDS: SkillKind[] = ['weather', 'stock', 'football'];

/** 技能元信息（编辑表单/提示词共用） */
export const SKILL_META: Record<SkillKind, { label: string; desc: string; directive: string; example: string }> = {
  weather: {
    label: '查询天气',
    desc: '问任何城市的实时天气与未来两天预报（平台免费提供，无需配置）',
    directive: 'WEATHER',
    example: '[[WEATHER|长春 明天]]',
  },
  stock: {
    label: '查询股票行情',
    desc: '查 A 股实时股价、涨跌幅、成交额等（沪深两市，平台免费提供）',
    directive: 'STOCK',
    example: '[[STOCK|贵州茅台]]',
  },
  football: {
    label: '查询竞彩足球',
    desc: '查竞彩足球在售赛程与胜平负/让球赔率（平台免费提供，理性看待、仅供参考）',
    directive: 'FOOTBALL',
    example: '[[FOOTBALL|明天]]',
  },
};

// ── 指令提取（纯逻辑，可单测）────────────────────────────────────────────

const KIND_BY_DIRECTIVE: Record<string, SkillKind> = {
  WEATHER: 'weather',
  STOCK: 'stock',
  FOOTBALL: 'football',
};

/** 单个技能指令（闭合） */
export interface SkillCall {
  kind: SkillKind;
  arg: string;
  /** 指令在原文中的起始下标（多指令共存时取最靠前的） */
  index: number;
}

const SKILL_TOKEN_RE = /\[\[\s*(WEATHER|STOCK|FOOTBALL)\s*[|｜]\s*([\s\S]*?)\s*\]\]/gi;

/** 从模型回复中提取最靠前的一条技能指令（无则 null） */
export function extractSkillCall(text: string): SkillCall | null {
  SKILL_TOKEN_RE.lastIndex = 0;
  let best: SkillCall | null = null;
  let m: RegExpExecArray | null;
  while ((m = SKILL_TOKEN_RE.exec(text))) {
    const kind = KIND_BY_DIRECTIVE[m[1].toUpperCase()];
    if (!kind) continue;
    const arg = m[2].trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '').slice(0, 60);
    if (!best || m.index < best.index) best = { kind, arg, index: m.index };
  }
  return best;
}

/** 剥离全部技能指令（闭合的）；返回干净正文 */
export function stripSkillDirectives(text: string): string {
  return text.replace(SKILL_TOKEN_RE, '');
}

/** 剥离未闭合的指令尾巴（流式输出时「[[WEATHER|长春」不该闪现在气泡里） */
export function stripUnclosedToolTail(text: string): string {
  const idx = text.lastIndexOf('[[');
  if (idx < 0) return text;
  const tail = text.slice(idx);
  if (tail.includes(']]')) return text;
  if (/^\[\[\s*(WEATHER|STOCK|FOOTBALL|SEARCH|weathe|weath|wea|we|stock|stoc|sto|st|footbal|footba|footb|foot|foo|fo|sear|sea|se|s)?\s*[|｜]?/i.test(tail)) {
    return text.slice(0, idx);
  }
  return text;
}

// ── 参数拆分（纯逻辑）────────────────────────────────────────────────────

/** 「长春 明天」→ { city: '长春', day: 1 }；支持 今天/明天/后天 与 0/1/2 */
export function parseWeatherArg(arg: string): { city: string; day: number } {
  let day = 0;
  let city = arg.trim();
  if (/后天|[2２]\s*$/.test(city)) day = 2;
  else if (/明天|[1１]\s*$/.test(city)) day = 1;
  city = city.replace(/[，,。.\s]*(今天|明天|后天|[0-2０-２])\s*$/g, '').trim();
  return { city, day };
}

/** 足彩日期口语化：今天/明天/后天/YYYY-MM-DD；空串=今天 */
export function normalizeFootballDate(arg: string): string {
  const t = arg.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) {
    const [y, mo, d] = t.split('-');
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const offset = /后天/.test(t) ? 2 : /明天/.test(t) ? 1 : 0;
  const d = new Date(Date.now() + offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 提示词 ───────────────────────────────────────────────────────────────

/** 合成已启用技能的协议提示词（只注入启用的技能） */
export function buildSkillsPrompt(enabled: SkillKind[]): string {
  if (!enabled.length) return '';
  const lines = [
    '【实时技能】你有以下由平台免费提供的实时技能，只在用户确实问到对应实时信息时使用：',
  ];
  if (enabled.includes('weather')) {
    lines.push(
      '· 天气：用户问任何城市天气/气温/下不下雨时，正文只输出一行隐藏指令（用户看不到，不要解释）' + SKILL_META.weather.example + '（城市名 + 可选「今天/明天/后天」，省略=今天），然后停下等资料',
    );
  }
  if (enabled.includes('stock')) {
    lines.push(
      '· 股票：用户问 A 股股价/涨跌/行情时，输出 ' + SKILL_META.stock.example + '（名称、拼音或 6 位代码均可），然后停下等资料；不预测走势、不给买卖建议，只陈述数据并提醒投资有风险',
    );
  }
  if (enabled.includes('football')) {
    lines.push(
      '· 竞彩足球：用户问足彩赛程/赔率/今天有什么比赛时，输出 ' + SKILL_META.football.example + '（今天/明天/后天或 YYYY-MM-DD，省略=今天），然后停下等资料；只客观转述数据，不怂恿购彩、不保证赛果',
    );
  }
  lines.push(
    '· 一次只输出一条指令，等 App 把资料回给你后，再用你的人设口吻、简短口语化地回答；数字/时间以资料为准，不要编造',
    '· 普通闲聊或这些技能之外的问题不要输出指令；技能查不到（ok:false 或列表为空）就如实转告，不要硬答',
  );
  return lines.join('\n');
}
