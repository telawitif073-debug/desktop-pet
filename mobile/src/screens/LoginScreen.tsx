/** 登录/注册：与桌面端同一套平台账号，登录成功后立即拉取云端数据 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as platform from '../api/platform';
import { pullAfterLogin, scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';

export default function LoginScreen(): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    setError('');
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    if (mode === 'register' && !email.trim()) {
      setError('注册需要填写邮箱');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        await platform.register(email.trim(), username.trim(), password);
      }
      const result = await platform.login(username.trim(), password);
      useAppStore.getState().setAuth(result.user, result.accessToken);
      // 登录后拉取云端数据；本地已有 LLM 档案时安排上传（本地为准）
      void pullAfterLogin().then(() => {
        if (useAppStore.getState().llmProfiles.length) scheduleUpload('config');
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>掌上宠物</Text>
      <Text style={styles.subtitle}>与桌面端使用同一账号，数据自动同步</Text>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, mode === 'login' && styles.tabActive]}
          onPress={() => setMode('login')}>
          <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>登录</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, mode === 'register' && styles.tabActive]}
          onPress={() => setMode('register')}>
          <Text style={[styles.tabText, mode === 'register' && styles.tabTextActive]}>注册</Text>
        </Pressable>
      </View>

      {mode === 'register' && (
        <TextInput
          style={styles.input}
          placeholder="邮箱"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder={mode === 'login' ? '用户名或邮箱' : '用户名'}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput style={styles.input} placeholder="密码" secureTextEntry value={password} onChangeText={setPassword} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.submit} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{mode === 'login' ? '登录' : '注册并登录'}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 32, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 32 },
  tabs: { flexDirection: 'row', marginBottom: 20, borderRadius: 8, backgroundColor: '#F2F3F5' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#fff' },
  tabText: { fontSize: 15, color: '#666' },
  tabTextActive: { color: '#1C6EF2', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#DDD',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    fontSize: 15,
  },
  error: { color: '#E5484D', fontSize: 13, marginBottom: 8 },
  submit: { backgroundColor: '#1C6EF2', borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
