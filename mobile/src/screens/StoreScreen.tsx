/** 商店页：宠物/智能体列表，安装宠物=设为当前形象（帧包懒下载），安装智能体=应用为聊天人设 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as platform from '../api/platform';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';
import { cacheAssetFile, normalizeFileUrl } from '../pet/petFiles';
import { normalizeFormat, type AssetItem } from '../types';

type StoreTab = 'pet' | 'agent';

export default function StoreScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<StoreTab>('pet');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const currentPetId = useAppStore((s) => s.petAsset?.id);

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
    void load();
  }, [load]);

  const install = async (item: AssetItem): Promise<void> => {
    setBusyId(item.id);
    try {
      if (tab === 'pet') {
        const detail = await platform.getAssetDetail('pet', item.id);
        // 触发下载计数（云端资源库自动收录，换设备可重新下载）
        await platform.downloadAsset('pet', item.id);
        const format = normalizeFormat(detail.format);
        // 相对路径 + 本地缓存：换服务器/隧道不断链，离线也能显示
        const fileUrl = normalizeFileUrl(detail.fileUrl);
        let localPath: string | undefined;
        if (format === 'image') {
          try {
            localPath = await cacheAssetFile(detail.id, fileUrl);
          } catch {
            localPath = undefined; // 缓存失败不阻塞安装，渲染时走远程
          }
        }
        const ref = { id: detail.id, name: detail.name, format, fileUrl, localPath };
        const store = useAppStore.getState();
        const list = store.downloadedPets.filter((p) => p.id !== ref.id);
        store.patch({ petAsset: ref, downloadedPets: [...list, ref] });
        // 当前宠物引用变更：防抖上传云端（桌面端/换机登录可恢复同一只）
        scheduleUpload('config');
        Alert.alert('已安装', `${detail.name} 已设为当前宠物`);
      } else {
        const detail = await platform.getAssetDetail('agent', item.id);
        await platform.downloadAsset('agent', item.id);
        // 智能体配置 JSON（含 name/systemPrompt）公开直出，直接解析
        const res = await fetch(platform.assetUrl(detail.fileUrl));
        const config = (await res.json().catch(() => ({}))) as { name?: string; systemPrompt?: string };
        useAppStore.getState().patch({
          installedAgent: { name: config.name ?? detail.name, systemPrompt: config.systemPrompt ?? '' },
        });
        scheduleUpload('config');
        Alert.alert('已安装', `${config.name ?? detail.name} 将作为聊天人设`);
      }
    } catch (e) {
      Alert.alert('安装失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.tabs, { paddingTop: insets.top + 10 }]}>
        <Pressable style={[styles.tab, tab === 'pet' && styles.tabActive]} onPress={() => setTab('pet')}>
          <Text style={[styles.tabText, tab === 'pet' && styles.tabTextActive]}>宠物</Text>
        </Pressable>
        <Pressable style={[styles.tab, tab === 'agent' && styles.tabActive]} onPress={() => setTab('agent')}>
          <Text style={[styles.tabText, tab === 'agent' && styles.tabTextActive]}>智能体</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.search}
        placeholder="搜索资源"
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
        onSubmitEditing={() => void load()}
      />

      {loading ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
          ListEmptyComponent={<Text style={styles.empty}>暂无资源</Text>}
          renderItem={({ item }) => {
            const isCurrent = tab === 'pet' && currentPetId === item.id;
            return (
              <View style={styles.item}>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName}>{item.name}</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  tab: { borderRadius: 8, backgroundColor: '#F2F3F5', paddingVertical: 6, paddingHorizontal: 18 },
  tabActive: { backgroundColor: '#1C6EF2' },
  tabText: { fontSize: 14, color: '#666' },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  search: { margin: 12, borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  loading: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingBottom: 20 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 40 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 15, fontWeight: '600', color: '#333' },
  itemMeta: { fontSize: 12, color: '#999', marginTop: 2 },
  installBtn: { backgroundColor: '#1C6EF2', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 16 },
  installDisabled: { backgroundColor: '#DDD' },
  installText: { color: '#fff', fontSize: 13 },
});
