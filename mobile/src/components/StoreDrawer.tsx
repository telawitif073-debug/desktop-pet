/**
 * DeepSeek 式侧边抽屉（替代原商店 Tab）：左上汉堡按钮或聊天页全屏右滑打开，抽屉内左滑返回；
 * 内容 = 资源商店（智能体/音色搜索、安装），最下层左侧用户头像 → 用户设置，右侧 … → 用户设置。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, FlatList, Image, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as platform from '../api/platform';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';
import { type AssetItem, type InstalledVoice } from '../types';
import { cloudVoiceReady, previewInstalled, stopAllVoice } from '../voiceEngine';
import { VOICE_GUIDE } from './voiceGuide';
import PublishVoiceModal from './PublishVoiceModal';

const DRAWER_W = Math.min(Dimensions.get('window').width * 0.82, 340);

/** 详情字段扩展（后端实体字段，AssetItem 索引签名兜底） */
interface DetailAsset extends AssetItem {
  format?: string;
  type?: string;
  version?: string;
  rating?: number;
  tags?: string[];
  previewUrl?: string | null;
  category?: string | null;
  dependencies?: string[];
  configSchema?: Record<string, unknown> | null;
  author?: { id?: string; username?: string } | null;
}

function agentTypeLabel(type?: string): string {
  return type === 'task' ? '任务智能体' : type === 'mixed' ? '混合智能体' : '对话智能体';
}

/** 从智能体实体依赖声明 + 配置文件里提取「需要的 API / 依赖」清单 */
function extractAgentDeps(detail: DetailAsset, config: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.push(v);
    else if (v && typeof v === 'object') {
      const n = (v as { name?: unknown }).name;
      if (typeof n === 'string' && n.trim()) out.push(n);
    }
  };
  (detail.dependencies ?? []).forEach(push);
  if (config) {
    const cd = config.dependencies;
    if (Array.isArray(cd)) cd.forEach(push);
    // 多智能体编排：编排器模型 + 子智能体 endpoint 视为外部 API
    const mg = (config.multi_agent ?? config.multiAgent) as
      | { orchestrator?: { model?: unknown }; agents?: Array<{ id?: unknown; endpoint?: unknown }> }
      | undefined;
    if (mg) {
      if (typeof mg.orchestrator?.model === 'string') out.push(`编排模型:${mg.orchestrator.model}`);
      (mg.agents ?? []).forEach((a) => {
        if (typeof a.endpoint === 'string') out.push(a.endpoint);
      });
    }
  }
  return [...new Set(out)];
}

export default function StoreDrawer({
  visible,
  onClose,
  onOpenSettings,
  onOpenAdmin,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'agent' | 'voice'>('agent');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [selected, setSelected] = useState<AssetItem | null>(null);
  const [detail, setDetail] = useState<DetailAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [imgError, setImgError] = useState(false);
  // ── 音色板块独立数据（voices 接口结构与 agents 不同，单独一套 state） ──
  const [voiceItems, setVoiceItems] = useState<platform.VoiceAssetItem[]>([]);
  const [voiceDetail, setVoiceDetail] = useState<platform.VoiceAssetItem | null>(null);
  const [previewingId, setPreviewingId] = useState('');
  const [publishVisible, setPublishVisible] = useState(false);
  const [helpModal, setHelpModal] = useState(false);
  const [agentConfig, setAgentConfig] = useState<Record<string, unknown> | null>(null);
  const [agentCfgText, setAgentCfgText] = useState('');
  const [showCfg, setShowCfg] = useState(false);
  // 安装智能体后选择「对话 API」绑定
  const [apiPickVisible, setApiPickVisible] = useState(false);
  const [apiPickTargetId, setApiPickTargetId] = useState('');
  // 已有可用对话 API 的档案（key/接口/模型齐全），用于安装后询问绑定。
  // 注意：filter 不能在 zustand selector 里直接返回（每次 render 新数组 →
  // useSyncExternalStore 快照引用变化 → 无限渲染循环 → Maximum update depth）。
  // 先取稳定引用，组件内 useMemo 过滤。
  const llmProfilesForPick = useAppStore((s) => s.llmProfiles);
  const apiCandidates = useMemo(
    () =>
      llmProfilesForPick.filter(
        (p) => p.id !== apiPickTargetId && (p.apiKey ?? '').trim() && (p.baseUrl ?? '').trim() && (p.model ?? '').trim(),
      ),
    [llmProfilesForPick, apiPickTargetId],
  );
  const downloadedVoices = useAppStore((s) => s.downloadedVoices);
  const activeCloudVoiceId = useAppStore((s) => s.activeCloudVoiceId);
  const token = useAppStore((s) => s.token);
  const username = useAppStore((s) => s.user?.username ?? '用户');
  const isAdmin = useAppStore((s) => s.user?.role === 'admin');
  const slide = useRef(new Animated.Value(-DRAWER_W)).current;

  // 打开/关闭滑入滑出
  useEffect(() => {
    Animated.timing(slide, { toValue: visible ? 0 : -DRAWER_W - 20, duration: 220, useNativeDriver: true }).start();
  }, [visible, slide]);

  // 商店页全屏左滑返回聊天：只在移动阶段捕获，且只认领明显横向为主的左滑
  //（点击无位移不受影响；垂直滚动列表纵向位移占优，不会被抢）。
  // onClose 经 ref 调用：PanResponder 只创建一次，避免闭包捕获到首渲染的旧引用。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const swipeClosePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => g.dx < -24 && Math.abs(g.dy) < Math.abs(g.dx) * 0.5,
      onPanResponderRelease: (_e, g) => {
        if (g.dx < -40) onCloseRef.current();
      },
    }),
  ).current;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      if (tab === 'voice') {
        const res = await platform.listVoices(search.trim() ? { search: search.trim() } : undefined);
        setVoiceItems(res.items);
      } else {
        const res = await platform.listAssets(search.trim() || undefined);
        setItems(res.items);
      }
    } catch {
      if (tab === 'voice') setVoiceItems([]);
      else setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  // 点击列表项 → 抽屉内详情视图（依赖列表已有的 getAssetDetail 详情接口）
  const openDetail = useCallback(
    async (item: AssetItem): Promise<void> => {
      setSelected(item);
      setDetail(null);
      setDetailLoading(true);
      setImgError(false);
      setAgentConfig(null);
      setAgentCfgText('');
      setShowCfg(false);
      try {
        if (tab === 'voice') {
          const d = await platform.getVoiceDetail(item.id);
          setVoiceDetail(d);
          setDetailLoading(false);
          return;
        }
        const d = (await platform.getAssetDetail(item.id)) as DetailAsset;
        setDetail(d);
        // 智能体：额外拉取配置 JSON（fileUrl 即配置包），用于展示提示词/依赖/JSON
        if (tab === 'agent' && d.fileUrl) {
          try {
            const res = await fetch(platform.assetUrl(d.fileUrl));
            const cfg = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (cfg && typeof cfg === 'object') {
              setAgentConfig(cfg);
              setAgentCfgText(JSON.stringify(cfg, null, 2));
            }
          } catch {
            /* 配置文件加载失败不影响主体详情 */
          }
        }
      } catch {
        setDetail(null);
        setVoiceDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [tab],
  );

  const backToList = useCallback((): void => {
    setSelected(null);
    setDetail(null);
    setVoiceDetail(null);
    setAgentConfig(null);
    setAgentCfgText('');
    setShowCfg(false);
    stopAllVoice();
  }, []);

  const install = async (item: AssetItem): Promise<void> => {
    setBusyId(item.id);
    try {
      const detail = await platform.getAssetDetail(item.id);
      await platform.downloadAsset(item.id);
      const res = await fetch(platform.assetUrl(detail.fileUrl ?? ''));
      const config = (await res.json().catch(() => ({}))) as { name?: string; systemPrompt?: string };
      const agentName = config.name ?? detail.name;
      const agentPrompt = String(config.systemPrompt ?? '').trim();
      const store = useAppStore.getState();
      // LlmProfile = 智能体：先创建（人设，API 留空），再让用户绑定对话 API
      const newId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      // 已有可用对话 API（key/接口/模型齐全）的档案（不含刚创建的）
      const candidates = store.llmProfiles.filter(
        (p) => p.id !== newId && (p.apiKey ?? '').trim() && (p.baseUrl ?? '').trim() && (p.model ?? '').trim(),
      );
      const newProfile = {
        id: newId,
        name: agentName,
        apiKey: '',
        baseUrl: '',
        model: '',
        systemPrompt: agentPrompt,
      };
      store.patch({
        llmProfiles: [...store.llmProfiles, newProfile],
        llmActiveProfileId: newId,
      });
      scheduleUpload('config');
      if (candidates.length === 1) {
        // 只有一个可用 API：不询问，自动绑定
        const src = candidates[0];
        applyApiToProfile(newId, src);
        Alert.alert('已安装', `${agentName} 已创建为新智能体，已自动使用「${src.name}」的 API 配置`, [{ text: '好的' }]);
      } else if (candidates.length > 1) {
        // 多个可用 API：询问用户绑定哪个
        setApiPickTargetId(newId);
        setApiPickVisible(true);
        Alert.alert(
          '已安装',
          `${agentName} 已创建为新智能体，请选择对话时使用的 API（暂不选择也可以在智能体管理中稍后配置）`,
          [{ text: '选择 API', onPress: () => setApiPickVisible(false) }],
        );
      } else {
        // 没有可用 API：提示去配置
        Alert.alert(
          '已安装',
          `${agentName} 已创建为新智能体（人设已应用），但没有可用的对话 API，请到智能体管理中填写 API Key、接口地址和模型后才能聊天`,
        );
      }
    } catch (e) {
      Alert.alert('安装失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  /** 把某个档案的对话 API 配置应用到指定智能体 */
  const applyApiToProfile = (
    profileId: string,
    src: { apiKey?: string; baseUrl?: string; model?: string },
  ): void => {
    const s = useAppStore.getState();
    s.patch({
      llmProfiles: s.llmProfiles.map((p) =>
        p.id === profileId ? { ...p, apiKey: src.apiKey ?? '', baseUrl: src.baseUrl ?? '', model: src.model ?? '' } : p,
      ),
    });
    scheduleUpload('config');
  };

  // ── 音色：列表/详情项转本机 InstalledVoice（试听与安装共用） ──
  const voiceItemToInstalled = (v: platform.VoiceAssetItem): InstalledVoice => ({
    id: v.id,
    name: v.name,
    description: v.description ?? undefined,
    config: v.configSchema,
    sampleUrl: v.fileUrl ? platform.assetUrl(v.fileUrl) : null,
    version: v.version,
    installedAt: Date.now(),
    fromStore: true,
  });

  const previewVoice = async (v: platform.VoiceAssetItem): Promise<void> => {
    if (previewingId) return;
    stopAllVoice();
    setPreviewingId(v.id);
    try {
      await previewInstalled(voiceItemToInstalled(v));
    } catch (e) {
      Alert.alert('试听失败', e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewingId('');
    }
  };

  const activateVoice = (id: string): void => {
    const s = useAppStore.getState();
    s.patch({ activeCloudVoiceId: id });
    scheduleUpload('config');
    if (!s.ttsEnabled) {
      Alert.alert('已启用该音色', '音色已选为当前朗读声音。朗读开关目前是关闭的，可到「设置 → 语音朗读」开启后听到效果。');
    }
  };

  /** 安装音色：拉配置（不含 Key）入库；云音色未配 Key 时引导去设置 */
  const installVoice = async (v: platform.VoiceAssetItem): Promise<void> => {
    setBusyId(v.id);
    try {
      const r = await platform.downloadVoice(v.id);
      const iv: InstalledVoice = {
        id: v.id,
        name: r.name,
        description: v.description ?? undefined,
        config: r.config,
        sampleUrl: r.sampleUrl,
        version: r.version,
        installedAt: Date.now(),
        fromStore: true,
      };
      const s = useAppStore.getState();
      s.patch({ downloadedVoices: [...s.downloadedVoices.filter((x) => x.id !== iv.id), iv] });
      scheduleUpload('config');
      const ready = iv.config.engine !== 'system' && cloudVoiceReady(iv);
      if (iv.config.engine === 'gptsovits' && !ready) {
        Alert.alert(
          '音色已安装',
          `「${iv.name}」由 GPT-SoVITS 引擎合成（免费、无需 Key）。请先在你电脑上部署 GPT-SoVITS 并开启 api_v2（默认端口 9880），再到「设置 → 语音朗读 → 云 TTS 服务配置」选 GPT-SoVITS 引擎并填入电脑局域网地址，详见音色板块的帮助指南。`,
          [
            { text: '去配置', onPress: onOpenSettings },
            { text: '稍后' },
          ],
        );
        return;
      }
      if (iv.config.engine === 'cloud' && !ready) {
        Alert.alert(
          '音色已安装',
          `「${iv.name}」是云音色，需要用你自己的 TTS 服务凭证合成声音。请先到「设置 → 语音朗读 → 云 TTS 服务配置」填写服务地址、模型和 API Key，再回来启用。`,
          [
            { text: '去配置', onPress: onOpenSettings },
            { text: '稍后' },
          ],
        );
        return;
      }
      Alert.alert('音色已安装', `「${iv.name}」已保存到本机，是否立即设为朗读声音？`, [
        { text: '立即启用', onPress: () => activateVoice(iv.id) },
        { text: '试听', onPress: () => void previewVoice(v) },
        { text: '稍后' },
      ]);
    } catch (e) {
      Alert.alert('安装失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  const detailItem = selected;
  // 详情大图：展示卡片预览图（preview_url）
  const detailImgSource = (() => {
    if (!detail || imgError) return null;
    const url = detail.previewUrl || null;
    return url ? platform.assetUrl(url) : null;
  })();
  // 智能体详情：系统提示词（配置优先，其次实体 configSchema）
  const agentPrompt = (() => {
    if (tab !== 'agent' || !detail) return '';
    if (agentConfig && typeof agentConfig.systemPrompt === 'string') return agentConfig.systemPrompt;
    const cs = detail.configSchema;
    return cs && typeof cs.systemPrompt === 'string' ? cs.systemPrompt : '';
  })();
  const depNames = tab === 'agent' && detail ? extractAgentDeps(detail, agentConfig) : [];

  // ── 音色详情派生 ──
  const voiceDetailInstalled = voiceDetail ? downloadedVoices.some((x) => x.id === voiceDetail.id) : false;
  const voiceDetailActive = voiceDetail ? activeCloudVoiceId === voiceDetail.id : false;
  const voiceDetailReady = voiceDetail ? cloudVoiceReady(voiceItemToInstalled(voiceDetail)) : false;
  const voiceCfg = voiceDetail?.configSchema;

  return (
    <View style={[styles.root, visible ? styles.rootActive : styles.rootHidden]} pointerEvents={visible ? 'auto' : 'none'} {...swipeClosePan.panHandlers}>
      <Pressable style={styles.mask} onPress={onClose} />
      <Animated.View style={[styles.drawer, { width: DRAWER_W, transform: [{ translateX: slide }], paddingTop: insets.top + 10, paddingBottom: insets.bottom + 10 }]}>
        {detailItem || voiceDetail ? (
          <View style={{ flex: 1 }}>
            <Pressable style={styles.detailBack} onPress={backToList} hitSlop={8}>
              <Text style={styles.detailBackText}>‹ 返回</Text>
            </Pressable>
            {voiceDetail ? (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
                <View style={styles.voiceHero}>
                  <Text style={styles.voiceHeroIcon}>🎙</Text>
                </View>
                <View style={styles.detailBadgeRow}>
                  <View style={styles.detailBadge}>
                    <Text style={styles.detailBadgeText}>{voiceCfg?.engine === 'cloud' ? '云音色' : '系统音色'}</Text>
                  </View>
                  <Text style={styles.detailVersion}>v{voiceDetail.version}</Text>
                  {voiceDetail.status && voiceDetail.status !== 'approved' && (
                    <Text style={[styles.detailVersion, { color: '#E8803A' }]}>
                      {voiceDetail.status === 'pending' ? ' · 审核中' : ' · 未通过'}
                    </Text>
                  )}
                </View>
                <Text style={styles.detailName}>{voiceDetail.name}</Text>
                <Text style={[styles.detailDesc, !voiceDetail.description && styles.detailDescEmpty]}>
                  {voiceDetail.description || '作者还没有添加描述。'}
                </Text>
                <View style={styles.detailStatsRow}>
                  <Text style={styles.detailStat}>{voiceDetail.downloads} 次下载</Text>
                  {voiceDetail.author?.username ? <Text style={styles.detailStat}>作者:{voiceDetail.author.username}</Text> : null}
                </View>

                <View style={styles.agentCard}>
                  <Text style={styles.agentCardTitle}>音色参数</Text>
                  <View style={styles.depRow}>
                    <Text style={styles.depDot}>•</Text>
                    <Text style={styles.depName}>合成引擎：{voiceCfg?.engine === 'cloud' ? '云端 TTS（OpenAI 兼容 /audio/speech）' : 'Android 系统 TTS（离线）'}</Text>
                  </View>
                  <View style={styles.depRow}>
                    <Text style={styles.depDot}>•</Text>
                    <Text style={styles.depName}>音色 ID：{String(voiceCfg?.voiceId ?? '-')}</Text>
                  </View>
                  {voiceCfg?.engine === 'cloud' && (
                    <>
                      <View style={styles.depRow}>
                        <Text style={styles.depDot}>•</Text>
                        <Text style={styles.depName}>默认模型：{voiceCfg.model?.trim() || '跟随云服务配置'}</Text>
                      </View>
                      <View style={styles.depRow}>
                        <Text style={styles.depDot}>•</Text>
                        <Text style={styles.depName}>服务地址：{voiceCfg.baseUrl?.trim() || '跟随云服务配置'}</Text>
                      </View>
                    </>
                  )}
                  {voiceCfg?.instructions?.trim() ? (
                    <View style={styles.depRow}>
                      <Text style={styles.depDot}>•</Text>
                      <Text style={styles.depName}>风格指令：{voiceCfg.instructions}</Text>
                    </View>
                  ) : null}
                  {voiceCfg?.engine === 'cloud' && !voiceDetailReady && (
                    <Text style={styles.voiceWarn}>该音色需要先在「设置 → 语音朗读 → 云 TTS 服务配置」填入你自己的服务地址与 API Key</Text>
                  )}
                </View>

                <Pressable
                  style={[styles.voicePreviewBtn, previewingId === voiceDetail.id && styles.installDisabled]}
                  disabled={previewingId === voiceDetail.id}
                  onPress={() => void previewVoice(voiceDetail)}
                >
                  <Text style={styles.voicePreviewText}>
                    {previewingId === voiceDetail.id ? '播放中…' : voiceDetail.fileUrl ? '▶ 试听样本' : '▶ 合成试听'}
                  </Text>
                </Pressable>

                {voiceDetailActive ? (
                  <View style={[styles.installBig, styles.installDisabled]}>
                    <Text style={styles.installBigText}>使用中</Text>
                  </View>
                ) : voiceDetailInstalled ? (
                  <Pressable
                    style={[styles.installBig, (!voiceDetailReady && voiceCfg?.engine === 'cloud') && styles.installDisabled]}
                    disabled={!!busyId || (!voiceDetailReady && voiceCfg?.engine === 'cloud')}
                    onPress={() => activateVoice(voiceDetail.id)}
                  >
                    <Text style={styles.installBigText}>
                      {voiceCfg?.engine === 'cloud' && !voiceDetailReady ? '未配置云服务 Key' : '启用该音色'}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.installBig, busyId === voiceDetail.id && styles.installDisabled]}
                    disabled={!!busyId}
                    onPress={() => void installVoice(voiceDetail)}
                  >
                    <Text style={styles.installBigText}>{busyId === voiceDetail.id ? '安装中…' : '安装音色'}</Text>
                  </Pressable>
                )}
              </ScrollView>
            ) : detailLoading || !detail ? (
              <ActivityIndicator style={{ marginTop: 48 }} />
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
                {detailImgSource ? (
                  <Image source={{ uri: detailImgSource }} style={styles.detailImg} resizeMode="cover" onError={() => setImgError(true)} />
                ) : (
                  <View style={styles.detailImgPlaceholder}>
                    <Text style={styles.detailImgLetter}>{detail.name.slice(0, 1)}</Text>
                  </View>
                )}
                <View style={styles.detailBadgeRow}>
                  <View style={styles.detailBadge}>
                    <Text style={styles.detailBadgeText}>{agentTypeLabel(detail.type)}</Text>
                  </View>
                  {typeof detail.version === 'string' && <Text style={styles.detailVersion}>v{detail.version}</Text>}
                </View>
                <Text style={styles.detailName}>{detail.name}</Text>
                <Text style={[styles.detailDesc, !detail.description && styles.detailDescEmpty]}>
                  {detail.description || '作者还没有添加描述。'}
                </Text>
                <View style={styles.detailStatsRow}>
                  {typeof detail.downloads === 'number' && <Text style={styles.detailStat}>{detail.downloads} 次下载</Text>}
                  {typeof detail.rating === 'number' && detail.rating > 0 && (
                    <Text style={styles.detailStat}>★ {detail.rating.toFixed(1)} 评分</Text>
                  )}
                </View>
                {Array.isArray(detail.tags) && detail.tags.length > 0 && (
                  <View style={styles.tagWrap}>
                    {detail.tags.map((t) => (
                      <View key={t} style={styles.tag}>
                        <Text style={styles.tagText}>{t}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {detail.author?.username ? <Text style={styles.detailAuthor}>作者:{detail.author.username}</Text> : null}
                {tab === 'agent' && (
                  <>
                    <View style={styles.agentCard}>
                      <Text style={styles.agentCardTitle}>系统提示词</Text>
                      <Text style={styles.agentPrompt}>{agentPrompt || '该智能体未提供系统提示词。'}</Text>
                    </View>
                    <View style={styles.agentCard}>
                      <Text style={styles.agentCardTitle}>需要的 API / 依赖</Text>
                      {depNames.length > 0 ? (
                        depNames.map((n) => (
                          <View key={n} style={styles.depRow}>
                            <Text style={styles.depDot}>•</Text>
                            <Text style={styles.depName}>{n}</Text>
                          </View>
                        ))
                      ) : (
                        <>
                          <View style={styles.depRow}>
                            <Text style={styles.depDot}>•</Text>
                            <Text style={styles.depName}>LLM 对话 API：使用你自己已配置的 API（安装后会询问绑定哪个，多个才询问，单个自动绑定）</Text>
                          </View>
                          <View style={styles.depRow}>
                            <Text style={styles.depDot}>•</Text>
                            <Text style={styles.depName}>实时时间：由系统每次注入，无需额外配置</Text>
                          </View>
                        </>
                      )}
                    </View>
                    {agentCfgText ? (
                      <View style={styles.agentCard}>
                        <Pressable style={styles.cfgToggle} onPress={() => setShowCfg((v) => !v)} hitSlop={4}>
                          <Text style={styles.agentCardTitle}>{showCfg ? '收起配置 JSON' : '查看配置 JSON'}</Text>
                          <Text style={styles.cfgToggleArrow}>{showCfg ? '▲' : '▼'}</Text>
                        </Pressable>
                        {showCfg && <Text style={styles.cfgJson}>{agentCfgText}</Text>}
                      </View>
                    ) : null}
                  </>
                )}
                <Pressable
                  style={[styles.installBig, busyId === detail.id && styles.installDisabled]}
                  disabled={!!busyId}
                  onPress={() => void install(detail as DetailAsset)}
                >
                  <Text style={styles.installBigText}>
                    {busyId === detail.id ? '安装中…' : '安装'}
                  </Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        ) : (
          <>
            <View style={styles.searchWrap}>
              <Text style={styles.searchIcon}>⌕</Text>
              <TextInput
                style={styles.search}
                placeholder={tab === 'voice' ? '搜索音色…' : '搜索智能体…'}
                placeholderTextColor="#B2B2B2"
                value={search}
                onChangeText={setSearch}
                returnKeyType="search"
                onSubmitEditing={() => void load()}
              />
            </View>

            <View style={styles.tabs}>
              {(['agent', 'voice'] as const).map((t) => (
                <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
                  <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                    {t === 'agent' ? '智能体' : '音色'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tab === 'voice' && (
              <View style={styles.voiceActionRow}>
                <Pressable
                  style={[styles.voicePublishEntry, !token && styles.entryDisabled]}
                  disabled={!token}
                  onPress={() => (token ? setPublishVisible(true) : Alert.alert('请先登录', '发布音色需要先登录平台账号'))}
                >
                  <Text style={styles.voicePublishEntryText}>＋ 发布我的音色</Text>
                </Pressable>
                <Pressable style={styles.voiceHelpEntry} onPress={() => setHelpModal(true)}>
                  <Text style={styles.voiceHelpEntryText}>配置 / 训练说明</Text>
                </Pressable>
              </View>
            )}

            {loading ? (
              <ActivityIndicator style={styles.loading} />
            ) : tab === 'voice' ? (
              <FlatList
                data={voiceItems}
                keyExtractor={(item) => item.id}
                ListEmptyComponent={<Text style={styles.empty}>暂无音色，来发布第一个吧</Text>}
                renderItem={({ item }) => {
                  const installed = downloadedVoices.some((x) => x.id === item.id);
                  const active = activeCloudVoiceId === item.id;
                  const isCloud = item.configSchema?.engine === 'cloud';
                  const meta = `${isCloud ? '云音色' : '系统音色'} · ${item.downloads} 次下载 · v${item.version}`;
                  return (
                    <View style={styles.item}>
                      <Pressable style={{ flex: 1 }} onPress={() => void openDetail(item as unknown as AssetItem)}>
                        <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                        <Text style={styles.itemMeta}>{meta}</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.voiceMiniBtn, previewingId === item.id && styles.installDisabled]}
                        disabled={previewingId === item.id}
                        onPress={() => void previewVoice(item)}
                      >
                        <Text style={styles.voiceMiniText}>{previewingId === item.id ? '…' : '试听'}</Text>
                      </Pressable>
                      {active ? (
                        <View style={[styles.installBtn, styles.installDisabled]}>
                          <Text style={styles.installText}>使用中</Text>
                        </View>
                      ) : installed ? (
                        <Pressable style={styles.installBtn} onPress={() => activateVoice(item.id)}>
                          <Text style={styles.installText}>启用</Text>
                        </Pressable>
                      ) : (
                        <Pressable
                          style={[styles.installBtn, busyId === item.id && styles.installDisabled]}
                          disabled={!!busyId}
                          onPress={() => void installVoice(item)}
                        >
                          <Text style={styles.installText}>{busyId === item.id ? '…' : '安装'}</Text>
                        </Pressable>
                      )}
                    </View>
                  );
                }}
              />
            ) : (
              <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                ListEmptyComponent={<Text style={styles.empty}>暂无资源</Text>}
                renderItem={({ item }) => {
                  const btnDisabled = !!busyId;
                  const btnText = busyId === item.id ? '…' : '安装';
                  const meta = `智能体${typeof item.downloads === 'number' ? ` · ${item.downloads} 次下载` : ''}`;
                  return (
                    <View style={styles.item}>
                      <Pressable style={{ flex: 1 }} onPress={() => void openDetail(item)}>
                        <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                        <Text style={styles.itemMeta}>{meta}</Text>
                      </Pressable>
                      <Pressable style={[styles.installBtn, btnDisabled && styles.installDisabled]} onPress={() => void install(item)} disabled={btnDisabled}>
                        <Text style={styles.installText}>{btnText}</Text>
                      </Pressable>
                    </View>
                  );
                }}
              />
            )}
          </>
        )}

        {/* 底部用户栏：头像 → 用户设置；… → 用户设置 */}
        <View style={styles.footer}>
          <Pressable style={styles.footerLeft} onPress={onOpenSettings} hitSlop={6}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{username.slice(0, 1).toUpperCase()}</Text>
            </View>
            <Text style={styles.footerName} numberOfLines={1}>{username}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {isAdmin && (
              <Pressable onPress={onOpenAdmin} hitSlop={8}>
                <Text style={styles.adminLink}>审核</Text>
              </Pressable>
            )}
            <Pressable style={styles.footerMore} onPress={onOpenSettings} hitSlop={8}>
              <Text style={styles.footerMoreText}>···</Text>
            </Pressable>
          </View>
        </View>

        {/* 安装智能体后选择「对话 API」的底部弹层 */}
        <Modal transparent animationType="fade" visible={apiPickVisible} onRequestClose={() => setApiPickVisible(false)}>
          <View style={styles.apiPickMask}>
            <View style={styles.apiPickPanel}>
              <Text style={styles.apiPickTitle}>选择对话 API</Text>
              <Text style={styles.apiPickSub}>该智能体将使用所选 API 的 Key / 接口 / 模型进行聊天</Text>
              {apiCandidates.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.apiPickRow}
                  onPress={() => {
                    applyApiToProfile(apiPickTargetId, p);
                    setApiPickVisible(false);
                    Alert.alert('已配置', `已使用「${p.name}」的 API`);
                  }}>
                  <Text style={styles.apiPickName} numberOfLines={1}>{p.name}</Text>
                  {p.model ? <Text style={styles.apiPickModel} numberOfLines={1}>{p.model}</Text> : null}
                </Pressable>
              ))}
              <Pressable style={styles.apiPickCancel} onPress={() => setApiPickVisible(false)} hitSlop={8}>
                <Text style={styles.apiPickCancelText}>暂不选择，稍后在智能体管理中配置</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 发布音色 */}
        <PublishVoiceModal
          visible={publishVisible}
          onClose={() => setPublishVisible(false)}
          onPublished={() => {
            setPublishVisible(false);
            void load();
          }}
        />

        {/* 音色配置 / 训练说明 */}
        <Modal transparent animationType="fade" visible={helpModal} onRequestClose={() => setHelpModal(false)}>
          <View style={styles.apiPickMask}>
            <View style={[styles.apiPickPanel, { maxHeight: '78%' }]}>
              <Text style={styles.apiPickTitle}>音色如何配置与训练</Text>
              <ScrollView style={{ marginTop: 8 }} showsVerticalScrollIndicator={false}>
                {VOICE_GUIDE.map((section, i) => (
                  <View key={i} style={{ marginBottom: 12 }}>
                    <Text style={styles.guideH}>{section.h}</Text>
                    {section.ps.map((p, j) => (
                      <Text key={j} style={styles.guideP}>{p}</Text>
                    ))}
                  </View>
                ))}
              </ScrollView>
              <Pressable style={[styles.installBig, { marginTop: 10 }]} onPress={() => setHelpModal(false)}>
                <Text style={styles.installBigText}>我知道了</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 900, elevation: 900 },
  rootActive: {},
  rootHidden: { display: 'none' },
  mask: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  drawer: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#F7F8FA', borderTopRightRadius: 18, borderBottomRightRadius: 18, paddingHorizontal: 14 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EDEEF1', borderRadius: 20, paddingHorizontal: 12, height: 38 },
  searchIcon: { fontSize: 17, color: '#999', marginRight: 6, marginTop: -2 },
  search: { flex: 1, fontSize: 14, color: '#333', paddingVertical: 0 },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 4 },
  tab: { borderRadius: 14, backgroundColor: '#ECEDEF', paddingVertical: 5, paddingHorizontal: 14 },
  tabActive: { backgroundColor: '#4D6BFE' },
  tabText: { fontSize: 13, color: '#666' },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  loading: { marginTop: 40 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40, fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginTop: 8 },
  itemName: { fontSize: 14, fontWeight: '600', color: '#333' },
  itemMeta: { fontSize: 11, color: '#999', marginTop: 2 },
  installBtn: { backgroundColor: '#4D6BFE', borderRadius: 14, paddingVertical: 5, paddingHorizontal: 14, marginLeft: 8 },
  installDisabled: { backgroundColor: '#D5D8DE' },
  installText: { color: '#fff', fontSize: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#E5E6EA', paddingTop: 10, marginTop: 6 },
  footerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#4D6BFE', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  footerName: { fontSize: 14, color: '#333', fontWeight: '600', marginLeft: 8, flex: 1 },
  adminLink: { fontSize: 13, color: '#4D6BFE', marginRight: 12 },
  footerMore: { paddingHorizontal: 6 },
  footerMoreText: { fontSize: 16, color: '#666', letterSpacing: 1 },
  // --- 详情视图 ---
  detailBack: { marginBottom: 10, alignSelf: 'flex-start' },
  detailBackText: { fontSize: 15, color: '#4D6BFE', fontWeight: '600' },
  detailImg: { width: '100%', height: 200, borderRadius: 12, backgroundColor: '#E9EBF0' },
  detailImgPlaceholder: { width: '100%', height: 200, borderRadius: 12, backgroundColor: '#E4E7EE', alignItems: 'center', justifyContent: 'center' },
  detailImgLetter: { fontSize: 56, color: '#B7BCC9', fontWeight: '700' },
  detailBadgeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  detailBadge: { backgroundColor: '#EDEFF3', borderRadius: 8, paddingVertical: 3, paddingHorizontal: 10 },
  detailBadgeText: { fontSize: 12, color: '#666', fontWeight: '600' },
  detailVersion: { fontSize: 12, color: '#999', marginLeft: 8 },
  detailName: { fontSize: 19, fontWeight: '700', color: '#1A1A1A', marginTop: 10 },
  detailDesc: { fontSize: 13, color: '#444', lineHeight: 20, marginTop: 8 },
  detailDescEmpty: { color: '#999' },
  detailStatsRow: { flexDirection: 'row', gap: 14, marginTop: 10 },
  detailStat: { fontSize: 12, color: '#7A7F8C' },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  tag: { backgroundColor: '#F0F4FF', borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 },
  tagText: { fontSize: 11, color: '#4D6BFE' },
  detailAuthor: { fontSize: 12, color: '#999', marginTop: 10 },
  installBig: { backgroundColor: '#4D6BFE', borderRadius: 24, alignItems: 'center', paddingVertical: 12, marginTop: 18 },
  installBigText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  // --- 智能体详情附加信息 ---
  agentCard: { marginTop: 14, backgroundColor: '#F7F8FA', borderRadius: 10, padding: 12 },
  agentCardTitle: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6 },
  agentPrompt: { fontSize: 13, lineHeight: 20, color: '#444' },
  agentHint: { fontSize: 12, color: '#999' },
  depRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 2 },
  depDot: { fontSize: 12, color: '#4D6BFE', marginRight: 6, marginTop: 2 },
  depName: { fontSize: 12, color: '#555', flex: 1, lineHeight: 16 },
  cfgToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cfgToggleArrow: { fontSize: 11, color: '#4D6BFE' },
  cfgJson: { marginTop: 8, fontFamily: 'monospace', fontSize: 11, lineHeight: 16, color: '#333' },
  // --- 选择对话 API 弹层 ---
  apiPickMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 28 },
  apiPickPanel: { backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  apiPickTitle: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  apiPickSub: { fontSize: 12, color: '#8A8F99', marginTop: 4, marginBottom: 10 },
  apiPickRow: { backgroundColor: '#F5F6F8', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginTop: 8 },
  apiPickName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  apiPickModel: { fontSize: 12, color: '#7A7F8C', marginTop: 2 },
  apiPickCancel: { marginTop: 14, alignItems: 'center' },
  apiPickCancelText: { fontSize: 13, color: '#4D6BFE' },
  // ── 音色板块 ──
  voiceHero: { width: '100%', height: 120, borderRadius: 12, backgroundColor: '#E9EDFE', alignItems: 'center', justifyContent: 'center' },
  voiceHeroIcon: { fontSize: 48 },
  voicePreviewBtn: { borderWidth: 1, borderColor: '#4D6BFE', borderRadius: 24, alignItems: 'center', paddingVertical: 10, marginTop: 16 },
  voicePreviewText: { color: '#4D6BFE', fontSize: 14, fontWeight: '600' },
  voiceWarn: { fontSize: 12, color: '#E8803A', lineHeight: 17, marginTop: 8 },
  voiceActionRow: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 2 },
  voicePublishEntry: { flex: 1, backgroundColor: '#4D6BFE', borderRadius: 14, paddingVertical: 7, alignItems: 'center' },
  voiceHelpEntry: { backgroundColor: '#ECEDEF', borderRadius: 14, paddingVertical: 7, paddingHorizontal: 12, justifyContent: 'center' },
  voicePublishEntryText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  voiceHelpEntryText: { color: '#555', fontSize: 12 },
  entryDisabled: { backgroundColor: '#D5D8DE' },
  voiceMiniBtn: { borderWidth: 1, borderColor: '#4D6BFE', borderRadius: 14, paddingVertical: 5, paddingHorizontal: 10, marginLeft: 8 },
  voiceMiniText: { color: '#4D6BFE', fontSize: 12 },
  guideH: { fontSize: 13, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 },
  guideP: { fontSize: 12, color: '#555', lineHeight: 18 },
  // ── 发布音色弹层 ──
  pubLabel: { fontSize: 12, color: '#666', fontWeight: '600', marginTop: 10, marginBottom: 4 },
  pubInput: { backgroundColor: '#F2F3F6', borderRadius: 8, paddingHorizontal: 10, fontSize: 13, color: '#222', paddingVertical: 7 },
  pubArea: { height: 92, textAlignVertical: 'top' },
  pubError: { color: '#E5484D', fontSize: 12, marginTop: 6, lineHeight: 16 },
  pubHint: { color: '#8A8F99', fontSize: 11, marginTop: 4, lineHeight: 15 },
});
