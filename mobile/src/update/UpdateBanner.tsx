/** 更新提醒横幅（安静模式）：顶部细条，可关闭；同一版本关闭后 24h 内不再出现，不阻塞任何操作 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';

const SNOOZE_MS = 24 * 60 * 60 * 1000;

export default function UpdateBanner(): React.JSX.Element | null {
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const panelVisible = useAppStore((s) => s.updatePanelVisible);
  const snooze = useAppStore((s) => s.updateSnooze);
  const insets = useSafeAreaInsets();

  if (!updateAvailable || panelVisible) return null;
  // 强制更新不显示横幅（直接弹面板）；静默期内不显示
  if (updateAvailable.forced) return null;
  if (snooze && snooze.versionName === updateAvailable.versionName && Date.now() < snooze.until) return null;

  return (
    <View style={[styles.wrap, { top: insets.top + 6 }]} pointerEvents="box-none">
      <Pressable
        style={styles.pill}
        onPress={() => useAppStore.getState().patch({ updatePanelVisible: true })}>
        <Text style={styles.text}>新版本 {updateAvailable.versionName} 可用</Text>
        <Text style={styles.action}>更新</Text>
      </Pressable>
      <Pressable
        style={styles.close}
        hitSlop={8}
        onPress={() =>
          useAppStore
            .getState()
            .patch({ updateSnooze: { versionName: updateAvailable.versionName, until: Date.now() + SNOOZE_MS } })
        }>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(28,110,242,0.92)',
    borderRadius: 16,
    paddingVertical: 6,
    paddingLeft: 14,
    paddingRight: 8,
  },
  text: { color: '#fff', fontSize: 12 },
  action: { color: '#fff', fontSize: 12, fontWeight: '700', marginLeft: 8, backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  close: { marginLeft: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 12, color: '#666' },
});
