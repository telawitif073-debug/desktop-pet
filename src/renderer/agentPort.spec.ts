import { describe, expect, it } from 'vitest';
import {
  buildDependencyList,
  exportAgentJson,
  extractConfigText,
  injectCredentials,
  inspectMultiAgent,
  isPersonaCard,
  mergeImportedProfiles,
  normalizeAgentText,
  parseConfigText,
  personaCardToAgent,
  personaToPrompt,
  safeRaw,
  yamlParseLite,
} from './agentPort';
import { capabilityDesc, capabilityLabel, detectCapabilities } from './agentCapabilities';
import type { LlmProfile } from '../global.d';

function profile(over: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: 'p1',
    name: '医疗助手',
    apiKey: 'sk-secret',
    baseUrl: 'https://api.test/v1',
    model: 'deepseek-chat',
    ...over,
  };
}

describe('agentPort 导出剥离（T4）', () => {
  it('导出不含 apiKey/id/boundVoiceId 等本机偏好', () => {
    const json = exportAgentJson([
      profile({ boundVoiceId: 'local-1', avatar: '🐱', domainTags: ['医疗'] }),
    ]);
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('local-1');
    expect(json).not.toContain('"id"');
    const file = JSON.parse(json);
    expect(file.type).toBe('desktop-pet-agents');
    expect(file.version).toBe(1);
    expect(file.profiles).toHaveLength(1);
    expect(file.profiles[0]).toMatchObject({
      name: '医疗助手',
      model: 'deepseek-chat',
      avatar: '🐱',
      domainTags: ['医疗'],
      apiKey: '',
      enabled: true,
    });
  });

  it('多智能体配置导出时剥离凭证值，并把 cred:// 引用还原成 ${VAR}', () => {
    const json = exportAgentJson([
      profile({
        multiConfig: {
          raw: 'model: cred://dep_1',
          format: 'yaml',
          deps: [
            { key: 'MODEL_KEY', type: 'model', protocol: 'openai', auth: 'api_key', usage: 'u', example: 'e', ref: 'cred://dep_1' },
          ],
          credentials: { 'cred://dep_1': 'sk-live-secret' },
        },
      }),
    ]);
    expect(json).not.toContain('sk-live-secret'); // 凭证值必须剥离
    expect(json).not.toContain('"credentials"');
    const multi = JSON.parse(json).profiles[0].multiConfig;
    expect(multi.raw).toBe('model: ${MODEL_KEY}'); // 配置骨架还原为可读占位符
    expect(multi.deps).toHaveLength(1); // 依赖清单随文件带走（ref 为内部引用，非密钥）
    expect(multi.deps[0].ref).toBe('cred://dep_1');
  });
});

describe('agentPort 配置文本解析（T4）', () => {
  it('extractConfigText 剥离代码块围栏与前后说明文字', () => {
    expect(extractConfigText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractConfigText('说明文字 {"a":1} 结尾说明')).toBe('{"a":1}');
    expect(extractConfigText('[1,2]')).toBe('[1,2]');
    expect(extractConfigText('   ')).toBe('');
  });

  it('parseConfigText 先 JSON 后 YAML；空内容与纯注释给出中文错误', () => {
    expect(parseConfigText('{"name":"A"}')).toMatchObject({ ok: true, format: 'json' });
    const yaml = parseConfigText('name: 小助手\nmodel: glm-4-flash');
    expect(yaml.ok).toBe(true);
    if (yaml.ok) expect(yaml.format).toBe('yaml');
    // 空文本 / 只有注释：解析失败且错误文案提到 YAML
    const bad = parseConfigText('# 只有注释');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('YAML');
    const empty = parseConfigText('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe('配置为空');
    // 无冒号的纯文本会被 YAML 子集解析成空对象：由上层「未能识别配置字段」兜底拦截
    const noise = parseConfigText('这不是配置');
    expect(noise.ok).toBe(true);
    if (noise.ok) expect(noise.value).toEqual({});
  });

  it('yamlParseLite 支持嵌套、列表项带子字段、注释、引号与标量类型', () => {
    const out = yamlParseLite(
      [
        '# 注释',
        'name: 小助手',
        'enabled: true',
        'count: 3',
        'nothing: null',
        'tags: [医疗, 陪伴]',
        'tasks:',
        '  - user_input: 叫我起床',
        '    repeat: daily',
        '  - user_input: 提醒我喝水',
        'nested:',
        '  inner: "带引号"',
      ].join('\n'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const v = out.value as Record<string, unknown>;
    expect(v.name).toBe('小助手');
    expect(v.enabled).toBe(true);
    expect(v.count).toBe(3);
    expect(v.nothing).toBeNull();
    expect(v.tags).toEqual(['医疗', '陪伴']);
    expect(v.tasks).toEqual([
      { user_input: '叫我起床', repeat: 'daily' },
      { user_input: '提醒我喝水' },
    ]);
    expect((v.nested as Record<string, unknown>).inner).toBe('带引号');
  });

  it('YAML 标量保留 ${VAR} / env:VAR 占位符并剥离行内注释', () => {
    const out = yamlParseLite('apiKey: ${MODEL_KEY}  # 占位\nbase: env:BASE_URL');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const v = out.value as Record<string, unknown>;
    expect(v.apiKey).toBe('${MODEL_KEY}');
    expect(v.base).toBe('env:BASE_URL');
  });
});

describe('agentPort 导入解析（T4）', () => {
  it('normalizeAgentText 支持数组 / profiles / llmProfiles 三种形状并跳过无效条目', () => {
    const arr = normalizeAgentText(JSON.stringify([
      { name: 'A', baseUrl: 'u', model: 'm' },
      'not-an-object',
      { name: '', baseUrl: 'u', model: 'm' },
      { name: 'B', baseUrl: '', model: 'm' },
    ]));
    expect(arr.ok).toBe(true);
    if (!arr.ok) return;
    expect(arr.items).toHaveLength(1);
    expect(arr.items[0].name).toBe('A');
    expect(arr.skipped).toBe(3);

    for (const shape of ['{"profiles":[]}', '{"llmProfiles":[]}']) {
      expect(normalizeAgentText(shape)).toMatchObject({ ok: true, items: [] });
    }
  });

  it('识别人设卡并按 species/tone/口头禅映射到标准条目', () => {
    const card = {
      agent_name: '小狐',
      persona: { species: '一只小狐狸', age: '18', tone: ['温柔', '俏皮'], catchphrases: ['嘿嘿~', '好呀'] },
      example_tasks: [{ user_input: '叫我起床' }, { user_input: '提醒我喝水' }],
    };
    expect(isPersonaCard(card)).toBe(true);
    expect(personaToPrompt(card)).toContain('你是一只小狐狸。');
    const agent = personaCardToAgent(card);
    expect(agent?.name).toBe('小狐');
    expect(agent?.role).toBe('一只小狐狸');
    expect(agent?.style).toBe('温柔、俏皮');
    expect(agent?.greeting).toBe('嘿嘿~');
    expect(agent?.exampleQuestions).toEqual(['叫我起床', '提醒我喝水']);

    const parsed = normalizeAgentText(JSON.stringify(card));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.items[0].name).toBe('小狐');
  });

  it('非 JSON 与无法识别的形状给出明确中文错误', () => {
    const bad = normalizeAgentText('这不是 JSON');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('不是合法的 JSON');
    const unknown = normalizeAgentText('{"foo":1}');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('人设卡');
  });
});

describe('agentCapabilities 能力检测（T4）', () => {
  it('结构化键命中：定时/主动/联网三类', () => {
    const det = detectCapabilities({
      capabilities: { natural_language_to_cron: true, proactive_chat: true, web_search: true },
    });
    expect(det.kinds).toEqual(['tasks', 'proactive', 'web']);
    expect(det.reasons.join()).toContain('声明了定时/提醒任务能力');
  });

  it('中文语义命中：提醒类需求 → tasks；主动搭话 → proactive', () => {
    const det = detectCapabilities({ systemPrompt: '你会在用户说提醒我吃药时记下来，并主动搭话关心他' });
    expect(det.kinds).toContain('tasks');
    expect(det.kinds).toContain('proactive');
  });

  it('平台免费技能：skills 声明与中文场景分别命中 weather/stock/football', () => {
    expect(detectCapabilities({ tools: ['get_weather'] }).kinds).toContain('weather');
    expect(detectCapabilities({ systemPrompt: '可以问我股价' }).kinds).toContain('stock');
    expect(detectCapabilities({ systemPrompt: '支持竞彩足球胜平负赔率' }).kinds).toContain('football');
  });

  it('读取 JSON 声明的间隔/时段/示例任务/每日上限并写入 spec', () => {
    const det = detectCapabilities({
      interval_minutes: 60,
      waking_hours: [8, 22],
      example_tasks: [{ user_input: '叫我起床' }, { user_input: '叫我起床' }, { input: '提醒喝水' }],
      frequency_control: { max_active_tasks_per_day: 5 },
    });
    expect(det.spec.intervalMinutes).toBe(60);
    expect(det.spec.wakingHours).toEqual([8, 22]);
    expect(det.spec.exampleTasks).toEqual(['叫我起床', '提醒喝水']);
    expect(det.spec.maxActiveTasksPerDay).toBe(5);
    expect(det.spec.source).toBe('import');
  });

  it('无任何能力线索时返回空清单（不误报）', () => {
    const det = detectCapabilities({ name: '翻译助手', systemPrompt: '把中文翻译成英文' });
    expect(det.kinds).toEqual([]);
  });

  it('6 种能力都有中文名与说明', () => {
    for (const kind of ['proactive', 'tasks', 'web', 'weather', 'stock', 'football'] as const) {
      expect(capabilityLabel(kind).length).toBeGreaterThan(0);
      expect(capabilityDesc(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('agentPort 合并导入（T4）', () => {
  const incoming = {
    name: '医疗助手',
    baseUrl: 'https://new.test/v1',
    model: 'glm-4-flash',
    systemPrompt: '新的人设',
    avatar: '',
    intro: '',
    domainTags: [],
    role: '',
    style: '',
    greeting: '',
    exampleQuestions: [],
    apiKey: '',
    enabled: true,
  };

  it('同名更新：保留本地 id/Key/专属音色/启停与已启用能力，仅刷新声明字段', () => {
    const current = [
      profile({
        boundVoiceId: 'local-1',
        enabled: false,
        avatar: '🐱',
        capabilities: { enabled: ['tasks'], spec: { source: 'manual' } },
      }),
    ];
    const outcome = mergeImportedProfiles(current, [
      { ...incoming, detection: detectCapabilities({ web_search: true, interval_minutes: 30 }) },
    ]);
    expect(outcome.updated).toBe(1);
    expect(outcome.added).toBe(0);
    expect(outcome.missingKeys).toBe(1);
    const merged = outcome.list[0];
    expect(merged.id).toBe('p1'); // 保留本地 id
    expect(merged.apiKey).toBe('sk-secret'); // 保留本地 Key
    expect(merged.boundVoiceId).toBe('local-1');
    expect(merged.enabled).toBe(false); // 启停仍以本地为准
    expect(merged.avatar).toBe('🐱'); // 导入为空 → 保留本地
    expect(merged.model).toBe('glm-4-flash'); // 非空 → 覆盖
    expect(merged.capabilities?.enabled).toEqual(['tasks']); // 已启用能力保留
    expect(merged.capabilities?.spec.intervalMinutes).toBe(30); // 规格刷新
    expect(outcome.capabilityOffers?.[0]).toMatchObject({
      profileId: 'p1',
      kinds: ['web'],
      enabled: ['tasks'],
    });
  });

  it('新名称新增为独立智能体（不切换激活），并给出能力待确认项', () => {
    const outcome = mergeImportedProfiles([profile()], [
      { ...incoming, name: '新助手', model: 'm', baseUrl: 'u', detection: detectCapabilities({ web_search: true }) },
    ]);
    expect(outcome.added).toBe(1);
    expect(outcome.list).toHaveLength(2);
    const added = outcome.list[1];
    expect(added.name).toBe('新助手');
    expect(added.id).not.toBe('p1');
    expect(added.enabled).toBe(true);
    expect(added.capabilities?.enabled).toEqual([]); // 待用户确认
    expect(outcome.capabilityOffers?.[0].kinds).toEqual(['web']);
  });

  it('无能力检测结果时不产生 capabilityOffers', () => {
    const outcome = mergeImportedProfiles([], [{ ...incoming, name: '普通助手' }]);
    expect(outcome.capabilityOffers).toBeUndefined();
    expect(outcome.added).toBe(1);
  });
});

describe('agentPort 多智能体编排（T4）', () => {
  it('识别多智能体配置并抽取成员与流程步骤', () => {
    const inspect = inspectMultiAgent({
      kind: 'multi_agent',
      orchestrator: { type: 'router' },
      agents: [{ id: 'a1', model: 'gpt-4o' }, { name: 'a2' }],
      workflow: ['第一步', { step: '第二步' }],
    });
    expect(inspect.detected).toBe(true);
    expect(inspect.orchestratorType).toBe('router');
    expect(inspect.members.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(inspect.workflowSteps).toEqual(['第一步', '第二步']);
    expect(inspectMultiAgent({ name: 'x' }).detected).toBe(false);
  });

  it('占位符 → 依赖清单 → cred:// 引用 → 运行时注入 → 导出还原', () => {
    const raw = 'model_api: ${MODEL_KEY}\nagent: env:AGENT_URL\nsecret: secret:BOT_TOKEN';
    const parsed = parseConfigText(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const deps = buildDependencyList(parsed.value, raw);
    expect(deps.map((d) => d.key)).toEqual(['AGENT_URL', 'BOT_TOKEN', 'MODEL_KEY']);
    expect(deps[0]).toMatchObject({ ref: 'cred://dep_1', type: 'agent_api' });
    const modelDep = deps.find((d) => d.key === 'MODEL_KEY');
    expect(modelDep?.type).toBe('model');
    expect(modelDep?.protocol).toBe('openai');

    const modelRef = modelDep?.ref ?? '';
    const safe = safeRaw(raw.replace('${MODEL_KEY}', modelRef), deps);
    expect(safe).toContain('${MODEL_KEY}');

    const injected = injectCredentials(modelRef, deps, { [modelRef]: 'sk-live' });
    expect(injected).toBe('sk-live');
  });
});