/**
 * DeepSeek 式侧边抽屉（替代原商店 Tab）：左上汉堡按钮或左缘右滑打开；
 * 内容 = 资源商店（宠物/智能体搜索、安装），最下层左侧用户头像 → 用户设置，右侧 … → 用户设置。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as platform from '../api/platform';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';
import { cacheAssetFile, normalizeFileUrl } from '../pet/petFiles';
import { normalizeFormat, type AssetItem } from '../types';

const DRAWER_W = Math.min(Dimensions.get('window').width * 0.82, 340);

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
  const [tab, setTab] = useState<'pet' | 'agent'>('pet');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const currentPetId = useAppStore((s) => s.petAsset?.id);
  const username = useAppStore((s) => s.user?.username ?? '用户');
  const isAdmin = useAppStore((s) => s.user?.role === 'admin');
  const slide = useRef(new Animated.Value(-DRAWER_W)).current;

  // 打开/关闭滑入滑出
  useEffect(() => {
    Animated.timing(slide, { toValue: visible ? 0 : -DRAWER_W - 20, duration: 220, useNativeDriver: true }).start();
  }, [visible, slide]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await platform.listAssets(tab, search.trim() || undefined);
      setItems(res.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const install = async (item: AssetItem): Promise<void> => {
    setBusyId(item.id);
    try {
      if (tab === 'pet') {
        const detail = await platform.getAssetDetail('pet', item.id);
        await platform.downloadAsset('pet', item.id);
        const format = normalizeFormat(detail.format);
        const fileUrl = normalizeFileUrl(detail.fileUrl);
        let localPath: string | undefined;
        if (format === 'image') {
          try {
            localPath = await cacheAssetFile(detail.id, fileUrl);
          } catch {
            localPath = undefined;
          }
        }
        const ref = { id: detail.id, name: detail.name, format, fileUrl, localPath };
        const store = useAppStore.getState();
        const list = store.downloadedPets.filter((p) => p.id !== ref.id);
        store.patch({ petAsset: ref, downloadedPets: [...list, ref] });
        scheduleUpload('config');
        Alert.alert('已安装', `${detail.name} 已设为当前宠物`);
      } else {
        const detail = await platform.getAssetDetail('agent', item.id);
        await platform.downloadAsset('agent', item.id);
        const res = await fetch(platform.assetUrl(detail.fileUrl));
        const config = (await res.json().catch(() => ({}))) as { name?: string; systemPrompt?: string };
        const agentName = config.name ?? detail.name;
        const agentPrompt = String(config.systemPrompt ?? '').trim();
        const store = useAppStore.getState();
        // 与桌面端一致：智能体提示词写入当前 API 档案的系统提示词（作为人格主体）
        const profileId = store.llmActiveProfileId || store.llmProfiles[0]?.id;
        const llmProfiles = agentPrompt
          ? store.llmProfiles.map((p) => (p.id === profileId ? { ...p, systemPrompt: agentPrompt } : p))
          : store.llmProfiles;
        store.patch({ installedAgent: { name: agentName, systemPrompt: agentPrompt }, llmProfiles });
        scheduleUpload('config');
        Alert.alert('已安装', `${agentName} 已应用为聊天人设${agentPrompt ? '（写入当前 API 档案的系统提示词）' : '（该智能体未附带提示词）'}`);
      }
    } catch (e) {
      Alert.alert('安装失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  return (
    <View style={[styles.root, visible ? styles.rootActive : styles.rootHidden]} pointerEvents={visible ? 'auto' : 'none'}>
      <Pressable style={styles.mask} onPress={onClose} />
      <Animated.View style={[styles.drawer, { width: DRAWER_W, transform: [{ translateX: slide }], paddingTop: insets.top + 10, paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.search}
            placeholder="搜索宠物 / 智能体…"
            placeholderTextColor="#B2B2B2"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            onSubmitEditing={() => void load()}
          />
        </View>

        <View style={styles.tabs}>
          {(['pet', 'agent'] as const).map((t) => (
            <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t === 'pet' ? '宠物' : '智能体'}</Text>
            </Pressable>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator style={styles.loading} />
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>暂无资源</Text>}
            renderItem={({ item }) => {
              const isCurrent = tab === 'pet' && currentPetId === item.id;
              return (
                <View style={styles.item}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.itemMeta}>
                      {normalizeFormat(item.format) === 'image' ? '静态形象' : normalizeFormat(item.format) === 'pack' ? '帧动画' : normalizeFormat(item.format) === 'live2d' ? 'Live2D' : '3D 模型'}
                      {typeof item.downloads === 'number' ? ` · ${item.downloads} 次下载` : ''}
                    </Text>
                  </View>
                  <Pressable style={[styles.installBtn, isCurrent && styles.installDisabled]} onPress={() => void install(item)} disabled={!!busyId || isCurrent}>
                    <Text style={styles.installText}>{isCurrent ? '当前' : busyId === item.id ? '…' : '安装'}</Text>
                  </Pressable>
                </View>
              );
            }}
          />
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
});
