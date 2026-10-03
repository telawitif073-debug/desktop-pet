/** 聊天页：直连用户 LLM 档案（云同步），流式输出（思考过程逐字可见）；含档案管理与清空确认 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  PermissionsAndroid,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AbortedError, supportsChat, streamChat, StreamInterruptError } from '../chat/llm';
import { scheduleUpload } from '../api/sync';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { isSpeechAvailable, startListening, stopListening, subscribeVoice } from '../native/Voice';
import { speakReply, stopAllVoice } from '../voiceEngine';
import type { ChatMsg, LlmProfile } from '../types';
import { exportAgentJson, isPersonaCard, normalizeAgentText, mergeImportedProfiles, parseConfigText, personaCardToAgent } from '../agentPort';
import type { ImportOutcome } from '../agentPort';
import type { CapabilityOffer } from '../agentPort';
import {
  capabilityDesc,
  capabilityLabel,
  detectCapabilities,
  type CapabilityDetection,
} from '../petCapabilities';
import { extractTaskDirectives, detectPetIntent, stripTaskMarkers } from '../petTasks';
import { createTaskFromDirective, handlePetIntent, mentionsDue } from '../petTaskScheduler';
import type { AgentCapabilities, AgentCapabilityKind, AgentCapabilitySpec, WebSearchProvider, WebSearchSpec } from '../types';
import { PROVIDER_LABEL, WEB_COST_HINT } from '../webSearch';
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

function Bubble({ msg, onRetry, onCopy, onLongPress }: { msg: ChatMsg; onRetry: () => void; onCopy: (t: string) => void; onLongPress?: (msg: ChatMsg) => void }): React.JSX.Element {
  const showThinking = useAppStore((s) => s.showThinking);
  const mine = msg.role === 'user';
  if (mine) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
        <Pressable
          style={[styles.bubble, styles.bubbleMine]}
          onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
          delayLongPress={350}>
          <Text selectable style={styles.bubbleTextMine}>{msg.content}</Text>
        </Pressable>
      </View>
    );
  }
  // 思考开关关闭时完全忽略 reasoning：既不显示思考卡，
  // 也不让「隐形思考期」（模型仍返回 reasoning）误判为有内容而渲染空气泡
  const reasoning = showThinking ? msg.reasoning : undefined;
  const hasReasoning = !!reasoning && reasoning.trim().length > 0;
  // 展示用剥离：任务指令（[[TASK|…]]）及其流式未写完的尾巴都不给用户看
  const shown = stripTaskMarkers(msg.content ?? '');
  const hasContent = shown.trim().length > 0;
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
          onPress={msg.error ? onRetry : undefined}
          onLongPress={onLongPress && !msg.streaming ? () => onLongPress(msg) : undefined}
          delayLongPress={350}>
          {hasReasoning && reasoning && (
            <ThinkCard reasoning={reasoning} seconds={msg.thinkSeconds} streaming={msg.streaming} />
          )}
          {hasContent && (looksMarkdown(shown) ? (
            <MarkdownText
              content={shown + (msg.streaming && !msg.error ? ' ▍' : '')}
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
              {shown}
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
  const downloadedVoices = useAppStore((s) => s.downloadedVoices);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [bindPetId, setBindPetId] = useState<string>('');
  /** 编辑表单选中的专属朗读音色 id（''=跟随全局默认音色） */
  const [bindVoiceId, setBindVoiceId] = useState<string>('');
  const [search, setSearch] = useState('');
  // ── 主动能力（来自导入 JSON 的检测结果 + 用户勾选；见 petCapabilities.ts）──
  /** 编辑表单里勾选的该智能体能力 */
  const [formCaps, setFormCaps] = useState<AgentCapabilityKind[]>([]);
  /** 该智能体自己的能力规格（间隔/时段/示例任务，来自它的 JSON） */
  const [formCapSpec, setFormCapSpec] = useState<AgentCapabilitySpec>({});
  /** 表单底部提示（导入检测到能力时说明「已为你勾选」） */
  const [formCapHint, setFormCapHint] = useState('');
  /** 批量导入后待确认的能力添加项（每个智能体一项） */
  const [capOffers, setCapOffers] = useState<CapabilityOffer[] | null>(null);
  /** 导入弹窗里每个智能体勾选的能力 */
  const [capChecked, setCapChecked] = useState<Record<string, AgentCapabilityKind[]>>({});

  // 从聊天页顶部每次进入都必须落在「智能体选择页（列表）」：
  // Modal 关闭期间组件仍挂载、formOpen 会残留，重新打开时重置回列表
  useEffect(() => {
    if (visible) setFormOpen(false);
  }, [visible]);

  const openAdd = (): void => {
    setEditingId('');
    setForm(emptyForm());
    setBindPetId('');
    setBindVoiceId('');
    setFormCaps([]);
    setFormCapSpec({});
    setFormCapHint('');
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
    setBindVoiceId(p.boundVoiceId ?? '');
    // 回填该智能体的主动能力（来自导入 JSON 的检测结果与用户此前的勾选）
    setFormCaps(p.capabilities?.enabled ?? []);
    setFormCapSpec(p.capabilities?.spec ?? {});
    setFormCapHint('');
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
    const newFields = {
      avatar: form.avatar.trim() || undefined,
      intro: form.intro.trim() || undefined,
      domainTags: linesToArray(form.domainTags),
      role: form.role.trim() || undefined,
      style: form.style.trim() || undefined,
      greeting: form.greeting.trim() || undefined,
      exampleQuestions: linesToArray(form.exampleQuestions),
    };
    // 主动能力（来自导入 JSON 的检测 + 用户勾选）：规格用该智能体自己的（间隔/时段/示例任务）
    const capabilities: AgentCapabilities | undefined =
      formCaps.length || Object.keys(formCapSpec).length
        ? { enabled: formCaps, spec: { ...formCapSpec, source: formCapSpec.source ?? 'manual' } }
        : undefined;
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
              boundVoiceId: bindVoiceId || undefined,
              capabilities,
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
        boundVoiceId: bindVoiceId || undefined,
        enabled: true,
        capabilities,
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
    const offers = importOutcome.capabilityOffers;
    setImportOpen(false);
    setImportText('');
    setImportOutcome(null);
    // 检测到自带主动能力的智能体：弹「是否为它添加这些能力」（检测到的默认勾选，可取消）
    if (offers?.length) {
      const checked: Record<string, AgentCapabilityKind[]> = {};
      for (const o of offers) checked[o.profileId] = [...o.kinds];
      setCapChecked(checked);
      setCapOffers(offers);
    }
  };

  /** 切换导入弹窗里某个智能体的某项能力 */
  const toggleOfferCap = (profileId: string, kind: AgentCapabilityKind): void => {
    setCapChecked((prev) => {
      const cur = prev[profileId] ?? [];
      return { ...prev, [profileId]: cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind] };
    });
  };

  /** 应用导入弹窗的选择：把能力写进对应智能体（规格保留它自己 JSON 里的间隔/时段/示例任务） */
  const applyCapabilityOffers = (): void => {
    if (!capOffers) return;
    const store = useAppStore.getState();
    const byId = new Map(capOffers.map((o) => [o.profileId, o]));
    const next = store.llmProfiles.map((p) => {
      const o = byId.get(p.id);
      if (!o) return p;
      return {
        ...p,
        capabilities: { enabled: capChecked[p.id] ?? [], spec: { ...o.spec, source: 'import' as const } },
      };
    });
    store.patch({ llmProfiles: next });
    scheduleUpload('config');
    setCapOffers(null);
  };

  /** 编辑表单：切换某项能力 */
  const toggleFormCap = (kind: AgentCapabilityKind): void => {
    setFormCaps((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  };

  /** 编辑表单：更新联网查询的搜索服务配置（提供商 / Key / 接口地址） */
  const setWebSpec = (patch: Partial<WebSearchSpec>): void => {
    setFormCapSpec((prev) => {
      const cur: WebSearchSpec = prev.web ?? { provider: 'bocha', apiKey: '' };
      return { ...prev, web: { ...cur, ...patch } };
    });
  };

  /** 编辑表单：切换该智能体的搭话间隔（10/30/60/120 循环） */
  const cycleCapInterval = (): void => {
    const options = [10, 30, 60, 120];
    const cur = formCapSpec.intervalMinutes ?? 30;
    const idx = options.indexOf(cur);
    const next = options[(idx + 1) % options.length];
    setFormCapSpec((prev) => ({ ...prev, intervalMinutes: next }));
  };

  /** 表单导入：解析 JSON / YAML（兼容数组与 {profiles}/{llmProfiles} 三种形状，以及人设卡 agent_name/persona），
   *  单智能体回填当前表单；多条配置请改用列表页「导入」。
   *  完全未识别出任何字段时报错并保留原表单（此前会把编辑中的内容清成空白，表现成「进入新增智能体」）。 */
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
    const isOrchestrationConfig = arr.some((it) => {
      const o = it as Record<string, unknown> | null;
      return !!o && typeof o === 'object' && (o.multi_agent || o.multiAgent || o.orchestrator || o.workflow || o.kind === 'multi_agent');
    });
    if (isOrchestrationConfig) {
      setFormImportError('不再支持多智能体编排配置。请粘贴单个智能体的配置（name / baseUrl / model / systemPrompt 等）或人设卡（agent_name / persona）');
      return;
    }
    if (arr.length > 1) {
      setFormImportError(`识别到 ${arr.length} 条智能体配置：请改用列表页的「导入」批量导入，本表单只能回填一个智能体`);
      return;
    }
    const d = (arr[0] ?? {}) as Record<string, unknown>;
    // 人设卡（agent_name / persona…）：映射到表单字段；显式字段优先，人设对象兜底
    const card = isPersonaCard(d) ? personaCardToAgent(d) : null;
    const name = s(d.name) || card?.name || '';
    const systemPrompt = s(d.systemPrompt ?? d.system_prompt ?? d.prompt ?? d.system) || card?.systemPrompt || '';
    const role = s(d.role) || card?.role || '';
    const style = s(d.style) || card?.style || '';
    const greeting = s(d.greeting) || card?.greeting || '';
    const tags = [...new Set(toArr(d.domainTags ?? d.tags).map((t) => t.trim()).filter(Boolean))].join('，');
    const qs = toArr(d.exampleQuestions ?? d.questions).map((t) => t.trim()).filter(Boolean).join('\n') || (card?.exampleQuestions ?? []).join('\n');
    // 完全未识别出任何可用字段：报错并保持原表单，避免把编辑内容清成空白
    if (![name, systemPrompt, role, style, greeting, tags, qs, s(d.model), s(d.apiKey ?? d.api_key), s(d.baseUrl ?? d.base_url)].some((x) => x.length > 0)) {
      setFormImportError('未能识别配置字段：请粘贴智能体配置（name / baseUrl / model / systemPrompt 等），或人设卡（agent_name / persona）');
      return;
    }
    let bind = s(d.petAssetId);
    if (!bind) {
      const pa = d.petAsset as Record<string, unknown> | string | null | undefined;
      bind = typeof pa === 'string' ? pa : pa && typeof pa === 'object' ? s((pa as Record<string, unknown>).id) : '';
    }
    setForm({
      name,
      apiKey: s(d.apiKey ?? d.api_key),
      baseUrl: s(d.baseUrl ?? d.base_url) || (card?.baseUrl ?? '') || 'https://api.openai.com/v1',
      model: s(d.model) || (card?.model ?? ''),
      systemPrompt,
      avatar: s(d.avatar),
      intro: s(d.intro),
      domainTags: tags,
      role,
      style,
      greeting,
      exampleQuestions: qs,
    });
    setBindPetId(bind || (editingId ? bindPetId : ''));
    // 主动能力检测：该 JSON 声明了「主动发起对话 / 定时任务」时，勾选能力并说明（用户可取消）
    const det: CapabilityDetection = detectCapabilities(d);
    if (det.kinds.length) {
      setFormCaps(det.kinds);
      setFormCapSpec(det.spec);
      setFormCapHint(
        `检测到该智能体声明了这些能力${det.reasons.length ? `（${det.reasons.join('；')}）` : ''}，已为你勾选，可在此调整`,
      );
    }
    setFormImportOpen(false);
    setFormImportText('');
    setFormImportError('');
    Alert.alert('已填充', `已导入「${name || '未命名'}」到表单，检查确认后保存即可。`);
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={() => (formOpen ? setFormOpen(false) : onClose())}>
      <View
        style={[
          pm.container,
          { paddingTop: insets.top + 10, paddingBottom: (kbVisible ? kbHeight : insets.bottom) + 6 },
        ]}>
        <View style={pm.header}>
          {formOpen ? (
            // 编辑/新增页：左上角是「返回」，回到智能体选择页而不是直接关闭整个弹层
            <Pressable onPress={() => setFormOpen(false)} hitSlop={8}>
              <Text style={pm.headerBtn}>‹ 返回</Text>
            </Pressable>
          ) : (
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={pm.headerBtn}>关闭</Text>
            </Pressable>
          )}
          <Text style={pm.title}>{formOpen ? (editingId ? '编辑智能体' : '新增智能体') : '智能体管理'}</Text>
          {formOpen ? (
            // 编辑页不显示「新增」，用等宽占位保持标题居中
            <View style={pm.headerBtnSpace} />
          ) : (
            <Pressable onPress={openAdd} hitSlop={8}>
              <Text style={[pm.headerBtn, pm.headerBtnPrimary]}>新增</Text>
            </Pressable>
          )}
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
                <Text style={pm.importTip}>粘贴单个智能体的 JSON / YAML（兼容数组与 profiles / llmProfiles 形状、支持人设卡 agent_name / persona、可带代码块包裹）。字段解析后将直接回填本表单；若含多条配置，请改用列表页的「导入」批量导入。</Text>
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

            {/* ── 朗读音色：默认跟随全局，或指定某个已下载音色（系统/云/GPT-SoVITS）── */}
            <Text style={pm.fieldLabel}>朗读音色</Text>
            <Pressable style={[pm.bindRow, !bindVoiceId && pm.bindRowActive]} onPress={() => setBindVoiceId('')}>
              <Text style={[pm.bindRowName, !bindVoiceId && pm.bindRowNameActive]} numberOfLines={1}>
                默认（跟随设置页的全局音色）
              </Text>
              {!bindVoiceId ? <Text style={pm.bindCheck}>✓</Text> : null}
            </Pressable>
            {downloadedVoices.length === 0 ? (
              <Text style={pm.fieldHint}>还没有已下载的音色，可去抽屉「音色」板块安装；保持默认则所有智能体共用全局音色</Text>
            ) : (
              downloadedVoices.map((v) => {
                const selected = bindVoiceId === v.id;
                const tag = v.config.engine === 'gptsovits' ? 'GPT-SoVITS' : v.config.engine === 'system' ? '系统' : '云';
                return (
                  <Pressable
                    key={v.id}
                    style={[pm.bindRow, selected && pm.bindRowActive]}
                    onPress={() => setBindVoiceId(selected ? '' : v.id)}>
                    <Text style={[pm.bindRowName, selected && pm.bindRowNameActive]} numberOfLines={1}>
                      {v.name}
                    </Text>
                    <Text style={pm.voiceTag}>{tag}</Text>
                    {selected && <Text style={pm.bindCheck}>✓</Text>}
                  </Pressable>
                );
              })
            )}
            <Text style={pm.fieldHint}>该智能体朗读回复时固定用此音色；云 / GPT-SoVITS 音色未配置好或被删除时自动回退全局音色</Text>

            {/* ── 智能体能力（常驻：新增/编辑任何智能体都可设置）── */}
            <Text style={pm.sectionDivider}>智能体能力</Text>
            <Text style={pm.fieldHint}>
              这些能力属于该智能体本身：导入的人设卡若声明了这些能力，导入时会自动勾选并带上它的规格；也可以在这里为任何智能体手动开启或关闭。
            </Text>
            {formCapHint ? <Text style={pm.capHint}>{formCapHint}</Text> : null}
            {(['proactive', 'tasks', 'web', 'weather', 'stock', 'football'] as AgentCapabilityKind[]).map((k) => (
              <View key={k}>
                {k === 'weather' ? (
                  <Text style={[pm.fieldHint, { marginBottom: 8 }]}>
                    以下「天气 / 股票 / 竞彩」是平台免费技能：登录账号即可使用，开启后无需配置任何 Key，由平台服务器代为查询。
                  </Text>
                ) : null}
                <View style={pm.capRow}>
                  <View style={pm.capInfo}>
                    <Text style={pm.capName}>{capabilityLabel(k)}</Text>
                    <Text style={pm.capDesc}>{capabilityDesc(k)}</Text>
                  </View>
                  <Switch
                    value={formCaps.includes(k)}
                    onValueChange={() => toggleFormCap(k)}
                    trackColor={{ false: '#D9D9D9', true: '#4D6BFE' }}
                    thumbColor="#fff"
                    style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
                  />
                </View>
              </View>
            ))}
            {formCaps.includes('web') ? (
              <View style={pm.webBox}>
                <Text style={pm.fieldLabel}>搜索服务</Text>
                <View style={pm.webChips}>
                  {(['bocha', 'serper', 'tavily'] as WebSearchProvider[]).map((p) => {
                    const on = (formCapSpec.web?.provider ?? 'bocha') === p;
                    return (
                      <Pressable key={p} style={[pm.webChip, on && pm.webChipOn]} onPress={() => setWebSpec({ provider: p })}>
                        <Text style={[pm.webChipText, on && pm.webChipTextOn]}>{PROVIDER_LABEL[p]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={pm.fieldLabel}>搜索服务 API Key</Text>
                <TextInput
                  style={pm.webInput}
                  value={formCapSpec.web?.apiKey ?? ''}
                  onChangeText={(v) => setWebSpec({ apiKey: v })}
                  placeholder="粘贴你在该搜索服务申请的 Key"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Text style={pm.fieldLabel}>接口地址（可选，走代理/自建网关时填）</Text>
                <TextInput
                  style={pm.webInput}
                  value={formCapSpec.web?.endpoint ?? ''}
                  onChangeText={(v) => setWebSpec({ endpoint: v })}
                  placeholder="留空使用官方地址"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {!formCapSpec.web?.apiKey?.trim() ? (
                  <Text style={pm.webWarn}>还没填 API Key，联网查询不会生效（它仍可正常聊天）</Text>
                ) : null}
                <Text style={pm.webCost}>{WEB_COST_HINT}</Text>
              </View>
            ) : null}
            {formCaps.includes('proactive') ? (
              <Pressable onPress={cycleCapInterval}>
                <Text style={pm.fieldLabel}>搭话间隔（点击切换）</Text>
                <Text style={pm.capValue}>每 {formCapSpec.intervalMinutes ?? 30} 分钟最多一次</Text>
              </Pressable>
            ) : null}
            {formCaps.includes('proactive') && formCapSpec.wakingHours ? (
              <Text style={pm.fieldHint}>
                搭话时段（该智能体 JSON 声明）：{formCapSpec.wakingHours[0]}:00–{formCapSpec.wakingHours[1]}:00
              </Text>
            ) : null}
            {formCaps.includes('tasks') && formCapSpec.exampleTasks?.length ? (
              <Text style={pm.fieldHint}>它会沿用这些场景表达：{formCapSpec.exampleTasks.slice(0, 3).join('、')}</Text>
            ) : null}

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
                {/* 内容区可滚动、按钮固定在底部：粘贴长 JSON 时输入框不再把按钮顶出屏幕，
                    保证「解析 / 确认导入」始终可见可点（此前按钮被顶到屏幕外且无法滚动到） */}
                <ScrollView style={pm.importScroll} keyboardShouldPersistTaps="handled">
                  <Text style={pm.importTip}>粘贴从本应用或桌面端导出的智能体配置（JSON），或人设卡（agent_name / persona）。按名称合并：同名更新配置，新名称新增为独立智能体。导出文件不包含 API Key，导入后请补全。</Text>
                  <TextInput
                    style={pm.importInput}
                    multiline
                    value={importText}
                    onChangeText={setImportText}
                    placeholder="在此粘贴 JSON…"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {importOutcome ? (
                    <Text style={pm.importPreview}>预览：新增 {importOutcome.added} 个 · 更新 {importOutcome.updated} 个{importOutcome.missingKeys ? ` · 缺密钥 ${importOutcome.missingKeys} 个` : ''}</Text>
                  ) : null}
                </ScrollView>
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
                      {item.capabilities?.enabled?.length ? (
                        <Text style={pm.capBadge}>
                          能力：{item.capabilities.enabled.map((k) => capabilityLabel(k)).join(' / ')}
                        </Text>
                      ) : null}
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
    {/* 导入后能力确认弹层：检测到主动能力的智能体，问用户是否为它添加（默认勾选，可取消） */}
    {capOffers ? (
      <Modal visible transparent animationType="fade" onRequestClose={() => setCapOffers(null)}>
        <Pressable style={pm.modalMask} onPress={() => setCapOffers(null)}>
          <Pressable style={pm.modalCard} onPress={() => undefined}>
            <Text style={pm.modalTitle}>为导入的智能体添加这些能力？</Text>
            {capOffers.map((o) => (
              <View key={o.profileId} style={pm.offerBlock}>
                <Text style={pm.offerName}>{o.name}</Text>
                {o.reasons.length ? (
                  <Text style={pm.fieldHint}>检测到：{o.reasons.join('；')}</Text>
                ) : null}
                {o.kinds.map((k) => (
                  <Pressable key={k} style={pm.capRow} onPress={() => toggleOfferCap(o.profileId, k)}>
                    <View style={pm.capInfo}>
                      <Text style={pm.capName}>{capabilityLabel(k)}</Text>
                      <Text style={pm.capDesc}>{capabilityDesc(k)}</Text>
                    </View>
                    <Text style={(capChecked[o.profileId] ?? []).includes(k) ? pm.offerChecked : pm.offerUnchecked}>
                      {(capChecked[o.profileId] ?? []).includes(k) ? '✓ 添加' : '不添加'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
            <Text style={pm.fieldHint}>这些能力直接合成进该智能体：搭话间隔 / 时段 / 示例任务都沿用它的 JSON 声明，可随时在「编辑」里调整或关闭。</Text>
            {capOffers.some((o) => (capChecked[o.profileId] ?? []).includes('web')) ? (
              <Text style={pm.webWarn}>联网查询还需要在「编辑 → 智能体能力」里填一个搜索服务的 API Key（博查/Serper/Tavily）才会生效。</Text>
            ) : null}
            <View style={pm.modalBtns}>
              <Pressable style={[pm.btn, pm.btnGhost]} onPress={() => setCapOffers(null)}>
                <Text style={pm.btnGhostText}>全部不添加</Text>
              </Pressable>
              <Pressable style={[pm.btn, pm.btnPrimary]} onPress={applyCapabilityOffers}>
                <Text style={pm.btnPrimaryText}>添加选中能力</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    ) : null}
    </>
  );
}

export default function ChatScreen({ onOpenDrawer }: { onOpenDrawer?: () => void }): React.JSX.Element {
  const messages = useAppStore((s) => s.messages);
  const profiles = useAppStore((s) => s.llmProfiles);
  const activeId = useAppStore((s) => s.llmActiveProfileId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [managerVisible, setManagerVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const copyWebRef = useRef<React.ElementRef<typeof WebView>>(null);
  const [copyToast, setCopyToast] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 生成中止控制器：发送/重试时新建，用户点「停止」时 abort（保留已生成内容） */
  const abortRef = useRef<AbortController | null>(null);
  /** 长按气泡操作菜单（复制 / 重新生成），DeepSeek 式长按弹出 */
  const [msgMenuId, setMsgMenuId] = useState<string | null>(null);
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

  // 执行一次助手流式回复：思考阶段单独计时；切后台/网络中断自动重试一次；用户可点「停止」中止
  const runAssistant = async (assistantId: string, history: ChatMsg[], allowRetry: boolean): Promise<void> => {
    setSending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
      }, ctrl.signal);
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
      // 模型建任务：回复末尾的隐藏任务指令（[[TASK|…]]）落库排期，正文剥离后再展示；
      // 排期结果另起一条可见确认（成功/重复/超限都要说清楚，避免「口头答应却没排上」）
      const full = target?.content || content || '';
      const { clean, directives } = extractTaskDirectives(full);
      if (clean !== full) cur.patchMessage(assistantId, { content: clean });
      if (directives.length) {
        const profileId = useAppStore.getState().llmActiveProfileId;
        const userText = [...cleanHistory].reverse().find((m) => m.role === 'user')?.content ?? '';
        // 模型自己已经用它的口吻说清了时间 → 不再补系统口径的确认（用户只看到智能体的话）
        const pending: string[] = [];
        for (const d of directives) {
          const r = await createTaskFromDirective(profileId, d, userText);
          if (!r.ok || !mentionsDue(clean)) pending.push(r.text);
        }
        if (pending.length) {
          useAppStore.getState().appendMessages([
            {
              id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              role: 'assistant',
              content: pending.join('\n'),
            },
          ]);
        }
      }
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
      // 开启朗读时读出回复（错误提示不读；云音色/系统音色由引擎按设置自动选择）
      const st = useAppStore.getState();
      if (st.ttsEnabled) {
        void speakReply(content);
      }
    } catch (e) {
      if (e instanceof AbortedError) {
        // 用户主动停止：保留已生成内容，不标错；若还什么都没生成就整条移除占位
        const cur = useAppStore.getState();
        const target = cur.messages.find((m) => m.id === assistantId);
        const partial = (target?.content ?? '').trim() || (target?.reasoning ?? '').trim();
        if (partial) {
          cur.patchMessage(assistantId, { pending: false, streaming: false });
        } else {
          cur.removeMessage(assistantId);
        }
        return;
      }
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
      abortRef.current = null;
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
    // 宠物定时任务：本地识别「定时提醒 / 到点主动搭话 / 任务管理」指令，
    // 动作由 App 直接落地（不经过模型，离线可用）；回复措辞由该智能体按人设产出，
    // 无 API / 调用失败才回退中性文案（见 petTaskScheduler 的 speak）
    const intent = detectPetIntent(text);
    if (intent) {
      const st0 = useAppStore.getState();
      const assistantId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      st0.appendMessages([
        { role: 'user', content: text },
        { id: assistantId, role: 'assistant', content: '', pending: true, streaming: false },
      ]);
      setSending(true);
      followRef.current = true;
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
      try {
        const reply = await handlePetIntent(intent, st0.llmActiveProfileId);
        useAppStore.getState().patchMessage(assistantId, { content: reply, pending: false, streaming: false });
      } catch (e) {
        useAppStore.getState().patchMessage(assistantId, {
          content: `出错了：${e instanceof Error ? e.message : String(e)}`,
          pending: false,
          streaming: false,
          error: true,
        });
      } finally {
        setSending(false);
        scheduleUpload('chat_history');
      }
      return;
    }
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
      stopAllVoice();
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

  /** 重新生成：以该 AI 消息之前的历史重新请求（与点错误气泡重试同逻辑，供长按菜单调用） */
  const regenerateMsg = (id: string): void => {
    setMsgMenuId(null);
    retryMsg(id);
  };

  /** 长按气泡菜单：当前选中的消息 */
  const menuMsg = msgMenuId ? messages.find((m) => m.id === msgMenuId) ?? null : null;
  /** 重新生成只对该条 AI 回复有意义（取其之前的历史重问一次） */
  const menuCanRegenerate = !!menuMsg && menuMsg.role === 'assistant' && !menuMsg.pending && !sending;

  const canSend = !!input.trim() && !sending;

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
        renderItem={({ item }) => item.id ? <Bubble msg={item} onRetry={() => retryMsg(item.id!)} onCopy={copyText} onLongPress={(m) => setMsgMenuId(m.id ?? null)} /> : <Bubble msg={item} onRetry={() => undefined} onCopy={copyText} />}
        ListEmptyComponent={
          // 空会话开场（DeepSeek 式）：智能体欢迎语 + 示例问题快捷按钮，点击即发送。
          // inverted 列表的空态会整体颠倒，需 scaleY 翻转回来
          <View style={styles.emptyWrap}>
            <Text style={styles.empty}>
              {profile?.greeting?.trim() || `和${profile?.name ?? '宠物'}聊点什么吧`}
            </Text>
            {(profile?.exampleQuestions ?? []).slice(0, 4).map((q) => (
              <Pressable
                key={q}
                style={styles.exampleQ}
                onPress={() => void send(q)}
                disabled={sending}>
                <Text style={styles.exampleQText}>{q}</Text>
              </Pressable>
            ))}
          </View>
        }
        // 微信式跟随：贴底(offset<60)时内容增长自动滚到最新；上滑看历史则暂停跟随，滑回底部自动恢复
        onScroll={(e) => { followRef.current = e.nativeEvent.contentOffset.y < 60; }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (followRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
      />

      {/* 隐藏复制引擎：1×1 WebView 提供剪贴板写入（execCommand('copy')），支持代码块/链接一键复制。
          必须包在绝对定位的 1×1 宿主里：WebView 自身设 position:absolute 在 Fabric 下不生效，
          会按流式布局占据大半屏，把聊天列表挤成上半屏、下方留出一大片空白 */}
      <View style={styles.hiddenWebHost} pointerEvents="none">
        <WebView
          ref={copyWebRef}
          style={styles.hiddenWeb}
          originWhitelist={['*']}
          javaScriptEnabled
          onError={() => undefined}
          source={{ html: COPY_HTML }}
        />
      </View>
      {copyToast && (
        <View style={styles.copyToast} pointerEvents="none">
          <Text style={styles.copyToastText}>已复制</Text>
        </View>
      )}

      {/* Trae 式输入卡：大圆角灰卡内含输入框与工具行（模型 chip / 按住说话 / 圆形发送钮）。
          底部留白严格由键盘真实可见性驱动（kbVisible 经原生 IME 状态看门狗校正），
          键盘收起时立即归零，绝不残留大 padding 把聊天区顶上去、下方留出点不动的空白 */}
      <View style={[styles.inputWrap, { paddingBottom: kbVisible ? kbHeight : insets.bottom + 6 }]}>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.input}
            placeholder={configured ? '发消息，或按住麦克风说话…' : '先创建 API 档案'}
            placeholderTextColor="#B2B2B2"
            value={input}
            onChangeText={setInput}
            multiline
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
            {sending ? (
              // 生成中：发送钮变为停止钮（DeepSeek 式），点击中止并保留已生成内容
              <Pressable
                style={[styles.sendCircle, styles.stopCircle]}
                onPress={() => abortRef.current?.abort()}
                hitSlop={4}>
                <Text style={styles.stopIcon}>■</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.sendCircle, !canSend && styles.sendCircleDisabled]}
                onPress={() => void send()}
                disabled={!canSend}
                hitSlop={4}>
                <Text style={styles.sendIcon}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* 长按气泡操作菜单（DeepSeek 式）：复制全文 / 重新生成（仅 AI 回复） */}
      <Modal transparent animationType="fade" visible={!!menuMsg} onRequestClose={() => setMsgMenuId(null)}>
        <Pressable style={styles.msgMenuMask} onPress={() => setMsgMenuId(null)}>
          <View style={styles.msgMenuCard}>
            <Pressable
              style={styles.msgMenuItem}
              onPress={() => {
                if (menuMsg) copyText(menuMsg.role === 'assistant' ? stripTaskMarkers(menuMsg.content ?? '') : menuMsg.content ?? '');
                setMsgMenuId(null);
              }}>
              <Text style={styles.msgMenuText}>复制</Text>
            </Pressable>
            {menuCanRegenerate && (
              <Pressable style={styles.msgMenuItem} onPress={() => menuMsg?.id && regenerateMsg(menuMsg.id)}>
                <Text style={styles.msgMenuText}>重新生成</Text>
              </Pressable>
            )}
            <Pressable style={styles.msgMenuItem} onPress={() => setMsgMenuId(null)}>
              <Text style={[styles.msgMenuText, styles.msgMenuCancel]}>取消</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

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
  // 空会话开场（inverted 列表需 scaleY 翻转）
  emptyWrap: { transform: [{ scaleY: -1 }], alignItems: 'center', paddingHorizontal: 24 },
  exampleQ: { backgroundColor: '#F2F3F5', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, marginTop: 10, alignSelf: 'stretch' },
  exampleQText: { fontSize: 13, color: '#4B4B4B', textAlign: 'center' },
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
  // 生成中的停止钮（DeepSeek 式）：深色方块
  stopCircle: { backgroundColor: '#1A1A1A' },
  stopIcon: { fontSize: 12, color: '#FFFFFF', fontWeight: '700' },
  // 长按气泡操作菜单
  msgMenuMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 48 },
  msgMenuCard: { backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  msgMenuItem: { paddingVertical: 13, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  msgMenuText: { fontSize: 15, color: '#1A1A1A' },
  msgMenuCancel: { color: '#999' },
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
  // 宿主容器负责脱离布局流（绝对定位 + 1×1 + 裁剪），WebView 只负责填满宿主
  hiddenWebHost: { position: 'absolute', width: 1, height: 1, left: -1000, top: 0, overflow: 'hidden' },
  hiddenWeb: { width: 1, height: 1, opacity: 0 },
  copyToast: { position: 'absolute', alignSelf: 'center', bottom: 130, backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  copyToastText: { color: '#fff', fontSize: 13 },
});

const pm = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  title: { fontSize: 16, fontWeight: '700', color: '#333' },
  headerBtn: { fontSize: 14, color: '#666', paddingHorizontal: 4 },
  headerBtnPrimary: { color: '#1C6EF2', fontWeight: '600' },
  headerBtnSpace: { width: 36 },
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
  // 联网查询配置（智能体能力 → web）
  webBox: { borderWidth: 1, borderColor: '#E6EAF2', backgroundColor: '#FAFBFE', borderRadius: 10, paddingHorizontal: 10, paddingBottom: 10, marginTop: 6 },
  webChips: { flexDirection: 'row', flexWrap: 'wrap' },
  webChip: { borderRadius: 14, borderWidth: 1, borderColor: '#DDD', paddingHorizontal: 12, paddingVertical: 5, marginRight: 8, marginBottom: 6, backgroundColor: '#fff' },
  webChipOn: { backgroundColor: '#E8EDFB', borderColor: '#4D6BFE' },
  webChipText: { fontSize: 12, color: '#666' },
  webChipTextOn: { color: '#4D6BFE', fontWeight: '600' },
  webInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, backgroundColor: '#fff' },
  webWarn: { fontSize: 12, color: '#B54708', marginTop: 8, lineHeight: 17 },
  webCost: { fontSize: 11, color: '#AAA', marginTop: 8, lineHeight: 16 },
  bindRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  bindRowActive: { backgroundColor: '#F0F6FF', borderRadius: 8, paddingHorizontal: 8, marginHorizontal: -8 },
  bindRowName: { fontSize: 14, color: '#1A1A1A', flex: 1, marginRight: 8 },
  bindRowNameActive: { color: '#4D6BFE', fontWeight: '600' },
  bindCheck: { fontSize: 16, color: '#4D6BFE', fontWeight: '600' },
  voiceTag: { fontSize: 11, color: '#8A8F99', backgroundColor: '#F2F3F6', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginRight: 8, overflow: 'hidden' },
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
  importScroll: { flex: 1 },
  importTip: { fontSize: 12, color: '#888', lineHeight: 18, marginBottom: 10 },
  importInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, minHeight: 180, maxHeight: 300, textAlignVertical: 'top', marginBottom: 12, backgroundColor: '#FAFAFA' },
  importBtns: { flexDirection: 'row', marginBottom: 10 },
  importPreview: { fontSize: 12, color: '#4D6BFE', fontWeight: '500' },
  formSectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  importFormBtn: { fontSize: 13, color: '#1C6EF2', fontWeight: '600' },
  importError: { fontSize: 12, color: '#E5484D', marginBottom: 8 },
  sectionDivider: { fontSize: 14, fontWeight: '700', color: '#333', marginTop: 18, marginBottom: 6 },
  // 多智能体徽标（历史数据：档案里仍可能带编排配置，列表上如实标注其运行模式）
  multiBadge: { fontSize: 10, color: '#8B3DFF', backgroundColor: '#F3E8FF', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', alignSelf: 'flex-start', marginTop: 3 },
  // ── 主动能力（常驻表单区块 / 导入能力确认弹层）──
  capHint: { fontSize: 12, color: '#1A7F37', lineHeight: 17, marginBottom: 6 },
  capRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  capInfo: { flex: 1, paddingRight: 10 },
  capName: { fontSize: 13, fontWeight: '600', color: '#1A1A1A' },
  capDesc: { fontSize: 11, color: '#999', marginTop: 2, lineHeight: 15 },
  capValue: { fontSize: 13, color: '#4D6BFE', marginBottom: 4 },
  capBadge: { fontSize: 10, color: '#1A7F37', backgroundColor: '#E6F7EC', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', alignSelf: 'flex-start', marginTop: 3 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 14, padding: 16, maxHeight: '80%' },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#1A1A1A', marginBottom: 8 },
  modalBtns: { flexDirection: 'row', marginTop: 12 },
  offerBlock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#EEE', paddingTop: 8, marginTop: 8 },
  offerName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  offerChecked: { fontSize: 12, color: '#1A7F37', fontWeight: '600' },
  offerUnchecked: { fontSize: 12, color: '#999' },
});
