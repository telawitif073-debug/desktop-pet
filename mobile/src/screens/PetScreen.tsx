/** 宠物页：形象展示 + 我的宠物管理（切换/删除）+ 状态条 + 喂食/玩耍/休息 */
import React, { useEffect } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PetView from '../pet/PetView';
import { cacheAssetFile, removePetFiles } from '../pet/petFiles';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';

function StateBar({ label, value, color }: { label: string; value: number; color: string }): React.JSX.Element {
  return (
    <View style={styles.barRow}>
      <Text style={styles.barLabel}>{label}</Text>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.barValue}>{Math.round(value)}</Text>
    </View>
  );
}

export default function PetScreen(): React.JSX.Element {
  const petAsset = useAppStore((s) => s.petAsset);
  const petState = useAppStore((s) => s.petState);
  const downloadedPets = useAppStore((s) => s.downloadedPets);
  const baseUrl = useAppStore((s) => s.baseUrl);
  const insets = useSafeAreaInsets();

  // 自然衰减：每 5s 一次，与桌面端节奏一致；衰减变更走 60s 防抖上传
  useEffect(() => {
    const timer = setInterval(() => {
      useAppStore.getState().decay();
      scheduleUpload('pet_state');
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // 旧版本安装的 image 宠物没有本地缓存：自动补缓存（离线可用）；地址修正后自动重试
  useEffect(() => {
    const store = useAppStore.getState();
    const pet = store.petAsset;
    if (!pet || pet.format !== 'image' || pet.localPath) return;
    let alive = true;
    cacheAssetFile(pet.id, pet.fileUrl)
      .then((path) => {
        if (!alive) return;
        const cur = useAppStore.getState();
        const updated = { ...pet, localPath: path };
        cur.patch({
          petAsset: updated,
          downloadedPets: cur.downloadedPets.map((p) => (p.id === pet.id ? updated : p)),
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [petAsset?.id, petAsset?.localPath, baseUrl]);

  const act = (action: 'feed' | 'play' | 'rest'): void => {
    useAppStore.getState()[action]();
    scheduleUpload('pet_state');
  };

  const switchPet = (id: string): void => {
    const target = useAppStore.getState().downloadedPets.find((p) => p.id === id);
    if (!target || useAppStore.getState().petAsset?.id === id) return;
    useAppStore.getState().patch({ petAsset: target });
    scheduleUpload('config');
  };

  const removePet = (id: string): void => {
    const store = useAppStore.getState();
    const pet = store.downloadedPets.find((p) => p.id === id);
    if (!pet) return;
    Alert.alert('删除宠物', `把「${pet.name}」从本机删除？不影响商店里其他人`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const rest = store.downloadedPets.filter((p) => p.id !== id);
          void removePetFiles(id);
          const nextCurrent = store.petAsset?.id === id ? rest[0] ?? null : store.petAsset;
          store.patch({ downloadedPets: rest, petAsset: nextCurrent });
          scheduleUpload('config');
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }]}>
      <Text style={styles.header}>{petAsset?.name ?? '宠物'}</Text>

      <PetView asset={petAsset} size={220} />

      <Text style={styles.manageTitle}>我的宠物（{downloadedPets.length}）</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {downloadedPets.map((pet) => {
          const current = petAsset?.id === pet.id;
          return (
            <View key={pet.id} style={[styles.chip, current && styles.chipCurrent]}>
              <Pressable onPress={() => switchPet(pet.id)} onLongPress={() => removePet(pet.id)}>
                <Text style={[styles.chipText, current && styles.chipTextCurrent]}>
                  {current ? '✓ ' : ''}
                  {pet.name}
                </Text>
              </Pressable>
              <Pressable style={styles.chipDelete} hitSlop={6} onPress={() => removePet(pet.id)}>
                <Text style={styles.chipDeleteText}>×</Text>
              </Pressable>
            </View>
          );
        })}
        <View style={[styles.chip, styles.chipGhost]}>
          <Text style={styles.chipGhostText}>去商店领养更多</Text>
        </View>
      </ScrollView>

      <View style={styles.bars}>
        <StateBar label="饱足" value={petState.hunger} color="#F5A623" />
        <StateBar label="心情" value={petState.mood} color="#7ED37E" />
        <StateBar label="精力" value={petState.energy} color="#4A9DF8" />
        <StateBar label="好感" value={petState.affection} color="#F06292" />
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.actionBtn} onPress={() => act('feed')}>
          <Text style={styles.actionText}>喂食</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => act('play')}>
          <Text style={styles.actionText}>玩耍</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => act('rest')}>
          <Text style={styles.actionText}>休息</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>喂食：饱足+15 好感+2；玩耍：心情+20 精力-10 好感+5；休息：精力+30 饥饿-5</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 32 },
  header: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  manageTitle: { fontSize: 12, color: '#888', marginTop: 14, marginBottom: 8 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F3F5', borderRadius: 16, paddingLeft: 12, paddingRight: 6, paddingVertical: 6 },
  chipCurrent: { backgroundColor: '#E3EEFF' },
  chipText: { fontSize: 13, color: '#555' },
  chipTextCurrent: { color: '#1C6EF2', fontWeight: '600' },
  chipDelete: { marginLeft: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: '#DDD', alignItems: 'center', justifyContent: 'center' },
  chipDeleteText: { fontSize: 13, color: '#888', lineHeight: 15 },
  chipGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#DDD', borderStyle: 'dashed' },
  chipGhostText: { fontSize: 13, color: '#AAA' },
  bars: { marginTop: 16 },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  barLabel: { width: 40, fontSize: 13, color: '#555' },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#EEE', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  barValue: { width: 32, textAlign: 'right', fontSize: 12, color: '#888' },
  actions: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 20 },
  actionBtn: { backgroundColor: '#1C6EF2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 26 },
  actionText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  note: { marginTop: 16, fontSize: 11, color: '#AAA', textAlign: 'center', lineHeight: 18 },
});
