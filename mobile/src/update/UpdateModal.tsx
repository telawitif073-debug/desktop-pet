/** 游戏式更新面板：两种模式——热更新（JS Bundle，无需重装，重启生效）/ 整包更新（下载 APK 自动拉起系统安装器） */
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { downloadAndInstall, guideInstallPermission, installPendingApk, subscribeUpdateFinished, subscribeUpdateProgress } from '../native/Update';
import { applyBundleUpdate, restartApp } from '../native/HotUpdate';
import { useAppStore } from '../store/appStore';
import { APP_VERSION_NAME } from './checkUpdate';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 面板骨架：标题/说明/进度/按钮区由调用方填充 */
function Panel({ children, notes, onClose, subtitle, title }: {
  children: React.ReactNode;
  notes: string;
  onClose: () => void;
  subtitle: string;
  title: string;
}): React.JSX.Element {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.mask}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.closeBtn}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.current}>当前版本 {APP_VERSION_NAME}</Text>
          <Text style={styles.hotTag}>{subtitle}</Text>
          <View style={styles.notesBox}>
            <Text style={styles.notesTitle}>更新内容</Text>
            <Text style={styles.notesText}>{notes}</Text>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

/** 热更新模式：下载 bundle zip → 解压登记 → 重启生效（无需重装 APK） */
function HotUpdatePanel(): React.JSX.Element {
  const hot = useAppStore((s) => s.updateHot)!;
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  const close = (): void => useAppStore.getState().patch({ updatePanelVisible: false });
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const start = async (): Promise<void> => {
    setError('');
    setPhase('downloading');
    setReceived(0);
    setTotal(0);
    try {
      await applyBundleUpdate(hot.url, hot.version, (r, t) => {
        setReceived(r);
        if (t > 0) setTotal(t);
      });
      setPhase('done');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restart = async (): Promise<void> => {
    try {
      await restartApp();
    } catch (e) {
      // 原生重启失败兜底：提示用户手动杀进程重开（不再静默无反应）
      const msg = e instanceof Error ? e.message : '';
      Alert.alert('自动重启失败', `${msg ? `${msg}\n` : ''}请手动关闭应用后重新打开，新版本即可生效。`);
    }
  };

  return (
    <Panel
      title={`发现新版本 v${hot.version}`}
      subtitle="热更新 · 无需下载安装包，重启即生效"
      notes={hot.notes}
      onClose={() => { if (phase !== 'downloading') close(); }}
    >
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
      {phase === 'error' && <Text style={styles.errorText}>更新失败：{error}</Text>}
      <View style={styles.btnRow}>
        {phase === 'idle' && (
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => void start()}>
            <Text style={styles.btnPrimaryText}>立即更新</Text>
          </Pressable>
        )}
        {phase === 'downloading' && (
          <Pressable style={[styles.btn, styles.btnDisabled]} disabled>
            <Text style={styles.btnDisabledText}>下载中…</Text>
          </Pressable>
        )}
        {phase === 'done' && (
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => void restart()}>
            <Text style={styles.btnPrimaryText}>重启应用生效</Text>
          </Pressable>
        )}
        {phase === 'error' && (
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => void start()}>
            <Text style={styles.btnPrimaryText}>重试</Text>
          </Pressable>
        )}
      </View>
      {phase === 'done' && <Text style={styles.hintText}>重启后自动加载新版本；若新版本异常，连续两次启动将自动恢复</Text>}
    </Panel>
  );
}

/** 整包更新模式：下载 APK → 自动拉起系统安装器 */
function ApkUpdatePanel(): React.JSX.Element | null {
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
      const result = await downloadAndInstall(updateInfo.apkUrl, updateInfo.versionName, updateInfo.versionCode);
      if (result === 'permission') {
        // 未开始下载：移除进度订阅，等待用户授权后重试
        unsubRef.current?.();
        unsubRef.current = null;
        setPhase('idle');
        guideInstallPermission();
        return;
      }
      // 'busy' | 'started'：系统级后台下载进行中，保持进度订阅，
      // 由 PetUpdateProgress 事件持续刷新进度条、PetUpdateFinished 收尾
    } catch (e) {
      unsubRef.current?.();
      unsubRef.current = null;
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
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
                <Text style={styles.btnPrimaryText}>完成</Text>
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

export default function UpdateModal(): React.JSX.Element | null {
  const updateHot = useAppStore((s) => s.updateHot);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const panelVisible = useAppStore((s) => s.updatePanelVisible);

  // 热更新与整包更新互斥（checkUpdate 保证），热更新优先展示（体积小、无需重装）
  if (updateHot && panelVisible && !updateAvailable) return <HotUpdatePanel />;
  return <ApkUpdatePanel />;
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  panel: { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '700', color: '#222', flex: 1 },
  closeBtn: { fontSize: 18, color: '#999', paddingHorizontal: 6 },
  current: { fontSize: 12, color: '#999', marginTop: 4 },
  hotTag: { fontSize: 12, color: '#0E8A4C', marginTop: 6, fontWeight: '600' },
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
  hintText: { fontSize: 11, color: '#AAA', marginTop: 8, lineHeight: 16, textAlign: 'center' },
  btnRow: { flexDirection: 'row', marginTop: 16 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginHorizontal: 4 },
  btnPrimary: { backgroundColor: '#1C6EF2' },
  btnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  btnDisabled: { backgroundColor: '#C9DCF9' },
  btnDisabledText: { color: '#fff', fontSize: 15 },
  resumeLink: { textAlign: 'center', color: '#1C6EF2', fontSize: 12, marginTop: 10 },
});
