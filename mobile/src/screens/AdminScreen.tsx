/** 审核工作台（仅管理员）：查看待审核智能体，通过或驳回，对齐平台 Web 端 AdminPage */
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { approveAsset, listAssets, rejectAsset } from '../api/platform';
import { useAppStore } from '../store/appStore';
import type { AssetItem } from '../types';

function AssetCard({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: AssetItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}): React.JSX.Element {
  const author = (item.author as { username?: string } | undefined)?.username ?? '未知';
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.tag}>待审核</Text>
      </View>
      <Text style={styles.desc} numberOfLines={2}>
        {item.description || '暂无描述'}
      </Text>
      <Text style={styles.meta}>作者：{author}</Text>
      <View style={styles.btnRow}>
        <Pressable style={[styles.btn, styles.btnApprove, busy && styles.btnDisabled]} onPress={onApprove} disabled={busy}>
          <Text style={styles.btnApproveText}>通过</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnReject, busy && styles.btnDisabled]} onPress={onReject} disabled={busy}>
          <Text style={styles.btnRejectText}>驳回</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function AdminScreen(): React.JSX.Element {
  const user = useAppStore((s) => s.user);
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const res = await listAssets({ status: 'pending', limit: 50, sort: 'createdAt' });
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateStatus = async (asset: AssetItem, action: 'approve' | 'reject'): Promise<void> => {
    if (busyId) return;
    setBusyId(asset.id);
    try {
      await (action === 'approve' ? approveAsset(asset.id) : rejectAsset(asset.id));
      setItems((list) => list.filter((x) => x.id !== asset.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  if (user?.role !== 'admin') {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>仅管理员可访问审核工作台</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.tabs, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.tabTitle}>待审智能体</Text>
        <Pressable style={styles.reload} onPress={() => void load()}>
          <Text style={styles.reloadText}>刷新</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={items}
        keyExtractor={(item) => item.id}
        refreshing={loading}
        onRefresh={() => void load()}
        ListEmptyComponent={
          loading ? undefined : <Text style={styles.empty}>{error ? '加载失败，下拉重试' : '当前没有待审核资源'}</Text>
        }
        renderItem={({ item }) => (
          <AssetCard
            item={item}
            busy={busyId === item.id}
            onApprove={() => void updateStatus(item, 'approve')}
            onReject={() => void updateStatus(item, 'reject')}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F8FA' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  centerText: { color: '#999', fontSize: 14 },
  tabs: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  tabTitle: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  reload: { marginLeft: 'auto', paddingHorizontal: 8 },
  reloadText: { fontSize: 13, color: '#1C6EF2' },
  error: { color: '#E5484D', fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 24 },
  empty: { textAlign: 'center', color: '#AAA', marginTop: 60, fontSize: 13 },
  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1, fontSize: 15, fontWeight: '600', color: '#333' },
  tag: { marginLeft: 8, fontSize: 11, color: '#B7791F', backgroundColor: '#FFF7E6', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  desc: { fontSize: 13, color: '#666', marginTop: 6, lineHeight: 19 },
  meta: { fontSize: 11, color: '#AAA', marginTop: 6 },
  btnRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  btn: { borderRadius: 8, paddingVertical: 7, paddingHorizontal: 18, marginLeft: 10 },
  btnApprove: { backgroundColor: '#1C6EF2' },
  btnApproveText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  btnReject: { borderWidth: 1, borderColor: '#E5484D' },
  btnRejectText: { color: '#E5484D', fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
});
