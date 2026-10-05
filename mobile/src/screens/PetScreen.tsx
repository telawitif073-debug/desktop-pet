/**
 * 宠物页（占位骨架）：宠物主体功能模块在移动端的入口。
 *
 * 当前阶段只落地「入口 + 占位信息 + 商店「宠物」板块跳转」，
 * 悬浮形象（FloatingPet）、动作播放、本地解包等留待后续阶段实现。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';

export default function PetScreen({ onOpenStore }: { onOpenStore?: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const petAsset = useAppStore((s) => s.petAsset);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>宠物</Text>
      {petAsset ? (
        <Text style={styles.desc}>当前宠物：{petAsset.name}</Text>
      ) : (
        <Text style={styles.empty}>还没有宠物。到商店「宠物」板块下载一个吧，后续版本它会以悬浮形象陪你。</Text>
      )}
      <Pressable style={styles.storeBtn} onPress={() => onOpenStore?.()}>
        <Text style={styles.storeBtnText}>去商店「宠物」板块</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#1A1A1A' },
  desc: { fontSize: 14, color: '#444', marginTop: 14 },
  empty: { fontSize: 14, color: '#999', lineHeight: 22, marginTop: 14 },
  storeBtn: { marginTop: 20, backgroundColor: '#4D6BFE', borderRadius: 24, alignItems: 'center', paddingVertical: 12 },
  storeBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
