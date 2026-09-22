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
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isConfigured, streamChat, StreamInterruptError } from '../chat/llm';
import { scheduleUpload } from '../api/sync';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { isSpeechAvailable, speak, startListening, stopListening, stopSpeak, subscribeVoice } from '../native/Voice';
import type { ChatMsg, LlmProfile } from '../types';

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

function Bubble({ msg, onRetry }: { msg: ChatMsg; onRetry: () => void }): React.JSX.Element {
  const showThinking = useAppStore((s) => s.showThinking);
  const mine = msg.role === 'user';
  if (mine) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
        <View style={[styles.bubble, styles.bubbleMine]}>
          <Text style={styles.bubbleTextMine}>{msg.content}</Text>
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
          {hasContent && msg.content && (
            <Text
              style={[
                msg.error ? styles.bubbleError : styles.bubbleText,
                hasReasoning && !msg.error && styles.contentAfterThink,
              ]}>
              {msg.content}
              {msg.streaming && !msg.error ? ' ▍' : ''}
            </Text>
          )}
          {msg.error && <Text style={styles.retryHint}>点此重试</Text>}
        </Pressable>
      )}
    </View>
  );
}

/** 空表单模板 */
function emptyForm(): { name: string; apiKey: string; baseUrl: string; model: string; systemPrompt: string } {
  return { name: '', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: '', systemPrompt: '' };
}

/** API 档案管理：列表切换 / 新增 / 编辑 / 删除，保存后云同步到桌面端 */
function ProfileManager({ visible, onClose }: { visible: boolean; onClose: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const profiles = useAppStore((s) => s.llmProfiles);
  const activeId = useAppStore((s) => s.llmActiveProfileId);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState(emptyForm());

  const openAdd = (): void => {
    setEditingId('');
    setForm(emptyForm());
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
    });
    setFormOpen(true);
  };

  const save = (): void => {
    const name = form.name.trim() || '未命名档案';
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (!baseUrl || !model) {
      Alert.alert('信息不全', '接口地址与模型为必填项');
      return;
    }
    const store = useAppStore.getState();
    if (editingId) {
      const next = store.llmProfiles.map((p) =>
        p.id === editingId ? { ...p, name, apiKey: form.apiKey.trim(), baseUrl, model, systemPrompt: form.systemPrompt.trim() } : p,
      );
      store.patch({ llmProfiles: next });
    } else {
      const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const profile: LlmProfile = { id, name, apiKey: form.apiKey.trim(), baseUrl, model, systemPrompt: form.systemPrompt.trim() };
      store.patch({ llmProfiles: [...store.llmProfiles, profile], llmActiveProfileId: id });
    }
    scheduleUpload('config');
    setFormOpen(false);
  };

  const remove = (p: LlmProfile): void => {
    Alert.alert('删除档案', `确定删除「${p.name}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const store = useAppStore.getState();
          const next = store.llmProfiles.filter((x) => x.id !== p.id);
          // 删除当前档案时自动切到剩余第一个（与桌面端一致）
          store.patch({
            llmProfiles: next,
            llmActiveProfileId: store.llmActiveProfileId === p.id ? next[0]?.id ?? '' : store.llmActiveProfileId,
          });
          scheduleUpload('config');
        },
      },
    ]);
  };

  const switchTo = (id: string): void => {
    useAppStore.getState().patch({ llmActiveProfileId: id });
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
        placeholder={key === 'baseUrl' ? 'https://api.openai.com/v1' : key === 'model' ? 'gpt-4o-mini / glm-4-flash …' : undefined}
        multiline={key === 'systemPrompt'}
      />
    </>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          pm.container,
          { paddingTop: insets.top + 10, paddingBottom: (kbHeight > 0 ? kbHeight : insets.bottom) + 6 },
        ]}>
        <View style={pm.header}>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={pm.headerBtn}>关闭</Text>
          </Pressable>
          <Text style={pm.title}>API 档案管理</Text>
          <Pressable onPress={openAdd} hitSlop={8}>
            <Text style={[pm.headerBtn, pm.headerBtnPrimary]}>新增</Text>
          </Pressable>
        </View>

        {formOpen ? (
          <ScrollView style={pm.form} keyboardShouldPersistTaps="handled">
            {field('名称', 'name')}
            {field('API Key', 'apiKey', true)}
            {field('接口地址', 'baseUrl')}
            {field('模型', 'model')}
            {field('系统提示词（可选）', 'systemPrompt')}
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
          <FlatList
            style={pm.list}
            data={profiles}
            keyExtractor={(p) => p.id}
            ListEmptyComponent={<Text style={pm.empty}>还没有档案，点右上角「新增」创建一个</Text>}
            renderItem={({ item }) => {
              const active = item.id === activeId;
              return (
                <Pressable style={[pm.row, active && pm.rowActive]} onPress={() => switchTo(item.id)}>
                  <View style={{ flex: 1 }}>
                    <Text style={pm.rowName}>
                      {item.name}
                      {active ? '（当前）' : ''}
                    </Text>
                    <Text style={pm.rowSub}>{item.model || '未设置模型'}</Text>
                  </View>
                  <Pressable style={pm.rowBtn} onPress={() => openEdit(item)} hitSlop={6}>
                    <Text style={pm.rowBtnText}>编辑</Text>
                  </Pressable>
                  <Pressable style={pm.rowBtn} onPress={() => remove(item)} hitSlop={6}>
                    <Text style={[pm.rowBtnText, pm.rowBtnDanger]}>删除</Text>
                  </Pressable>
                </Pressable>
              );
            }}
          />
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
  const [sending, setSending] = useState(false);
  const [managerVisible, setManagerVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => undefined);
  // 微信式贴底跟随：流式输出/新消息时自动滚到最新；用户上滑看历史则暂停，滑回底部自动恢复
  const followRef = useRef(true);
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();

  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  const configured = isConfigured();

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

  const send = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? input).trim();
    if (!text || sending) return;
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
            {configured ? profile?.name ?? 'API' : '未配置聊天 API'}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {configured ? profile?.model ?? '' : '点此管理档案'}
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
        renderItem={({ item }) => item.id ? <Bubble msg={item} onRetry={() => retryMsg(item.id!)} /> : <Bubble msg={item} onRetry={() => undefined} />}
        ListEmptyComponent={<Text style={styles.empty}>和宠物聊点什么吧</Text>}
        // 微信式跟随：贴底(offset<60)时内容增长自动滚到最新；上滑看历史则暂停跟随，滑回底部自动恢复
        onScroll={(e) => { followRef.current = e.nativeEvent.contentOffset.y < 60; }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (followRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
      />

      {/* Trae 式输入卡：大圆角灰卡内含输入框与工具行（模型 chip / 按住说话 / 圆形发送钮） */}
      <View style={[styles.inputWrap, { paddingBottom: kbHeight > 0 ? kbHeight : insets.bottom + 6 }]}>
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FFFFFF', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#F0F0F0' },
  headerSideLeft: { flex: 1, alignItems: 'flex-start' },
  headerSideRight: { flex: 1, alignItems: 'flex-end' },
  burger: { width: 26, height: 22, justifyContent: 'center', gap: 5, alignItems: 'flex-start' },
  burgerLine: { width: 20, height: 2, borderRadius: 1, backgroundColor: '#333' },
  headerCenter: { flex: 5, alignItems: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  headerSub: { fontSize: 11, color: '#999', marginTop: 1 },
  headerAction: { fontSize: 13, color: '#1C6EF2' },
  headerActionDisabled: { color: '#CCC' },
  guide: { backgroundColor: '#FFF7E6', margin: 12, marginBottom: 0, borderRadius: 12, padding: 10 },
  guideText: { color: '#9A6B00', fontSize: 12, lineHeight: 18 },
  list: { flex: 1, paddingHorizontal: 14 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  bubbleRow: { flexDirection: 'row', marginVertical: 5 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '86%', borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  // Trae 式：双方均为浅灰圆角卡（无尖角无描边），靠左右对齐区分；我方灰度略深
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
  inputWrap: { backgroundColor: '#FFFFFF', paddingTop: 6 },
  inputCard: { backgroundColor: '#F2F3F5', borderRadius: 22, marginHorizontal: 10, paddingHorizontal: 14, paddingTop: 4, paddingBottom: 8 },
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
});

const pm = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  title: { fontSize: 16, fontWeight: '700', color: '#333' },
  headerBtn: { fontSize: 14, color: '#666', paddingHorizontal: 4 },
  headerBtnPrimary: { color: '#1C6EF2', fontWeight: '600' },
  list: { flex: 1, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F7F8FA', borderRadius: 10, padding: 12, marginBottom: 8 },
  rowActive: { borderWidth: 1.5, borderColor: '#1C6EF2', backgroundColor: '#F0F6FF' },
  rowName: { fontSize: 14, fontWeight: '600', color: '#333' },
  rowSub: { fontSize: 12, color: '#999', marginTop: 2 },
  rowBtn: { marginLeft: 12, paddingHorizontal: 6, paddingVertical: 4 },
  rowBtnText: { fontSize: 13, color: '#1C6EF2' },
  rowBtnDanger: { color: '#E5484D' },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  form: { flex: 1, padding: 14 },
  fieldLabel: { fontSize: 12, color: '#888', marginTop: 10, marginBottom: 4 },
  field: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, minHeight: 40, textAlignVertical: 'top' },
  formBtns: { flexDirection: 'row', marginTop: 18, marginBottom: 30 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: '#DDD', marginRight: 10 },
  btnGhostText: { color: '#666', fontSize: 14 },
  btnPrimary: { backgroundColor: '#1C6EF2' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 11, color: '#AAA', padding: 12, paddingBottom: 20, textAlign: 'center' },
});
