import { useCallback, useEffect, useState } from 'react';
import { C, formatBytes, inputStyle, labelStyle, smallBtn } from '../studioTheme';
import { toPayloadFile } from '../../renderer/publishFiles';
import type { PlatformAuthState, PublishFilePayload, PublishPayload } from '../../global.d';

/**
 * 两类发布（智能体 / 音色）共用的发布底座：
 * - usePublish()：平台登录态、提交、结果与错误口径统一（都走主进程 platform:upload）
 * - PublishLayout：左侧表单 + 右侧「账号卡 + 提交卡」的统一版式
 * - FileField / ChoiceRow：共用表单控件
 * 各页面只提供自己的字段与校验，发布体验与数据处理逻辑保持一致。
 */

export interface PublishOutcome {
  ok: boolean;
  text: string;
}

/** Electron 远程调用错误 → 去掉 IPC 包装前缀，只留服务端信息 */
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

export function usePublish() {
  const [auth, setAuth] = useState<PlatformAuthState | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishOutcome | null>(null);
  const [loginId, setLoginId] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  const refreshAuth = useCallback(async () => {
    const state = await window.electronAPI?.platform.authStatus();
    if (state) setAuth(state);
  }, []);

  useEffect(() => {
    void refreshAuth();
    // 资源中心窗口登录/登出后主进程广播配置，这里同步刷新登录态
    const cleanup = window.electronAPI?.onConfigChanged(() => void refreshAuth());
    return () => cleanup?.();
  }, [refreshAuth]);

  const login = useCallback(async () => {
    if (!loginId.trim() || !loginPwd) {
      setLoginError('请填写账号（用户名或邮箱）与密码');
      return;
    }
    setLoginBusy(true);
    setLoginError('');
    try {
      await window.electronAPI?.platform.login(loginId.trim(), loginPwd);
      setLoginPwd('');
      await refreshAuth();
    } catch (error) {
      setLoginError(readableError(error));
    } finally {
      setLoginBusy(false);
    }
  }, [loginId, loginPwd, refreshAuth]);

  const logout = useCallback(async () => {
    await window.electronAPI?.platform.logout();
    await refreshAuth();
  }, [refreshAuth]);

  /**
   * 提交发布：未登录给指引，成功后统一提示「已提交，等待管理员审核」。
   * 返回是否成功，供表单决定是否清空。
   */
  const submit = useCallback(async (payload: PublishPayload, label: string): Promise<boolean> => {
    const api = window.electronAPI;
    setResult(null);
    if (!api) {
      setResult({ ok: false, text: '当前环境不支持发布（需在桌面客户端中使用宠工坊）' });
      return false;
    }
    setBusy(true);
    try {
      const response = await api.platform.upload(payload);
      if (!response.success) {
        setResult({ ok: false, text: response.error || '提交失败' });
        return false;
      }
      setResult({ ok: true, text: `「${response.asset?.name ?? label}」已提交，等待管理员审核` });
      return true;
    } catch (error) {
      setResult({ ok: false, text: readableError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    auth,
    busy,
    result,
    setResult,
    loginId,
    setLoginId,
    loginPwd,
    setLoginPwd,
    loginBusy,
    loginError,
    login,
    logout,
    submit,
  };
}

export type PublishApi = ReturnType<typeof usePublish>;

/** 右侧账号卡：已登录显示身份与退出，未登录给最小登录表单（也可去资源中心登录，登录态会自动同步） */
export const PublishAccountCard = ({ pub }: { pub: PublishApi }) => {
  const loggedIn = pub.auth?.loggedIn === true;
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>平台账号</div>
      {loggedIn ? (
        <>
          <div style={{ fontSize: 12, color: C.text, lineHeight: 1.8 }}>
            已登录：{pub.auth?.user?.username ?? '未知用户'}
            {pub.auth?.user?.role === 'admin' ? '（管理员）' : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" style={smallBtn()} onClick={() => void window.electronAPI?.platform.openStore()}>
              打开资源中心
            </button>
            <button type="button" style={smallBtn()} onClick={() => void pub.logout()}>
              退出登录
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
            发布需要平台账号；也可以先在「资源中心」窗口登录，登录状态会自动同步到这里。
          </div>
          <label style={labelStyle}>账号（用户名或邮箱）</label>
          <input
            value={pub.loginId}
            onChange={(event) => pub.setLoginId(event.target.value)}
            placeholder="用户名 / 邮箱"
            style={inputStyle}
          />
          <label style={labelStyle}>密码</label>
          <input
            type="password"
            value={pub.loginPwd}
            onChange={(event) => pub.setLoginPwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void pub.login();
            }}
            placeholder="密码"
            style={inputStyle}
          />
          <button
            type="button"
            disabled={pub.loginBusy}
            onClick={() => void pub.login()}
            style={{
              width: '100%', padding: '6px', border: 'none', borderRadius: 4,
              background: C.accent, color: '#fff', fontSize: 12, cursor: pub.loginBusy ? 'wait' : 'pointer',
            }}
          >
            {pub.loginBusy ? '登录中…' : '登录'}
          </button>
          <button
            type="button"
            style={{ ...smallBtn(), width: '100%', marginTop: 6, padding: '5px' }}
            onClick={() => void window.electronAPI?.platform.openStore()}
          >
            打开资源中心
          </button>
          {pub.loginError && <div style={{ fontSize: 11, color: C.danger, marginTop: 6, lineHeight: 1.7 }}>{pub.loginError}</div>}
        </>
      )}
    </div>
  );
};

/** 统一版式：左表单（可滚动）+ 右账号卡/提交卡 */
export const PublishLayout = ({
  pub,
  title,
  description,
  submitLabel,
  submitHint,
  onSubmit,
  children,
}: {
  pub: PublishApi;
  title: string;
  description: string;
  submitLabel: string;
  submitHint: string;
  onSubmit: () => void;
  children: React.ReactNode;
}) => {
  const blocked = pub.busy || pub.auth?.loggedIn !== true;
  return (
    <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <section style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 20px' }}>
        <div style={{ maxWidth: 760 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 12, lineHeight: 1.7 }}>{description}</div>
          {children}
        </div>
      </section>
      <aside style={{ width: 264, flexShrink: 0, borderLeft: `1px solid ${C.border}`, padding: 14, overflowY: 'auto' }}>
        <PublishAccountCard pub={pub} />
        <div style={{ height: 1, background: C.border, margin: '14px 0' }} />
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>提交审核</div>
        <button
          type="button"
          disabled={blocked}
          onClick={onSubmit}
          style={{
            width: '100%', padding: '8px', border: 'none', borderRadius: 4,
            background: blocked ? '#333' : C.accent, color: blocked ? '#777' : '#fff',
            fontSize: 12, cursor: blocked ? 'not-allowed' : 'pointer',
          }}
        >
          {pub.busy ? '提交中…' : submitLabel}
        </button>
        {pub.auth?.loggedIn !== true && (
          <div style={{ fontSize: 11, color: C.warn, marginTop: 6, lineHeight: 1.7 }}>未登录时不能提交，请先登录平台账号。</div>
        )}
        {pub.result && (
          <div style={{ fontSize: 11, color: pub.result.ok ? C.ok : C.danger, marginTop: 8, lineHeight: 1.7 }}>{pub.result.text}</div>
        )}
        {pub.result?.ok && (
          <button
            type="button"
            style={{ ...smallBtn(), width: '100%', marginTop: 6, padding: '5px' }}
            onClick={() => void window.electronAPI?.platform.openStore()}
          >
            在资源中心查看审核状态
          </button>
        )}
        <div style={{ fontSize: 11, color: C.sub, marginTop: 10, lineHeight: 1.8 }}>{submitHint}</div>
      </aside>
    </main>
  );
};

/** 单选行（沿用宠工坊按钮式选择，避免引入额外 UI 依赖） */
export const ChoiceRow = <T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) => (
  <div style={{ marginBottom: 10 }}>
    <label style={labelStyle}>{label}</label>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          style={{ ...smallBtn(value === option.value), opacity: disabled ? 0.5 : 1 }}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

/** 文件选择：点击或拖入（读成字节交主进程上传，不经文件系统） */
export const FileField = ({
  label,
  accept,
  value,
  hint,
  onChange,
}: {
  label: string;
  accept: string;
  value: PublishFilePayload | null;
  hint?: string;
  onChange: (next: PublishFilePayload | null) => void;
}) => (
  <div style={{ marginBottom: 10 }}>
    <label style={labelStyle}>{label}</label>
    <label
      style={{
        display: 'block',
        padding: '10px 12px',
        border: `1px dashed ${value ? C.accent : C.border}`,
        borderRadius: 6,
        background: C.panelAlt,
        color: value ? C.text : C.sub,
        fontSize: 12,
        cursor: 'pointer',
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const dropped = event.dataTransfer?.files?.[0];
        if (dropped) void toPayloadFile(dropped).then(onChange);
      }}
    >
      <input
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) void toPayloadFile(picked).then(onChange);
          event.target.value = '';
        }}
      />
      {value ? `${value.name}（${formatBytes(value.bytes.length)}）· 点击更换` : '点击选择文件，或把文件拖到这里'}
    </label>
    {hint && <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.6 }}>{hint}</div>}
  </div>
);