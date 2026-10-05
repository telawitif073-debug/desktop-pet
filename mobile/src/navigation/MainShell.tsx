/**
 * 主壳：应用直接进入聊天界面（DeepSeek 式单页）。
 * - 左上汉堡或全屏右滑打开商店抽屉（StoreDrawer），抽屉内左滑返回聊天
 * - 抽屉底部头像/… → 用户设置（DeepSeek 样式设置页，全屏弹层）
 * - 管理员可从抽屉进入内容审核（AdminScreen，全屏弹层）
 */
import React, { useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ChatScreen from '../screens/ChatScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AdminScreen from '../screens/AdminScreen';
import PetScreen from '../screens/PetScreen';
import StoreDrawer from '../components/StoreDrawer';
import { useAgentTaskScheduler } from '../agentTaskScheduler';
import { useAgentProactive } from '../agentProactive';

export default function MainShell(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  // 定时任务调度：前台期间扫描到期任务，到点由智能体主动发消息（见 agentTaskScheduler.ts）
  useAgentTaskScheduler();
  // 自主主动搭话：无用户排期时智能体也会按间隔来找你说话（见 agentProactive.ts）
  useAgentProactive();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  // 宠物页（占位骨架）：从右下角浮标进入，后续阶段替换为悬浮形象
  const [petOpen, setPetOpen] = useState(false);
  // drawerOpen 的最新值（PanResponder 闭包只创建一次，须经 ref 读取，避免陈旧闭包）
  const drawerOpenRef = useRef(false);
  drawerOpenRef.current = drawerOpen;
  // 全屏右滑打开商店抽屉：只在「移动阶段」捕获（onMoveShouldSet*Capture），
  // 点击/长按没有位移、不会触发捕获，子组件点击不受影响（此前「捕获抢点击」的教训针对 start 捕获）。
  // 认领条件：横向位移 >24 且明显横向为主（角度约 <27°），垂直滚动消息列表不会被抢。
  const swipeOpenPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        !drawerOpenRef.current && g.dx > 24 && Math.abs(g.dy) < Math.abs(g.dx) * 0.5,
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 40) setDrawerOpen(true);
      },
    }),
  ).current;

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }} {...swipeOpenPan.panHandlers}>
      <ChatScreen onOpenDrawer={() => setDrawerOpen(true)} />
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
      <SettingsScreen visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* 宠物入口浮标：进入宠物页（占位骨架），zIndex 低于商店抽屉，抽屉打开时被遮罩覆盖 */}
      <Pressable
        style={[styles.petEntry, { bottom: insets.bottom + 112 }]}
        onPress={() => setPetOpen(true)}
        hitSlop={8}
      >
        <Text style={styles.petEntryText}>🐾</Text>
      </Pressable>
      <Modal visible={petOpen} animationType="slide" onRequestClose={() => setPetOpen(false)}>
        <View style={[styles.petHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setPetOpen(false)} hitSlop={10}>
            <Text style={styles.adminBack}>‹ 返回</Text>
          </Pressable>
        </View>
        <PetScreen
          onOpenStore={() => {
            setPetOpen(false);
            setDrawerOpen(true);
          }}
        />
      </Modal>
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
  petHeader: { paddingHorizontal: 14, paddingBottom: 8, backgroundColor: '#fff' },
  petEntry: { position: 'absolute', right: 14, zIndex: 800, elevation: 800, width: 46, height: 46, borderRadius: 23, backgroundColor: '#4D6BFE', alignItems: 'center', justifyContent: 'center' },
  petEntryText: { fontSize: 22 },
});
