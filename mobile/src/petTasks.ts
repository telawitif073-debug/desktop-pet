/**
 * 宠物定时任务·纯逻辑层（不依赖 React Native，可直接被 Node 单测）。
 * 落实人设卡 active_execution 描述的能力：
 * - natural_language_to_cron：中文自然语言时间解析（相对时间 / 每天 / 每周X / 明早 / 今晚 / 整点 / HH:MM）
 * - task_types：reminder（到点提醒）/ active_chat（到点主动发起对话）
 * - task_management：建任务、查询任务、取消、暂停/继续（关键词识别）
 * 调度触发与消息落地见 petTaskScheduler.ts；类型定义见 types.ts 的 PetTask。
 */
import type { PetTask } from './types';
import { SEARCH_DIRECTIVE_RE } from './webSearch';
import { stripSkillDirectives, stripUnclosedToolTail } from './skills';

// ────────────────────────────── 中文数字 ──────────────────────────────
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 数字表达式（阿拉伯或中文），如 8 / 八 / 二十一 */
const CN = '[一二两三四五六七八九十]{1,3}|[0-9]{1,2}';

export function cnNum(raw: string): number | null {
  const s = raw.trim();
  if (/^[0-9]{1,2}$/.test(s)) return parseInt(s, 10);
  if (!/^[一二两三四五六七八九十]{1,3}$/.test(s)) return null;
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : CN_DIGIT[a];
    const ones = b === '' ? 0 : CN_DIGIT[b];
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  let v = 0;
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d == null) return null;
    v = v * 10 + d;
  }
  return v;
}

// ────────────────────────────── 时间解析 ──────────────────────────────
export interface ParsedSchedule {
  /** 触发时间戳（ms） */
  due: number;
  repeat: 'none' | 'daily' | 'weekly';
  /** 展示用（「1分钟后」/「今天 15:30」/「每天 08:00」/「每周三 21:00」） */
  label: string;
  /** 命中的时间短语原文（用于从整句里剥离得到任务内容） */
  raw: string;
}

/** 时段词（含捕获组，用于取出 period 文本）；末尾补「早/晚」短形式（晚9点 / 早8点） */
const PERIOD_S = '(凌晨|半夜|清晨|早晨|早上|早间|上午|中午|正午|下午|午后|傍晚|晚上|夜里|夜间|晚间|早|晚)';
/** 整点表达式：捕获 1=小时，2=分钟部分（半/一刻/三刻/X分） */
const CLOCK = `(${CN})\\s*[点时]\\s*(半|一刻|三刻|(?:${CN})\\s*分)?`;

const DAY_MS = 86400000;
const WEEK_CN = '日一二三四五六';

function parseMinute(expr?: string): number {
  if (!expr) return 0;
  if (expr.includes('一刻')) return 15;
  if (expr.includes('三刻')) return 45;
  if (expr.includes('半')) return 30;
  const m = expr.match(new RegExp(`(${CN})\\s*分`));
  return m ? cnNum(m[1]) ?? 0 : 0;
}

/** 时段 → 24 小时制：晚上8点→20、下午3点→15、晚9点→21、晚12点→0（次日）、凌晨12点→0 */
function to24(hour: number, period?: string): number {
  let h = hour;
  if (h === 24) return 0;
  if (!period) return h;
  if (/凌晨|半夜/.test(period)) {
    if (h === 12) h = 0;
  } else if (/中午|正午/.test(period)) {
    if (h >= 1 && h <= 2) h += 12;
  } else if (/下午|午后/.test(period)) {
    if (h < 12) h += 12;
  } else if (/晚/.test(period)) {
    // 晚上/傍晚/夜里/晚间/夜/晚（短形式）：12 点按 0 点，其余 +12
    if (h === 12) h = 0;
    else if (h < 12) h += 12;
  }
  return h;
}

/** 是否「晚上」类时段（含短形式「晚」），用于判断晚上12点是否顺延到后天 */
function isEvening(period?: string): boolean {
  return !!period && /晚/.test(period);
}

/** 没说上午下午的 1~5 点按下午理解（3点 → 15:00），显式时段不受影响 */
function bareHour(hour: number): number {
  return hour >= 1 && hour <= 5 ? hour + 12 : hour;
}

function atTime(base: Date, hour: number, minute: number, addDays = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** 今天该时刻已过则顺延到明天（「8点」在 9 点说 = 明早 8 点） */
function futureOrTomorrow(now: Date, hour: number, minute: number): Date {
  const d = atTime(now, hour, minute);
  return d.getTime() <= now.getTime() ? atTime(now, hour, minute, 1) : d;
}

/** 下一个指定星期几的时刻（今天已过则下周） */
function nextWeekly(now: Date, weekday: number, hour: number, minute: number): Date {
  const d = atTime(now, hour, minute);
  let diff = (weekday - d.getDay() + 7) % 7;
  if (diff === 0 && d.getTime() <= now.getTime()) diff = 7;
  return atTime(now, hour, minute, diff);
}

export function formatDueLabel(due: number, repeat: 'none' | 'daily' | 'weekly', now: number = Date.now()): string {
  const d = new Date(due);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (repeat === 'daily') return `每天 ${time}`;
  if (repeat === 'weekly') return `每周${WEEK_CN[d.getDay()]} ${time}`;
  const day0 = (x: number): number => {
    const t = new Date(x);
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  };
  const days = Math.round((day0(due) - day0(now)) / DAY_MS);
  if (days <= 0) return `今天 ${time}`;
  if (days === 1) return `明天 ${time}`;
  if (days === 2) return `后天 ${time}`;
  if (days < 7) return `周${WEEK_CN[d.getDay()]} ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

/**
 * 中文时间解析：从一句话中识别时间短语。
 * 支持：30秒后 / 5分钟后 / 半小时后 / 每天早8点 / 每周三晚9点 / 明早8点 / 明晚8点 /
 * 明天下午3点 / 今晚10点 / 今天下午3点 / 下午3点 / 8点 / 8点半 / 21:00。
 * 多种时间短语时取第一个命中者。
 */
export function parseSchedule(text: string, now: Date = new Date()): ParsedSchedule | null {
  // 归一化 HH:MM：每天8:30 → 每天8点30分
  const t = text.replace(/(\d{1,2})[:：](\d{2})/g, '$1点$2分');
  const mk = (due: number, repeat: ParsedSchedule['repeat'], raw: string): ParsedSchedule => ({
    due,
    repeat,
    label: formatDueLabel(due, repeat, now.getTime()),
    raw,
  });
  let m: RegExpMatchArray | null;

  // 1) 相对时间：30秒后 / 5分钟后 / 半小时后 / 2小时后
  m = t.match(/(半|[0-9]+|[一二两三四五六七八九十]+)\s*(秒|分钟|分|小时|个小时|钟头)\s*(?:后|之后|以后)/);
  if (m) {
    const v = m[1] === '半' ? 0.5 : cnNum(m[1]);
    if (v && v > 0) {
      const unit = /秒/.test(m[2]) ? '秒后' : /小时|钟头/.test(m[2]) ? '小时后' : '分钟后';
      const ms = unit === '秒后' ? v * 1000 : unit === '小时后' ? v * 3600000 : v * 60000;
      return {
        due: now.getTime() + ms,
        repeat: 'none',
        label: m[1] === '半' ? '半小时后' : `${m[1]}${unit}`,
        raw: m[0],
      };
    }
  }

  // 2) 每周X：每周三晚上9点 / 周三21点 / 每个星期五早上8点半
  m = t.match(new RegExp(`(?:每|每个)?(?:周|星期|礼拜)\\s*([一二三四五六日天])\\s*${PERIOD_S}?\\s*${CLOCK}`));
  if (m) {
    const weekday = m[1] === '日' || m[1] === '天' ? 0 : cnNum(m[1]) ?? 0;
    const hour = to24(cnNum(m[3]) ?? 0, m[2]);
    const due = nextWeekly(now, weekday, hour, parseMinute(m[4])).getTime();
    return mk(due, 'weekly', m[0]);
  }

  // 3) 每天/每晚：每天早上8点 / 每晚10点
  m = t.match(new RegExp(`(每天|每日|每晚)\\s*${PERIOD_S}?\\s*${CLOCK}`));
  if (m) {
    const period = m[2] ?? (m[1] === '每晚' ? '晚上' : undefined);
    const hour = to24(cnNum(m[3]) ?? 0, period);
    const due = futureOrTomorrow(now, hour, parseMinute(m[4])).getTime();
    return mk(due, 'daily', m[0]);
  }

  // 4) 明早/明天早上·上午
  m = t.match(new RegExp(`(?:明早|明天早上|明天早晨|明天上午|明天清晨)\\s*${CLOCK}`));
  if (m) {
    const hour = to24(cnNum(m[1]) ?? 0, '上午');
    return mk(atTime(now, hour, parseMinute(m[2]), 1).getTime(), 'none', m[0]);
  }

  // 5) 明晚/明天晚上
  m = t.match(new RegExp(`(?:明晚|明天晚上|明天傍晚|明天夜里|明天晚间)\\s*${CLOCK}`));
  if (m) {
    const rawHour = cnNum(m[1]) ?? 0;
    // 晚上12点 = 次日 0 点 → 再顺延一天
    const addDays = rawHour === 12 ? 2 : 1;
    const hour = to24(rawHour, '晚上');
    return mk(atTime(now, hour, parseMinute(m[2]), addDays).getTime(), 'none', m[0]);
  }

  // 6) 明天 + 时段：明天下午3点 / 明天8点 / 明天晚8点
  m = t.match(new RegExp(`明天\\s*${PERIOD_S}?\\s*${CLOCK}`));
  if (m) {
    const period = m[1];
    const rawHour = cnNum(m[2]) ?? 0;
    const addDays = isEvening(period) && rawHour === 12 ? 2 : 1;
    const hour = to24(period ? rawHour : bareHour(rawHour), period);
    return mk(atTime(now, hour, parseMinute(m[3]), addDays).getTime(), 'none', m[0]);
  }

  // 7) 今晚/今天晚上/今夜
  m = t.match(new RegExp(`(?:今晚|今天晚上|今夜|今儿晚上)\\s*${CLOCK}`));
  if (m) {
    const hour = to24(cnNum(m[1]) ?? 0, '晚上');
    return mk(futureOrTomorrow(now, hour, parseMinute(m[2])).getTime(), 'none', m[0]);
  }

  // 8) 今天 + 时段：今天下午3点
  m = t.match(new RegExp(`(?:今天|今日)\\s*${PERIOD_S}?\\s*${CLOCK}`));
  if (m) {
    const period = m[1];
    const hour = to24(period ? cnNum(m[2]) ?? 0 : bareHour(cnNum(m[2]) ?? 0), period);
    return mk(futureOrTomorrow(now, hour, parseMinute(m[3])).getTime(), 'none', m[0]);
  }

  // 9) 时段 + 整点：下午3点 / 晚上10点 / 早上8点
  m = t.match(new RegExp(`${PERIOD_S}\\s*${CLOCK}`));
  if (m) {
    const hour = to24(cnNum(m[2]) ?? 0, m[1]);
    return mk(futureOrTomorrow(now, hour, parseMinute(m[3])).getTime(), 'none', m[0]);
  }

  // 10) 裸整点：8点 / 3点半 / 21点（1~5 点按下午理解）
  m = t.match(new RegExp(CLOCK));
  if (m) {
    const hour = to24(bareHour(cnNum(m[1]) ?? 0));
    return mk(futureOrTomorrow(now, hour, parseMinute(m[2])).getTime(), 'none', m[0]);
  }

  return null;
}

// ────────────────────────────── 意图识别 ──────────────────────────────
export type PetTaskKind = 'reminder' | 'active_chat';

export type PetIntent =
  | { kind: 'create'; schedule: ParsedSchedule; rawText: string; content: string; display: string; taskKind: PetTaskKind }
  | { kind: 'query' }
  | { kind: 'cancel'; hint: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clarify' };

/** 查询：我有什么任务 / 我的提醒 / 你明天要叫我吗 */
const RE_QUERY = /(我(都)?有(什么|哪些|啥)任务|我的(任务|提醒|定时|待办)|任务(列表|清单)|查看(我的)?(任务|提醒)|待办(事项|列表)|你(今天|明天|等会|等会儿|待会)?(要|会|准备)?(叫我|提醒我|来找我|问我)吗)/;
/** 暂停 / 继续 */
const RE_PAUSE = /(暂停|先别|暂时别|别再|不要)(?:所有|全部)?(提醒|任务)|(提醒|任务)(?:都)?(暂停|先停|停一下)/;
const RE_RESUME = /(继续|恢复|重新开启|重新)(?:所有|全部)?(提醒|任务)|(提醒|任务)(?:继续|恢复)/;
/** 取消：取消提醒 / 取消起床提醒 / 别叫我了 / 不用提醒我了 */
const RE_CANCEL = /(取消|删掉|删除|清空|撤销)[^，。！？,.!?]*(提醒|任务|闹钟|闹铃)|别(叫|提醒|喊)我了|不用(叫|提醒|喊)我了/;
/** 任务动词（宽）：与时间短语同时出现才建任务 */
const RE_VERB = /提醒我|提醒一下|提醒下|提醒|叫我起床|叫我起来|叫我|喊我起床|喊我|叫醒我|定个闹钟|定闹钟|闹钟|通知我|来找我|找我聊|跟我聊|跟我说|陪我说|陪我聊|来陪我|主动|问我/;
/** 任务动词（强）：无时间短语时给出「什么时候」追问（避免答非所问式空承诺） */
const RE_VERB_STRONG = /提醒我|提醒一下|提醒下|叫我起床|叫我起来|叫我|喊我|叫醒我|定个闹钟|定闹钟|通知我|主动(来)?(找|聊|说|问)|问我/;

/** 从整句里剥离时间短语与语气词，得到任务内容（「明早8点叫我起床」→「叫我起床」） */
export function extractContent(text: string, timeRaw: string): string {
  let c = text.replace(timeRaw, ' ').trim();
  c = c.replace(/^[，。,.、；;：:！!？?\s]*(?:帮我|帮忙|请|麻烦|记得|到时候|到点|按时|准时|给我|然后|就|你)*\s*/, '');
  c = c.replace(/^[，。,.、；;：:！!？?\s]+|[，。,.、；;：:！!？?\s]+$/g, '');
  return c || text;
}

/** 展示用短语（剥离「主动来/提醒我/问我」等动词前缀）：
 *  提醒我喝水 → 喝水；叫我起床 → 该起床啦；主动来问我今天的工作计划 → 今天的工作计划 */
export function taskDisplay(content: string): string {
  const VERB = /^(?:提醒我(?:一下|下)?|提醒|叫我起床|叫我起来|叫我|喊我起床|喊我|叫醒我|问我|告诉我|通知我|来找我|来问我|来问一下|来问|找我(?:聊|说|谈)?|跟我聊|跟我说话|陪我说|陪我聊|来陪我|聊聊天|说说话)/;
  let d = content.replace(/^主动(?:来|去)?/, '').trim();
  // 前缀可叠加（「主动来 + 问我」/「来问 + 我…」），最多剥两层
  for (let i = 0; i < 2; i++) {
    const next = d.replace(VERB, '').trim();
    if (next === d) break;
    d = next;
  }
  if (!d) d = /起床|起来|醒/.test(content) ? '该起床啦' : content;
  return d;
}

/**
 * 识别一句话是否为定时任务指令。优先级：查询 → 暂停 → 继续 → 取消 → 建任务 → 补时间追问。
 * 返回 null 表示普通聊天（交给模型）。
 */
export function detectPetIntent(text: string, now: Date = new Date()): PetIntent | null {
  const t = text.trim();
  if (!t) return null;
  if (RE_QUERY.test(t)) return { kind: 'query' };
  if (RE_PAUSE.test(t)) return { kind: 'pause' };
  if (RE_RESUME.test(t)) return { kind: 'resume' };
  if (RE_CANCEL.test(t)) {
    const hint = t
      .replace(/(取消|删掉|删除|清空|撤销|别|不用|提醒|任务|闹钟|闹铃|所有|全部|一下|了|吧|呀|啊|啦|的|我)/g, '')
      .replace(/[，。！？,.!?\s]/g, '')
      .trim();
    // 残留单字（如「别叫我了」剩下的「叫」）不构成指代，按全部取消处理
    return { kind: 'cancel', hint: hint.length >= 2 ? hint : '' };
  }
  const schedule = parseSchedule(t, now);
  if (schedule && RE_VERB.test(t)) {
    const content = extractContent(t, schedule.raw);
    const taskKind: PetTaskKind =
      /问我|跟我聊|跟我说|来找我|陪我|主动(来)?(找|聊|说|问)/.test(t) && !/提醒/.test(t) ? 'active_chat' : 'reminder';
    return { kind: 'create', schedule, rawText: t, content, display: taskDisplay(content), taskKind };
  }
  if (!schedule && RE_VERB_STRONG.test(t) && t.length <= 40) return { kind: 'clarify' };
  return null;
}

// ────────────────────────────── 模型建任务指令协议 ──────────────────────────────
/**
 * 智能体在回复末尾附加的隐藏任务指令（用户看不到），App 解析后替用户排期。
 * 形如：[[TASK|reminder|2026-09-25T08:00:00+08:00|none|叫我起床]]
 * 字段：类型 | ISO 本地时间（带时区） | 重复 | 内容；第三段也可省略重复（按 none 处理）。
 * 提示词由 petCapabilities.buildTaskProtocolPrompt 按「该智能体自己的 JSON 规格」合成
 * （只有启用该能力的智能体才会被注入），本地固定句式命中时亦走本地建任务。
 */
export interface TaskDirective {
  kind: PetTaskKind;
  /** 触发时间戳（ms） */
  due: number;
  repeat: 'none' | 'daily' | 'weekly';
  /** 任务内容（要点） */
  content: string;
  /** 命中的指令原文 */
  raw: string;
}

/** 指令三段式：TASK | 类型 | 时间 | 其余（其余可为「重复|内容」或直接「内容」） */
const TASK_DIRECTIVE_RE = /\[\[\s*TASK\s*[|｜]\s*([^|｜\]]+?)\s*[|｜]\s*([^|｜\]]+?)\s*[|｜]\s*([\s\S]+?)\s*\]\]/gi;
/** 指令最长可接受时限（超出视为模型胡写）：90 天 */
const DIRECTIVE_MAX_AHEAD_MS = 90 * 86400000;

function normKind(raw: string): PetTaskKind | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (/^(reminder|remind|提醒|提醒类|提醒事项)$/.test(k)) return 'reminder';
  if (/^(active_chat|active|chat|搭话|主动|主动搭话|闲聊|关心)$/.test(k)) return 'active_chat';
  return null;
}

function normRepeat(raw: string): 'none' | 'daily' | 'weekly' | null {
  const r = raw.trim().toLowerCase();
  if (/^(none|无|不重复|一次|一次性)$/.test(r)) return 'none';
  if (/^(daily|每天|每日)$/.test(r)) return 'daily';
  if (/^(weekly|每周|每星期)$/.test(r)) return 'weekly';
  return null;
}

/**
 * 解析模型回复中的任务指令：返回「剥离指令后的正文」与合法指令列表。
 * 类型不识别 / 时间无法解析或已过期或过远 / 内容为空 的指令被丢弃（但仍从正文剥离，避免暴露给用户）。
 */
export function extractTaskDirectives(
  text: string,
  now: number = Date.now(),
): { clean: string; directives: TaskDirective[] } {
  const directives: TaskDirective[] = [];
  const clean = text
    .replace(TASK_DIRECTIVE_RE, (raw, kindRaw: string, timeRaw: string, restRaw: string) => {
      const kind = normKind(kindRaw);
      const timeText = timeRaw.trim();
      let due = Date.parse(timeText);
      let repeat: 'none' | 'daily' | 'weekly' = 'none';
      let content = restRaw;
      // 其余字段可为「重复|内容」；先按竖线切分再 trim（否则空内容会被提前 trim 掉导致重复段被当内容）
      const withRepeat = content.match(/^([^|｜]+?)\s*[|｜]\s*([\s\S]*)$/);
      if (withRepeat) {
        const r = normRepeat(withRepeat[1]);
        if (r) {
          repeat = r;
          content = withRepeat[2];
        }
      }
      content = content.trim();
      // 时间写的是中文短语（明早8点/每天下午3点）时改用本地解析，并以其重复规则为准
      if (!Number.isFinite(due)) {
        const ps = parseSchedule(timeText, new Date(now));
        if (ps) {
          due = ps.due;
          repeat = ps.repeat;
        }
      }
      content = content.replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, '').slice(0, 60);
      if (kind && Number.isFinite(due) && due > now + 5000 && due < now + DIRECTIVE_MAX_AHEAD_MS && content) {
        directives.push({ kind, due, repeat, content, raw });
      }
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, directives: directives.slice(0, 2) };
}

/**
 * 展示用剥离：去掉完整指令与「流式未写完的指令尾巴」（回复末尾的 [[TASK|remin…），
 * 联网指令 [[SEARCH|…]] 与平台技能 [[WEATHER/STOCK/FOOTBALL|…]] 同理（由 chat/llm.ts
 * 处理后回注资料），避免指令在气泡里一闪而过。落库以 extractTaskDirectives().clean 为准。
 */
export function stripTaskMarkers(text: string): string {
  let out = stripSkillDirectives(text).replace(TASK_DIRECTIVE_RE, '').replace(SEARCH_DIRECTIVE_RE, '');
  out = stripUnclosedToolTail(out);
  const idx = out.lastIndexOf('[[');
  if (idx >= 0 && out.slice(idx).indexOf(']]') < 0) out = out.slice(0, idx);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

// ────────────────────────────── 文案 ──────────────────────────────
export const CLARIFY_REPLY = '好呀，你想让我什么时候做这件事？可以说「1分钟后提醒我喝水」，或「明早8点叫我起床」。';

export function createReply(label: string, display: string, taskKind: PetTaskKind): string {
  return taskKind === 'active_chat'
    ? `好，${label}我会主动来找你聊：${display}。`
    : `好，${label}我会准时提醒你：${display}。到点我主动来找你。`;
}

export function queryReply(tasks: PetTask[], now: number = Date.now()): string {
  if (!tasks.length) return '当前没有进行中的任务。你可以说「1分钟后提醒我喝水」或「明早8点叫我起床」来安排。';
  const lines = tasks.map(
    (k, i) => `${i + 1}. ${k.status === 'paused' ? '（已暂停）' : ''}${formatDueLabel(k.due, k.repeat, now)} — ${taskDisplay(k.content)}`,
  );
  return `📋 你目前有 ${tasks.length} 个任务：\n${lines.join('\n')}\n\n说「别叫我了」可全部取消，说「暂停提醒」可暂时停掉。`;
}

export function cancelReply(lines: string[]): string {
  if (!lines.length) return '当前没有可取消的任务。';
  return `已取消 ${lines.length} 个任务：\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
}

export function pauseReply(n: number): string {
  return n ? `已暂停 ${n} 个任务，说「继续提醒」可恢复。` : '当前没有进行中的任务。';
}

export function resumeReply(n: number): string {
  return n ? `已恢复 ${n} 个任务。` : '当前没有暂停的任务。';
}

/** 到点消息模板（无可用 LLM 时的降级文案） */
export function fallbackMessage(task: PetTask): string {
  const d = taskDisplay(task.content);
  return task.kind === 'active_chat' ? `💬 ${d}` : `⏰ 到点了：${d}`;
}

/** 持久化数据消毒：过滤形状不合法的任务（版本升级/脏数据兜底） */
export function sanitizePetTasks(list: unknown): PetTask[] {
  if (!Array.isArray(list)) return [];
  const out: PetTask[] = [];
  for (const raw of list as PetTask[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' || typeof raw.profileId !== 'string' || typeof raw.due !== 'number') continue;
    if (raw.status !== 'pending' && raw.status !== 'paused' && raw.status !== 'done' && raw.status !== 'canceled') continue;
    out.push({
      id: raw.id,
      profileId: raw.profileId,
      kind: raw.kind === 'active_chat' ? 'active_chat' : 'reminder',
      rawText: typeof raw.rawText === 'string' ? raw.rawText : '',
      content: typeof raw.content === 'string' ? raw.content : '',
      timeLabel: typeof raw.timeLabel === 'string' ? raw.timeLabel : '',
      due: raw.due,
      repeat: raw.repeat === 'daily' || raw.repeat === 'weekly' ? raw.repeat : 'none',
      status: raw.status,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      ...(typeof raw.firedAt === 'number' ? { firedAt: raw.firedAt } : {}),
    });
  }
  return out;
}