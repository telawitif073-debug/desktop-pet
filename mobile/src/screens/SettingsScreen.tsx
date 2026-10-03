/**
 * 用户设置（DeepSeek 样式）：分组卡片 + 图标行 + 右侧值/开关/箭头，子功能点击进入二级弹层。
 * 打开方式：抽屉底部头像或 …（MainShell 传入 visible/onClose）。
 * 服务器地址已内置隐藏：长按「检查更新」行的版本号可打开调试弹窗。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { flushAllOnQuit, scheduleUpload } from '../api/sync';
import { DEFAULT_BASE_URL, useAppStore, type PetAssetRef } from '../store/appStore';
import { listVoices } from '../native/Voice';
import { speakReply, previewInstalled, previewSystemVoice, cloudVoiceReady, stopAllVoice, testGptsovitsEngine } from '../voiceEngine';
import type { InstalledVoice, TtsCloudConfig } from '../types';
import { APP_VERSION_NAME, checkAppUpdate } from '../update/checkUpdate';
import { nativeVersionName } from '../native/PetInfo';
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
    <View style={st.stepperRow}>
      <Text style={st.rowLabel}>{label}</Text>
      <View style={st.stepper}>
        <Pressable
          style={st.stepperBtn}
          onPress={() => onChange(Math.max(min, Math.round((value - step) * 100) / 100))}
          disabled={value <= min}>
          <Text style={[st.stepperBtnText, value <= min && { color: '#CCC' }]}>－</Text>
        </Pressable>
        <Text style={st.stepperVal}>{value.toFixed(1)}x</Text>
        <Pressable
          style={st.stepperBtn}
          onPress={() => onChange(Math.min(max, Math.round((value + step) * 100) / 100))}
          disabled={value >= max}>
          <Text style={[st.stepperBtnText, value >= max && { color: '#CCC' }]}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** DeepSeek 式设置行：图标 + 标题 + 右侧（值/开关/箭头） */
function Row({
  icon,
  label,
  value,
  showArrow,
  danger,
  switchValue,
  onSwitch,
  onPress,
  onLongPress,
  disabled,
}: {
  icon: string;
  label: string;
  value?: string;
  showArrow?: boolean;
  danger?: boolean;
  switchValue?: boolean;
  onSwitch?: (next: boolean) => void;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      style={[st.row, disabled && st.rowDisabled]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || (!onPress && !onLongPress && !onSwitch)}>
      <Text style={st.rowIcon}>{icon}</Text>
      <Text style={[st.rowLabel, danger && st.rowDanger, disabled && st.rowDisabled]}>{label}</Text>
      {typeof switchValue === 'boolean' && onSwitch ? (
        <Switch value={switchValue} onValueChange={onSwitch} />
      ) : (
        <>
          {!!value && <Text style={st.rowValue} numberOfLines={1}>{value}</Text>}
          {showArrow && <Text style={st.rowArrow}>›</Text>}
        </>
      )}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={st.section}>
      <Text style={st.sectionTitle}>{title}</Text>
      <View style={st.card}>{children}</View>
    </View>
  );
}

export default function SettingsScreen({ visible, onClose }: { visible: boolean; onClose: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const user = useAppStore((s) => s.user);
  const baseUrl = useAppStore((s) => s.baseUrl);
  const llmProfiles = useAppStore((s) => s.llmProfiles);
  const llmActiveProfileId = useAppStore((s) => s.llmActiveProfileId);
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
  const downloadedVoices = useAppStore((s) => s.downloadedVoices);
  const activeCloudVoiceId = useAppStore((s) => s.activeCloudVoiceId);
  const ttsCloudConfig = useAppStore((s) => s.ttsCloudConfig);
  const chatClearConfirm = useAppStore((s) => s.chatClearConfirm);
  const petStateEnabled = useAppStore((s) => s.petStateEnabled);
  const moodFromChat = useAppStore((s) => s.moodFromChat);
  const petSelfDescription = useAppStore((s) => s.petSelfDescription);

  const [url, setUrl] = useState(baseUrl);
  const [serverModal, setServerModal] = useState(false);
  const [overlay, setOverlay] = useState(overlayEnabled);
  const [tts, setTts] = useState(ttsEnabled);
  const [busy, setBusy] = useState(false);
  const [voiceModal, setVoiceModal] = useState(false);
  const [speechModal, setSpeechModal] = useState(false);
  const [voices, setVoices] = useState<Array<{ name: string; label: string }>>([]);
  const [voicePreviewing, setVoicePreviewing] = useState('');
  const [ttsCfgModal, setTtsCfgModal] = useState(false);
  const [ttsCfg, setTtsCfg] = useState<TtsCloudConfig>({ engine: 'openai', baseUrl: '', apiKey: '', model: '' });
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestResult, setTtsTestResult] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const downloadedPets = useAppStore((s) => s.downloadedPets);
  const activeCloudVoiceName = downloadedVoices.find((v) => v.id === activeCloudVoiceId)?.name ?? '';

  /** 试听已安装云音色（错误如缺 Key 直接弹窗指引） */
  const previewCloud = async (v: InstalledVoice): Promise<void> => {
    if (voicePreviewing) return;
    stopAllVoice();
    setVoicePreviewing(v.id);
    try {
      await previewInstalled(v);
    } catch (e) {
      Alert.alert('试听失败', e instanceof Error ? e.message : String(e));
    } finally {
      setVoicePreviewing('');
    }
  };

  const previewSys = async (voiceName: string | undefined): Promise<void> => {
    if (voicePreviewing) return;
    setVoicePreviewing(voiceName || 'system-default');
    try {
      await previewSystemVoice(voiceName);
    } finally {
      setVoicePreviewing('');
    }
  };

  /** 删除已安装音色（当前使用中则一并取消选择） */
  const removeVoice = (v: InstalledVoice): void => {
    Alert.alert('删除音色', `确定从本机删除「${v.name}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const s = useAppStore.getState();
          s.patch({
            downloadedVoices: s.downloadedVoices.filter((x) => x.id !== v.id),
            ...(s.activeCloudVoiceId === v.id ? { activeCloudVoiceId: '' } : {}),
          });
          scheduleUpload('config');
        },
      },
    ]);
  };

  /** 选择系统音色：与云音色互斥（清空云选择） */
  const pickSystemVoice = (voiceName: string): void => {
    useAppStore.getState().patch({ speechVoice: voiceName, activeCloudVoiceId: '' });
    scheduleUpload('config');
    setVoiceModal(false);
  };

  const pickCloudVoice = (v: InstalledVoice): void => {
    const s = useAppStore.getState();
    s.patch({ activeCloudVoiceId: v.id });
    scheduleUpload('config');
    setVoiceModal(false);
    if (!cloudVoiceReady(v)) {
      Alert.alert('已选择云音色', `「${v.name}」需要云 TTS 服务凭证，请点本页「云 TTS 服务配置」填写地址、模型和 Key。`);
    }
  };

  const saveTtsCfg = (): void => {
    useAppStore.getState().patch({
      ttsCloudConfig: {
        engine: ttsCfg.engine || 'openai',
        baseUrl: ttsCfg.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: ttsCfg.apiKey.trim(),
        model: ttsCfg.model.trim(),
      },
    });
    scheduleUpload('config');
  };

  // 聊天人设 = 当前 API 档案的系统提示词（安装智能体会写入这里，见商店安装逻辑）
  const activeProfile = llmProfiles.find((p) => p.id === llmActiveProfileId) ?? llmProfiles[0] ?? null;
  const [persona, setPersona] = useState(activeProfile?.systemPrompt ?? '');
  useEffect(() => {
    if (personaOpen) setPersona(activeProfile?.systemPrompt ?? '');
  }, [personaOpen, activeProfile?.id, activeProfile?.systemPrompt]);

  const [desc, setDesc] = useState(petSelfDescription);
  useEffect(() => {
    setDesc(petSelfDescription);
  }, [petSelfDescription]);

  // 进设置页时刷新开关显示（权限可能在系统设置中被收回）
  useEffect(() => {
    setOverlay(overlayEnabled);
  }, [overlayEnabled]);

  useEffect(() => {
    setTts(ttsEnabled);
  }, [ttsEnabled]);

  const overlaySupported = isOverlaySupported();

  /** 清洗用户输入：截取首个合法 URL 起点（兜住 `;` 等误输入前缀），缺 scheme 自动补 https:// */
  function normalizeServerUrl(raw: string): string {
    const compact = raw.replace(/\s+/g, '');
    const hit = compact.match(/https?:\/\/.+/i);
    if (hit) return hit[0];
    return 'https://' + compact.replace(/^[^a-zA-Z0-9]+/, '');
  }

  const saveUrl = async (): Promise<void> => {
    if (!url.replace(/\s+/g, '')) {
      Alert.alert('地址为空', `请输入服务器地址（默认 ${DEFAULT_BASE_URL}）`);
      return;
    }
    const cleaned = normalizeServerUrl(url);
    setUrl(cleaned);
    useAppStore.getState().setBaseUrl(cleaned);
    try {
      const res = await fetch(`${cleaned.replace(/\/$/, '')}/app-update`);
      Alert.alert('已保存', res.ok ? '服务器地址已更新，连接正常' : `已保存，但服务器返回 ${res.status}`);
    } catch {
      Alert.alert('已保存，但连不上服务器', '请检查地址与手机网络');
    }
  };

  const savePersona = (): void => {
    if (!activeProfile) {
      Alert.alert('还没有 API 档案', '先在聊天页顶部创建 API 档案，再回来编辑人设');
      return;
    }
    const trimmed = persona.trim();
    useAppStore
      .getState()
      .patch({ llmProfiles: llmProfiles.map((p) => (p.id === activeProfile.id ? { ...p, systemPrompt: trimmed } : p)) });
    setPersonaOpen(false);
    scheduleUpload('config');
    Alert.alert('已保存', trimmed ? '聊天人设已更新并云同步' : '已清空人设，使用默认宠物人格');
  };

  const saveDesc = (): void => {
    const trimmed = desc.trim();
    useAppStore.getState().patch({ petSelfDescription: trimmed });
    setDescOpen(false);
    scheduleUpload('config');
    Alert.alert('已保存', '宠物自我描述已更新');
  };

  const syncNow = (): void => {
    flushAllOnQuit();
    Alert.alert('已同步', '本地变更已上传到平台');
  };

  const logout = (): void => {
    setAccountOpen(false);
    onClose();
    setTimeout(() => useAppStore.getState().logout(), 50);
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
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[st.container, { paddingTop: insets.top + 6 }]}>
        {/* 头部：返回 + 居中标题 */}
        <View style={st.header}>
          <Pressable style={st.backBtn} onPress={onClose} hitSlop={10}>
            <Text style={st.backText}>‹</Text>
          </Pressable>
          <Text style={st.headerTitle}>设置</Text>
          <View style={{ width: 38 }} />
        </View>

        <ScrollView contentContainerStyle={[st.content, { paddingBottom: insets.bottom + 40 }]}>
          <Section title="账户">
            <Row icon="👤" label="账号管理" value={user?.username ?? '-'} showArrow onPress={() => setAccountOpen(true)} />
            <View style={st.divider} />
            <Row icon="🔄" label="数据管理" value="立即同步" showArrow onPress={syncNow} />
          </Section>

          <Section title="聊天">
            <Row icon="🧠" label="显示思考过程" switchValue={showThinking} onSwitch={(next) => useAppStore.getState().patch({ showThinking: next })} />
            <View style={st.divider} />
            <Row
              icon="🌐"
              label="思考过程语言"
              value={thinkingLang === 'auto' ? '跟随回复' : thinkingLang === 'zh' ? '中文' : 'English'}
              showArrow
              disabled={!showThinking}
              onPress={() =>
                Alert.alert('思考过程语言', '选择模型内部思考（reasoning）的书写语言，回复语言不受影响', [
                  { text: '跟随回复', onPress: () => useAppStore.getState().patch({ thinkingLang: 'auto' }) },
                  { text: '中文', onPress: () => useAppStore.getState().patch({ thinkingLang: 'zh' }) },
                  { text: 'English', onPress: () => useAppStore.getState().patch({ thinkingLang: 'en' }) },
                  { text: '取消', style: 'cancel' },
                ])
              }
            />
            <View style={st.divider} />
            <Row icon="⚠️" label="清空对话前询问" switchValue={chatClearConfirm} onSwitch={(next) => useAppStore.getState().patch({ chatClearConfirm: next })} />
          </Section>

          <Section title="语音">
            <Row icon="🔊" label="朗读宠物回复" switchValue={tts} onSwitch={(next) => { setTts(next); setTtsEnabled(next); }} />
            <View style={st.divider} />
            <Row
              icon="🎙"
              label="音色"
              value={activeCloudVoiceName || (speechVoice ? '系统音色' : '系统默认')}
              showArrow
              disabled={!tts}
              onPress={() => {
                void listVoices().then((list) => {
                  setVoices(list);
                  setVoiceModal(true);
                });
              }}
            />
            <View style={st.divider} />
            <Row
              icon="☁️"
              label="云 TTS 服务配置"
              value={ttsCloudConfig.apiKey || ttsCloudConfig.baseUrl ? (ttsCloudConfig.engine === 'gptsovits' ? 'GPT-SoVITS' : '已配置 Key') : '未配置'}
              showArrow
              disabled={!tts}
              onPress={() => {
                const c = useAppStore.getState().ttsCloudConfig;
                setTtsCfg({ engine: c.engine || 'openai', baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model });
                setTtsTestResult('');
                setTtsCfgModal(true);
              }}
            />
            <View style={st.divider} />
            <Row icon="🎚" label="语速与音调" value={`${speechRate.toFixed(1)}x · ${speechPitch.toFixed(1)}x`} showArrow disabled={!tts} onPress={() => setSpeechModal(true)} />
          </Section>

          <Section title="宠物">
            <Row icon="🐾" label="宠物状态功能" switchValue={petStateEnabled} onSwitch={(next) => useAppStore.getState().setPetStateEnabled(next)} />
            <View style={st.divider} />
            <Row icon="❤️" label="心情随对话变化" switchValue={moodFromChat} onSwitch={(next) => useAppStore.getState().setMoodFromChat(next)} />
            <Text style={st.hint}>开启后智能体聊得开心心情+8，不愉快心情-8；需宠物状态功能开启</Text>
            <View style={st.divider} />
            <Row icon="✏️" label="宠物自我描述" value={petSelfDescription ? petAsset?.name ?? '已设置' : '未设置'} showArrow onPress={() => setDescOpen(true)} />
            <View style={st.divider} />
            <Row
              icon="🪟"
              label="悬浮窗宠物（其他应用上层）"
              switchValue={overlay}
              onSwitch={toggleOverlay}
            />
            <Text style={st.hint}>
              {!overlaySupported
                ? Platform.OS === 'ios'
                  ? 'iOS 系统不支持悬浮窗，请使用 App 内形态（宠物已常驻聊天页上层）'
                  : '当前环境不支持悬浮窗功能'
                : '应用内宠物已常驻聊天页上层；此开关控制退出应用后仍悬浮在其他应用上方'}
            </Text>
          </Section>

          <Section title="关于">
            <Row
              icon="ⓘ"
              label="检查更新"
              value={nativeVersionName || APP_VERSION_NAME}
              showArrow
              onPress={() => void checkAppUpdate(false)}
              onLongPress={() => {
                setUrl(baseUrl);
                setServerModal(true);
              }}
            />
          </Section>

          <View style={st.card}>
            <Row icon="↪️" label="退出登录" danger onPress={logout} />
          </View>
        </ScrollView>

        {/* 账号管理二级页 */}
        <Modal visible={accountOpen} animationType="slide" onRequestClose={() => setAccountOpen(false)}>
          <View style={[st.container, { paddingTop: insets.top + 6 }]}>
            <View style={st.header}>
              <Pressable style={st.backBtn} onPress={() => setAccountOpen(false)} hitSlop={10}>
                <Text style={st.backText}>‹</Text>
              </Pressable>
              <Text style={st.headerTitle}>账号管理</Text>
              <View style={{ width: 38 }} />
            </View>
            <ScrollView contentContainerStyle={st.content}>
              <Section title="账户">
                <View style={st.accountBox}>
                  <Text style={st.accountLabel}>用户名</Text>
                  <Text style={st.accountValue}>{user?.username ?? '-'}</Text>
                  <View style={st.divider} />
                  <Text style={st.accountLabel}>邮箱</Text>
                  <Text style={st.accountValue}>{user?.email ?? '-'}</Text>
                </View>
              </Section>
              <View style={st.card}>
                <Row icon="↪️" label="退出登录" danger onPress={logout} />
              </View>
            </ScrollView>
          </View>
        </Modal>

        {/* 宠物自我描述编辑 */}
        <Modal visible={descOpen} transparent animationType="fade" onRequestClose={() => setDescOpen(false)}>
          <Pressable style={st.modalMask} onPress={() => setDescOpen(false)}>
            <Pressable style={st.modalCard} onPress={() => undefined}>
              <Text style={st.modalTitle}>宠物自我描述</Text>
              <TextInput
                style={st.areaInput}
                value={desc}
                onChangeText={(v) => setDesc(v.slice(0, 200))}
                placeholder="例如：一只白色的小猫，性格黏人爱撒娇"
                maxLength={200}
                multiline
              />
              <Text style={st.hint}>描述宠物的形象与性格，会作为智能体人设的一部分并同步到桌面端</Text>
              <View style={st.modalBtns}>
                <Pressable style={[st.btn, st.btnGhost]} onPress={() => setDescOpen(false)}>
                  <Text style={st.btnGhostText}>取消</Text>
                </Pressable>
                <Pressable style={[st.btn, st.btnPrimary]} onPress={saveDesc}>
                  <Text style={st.btnPrimaryText}>保存</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 语速与音调 */}
        <Modal visible={speechModal} transparent animationType="fade" onRequestClose={() => setSpeechModal(false)}>
          <Pressable style={st.modalMask} onPress={() => setSpeechModal(false)}>
            <Pressable style={st.modalCard} onPress={() => undefined}>
              <Text style={st.modalTitle}>语速与音调</Text>
              <Stepper label="语速" value={speechRate} min={0.5} max={2.0} step={0.1} onChange={(v) => useAppStore.getState().patch({ speechRate: v })} />
              <Stepper label="音调" value={speechPitch} min={0.5} max={2.0} step={0.1} onChange={(v) => useAppStore.getState().patch({ speechPitch: v })} />
              <Pressable
                style={[st.btn, st.btnPrimary, { marginTop: 16 }]}
                onPress={() => {
                  void speakReply('你好，我是你的宠物，很高兴见到你。', null);
                }}>
                <Text style={st.btnPrimaryText}>试听</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 音色选择：我的云音色（商店安装）+ 系统音色 */}
        <Modal visible={voiceModal} transparent animationType="fade" onRequestClose={() => setVoiceModal(false)}>
          <Pressable style={st.modalMask} onPress={() => setVoiceModal(false)}>
            <Pressable style={st.modalCard} onPress={() => undefined}>
              <Text style={st.modalTitle}>选择音色</Text>
              <ScrollView style={{ maxHeight: 380 }}>
                {downloadedVoices.length > 0 && <Text style={st.voiceGroup}>我的云音色（商店）</Text>}
                {downloadedVoices.map((v) => {
                  const active = activeCloudVoiceId === v.id;
                  const ready = v.config.engine === 'system' || cloudVoiceReady(v);
                  return (
                    <View key={v.id} style={st.voiceRow}>
                      <Pressable style={{ flex: 1 }} onPress={() => pickCloudVoice(v)}>
                        <Text style={[st.voiceRowText, active && st.voiceRowActive]} numberOfLines={1}>
                          {v.name}
                          {v.config.engine === 'cloud' && !ready ? '（未配 Key）' : ''}
                        </Text>
                      </Pressable>
                      <Pressable hitSlop={6} disabled={!!voicePreviewing} onPress={() => void previewCloud(v)} style={{ marginRight: 12 }}>
                        <Text style={{ color: '#4D6BFE', fontSize: 13 }}>{voicePreviewing === v.id ? '…' : '试听'}</Text>
                      </Pressable>
                      <Pressable hitSlop={6} onPress={() => removeVoice(v)} style={{ marginRight: 10 }}>
                        <Text style={{ color: '#C04040', fontSize: 13 }}>删除</Text>
                      </Pressable>
                      {active && <Text style={st.voiceRowActive}>✓</Text>}
                    </View>
                  );
                })}

                <Text style={st.voiceGroup}>系统音色（离线）</Text>
                <View style={st.voiceRow}>
                  <Pressable style={{ flex: 1 }} onPress={() => pickSystemVoice('')}>
                    <Text style={[st.voiceRowText, !speechVoice && !activeCloudVoiceId && st.voiceRowActive]}>系统默认</Text>
                  </Pressable>
                  <Pressable hitSlop={6} disabled={!!voicePreviewing} onPress={() => void previewSys(undefined)} style={{ marginRight: 12 }}>
                    <Text style={{ color: '#4D6BFE', fontSize: 13 }}>{voicePreviewing === 'system-default' ? '…' : '试听'}</Text>
                  </Pressable>
                  {!speechVoice && !activeCloudVoiceId && <Text style={st.voiceRowActive}>✓</Text>}
                </View>
                {voices.map((v) => (
                  <View key={v.name} style={st.voiceRow}>
                    <Pressable style={{ flex: 1 }} onPress={() => pickSystemVoice(v.name)}>
                      <Text style={[st.voiceRowText, speechVoice === v.name && !activeCloudVoiceId && st.voiceRowActive]} numberOfLines={1}>
                        {v.label}
                      </Text>
                    </Pressable>
                    <Pressable hitSlop={6} disabled={!!voicePreviewing} onPress={() => void previewSys(v.name)} style={{ marginRight: 12 }}>
                      <Text style={{ color: '#4D6BFE', fontSize: 13 }}>{voicePreviewing === v.name ? '…' : '试听'}</Text>
                    </Pressable>
                    {speechVoice === v.name && !activeCloudVoiceId && <Text style={st.voiceRowActive}>✓</Text>}
                  </View>
                ))}
                {!voices.length && <Text style={st.hint}>未发现更多系统音色（可在安卓系统设置中安装语音引擎与中文语音包）</Text>}
                <Text style={[st.hint, { marginTop: 8 }]}>更多云音色请到侧边栏「商店 → 音色」安装；云音色需配合「云 TTS 服务配置」使用</Text>
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 云 TTS 服务配置：OpenAI 兼容 /audio/speech 或自建 GPT-SoVITS api_v2 */}
        <Modal visible={ttsCfgModal} transparent animationType="fade" onRequestClose={() => setTtsCfgModal(false)}>
          <Pressable style={st.modalMask} onPress={() => setTtsCfgModal(false)}>
            <Pressable style={st.modalCard} onPress={() => undefined}>
              <Text style={st.modalTitle}>云 TTS 服务配置</Text>
              <ScrollView keyboardShouldPersistTaps="handled">
                {/* 引擎选择 */}
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  {([
                    { key: 'openai', label: 'OpenAI 兼容' },
                    { key: 'gptsovits', label: 'GPT-SoVITS' },
                  ] as const).map((it) => (
                    <Pressable
                      key={it.key}
                      onPress={() => {
                        setTtsCfg((c) => ({ ...c, engine: it.key }));
                        setTtsTestResult('');
                      }}
                      style={{
                        flex: 1,
                        paddingVertical: 8,
                        borderRadius: 8,
                        alignItems: 'center',
                        backgroundColor: (ttsCfg.engine || 'openai') === it.key ? '#4D6BFE' : '#F2F3F6',
                      }}>
                      <Text style={{ color: (ttsCfg.engine || 'openai') === it.key ? '#fff' : '#555', fontSize: 13, fontWeight: '600' }}>{it.label}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={st.fieldLabel}>服务地址</Text>
                <TextInput
                  style={st.textInput}
                  value={ttsCfg.baseUrl}
                  onChangeText={(t) => setTtsCfg((c) => ({ ...c, baseUrl: t }))}
                  placeholder={ttsCfg.engine === 'gptsovits' ? 'http://192.168.1.5:9880' : 'https://api.openai.com/v1'}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                {ttsCfg.engine === 'gptsovits' ? (
                  <>
                    <Text style={st.hint}>
                      填你电脑上 GPT-SoVITS 整合包 api_v2 服务的地址（默认端口 9880），手机需与电脑在同一局域网；引擎所在电脑记得放行防火墙端口。
                      参考音频（refAudioPath）在音色配置里填，无需 API Key。部署与训练克隆详见音色板块的帮助指南。
                    </Text>
                    {ttsTestResult ? <Text style={{ fontSize: 12, marginTop: 8, color: ttsTestResult.startsWith('✓') ? '#2BA44C' : '#E5484D' }}>{ttsTestResult}</Text> : null}
                    <Pressable
                      style={[st.btn, { borderWidth: 1, borderColor: '#4D6BFE', marginTop: 12 }, ttsTesting && { opacity: 0.6 }]}
                      disabled={ttsTesting}
                      onPress={async () => {
                        setTtsTesting(true);
                        setTtsTestResult('');
                        try {
                          const r = await testGptsovitsEngine(ttsCfg.baseUrl);
                          setTtsTestResult(`${r.online ? '✓' : '✗'} ${r.message}`);
                        } finally {
                          setTtsTesting(false);
                        }
                      }}>
                      <Text style={{ color: '#4D6BFE', fontSize: 14 }}>{ttsTesting ? '测试中…' : '连接测试'}</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Text style={st.fieldLabel}>模型名</Text>
                    <TextInput
                      style={st.textInput}
                      value={ttsCfg.model}
                      onChangeText={(t) => setTtsCfg((c) => ({ ...c, model: t }))}
                      placeholder="tts-1 / gpt-4o-mini-tts / cosyvoice-v2 等"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={st.fieldLabel}>API Key</Text>
                    <TextInput
                      style={st.textInput}
                      value={ttsCfg.apiKey}
                      onChangeText={(t) => setTtsCfg((c) => ({ ...c, apiKey: t }))}
                      placeholder="sk-..."
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                    />
                    <Text style={st.hint}>
                      Key 仅保存在本机、云同步时加密，不会随音色配置分享。兼容 OpenAI「/audio/speech」的服务均可：OpenAI、阿里云
                      CosyVoice/百炼、火山引擎豆包语音、MiniMax、硅基流动等，具体地址与模型名以服务商控制台为准。
                    </Text>
                  </>
                )}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  <Pressable
                    style={[st.btn, { borderWidth: 1, borderColor: '#D5D8DE' }, ttsTesting && { opacity: 0.6 }]}
                    disabled={ttsTesting}
                    onPress={async () => {
                      saveTtsCfg();
                      const cur = useAppStore.getState();
                      const v = cur.downloadedVoices.find((x) => x.id === cur.activeCloudVoiceId);
                      if (!v || v.config.engine === 'system') {
                        Alert.alert('暂无可试听音色', '请先在「音色」里选择一个云音色，或到商店安装后再来测试。');
                        return;
                      }
                      setTtsTesting(true);
                      try {
                        await previewInstalled(v);
                      } catch (e) {
                        Alert.alert('测试失败', e instanceof Error ? e.message : String(e));
                      } finally {
                        setTtsTesting(false);
                      }
                    }}>
                    <Text style={{ color: '#4D6BFE', fontSize: 14 }}>{ttsTesting ? '合成中…' : '保存并试听'}</Text>
                  </Pressable>
                  <Pressable
                    style={[st.btn, st.btnPrimary, { flex: 1 }]}
                    onPress={() => {
                      saveTtsCfg();
                      setTtsCfgModal(false);
                    }}>
                    <Text style={st.btnPrimaryText}>保存</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 服务器地址（隐藏入口：长按检查更新行的版本号） */}
        <Modal visible={serverModal} transparent animationType="fade" onRequestClose={() => setServerModal(false)}>
          <Pressable style={st.modalMask} onPress={() => setServerModal(false)}>
            <Pressable style={st.modalCard} onPress={() => undefined}>
              <Text style={st.modalTitle}>服务器地址</Text>
              <TextInput style={st.textInput} value={url} onChangeText={setUrl} autoCapitalize="none" placeholder={DEFAULT_BASE_URL} />
              <Text style={st.hint}>应用已内置云服务器地址（7×24 常驻），仅调试时修改</Text>
              <Pressable
                style={[st.btn, st.btnPrimary, { marginTop: 14 }]}
                onPress={() => {
                  setServerModal(false);
                  void saveUrl();
                }}>
                <Text style={st.btnPrimaryText}>保存</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F8FA' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 8 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 24, color: '#333', marginTop: -3, fontWeight: '600' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#1A1A1A' },
  content: { padding: 14, paddingBottom: 40 },
  section: { marginBottom: 8 },
  sectionTitle: { fontSize: 12, color: '#9AA0A6', marginBottom: 6, marginLeft: 6 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, paddingHorizontal: 6, paddingVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 10 },
  rowDisabled: { opacity: 0.45 },
  rowIcon: { fontSize: 17, width: 30, textAlign: 'center' },
  rowLabel: { fontSize: 15, color: '#1A1A1A', flex: 1, marginRight: 8 },
  rowValue: { fontSize: 13, color: '#9AA0A6', maxWidth: '52%' },
  rowArrow: { fontSize: 17, color: '#C4C7CC', marginLeft: 6 },
  rowDanger: { color: '#E5484D' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#F0F1F3', marginLeft: 40 },
  hint: { fontSize: 11, color: '#A8ADB4', lineHeight: 17, marginTop: 4, marginLeft: 40, marginBottom: 8, marginRight: 8 },
  accountBox: { paddingVertical: 6 },
  accountLabel: { fontSize: 12, color: '#9AA0A6', marginTop: 10 },
  accountValue: { fontSize: 15, color: '#1A1A1A', marginTop: 2, marginBottom: 6 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18, width: '100%' },
  modalTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginBottom: 12 },
  textInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  areaInput: { borderWidth: 1, borderColor: '#DDD', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, minHeight: 90, textAlignVertical: 'top' },
  modalBtns: { flexDirection: 'row', marginTop: 14 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: '#DDD', marginRight: 10 },
  btnGhostText: { color: '#666', fontSize: 14 },
  btnPrimary: { backgroundColor: '#4D6BFE' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  voiceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  voiceRowText: { fontSize: 14, color: '#1A1A1A', flex: 1, marginRight: 8 },
  voiceRowActive: { color: '#4D6BFE', fontWeight: '600' },
  voiceGroup: { fontSize: 12, color: '#8A8F99', fontWeight: '700', marginTop: 14, marginBottom: 2 },
  fieldLabel: { fontSize: 12, color: '#666', fontWeight: '600', marginTop: 10, marginBottom: 4 },
  stepperRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepperBtn: { width: 34, height: 30, borderRadius: 8, backgroundColor: '#F0F2F5', alignItems: 'center', justifyContent: 'center' },
  stepperBtnText: { fontSize: 18, color: '#333', lineHeight: 22 },
  stepperVal: { minWidth: 56, textAlign: 'center', fontSize: 14, color: '#333' },
  // 智能体管理
  agentEmpty: { paddingVertical: 16, paddingHorizontal: 10, alignItems: 'center' },
  agentEmptyText: { fontSize: 14, color: '#999' },
  agentPet: { fontSize: 12, color: '#9AA0A6', marginTop: 2 },
  agentEditBox: { paddingVertical: 6, paddingHorizontal: 4 },
  petBindRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  petBindRowActive: { backgroundColor: '#F0F6FF', borderRadius: 8, paddingHorizontal: 8, marginHorizontal: -8 },
  petBindName: { fontSize: 14, color: '#1A1A1A', flex: 1, marginRight: 8 },
  petBindNameActive: { color: '#4D6BFE', fontWeight: '600' },
  petBindCheck: { fontSize: 16, color: '#4D6BFE', fontWeight: '600' },
  // 智能体列表 Modal
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalCloseText: { fontSize: 18, color: '#999', padding: 4 },
  modalHint: { fontSize: 12, color: '#AAA', marginTop: 10, textAlign: 'center' },
  agentMgrRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, marginVertical: 2, borderRadius: 8 },
  agentMgrRowActive: { backgroundColor: '#F0F6FF' },
  agentMgrName: { fontSize: 15, color: '#1A1A1A', fontWeight: '500' },
  agentMgrPet: { fontSize: 12, color: '#9AA0A6', marginTop: 2 },
});
