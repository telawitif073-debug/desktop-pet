import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Button, Card, Divider, Form, Input, Modal, Popconfirm, Space, Switch, Tag, Typography, message } from 'antd';
import { ApiOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ExperimentOutlined, PlusOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import type { AgentMultiConfig, LlmProfile, MultiAgentDependency, SyncConfigPayload } from '../types';
import { getSyncConfig, putSyncConfig, verifyDependency } from '../api';
import { getErrorMessage } from '../utils';
import { buildMultiConfig, exportAgentJson, inspectMultiAgent, normalizeAgentText, mergeImportedProfiles, parseConfigText, replacePlaceholdersToRefs, safeRaw } from '../agentPort';
import type { MultiAgentInspect } from '../agentPort';

const { Text, Paragraph } = Typography;

const DOMAIN_TAG_PRESETS = ['医疗', '训练', '内容', '陪伴', '电商'];
const ROLE_PRESETS = ['医生', '训练师', '经纪人', '管家', '老师', '朋友'];
const STYLE_PRESETS = ['温柔', '毒舌', '专业', '搞笑', '简短'];

function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface FormValues {
  name: string;
  avatar?: string;
  intro?: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  domainTags?: string;
  role?: string;
  style?: string;
  greeting?: string;
  exampleQuestions?: string;
}

/** 逗号/换行分隔文本 → 数组 */
function toList(text?: string): string[] | undefined {
  if (!text) return undefined;
  const out: string[] = [];
  for (const line of String(text).split(/[\n,，]/)) {
    const t = line.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length ? out : undefined;
}

export default function AgentsPage() {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [payload, setPayload] = useState<SyncConfigPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<LlmProfile | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 多智能体编排配置向导状态（P1-2）──
  const [multiRaw, setMultiRaw] = useState(''); // 用户粘贴的原始配置（YAML/JSON）
  const [multiFormat, setMultiFormat] = useState<'yaml' | 'json'>('yaml');
  const [multiInspect, setMultiInspect] = useState<MultiAgentInspect | null>(null); // 识别结果
  const [multiDeps, setMultiDeps] = useState<MultiAgentDependency[] | null>(null); // 依赖清单（识别后非空）
  const [multiValues, setMultiValues] = useState<Record<string, string>>({}); // ref → 用户填写的凭证值
  const [multiError, setMultiError] = useState('');
  const [testingRef, setTestingRef] = useState(''); // 正在测试连通性的依赖 ref
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; status: number | null; latencyMs: number | null; error?: string }>>({});
  const [multiSaving, setMultiSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const cfg = await getSyncConfig<SyncConfigPayload>();
      setPayload(cfg);
      setProfiles(Array.isArray(cfg.llmProfiles) ? cfg.llmProfiles : []);
      setActiveId(cfg.llmActiveProfileId ?? '');
    } catch (e) {
      messageApi.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = async (next: LlmProfile[], nextActiveId: string) => {
    const nextPayload: SyncConfigPayload = { ...(payload ?? {}), llmProfiles: next, llmActiveProfileId: nextActiveId };
    setProfiles(next);
    setActiveId(nextActiveId);
    setPayload(nextPayload);
    await putSyncConfig(nextPayload);
  };

  // ── P1 导入导出：导出剥离凭证，导入按名称合并 ──
  const handleExport = () => {
    if (profiles.length === 0) {
      messageApi.warning('还没有智能体可导出');
      return;
    }
    const json = exportAgentJson(profiles);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `智能体配置-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const r = normalizeAgentText(text);
      if (!r.ok) {
        messageApi.error(r.error);
        return;
      }
      const out = mergeImportedProfiles(profiles, r.items);
      await persist(out.list, activeId);
      messageApi.success(
        `导入完成：新增 ${out.added} 个、更新 ${out.updated} 个${out.missingKeys ? `，其中 ${out.missingKeys} 个缺少 API Key 需补全` : ''}${r.skipped ? `，跳过 ${r.skipped} 条无效条目` : ''}`,
      );
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    }
  };

  const openAdd = () => {
    setEditing(null);
    // 重置多智能体配置向导
    setMultiRaw('');
    setMultiFormat('yaml');
    setMultiInspect(null);
    setMultiDeps(null);
    setMultiValues({});
    setMultiError('');
    setTestResults({});
    form.resetFields();
    form.setFieldsValue({ name: '', avatar: '', intro: '', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: '', systemPrompt: '', domainTags: '', role: '', style: '', greeting: '', exampleQuestions: '' });
    setFormOpen(true);
  };

  const openEdit = (p: LlmProfile) => {
    setEditing(p);
    // 回填多智能体配置（如存在）：展示原始占位符文本，并恢复已填凭证
    setMultiError('');
    setTestResults({});
    if (p.multiConfig) {
      const deps = p.multiConfig.deps ?? [];
      const displayRaw = safeRaw(p.multiConfig.raw, deps);
      setMultiRaw(displayRaw);
      setMultiFormat(p.multiConfig.format ?? 'yaml');
      setMultiDeps(deps);
      const vals: Record<string, string> = {};
      for (const d of deps) vals[d.ref] = p.multiConfig?.credentials?.[d.ref] ?? '';
      setMultiValues(vals);
      const parsed = parseConfigText(displayRaw);
      setMultiInspect(parsed.ok ? inspectMultiAgent(parsed.value) : null);
    } else {
      setMultiRaw('');
      setMultiFormat('yaml');
      setMultiInspect(null);
      setMultiDeps(null);
      setMultiValues({});
    }
    form.setFieldsValue({
      name: p.name,
      avatar: p.avatar ?? '',
      intro: p.intro ?? '',
      apiKey: '', // 编辑时留空=不修改密钥
      baseUrl: p.baseUrl,
      model: p.model,
      systemPrompt: p.systemPrompt ?? '',
      domainTags: (p.domainTags ?? []).join('，'),
      role: p.role ?? '',
      style: p.style ?? '',
      greeting: p.greeting ?? '',
      exampleQuestions: (p.exampleQuestions ?? []).join('\n'),
    });
    setFormOpen(true);
  };

  /** 解析用户粘贴的多智能体配置：识别结构 → 提取依赖 */
  const handleParseMulti = () => {
    const text = multiRaw.trim();
    if (!text) {
      messageApi.warning('请先粘贴多智能体配置（YAML 或 JSON）');
      return;
    }
    const parsed = parseConfigText(text);
    if (!parsed.ok) {
      setMultiError(parsed.error);
      setMultiInspect(null);
      setMultiDeps(null);
      return;
    }
    const built = buildMultiConfig(text, parsed.format);
    if (!built.ok) {
      setMultiError(built.error);
      setMultiInspect(null);
      setMultiDeps(null);
      return;
    }
    setMultiError('');
    setMultiFormat(built.cfg.format);
    setMultiInspect(built.inspect);
    setMultiDeps(built.cfg.deps);
    // 保留之前填过的凭证值（按 ref 对齐）
    setMultiValues((prev) => {
      const next: Record<string, string> = {};
      for (const d of built.cfg.deps) next[d.ref] = prev[d.ref] ?? '';
      return next;
    });
    setTestResults({});
    messageApi.success(built.inspect.detected ? '已识别多智能体编排配置' : '已解析配置（未检测到多智能体结构，将作为普通配置保存）');
  };

  /** 测试单条依赖连通性：后端代发探测请求 */
  const handleTestDependency = async (dep: MultiAgentDependency) => {
    const raw = (multiValues[dep.ref] ?? '').trim() || dep.example;
    // 拼出探测目标：优先用户填写的整串里的 URL，否则用示例地址
    const urlMatch = raw.match(/https?:\/\/[^\s，,]+/);
    const url = urlMatch ? urlMatch[0] : raw;
    if (!/^https?:\/\//.test(url)) {
      messageApi.warning('该依赖没有可探测的 URL，请填写有效地址');
      return;
    }
    setTestingRef(dep.ref);
    try {
      const res = await verifyDependency({
        url,
        protocol: dep.protocol,
        auth: dep.auth,
        apiKey: dep.auth === 'none' ? undefined : (multiValues[dep.ref]?.trim() || undefined),
      });
      setTestResults((prev) => ({ ...prev, [dep.ref]: res }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [dep.ref]: { ok: false, status: null, latencyMs: null, error: getErrorMessage(e) } }));
    } finally {
      setTestingRef('');
    }
  };

  /** 更新依赖的用途说明 */
  const setDepUsage = (idx: number, usage: string) => {
    setMultiDeps((prev) => (prev ? prev.map((d, i) => (i === idx ? { ...d, usage } : d)) : prev));
  };

  /** 清除多智能体配置向导（含已填凭证与测试结果） */
  const setMultiValueResetAll = () => {
    setMultiRaw('');
    setMultiFormat('yaml');
    setMultiValues({});
    setMultiError('');
    setTestResults({});
  };

  const save = async () => {
    const values = await form.validateFields();
    const name = values.name.trim() || '未命名智能体';
    const baseUrl = values.baseUrl.trim();
    const model = values.model.trim();
    if (!baseUrl || !model) {
      messageApi.warning('接口地址与模型为必填项');
      return;
    }
    // 多智能体配置组装：有粘贴内容但未解析 → 阻止保存；解析过 → 用占位符转 cred:// 引用 + 凭证
    let multiConfig: AgentMultiConfig | undefined;
    const rawText = multiRaw.trim();
    if (rawText) {
      if (!multiDeps) {
        messageApi.warning('请先点击「解析配置」识别多智能体结构与外部依赖');
        return;
      }
      const replaced = replacePlaceholdersToRefs(rawText, multiDeps);
      const credentials: Record<string, string> = {};
      for (const d of multiDeps) {
        const v = (multiValues[d.ref] ?? '').trim();
        if (v) credentials[d.ref] = v;
      }
      multiConfig = {
        raw: replaced,
        format: multiFormat,
        deps: multiDeps.map((d) => ({ ...d })),
        credentials,
      };
    }
    setSaving(true);
    try {
      if (editing) {
        const next = profiles.map((p) =>
          p.id === editing.id
            ? {
                ...p,
                name,
                avatar: values.avatar?.trim() || p.avatar,
                intro: values.intro?.trim() || p.intro,
                // 编辑时 apiKey 留空 = 保持不变
                apiKey: values.apiKey?.trim() ? values.apiKey.trim() : p.apiKey,
                baseUrl,
                model,
                systemPrompt: values.systemPrompt?.trim() ?? p.systemPrompt,
                domainTags: toList(values.domainTags),
                role: values.role?.trim() || p.role,
                style: values.style?.trim() || p.style,
                greeting: values.greeting?.trim() || p.greeting,
                exampleQuestions: toList(values.exampleQuestions),
                multiConfig,
              }
            : p,
        );
        await persist(next, activeId);
        messageApi.success('已保存');
      } else {
        const profile: LlmProfile = {
          id: newId(),
          name,
          apiKey: values.apiKey?.trim() ?? '',
          baseUrl,
          model,
          systemPrompt: values.systemPrompt?.trim(),
          avatar: values.avatar?.trim(),
          intro: values.intro?.trim(),
          domainTags: toList(values.domainTags),
          role: values.role?.trim(),
          style: values.style?.trim(),
          greeting: values.greeting?.trim(),
          exampleQuestions: toList(values.exampleQuestions),
          enabled: true,
          multiConfig,
        };
        if (!profile.apiKey) {
          messageApi.warning('新增智能体需要填写 API Key');
          return;
        }
        await persist([...profiles, profile], profile.id);
        messageApi.success(`已创建「${name}」并设为当前`);
      }
      setFormOpen(false);
    } catch (e) {
      messageApi.error(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: LlmProfile) => {
    try {
      const next = profiles.filter((x) => x.id !== p.id);
      const isActive = p.id === activeId;
      const nextActiveId = isActive ? next.find((x) => x.enabled !== false)?.id ?? '' : activeId;
      await persist(next, nextActiveId);
      messageApi.success('已删除');
    } catch (e) {
      messageApi.error(getErrorMessage(e));
    }
  };

  const duplicate = async (p: LlmProfile) => {
    const copy: LlmProfile = { ...p, id: newId(), name: `${p.name} 副本`, enabled: true };
    try {
      await persist([...profiles, copy], copy.id);
      messageApi.success(`已创建「${copy.name}」`);
    } catch (e) {
      messageApi.error(getErrorMessage(e));
    }
  };

  const toggle = async (p: LlmProfile, nextEnabled: boolean) => {
    if (nextEnabled === false && p.id === activeId) {
      messageApi.warning('当前正在对话的智能体不能停用，请先切换到其他智能体');
      return;
    }
    try {
      const next = profiles.map((x) => (x.id === p.id ? { ...x, enabled: nextEnabled } : x));
      await persist(next, activeId);
    } catch (e) {
      messageApi.error(getErrorMessage(e));
    }
  };

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return profiles;
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(kw) ||
        p.model.toLowerCase().includes(kw) ||
        (p.domainTags ?? []).some((t) => t.toLowerCase().includes(kw)) ||
        (p.style ?? '').toLowerCase().includes(kw),
    );
  }, [profiles, search]);

  return (
    <div className="content-wrap">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENTS</span>
          <Typography.Title>智能体管理</Typography.Title>
          <Paragraph>你的个人智能体（云端加密同步，手机端与桌面端共用）。每个智能体绑定专属宠物形象、拥有独立对话。支持 JSON 导出（不含密钥）与导入合并。</Paragraph>
        </div>
      </div>
      {contextHolder}
      <input ref={fileInputRef} type="file" accept=".json,.txt,application/json" style={{ display: 'none' }} onChange={(e) => void handleImportFile(e)} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 16, maxWidth: 900, flexWrap: 'wrap' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索智能体（名称 / 模型 / 标签）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 360 }}
        />
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>导出</Button>
          <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>导入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>新增智能体</Button>
        </Space>
      </div>

      {!loading && profiles.length === 0 && !search && (
        <Alert type="info" showIcon style={{ maxWidth: 900 }} message="还没有智能体" description="点击右上角「新增智能体」，或直接在手机端/桌面端的智能体管理中创建，创建后会自动同步到这里。" />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
        {filtered.map((p) => {
          const active = p.id === activeId;
          const enabled = p.enabled !== false;
          const avatar = p.avatar?.trim() || p.name.slice(0, 1).toUpperCase();
          return (
            <Card key={p.id} size="small" style={{ opacity: enabled ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <Avatar size={40} style={{ backgroundColor: '#e8edfb', color: '#4d6bfe', fontWeight: 600, flexShrink: 0 }}>{avatar}</Avatar>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Space align="center" wrap>
                    <Typography.Text strong style={{ fontSize: 15 }}>{p.name}</Typography.Text>
                    {active && <Tag color="blue">当前</Tag>}
                    {!enabled && <Tag>已停用</Tag>}
                    {p.multiConfig && <Tag color="purple" icon={<ApiOutlined />}>多智能体</Tag>}
                  </Space>
                  <div style={{ marginTop: 2 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{p.model || '未设置模型'}{p.intro ? ` · ${p.intro}` : ''}</Text>
                  </div>
                  {(p.domainTags?.length || p.role || p.style) && (
                    <Space size={[4, 2]} wrap style={{ marginTop: 4 }}>
                      {(p.domainTags ?? []).map((t) => <Tag key={t} color="geekblue" style={{ marginInlineEnd: 0 }}>{t}</Tag>)}
                      {p.role && <Tag>{p.role}</Tag>}
                      {p.style && <Tag>{p.style}</Tag>}
                    </Space>
                  )}
                  <div style={{ marginTop: 2 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {p.petAssetId ? `已绑定宠物形象 ID：${p.petAssetId}` : '未绑定宠物形象（可在手机端智能体管理中绑定）'}
                    </Text>
                  </div>
                </div>
                <Space>
                  <Switch checked={enabled} onChange={(v) => void toggle(p, v)} />
                  <Button size="small" icon={<CopyOutlined />} onClick={() => void duplicate(p)}>复制</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>编辑</Button>
                  <Popconfirm title="删除智能体" description="该智能体的对话记录也会被删除" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(p)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </Space>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal
        title={editing ? `编辑「${editing.name}」` : '新增智能体'}
        open={formOpen}
        onOk={() => void save()}
        onCancel={() => setFormOpen(false)}
        confirmLoading={saving}
        okText="保存"
        width={760}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={40} placeholder="例如：健康顾问" />
          </Form.Item>
          <Form.Item name="avatar" label="头像（emoji 或文字，留空取名称首字）">
            <Input maxLength={8} placeholder="🐱 或 医" />
          </Form.Item>
          <Form.Item name="intro" label="简介">
            <Input.TextArea rows={2} maxLength={200} placeholder="一句话介绍这个智能体" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" rules={editing ? [] : [{ required: true, message: '新增智能体需要填写 API Key' }]}>
            <Input.Password placeholder={editing ? '留空保持不变' : 'sk-…'} autoComplete="off" />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item name="model" label="模型" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="gpt-4o-mini / glm-4-flash" />
            </Form.Item>
          </div>
          <Form.Item name="domainTags" label="领域标签">
            <Input placeholder={`逗号分隔：${DOMAIN_TAG_PRESETS.join(' / ')} 或自定义`} />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="role" label="角色">
              <Input placeholder={`如：${ROLE_PRESETS.join(' / ')}`} />
            </Form.Item>
            <Form.Item name="style" label="风格">
              <Input placeholder={`如：${STYLE_PRESETS.join(' / ')}`} />
            </Form.Item>
          </div>
          <Form.Item name="greeting" label="欢迎语（新对话开场白）">
            <Input placeholder="例如：你好呀，今天想聊点什么？" />
          </Form.Item>
          <Form.Item name="exampleQuestions" label="示例问题（每行一个）">
            <Input.TextArea rows={3} placeholder="每行一个问题" />
          </Form.Item>
          <Form.Item name="systemPrompt" label="系统提示词（人设）">
            <Input.TextArea rows={4} placeholder="例如：你是一只傲娇的猫娘，说话简短带喵～" />
          </Form.Item>
        <Divider orientation="left" style={{ margin: '4px 0 12px' }}>多智能体编排配置（可选）</Divider>
          <Alert type="info" showIcon style={{ marginBottom: 8 }} message="支持 YAML / JSON。粘贴后点「解析配置」：自动识别是否多智能体（kind: multi_agent / agents / orchestrator / workflow），提取 ${VAR}、{{VAR}}、env:VAR、secret:VAR 外部依赖；为每条依赖填写真实信息并测试连通性后保存，凭证以内部引用存储、导出时自动剥离。" />
          <Input.TextArea
            value={multiRaw}
            onChange={(e) => setMultiRaw(e.target.value)}
            rows={6}
            placeholder={'kind: multi_agent\nname: 宠物管家团\norchestrator:\n  type: supervisor\n  model: ${MODEL_API}\nagents:\n  - id: health\n    endpoint: ${HEALTH_AGENT_API}\n    api_key: ${HEALTH_AGENT_KEY}'}
            style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 8 }}
          />
          <Space wrap style={{ marginBottom: 12 }}>
            <Button size="small" icon={<ExperimentOutlined />} onClick={handleParseMulti} disabled={!multiRaw.trim()}>解析配置</Button>
            {multiRaw.trim() && multiDeps && (
              <Button size="small" danger onClick={() => { setMultiDeps(null); setMultiInspect(null); setMultiValueResetAll(); }}>清除</Button>
            )}
          </Space>
          {multiError && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={multiError} />}

          {multiInspect && (
            <Card size="small" style={{ marginBottom: 12, background: '#f8f9ff' }}>
              <Divider style={{ margin: '0 0 8px' }} orientation="left">识别结果</Divider>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                {multiInspect.detected ? <Tag color="green">多智能体</Tag> : <Tag>普通配置</Tag>}
                {multiInspect.kind && <Tag>kind: {multiInspect.kind}</Tag>}
                {multiInspect.orchestratorType && <Tag color="purple">编排器: {multiInspect.orchestratorType}</Tag>}
                {multiInspect.members.length > 0 && <Tag>成员: {multiInspect.members.map((m) => m.id).join(' / ')}</Tag>}
                {multiInspect.workflowSteps.length > 0 && <Tag>流程: {multiInspect.workflowSteps.join(' → ')}</Tag>}
              </div>
              {multiInspect.members.length > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>将按编排配置调用多个智能体；子智能体无需单独维护，凭证由下方依赖统一管理。</Text>
              )}
            </Card>
          )}

          {multiDeps && multiDeps.length > 0 && (
            <Divider style={{ margin: '0 0 8px' }} orientation="left">外部依赖补全（{multiDeps.length} 项）</Divider>
          )}
          {multiDeps?.map((dep, idx) => {
            const result = testResults[dep.ref];
            return (
              <div key={dep.ref} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <Text code>{dep.ref}</Text>
                  <Text strong style={{ fontSize: 13 }}>{dep.key}</Text>
                  <Tag color={dep.type === 'model' ? 'geekblue' : dep.type === 'agent_api' ? 'purple' : 'default'}>
                    {dep.type === 'model' ? '大模型' : dep.type === 'agent_api' ? '子智能体' : dep.type === 'tool_api' ? '工具 API' : dep.type === 'memory' ? '记忆库' : '其他'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{dep.protocol} / {dep.auth === 'api_key' ? 'API Key' : dep.auth === 'bearer' ? 'Bearer' : dep.auth === 'oauth' ? 'OAuth' : '免鉴权'}</Text>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <Text type="secondary" style={{ fontSize: 12, width: 56, flexShrink: 0 }}>用途</Text>
                  <Input
                    size="small"
                    style={{ flex: 1, minWidth: 200 }}
                    value={dep.usage}
                    onChange={(e) => setDepUsage(idx, e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text type="secondary" style={{ fontSize: 12, width: 56, flexShrink: 0 }}>凭证值</Text>
                  <Input
                    size="middle"
                    style={{ flex: 1, minWidth: 200 }}
                    placeholder={dep.example}
                    value={multiValues[dep.ref] ?? ''}
                    onChange={(e) => setMultiValues((prev) => ({ ...prev, [dep.ref]: e.target.value }))}
                  />
                  <Button
                    size="small"
                    icon={<ExperimentOutlined />}
                    onClick={() => void handleTestDependency(dep)}
                    loading={testingRef === dep.ref}
                  >
                    测试连通
                  </Button>
                  {result && (
                    <Text type={result.ok ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                      {result.ok ? `✓ HTTP ${result.status}（${result.latencyMs}ms）` : `✗ ${result.error ?? `HTTP ${result.status}`}`}
                    </Text>
                  )}
                </div>
                {dep.type === 'model' && (
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                    验证该模型服务的地址 / 模型名 / 密钥是否可用（示例仅作占位）
                  </Text>
                )}
              </div>
            );
          })}
        </Form>
      </Modal>
    </div>
  );
}