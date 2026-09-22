/** 游戏式更新面板：发现新版本 → 面板内进度条下载 → 自动拉起系统安装器 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { downloadAndInstall, guideInstallPermission, installPendingApk, subscribeUpdateFinished, subscribeUpdateProgress } from '../native/Update';
import { useAppStore } from '../store/appStore';
import { APP_VERSION_NAME } from './checkUpdate';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function UpdateModal(): React.JSX.Element | null {
  const updateInfo = useAppStore((s) => s.updateAvailable);
  const panelVisible = useAppStore((s) => s.updatePanelVisible);
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const unsubRef = useRef<(() => void) | null>(null);

  // 打开面板时重置下载状态
  useEffect(() => {
    if (panelVisible) {
      setPhase('idle');
      setReceived(0);
      setTotal(0);
      setError('');
    }
  }, [panelVisible]);

  useEffect(() => () => unsubRef.current?.(), []);

  // 下载结束（系统 DownloadManager 完成后原生自动拉起安装器）
  const finishedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    finishedRef.current = subscribeUpdateFinished(({ ok, message }) => {
      if (ok) {
        setPhase('done');
      } else {
        setPhase('error');
        setError(message || '下载失败，请重试');
      }
    });
    return () => finishedRef.current?.();
  }, []);

  if (!updateInfo || !panelVisible) return null;

  const forced = updateInfo.forced;
  const close = (): void => {
    if (!forced) useAppStore.getState().patch({ updatePanelVisible: false });
  };
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const start = async (): Promise<void> => {
    setError('');
    setPhase('downloading');
    setReceived(0);
    setTotal(0);
    unsubRef.current?.();
    unsubRef.current = subscribeUpdateProgress((p) => {
      setReceived(p.received);
      if (p.total > 0) setTotal(p.total);
    });
    try {
      const result = await downloadAndInstall(updateInfo.apkUrl, updateInfo.versionName);
      if (result === 'permission') {
        setPhase('idle');
        guideInstallPermission();
        return;
      }
      if (result === 'busy' || result === 'started') {
        // 系统级后台下载进行中：进度条继续走，完成时由 PetUpdateFinished 事件收尾
        setPhase('downloading');
        return;
      }
      setPhase('done');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unsubRef.current?.();
      unsubRef.current = null;
    }
  };

  const resumeInstall = async (): Promise<void> => {
    try {
      const result = await installPendingApk();
      if (result === 'permission') {
        guideInstallPermission();
        return;
      }
      setPhase('done');
    } catch (e) {
      // 没有已下载的包则重新下载
      setError(e instanceof Error ? e.message : String(e));
      void start();
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (phase !== 'downloading') close(); }}>
      <View style={styles.mask}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>发现新版本 {updateInfo.versionName}</Text>
            {!forced && (
              <Pressable onPress={close} hitSlop={8}>
                <Text style={styles.closeBtn}>✕</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.current}>当前版本 {APP_VERSION_NAME}</Text>
          {forced && <Text style={styles.forcedText}>当前版本过低，需更新到最新版后才能继续使用</Text>}

          <View style={styles.notesBox}>
            <Text style={styles.notesTitle}>更新内容</Text>
            <Text style={styles.notesText}>{updateInfo.notes}</Text>
          </View>

          {phase === 'downloading' && (
            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(3, pct)}%` }]} />
              </View>
              <View style={styles.progressMeta}>
                <Text style={styles.progressPct}>{pct}%</Text>
                <Text style={styles.progressBytes}>{total > 0 ? `${mb(received)} / ${mb(total)}` : mb(received)}</Text>
              </View>
            </View>
          )}

          {phase === 'error' && <Text style={styles.errorText}>下载失败：{error}</Text>}

          <View style={styles.btnRow}>
            {phase === 'idle' && (
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => void start()}>
                <Text style={styles.btnPrimaryText}>{forced ? '立即更新（必须）' : '立即更新'}</Text>
              </Pressable>
            )}
            {phase === 'downloading' && (
              <Pressable style={[styles.btn, styles.btnDisabled]} disabled>
                <Text style={styles.btnDisabledText}>下载中…</Text>
              </Pressable>
            )}
            {phase === 'done' && (
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={close}>
                <Text style={styles.btnPrimaryText}>已开始安装</Text>
              </Pressable>
            )}
            {phase === 'error' && (
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => void start()}>
                <Text style={styles.btnPrimaryText}>重试</Text>
              </Pressable>
            )}
          </View>
          {phase === 'idle' && received > 0 && (
            <Pressable onPress={() => void resumeInstall()}>
              <Text style={styles.resumeLink}>已下载过？继续安装</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  panel: { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '700', color: '#222', flex: 1 },
  closeBtn: { fontSize: 18, color: '#999', paddingHorizontal: 6 },
  current: { fontSize: 12, color: '#999', marginTop: 4 },
  forcedText: { color: '#E5484D', fontSize: 12, marginTop: 6, fontWeight: '600' },
  notesBox: { backgroundColor: '#F5F7FA', borderRadius: 10, padding: 12, marginTop: 12 },
  notesTitle: { fontSize: 12, color: '#888', marginBottom: 4 },
  notesText: { fontSize: 13, lineHeight: 20, color: '#444' },
  progressWrap: { marginTop: 14 },
  progressTrack: { height: 10, backgroundColor: '#E8EBF0', borderRadius: 5, overflow: 'hidden' },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: '#1C6EF2' },
  progressMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressPct: { fontSize: 12, color: '#1C6EF2', fontWeight: '600' },
  progressBytes: { fontSize: 11, color: '#999' },
  errorText: { color: '#E5484D', fontSize: 12, marginTop: 10 },
  btnRow: { flexDirection: 'row', marginTop: 16 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginHorizontal: 4 },
  btnPrimary: { backgroundColor: '#1C6EF2' },
  btnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  btnDisabled: { backgroundColor: '#C9DCF9' },
  btnDisabledText: { color: '#fff', fontSize: 15 },
  resumeLink: { textAlign: 'center', color: '#1C6EF2', fontSize: 12, marginTop: 10 },
});
