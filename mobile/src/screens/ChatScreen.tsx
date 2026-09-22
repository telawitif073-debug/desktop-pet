/** 聊天页：直连用户 LLM 档案（云同步），流式输出（思考过程逐字可见）；含档案管理与清空确认 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
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
import { isConfigured, streamChat } from '../chat/llm';
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

/** 「正在思考」过渡提示：动态省略号 */
function ThinkingDots(): React.JSX.Element {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v + 1) % 4), 450);
    return () => clearInterval(t);
  }, []);
  return (
    <Text style={styles.thinkingText}>
      正在思考{'.'.repeat(n)}
    </Text>
  );
}

/** 头像：微信式略圆角方块，自己绿色「我」，助手用宠物名首字（蓝色底） */
function Avatar({ mine, petName }: { mine: boolean; petName: string }): React.JSX.Element {
  return (
    <View style={[styles.avatar, mine ? styles.avatarMine : styles.avatarTheirs]}>
      <Text style={styles.avatarText}>{mine ? '我' : (petName.trim()[0] ?? '宠')}</Text>
    </View>
  );
}

/** 时间分割线：与上一条间隔 ≥5 分钟时居中显示（格式参考微信：今天只显时分，更早带日期） */
function TimeSeparator({ ts }: { ts: number }): React.JSX.Element | null {
  const d = new Date(ts);
  const now = new Date();
  const pad = (v: number): string => String(v).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const label = sameDay ? hm : yesterday ? `昨天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return (
    <View style={styles.timeRow}>
      <Text style={styles.timeText}>{label}</Text>
    </View>
  );
}

function Bubble({ msg }: { msg: ChatMsg }): React.JSX.Element {
  const mine = msg.role === 'user';
  const petName = useAppStore((s) => s.petName);
  if (mine) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
        <View style={[styles.bubble, styles.bubbleMine]}>
          <Text style={styles.bubbleTextMine}>{msg.content}</Text>
        </View>
        <View style={[styles.triangle, styles.triangleMine]} />
        <Avatar mine petName={petName} />
      </View>
    );
  }
  // 助手：头像在左，气泡带指向头像的小三角；内含思考卡片 + 正文
  const showDots = msg.pending && !msg.reasoning && !msg.content;
  return (
    <View style={styles.bubbleRow}>
      <Avatar mine={false} petName={petName} />
      <View style={[styles.triangle, styles.triangleTheirs]} />
      <View style={[styles.bubble, styles.bubbleTheirs]}>
        {showDots && <ThinkingDots />}
        {!!msg.reasoning && (
          <ThinkCard reasoning={msg.reasoning} seconds={msg.thinkSeconds} streaming={msg.streaming} />
        )}
        {!!msg.content && (
          <Text style={[styles.bubbleText, !!msg.reasoning && styles.contentAfterThink]}>
            {msg.content}
            {msg.streaming ? ' ▍' : ''}
          </Text>
        )}
      </View>
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

export default function ChatScreen(): React.JSX.Element {
  const messages = useAppStore((s) => s.messages);
  const profiles = useAppStore((s) => s.llmProfiles);
  const activeId = useAppStore((s) => s.llmActiveProfileId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [managerVisible, setManagerVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => undefined);
  const initialScrollDone = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();

  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  const configured = isConfigured();

  // 内容更新（含流式逐字）时节流滚到底部
  useEffect(() => {
    if (!messages.length) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 120);
    return () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, [messages]);

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

  const send = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? input).trim();
    if (!text || sending) return;
    setInput('');
    const store0 = useAppStore.getState();
    const history: ChatMsg[] = [...store0.messages, { role: 'user', content: text }];
    const assistantId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    store0.appendMessages([
      { role: 'user', content: text, ts: startedAt },
      { id: assistantId, role: 'assistant', content: '', pending: true, ts: Date.now() },
    ]);
    setSending(true);
    try {
      const { content, reasoning } = await streamChat(history, {
        onReasoning: (d) =>
          useAppStore.getState().appendMessageChunk(assistantId, { reasoningDelta: d }),
        onContent: (d) =>
          useAppStore.getState().appendMessageChunk(assistantId, { contentDelta: d }),
      });
      const thinkSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      // 非流式降级路径不会产生增量：用最终结果回填
      const cur = useAppStore.getState();
      const target = cur.messages.find((m) => m.id === assistantId);
      const patch: Partial<ChatMsg> = {
        pending: false,
        streaming: false,
        thinkSeconds,
      };
      if (!target?.content && content) patch.content = content;
      if (!target?.reasoning && reasoning) patch.reasoning = reasoning;
      cur.patchMessage(assistantId, patch);
      // 开启朗读时读出回复（错误提示不读，带音色/语速/音调设置）
      const st = useAppStore.getState();
      if (st.ttsEnabled) {
        void speak(content, { rate: st.speechRate, pitch: st.speechPitch, voice: st.speechVoice || undefined });
      }
    } catch (e) {
      useAppStore.getState().patchMessage(assistantId, {
        pending: false,
        streaming: false,
        content: `出错了：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSending(false);
      scheduleUpload('chat_history');
    }
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
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Pressable style={styles.headerLeft} onPress={() => setManagerVisible(true)} hitSlop={6}>
          <Text style={styles.headerText} numberOfLines={1}>
            {configured ? `${profile?.name ?? 'API'} · ${profile?.model ?? ''}` : '未配置聊天 API，点此管理档案'}
          </Text>
        </Pressable>
        <Pressable onPress={confirmClear} hitSlop={12} disabled={!messages.length}>
          <Text style={[styles.headerAction, !messages.length && styles.headerActionDisabled]}>清空</Text>
        </Pressable>
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
        data={messages}
        keyExtractor={(m, i) => m.id ?? String(i)}
        renderItem={({ item, index }) => {
          // 微信式时间分割线：首条带时间，或与上一条间隔 ≥5 分钟
          const prev = index > 0 ? messages[index - 1] : null;
          const showTime = !!item.ts && (!prev?.ts || item.ts - prev.ts >= 5 * 60 * 1000);
          return (
            <>
              {showTime && item.ts != null && <TimeSeparator ts={item.ts} />}
              <Bubble msg={item} />
            </>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>和宠物聊点什么吧</Text>}
        onContentSizeChange={() => {
          // 首次内容布局完成后才定位到最后一条对话（scrollToEnd 在布局未完成时调用会静默失效）
          if (initialScrollDone.current) return;
          initialScrollDone.current = true;
          listRef.current?.scrollToEnd({ animated: false });
        }}
      />

      {/* 输入栏：键盘弹起时底部留白=键盘高度（微信式始终可见），收起时留安全区 */}
      <View style={[styles.inputWrap, { paddingBottom: kbHeight > 0 ? kbHeight : insets.bottom }]}>
        <View style={styles.inputRow}>
          <Pressable
            style={[styles.mic, listening && styles.micActive]}
            onPressIn={() => void micPressIn()}
            onPressOut={micPressOut}>
            <Text style={styles.micText}>{listening ? '松开' : '按住'}</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder={configured ? '说点什么…' : '先创建 API 档案'}
            placeholderTextColor="#B2B2B2"
            value={input}
            onChangeText={setInput}
            multiline
          />
          <Pressable
            style={styles.sendTextBtn}
            onPress={() => void send()}
            disabled={!canSend}
            hitSlop={6}>
            <Text style={[styles.sendText, !canSend && styles.sendTextDisabled]}>发送</Text>
          </Pressable>
        </View>
      </View>

      <ProfileManager visible={managerVisible} onClose={() => setManagerVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#EDEDED' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#F7F7F7', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#E0E0E0' },
  headerLeft: { flex: 1, marginRight: 10 },
  headerText: { fontSize: 12, color: '#888' },
  headerAction: { fontSize: 13, color: '#1C6EF2' },
  headerActionDisabled: { color: '#CCC' },
  guide: { backgroundColor: '#FFF7E6', margin: 12, marginBottom: 0, borderRadius: 8, padding: 10 },
  guideText: { color: '#9A6B00', fontSize: 12, lineHeight: 18 },
  list: { flex: 1, paddingHorizontal: 12 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  bubbleRow: { flexDirection: 'row', marginVertical: 5, alignItems: 'flex-start' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '76%', borderRadius: 6, paddingVertical: 9, paddingHorizontal: 12 },
  // 微信式：我方绿色气泡右侧，对方白色气泡左侧（带边框在灰底上有区分），小三角指向头像
  bubbleMine: { backgroundColor: '#95EC66', marginRight: 5 },
  bubbleTheirs: { backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: '#DCDCDC', marginLeft: 5 },
  // 气泡小三角（与气泡同色）
  triangle: { width: 0, height: 0, marginTop: 12, backgroundColor: 'transparent', borderTopWidth: 5, borderBottomWidth: 5 },
  triangleMine: { borderLeftWidth: 7, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: '#95EC66' },
  triangleTheirs: { borderRightWidth: 7, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderRightColor: '#FFFFFF' },
  // 头像（微信式略圆角方块）
  avatar: { width: 40, height: 40, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  avatarMine: { backgroundColor: '#07C160' },
  avatarTheirs: { backgroundColor: '#4A90D9' },
  avatarText: { fontSize: 16, color: '#fff', fontWeight: '600' },
  // 时间分割线（微信式居中灰底）
  timeRow: { alignSelf: 'center', backgroundColor: '#DADADA', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginTop: 8, marginBottom: 4 },
  timeText: { fontSize: 12, color: '#FFFFFF' },
  bubbleText: { fontSize: 16, lineHeight: 22, color: '#181818' },
  bubbleTextMine: { fontSize: 16, lineHeight: 22, color: '#181818' },
  thinkingText: { fontSize: 15, color: '#999' },
  // 思考卡片
  thinkCard: { backgroundColor: '#F7F8FA', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: StyleSheet.hairlineWidth, borderColor: '#ECECEC' },
  thinkHeader: { flexDirection: 'row', alignItems: 'center' },
  thinkTitle: { fontSize: 13, fontWeight: '600', color: '#5F6368', flex: 1 },
  thinkChevron: { fontSize: 12, color: '#AAA', marginLeft: 6 },
  thinkBody: { fontSize: 12.5, lineHeight: 20, color: '#6B6B6B', marginTop: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#E5E5E5', paddingTop: 7 },
  contentAfterThink: { marginTop: 9 },
  // 微信式输入栏
  inputWrap: { backgroundColor: '#F7F7F7', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#DCDCDC' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 8, paddingTop: 7 },
  mic: { backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: '#DCDCDC', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 9, marginRight: 7 },
  micActive: { backgroundColor: '#FDE2E2', borderColor: '#E5484D' },
  micText: { fontSize: 13, color: '#555' },
  input: { flex: 1, minHeight: 38, maxHeight: 100, backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: '#DCDCDC', borderRadius: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, fontSize: 16, textAlignVertical: 'center' },
  sendTextBtn: { marginLeft: 7, paddingHorizontal: 6, paddingVertical: 9 },
  sendText: { fontSize: 16, color: '#07C160', fontWeight: '600' },
  sendTextDisabled: { color: '#BBBBBB', fontWeight: '400' },
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
