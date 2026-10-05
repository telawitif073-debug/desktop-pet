/**
 * 宠物页：展示当前宠物形象（图片 / 帧序列 / Live2D / 3D 占位），四维生命体征与互动。
 * - 形象经 PetView 渲染（未安装时提示去商店「宠物」板块领养）
 * - 喂食/玩耍/休息驱动 petState 四维（规则在共享包 pet/domain），并防抖上传 pet_state
 * - Android 可开系统级悬浮窗（聊其他应用时也显示宠物；见 native/OverlayPet.ts）
 */
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PetView from '../pet/PetView';
import { petInteract, type PetAction } from '../chat/interact';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';
// 展示视图模型（状态行/文案）来自共享包 pet/ui，与桌面端同一份
import { interactionHint, vitalsRows } from '../../../pet/ui';
import { checkOverlayPermission, isOverlaySupported, requestOverlayPermission, startOverlay, stopOverlay } from '../native/OverlayPet';

const ACTION_LABEL: Record<PetAction, string> = { feed: '🍚 喂食', play: '🎾 玩耍', rest: '😴 休息' };

export default function PetScreen({ onOpenStore }: { onOpenStore?: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const petAsset = useAppStore((s) => s.petAsset);
  const petState = useAppStore((s) => s.petState);
  const [overlayOn, setOverlayOn] = useState(false);

  const act = (action: PetAction): void => {
    const store = useAppStore.getState();
    if (action === 'feed') store.feedPet();
    else if (action === 'play') store.playWithPet();
    else store.restPet();
    scheduleUpload('pet_state');
    petInteract(action);
  };

  const toggleOverlay = async (): Promise<void> => {
    if (overlayOn) {
      await stopOverlay();
      setOverlayOn(false);
      return;
    }
    if (!(await checkOverlayPermission())) {
      await requestOverlayPermission();
      Alert.alert('请先授权', '请在系统设置里允许「在其他应用上层显示」，再回来打开悬浮窗。');
      return;
    }
    const ok = await startOverlay(petAsset);
    setOverlayOn(ok);
    if (!ok) Alert.alert('无法打开悬浮窗', '请确认已安装宠物形象，并已授予悬浮窗权限。');
  };

  const rows = vitalsRows(petState);

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <Text style={styles.title}>宠物</Text>

      <View style={styles.stage}>
        <PetView asset={petAsset} size={220} />
      </View>
      <Text style={styles.name}>{petAsset ? petAsset.name : '还没有宠物'}</Text>
      <Text style={styles.hint}>{interactionHint(petState)}</Text>

      <View style={styles.vitals}>
        {rows.map((r) => (
          <View key={r.key} style={styles.vitalRow}>
            <Text style={styles.vitalLabel}>{r.label}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${r.percent}%`, backgroundColor: r.alert ? '#E8803A' : '#4D6BFE' }]} />
            </View>
            <Text style={styles.vitalValue}>{Math.round(r.value)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        {(['feed', 'play', 'rest'] as const).map((k) => (
          <Pressable key={k} style={styles.actionBtn} onPress={() => act(k)}>
            <Text style={styles.actionText}>{ACTION_LABEL[k]}</Text>
          </Pressable>
        ))}
      </View>

      {isOverlaySupported() && (
        <Pressable style={[styles.secondaryBtn, overlayOn && styles.secondaryBtnOn]} onPress={() => void toggleOverlay()}>
          <Text style={styles.secondaryText}>{overlayOn ? '关闭系统悬浮窗' : '开启系统悬浮窗（聊其他应用也陪着）'}</Text>
        </Pressable>
      )}

      <Pressable style={styles.storeBtn} onPress={() => onOpenStore?.()}>
        <Text style={styles.storeBtnText}>去商店「宠物」板块</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#1A1A1A', marginTop: 4 },
  stage: { marginTop: 16, alignItems: 'center' },
  name: { fontSize: 17, fontWeight: '600', color: '#1A1A1A', textAlign: 'center', marginTop: 12 },
  hint: { fontSize: 13, color: '#999', textAlign: 'center', marginTop: 6 },
  vitals: { marginTop: 20 },
  vitalRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  vitalLabel: { width: 44, fontSize: 13, color: '#666' },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#EFF1F4', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  vitalValue: { width: 36, textAlign: 'right', fontSize: 12, color: '#666' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actionBtn: { flex: 1, backgroundColor: '#F2F3F5', borderRadius: 12, alignItems: 'center', paddingVertical: 12 },
  actionText: { fontSize: 14, color: '#333' },
  secondaryBtn: { marginTop: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: '#4D6BFE', borderRadius: 20, alignItems: 'center', paddingVertical: 10 },
  secondaryBtnOn: { backgroundColor: '#EAF0FF' },
  secondaryText: { fontSize: 13, color: '#4D6BFE' },
  storeBtn: { marginTop: 16, backgroundColor: '#4D6BFE', borderRadius: 24, alignItems: 'center', paddingVertical: 12 },
  storeBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
