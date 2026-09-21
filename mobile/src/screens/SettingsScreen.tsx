/** 设置页：账号、服务器地址、同步、语音朗读、悬浮窗宠物开关 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { flushAllOnQuit } from '../api/sync';
import { useAppStore } from '../store/appStore';
import { listVoices, speak } from '../native/Voice';
import { APP_VERSION_NAME, checkAppUpdate } from '../update/checkUpdate';
import {
  checkOverlayPermission,
  isOverlaySupported,
  requestOverlayPermission,
  startOverlay,
  stopOverlay,
} from '../native/OverlayPet';

/** 步进调节行（语速/音调） */
function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}): React.JSX.Element {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.row}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          style={styles.stepperBtn}
          onPress={() => onChange(Math.max(min, Math.round((value - step) * 100) / 100))}
          disabled={value <= min}>
          <Text style={[styles.stepperBtnText, value <= min && { color: '#CCC' }]}>－</Text>
        </Pressable>
        <Text style={styles.stepperVal}>{value.toFixed(1)}x</Text>
        <Pressable
          style={styles.stepperBtn}
          onPress={() => onChange(Math.min(max, Math.round((value + step) * 100) / 100))}
          disabled={value >= max}>
          <Text style={[styles.stepperBtnText, value >= max && { color: '#CCC' }]}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function SettingsScreen(): React.JSX.Element {
  const user = useAppStore((s) => s.user);
  const insets = useSafeAreaInsets();
  const baseUrl = useAppStore((s) => s.baseUrl);
  const llmCount = useAppStore((s) => s.llmProfiles.length);
  const installedAgentName = useAppStore((s) => s.installedAgent?.name);
  const petAsset = useAppStore((s) => s.petAsset);
  const overlayEnabled = useAppStore((s) => s.overlayEnabled);
  const setOverlayEnabled = useAppStore((s) => s.setOverlayEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);
  const setTtsEnabled = useAppStore((s) => s.setTtsEnabled);
  const petName = useAppStore((s) => s.petName);
  const userNickname = useAppStore((s) => s.userNickname);
  const showThinking = useAppStore((s) => s.showThinking);
  const thinkingLang = useAppStore((s) => s.thinkingLang);
  const speechRate = useAppStore((s) => s.speechRate);
  const speechPitch = useAppStore((s) => s.speechPitch);
  const speechVoice = useAppStore((s) => s.speechVoice);
  const chatClearConfirm = useAppStore((s) => s.chatClearConfirm);

  const [url, setUrl] = useState(baseUrl);
  const [overlay, setOverlay] = useState(overlayEnabled);
  const [tts, setTts] = useState(ttsEnabled);
  const [name, setName] = useState(petName);
  const [nick, setNick] = useState(userNickname);
  const [busy, setBusy] = useState(false);
  const [voiceModal, setVoiceModal] = useState(false);
  const [voices, setVoices] = useState<Array<{ name: string; label: string }>>([]);

  // 宠物名字改动后同步输入框显示
  useEffect(() => {
    setName(petName);
  }, [petName]);

  useEffect(() => {
    setNick(userNickname);
  }, [userNickname]);

  // 进设置页时刷新开关显示（权限可能在系统设置中被收回）
  useEffect(() => {
    setOverlay(overlayEnabled);
  }, [overlayEnabled]);

  useEffect(() => {
    setTts(ttsEnabled);
  }, [ttsEnabled]);

  const overlaySupported = isOverlaySupported();
  const overlayHint = !overlaySupported
    ? Platform.OS === 'ios'
      ? 'iOS 系统不支持悬浮窗，请使用 App 内形态'
      : '当前环境不支持悬浮窗功能'
    : '开启后宠物会显示在其他应用上方，可拖动到任意位置；关闭即移除';

  const saveUrl = async (): Promise<void> => {
    const cleaned = url.replace(/\s+/g, '');
    if (!/^https?:\/\//i.test(cleaned)) {
      Alert.alert('地址无效', '需要以 http:// 或 https:// 开头');
      return;
    }
    setUrl(cleaned);
    useAppStore.getState().setBaseUrl(cleaned);
    // 保存后立即验证连通性，当场发现拼错/网络不通
    try {
      const res = await fetch(`${cleaned.replace(/\/$/, '')}/app-update`);
      Alert.alert('已保存', res.ok ? '服务器地址已更新，连接正常' : `已保存，但服务器返回 ${res.status}`);
    } catch {
      Alert.alert('已保存，但连不上服务器', '请检查地址拼写与手机网络（用局域网地址时手机需和电脑连同一 Wi-Fi）');
    }
  };

  const syncNow = (): void => {
    flushAllOnQuit();
    Alert.alert('已同步', '本地变更已上传到平台');
  };

  const logout = (): void => {
    useAppStore.getState().logout();
  };

  const toggleOverlay = useCallback(
    async (next: boolean) => {
      if (busy) return;
      if (!next) {
        setBusy(true);
        try {
          await stopOverlay();
          setOverlayEnabled(false);
          setOverlay(false);
        } catch (e) {
          Alert.alert('关闭失败', e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      // 开启流程：检查权限 → 缺则引导授权 → 真正启动服务
      setBusy(true);
      try {
        const granted = await checkOverlayPermission();
        if (!granted) {
          Alert.alert(
            '需要悬浮窗权限',
            '请在接下来的系统设置中为本应用开启「显示在其他应用上层」权限，开启后回到本应用再次打开开关',
            [
              { text: '取消', style: 'cancel' },
              {
                text: '去授权',
                onPress: () => {
                  void requestOverlayPermission().catch(() => undefined);
                },
              },
            ],
          );
          setOverlay(false);
          return;
        }
        await startOverlay(petAsset);
        setOverlayEnabled(true);
        setOverlay(true);
        Alert.alert('已开启', '宠物悬浮在其他应用上方，可拖动到任意位置');
      } catch (e) {
        Alert.alert('开启失败', e instanceof Error ? e.message : String(e));
        setOverlay(false);
      } finally {
        setBusy(false);
      }
    },
    [busy, petAsset, setOverlayEnabled],
  );

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 32 }]}>
      <Text style={styles.section}>账号</Text>
      <View style={styles.card}>
        <Text style={styles.row}>用户名：{user?.username ?? '-'}</Text>
        <Text style={styles.row}>邮箱：{user?.email ?? '-'}</Text>
        <Pressable style={styles.dangerBtn} onPress={logout}>
          <Text style={styles.dangerText}>退出登录</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>平台服务器</Text>
      <View style={styles.card}>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} autoCapitalize="none" placeholder="http://10.0.2.2:3001/api" />
        <Text style={styles.hint}>
          Android 模拟器固定用 10.0.2.2 访问电脑；真机请改成电脑的局域网 IP（如 http://192.168.x.x:3001/api）
        </Text>
        <Pressable style={styles.primaryBtn} onPress={saveUrl}>
          <Text style={styles.primaryText}>保存地址</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>数据同步</Text>
      <View style={styles.card}>
        <Text style={styles.row}>LLM API 档案：{llmCount} 个</Text>
        <Text style={styles.row}>聊天人设：{installedAgentName ?? '默认'}</Text>
        <Text style={styles.hint}>宠物状态与聊天记录每 60 秒自动上传；与桌面端登录同一账号即共享</Text>
        <Pressable style={styles.primaryBtn} onPress={syncNow}>
          <Text style={styles.primaryText}>立即同步</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>宠物信息</Text>
      <View style={styles.card}>
        <Text style={styles.row}>宠物名字</Text>
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          value={name}
          onChangeText={(v) => setName(v.slice(0, 12))}
          placeholder="小宠"
          maxLength={12}
        />
        <Text style={styles.hint}>聊天时会用这个名字称呼宠物；12 字以内，默认「小宠」</Text>
        <Text style={[styles.row, { marginTop: 14 }]}>智能体怎么称呼你</Text>
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          value={nick}
          onChangeText={(v) => setNick(v.slice(0, 12))}
          placeholder="例如：主人、老板（留空则不指定）"
          maxLength={12}
        />
        <Text style={styles.hint}>设置后智能体回复会用这个称呼叫你</Text>
        <Pressable
          style={styles.primaryBtn}
          onPress={() => {
            const trimmedName = name.trim() || '小宠';
            const trimmedNick = nick.trim();
            useAppStore.getState().patch({ petName: trimmedName, userNickname: trimmedNick });
            setName(trimmedName);
            setNick(trimmedNick);
            Alert.alert('已保存', `宠物名字：${trimmedName}${trimmedNick ? `，称呼你：${trimmedNick}` : ''}`);
          }}>
          <Text style={styles.primaryText}>保存</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>聊天</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.row}>显示思考过程</Text>
          <Switch
            value={showThinking}
            onValueChange={(next) => useAppStore.getState().patch({ showThinking: next })}
          />
        </View>
        <Text style={styles.hint}>开启后回复前会先展示模型的思考过程（需模型支持；智谱 GLM-4.5 及以上支持，DeepSeek 需把模型改为 deepseek-reasoner，deepseek-chat 无思考过程）</Text>
        <Pressable
          style={[styles.switchRow, { marginTop: 12 }]}
          disabled={!showThinking}
          onPress={() =>
            Alert.alert('思考过程语言', '选择模型内部思考（reasoning）的书写语言，回复语言不受影响', [
              { text: '跟随回复', onPress: () => useAppStore.getState().patch({ thinkingLang: 'auto' }) },
              { text: '中文', onPress: () => useAppStore.getState().patch({ thinkingLang: 'zh' }) },
              { text: 'English', onPress: () => useAppStore.getState().patch({ thinkingLang: 'en' }) },
              { text: '取消', style: 'cancel' },
            ])
          }>
          <Text style={[styles.row, !showThinking && { color: '#CCC' }]}>思考过程语言</Text>
          <Text style={styles.valueText}>
            {thinkingLang === 'auto' ? '跟随回复' : thinkingLang === 'zh' ? '中文' : 'English'} ›
          </Text>
        </Pressable>
        <View style={[styles.switchRow, { marginTop: 12 }]}>
          <Text style={styles.row}>清空对话前询问</Text>
          <Switch
            value={chatClearConfirm}
            onValueChange={(next) => useAppStore.getState().patch({ chatClearConfirm: next })}
          />
        </View>
        <Text style={styles.hint}>关闭后点「清空」直接清空记录，不再弹确认</Text>
      </View>

      <Text style={styles.section}>语音朗读</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.row}>朗读宠物回复</Text>
          <Switch
            value={tts}
            onValueChange={(next) => {
              setTts(next);
              setTtsEnabled(next);
            }}
          />
        </View>
        <Text style={styles.hint}>开启后聊天里宠物的回复会用系统语音读出来；聊天页按住麦克风可以语音输入</Text>

        <View style={styles.switchRow}>
          <Text style={styles.row}>音色</Text>
          <Pressable
            style={styles.voiceBtn}
            onPress={() => {
              void listVoices().then((list) => {
                setVoices(list);
                setVoiceModal(true);
              });
            }}>
            <Text style={styles.voiceBtnText}>
              {speechVoice ? voices.find((v) => v.name === speechVoice)?.label ?? '已选音色' : '系统默认'}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>使用手机系统提供的中文语音；列表为空表示设备只有一个音色</Text>

        <Stepper
          label="语速"
          value={speechRate}
          min={0.5}
          max={2.0}
          step={0.1}
          onChange={(v) => useAppStore.getState().patch({ speechRate: v })}
        />
        <Stepper
          label="音调"
          value={speechPitch}
          min={0.5}
          max={2.0}
          step={0.1}
          onChange={(v) => useAppStore.getState().patch({ speechPitch: v })}
        />

        <Pressable
          style={styles.primaryBtn}
          onPress={() => {
            const st = useAppStore.getState();
            void speak('你好，我是你的宠物，很高兴见到你。', {
              rate: st.speechRate,
              pitch: st.speechPitch,
              voice: st.speechVoice || undefined,
            });
          }}>
          <Text style={styles.primaryText}>试听</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>悬浮窗宠物</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.row}>在其他应用上方显示宠物</Text>
          <Switch
            value={overlay}
            onValueChange={toggleOverlay}
            disabled={!overlaySupported || busy}
          />
        </View>
        <Text style={styles.hint}>{overlayHint}</Text>
        {!petAsset && overlaySupported ? (
          <Text style={styles.hint}>当前未领养宠物，开启后将显示占位提示</Text>
        ) : null}
      </View>

      <Text style={styles.section}>关于</Text>
      <View style={styles.card}>
        <Text style={styles.row}>当前版本：{APP_VERSION_NAME}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => void checkAppUpdate(false)}>
          <Text style={styles.primaryText}>检查更新</Text>
        </Pressable>
        <Text style={styles.hint}>发现新版本时会弹出更新面板，面板内直接下载并自动安装</Text>
      </View>
    </ScrollView>

      {/* 音色选择弹窗 */}
      <Modal visible={voiceModal} transparent animationType="fade" onRequestClose={() => setVoiceModal(false)}>
        <Pressable style={styles.modalMask} onPress={() => setVoiceModal(false)}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>选择音色</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              <Pressable
                style={styles.voiceRow}
                onPress={() => {
                  useAppStore.getState().patch({ speechVoice: '' });
                  setVoiceModal(false);
                }}>
                <Text style={[styles.voiceRowText, !speechVoice && styles.voiceRowActive]}>系统默认</Text>
                {!speechVoice && <Text style={styles.voiceRowActive}>✓</Text>}
              </Pressable>
              {voices.map((v) => (
                <Pressable
                  key={v.name}
                  style={styles.voiceRow}
                  onPress={() => {
                    useAppStore.getState().patch({ speechVoice: v.name });
                    setVoiceModal(false);
                  }}>
                  <Text style={[styles.voiceRowText, speechVoice === v.name && styles.voiceRowActive]} numberOfLines={1}>
                    {v.label}
                  </Text>
                  {speechVoice === v.name && <Text style={styles.voiceRowActive}>✓</Text>}
                </Pressable>
              ))}
              {!voices.length && <Text style={styles.hint}>未发现可切换的中文音色</Text>}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F8FA' },
  content: { padding: 16, paddingBottom: 32 },
  section: { fontSize: 13, color: '#888', marginTop: 14, marginBottom: 8 },
  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14 },
  row: { fontSize: 14, color: '#333', lineHeight: 24 },
  input: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  hint: { fontSize: 11, color: '#AAA', marginTop: 6, lineHeight: 17 },
  primaryBtn: { backgroundColor: '#1C6EF2', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  dangerBtn: { borderWidth: 1, borderColor: '#E5484D', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 12 },
  dangerText: { color: '#E5484D', fontSize: 14 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  valueText: { fontSize: 13, color: '#1C6EF2' },
  voiceBtn: { borderWidth: 1, borderColor: '#1C6EF2', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  voiceBtnText: { color: '#1C6EF2', fontSize: 13 },
  stepperRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepperBtn: { width: 34, height: 30, borderRadius: 8, backgroundColor: '#F0F2F5', alignItems: 'center', justifyContent: 'center' },
  stepperBtnText: { fontSize: 18, color: '#333', lineHeight: 22 },
  stepperVal: { minWidth: 56, textAlign: 'center', fontSize: 14, color: '#333' },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  modalCard: { backgroundColor: '#fff', borderRadius: 12, padding: 16, width: '100%' },
  modalTitle: { fontSize: 16, fontWeight: '600', color: '#333', marginBottom: 10 },
  voiceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  voiceRowText: { fontSize: 14, color: '#333', flex: 1, marginRight: 8 },
  voiceRowActive: { color: '#1C6EF2', fontWeight: '600' },
});
