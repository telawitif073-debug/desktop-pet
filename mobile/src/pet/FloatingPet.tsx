/**
 * 应用内常驻悬浮宠物：始终浮在聊天界面最上层，可拖动；
 * 三连击弹出喂食/玩耍/睡觉菜单（复用 interact.ts 打通智能体真实回应）；
 * 承接原宠物页的自然衰减计时（5s 一次，60s 防抖上传）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import PetView from './PetView';
import { petInteract } from '../chat/interact';
import { scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';

const SCREEN = Dimensions.get('window');
const PET_SIZE = 88;

export default function FloatingPet(): React.JSX.Element | null {
  const petAsset = useAppStore((s) => s.petAsset);
  const [menuOpen, setMenuOpen] = useState(false);
  const tapsRef = useRef<number[]>([]);
  const posRef = useRef({ x: SCREEN.width - PET_SIZE - 18, y: 140 });
  const pos = useRef(new Animated.ValueXY(posRef.current)).current;
  const dragBase = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  // 自然衰减（原宠物页逻辑迁移至此，应用内持续生效）
  useEffect(() => {
    const timer = setInterval(() => {
      useAppStore.getState().decay();
      scheduleUpload('pet_state');
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // PanResponder 用 ref 固定：render body 里每次 create 会打断进行中的手势
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
      onPanResponderGrant: () => {
        movedRef.current = false;
        dragBase.current = { ...posRef.current };
        pos.setOffset({ x: posRef.current.x, y: posRef.current.y });
        pos.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6) movedRef.current = true;
        posRef.current = { x: dragBase.current.x + g.dx, y: dragBase.current.y + g.dy };
        pos.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: (_e, g) => {
        pos.flattenOffset();
        // 边界回弹：拖出屏幕则拉回
        const x = Math.min(Math.max(posRef.current.x, 8), SCREEN.width - PET_SIZE - 8);
        const y = Math.min(Math.max(posRef.current.y, 60), SCREEN.height - PET_SIZE - 120);
        posRef.current = { x, y };
        Animated.spring(pos, { toValue: { x, y }, useNativeDriver: false }).start();
        // 未移动视为点击：500ms 内三连击打开互动菜单
        if (!movedRef.current && Math.abs(g.vx) < 0.5) {
          const now = Date.now();
          tapsRef.current = [...tapsRef.current.filter((t) => now - t < 500), now];
          if (tapsRef.current.length >= 3) {
            tapsRef.current = [];
            setMenuOpen(true);
          }
        }
      },
    }),
  ).current;

  const act = (action: 'feed' | 'play' | 'rest'): void => {
    setMenuOpen(false);
    const store = useAppStore.getState();
    store[action]();
    scheduleUpload('pet_state');
    // 打通智能体真实回应（未配置 API 时内部静默跳过）
    petInteract(action);
  };

  if (!petAsset) return null;
  const label = { feed: '喂食', play: '玩耍', rest: '睡觉' } as const;

  return (
    <>
      {menuOpen && (
        <Pressable style={styles.menuMask} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menu, { left: Math.min(posRef.current.x, SCREEN.width - 150) - 40, top: posRef.current.y + PET_SIZE - 10 }]} pointerEvents="box-none">
            {(['feed', 'play', 'rest'] as const).map((k) => (
              <Pressable key={k} style={styles.menuItem} onPress={() => act(k)}>
                <Text style={styles.menuText}>{label[k]}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      )}
      <Animated.View style={[styles.pet, pos.getLayout()]} {...pan.panHandlers}>
        <PetView asset={petAsset} size={PET_SIZE} />
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  pet: { position: 'absolute', width: 88, height: 88, zIndex: 999, elevation: 999 },
  menuMask: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 998, elevation: 998 },
  menu: { position: 'absolute', backgroundColor: '#FFFFFF', borderRadius: 14, paddingVertical: 4, minWidth: 96, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: '#EEE' },
  menuItem: { paddingVertical: 10, paddingHorizontal: 18 },
  menuText: { fontSize: 14, color: '#333' },
});
