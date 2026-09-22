/**
 * 主壳：应用直接进入聊天界面（DeepSeek 式单页）。
 * - 宠物以应用内悬浮形态常驻最上层（FloatingPet，可拖动、三连击互动）
 * - 左上汉堡或左缘右滑打开商店抽屉（StoreDrawer）
 * - 抽屉底部头像/… → 用户设置（DeepSeek 样式设置页，全屏弹层）
 * - 管理员可从抽屉进入内容审核（AdminScreen，全屏弹层）
 */
import React, { useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ChatScreen from '../screens/ChatScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AdminScreen from '../screens/AdminScreen';
import StoreDrawer from '../components/StoreDrawer';
import FloatingPet from '../pet/FloatingPet';

export default function MainShell(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  // 左缘右滑打开抽屉：手势只挂在 20pt 宽的独立触摸条上（避开 header/汉堡按钮），
  // 绝不挂全屏根 View——捕获阶段手势会抢走子组件（汉堡等）的点击
  const edgePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dx > 30 && Math.abs(g.dy) < 24,
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 30) setDrawerOpen(true);
      },
    }),
  ).current;

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      <ChatScreen onOpenDrawer={() => setDrawerOpen(true)} />
      <FloatingPet />
      <StoreDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenSettings={() => {
          setDrawerOpen(false);
          setSettingsOpen(true);
        }}
        onOpenAdmin={() => {
          setDrawerOpen(false);
          setAdminOpen(true);
        }}
      />
      {/* 左缘右滑触摸条：top 避开 header（不挡汉堡），抽屉打开时卸载（不挡抽屉） */}
      {!drawerOpen && (
        <View
          style={{ position: 'absolute', left: 0, top: insets.top + 64, bottom: 0, width: 20, zIndex: 800 }}
          {...edgePan.panHandlers}
        />
      )}
      <SettingsScreen visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Modal visible={adminOpen} animationType="slide" onRequestClose={() => setAdminOpen(false)}>
        <View style={[styles.adminHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setAdminOpen(false)} hitSlop={10}>
            <Text style={styles.adminBack}>‹ 返回</Text>
          </Pressable>
          <Text style={styles.adminTitle}>内容审核</Text>
          <View style={{ width: 60 }} />
        </View>
        <AdminScreen />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  adminHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 8, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  adminBack: { fontSize: 15, color: '#4D6BFE', width: 60 },
  adminTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
});
