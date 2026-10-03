/**
 * 智能体自带能力·检测与合成（纯逻辑，Node 可直跑单测）。
 *
 * 用户上传的智能体 JSON（人设卡 / 角色卡）里可能声明「主动执行」能力，例如：
 *   { agent_name, persona:{...}, active_execution:{ natural_language_to_cron, task_types, task_management,
 *     frequency_control:{max_active_tasks_per_day, avoid_spam, interval_minutes}, waking_hours }, example_tasks:[{user_input}] }
 * 本模块负责：
 *   1) 从任意形状的导入 JSON 中检测出这些能力（宽口径：结构键 + 中文语义双通道），供导入时询问用户是否添加；
 *   2) 把能力按该 JSON 的规格合成进提示词（示例任务/搭话时段/频率约束都取自它自己，而不是应用默认）。
 *
 * 能力口径（与导入弹窗、编辑表单一致）：
 *   tasks    = 根据用户需求创建定时任务（到点由智能体主动开口）
 *   proactive= 无需用户排期，空闲时自己找用户搭话
 */
import type { AgentCapabilityKind, AgentCapabilitySpec } from './types';

/** 检测结果：命中的能力 + 从 JSON 读到的规格 + 命中依据（给用户看） */
export interface CapabilityDetection {
  kinds: AgentCapabilityKind[];
  spec: AgentCapabilitySpec;
  /** 命中依据（中文短语，展示在导入弹窗里） */
  reasons: string[];
}

/** 检测用到的能力相关中文/英文关键词（值语义通道） */
const RE_TASK_TEXT =
  /(提醒我|叫我起床|叫我|喊我|定时|闹钟|日程|待办|别忘|提醒一下|natural_language_to_cron|task_types|task_management|reminder|schedule|cron)/i;
const RE_PROACTIVE_TEXT =
  /(主动发起对话|主动搭话|主动关心|主动问候|主动找你|主动来找|定时问候|不定时.*(关心|问候)|proactive|initiative|check[_-]?in|active_chat)/i;
const RE_WEB_TEXT =
  /(联网|上网查|上网搜|搜索引擎|查实时|实时信息|最新信息|web[_\s-]?search|internet[_\s-]?access|search the web|browse the web)/i;

/** 结构化键（键名通道）：出现即可判定能力 */
const KEYS_TASK = [
  'natural_language_to_cron',
  'task_types',
  'task_management',
  'task_creation',
  'example_tasks',
  'reminders',
];
const KEYS_PROACTIVE = [
  'proactive',
  'proactive_chat',
  'initiative',
  'check_in',
  'checkin',
  'active_execution',
  'greeting_schedule',
  'small_talk',
];
const KEYS_WEB = ['web_search', 'websearch', 'internet_access', 'online_search', 'search_api'];

/** 递归收集所有键名（小写）与字符串值 */
function walk(node: unknown, keys: Set<string>, strings: string[], depth = 0): void {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, keys, strings, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      keys.add(k.toLowerCase());
      walk(v, keys, strings, depth + 1);
    }
    return;
  }
  if (typeof node === 'string' && node.trim()) strings.push(node);
}

/** 深度优先查找某个键的值（任意层级） */
function findValue(node: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findValue(v, key, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k.toLowerCase() === key) return v;
  }
  for (const v of Object.values(o)) {
    const hit = findValue(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** 从 JSON 里读「主动搭话间隔（分钟）」：interval_minutes / proactive_interval_minutes / check_in_interval_minutes */
function readIntervalMinutes(root: unknown): number | undefined {
  for (const key of ['interval_minutes', 'proactive_interval_minutes', 'check_in_interval_minutes', 'proactive_interval']) {
    const n = num(findValue(root, key));
    if (n && n > 0) return Math.round(n);
  }
  return undefined;
}

/** 从 JSON 里读「搭话时段」：waking_hours / active_hours = [8,22] 或 {start,end} */
function readWakingHours(root: unknown): [number, number] | undefined {
  for (const key of ['waking_hours', 'active_hours', 'awake_hours']) {
    const v = findValue(root, key);
    if (Array.isArray(v) && v.length >= 2) {
      const a = num(v[0]);
      const b = num(v[1]);
      if (a != null && b != null && a >= 0 && b <= 24 && b > a) return [a, b];
    }
    if (v && typeof v === 'object') {
      const a = num((v as Record<string, unknown>).start);
      const b = num((v as Record<string, unknown>).end);
      if (a != null && b != null && a >= 0 && b <= 24 && b > a) return [a, b];
    }
  }
  return undefined;
}

/** 从 JSON 里读示例任务（example_tasks[].user_input / exampleTasks） */
function readExampleTasks(root: unknown): string[] {
  const out: string[] = [];
  const push = (s: unknown): void => {
    const t = typeof s === 'string' ? s.trim() : '';
    if (t && !out.includes(t) && out.length < 8) out.push(t);
  };
  for (const key of ['example_tasks', 'exampleTasks', 'example_questions']) {
    const v = findValue(root, key);
    if (!Array.isArray(v)) continue;
    for (const it of v) {
      if (typeof it === 'string') push(it);
      else if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>;
        push(o.user_input ?? o.input ?? o.prompt ?? o.text ?? o.question);
      }
    }
  }
  return out;
}

/** 从 JSON 里读每日任务上限（frequency_control.max_active_tasks_per_day） */
function readMaxTasksPerDay(root: unknown): number | undefined {
  const n = num(findValue(root, 'max_active_tasks_per_day'));
  if (n && n > 0 && n <= 50) return Math.round(n);
  return undefined;
}

/**
 * 检测导入 JSON 里声明的主动能力。
 * 宽口径策略：结构化键命中即判定；仅靠中文语义时需「整份 JSON 中命中关键词」——
 * 因为紧接着会弹窗让用户确认，误报成本低，漏报成本高。
 */
export function detectCapabilities(raw: unknown): CapabilityDetection {
  const keys = new Set<string>();
  const strings: string[] = [];
  walk(raw, keys, strings);
  const text = strings.join('\n');
  const hasKey = (list: string[]): boolean => list.some((k) => keys.has(k));

  const reasons: string[] = [];
  const kinds: AgentCapabilityKind[] = [];

  // ── 定时任务能力（根据用户需求创造任务）──
  const taskByKey = hasKey(KEYS_TASK);
  const taskByText = RE_TASK_TEXT.test(text);
  if (taskByKey || taskByText) {
    kinds.push('tasks');
    reasons.push(taskByKey ? '声明了定时/提醒任务能力' : '示例或人设里包含提醒类需求');
  }

  // ── 主动发起对话能力（主动搭话）──
  const proactiveByKey = hasKey(KEYS_PROACTIVE);
  const proactiveByText = RE_PROACTIVE_TEXT.test(text);
  // active_execution 是「主动执行」总声明：即使用户只写了任务相关子键，也视为可能包含主动搭话
  if (proactiveByKey || proactiveByText) {
    kinds.push('proactive');
    reasons.push(proactiveByKey ? '声明了主动执行/主动搭话能力' : '人设里提到会主动找你说话');
  }

  // ── 联网查询能力（需要实时信息时上网查）──
  const webByKey = hasKey(KEYS_WEB);
  const webByText = RE_WEB_TEXT.test(text);
  if (webByKey || webByText) {
    kinds.push('web');
    reasons.push(webByKey ? '声明了联网/搜索能力' : '人设里提到会联网查资料');
  }

  // ── 平台免费技能（天气/股票/竞彩足球；JSON 显式声明 skills/tools/plugins，或中文语义）──
  const skillTokens = new Set<string>();
  const skillsNode =
    findValue(raw, 'skills') ?? findValue(raw, 'tools') ?? findValue(raw, 'plugins') ?? findValue(raw, 'capabilities_tools');
  const collectTokens = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) {
        if (typeof v === 'string') skillTokens.add(v.toLowerCase());
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (typeof o.type === 'string') skillTokens.add(o.type.toLowerCase());
          if (typeof o.name === 'string') skillTokens.add(o.name.toLowerCase());
        }
      }
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node as Record<string, unknown>)) skillTokens.add(k.toLowerCase());
    }
  };
  collectTokens(skillsNode);
  const hasSkillToken = (aliases: string[]): boolean =>
    aliases.some((a) => skillTokens.has(a)) || hasKey(aliases);
  const skillDefs: Array<{ kind: AgentCapabilityKind; aliases: string[]; re: RegExp; reason: string }> = [
    { kind: 'weather', aliases: ['weather', 'weather_query', 'get_weather'], re: /(查天气|天气预报|气温|实时天气)/, reason: '声明了天气查询技能' },
    { kind: 'stock', aliases: ['stock', 'stock_query', 'stocks', 'stock_price'], re: /(股票行情|股价|查股票|股市行情)/, reason: '声明了股票行情技能' },
    { kind: 'football', aliases: ['football', 'football_lottery', 'jc_zq', 'spf'], re: /(足彩|竞彩足球|胜平负赔率)/, reason: '声明了竞彩足球技能' },
  ];
  for (const sd of skillDefs) {
    const byToken = hasSkillToken(sd.aliases);
    const byText = sd.re.test(text);
    if (byToken || byText) {
      kinds.push(sd.kind);
      reasons.push(byToken ? sd.reason : '人设里提到了对应的实时查询场景');
    }
  }

  const intervalMinutes = readIntervalMinutes(raw);
  const wakingHours = readWakingHours(raw);
  const exampleTasks = readExampleTasks(raw);
  const maxActiveTasksPerDay = readMaxTasksPerDay(raw);
  if (intervalMinutes) reasons.push(`自带搭话间隔 ${intervalMinutes} 分钟`);
  if (wakingHours) reasons.push(`自带搭话时段 ${wakingHours[0]}:00–${wakingHours[1]}:00`);

  return {
    kinds,
    spec: {
      intervalMinutes,
      wakingHours,
      exampleTasks: exampleTasks.length ? exampleTasks : undefined,
      maxActiveTasksPerDay,
      detectedAt: Date.now(),
      source: 'import',
    },
    reasons,
  };
}

/** 能力中文名（弹窗/表单/列表统一文案） */
export function capabilityLabel(kind: AgentCapabilityKind): string {
  if (kind === 'tasks') return '根据我的需求排定时任务';
  if (kind === 'web') return '联网查询';
  if (kind === 'weather') return '查询天气';
  if (kind === 'stock') return '查询股票行情';
  if (kind === 'football') return '查询竞彩足球';
  return '主动发起对话';
}

/** 能力说明（一句话，展示给用户） */
export function capabilityDesc(kind: AgentCapabilityKind): string {
  if (kind === 'tasks') return '你说出需求后，它会记住并在到点主动来找你（如「下班前提醒我交周报」）';
  if (kind === 'web') return '遇到实时信息（天气、新闻、价格等）时，它会先上网查一下再回答（搜索服务由你自己配置）';
  if (kind === 'weather') return '问城市天气/气温/会不会下雨，它查实时数据回答（平台免费，无需配置）';
  if (kind === 'stock') return '问 A 股股价、涨跌、成交额，它查实时行情回答（沪深两市，平台免费）';
  if (kind === 'football') return '问竞彩足球当天/未来赛程与胜平负赔率，它查最新数据（平台免费，理性参考）';
  return '不等你开口，它也会按自己的节奏主动找你说话';
}

/**
 * 按该智能体的 JSON 规格合成「建任务」协议提示词：
 * 示例任务用它的 example_tasks，重复/频率约束用它的 frequency_control，人格要求优先。
 */
export function buildTaskProtocolPrompt(spec?: AgentCapabilitySpec): string {
  const lines = [
    '【定时能力】当用户明确要求「在将来某个时间做某事」时（如提醒、叫我起床、到点来问我），你要替 ta 排一个定时任务：',
    '在回复正文之后另起一行，输出一条隐藏指令（用户看不到，不要解释它）：',
    '[[TASK|类型|ISO时间|重复|内容]]',
    '· 类型：reminder（到点提醒 ta 做某事）或 active_chat（到点由你主动找 ta 聊这个话题）',
    '· ISO时间：本地时间，必须带时区，如 2026-09-25T08:00:00+08:00（当前时间见上文）',
    '· 重复：none / daily / weekly',
    '· 内容：不超过 30 字的要点，如「交周报」「问问他面试准备得怎么样」',
  ];
  const examples = (spec?.exampleTasks ?? []).filter((x) => x.trim()).slice(0, 3);
  if (examples.length) {
    lines.push(`· 你们的常用场景（可直接复用其表达方式）：${examples.map((x) => `「${x}」`).join('、')}`);
  }
  if (spec?.maxActiveTasksPerDay) {
    lines.push(`· 每天最多安排 ${spec.maxActiveTasksPerDay} 个任务，别把 ta 淹没在提醒里`);
  }
  lines.push(
    '规则：只有用户明确要求在将来做某事时才输出该指令；时间不明确就先问清楚（不要自己猜）；普通闲聊绝不输出；一次最多两条。',
    '口径要求：正文里必须用你自己的口吻说清「什么时候、做什么」（例如「好，今天 17:35 我准时喊你」），不要提「任务」「定时」「系统」「已排期」这些字眼，也不要解释隐藏指令；隐藏指令只放在正文最后一行。',
  );
  return lines.join('\n');
}

/**
 * 合成「主动发起对话」能力提示词（针对该智能体；规格取自它自己的 JSON）：
 * 让它在生成主动消息时也严格遵守人设与频率约束。
 */
export function buildProactivePrompt(spec?: AgentCapabilitySpec): string {
  const [start, end] = spec?.wakingHours ?? [8, 22];
  const lines = [
    '【主动发起对话】你会在用户没有开口时主动找他说话（App 会在合适的时机向你索要一句开场白）。',
    `· 只在 ${start}:00–${end}:00 之间开口，其余时间不打扰`,
    '· 开口要短（1~2 句）、贴合你的人设口吻，像你自己想说才说的，不要提「定时」「任务」「系统」这些字眼',
    '· 不打探隐私、不指责用户、不刷屏；用户明显在忙或刚说过话时不要抢话',
  ];
  return lines.join('\n');
}

/** 智能体档案的 JSON 摘要（供编辑表单展示「检测到的能力」） */
export function summarizeCapabilities(d: CapabilityDetection): string {
  if (!d.kinds.length) return '未检测到能力声明';
  const parts = d.kinds.map(capabilityLabel);
  if (d.spec.intervalMinutes) parts.push(`间隔 ${d.spec.intervalMinutes} 分钟`);
  if (d.spec.wakingHours) parts.push(`时段 ${d.spec.wakingHours[0]}:00–${d.spec.wakingHours[1]}:00`);
  return parts.join(' · ');
}