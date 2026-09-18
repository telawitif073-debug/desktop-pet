import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Segmented, Typography, message } from 'antd';
import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { login, register } from '../api';
import type { User } from '../types';
import { getErrorMessage } from '../utils';

export default function AuthPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const [messageApi, contextHolder] = message.useMessage();

  const submit = async (values: { identifier?: string; email?: string; username?: string; password: string }) => {
    setLoading(true); setError('');
    try {
      const result = mode === 'login'
        ? await login(values.identifier!, values.password)
        : await register(values.email!, values.username!, values.password);
      onAuthenticated(result.user);
      messageApi.success(mode === 'login' ? '欢迎回来' : '注册成功');
      const requestedPath = (location.state as { from?: string } | null)?.from;
      navigate(result.user.role === 'admin' ? '/admin' : requestedPath || '/');
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setLoading(false); }
  };

  return <div className="auth-layout">
    {contextHolder}
    <div className="auth-intro"><span className="eyebrow">DESKTOP PET / MARKETPLACE</span><Typography.Title>给陪伴你的宠物，<br /><em>找到新的表达。</em></Typography.Title><Typography.Paragraph>浏览社区精选的宠物外观与智能体，让每一次互动都更贴近你的想象。</Typography.Paragraph></div>
    <Card className="auth-card" variant="borderless">
      <Segmented block value={mode} onChange={(value) => { setMode(value as 'login' | 'register'); setError(''); }} options={[{ label: '登录', value: 'login' }, { label: '注册', value: 'register' }]} />
      <div className="auth-card-heading"><Typography.Title level={3}>{mode === 'login' ? '欢迎回来' : '创建账号'}</Typography.Title><Typography.Text type="secondary">{mode === 'login' ? '登录后即可下载和管理资源' : '加入创作者与宠物爱好者社区'}</Typography.Text></div>
      {error && <Alert className="form-alert" type="error" showIcon message={error} />}
      <Form layout="vertical" onFinish={submit} requiredMark={false}>
        {mode === 'login' ? <Form.Item label="账号" name="identifier" rules={[{ required: true, message: '请输入邮箱或用户名' }]}><Input size="large" prefix={<UserOutlined />} placeholder="邮箱或用户名" /></Form.Item> : <>
          <Form.Item label="邮箱" name="email" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}><Input size="large" prefix={<MailOutlined />} placeholder="you@example.com" /></Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true, min: 2, message: '用户名至少 2 个字符' }]}><Input size="large" prefix={<UserOutlined />} placeholder="你的展示名称" /></Form.Item>
        </>}
        <Form.Item label="密码" name="password" rules={[{ required: true, min: 6, message: '密码至少 6 个字符' }]}><Input.Password size="large" prefix={<LockOutlined />} placeholder="至少 6 个字符" /></Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={loading}>{mode === 'login' ? '进入资源库' : '创建账号'}</Button>
      </Form>
    </Card>
  </div>;
}
