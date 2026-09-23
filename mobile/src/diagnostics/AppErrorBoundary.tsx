/** 全局错误边界：渲染期/生命周期错误不再杀死进程，改为全屏展示错误信息，
 *  用户可直接截图反馈（配合 App.tsx 的非致命全局 handler，彻底避免「崩溃 → 自愈回滚 → 反复推送更新」死循环）。 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { reportCrash } from './crashReport';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, stack: error?.stack ?? '' };
  }

  componentDidCatch(error: Error): void {
    // 渲染期错误上报云端，排查时直接读服务器 crash.log
    reportCrash(error?.message ?? String(error), error?.stack ?? '', 'render-boundary');
  }

  private reset = (): void => {
    this.setState({ error: null, stack: '' });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>应用运行异常</Text>
          <Text style={styles.desc}>已暂停当前操作，未丢失登录状态。请截图本页发送给我们，以便修复（可在下方重试）。</Text>
          <ScrollView style={styles.box}>
            <Text style={styles.message}>{this.state.error.message || String(this.state.error)}</Text>
            <Text style={styles.stack}>{this.state.stack}</Text>
          </ScrollView>
          <View style={styles.btnRow}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={this.reset}>
              <Text style={styles.btnGhostText}>重试</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 80 },
  title: { fontSize: 20, fontWeight: '700', color: '#E5484D', marginBottom: 8 },
  desc: { fontSize: 13, color: '#666', lineHeight: 19, marginBottom: 16 },
  box: { flex: 1, backgroundColor: '#F7F8FA', borderRadius: 10, padding: 12 },
  message: { fontSize: 13, color: '#C0392B', fontWeight: '600', marginBottom: 8 },
  stack: { fontSize: 11, color: '#888', lineHeight: 16 },
  btnRow: { flexDirection: 'row', marginVertical: 20, justifyContent: 'flex-end' },
  btn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
  btnGhost: { backgroundColor: '#F2F3F5' },
  btnGhostText: { color: '#1C6EF2', fontSize: 15, fontWeight: '600' },
});