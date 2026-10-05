/** 智能体配置导入/导出、Schema 校验与多智能体识别（P1-1/P1-2，逻辑与手机端 mobile/src/agentPort.ts 同构）
 *  导出剥离凭证（apiKey/本地 id/凭证值）；导入按名称合并；
 *  多智能体：解析 YAML/JSON → 识别编排结构 → 提取外部依赖（${VAR}/{{VAR}}/env:/secret:）→ 占位符替换为内部引用 cred://dep_N。
 */
import type { LlmProfile, AgentMultiConfig, MultiAgentDependency } from './types';

export interface AgentExportFile {
  type: 'desktop-pet-agents';
  version: 1;
  exportedAt: string;
  profiles: NormalizedAgent[];
}

export interface NormalizedAgent {
  name: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  avatar: string;
  intro: string;
  domainTags: string[];
  role: string;
  style: string;
  greeting: string;
  exampleQuestions: string[];
  apiKey: string;
  enabled: boolean;
}

export interface ImportOutcome {
  list: LlmProfile[];
  added: number;
  updated: number;
  missingKeys: number;
}

export function exportAgentJson(profiles: LlmProfile[]): string {
  const safe: NormalizedAgent[] = profiles.map((p) => {
    const base = {
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      systemPrompt: p.systemPrompt ?? '',
      avatar: p.avatar ?? '',
      intro: p.intro ?? '',
      domainTags: p.domainTags ?? [],
      role: p.role ?? '',
      style: p.style ?? '',
      greeting: p.greeting ?? '',
      exampleQuestions: p.exampleQuestions ?? [],
      apiKey: '',
      enabled: p.enabled !== false,
    };
    // 多智能体配置：仅导出配置骨架与依赖清单，剥离凭证值（credentials）
    if (p.multiConfig) {
      return {
        ...base,
        multiConfig: {
          raw: safeRaw(p.multiConfig.raw, p.multiConfig.deps ?? []),
          format: p.multiConfig.format ?? 'yaml',
          deps: (p.multiConfig.deps ?? []).map((d): MultiAgentDependency => ({ ...d })),
        },
      };
    }
    return base;
  });
  const file: AgentExportFile = {
    type: 'desktop-pet-agents',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: safe,
  };
  return JSON.stringify(file, null, 2);
}

function toStrArr(v: unknown): string[] {
  const out: string[] = [];
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\n,，]/) : [];
  for (const x of raw) {
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v.trim();
  return v == null ? fallback : String(v).trim();
}

export function normalizeAgentText(
  text: string,
): { ok: true; items: NormalizedAgent[]; skipped: number } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文本，请检查内容' };
  }
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).profiles)) {
    arr = (raw as { profiles: unknown[] }).profiles;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).llmProfiles)) {
    arr = (raw as { llmProfiles: unknown[] }).llmProfiles;
  } else {
    return { ok: false, error: '格式无法识别：应为智能体数组，或含 profiles / llmProfiles 字段的对象' };
  }
  const items: NormalizedAgent[] = [];
  let skipped = 0;
  for (const it of arr) {
    if (!it || typeof it !== 'object') {
      skipped += 1;
      continue;
    }
    const o = it as Record<string, unknown>;
    const name = str(o.name);
    const baseUrl = str(o.baseUrl);
    const model = str(o.model);
    if (!name || !baseUrl || !model) {
      skipped += 1;
      continue;
    }
    items.push({
      name,
      baseUrl,
      model,
      systemPrompt: str(o.systemPrompt),
      avatar: str(o.avatar),
      intro: str(o.intro),
      domainTags: toStrArr(o.domainTags),
      role: str(o.role),
      style: str(o.style),
      greeting: str(o.greeting),
      exampleQuestions: toStrArr(o.exampleQuestions),
      apiKey: str(o.apiKey),
      enabled: o.enabled !== false,
    });
  }
  return { ok: true, items, skipped };
}

export function mergeImportedProfiles(current: LlmProfile[], items: NormalizedAgent[]): ImportOutcome {
  const list = [...current];
  let added = 0;
  let updated = 0;
  let missingKeys = 0;
  for (const inc of items) {
    if (!inc.apiKey) missingKeys += 1;
    const idx = list.findIndex((p) => p.name === inc.name);
    if (idx >= 0) {
      const cur = list[idx];
      list[idx] = {
        ...cur,
        name: inc.name,
        baseUrl: inc.baseUrl || cur.baseUrl,
        model: inc.model || cur.model,
        systemPrompt: inc.systemPrompt || cur.systemPrompt,
        avatar: inc.avatar || cur.avatar,
        intro: inc.intro || cur.intro,
        domainTags: inc.domainTags.length ? inc.domainTags : cur.domainTags,
        role: inc.role || cur.role,
        style: inc.style || cur.style,
        greeting: inc.greeting || cur.greeting,
        exampleQuestions: inc.exampleQuestions.length ? inc.exampleQuestions : cur.exampleQuestions,
      };
      updated += 1;
    } else {
      const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      list.push({
        id,
        name: inc.name,
        apiKey: inc.apiKey,
        baseUrl: inc.baseUrl,
        model: inc.model,
        systemPrompt: inc.systemPrompt,
        avatar: inc.avatar,
        intro: inc.intro,
        domainTags: inc.domainTags,
        role: inc.role,
        style: inc.style,
        greeting: inc.greeting,
        exampleQuestions: inc.exampleQuestions,
        enabled: inc.enabled,
      });
      added += 1;
    }
  }
  return { list, added, updated, missingKeys };
}

// ────────────────────────────────────────────────────────────────────────
// P1-2 多智能体识别 / 外部依赖提取 / 占位符自动替换（纯函数，两端同构）
// ────────────────────────────────────────────────────────────────────────

export interface ConfigParseResult {
  ok: true;
  value: unknown;
  format: 'yaml' | 'json';
}
export interface ConfigParseError {
  ok: false;
  error: string;
}
export type ConfigParseOutcome = ConfigParseResult | ConfigParseError;

/** 极简 YAML 子集解析：支持规格示例（缩进 2 空格、key: value、嵌套、- 数组项、# 注释、引号） */
export function yamlParseLite(text: string): ConfigParseOutcome {
  try {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
    if (lines.length === 0) {
      return { ok: false, error: '配置为空' };
    }
    const tokens = toYamlNodes(lines);
    if (tokens.length === 0) return { ok: false, error: '配置为空' };
    const built = buildYamlTree(tokens, 0);
    return { ok: true, value: built.value, format: 'yaml' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 解析入口：先试 JSON，再试 YAML 子集 */
export function parseConfigText(text: string): ConfigParseOutcome {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: '配置为空' };
  const json = tryParseJson(trimmed);
  if (json.ok) return json;
  const yaml = yamlParseLite(trimmed);
  if (yaml.ok) return yaml;
  return { ok: false, error: `既不是合法 JSON 也不是可识别的 YAML：${yaml.error}` };
}

function tryParseJson(text: string): ConfigParseOutcome {
  try {
    const v = JSON.parse(text);
    return { ok: true, value: v, format: 'json' };
  } catch {
    return { ok: false, error: '非法 JSON' };
  }
}

interface YamlNode {
  indent: number;
  text: string;
  isList: boolean;
}

/**
 * 递归构建 YAML 树：以 nodes[start].indent 为基准生成一个块（对象或列表）。
 * 关键支持：列表项 `- key: value` 后可携带更深缩进的子字段（并入同一列表元素），
 * 值空时递归下一行作为子块。返回 { value, next }，next 指向块结束后的下一个节点下标。
 */
function buildYamlTree(nodes: YamlNode[], start: number): { value: unknown; next: number } {
  const base = nodes[start].indent;
  return nodes[start].isList ? buildYamlList(nodes, start, base) : buildYamlMap(nodes, start, base);
}

/** 对象块：key: value 对；值为空时递归其后更深缩进行作为子块 */
function buildYamlMap(nodes: YamlNode[], start: number, base: number): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.indent < base || n.indent > base) break; // 更浅 = 父块；更深 = 应由递归处理，属异常直出
    if (n.isList) break; // 对象块内不可直接出现列表项
    const sep = findTopLevelColon(n.text);
    if (sep < 0) { i += 1; continue; }
    const key = n.text.slice(0, sep).trim().replace(/^["']|["']$/g, '');
    const valRaw = n.text.slice(sep + 1).trim();
    if (valRaw === '') {
      const next = i + 1 < nodes.length ? nodes[i + 1] : null;
      // 子块：更深缩进，或同缩进但为列表项（YAML 允许 `key:` 下一行列表不缩进）
      if (next && (next.indent > base || (next.indent === base && next.isList))) {
        const sub = buildYamlTree(nodes, i + 1);
        out[key] = sub.value;
        i = sub.next;
      } else {
        out[key] = null;
        i += 1;
      }
      continue;
    }
    out[key] = parseYamlScalar(valRaw);
    i += 1;
  }
  return { value: out, next: i };
}

/** 列表块：- item；item 可为标量、key:value（其后更深缩进行并入该元素）、或空项承接子块 */
function buildYamlList(nodes: YamlNode[], start: number, base: number): { value: unknown[]; next: number } {
  const out: unknown[] = [];
  let i = start;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.indent < base) break;
    if (!n.isList) break; // 列表块结束（深度不同的普通行不在此层）
    const content = n.text.replace(/^-\s*/, '').trim();
    if (content === '') {
      // `-` 空项承接子块
      if (i + 1 < nodes.length && nodes[i + 1].indent > base) {
        const sub = buildYamlTree(nodes, i + 1);
        out.push(sub.value);
        i = sub.next;
      } else {
        out.push(null);
        i += 1;
      }
      continue;
    }
    const sep = findTopLevelColon(content);
    if (sep < 0) {
      out.push(parseYamlScalar(content));
      i += 1;
      continue;
    }
    // 列表元素为 key: value（对象），其后的更深缩进行作为该元素的字段并入
    const el: Record<string, unknown> = {};
    const key = content.slice(0, sep).trim().replace(/^["']|["']$/g, '');
    const valRaw = content.slice(sep + 1).trim();
    if (valRaw === '') {
      if (i + 1 < nodes.length && nodes[i + 1].indent > base) {
        const sub = buildYamlTree(nodes, i + 1);
        el[key] = sub.value;
        i = sub.next;
      } else {
        el[key] = null;
        i += 1;
      }
    } else {
      el[key] = parseYamlScalar(valRaw);
      i += 1;
    }
    // 继续并入更深缩进的对象字段（含其嵌套子块），直到遇到下一列表项或列表结束
    while (i < nodes.length && nodes[i].indent > base && !nodes[i].isList) {
      const f = nodes[i];
      const fsep = findTopLevelColon(f.text);
      if (fsep < 0) { i += 1; continue; }
      const fkey = f.text.slice(0, fsep).trim().replace(/^["']|["']$/g, '');
      const fval = f.text.slice(fsep + 1).trim();
      if (fval === '') {
        if (i + 1 < nodes.length && nodes[i + 1].indent > nodes[i].indent) {
          const sub = buildYamlTree(nodes, i + 1);
          el[fkey] = sub.value;
          i = sub.next;
        } else {
          el[fkey] = null;
          i += 1;
        }
      } else {
        el[fkey] = parseYamlScalar(fval);
        i += 1;
      }
    }
    out.push(el);
  }
  return { value: out, next: i };
}

function toYamlNodes(lines: string[]): YamlNode[] {
  return lines
    .map((line) => {
      const indentMatch = line.match(/^(\s*)/);
      const indent = (indentMatch ? indentMatch[1].length : 0) ?? 0;
      const text = line.slice(indent).trim();
      return { indent, text, isList: text.startsWith('- ') };
    })
    .filter((n) => n.text.length > 0);
}

function findTopLevelColon(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/** 标量求值：去掉引号/注释，保留 ${VAR}、env:VAR、secret:VAR 等占位符，识别布尔/数字/null */
function parseYamlScalar(raw: string): unknown {
  let v = raw;
  // 去除行内注释（# 前有空格，避免识别 ${VAR}#x）
  v = v.replace(/\s+#.*$/, '').trim();
  if (v.length >= 2 && (v[0] === '"' && v[v.length - 1] === '"' || v[0] === "'" && v[v.length - 1] === "'")) {
    return v.slice(1, -1);
  }
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseYamlScalar(x.trim()) || '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** 多智能体识别结果（规格：kind/mode/orchestrator/agents/workflow/handoffs/steps） */
export interface MultiAgentInspect {
  detected: boolean;
  kind: string;
  name: string;
  orchestratorType: string;
  members: { id: string; model?: string; endpoint?: string }[];
  workflowSteps: string[];
}

/** 递归字符串收集器：在对象/数组所有字符串值与非键名中发现占位符变量 */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|(?:^|[\s:=])env:([A-Za-z_][A-Za-z0-9_]*)|(?:^|[\s:=])secret:([A-Za-z_][A-Za-z0-9_]*)/g;

function collectPlaceholderKeys(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectPlaceholderKeys(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectPlaceholderKeys(v, out);
    return;
  }
  if (typeof value === 'string') {
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(value)) !== null) {
      const key = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (key) out.add(key);
    }
  }
}

/** 按变量名推断依赖属性（key 内含 MODEL → 模型；KEY/SECRET → 凭据；AGENT/ENDPOINT/URL → 远程端点） */
function inferDependency(key: string): Pick<MultiAgentDependency, 'type' | 'protocol' | 'auth' | 'usage' | 'example'> {
  const k = key.toUpperCase();
  const isModel = /MODEL|LLM|OPENAI|GLM|DEEPSEEK|API_BASE|BASE_URL/.test(k);
  const isKey = /KEY|SECRET|TOKEN|PASSWORD/.test(k);
  const isAgent = /AGENT|ENDPOINT|URL|HOST|API/.test(k);
  const isMCP = /MCP|TOOL|FUNCTION/.test(k);
  if (isModel) {
    return {
      type: 'model',
      protocol: 'openai',
      auth: 'api_key',
      usage: '大模型 API（OpenAI 兼容）：Provider、Base URL 与模型名',
      example: 'https://api.openai.com/v1  /  gpt-4o  /  sk-xxx',
    };
  }
  if (isMCP) {
    return {
      type: 'tool_api',
      protocol: 'mcp',
      auth: 'bearer',
      usage: '工具 / MCP 端点：提供工具能力的外部服务地址',
      example: 'https://mcp.example.com  /  Bearer xxx',
    };
  }
  if (isAgent) {
    return {
      type: 'agent_api',
      protocol: 'rest',
      auth: isKey ? 'api_key' : 'bearer',
      usage: isKey ? '远程子智能体鉴权密钥' : '远程子智能体服务地址（REST）',
      example: isKey ? 'sk-remote-key' : 'https://agent.example.com/api',
    };
  }
  if (isKey) {
    return {
      type: 'other',
      protocol: 'other',
      auth: 'api_key',
      usage: '外部服务鉴权密钥',
      example: 'sk-xxx',
    };
  }
  return {
    type: 'other',
    protocol: 'rest',
    auth: 'bearer',
    usage: '外部 API 依赖（未明确定义，请按需修改）',
    example: 'https://example.com/api',
  };
}

/** 在主配置对象中识别多智能体特征并生成依赖清单 */
export function buildDependencyList(value: unknown, keyHint: string): MultiAgentDependency[] {
  const keys = new Set<string>();
  collectPlaceholderKeys(value, keys);
  // 也收集位于配置 key 中的占位符（如 name: ${AGENT_NAME}）
  collectPlaceholderKeys(keyHint, keys);
  const deps: MultiAgentDependency[] = [];
  let idx = 0;
  for (const key of Array.from(keys).sort()) {
    const infer = inferDependency(key);
    deps.push({
      key,
      ...infer,
      ref: `cred://dep_${++idx}`,
    });
  }
  return deps;
}

/** 识别多智能体（kind/mode/orchestrator/agents/workflow/handoffs/steps） */
export function inspectMultiAgent(value: unknown): MultiAgentInspect {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const kind = String(o.kind ?? o.mode ?? (Array.isArray(o.agents) ? 'multi_agent' : '')).toLowerCase();
  const detected =
    kind.includes('multi_agent') ||
    Array.isArray(o.agents) ||
    !!o.orchestrator ||
    !!o.supervisor ||
    !!o.router ||
    Array.isArray(o.workflow) ||
    Array.isArray(o.steps) ||
    !!o.handoffs;
  const orchestrator = (o.orchestrator ?? o.supervisor ?? o.router ?? {}) as Record<string, unknown>;
  const members: { id: string; model?: string; endpoint?: string }[] = [];
  const rawAgents = Array.isArray(o.agents) ? o.agents : [];
  for (const a of rawAgents) {
    const ag = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const id = String(ag.id ?? ag.name ?? ag.key ?? 'agent');
    members.push({
      id,
      model: typeof ag.model === 'string' ? ag.model : undefined,
      endpoint: typeof ag.endpoint === 'string' ? ag.endpoint : undefined,
    });
  }
  const workflowSource = Array.isArray(o.workflow) ? o.workflow : Array.isArray(o.steps) ? o.steps : [];
  const workflowSteps: string[] = workflowSource.map((w) => {
    if (typeof w === 'string') return w;
    const wo = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    return String(wo.step ?? wo.name ?? wo.type ?? '');
  });
  return {
    detected,
    kind: detected ? (kind || 'multi_agent') : 'single',
    name: String(o.name ?? ''),
    orchestratorType: String(orchestrator.type ?? ''),
    members,
    workflowSteps,
  };
}

/** 将原始文本中的 ${VAR}/{{VAR}}/env:VAR/secret:VAR 替换为内部凭证引用 cred://dep_N */
export function replacePlaceholdersToRefs(text: string, deps: MultiAgentDependency[]): string {
  let out = text;
  for (const d of deps) {
    // 按变量名替换 4 种占位形式（值中）
    const reVar = new RegExp(`\\$\\{${escapeRe(d.key)}\\}|\\{\\{\\s*${escapeRe(d.key)}\\s*\\}\\}`, 'g');
    out = out.replace(reVar, d.ref);
    const reEnv = new RegExp(`(\\b)env:${escapeRe(d.key)}(\\b)`, 'g');
    out = out.replace(reEnv, `$1${d.ref}$2`);
    const reSec = new RegExp(`(\\b)secret:${escapeRe(d.key)}(\\b)`, 'g');
    out = out.replace(reSec, `$1${d.ref}$2`);
  }
  return out;
}

/** 导出时把 cred:// 引用恢复为原始 ${VAR} 占位符（可读且不含凭证） */
export function safeRaw(raw: string, deps: MultiAgentDependency[]): string {
  let out = raw;
  for (const d of deps) {
    const re = new RegExp(escapeRe(d.ref), 'g');
    out = out.replace(re, `\${${d.key}}`);
  }
  return out;
}

/** 运行时注入：把配置文本中的 cred://dep_N 替换为真实凭证值 */
export function injectCredentials(text: string, deps: MultiAgentDependency[], credentials: Record<string, string>): string {
  let out = text;
  for (const d of deps) {
    const val = credentials[d.ref] ?? '';
    const re = new RegExp(escapeRe(d.ref), 'g');
    out = out.replace(re, val);
  }
  return out;
}

/** 便捷：由 LlmProfile 构造多智能体配置对象（自动替换为 cred:// 引用并保留凭证） */
export function buildMultiConfig(rawText: string, format: 'yaml' | 'json'): { ok: true; cfg: AgentMultiConfig; inspect: MultiAgentInspect } | { ok: false; error: string } {
  const parse = parseConfigText(rawText);
  if (!parse.ok) return { ok: false, error: parse.error };
  const deps = buildDependencyList(parse.value, rawText);
  const safe = replacePlaceholdersToRefs(rawText, deps);
  const inspect = inspectMultiAgent(parse.value);
  return {
    ok: true,
    inspect,
    cfg: { raw: safe, format, deps, credentials: {} },
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}