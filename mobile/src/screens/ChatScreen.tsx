/** 聊天页：直连用户 LLM 档案（云同步），流式输出（思考过程逐字可见）；含档案管理与清空确认 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supportsChat, streamChat, StreamInterruptError } from '../chat/llm';
import { scheduleUpload } from '../api/sync';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { isSpeechAvailable, speak, startListening, stopListening, stopSpeak, subscribeVoice } from '../native/Voice';
import type { ChatMsg, LlmProfile } from '../types';
import { buildMultiConfig, exportAgentJson, inspectMultiAgent, normalizeAgentText, mergeImportedProfiles, parseConfigText, replacePlaceholdersToRefs, safeRaw } from '../agentPort';
import type { ImportOutcome, MultiAgentInspect } from '../agentPort';
import { verifyDependency } from '../api/platform';
import type { AgentMultiConfig, MultiAgentDependency } from '../types';
import { WebView } from 'react-native-webview';
import MarkdownText from '../components/MarkdownText';

/** 思考过程卡片：流式时自动展开、头部显示「深度思考中…」；结束后折叠为「已深度思考（用时 X 秒）」 */
function ThinkCard({
  reasoning,
  seconds,
  streaming,
}: {
  reasoning: string;
  seconds?: number;
  streaming?: boolean;
}): React.JSX.Element {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? !!streaming;
  const title = streaming
    ? '深度思考中…'
    : `已深度思考${typeof seconds === 'number' && seconds > 0 ? `（用时 ${seconds} 秒）` : ''}`;
  return (
    <View style={styles.thinkCard}>
      <Pressable
        style={styles.thinkHeader}
        onPress={() => setManual(!expanded)}
        hitSlop={4}>
        <Text style={styles.thinkTitle}>{title}</Text>
        <Text style={styles.thinkChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded && <Text style={styles.thinkBody}>{reasoning}</Text>}
    </View>
  );
}

/** 单个圆点的波浪循环（固定周期+相位差，三点依次起伏不漂移） */
function useDotWave(phase: number): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const period = 900;
    const up = 280;
    const down = 280;
    let stopped = false;
    const run = (): void => {
      if (stopped) return;
      Animated.sequence([
        Animated.delay(phase),
        Animated.timing(v, { toValue: 1, duration: up, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: down, useNativeDriver: true }),
        Animated.delay(period - phase - up - down),
      ]).start(({ finished }) => {
        if (finished) run();
      });
    };
    run();
    return () => {
      stopped = true;
      v.stopAnimation();
    };
  }, [v, phase]);
  return v;
}

/** Trae 式等待指示：无气泡，「正在思考」标题 + 三个由浅到深的圆点波浪 */
function WaitingThink(): React.JSX.Element {
  const p0 = useDotWave(0);
  const p1 = useDotWave(150);
  const p2 = useDotWave(300);
  const dotStyle = (v: Animated.Value, color: string) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
    backgroundColor: color,
  });
  return (
    <View style={styles.waitWrap} pointerEvents="none">
      <Text style={styles.waitTitle}>正在思考</Text>
      <View style={styles.waitDots}>
        <Animated.View style={[styles.waitDot, dotStyle(p0, '#C9C9C9')]} />
        <Animated.View style={[styles.waitDot, dotStyle(p1, '#9B9B9B')]} />
        <Animated.View style={[styles.waitDot, dotStyle(p2, '#6B6B6B')]} />
      </View>
    </View>
  );
}

/** 是否包含需要特殊渲染的 Markdown 语法（代码块/行内代码/链接/加粗/标题/引用/列表） */
function looksMarkdown(text: string): boolean {
  return /```|`[^`\n]+`|\[[^\]]+\]\(\w+:|(\*\*|__)[\s\S]+?\1|^#{1,3}\s+|^>\s?/.test(text);
}

/** 隐藏复制引擎页：textarea + execCommand('copy')，供 RN 侧注入执行剪贴板写入 */
const COPY_HTML =
  '<html><head><style>html,body{margin:0;padding:0}textarea{position:fixed;left:-1000px;top:0;width:10px;height:10px}</style></head>' +
  '<body><textarea id="t"></textarea><script>window.__copy=function(s){var e=document.getElementById("t");e.value=s;e.focus();e.select();' +
  'try{return document.execCommand("copy");}catch(err){try{navigator.clipboard.writeText(s);return true;}catch(e2){return false;}}};</script></body></html>';

function Bubble({ msg, onRetry, onCopy }: { msg: ChatMsg; onRetry: () => void; onCopy: (t: string) => void }): React.JSX.Element {
  const showThinking = useAppStore((s) => s.showThinking);
  const mine = msg.role === 'user';
  if (mine) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
        <View style={[styles.bubble, styles.bubbleMine]}>
          <Text selectable style={styles.bubbleTextMine}>{msg.content}</Text>
        </View>
      </View>
    );
  }
  // 思考开关关闭时完全忽略 reasoning：既不显示思考卡，
  // 也不让「隐形思考期」（模型仍返回 reasoning）误判为有内容而渲染空气泡
  const reasoning = showThinking ? msg.reasoning : undefined;
  const hasReasoning = !!reasoning && reasoning.trim().length > 0;
  const hasContent = !!msg.content && msg.content.trim().length > 0;
  // 思考过渡不占气泡：Trae 式「正在思考」+ 圆点
  const waiting = msg.pending && !hasReasoning && !hasContent && !msg.error;
  if (!msg.pending && !hasReasoning && !hasContent) return <></>;
  return (
    <View style={styles.bubbleRow}>
      {waiting ? (
        <WaitingThink />
      ) : (
        <Pressable
          style={[styles.bubble, styles.bubbleTheirs]}
          onPress={msg.error ? onRetry : undefined}>
          {hasReasoning && reasoning && (
            <ThinkCard reasoning={reasoning} seconds={msg.thinkSeconds} streaming={msg.streaming} />
          )}
          {hasContent && msg.content && (looksMarkdown(msg.content) ? (
            <MarkdownText
              content={msg.content + (msg.streaming && !msg.error ? ' ▍' : '')}
              baseStyle={[
                msg.error ? styles.bubbleError : styles.bubbleText,
                hasReasoning && !msg.error && styles.contentAfterThink,
              ]}
              onCopy={onCopy}
            />
          ) : (
            <Text
              selectable
              style={[
                msg.error ? styles.bubbleError : styles.bubbleText,
                hasReasoning && !msg.error && styles.contentAfterThink,
              ]}>
              {msg.content}
              {msg.streaming && !msg.error ? ' ▍' : ''}
            </Text>
          ))}
          {msg.error && <Text style={styles.retryHint}>点此重试</Text>}
        </Pressable>
      )}
    </View>
  );
}

/** 空表单模板（表单内 tags/questions 用换行分隔字符串承载，保存时转数组） */
function emptyForm(): {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  avatar: string;
  intro: string;
  domainTags: string;
  role: string;
  style: string;
  greeting: string;
  exampleQuestions: string;
} {
  return {
    name: '',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    systemPrompt: '',
    avatar: '',
    intro: '',
    domainTags: '',
    role: '',
    style: '',
    greeting: '',
    exampleQuestions: '',
  };
}

/** 领域标签 / 角色 / 风格 预设选项（可自填，表单用文本输入承载） */
const DOMAIN_TAG_PRESETS = ['医疗', '训练', '内容', '陪伴', '电商'];
const ROLE_PRESETS = ['医生', '训练师', '经纪人', '管家', '老师', '朋友'];
const STYLE_PRESETS = ['温柔', '毒舌', '专业', '搞笑', '简短'];

/** 把换行分隔文本转数组（去空去重） */
function linesToArray(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text || '').split(/[\n,，]/)) {
    const t = line.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 智能体管理（= API 档案）：搜索 / 新增 / 编辑 / 复制 / 启停 / 删除 / 切换，P0 扩展字段 */
function ProfileManager({ visible, onClose }: { visible: boolean; onClose: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { kbHeight, kbVisible } = useKeyboardHeight();
  const profiles = useAppStore((s) => s.llmProfiles);
  const activeId = useAppStore((s) => s.llmActiveProfileId);
  const downloadedPets = useAppStore((s) => s.downloadedPets);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [bindPetId, setBindPetId] = useState<string>('');
  const [search, setSearch] = useState('');
  // ── P1-2 多智能体编排配置向导状态 ──
  const [multiRaw, setMultiRaw] = useState('');
  const [multiFormat, setMultiFormat] = useState<'yaml' | 'json'>('yaml');
  const [multiInspect, setMultiInspect] = useState<MultiAgentInspect | null>(null);
  const [multiDeps, setMultiDeps] = useState<MultiAgentDependency[] | null>(null);
  const [multiValues, setMultiValues] = useState<Record<string, string>>({});
  const [multiError, setMultiError] = useState('');
  const [testingRef, setTestingRef] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; status: number | null; latencyMs: number | null; error?: string }>>({});

  const openAdd = (): void => {
    setEditingId('');
    setForm(emptyForm());
    setBindPetId('');
    // 重置多智能体配置向导
    setMultiRaw('');
    setMultiFormat('yaml');
    setMultiInspect(null);
    setMultiDeps(null);
    setMultiValues({});
    setMultiError('');
    setTestResults({});
    setFormOpen(true);
  };

  const openEdit = (p: LlmProfile): void => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: p.model,
      systemPrompt: p.systemPrompt ?? '',
      avatar: p.avatar ?? '',
      intro: p.intro ?? '',
      domainTags: (p.domainTags ?? []).join('，'),
      role: p.role ?? '',
      style: p.style ?? '',
      greeting: p.greeting ?? '',
      exampleQuestions: (p.exampleQuestions ?? []).join('\n'),
    });
    setBindPetId(p.petAssetId ?? '');
    // 回填多智能体配置（如存在）：展示原始占位符文本，并恢复已填凭证
    setMultiError('');
    setTestResults({});
    if (p.multiConfig) {
      const deps = p.multiConfig.deps ?? [];
      setMultiRaw(safeRaw(p.multiConfig.raw, deps));
      setMultiFormat(p.multiConfig.format ?? 'yaml');
      setMultiDeps(deps);
      const vals: Record<string, string> = {};
      for (const d of deps) vals[d.ref] = p.multiConfig?.credentials?.[d.ref] ?? '';
      setMultiValues(vals);
      const displayRaw = safeRaw(p.multiConfig.raw, deps);
      const parsed = parseConfigText(displayRaw);
      setMultiInspect(parsed.ok ? inspectMultiAgent(parsed.value) : null);
    } else {
      setMultiRaw('');
      setMultiFormat('yaml');
      setMultiInspect(null);
      setMultiDeps(null);
      setMultiValues({});
    }
    setFormOpen(true);
  };

  const save = (): void => {
    const name = form.name.trim() || '未命名智能体';
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (!baseUrl || !model) {
      Alert.alert('信息不全', '接口地址与模型为必填项');
      return;
    }
    const store = useAppStore.getState();
    const petAssetId = bindPetId || undefined;
    // 多智能体配置组装：有粘贴内容但未解析 → 阻止保存；解析过 → 占位符转 cred:// 引用 + 凭证
    let multiConfig: AgentMultiConfig | undefined;
    const rawText = multiRaw.trim();
    if (rawText) {
      if (!multiDeps) {
        Alert.alert('提示', '请先点击「解析配置」识别多智能体结构与外部依赖');
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
    const newFields = {
      avatar: form.avatar.trim() || undefined,
      intro: form.intro.trim() || undefined,
      domainTags: linesToArray(form.domainTags),
      role: form.role.trim() || undefined,
      style: form.style.trim() || undefined,
      greeting: form.greeting.trim() || undefined,
      exampleQuestions: linesToArray(form.exampleQuestions),
    };
    if (editingId) {
      const next = store.llmProfiles.map((p) =>
        p.id === editingId
          ? {
              ...p,
              name,
              apiKey: form.apiKey.trim(),
              baseUrl,
              model,
              systemPrompt: form.systemPrompt.trim(),
              petAssetId,
              multiConfig,
              ...newFields,
            }
          : p,
      );
      store.patch({ llmProfiles: next });
      // 严格绑定：保存的是当前激活智能体时，绑定形象变了同步更新 petAsset；解绑（无形象）则该智能体无法继续使用
      if (editingId === store.llmActiveProfileId) {
        const newPet = petAssetId ? store.downloadedPets.find((p) => p.id === petAssetId) : null;
        if (newPet) {
          if (newPet.id !== store.petAsset?.id) store.patch({ petAsset: newPet });
        } else {
          // 严格绑定：激活智能体解绑形象 → 清空当前宠物，聊天发送将被拦截
          store.patch({ petAsset: null });
          Alert.alert('当前智能体已解绑形象', '已清空当前宠物，该智能体将不能继续对话，请重新绑定宠物形象，或切换到其他已绑定形象的智能体');
        }
      }
    } else {
      const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const profile: LlmProfile = {
        id,
        name,
        apiKey: form.apiKey.trim(),
        baseUrl,
        model,
        systemPrompt: form.systemPrompt.trim(),
        petAssetId,
        enabled: true,
        multiConfig,
        ...newFields,
      };
      if (petAssetId) {
        // 严格绑定：新建智能体已绑定形象 → 直接激活并同步切换宠物
        const newPet = store.downloadedPets.find((p) => p.id === petAssetId);
        if (newPet) {
          store.patch({ llmProfiles: [...store.llmProfiles, profile], llmActiveProfileId: id, petAsset: newPet });
        } else {
          // 绑定 id 不在已下载列表（选择器来自下载列表，理论不可达）：保守只保存不激活
          store.patch({ llmProfiles: [...store.llmProfiles, profile] });
          Alert.alert('绑定形象未下载', '所选宠物形象未在本地，智能体已保存但未激活，请先下载该形象');
        }
      } else {
        // 严格绑定：无形象只允许保存、不激活，稍后绑定后才可使用
        store.patch({ llmProfiles: [...store.llmProfiles, profile] });
        Alert.alert('已保存', '尚未绑定宠物形象，该智能体暂不能使用：请在编辑中绑定一个已下载的宠物形象后再切换使用');
      }
    }
    scheduleUpload('config');
    setFormOpen(false);
  };

  const remove = (p: LlmProfile): void => {
    Alert.alert('删除智能体', `确定删除「${p.name}」吗？该智能体的对话记录也会被删除。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const store = useAppStore.getState();
          const next = store.llmProfiles.filter((x) => x.id !== p.id);
          // 同时删除该智能体的对话记录
          const profileMessages = { ...store.profileMessages };
          delete profileMessages[p.id];
          // 删除当前智能体时自动切到剩余第一个（优先选「已绑定且形象已下载」的，保证可用）
          const isActive = store.llmActiveProfileId === p.id;
          const nextActiveId = isActive
            ? next.find((x) => x.enabled !== false && x.petAssetId && store.downloadedPets.some((d) => d.id === x.petAssetId))?.id ?? next[0]?.id ?? ''
            : store.llmActiveProfileId;
          const nextMessages = isActive ? (profileMessages[nextActiveId] ?? []) : store.messages;
          // 严格绑定：下一智能体已绑定且形象已下载时切换宠物，否则不切（避免展示不存在的形象）
          const nextProfile = isActive ? next.find((x) => x.id === nextActiveId) ?? null : null;
          const nextPet = isActive
            ? (nextProfile && nextProfile.petAssetId
                ? store.downloadedPets.find((x) => x.id === nextProfile.petAssetId) ?? null
                : null)
            : store.petAsset;
          store.patch({
            llmProfiles: next,
            llmActiveProfileId: nextActiveId,
            profileMessages,
            messages: nextMessages,
            ...(nextPet ? { petAsset: nextPet } : {}),
          });
          scheduleUpload('config');
        },
      },
    ]);
  };

  const switchTo = (id: string): void => {
    const store = useAppStore.getState();
    const target = store.llmProfiles.find((p) => p.id === id);
    // 严格绑定：未配置形象 / 绑定形象未下载的智能体无法使用，拦截切换
    const boundPet = target?.petAssetId ? store.downloadedPets.find((p) => p.id === target.petAssetId) : null;
    if (!target?.petAssetId || !boundPet) {
      Alert.alert('该智能体无法使用', '未绑定宠物形象（或所绑形象未下载），请先在「智能体管理 → 编辑」中绑定一个已下载的宠物形象', [{ text: '好的' }]);
      return;
    }
    store.switchProfile(id);
    scheduleUpload('config');
  };

  const field = (label: string, key: keyof ReturnType<typeof emptyForm>, secure = false): React.JSX.Element => (
    <>
      <Text style={pm.fieldLabel}>{label}</Text>
      <TextInput
        style={pm.field}
        value={form[key]}
        onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        placeholder={key === 'baseUrl' ? 'https://api.openai.com/v1' : key === 'model' ? 'gpt-4o-mini / glm-4-flash …' : key === 'domainTags' ? '用逗号或换行分隔多个标签' : key === 'exampleQuestions' ? '每行一个问题' : undefined}
        multiline={key === 'systemPrompt' || key === 'exampleQuestions'}
      />
    </>
  );

  // 预设 chip 输入：点击预设项将其追加进对应文本
  const chipSetter = (key: 'domainTags' | 'role' | 'style', presets: string[]): React.JSX.Element => (
    <View style={pm.chipWrap}>
      {presets.map((t) => {
        const cur = form[key];
        const on = cur.split(/[\n,，]/).map((x) => x.trim()).includes(t);
        return (
          <Pressable
            key={t}
            style={[pm.chip, on && pm.chipOn]}
            onPress={() => {
              const parts = cur.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
              const next = on ? parts.filter((x) => x !== t) : [...parts, t];
              setForm((f) => ({ ...f, [key]: next.join('，') }));
            }}>
            <Text style={[pm.chipText, on && pm.chipTextOn]}>{t}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  // 按搜索词过滤列表（名称/模型/领域标签/风格）
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

  const toggleEnabled = (p: LlmProfile): void => {
    // 激活的智能体不可直接停用（UI 拦截：需先切换）
    if (p.enabled !== false && p.id === activeId) {
      Alert.alert('无法停用', '当前正在对话的智能体不能停用，请先切换到其他智能体');
      return;
    }
    const store = useAppStore.getState();
    store.toggleProfileEnabled(p.id, p.enabled === false);
    scheduleUpload('config');
  };

  const duplicate = (p: LlmProfile): void => {
    useAppStore.getState().duplicateProfile(p.id);
    scheduleUpload('config');
    Alert.alert('已复制', `已创建「${p.name} 副本」`);
  };

  // ── P1-2 多智能体编排：解析识别 → 依赖补全 → 连通性测试 ──

  /** 解析用户粘贴的多智能体配置：识别结构 → 提取依赖 */
  const handleParseMulti = (): void => {
    const text = multiRaw.trim();
    if (!text) {
      Alert.alert('提示', '请先粘贴多智能体配置（YAML 或 JSON）');
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
    Alert.alert(
      built.inspect.detected ? '已识别多智能体' : '已解析配置',
      built.inspect.detected
        ? '已识别多智能体编排结构，请在下方「外部依赖补全」逐项填写真实信息'
        : '未检测到多智能体结构，将作为普通配置保存',
    );
  };

  /** 清除多智能体配置向导（含已填凭证与测试结果） */
  const clearMulti = (): void => {
    setMultiRaw('');
    setMultiFormat('yaml');
    setMultiInspect(null);
    setMultiDeps(null);
    setMultiValues({});
    setMultiError('');
    setTestResults({});
  };

  /** 更新依赖的用途说明 */
  const setDepUsage = (idx: number, usage: string): void => {
    setMultiDeps((prev) => (prev ? prev.map((d, i) => (i === idx ? { ...d, usage } : d)) : prev));
  };

  /** 测试单条依赖连通性：后端代发探测请求 */
  const handleTestDependency = async (dep: MultiAgentDependency): Promise<void> => {
    const raw = (multiValues[dep.ref] ?? '').trim() || dep.example;
    // 拼出探测目标：优先用户填写的整串里的 URL，否则用示例地址
    const urlMatch = raw.match(/https?:\/\/[^\s，,]+/);
    const url = urlMatch ? urlMatch[0] : raw;
    if (!/^https?:\/\//.test(url)) {
      Alert.alert('无法测试', '该依赖没有可探测的 URL，请填写有效地址');
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
      setTestResults((prev) => ({
        ...prev,
        [dep.ref]: { ok: false, status: null, latencyMs: null, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTestingRef('');
    }
  };

  // ── P1 导入导出：导出剥离凭证，导入按名称合并 ──
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);
  // ── 编辑表单内导入（解析单条配置回填表单）──
  const [formImportOpen, setFormImportOpen] = useState(false);
  const [formImportText, setFormImportText] = useState('');
  const [formImportError, setFormImportError] = useState('');

  const doExport = (): void => {
    const store = useAppStore.getState();
    if (store.llmProfiles.length === 0) {
      Alert.alert('没有可导出', '先新增智能体，再导出配置');
      return;
    }
    const json = exportAgentJson(store.llmProfiles);
    Share.share({ message: json, title: '我的智能体配置（不含 API Key，导入后需补全）' }).catch(() => {});
  };

  const doImportParse = (): void => {
    const r = normalizeAgentText(importText);
    if (!r.ok) {
      Alert.alert('导入失败', r.error);
      return;
    }
    const outcome = mergeImportedProfiles(useAppStore.getState().llmProfiles, r.items);
    setImportOutcome(outcome);
    Alert.alert(
      '解析成功',
      `识别 ${r.items.length} 条配置：新增 ${outcome.added} 个、更新 ${outcome.updated} 个${r.skipped ? `，跳过 ${r.skipped} 条无效条目` : ''}${outcome.missingKeys ? `；其中 ${outcome.missingKeys} 个缺少 API Key，导入后请在「编辑」中补全` : ''}`,
    );
  };

  const doImportConfirm = (): void => {
    if (!importOutcome) return;
    useAppStore.getState().patch({ llmProfiles: importOutcome.list });
    scheduleUpload('config');
    setImportOpen(false);
    setImportText('');
    setImportOutcome(null);
  };

  /** 表单导入：解析 JSON / YAML（兼容数组与 {profiles}/{llmProfiles} 三种形状），
   *  单智能体回填当前表单；多智能体/编排配置转入下方向导，由「解析配置」接手 */
  const doFormImport = (): void => {
    const parsed = parseConfigText(formImportText);
    if (!parsed.ok) {
      setFormImportError(parsed.error);
      return;
    }
    const v = parsed.value;
    const s = (x: unknown): string => (x == null ? '' : String(x).trim());
    const toArr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === 'string' ? String(x).split(/[\n,，]/) : []);
    let arr: unknown[];
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).profiles)) arr = (v as { profiles: unknown[] }).profiles;
    else if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).llmProfiles)) arr = (v as { llmProfiles: unknown[] }).llmProfiles;
    else arr = [v];
    const isMulti =
      arr.length > 1 ||
      arr.some((it) => {
        const o = it as Record<string, unknown> | null;
        return !!o && typeof o === 'object' && (o.multi_agent || o.multiAgent || o.orchestrator || o.workflow || o.kind === 'multi_agent');
      });
    if (isMulti) {
      // 多智能体/编排配置 → 转入编排向导，让用户点「解析配置」
      setMultiRaw(formImportText);
      setMultiInspect(null);
      setMultiDeps(null);
      setMultiError('');
      setTestResults({});
      setFormImportOpen(false);
      setFormImportText('');
      setFormImportError('');
      Alert.alert('已填入多智能体编排向导', '识别到多智能体/编排配置，已粘贴到下方「多智能体编排配置」，请点击「解析配置」继续；若仅需单个智能体，请粘贴单条配置');
      return;
    }
    const d = (arr[0] ?? {}) as Record<string, unknown>;
    const tags = [...new Set(toArr(d.domainTags ?? d.tags).map((t) => t.trim()).filter(Boolean))].join('，');
    const qs = toArr(d.exampleQuestions ?? d.questions).map((t) => t.trim()).filter(Boolean).join('\n');
    let bind = s(d.petAssetId);
    if (!bind) {
      const pa = d.petAsset as Record<string, unknown> | string | null | undefined;
      bind = typeof pa === 'string' ? pa : pa && typeof pa === 'object' ? s((pa as Record<string, unknown>).id) : '';
    }
    setForm({
      name: s(d.name),
      apiKey: s(d.apiKey ?? d.api_key),
      baseUrl: s(d.baseUrl ?? d.base_url) || 'https://api.openai.com/v1',
      model: s(d.model),
      systemPrompt: s(d.systemPrompt ?? d.system_prompt ?? d.prompt ?? d.system),
      avatar: s(d.avatar),
      intro: s(d.intro),
      domainTags: tags,
      role: s(d.role),
      style: s(d.style),
      greeting: s(d.greeting),
      exampleQuestions: qs,
    });
    setBindPetId(bind);
    setFormImportOpen(false);
    setFormImportText('');
    setFormImportError('');
    Alert.alert('已填充', `已导入「${s(d.name) || '未命名'}」到表单，检查确认后保存即可。`);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          pm.container,
          { paddingTop: insets.top + 10, paddingBottom: (kbVisible ? kbHeight : insets.bottom) + 6 },
        ]}>
        <View style={pm.header}>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={pm.headerBtn}>关闭</Text>
          </Pressable>
          <Text style={pm.title}>智能体管理</Text>
          <Pressable onPress={openAdd} hitSlop={8}>
            <Text style={[pm.headerBtn, pm.headerBtnPrimary]}>新增</Text>
          </Pressable>
        </View>

        {formOpen ? (
          <ScrollView style={pm.form} keyboardShouldPersistTaps="handled">
            <View style={pm.formSectionRow}>
              <Text style={pm.sectionDivider}>智能体信息（人设与形象）</Text>
              <Pressable onPress={() => setFormImportOpen(true)} hitSlop={8}>
                <Text style={pm.importFormBtn}>导入配置</Text>
              </Pressable>
            </View>
            {formImportOpen ? (
              <View style={pm.importBox}>
                <Text style={pm.importTip}>粘贴单个智能体的 JSON / YAML（兼容数组与 profiles / llmProfiles 形状、可带代码块包裹）。字段解析后将直接回填本表单；多智能体/编排配置会自动转入下方「多智能体编排配置」向导。</Text>
                <TextInput
                  style={pm.importInput}
                  multiline
                  value={formImportText}
                  onChangeText={setFormImportText}
                  placeholder={'{\n  "name": "宠物医生",\n  "systemPrompt": "你是一位……",\n  "avatar": "🐱",\n  "domainTags": ["医疗"]\n}'}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {formImportError ? <Text style={pm.importError}>{formImportError}</Text> : null}
                <View style={pm.importBtns}>
                  <Pressable style={[pm.btn, pm.btnGhost]} onPress={() => { setFormImportOpen(false); setFormImportText(''); setFormImportError(''); }}>
                    <Text style={pm.btnGhostText}>取消</Text>
                  </Pressable>
                  <Pressable style={[pm.btn, pm.btnPrimary]} onPress={doFormImport} disabled={!formImportText.trim()}>
                    <Text style={pm.btnPrimaryText}>解析并填充</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            {field('名称', 'name')}
            {field('头像（emoji 或文字，留空取名称首字）', 'avatar')}
            {field('简介', 'intro')}
            {field('系统提示词（人设）', 'systemPrompt')}
            <Text style={pm.fieldLabel}>领域标签</Text>
            {chipSetter('domainTags', DOMAIN_TAG_PRESETS)}
            {field('', 'domainTags')}
            <Text style={pm.fieldLabel}>角色</Text>
            {chipSetter('role', ROLE_PRESETS)}
            {field('', 'role')}
            <Text style={pm.fieldLabel}>风格</Text>
            {chipSetter('style', STYLE_PRESETS)}
            {field('', 'style')}
            {field('欢迎语（新对话开场白）', 'greeting')}
            {field('示例问题（每行一个）', 'exampleQuestions')}
            <Text style={pm.sectionDivider}>对话 API（可多个智能体共用）</Text>
            {field('API Key', 'apiKey', true)}
            {field('接口地址', 'baseUrl')}
            {field('模型', 'model')}
            <Text style={pm.fieldHint}>多个智能体可复用同一套对话 API；从商店安装新智能体时会询问绑定哪个 API（只有一个时自动绑定）。</Text>
            <Text style={pm.fieldLabel}>绑定宠物形象</Text>
            {downloadedPets.length === 0 ? (
              <Text style={pm.fieldHint}>还没有已下载的宠物形象，去商店安装一个</Text>
            ) : (
              downloadedPets.map((pet) => {
                const selected = bindPetId === pet.id;
                return (
                  <Pressable
                    key={pet.id}
                    style={[pm.bindRow, selected && pm.bindRowActive]}
                    onPress={() => setBindPetId(selected ? '' : pet.id)}>
                    <Text style={[pm.bindRowName, selected && pm.bindRowNameActive]} numberOfLines={1}>
                      {pet.name}
                    </Text>
                    {selected && <Text style={pm.bindCheck}>✓</Text>}
                  </Pressable>
                );
              })
            )}
            <Text style={pm.fieldHint}>一个智能体必须且只能绑定一个宠物形象</Text>

            {/* ── P1-2 多智能体编排配置向导 ── */}
            <Text style={pm.sectionDivider}>多智能体编排配置（可选）</Text>
            <Text style={pm.multiTip}>
              {'支持 YAML / JSON。粘贴后点「解析配置」：自动识别是否多智能体（kind: multi_agent / agents / orchestrator / workflow），提取 ${VAR}、{{VAR}}、env:VAR、secret:VAR 外部依赖；为每条依赖填写真实信息并测试连通性后保存，凭证以内部引用存储、导出时自动剥离。'}
            </Text>
            <TextInput
              style={pm.multiEditor}
              multiline
              value={multiRaw}
              onChangeText={setMultiRaw}
              placeholder={'kind: multi_agent\nname: 宠物管家团\norchestrator:\n  type: supervisor\n  model: ${MODEL_API}\nagents:\n  - id: health\n    endpoint: ${HEALTH_AGENT_API}\n    api_key: ${HEALTH_AGENT_KEY}'}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={pm.multiBtns}>
              <Pressable
                style={[pm.btn, pm.btnGhost, pm.multiBtn]}
                onPress={handleParseMulti}
                disabled={!multiRaw.trim()}>
                <Text style={pm.btnGhostText}>解析配置</Text>
              </Pressable>
              {multiRaw.trim() && multiDeps ? (
                <Pressable style={[pm.btn, pm.btnGhost, pm.multiBtn]} onPress={clearMulti}>
                  <Text style={[pm.btnGhostText, pm.multiBtnDanger]}>清除</Text>
                </Pressable>
              ) : null}
            </View>
            {multiError ? <Text style={pm.multiError}>{multiError}</Text> : null}

            {multiInspect ? (
              <View style={pm.multiInspect}>
                <Text style={pm.multiInspectTitle}>识别结果</Text>
                <View style={pm.multiInspectTags}>
                  <Text style={[pm.multiTag, multiInspect.detected ? pm.multiTagGreen : pm.multiTagGray]}>
                    {multiInspect.detected ? '多智能体' : '普通配置'}
                  </Text>
                  {multiInspect.kind ? <Text style={pm.multiTag}>kind: {multiInspect.kind}</Text> : null}
                  {multiInspect.orchestratorType ? (
                    <Text style={[pm.multiTag, pm.multiTagPurple]}>编排器: {multiInspect.orchestratorType}</Text>
                  ) : null}
                  {multiInspect.members.length > 0 ? (
                    <Text style={pm.multiTag}>成员: {multiInspect.members.map((m) => m.id).join(' / ')}</Text>
                  ) : null}
                  {multiInspect.workflowSteps.length > 0 ? (
                    <Text style={pm.multiTag}>流程: {multiInspect.workflowSteps.join(' → ')}</Text>
                  ) : null}
                </View>
                {multiInspect.members.length > 0 ? (
                  <Text style={pm.multiInspectHint}>将按编排配置调用多个智能体；子智能体无需单独维护，凭证由下方依赖统一管理。</Text>
                ) : null}
              </View>
            ) : null}

            {multiDeps && multiDeps.length > 0 ? (
              <Text style={pm.sectionDivider}>外部依赖补全（{multiDeps.length} 项）</Text>
            ) : null}
            {multiDeps?.map((dep, idx) => {
              const result = testResults[dep.ref];
              return (
                <View key={dep.ref} style={pm.depCard}>
                  <View style={pm.depHead}>
                    <Text style={pm.depRef}>{dep.ref}</Text>
                    <Text style={pm.depKey} numberOfLines={1}>{dep.key}</Text>
                    <Text style={pm.depTag}>
                      {dep.type === 'model' ? '大模型' : dep.type === 'agent_api' ? '子智能体' : dep.type === 'tool_api' ? '工具 API' : dep.type === 'memory' ? '记忆库' : '其他'}
                    </Text>
                  </View>
                  <Text style={pm.depMeta}>
                    {dep.protocol} / {dep.auth === 'api_key' ? 'API Key' : dep.auth === 'bearer' ? 'Bearer' : dep.auth === 'oauth' ? 'OAuth' : '免鉴权'}
                  </Text>
                  <Text style={pm.fieldLabel}>用途</Text>
                  <TextInput
                    style={pm.depInput}
                    value={dep.usage}
                    onChangeText={(v) => setDepUsage(idx, v)}
                  />
                  <Text style={pm.fieldLabel}>凭证值</Text>
                  <View style={pm.depValueRow}>
                    <TextInput
                      style={[pm.depInput, { flex: 1, marginRight: 8 }]}
                      value={multiValues[dep.ref] ?? ''}
                      onChangeText={(v) => setMultiValues((prev) => ({ ...prev, [dep.ref]: v }))}
                      placeholder={dep.example}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Pressable
                      style={[pm.btn, pm.btnGhost, pm.multiBtn]}
                      onPress={() => void handleTestDependency(dep)}
                      disabled={testingRef === dep.ref}>
                      <Text style={pm.btnGhostText}>{testingRef === dep.ref ? '测试中…' : '测试连通'}</Text>
                    </Pressable>
                  </View>
                  {result ? (
                    <Text style={[pm.depResult, result.ok ? pm.depResultOk : pm.depResultFail]}>
                      {result.ok ? `✓ HTTP ${result.status}（${result.latencyMs}ms）` : `✗ ${result.error ?? `HTTP ${result.status}`}`}
                    </Text>
                  ) : null}
                  {dep.type === 'model' ? (
                    <Text style={pm.depHint}>验证该模型服务的地址 / 模型名 / 密钥是否可用（示例仅作占位）</Text>
                  ) : null}
                </View>
              );
            })}
            <View style={pm.formBtns}>
              <Pressable style={[pm.btn, pm.btnGhost]} onPress={() => setFormOpen(false)}>
                <Text style={pm.btnGhostText}>取消</Text>
              </Pressable>
              <Pressable style={[pm.btn, pm.btnPrimary]} onPress={save}>
                <Text style={pm.btnPrimaryText}>保存</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : (
          <View style={pm.list}>
            {importOpen ? (
              <View style={pm.importBox}>
                <Text style={pm.importTip}>粘贴从本应用或桌面端导出的智能体配置（JSON）。按名称合并：同名更新配置，新名称新增为独立智能体。导出文件不包含 API Key，导入后请补全。</Text>
                <TextInput
                  style={pm.importInput}
                  multiline
                  value={importText}
                  onChangeText={setImportText}
                  placeholder="在此粘贴 JSON…"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={pm.importBtns}>
                  <Pressable style={[pm.btn, pm.btnGhost]} onPress={() => { setImportOpen(false); setImportText(''); setImportOutcome(null); }}>
                    <Text style={pm.btnGhostText}>取消</Text>
                  </Pressable>
                  <Pressable style={[pm.btn, pm.btnGhost]} onPress={doImportParse}>
                    <Text style={pm.btnGhostText}>解析</Text>
                  </Pressable>
                  <Pressable style={[pm.btn, pm.btnPrimary]} onPress={doImportConfirm} disabled={!importOutcome}>
                    <Text style={pm.btnPrimaryText}>确认导入</Text>
                  </Pressable>
                </View>
                {importOutcome ? (
                  <Text style={pm.importPreview}>预览：新增 {importOutcome.added} 个 · 更新 {importOutcome.updated} 个{importOutcome.missingKeys ? ` · 缺密钥 ${importOutcome.missingKeys} 个` : ''}</Text>
                ) : null}
              </View>
            ) : (
              <>
                <View style={pm.toolbar}>
                  <Pressable style={pm.toolBtn} onPress={doExport} hitSlop={8}>
                    <Text style={pm.toolBtnText}>导出</Text>
                  </Pressable>
                  <Pressable style={pm.toolBtn} onPress={() => setImportOpen(true)} hitSlop={8}>
                    <Text style={pm.toolBtnText}>导入</Text>
                  </Pressable>
                </View>
                <TextInput
                  style={pm.search}
                  placeholder="搜索智能体（名称/模型/标签）"
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
            <FlatList
              style={pm.listInner}
              data={filtered}
              keyExtractor={(p) => p.id}
              ListEmptyComponent={<Text style={pm.empty}>还没有智能体，点右上角「新增」创建一个</Text>}
              renderItem={({ item }) => {
                const active = item.id === activeId;
                const boundPet = item.petAssetId ? downloadedPets.find((p) => p.id === item.petAssetId) : null;
                const enabled = item.enabled !== false;
                const avatar = item.avatar?.trim() || item.name.slice(0, 1).toUpperCase();
                return (
                  <Pressable
                    style={[pm.row, active && pm.rowActive, !enabled && pm.rowDisabled]}
                    onPress={() => switchTo(item.id)}>
                    <View style={pm.avatarCircle}>
                      <Text style={pm.avatarText} numberOfLines={1}>{avatar}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={pm.rowName}>
                        {item.name}
                        {active ? '（当前）' : ''}
                        {!enabled ? '（已停用）' : ''}
                      </Text>
                      <Text style={pm.rowSub} numberOfLines={1}>
                        {item.model || '未设置模型'}
                        {boundPet ? ` · ${boundPet.name}` : ' · 未绑定形象'}
                      </Text>
                      {item.multiConfig ? <Text style={pm.multiBadge}>多智能体</Text> : null}
                      {(item.domainTags?.length || item.style) ? (
                        <Text style={pm.rowTags} numberOfLines={1}>
                          {item.domainTags?.length ? item.domainTags.join(' / ') : ''}
                          {item.style ? `${item.domainTags?.length ? ' · ' : ''}${item.style}` : ''}
                        </Text>
                      ) : null}
                    </View>
                    <View style={pm.rowActions}>
                      <Switch
                        value={enabled}
                        onValueChange={() => toggleEnabled(item)}
                        trackColor={{ false: '#D9D9D9', true: '#4D6BFE' }}
                        thumbColor="#fff"
                        style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
                      />
                      <View style={pm.rowBtns}>
                        <Pressable style={pm.rowBtn} onPress={() => duplicate(item)} hitSlop={6}>
                          <Text style={pm.rowBtnText}>复制</Text>
                        </Pressable>
                        <Pressable style={pm.rowBtn} onPress={() => openEdit(item)} hitSlop={6}>
                          <Text style={pm.rowBtnText}>编辑</Text>
                        </Pressable>
                        <Pressable style={pm.rowBtn} onPress={() => remove(item)} hitSlop={6}>
                          <Text style={[pm.rowBtnText, pm.rowBtnDanger]}>删除</Text>
                        </Pressable>
                      </View>
                    </View>
                  </Pressable>
                );
              }}
            />
              </>
            )}
          </View>
        )}
        <Text style={pm.hint}>修改会自动云同步，桌面端登录同一账号即可共用</Text>
      </View>
    </Modal>
  );
}

export default function ChatScreen({ onOpenDrawer }: { onOpenDrawer?: () => void }): React.JSX.Element {
  const messages = useAppStore((s) => s.messages);
  const profiles = useAppStore((s) => s.llmProfiles);
  const activeId = useAppStore((s) => s.llmActiveProfileId);
  const [input, setInput] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [managerVisible, setManagerVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const copyWebRef = useRef<React.ElementRef<typeof WebView>>(null);
  const [copyToast, setCopyToast] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 复制文本：注入隐藏 WebView 执行 execCommand('copy')（RN 内核无剪贴板，热更期不引原生模块） */
  const copyText = (t: string): void => {
    try {
      copyWebRef.current?.injectJavaScript(`window.__copy(${JSON.stringify(t)});true;`);
    } catch {
      /* 剪贴板写入失败不影响聊天 */
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopyToast(true);
    copyTimerRef.current = setTimeout(() => setCopyToast(false), 1600);
  };
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => undefined);
  // 微信式贴底跟随：流式输出/新消息时自动滚到最新；用户上滑看历史则暂停，滑回底部自动恢复
  const followRef = useRef(true);
  const insets = useSafeAreaInsets();
  const { kbHeight, kbVisible } = useKeyboardHeight();

  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  const configured = supportsChat();

  // 倒序列表：最新一条天然锚定在底部，进入页面必显示（微信式），无需滚动调用
  const data = useMemo(() => [...messages].reverse(), [messages]);

  // 语音识别事件订阅（partial 实时回显，最终结果自动发送）
  useEffect(() => {
    return subscribeVoice({
      onStart: () => setListening(true),
      onPartial: (t) => setInput(t),
      onResult: (t) => {
        setListening(false);
        const text = t.trim();
        if (text) void sendRef.current(text);
      },
      onError: () => setListening(false),
    });
  }, []);

  // 执行一次助手流式回复：思考阶段单独计时；切后台/网络中断自动重试一次
  const runAssistant = async (assistantId: string, history: ChatMsg[], allowRetry: boolean): Promise<void> => {
    setSending(true);
    const startedAt = Date.now();
    let thinkStart = 0;
    let thinkEnd = 0;
    // 历史里旧的报错消息不参与上下文
    const cleanHistory = history.filter((m) => !(m.role === 'assistant' && m.error));
    try {
      const { content, reasoning } = await streamChat(cleanHistory, {
        onReasoning: (d) => {
          if (!thinkStart) thinkStart = Date.now();
          useAppStore.getState().appendMessageChunk(assistantId, { reasoningDelta: d });
        },
        onContent: (d) => {
          if (thinkStart && !thinkEnd) thinkEnd = Date.now();
          useAppStore.getState().appendMessageChunk(assistantId, { contentDelta: d });
        },
      });
      const cur = useAppStore.getState();
      const target = cur.messages.find((m) => m.id === assistantId);
      const hasReasoning = !!(target?.reasoning?.trim() || reasoning?.trim());
      // 思考用时 = 首个思考增量 → 首个正文增量；非流式降级无增量则退回整请求耗时
      const thinkSeconds = thinkStart
        ? Math.max(1, Math.round(((thinkEnd || Date.now()) - thinkStart) / 1000))
        : hasReasoning
          ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          : undefined;
      const patch: Partial<ChatMsg> = { pending: false, streaming: false };
      if (thinkSeconds) patch.thinkSeconds = thinkSeconds;
      // 非流式降级路径不会产生增量：用最终结果回填
      if (!target?.content && content) patch.content = content;
      if (!target?.reasoning && reasoning) patch.reasoning = reasoning;
      cur.patchMessage(assistantId, patch);
      // 互动实装：聊天成功好感+1（好感度不受状态开关影响，见宠物页说明）
      useAppStore.getState().addAffection(1);
      // 心情与对话关联：按回复情绪词调整心情（设置里可关闭；需宠物状态功能开启）
      const stMood = useAppStore.getState();
      if (stMood.petStateEnabled && stMood.moodFromChat) {
        const text = (target?.content || content || '').slice(0, 300);
        const negative = /(生气|讨厌|不理你|不想理|烦死了|无聊|凶|哭|委屈|骂你|打你|坏主人)/.test(text);
        const positive = /(开心|高兴|喜欢|谢谢|感谢|么么|愉快|爱你|真棒|好耶|嘻嘻|哈哈|摸摸|夸你|原谅你)/.test(text);
        if (negative && !positive) useAppStore.getState().adjustMood(-8);
        else if (positive && !negative) useAppStore.getState().adjustMood(8);
      }
      // 开启朗读时读出回复（错误提示不读，带音色/语速/音调设置）
      const st = useAppStore.getState();
      if (st.ttsEnabled) {
        void speak(content, { rate: st.speechRate, pitch: st.speechPitch, voice: st.speechVoice || undefined });
      }
    } catch (e) {
      if (allowRetry && e instanceof StreamInterruptError) {
        // 留 1.2 秒网络恢复窗口（切后台回来/基站切换后立刻重连大概率再断），再清空占位重发（只一次）
        await new Promise((r) => setTimeout(() => r(null), 1200));
        useAppStore.getState().patchMessage(assistantId, {
          pending: true,
          streaming: true,
          content: '',
          reasoning: '',
          thinkSeconds: undefined,
          error: false,
        });
        await runAssistant(assistantId, history, false);
        return;
      }
      const patch: Partial<ChatMsg> = {
        pending: false,
        streaming: false,
        error: true,
        content: `出错了：${e instanceof Error ? e.message : String(e)}`,
      };
      // 思考已开始则保留真实思考用时（不再显示无秒数的「已深度思考」）
      if (thinkStart) patch.thinkSeconds = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
      useAppStore.getState().patchMessage(assistantId, patch);
    } finally {
      setSending(false);
      scheduleUpload('chat_history');
    }
  };

  /** 严格绑定守卫：当前激活智能体必须已绑定且已下载形象才能对话，否则提示并返回 false */
  const activePetReady = (): boolean => {
    const s = useAppStore.getState();
    const target = s.llmProfiles.find((p) => p.id === s.llmActiveProfileId);
    const ready = !!target?.petAssetId && !!s.downloadedPets.find((p) => p.id === target.petAssetId);
    if (!ready) {
      Alert.alert('该智能体未绑定宠物形象', '无法对话。请先在「智能体管理 → 编辑」中绑定一个已下载的宠物形象后使用');
    }
    return ready;
  };

  const send = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? input).trim();
    if (!text || sending) return;
    // 严格绑定：无形象智能体不能使用，拦截发送
    if (!activePetReady()) return;
    setInput('');
    const store0 = useAppStore.getState();
    const history: ChatMsg[] = [...store0.messages, { role: 'user', content: text }];
    const assistantId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    store0.appendMessages([
      { role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', pending: true, streaming: true },
    ]);
    // 倒序列表底部=offset 0：发送后回到最新（用户上翻看历史时也能看到自己刚发的消息）
    followRef.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
    await runAssistant(assistantId, history, true);
  };

  // 错误气泡点击重试：以该消息之前的历史重发
  const retryMsg = (id: string): void => {
    if (sending) return;
    // 严格绑定：无形象智能体不能使用，拦截重试
    if (!activePetReady()) return;
    const store = useAppStore.getState();
    const idx = store.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const history: ChatMsg[] = store.messages.slice(0, idx);
    store.patchMessage(id, { pending: true, streaming: true, content: '', reasoning: '', thinkSeconds: undefined, error: false });
    followRef.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
    void runAssistant(id, history, true);
  };
  sendRef.current = send;

  // 按住说话：先请求麦克风权限，开始前停掉 TTS 防自听
  const micPressIn = async (): Promise<void> => {
    if (!isSpeechAvailable()) {
      Alert.alert('功能不可用', '当前设备缺少语音模块');
      return;
    }
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: '麦克风权限',
        message: '用于按住说话和宠物语音对话',
        buttonPositive: '允许',
        buttonNegative: '拒绝',
      });
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
      await stopSpeak();
      await startListening();
    } catch (e) {
      Alert.alert('无法开始识别', e instanceof Error ? e.message : String(e));
    }
  };

  const micPressOut = (): void => {
    if (listening) void stopListening();
  };

  // 清空对话：与桌面端一致先确认（可在设置关闭询问；清空即同时清本地并同步清云端）
  const confirmClear = (): void => {
    if (!messages.length) return;
    if (!useAppStore.getState().chatClearConfirm) {
      useAppStore.getState().clearMessages();
      scheduleUpload('chat_history');
      return;
    }
    Alert.alert('清空对话', '确定要清空全部对话记录吗？清空后无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空全部对话记录',
        style: 'destructive',
        onPress: () => {
          useAppStore.getState().clearMessages();
          scheduleUpload('chat_history');
        },
      },
    ]);
  };

  const canSend = !!input.trim() && !sending;

  /** 复制全部聊天记录：拼接当前对话（含深度思考）为纯文本，走系统分享（可复制/发送/保存） */
  const copyAllChat = (): void => {
    const s = useAppStore.getState();
    if (!s.messages.length) return;
    const agentName = profile?.name ?? '智能体';
    const lines: string[] = [];
    for (const m of s.messages) {
      const content = String(m.content ?? '').trim();
      const think = (m.reasoning ?? '').trim();
      const parts: string[] = [];
      if (think) parts.push(`【深度思考】${think}`);
      if (content) parts.push(content);
      if (m.error && !content) parts.push('（本条发送失败）');
      if (m.role === 'user') lines.push(`我：${content}`);
      else lines.push(`${agentName}：${parts.join('\n')}`);
    }
    Share.share({ message: lines.join('\n\n'), title: `${agentName} 聊天记录` }).catch(() => undefined);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerSideLeft}>
          <Pressable onPress={() => onOpenDrawer?.()} hitSlop={10}>
            <View style={styles.burger}>
              <View style={styles.burgerLine} />
              <View style={[styles.burgerLine, { width: 12 }]} />
            </View>
          </Pressable>
        </View>
        <Pressable style={styles.headerCenter} onPress={() => setManagerVisible(true)} hitSlop={6}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {configured ? profile?.name ?? '智能体' : '未配置聊天 API'}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {configured ? profile?.model ?? '' : '点此管理智能体'}
          </Text>
        </Pressable>
        <View style={styles.headerSideRight}>
          <Pressable onPress={copyAllChat} hitSlop={12} disabled={!messages.length} style={{ marginRight: 14 }}>
            <Text style={[styles.headerAction, !messages.length && styles.headerActionDisabled]}>复制</Text>
          </Pressable>
          <Pressable onPress={confirmClear} hitSlop={12} disabled={!messages.length}>
            <Text style={[styles.headerAction, !messages.length && styles.headerActionDisabled]}>清空</Text>
          </Pressable>
        </View>
      </View>

      {!profiles.length && (
        <Pressable style={styles.guide} onPress={() => setManagerVisible(true)}>
          <Text style={styles.guideText}>
            还没有 API 档案。点击这里在手机上直接创建，或在桌面端「API 配置」中添加后登录同一账号自动同步。
          </Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        style={styles.list}
        data={data}
        inverted
        keyExtractor={(m, i) => m.id ?? String(i)}
        renderItem={({ item }) => item.id ? <Bubble msg={item} onRetry={() => retryMsg(item.id!)} onCopy={copyText} /> : <Bubble msg={item} onRetry={() => undefined} onCopy={copyText} />}
        ListEmptyComponent={<Text style={styles.empty}>和宠物聊点什么吧</Text>}
        // 微信式跟随：贴底(offset<60)时内容增长自动滚到最新；上滑看历史则暂停跟随，滑回底部自动恢复
        onScroll={(e) => { followRef.current = e.nativeEvent.contentOffset.y < 60; }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (followRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
      />

      {/* 隐藏复制引擎：1×1 WebView 提供剪贴板写入（execCommand('copy')），支持代码块/链接一键复制 */}
      <WebView
        ref={copyWebRef}
        style={styles.hiddenWeb}
        originWhitelist={['*']}
        javaScriptEnabled
        onError={() => undefined}
        source={{ html: COPY_HTML }}
      />
      {copyToast && (
        <View style={styles.copyToast} pointerEvents="none">
          <Text style={styles.copyToastText}>已复制</Text>
        </View>
      )}

      {/* Trae 式输入卡：大圆角灰卡内含输入框与工具行（模型 chip / 按住说话 / 圆形发送钮）
          仅当键盘可见且输入框聚焦时才让出键盘空间，失焦/事件丢失时绝不残留大 padding，
          避免底栏被撑高、聊天区只剩上半屏、下方出现无法点击滚动的空白 */}
      <View style={[styles.inputWrap, { paddingBottom: kbVisible && inputFocused ? kbHeight : insets.bottom + 6 }]}>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.input}
            placeholder={configured ? '发消息，或按住麦克风说话…' : '先创建 API 档案'}
            placeholderTextColor="#B2B2B2"
            value={input}
            onChangeText={setInput}
            multiline
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
          <View style={styles.inputTools}>
            <Pressable style={styles.modelChip} onPress={() => setManagerVisible(true)} hitSlop={4}>
              <Text style={styles.modelChipText} numberOfLines={1}>
                {configured ? `${profile?.name ?? 'API'} · ${profile?.model ?? ''}` : '未配置模型'}
              </Text>
              <Text style={styles.modelChipChevron}>▼</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              style={[styles.micPill, listening && styles.micPillActive]}
              onPressIn={() => void micPressIn()}
              onPressOut={micPressOut}>
              <Text style={styles.micPillText}>{listening ? '松开' : '按住'}</Text>
            </Pressable>
            <Pressable
              style={[styles.sendCircle, !canSend && styles.sendCircleDisabled]}
              onPress={() => void send()}
              disabled={!canSend}
              hitSlop={4}>
              <Text style={styles.sendIcon}>↑</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <ProfileManager visible={managerVisible} onClose={() => setManagerVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Trae 手机端排版：白底 + 浅灰圆角卡片 + 大圆角输入卡
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#FFFFFF', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#F0F0F0' },
  headerSideLeft: { flex: 1, alignItems: 'flex-start' },
  headerSideRight: { flex: 1, alignItems: 'flex-end' },
  burger: { width: 26, height: 22, justifyContent: 'center', gap: 5, alignItems: 'flex-start' },
  burgerLine: { width: 20, height: 2, borderRadius: 1, backgroundColor: '#333' },
  headerCenter: { flex: 5, alignItems: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  headerSub: { fontSize: 11, color: '#999', marginTop: 1 },
  headerAction: { fontSize: 13, color: '#1C6EF2' },
  headerActionDisabled: { color: '#CCC' },
  headerSwitch: { fontSize: 9, color: '#999', marginLeft: 4, marginTop: 1 },
  guide: { backgroundColor: '#FFF7E6', margin: 12, marginBottom: 0, borderRadius: 12, padding: 10 },
  guideText: { color: '#9A6B00', fontSize: 12, lineHeight: 18 },
  list: { flex: 1, paddingHorizontal: 12 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  bubbleRow: { flexDirection: 'row', marginVertical: 5 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '86%', borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  // 双方均为浅灰圆角卡（无尖角无描边），靠左右对齐区分；我方灰度略深（用户要求回到上一个版本）
  bubbleMine: { backgroundColor: '#E9EBF0', borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: '#F7F8FA', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, lineHeight: 22, color: '#1A1A1A' },
  bubbleTextMine: { fontSize: 15, lineHeight: 22, color: '#1A1A1A' },
  bubbleError: { fontSize: 15, lineHeight: 22, color: '#E5484D' },
  retryHint: { fontSize: 12, color: '#1C6EF2', marginTop: 6 },
  // Trae 式等待指示：无气泡
  waitWrap: { paddingHorizontal: 4, paddingVertical: 6 },
  waitTitle: { fontSize: 13, color: '#8A8A8A' },
  waitDots: { flexDirection: 'row', marginLeft: 2, marginTop: 8 },
  waitDot: { width: 8, height: 8, borderRadius: 4, marginRight: 9 },
  // 思考卡片（灰卡上用白底浮起）
  thinkCard: { backgroundColor: '#FFFFFF', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, borderWidth: StyleSheet.hairlineWidth, borderColor: '#ECECEC' },
  thinkHeader: { flexDirection: 'row', alignItems: 'center' },
  thinkTitle: { fontSize: 13, fontWeight: '600', color: '#5F6368', flex: 1 },
  thinkChevron: { fontSize: 12, color: '#AAA', marginLeft: 6 },
  thinkBody: { fontSize: 12.5, lineHeight: 20, color: '#6B6B6B', marginTop: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#EEEEEE', paddingTop: 7 },
  contentAfterThink: { marginTop: 9 },
  // Trae 式输入卡
  inputWrap: { backgroundColor: '#FFFFFF', paddingTop: 10 },
  inputCard: { backgroundColor: '#F2F3F5', borderRadius: 22, marginHorizontal: 12, paddingHorizontal: 14, paddingTop: 4, paddingBottom: 8 },
  input: { minHeight: 40, maxHeight: 110, fontSize: 16, color: '#1A1A1A', paddingHorizontal: 2, paddingTop: 9, textAlignVertical: 'top' },
  inputTools: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  modelChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, maxWidth: '55%' },
  modelChipText: { fontSize: 12, color: '#4B4B4B', flexShrink: 1 },
  modelChipChevron: { fontSize: 9, color: '#999', marginLeft: 4 },
  micPill: { minWidth: 34, height: 30, borderRadius: 15, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, marginLeft: 8 },
  micPillActive: { backgroundColor: '#FDE2E2' },
  micPillText: { fontSize: 11, color: '#4B4B4B' },
  sendCircle: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#4D6BFE', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  sendCircleDisabled: { backgroundColor: '#C9CDD6' },
  sendIcon: { fontSize: 17, color: '#FFFFFF', fontWeight: '700', marginTop: -2 },
  // 智能体切换弹窗
  switcherMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  switcherCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18, width: '100%' },
  switcherTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginBottom: 12 },
  switcherRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  switcherRowActive: { backgroundColor: '#F0F6FF', borderRadius: 8, paddingHorizontal: 8, marginHorizontal: -8 },
  switcherRowText: { fontSize: 15, color: '#1A1A1A', flex: 1, marginRight: 8 },
  switcherRowActiveText: { color: '#4D6BFE', fontWeight: '600' },
  switcherCheck: { fontSize: 16, color: '#4D6BFE', fontWeight: '600' },
  switcherEmpty: { fontSize: 13, color: '#AAA', textAlign: 'center', paddingVertical: 20 },
  switcherHint: { fontSize: 11, color: '#AAA', marginTop: 10, textAlign: 'center' },
  // 隐藏复制引擎与「已复制」提示
  hiddenWeb: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -100, top: 0 },
  copyToast: { position: 'absolute', alignSelf: 'center', bottom: 130, backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  copyToastText: { color: '#fff', fontSize: 13 },
});

const pm = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  title: { fontSize: 16, fontWeight: '700', color: '#333' },
  headerBtn: { fontSize: 14, color: '#666', paddingHorizontal: 4 },
  headerBtnPrimary: { color: '#1C6EF2', fontWeight: '600' },
  list: { flex: 1, padding: 12 },
  listInner: { flex: 1 },
  search: { backgroundColor: '#F2F3F5', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F7F8FA', borderRadius: 10, padding: 12, marginBottom: 8 },
  rowActive: { borderWidth: 1.5, borderColor: '#1C6EF2', backgroundColor: '#F0F6FF' },
  rowDisabled: { opacity: 0.55 },
  avatarCircle: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E8EDFB', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  avatarText: { fontSize: 15, fontWeight: '600', color: '#4D6BFE' },
  rowName: { fontSize: 14, fontWeight: '600', color: '#333' },
  rowSub: { fontSize: 12, color: '#999', marginTop: 2 },
  rowTags: { fontSize: 11, color: '#7C8CE0', marginTop: 3, backgroundColor: '#EEF1FB', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: 'flex-start', overflow: 'hidden' },
  rowActions: { alignItems: 'flex-end', marginLeft: 8 },
  rowBtns: { flexDirection: 'row', marginTop: 4 },
  rowBtn: { marginLeft: 12, paddingHorizontal: 6, paddingVertical: 4 },
  rowBtnText: { fontSize: 13, color: '#1C6EF2' },
  rowBtnDanger: { color: '#E5484D' },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  form: { flex: 1, padding: 14 },
  fieldLabel: { fontSize: 12, color: '#888', marginTop: 10, marginBottom: 4 },
  field: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, minHeight: 40, textAlignVertical: 'top' },
  fieldHint: { fontSize: 12, color: '#AAA', marginBottom: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  chip: { borderRadius: 14, borderWidth: 1, borderColor: '#DDD', paddingHorizontal: 12, paddingVertical: 5, marginRight: 8, marginBottom: 6 },
  chipOn: { backgroundColor: '#E8EDFB', borderColor: '#4D6BFE' },
  chipText: { fontSize: 12, color: '#666' },
  chipTextOn: { color: '#4D6BFE', fontWeight: '600' },
  bindRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  bindRowActive: { backgroundColor: '#F0F6FF', borderRadius: 8, paddingHorizontal: 8, marginHorizontal: -8 },
  bindRowName: { fontSize: 14, color: '#1A1A1A', flex: 1, marginRight: 8 },
  bindRowNameActive: { color: '#4D6BFE', fontWeight: '600' },
  bindCheck: { fontSize: 16, color: '#4D6BFE', fontWeight: '600' },
  formBtns: { flexDirection: 'row', marginTop: 18, marginBottom: 30 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: '#DDD', marginRight: 10 },
  btnGhostText: { color: '#666', fontSize: 14 },
  btnPrimary: { backgroundColor: '#1C6EF2' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 11, color: '#AAA', padding: 12, paddingBottom: 20, textAlign: 'center' },
  toolbar: { flexDirection: 'row', marginBottom: 10 },
  toolBtn: { backgroundColor: '#F2F3F5', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7, marginRight: 10 },
  toolBtnText: { fontSize: 13, color: '#1C6EF2', fontWeight: '500' },
  importBox: { flex: 1, paddingHorizontal: 4, paddingTop: 8 },
  importTip: { fontSize: 12, color: '#888', lineHeight: 18, marginBottom: 10 },
  importInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, minHeight: 180, textAlignVertical: 'top', marginBottom: 12, backgroundColor: '#FAFAFA' },
  importBtns: { flexDirection: 'row', marginBottom: 10 },
  importPreview: { fontSize: 12, color: '#4D6BFE', fontWeight: '500' },
  formSectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  importFormBtn: { fontSize: 13, color: '#1C6EF2', fontWeight: '600' },
  importError: { fontSize: 12, color: '#E5484D', marginBottom: 8 },
  // ── P1-2 多智能体编排配置向导 ──
  multiBadge: { fontSize: 10, color: '#8B3DFF', backgroundColor: '#F3E8FF', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', alignSelf: 'flex-start', marginTop: 3 },
  sectionDivider: { fontSize: 14, fontWeight: '700', color: '#333', marginTop: 18, marginBottom: 6 },
  multiTip: { fontSize: 12, color: '#888', lineHeight: 18, marginBottom: 8 },
  multiEditor: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), minHeight: 150, maxHeight: 240, textAlignVertical: 'top', backgroundColor: '#FAFAFA' },
  multiBtns: { flexDirection: 'row', marginTop: 4, marginBottom: 2 },
  multiBtn: { flex: 0, paddingHorizontal: 16, marginRight: 10 },
  multiBtnDanger: { color: '#E5484D' },
  multiError: { fontSize: 12, color: '#E5484D', marginTop: 8, lineHeight: 17 },
  multiInspect: { backgroundColor: '#F6F8FF', borderRadius: 10, padding: 10, marginTop: 10 },
  multiInspectTitle: { fontSize: 12, fontWeight: '600', color: '#5F6368', marginBottom: 8 },
  multiInspectTags: { flexDirection: 'row', flexWrap: 'wrap' },
  multiTag: { fontSize: 11, color: '#4B5563', backgroundColor: '#EEF0F3', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginRight: 6, marginBottom: 4, overflow: 'hidden' },
  multiTagGreen: { backgroundColor: '#E6F7EC', color: '#1A7F37' },
  multiTagGray: { backgroundColor: '#F0F0F0', color: '#666' },
  multiTagPurple: { backgroundColor: '#F3E8FF', color: '#8B3DFF' },
  multiInspectHint: { fontSize: 11, color: '#888', marginTop: 6, lineHeight: 16 },
  depCard: { borderWidth: 1, borderColor: '#EEE', borderRadius: 10, padding: 10, marginTop: 8 },
  depHead: { flexDirection: 'row', alignItems: 'center' },
  depRef: { fontSize: 11, color: '#B45309', backgroundColor: '#FEF3E2', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden' },
  depKey: { fontSize: 13, fontWeight: '600', color: '#1A1A1A', marginLeft: 8, flexShrink: 1 },
  depTag: { fontSize: 11, color: '#4D6BFE', backgroundColor: '#E8EDFB', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 'auto', overflow: 'hidden' },
  depMeta: { fontSize: 12, color: '#999', marginTop: 4 },
  depInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, backgroundColor: '#FFF' },
  depValueRow: { flexDirection: 'row', alignItems: 'center' },
  depResult: { fontSize: 12, marginTop: 6 },
  depResultOk: { color: '#1A7F37' },
  depResultFail: { color: '#E5484D' },
  depHint: { fontSize: 11, color: '#AAA', marginTop: 4, lineHeight: 15 },
});
