import { useEffect, useState } from 'react';
import { Layout, Menu, Avatar, Button, ConfigProvider, Segmented, Typography } from 'antd';
import { HeartOutlined, LogoutOutlined, SafetyCertificateOutlined, SettingOutlined, ShopOutlined, UploadOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearAuth, getMe, getStoredUser } from './api';
import type { User } from './types';
import AuthPage from './pages/AuthPage';
import ResourceListPage from './pages/ResourceListPage';
import ResourceDetailPage from './pages/ResourceDetailPage';
import UploadPage from './pages/UploadPage';
import ProfilePage from './pages/ProfilePage';
import AdminPage from './pages/AdminPage';
import SettingsPage from './pages/SettingsPage';

const { Header, Content } = Layout;

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const location = useLocation();
  return getStoredUser() ? children : <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

// 登记的开发者账号：可在用户视图与管理员视图间自由切换（需同时具备 admin 角色）
const DEVELOPER_ACCOUNTS = ['developer'];

function AppHeader({ user, viewMode, adminView, isDeveloper, onViewModeChange, onLogout }: { user: User | null; viewMode: 'user' | 'admin'; adminView: boolean; isDeveloper: boolean; onViewModeChange: (mode: 'user' | 'admin') => void; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const selected = location.pathname.startsWith('/profile') ? 'profile' : location.pathname.startsWith('/upload') ? 'upload' : location.pathname.startsWith('/admin') ? 'admin' : location.pathname.startsWith('/settings') ? 'settings' : 'browse';
  const viewSwitch = <Segmented size="small" value={viewMode} onChange={(value) => onViewModeChange(value as 'user' | 'admin')} options={[{ label: '用户视图', value: 'user' }, { label: '管理员视图', value: 'admin' }]} />;

  if (adminView) {
    return <Header className="site-header admin-header">
      <Link to="/admin" className="brand"><span className="brand-mark"><SafetyCertificateOutlined /></span><span>桌面宠物管理后台</span></Link>
      <Menu theme="dark" mode="horizontal" selectedKeys={['admin']} items={[{ key: 'admin', label: <Link to="/admin">审核工作台</Link>, icon: <SafetyCertificateOutlined /> }]} />
      <div className="header-account">{isDeveloper && viewSwitch}<Typography.Text className="account-label">管理员 · {user!.username}</Typography.Text><Button type="text" className="account-button" onClick={onLogout} icon={<LogoutOutlined />}>退出</Button></div>
    </Header>;
  }

  return (
    <Header className="site-header">
      <Link to="/" className="brand"><span className="brand-mark"><HeartOutlined /></span><span>桌面宠物资源库</span></Link>
      <Menu
        theme="dark"
        mode="horizontal"
        selectedKeys={[selected]}
        items={[
          { key: 'browse', label: <Link to="/">探索资源</Link>, icon: <ShopOutlined /> },
          { key: 'upload', label: <Link to="/upload">上传资源</Link>, icon: <UploadOutlined /> },
          ...(user ? [{ key: 'profile', label: <Link to="/profile">个人中心</Link>, icon: <UserOutlined /> }] : []),
          { key: 'settings', label: <Link to="/settings">设置</Link>, icon: <SettingOutlined /> },
        ]}
      />
      <div className="header-account">
        {user ? (
          <>
            {isDeveloper && viewSwitch}
            <Button type="text" className="account-button" onClick={() => navigate('/profile')} icon={<Avatar size="small" icon={<UserOutlined />} />}>{user.username}</Button>
            <Button type="text" className="account-button" onClick={onLogout} icon={<LogoutOutlined />}>退出</Button>
          </>
        ) : <Button type="primary" ghost onClick={() => navigate('/login')}>登录</Button>}
      </div>
    </Header>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(getStoredUser());
  const [viewMode, setViewMode] = useState<'user' | 'admin'>(() => localStorage.getItem('creator_view_mode') === 'admin' ? 'admin' : 'user');
  const navigate = useNavigate();

  useEffect(() => {
    if (!user || !localStorage.getItem('platform_access_token')) return;
    getMe().then(setUser).catch(() => setUser(null));
  }, []);

  // api 拦截器 token 续期失败时派发 platform:logout：同步登录态并回到登录页
  useEffect(() => {
    const onForceLogout = () => {
      setUser(null);
      navigate('/login', { replace: true });
    };
    window.addEventListener('platform:logout', onForceLogout);
    return () => window.removeEventListener('platform:logout', onForceLogout);
  }, [navigate]);

  const logout = () => {
    clearAuth();
    setUser(null);
  };

  const changeViewMode = (mode: 'user' | 'admin') => {
    setViewMode(mode);
    localStorage.setItem('creator_view_mode', mode);
    // 整页刷新并跳转到对应视图首页，保证状态完全重置
    window.location.href = mode === 'admin' ? '/admin' : '/';
  };

  const isDeveloper = user?.role === 'admin' && DEVELOPER_ACCOUNTS.includes(user.username);
  const adminView = user?.role === 'admin' && (isDeveloper ? viewMode === 'admin' : true);

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#137a72', borderRadius: 10, colorBgLayout: '#f4f7f5' } }}>
      <Layout className="app-shell">
        <AppHeader user={user} viewMode={viewMode} adminView={adminView} isDeveloper={isDeveloper} onViewModeChange={changeViewMode} onLogout={logout} />
        <Content className="page-content">
          <Routes>
            <Route path="/login" element={<AuthPage onAuthenticated={setUser} />} />
            <Route path="/" element={adminView ? <Navigate to="/admin" replace /> : <ResourceListPage />} />
            <Route path="/asset/:type/:id" element={<ResourceDetailPage user={user} />} />
            <Route path="/upload" element={<ProtectedRoute><UploadPage /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={user?.role === 'admin' ? <AdminPage user={user} /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
        <footer className="site-footer"><Typography.Text type="secondary">一处收集，轻松安装到你的桌面宠物</Typography.Text></footer>
      </Layout>
    </ConfigProvider>
  );
}
