/**
 * 智能体技能工具网关（服务端代理，免用户自配 Key）：
 * - weather：Open-Meteo（地理编码 + 预报，免费无 Key，WMO 天气码归一化为中文）
 * - stock：腾讯证券（smartbox 搜索 + qt 实时行情，源站 GBK，服务端转 UTF-8 并归一化字段）
 * - football：中国竞彩足球在售赛程与赔率（500 彩票网页面 gb18030，服务端解析 data-* 结构）
 *
 * 全部归一化为中文 JSON 返回给 App，规避手机端 GBK 解码、地域风控与 CORS。
 */
import { BadGatewayException, Injectable } from '@nestjs/common';

const FETCH_TIMEOUT_MS = 12000;

async function fetchText(url: string, encoding: 'utf-8' | 'gbk' = 'utf-8'): Promise<string> {
  let lastErr: unknown;
  // 偶发网络抖动（DNS/连接重置）时重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile' },
      });
      if (!res.ok) throw new BadGatewayException(`上游返回 ${res.status}`);
      if (encoding === 'utf-8') return await res.text();
      const buf = Buffer.from(await res.arrayBuffer());
      // gb18030 是 GBK 超集，Node 22 full-icu 内置支持
      return new TextDecoder('gb18030').decode(buf);
    } catch (e) {
      lastErr = e;
      if (e instanceof BadGatewayException && e.message.includes('上游返回')) break;
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr instanceof BadGatewayException) throw lastErr;
  throw new BadGatewayException(`数据源暂时不可用：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url, 'utf-8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BadGatewayException('数据源返回格式异常');
  }
}

/** 腾讯 smartbox 返回内容中的 \uXXXX JS 转义还原为字符 */
function decodeJsUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function numOrNull(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 天气 ────────────────────────────────────────────────────────────────────

/** WMO 天气解释码 → 中文（Open-Meteo weather_code 标准） */
const WMO: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '浓毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

interface GeoResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
}

@Injectable()
export class ToolsService {
  /**
   * 天气查询。dayOffset：0=今天（含实时），1=明天，2=后天
   */
  async weather(city: string, dayOffset = 0): Promise<Record<string, unknown>> {
    const kw = city.trim();
    if (!kw) throw new BadGatewayException('请给出城市名，如「北京」「长春 明天」');
    const day = Math.min(Math.max(dayOffset, 0), 2);
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(kw)}&count=1&language=zh&format=json`;
    const geo = await fetchJson<{ results?: GeoResult[] }>(geoUrl);
    const place = geo.results?.[0];
    if (!place || typeof place.latitude !== 'number') {
      return { ok: false, message: `没找到「${kw}」这个城市，请换个更常见的城市名（如「长春」而非「朝阳区」）` };
    }
    const fUrl =
      'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=3';
    const f = await fetchJson<{
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
      };
    }>(fUrl);
    const d = f.daily;
    const daily = (d?.time ?? []).map((date, i) => ({
      date,
      summary: WMO[d?.weather_code?.[i] ?? -1] ?? '未知',
      tempMax: d?.temperature_2m_max?.[i] ?? null,
      tempMin: d?.temperature_2m_min?.[i] ?? null,
      rainProb: d?.precipitation_probability_max?.[i] ?? null,
    }));
    const target = daily[day] ?? daily[0];
    const out: Record<string, unknown> = {
      ok: true,
      city: place.name ?? kw,
      region: [place.admin1, place.country].filter(Boolean).join(' '),
      dayOffset: day,
      date: target?.date ?? null,
      summary: target?.summary ?? '未知',
      tempMax: target?.tempMax ?? null,
      tempMin: target?.tempMin ?? null,
      rainProb: target?.rainProb ?? null,
      daily,
      source: 'Open-Meteo',
    };
    if (day === 0 && f.current) {
      out.current = {
        temp: f.current.temperature_2m ?? null,
        feelsLike: f.current.apparent_temperature ?? null,
        humidity: f.current.relative_humidity_2m ?? null,
        windSpeed: f.current.wind_speed_10m ?? null,
        summary: WMO[f.current.weather_code ?? -1] ?? '未知',
      };
    }
    return out;
  }

  /**
   * 股票行情（A 股；输入名称/拼音/6 位代码）。
   * 数据源：腾讯证券 smartbox 搜索 + qt.gtimg.cn 行情（GBK）。
   * （东方财富 push2 行情域对机房 IP 拒连，故弃用；searchapi 仅作搜索备用）
   */
  async stock(keyword: string): Promise<Record<string, unknown>> {
    const kw = keyword.trim();
    if (!kw) throw new BadGatewayException('请给出股票名称或代码，如「贵州茅台」「600519」');

    // 1. 定位市场+6 位代码：纯数字直接判定（6/9 开头沪市，0/2/3 开头深市），否则走 smartbox 搜索
    let market: 'sh' | 'sz' | null = null;
    let code: string | null = null;
    let hitName: string | null = null;
    if (/^\d{6}$/.test(kw)) {
      market = /^[69]/.test(kw) ? 'sh' : 'sz';
      code = kw;
    } else {
      const sUrl = `https://smartbox.gtimg.cn/s3/?t=all&q=${encodeURIComponent(kw)}`;
      const sText = decodeJsUnicode(await fetchText(sUrl, 'gbk'));
      const m = sText.match(/v_hint="([^"]*)"/);
      const items = (m?.[1] ?? '')
        .split('^')
        .map((s) => s.split('~'))
        .filter((f) => f[4] === 'GP-A' && (f[0] === 'sh' || f[0] === 'sz'));
      const exact = items.find((f) => f[2] === kw);
      const hit = exact ?? items[0];
      if (hit) {
        market = hit[0] as 'sh' | 'sz';
        code = hit[1];
        hitName = hit[2];
      }
    }
    if (!market || !code) {
      return { ok: false, message: `没找到「${kw}」对应的 A 股，请用完整名称或 6 位代码（如 000001）` };
    }

    // 2. 行情：v_sh600519="1~贵州茅台~600519~现价~昨收~今开~成交量(手)~...~时间~涨跌~涨跌幅~最高~最低~...~成交额(万元)~..."
    const qText = await fetchText(`https://qt.gtimg.cn/q=${market}${code}`, 'gbk');
    const qm = qText.match(/v_[a-z]+\d+="([^"]*)"/);
    const f = (qm?.[1] ?? '').split('~');
    const price = Number(f[3]);
    if (!f[1] || !Number.isFinite(price) || price === 0) {
      return { ok: false, message: `没有「${hitName ?? code}」的实时行情（可能已停牌或代码有误）` };
    }
    const prevClose = Number(f[4]);
    const high = Number(f[33]);
    const low = Number(f[34]);
    const amountWan = Number(f[37]);
    return {
      ok: true,
      name: f[1] || hitName || kw,
      code: f[2] || code,
      market: market === 'sh' ? '上海证券交易所' : '深圳证券交易所',
      price,
      change: numOrNull(f[31]),
      changePct: numOrNull(f[32]),
      // 振幅 = (最高-最低)/昨收 ×100%
      amplitude: prevClose ? Number((((high - low) / prevClose) * 100).toFixed(2)) : null,
      open: numOrNull(f[5]),
      high: numOrNull(f[33]),
      low: numOrNull(f[34]),
      prevClose: numOrNull(f[4]),
      volumeHands: numOrNull(f[6]),
      // 成交额：腾讯单位万元，换算为元（模型回答时自行换算成亿元）
      amountYuan: Number.isFinite(amountWan) ? Math.round(amountWan * 10000) : null,
      quoteTime: /^\d{14}$/.test(f[30] ?? '')
        ? `${f[30].slice(0, 4)}-${f[30].slice(4, 6)}-${f[30].slice(6, 8)} ${f[30].slice(8, 10)}:${f[30].slice(10, 12)}`
        : null,
      source: '腾讯证券',
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * 竞彩足球：某日在售/已截止赛程与胜平负赔率（北京时间）。
   * date 为空取今天；500 页面只覆盖近几天，超出范围返回空列表。
   */
  async football(date?: string): Promise<Record<string, unknown>> {
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
      ? (date as string)
      : new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-').split('-').map((p) => p.padStart(2, '0')).join('-');
    const html = await fetchText('https://trade.500.com/jczq/', 'gbk');
    const rows = html.match(/<tr[^>]*class="bet-tb-tr"[\s\S]*?<\/tr>/g) ?? [];
    interface FootballMatch {
      num: string; league: string; date: string; time: string;
      home: string; away: string; handicap: string; selling: boolean;
      win: number | null; draw: number | null; lose: number | null;
      rqWin: number | null; rqDraw: number | null; rqLose: number | null;
    }
    const matches: FootballMatch[] = [];
    for (const row of rows) {
      const attr = this.parseAttrs(row);
      if (!attr['data-matchdate']) continue;
      const nspf = this.parseOdds(row, 'itm-rangB1');
      const spf = this.parseOdds(row, 'itm-rangB2');
      matches.push({
        num: attr['data-matchnum'] ?? '',
        league: attr['data-simpleleague'] ?? '',
        date: attr['data-matchdate'] ?? '',
        time: attr['data-matchtime'] ?? '',
        home: attr['data-homesxname'] ?? '',
        away: attr['data-awaysxname'] ?? '',
        handicap: attr['data-rangqiu'] ?? '0',
        selling: attr['data-isend'] !== '1',
        // 不让球胜平负
        win: nspf[0] ?? null,
        draw: nspf[1] ?? null,
        lose: nspf[2] ?? null,
        // 让球胜平负
        rqWin: spf[0] ?? null,
        rqDraw: spf[1] ?? null,
        rqLose: spf[2] ?? null,
      });
    }
    const dayMatches = matches.filter((m) => m.date === targetDate);
    return {
      ok: true,
      date: targetDate,
      count: dayMatches.length,
      matches: dayMatches,
      source: '中国竞彩网在售赛程（500彩票网数据）',
      note: '赔率为页面抓取时刻的参考值，实际以出票为准；在售=false 表示已截止投注',
    };
  }

  /** 提取一行 tr 的 data-* 属性表 */
  private parseAttrs(row: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /\s(data-[a-z0-9-]+)="([^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(row))) out[m[1]] = m[2];
    return out;
  }

  /** 解析某个赔率组（itm-rangB1=不让球，itm-rangB2=让球）的 胜/平/负 三个 data-sp（顺序固定） */
  private parseOdds(row: string, rowClass: string): Array<number | null> {
    const block = new RegExp(`<div class="betbtn-row ${rowClass}">([\\s\\S]*?)</div>`).exec(row);
    if (!block) return [null, null, null];
    const sps = [...block[1].matchAll(/data-sp="([\d.]+)"/g)].map((x) => Number(x[1]));
    return [sps[0] ?? null, sps[1] ?? null, sps[2] ?? null];
  }
}
