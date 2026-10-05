/**
 * 登录/注册（DeepSeek 风格）：
 * - 登录 tab 内「密码登录 / 验证码登录」双通道；注册 = 邮箱 + 验证码 + 密码（≥8 位），用户名选填
 * - 验证码按钮 60s 倒计时；开发环境（服务端开启回显）自动填入并提示「测试模式」
 * - 注册/登录成功都保存双令牌（accessToken + refreshToken），并拉取云端数据恢复
 * 与桌面端同一套平台账号（桌面端仍走旧的「用户名+密码」注册，后端兼容）。
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as platform from '../api/platform';
import { pullAfterLogin, scheduleUpload } from '../api/sync';
import { useAppStore } from '../store/appStore';

type Mode = 'login' | 'register';
type LoginWay = 'password' | 'code';

const EMAIL_RE = /\S+@\S+\.\S+/;

export default function LoginScreen(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [loginWay, setLoginWay] = useState<LoginWay>('password');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 60s 倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const switchMode = (m: Mode): void => {
    setMode(m);
    setError('');
  };

  /** 获取验证码：注册/登录共用，purpose 跟随当前 tab */
  const handleSendCode = async (): Promise<void> => {
    if (countdown > 0 || sending) return;
    const em = email.trim();
    if (!EMAIL_RE.test(em)) {
      setError('请先填写正确的邮箱地址');
      return;
    }
    setError('');
    setSending(true);
    try {
      const r = await platform.sendCode(em, mode === 'register' ? 'register' : 'login');
      if (r.devCode) {
        setCode(r.devCode);
        Alert.alert('测试模式', `邮件服务未配置，验证码已回显并自动填入：${r.devCode}\n（仅开发环境可见，正式环境将通过邮件发送）`);
      } else {
        Alert.alert('已发送', `验证码已发送至 ${em}，10 分钟内有效。\n收不到时请检查垃圾邮件箱。`);
      }
      setCountdown(60);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  /** 登录/注册成功后统一处理：拉取云端数据（智能体/聊天记录恢复） */
  const afterAuth = (): void => {
    void pullAfterLogin().then((sum) => {
      if (sum.agents || sum.messages) {
        const parts = [
          sum.agents ? `智能体 ${sum.agents} 个` : '',
          sum.messages ? `聊天记录 ${sum.messages} 条` : '',
        ].filter(Boolean);
        Alert.alert('已从云端恢复', `这台设备上恢复了：${parts.join('、')}`);
      }
      if (useAppStore.getState().llmProfiles.length) scheduleUpload('config');
    });
  };

  const submit = async (): Promise<void> => {
    setError('');
    const em = email.trim();
    try {
      if (mode === 'login') {
        if (loginWay === 'password') {
          if (!username.trim() || !password) {
            setError('请输入账号和密码');
            return;
          }
          setBusy(true);
          const result = await platform.login(username.trim(), password);
          useAppStore.getState().setAuth(result.user, result.accessToken, result.refreshToken);
        } else {
          if (!EMAIL_RE.test(em)) {
            setError('请输入正确的邮箱地址');
            return;
          }
          if (!/^\d{6}$/.test(code.trim())) {
            setError('请输入 6 位数字验证码');
            return;
          }
          setBusy(true);
          const result = await platform.loginByEmailCode(em, code.trim());
          useAppStore.getState().setAuth(result.user, result.accessToken, result.refreshToken);
        }
      } else {
        // 注册：邮箱 + 验证码 + 密码（≥8 位），用户名选填（默认邮箱前缀）
        if (!EMAIL_RE.test(em)) {
          setError('请输入正确的邮箱地址');
          return;
        }
        if (!/^\d{6}$/.test(code.trim())) {
          setError('请输入 6 位数字验证码');
          return;
        }
        if (password.length < 8) {
          setError('设置密码至少 8 位');
          return;
        }
        setBusy(true);
        const result = await platform.register(em, code.trim(), password, username.trim() || undefined);
        useAppStore.getState().setAuth(result.user, result.accessToken, result.refreshToken);
        Alert.alert('注册成功', '欢迎加入掌上宠物！');
      }
      afterAuth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonLabel = countdown > 0 ? `${countdown}s 后重发` : sending ? '发送中…' : '获取验证码';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>掌上宠物</Text>
      <Text style={styles.subtitle}>与桌面端使用同一账号，数据自动同步</Text>

      {/* 顶部 tab：登录 | 注册（激活下划线） */}
      <View style={styles.tabs}>
        <Pressable style={styles.tab} onPress={() => switchMode('login')}>
          <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>登录</Text>
          {mode === 'login' && <View style={styles.tabUnderline} />}
        </Pressable>
        <Pressable style={styles.tab} onPress={() => switchMode('register')}>
          <Text style={[styles.tabText, mode === 'register' && styles.tabTextActive]}>注册</Text>
          {mode === 'register' && <View style={styles.tabUnderline} />}
        </Pressable>
      </View>

      {mode === 'login' && (
        // 密码登录 / 验证码登录切换
        <View style={styles.waySwitch}>
          {(['password', 'code'] as LoginWay[]).map((w) => (
            <Pressable key={w} onPress={() => { setLoginWay(w); setError(''); }}>
              <Text style={[styles.wayText, loginWay === w && styles.wayTextActive]}>
                {w === 'password' ? '密码登录' : '验证码登录'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {mode === 'register' || loginWay === 'code' ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="邮箱"
            placeholderTextColor="#A8ABB3"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          {/* DeepSeek 式：验证码按钮嵌在输入框内部右侧，竖线分隔 */}
          <View style={styles.codeRow}>
            <TextInput
              style={styles.codeInput}
              placeholder="6 位验证码"
              placeholderTextColor="#A8ABB3"
              autoCapitalize="none"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, ''))}
            />
            <View style={styles.codeDivider} />
            <Pressable
              style={styles.codeBtn}
              onPress={() => void handleSendCode()}
              disabled={countdown > 0 || sending}>
              <Text style={[styles.codeBtnText, countdown > 0 && styles.codeBtnTextDisabled]}>{codeButtonLabel}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <TextInput
          style={styles.input}
          placeholder="用户名或邮箱"
          placeholderTextColor="#A8ABB3"
          autoCapitalize="none"
          value={username}
          onChangeText={setUsername}
        />
      )}

      {mode === 'register' && (
        <TextInput
          style={styles.input}
          placeholder="用户名（选填，默认取邮箱前缀）"
          placeholderTextColor="#A8ABB3"
          autoCapitalize="none"
          value={username}
          onChangeText={setUsername}
        />
      )}
      {mode === 'register' || loginWay === 'password' ? (
        <TextInput
          style={styles.input}
          placeholder={mode === 'register' ? '设置密码（至少 8 位）' : '密码'}
          placeholderTextColor="#A8ABB3"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.submit, busy && styles.submitDisabled]} onPress={() => void submit()} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.submitText}>{mode === 'login' ? '登录' : '注册'}</Text>
        )}
      </Pressable>

      {mode === 'register' && (
        <Text style={styles.hint}>注册即代表同意将账号数据同步到平台，仅用于多设备恢复</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 48 },
  title: { fontSize: 28, fontWeight: '700', color: '#1A1A1A', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 36 },
  tabs: { flexDirection: 'row', justifyContent: 'center', gap: 48, marginBottom: 24 },
  tab: { alignItems: 'center', paddingBottom: 8 },
  tabText: { fontSize: 17, color: '#666' },
  tabTextActive: { color: '#4D6BFE', fontWeight: '600' },
  tabUnderline: { position: 'absolute', bottom: 0, width: 28, height: 3, borderRadius: 2, backgroundColor: '#4D6BFE' },
  waySwitch: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginBottom: 20 },
  wayText: { fontSize: 14, color: '#888' },
  wayTextActive: { color: '#4D6BFE', fontWeight: '600' },
  input: {
    // DeepSeek 实测风格：浅灰填充、无边框、大圆角
    backgroundColor: '#F5F7FA',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 14,
    fontSize: 15,
    color: '#1A1A1A',
  },
  codeRow: {
    backgroundColor: '#F5F7FA',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  codeInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: '#1A1A1A' },
  codeDivider: { width: 1, height: 18, backgroundColor: '#DDD' },
  codeBtn: { paddingHorizontal: 12, paddingVertical: 13 },
  codeBtnText: { color: '#4D6BFE', fontSize: 14, fontWeight: '600' },
  codeBtnTextDisabled: { color: '#B0B4BC' },
  error: { color: '#E5484D', fontSize: 13, marginBottom: 10 },
  submit: { backgroundColor: '#4D6BFE', borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 12, color: '#A8ABB3', textAlign: 'center', marginTop: 18, lineHeight: 18 },
});
