/**
 * 多智能体运行时编排器（后端，服务端 Config Parser / Orchestrator）。
 * 最小闭环：注入凭证 → 解析配置（JSON / YAML 子集） → 识别子智能体与编排模式 →
 * 按 supervisor/router/并行/顺序/handoff 协同执行 → 主模型汇总 → 返回结果与轨迹。
 * 子智能体调用 MVP：OpenAI 兼容 /chat/completions 非流式（协议 openai / rest 均按此处理）。
 * YAML 子集解析逻辑与两端 agentPort.ts 同构，避免引入新依赖（服务器离线部署，node_modules 不可变）。
 */
import { BadRequestException } from '@nestjs/common';

export interface TraceItem {
  /** route / delegate / parallel / sequential / summarize / single */
  stage: string;
  agentId?: string;
  model?: string;
  input?: string;
  output?: string;
  latencyMs?: number;
  error?: string;
}

export interface OrchestrateResult {
  content: string;
  trace: TraceItem[];
  latencyMs: number;
}

interface ResolvedAgent {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  instructions: string;
}

interface MainModel {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AgentDepLike {
  key: string;
  ref: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 依赖注入：把配置中的 cred://dep_N 引用替换为真实凭证值
// ────────────────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function injectCredentials(
  text: string,
  deps: AgentDepLike[],
  credentials: Record<string, string>,
): string {
  let out = text;
  for (const d of deps ?? []) {
    const val = credentials?.[d.ref] ?? '';
    // 兜底两种占位形式：前端已替换的 cred:// 引用；或导入的原始 ${KEY} 形式（== 类同 agentPort 自动替换）
    out = out.replace(new RegExp(`\\$\\{${escapeRe(d.key)}\\}|\\{\\{\\s*${escapeRe(d.key)}\\s*\\}\\}`, 'g'), val);
    out = out.replace(new RegExp(escapeRe(d.ref), 'g'), val);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Config Parser：JSON 优先，其次 YAML 子集（与 agentPort.ts 同构）
// ────────────────────────────────────────────────────────────────────────────

interface YamlNode {
  indent: number;
  text: string;
  isList: boolean;
}

function yamlToNodes(lines: string[]): YamlNode[] {
  return lines
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
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

function parseYamlScalar(raw: string): unknown {
  let v = raw.replace(/\s+#.*$/, '').trim();
  if (
    v.length >= 2 &&
    ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))
  ) {
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

function buildYamlTree(nodes: YamlNode[], start: number): { value: unknown; next: number } {
  return nodes[start].isList
    ? buildYamlList(nodes, start, nodes[start].indent)
    : buildYamlMap(nodes, start, nodes[start].indent);
}

function buildYamlMap(
  nodes: YamlNode[],
  start: number,
  base: number,
): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.indent < base) break;
    if (n.isList) break;
    const sep = findTopLevelColon(n.text);
    if (sep < 0) {
      i += 1;
      continue;
    }
    const key = n.text.slice(0, sep).trim().replace(/^["']|["']$/g, '');
    const valRaw = n.text.slice(sep + 1).trim();
    if (valRaw === '') {
      const next = i + 1 < nodes.length ? nodes[i + 1] : null;
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

function buildYamlList(
  nodes: YamlNode[],
  start: number,
  base: number,
): { value: unknown[]; next: number } {
  const out: unknown[] = [];
  let i = start;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.indent < base || !n.isList) break;
    const content = n.text.replace(/^-\s*/, '').trim();
    if (content === '') {
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
    while (i < nodes.length && nodes[i].indent > base && !nodes[i].isList) {
      const f = nodes[i];
      const fsep = findTopLevelColon(f.text);
      if (fsep < 0) {
        i += 1;
        continue;
      }
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

export function parseConfigText(
  text: string,
): { ok: true; value: unknown; format: 'yaml' | 'json' } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: '配置为空' };
  try {
    return { ok: true, value: JSON.parse(trimmed), format: 'json' };
  } catch {
    // 继续尝试 YAML
  }
  try {
    const tokens = yamlToNodes(trimmed.split(/\r?\n/).map((l) => l.replace(/\r$/, '')));
    if (tokens.length === 0) return { ok: false, error: '配置为空' };
    const built = buildYamlTree(tokens, 0);
    return { ok: true, value: built.value, format: 'yaml' };
  } catch (e) {
    return { ok: false, error: `既不是合法 JSON 也不是可识别的 YAML：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 子智能体 / 主模型调用（OpenAI 兼容 /chat/completions，非流式）
// ────────────────────────────────────────────────────────────────────────────

interface AgentCallResult {
  output: string;
  latencyMs: number;
  error?: string;
}

async function callOpenAiChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
): Promise<{ content: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.8 }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 150)}` : ''}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口未返回内容');
    return { content: String(content) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      throw new Error(`调用超时（${Math.floor(timeoutMs / 1000)} 秒未响应）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callAgent(a: ResolvedAgent, input: string, contextText: string): Promise<AgentCallResult> {
  const started = Date.now();
  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (a.instructions) {
      messages.push({ role: 'system', content: a.instructions });
    } else {
      messages.push({
        role: 'system',
        content: `你是子智能体「${a.id}」：直接处理任务，回复保持简洁、口语化，不超过 200 字。`,
      });
    }
    if (contextText.trim()) {
      messages.push({ role: 'user', content: `（上文对话，仅供理解上下文，请勿复述）\n${contextText}` });
    }
    messages.push({ role: 'user', content: input });
    const model = a.model || 'default';
    const { content } = await callOpenAiChat(a.endpoint, a.apiKey, model, messages, 60000);
    return { output: content, latencyMs: Date.now() - started };
  } catch (e) {
    return {
      output: '',
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 从模型文本中尽量提取 {"agent":"..."} JSON，失败返回 null */
function extractAgentJson(text: string): { agent?: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v && typeof v === 'object') return v as { agent?: string };
  } catch {
    // 继续尝试正则
  }
  const id = text.match(/["']?agent["']?\s*[:：=]\s*["']([^"']+)["']/);
  if (id) return { agent: id[1].trim() };
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 编排主流程
// ────────────────────────────────────────────────────────────────────────────

export interface OrchestrateOptions {
  profile: {
    name: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    systemPrompt?: string;
    role?: string;
    style?: string;
  };
  raw: string;
  format: 'yaml' | 'json';
  deps: AgentDepLike[];
  credentials: Record<string, string>;
  question: string;
  contextText?: string;
  /** 路由/汇总使用的主模型（默认取 profile；可为空表示纯子智能体协同） */
  mainOverride?: { baseUrl: string; apiKey: string; model: string };
}

export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const started = Date.now();
  const trace: TraceItem[] = [];

  // 1) 注入凭证 → 解析
  const resolvedText = injectCredentials(opts.raw ?? '', opts.deps ?? [], opts.credentials ?? {});
  const parsed = parseConfigText(resolvedText);
  if (!parsed.ok) {
    throw new BadRequestException(`智能体配置解析失败：${parsed.error}`);
  }
  const value = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as Record<
    string,
    unknown
  >;

  // 2) 子智能体清单与编排模式
  const rawAgents = Array.isArray(value.agents) ? value.agents : [];
  const agents: ResolvedAgent[] = [];
  for (const ra of rawAgents) {
    if (!ra || typeof ra !== 'object') continue;
    const a = ra as Record<string, unknown>;
    const endpoint = typeof a.endpoint === 'string' ? a.endpoint.trim() : '';
    if (!endpoint) continue;
    agents.push({
      id: String(
        a.id ?? a.name ?? (typeof a.key === 'string' ? a.key : `agent${agents.length + 1}`),
      ),
      endpoint,
      apiKey: typeof a.api_key === 'string' ? a.api_key.trim() : typeof a.apiKey === 'string' ? a.apiKey.trim() : '',
      model: typeof a.model === 'string' ? a.model.trim() : '',
      instructions: typeof a.instructions === 'string' ? a.instructions.trim() : '',
    });
  }

  const orch =
    (value.orchestrator && typeof value.orchestrator === 'object'
      ? value.orchestrator
      : (value.supervisor && typeof value.supervisor === 'object'
          ? value.supervisor
          : (value.router && typeof value.router === 'object' ? value.router : {}))) as Record<
      string,
      unknown
    >;
  const otype = String(orch.type ?? value.mode ?? '').toLowerCase();
  const kind = String(value.kind ?? value.mode ?? '').toLowerCase();
  const workflowSource = Array.isArray(value.workflow)
    ? value.workflow
    : Array.isArray(value.steps)
      ? value.steps
      : [];
  const wsteps = workflowSource
    .map((w) => (typeof w === 'string' ? String(w) : String((w as Record<string, unknown>).step ?? (w as Record<string, unknown>).name ?? (w as Record<string, unknown>).type ?? '')))
    .map((s) => s.toLowerCase());

  const main = opts.mainOverride || (opts.profile.baseUrl && opts.profile.apiKey && opts.profile.model
    ? { baseUrl: opts.profile.baseUrl, apiKey: opts.profile.apiKey, model: opts.profile.model }
    : null);

  const question = opts.question?.trim() || '你好';
  const contextText = opts.contextText?.trim() ?? '';

  const parts: string[] = [];
  const profilePrompt = opts.profile.systemPrompt?.trim();
  if (profilePrompt) parts.push(profilePrompt);
  if (opts.profile.role?.trim()) parts.push(`你的角色：${opts.profile.role.trim()}。`);
  if (opts.profile.style?.trim()) parts.push(`你的说话风格：${opts.profile.style.trim()}，请全程保持。`);
  if (parts.length === 0) parts.push('你是一个贴心的桌面助手智能体，回复友好、简洁。');
  const mainSystem = parts.join('\n');

  // 3) 无子智能体：单模型直答（编排器退化为主模型）
  if (agents.length === 0) {
    if (!main) {
      throw new BadRequestException(
        '配置中没有可用的子智能体（agents 下的 endpoint 为空），且当前档案缺少主模型 Key/接口，无法执行协同',
      );
    }
    trace.push({ stage: 'single', model: main.model, input: question });
    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: mainSystem }];
    if (contextText) messages.push({ role: 'user', content: `（上文对话）\n${contextText}` });
    messages.push({ role: 'user', content: question });
    const { content } = await callOpenAiChat(main.baseUrl, main.apiKey, main.model, messages, 300000);
    trace[trace.length - 1].output = content.slice(0, 300);
    return { content, trace, latencyMs: Date.now() - started };
  }

  // 4) 多子智能体：路由 → 执行（顺序/并行） → 汇总
  const wantRoute =
    otype === 'supervisor' || otype === 'router' || /(^|\s)(route|router|supervisor)(\s|$)/.test(wsteps.join(' '));
  const wantSeq = /(handoff|sequential|sequence|chain)/.test(wsteps.join(' ') + kind) && !wantRoute;

  let targets: ResolvedAgent[] = agents;
  if (wantRoute && main) {
    // 路由：主模型从子智能体中挑一个（空 = 全部协作）
    const list = agents
      .map((a) => `- id: ${a.id}${a.instructions ? `（用途：${a.instructions.slice(0, 80)}）` : ''}`)
      .join('\n');
    const route = await callOpenAiChat(
      main.baseUrl,
      main.apiKey,
      main.model,
      [
        {
          role: 'system',
          content: `你是多智能体编排的调度员。可用子智能体：\n${list}\n根据用户提问选择最合适的子智能体，只输出一个 JSON 对象（不要任何其他文字），如 {"agent":"health"}；若需多个协作则输出 {"agent":""}。`,
        },
        { role: 'user', content: `用户提问：${question}` },
      ],
      120000,
    ).then(
      (r) => r.content,
      (e) => {
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
    const picked = extractAgentJson(route);
    const targetId = picked?.agent?.trim() ?? '';
    trace.push({
      stage: 'route',
      model: main.model,
      input: question,
      output: targetId || '（调度员选择全部协作）',
    });
    if (targetId) {
      const hit = agents.find((a) => a.id === targetId);
      if (hit) targets = [hit];
    }
  }

  // 执行阶段
  const callResults: Array<{ agent: ResolvedAgent; result: AgentCallResult }> = [];
  let final = '';
  if (targets.length === 1 && !wantSeq) {
    const result = await callAgent(targets[0], question, contextText);
    callResults.push({ agent: targets[0], result });
    trace.push({
      stage: 'delegate',
      agentId: targets[0].id,
      input: question.slice(0, 200),
      output: result.output.slice(0, 300),
      latencyMs: result.latencyMs,
      error: result.error,
    });
    final = result.output || result.error || '';
  } else if (wantSeq) {
    // 顺序 / handoff：前一智能体输出作为下一智能体输入
    let prev: { agent: string; output: string } | null = null;
    for (const a of targets) {
      const input = `用户问题：${question}${prev ? `\n\n前一阶段输出（「${prev.agent}」）：\n${prev.output}` : ''}`;
      const result = await callAgent(a, input, contextText);
      callResults.push({ agent: a, result });
      trace.push({
        stage: 'sequential',
        agentId: a.id,
        input: input.slice(0, 200),
        output: result.output.slice(0, 300),
        latencyMs: result.latencyMs,
        error: result.error,
      });
      prev = { agent: a.id, output: result.output || result.error || '' };
    }
    final = prev?.output ?? '';
  } else {
    // 并行执行全部
    const results = await Promise.all(targets.map((a) => callAgent(a, question, contextText)));
    results.forEach((result, i) => {
      const agent = targets[i];
      callResults.push({ agent, result });
      trace.push({
        stage: 'parallel',
        agentId: agent.id,
        input: question.slice(0, 200),
        output: result.output.slice(0, 300),
        latencyMs: result.latencyMs,
        error: result.error,
      });
    });
    final = results.map((r, i) => `【${targets[i].id}】\n${r.output || r.error || ''}`).join('\n\n');
  }

  // 全部失败则直接报错
  const errors = callResults
    .filter((c) => c.result.error)
    .map((c) => `「${c.agent.id}」调用失败：${c.result.error}`);
  const okCount = callResults.filter((c) => !c.result.error).length;
  if (okCount === 0) {
    throw new BadRequestException(
      `多智能体协同执行失败：${errors[0] ?? '未知错误'}${errors.length > 1 ? `（另有 ${errors.length - 1} 个智能体失败）` : ''}`,
    );
  }

  // 汇总：主模型组织最终答复（supervisor 气质）；无主模型则直接使用子智能体输出
  const outputsText = callResults
    .map((c) => `【${c.agent.id}】${c.result.error ? `错误：${c.result.error}` : c.result.output}`)
    .join('\n\n');
  if (main) {
    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: `${mainSystem}\n你是多智能体协同的最终回复者：基于子智能体输出直接回答用户。输出不足或部分失败时如实说明，别罗列技术细节。`,
      },
    ];
    if (contextText) messages.push({ role: 'user', content: `（上文对话，仅供理解）\n${contextText}` });
    messages.push({
      role: 'user',
      content: `用户提问：\n${question}\n\n子智能体输出：\n${outputsText}`,
    });
    const summarized = await callOpenAiChat(main.baseUrl, main.apiKey, main.model, messages, 300000);
    trace.push({
      stage: 'summarize',
      model: main.model,
      input: question.slice(0, 200),
      output: summarized.content.slice(0, 300),
    });
    final = summarized.content;
  }

  if (!final.trim()) {
    throw new BadRequestException('多智能体协同未产生任何输出');
  }
  return { content: final, trace, latencyMs: Date.now() - started };
}