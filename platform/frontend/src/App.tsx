import { useEffect, useState } from 'react';
import { Layout, Menu, Avatar, Button, ConfigProvider, Segmented, Typography } from 'antd';
import { HeartOutlined, LogoutOutlined, SafetyCertificateOutlined, ShopOutlined, UploadOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearAuth, getMe, getStoredUser } from './api';
import type { User } from './types';
import AuthPage from './pages/AuthPage';
import ResourceListPage from './pages/ResourceListPage';
import ResourceDetailPage from './pages/ResourceDetailPage';
import UploadPage from './pages/UploadPage';
import ProfilePage from './pages/ProfilePage';
import AdminPage from './pages/AdminPage';

const { Header, Content } = Layout;

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const location = useLocation();
  return getStoredUser() ? children : <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

function AdminRoute({ user, children }: { user: User | null; children: JSX.Element }) {
  if (!user) return <Navigate to="/login" replace state={{ from: '/admin' }} />;
  return user.role === 'admin' ? children : <Navigate to="/" replace />;
}

function AppHeader({ user, viewMode, onViewModeChange, onLogout }: { user: User | null; viewMode: 'user' | 'admin'; onViewModeChange: (mode: 'user' | 'admin') => void; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const selected = location.pathname.startsWith('/profile') ? 'profile' : location.pathname.startsWith('/upload') ? 'upload' : location.pathname.startsWith('/admin') ? 'admin' : 'browse';
  if (user?.role === 'admin') {
    return <Header className="site-header admin-header">
      <Link to="/admin" className="brand"><span className="brand-mark"><SafetyCertificateOutlined /></span><span>桌面宠物管理后台</span></Link>
      <Menu theme="dark" mode="horizontal" selectedKeys={['admin']} items={[{ key: 'admin', label: <Link to="/admin">审核工作台</Link>, icon: <SafetyCertificateOutlined /> }]} />
      <div className="header-account"><Typography.Text className="account-label">管理员 · {user.username}</Typography.Text><Button type="text" className="account-button" onClick={onLogout} icon={<LogoutOutlined />}>退出</Button></div>
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
        ]}
      />
      <div className="header-account">
        {user ? (
          <>
        {user.username === 'creator' && <Segmented size="small" value={viewMode} onChange={(value) => onViewModeChange(value as 'user' | 'admin')} options={[{ label: '用户', value: 'user' }, { label: '管理样式', value: 'admin' }]} />}
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

  useEffect(() => {
    if (!user || !localStorage.getItem('platform_access_token')) return;
    getMe().then(setUser).catch(() => setUser(null));
  }, []);

  const logout = () => {
    clearAuth();
    setUser(null);
  };

  const changeViewMode = (mode: 'user' | 'admin') => {
    setViewMode(mode);
    localStorage.setItem('creator_view_mode', mode);
  };

  const creatorPreview = user?.username === 'creator' && viewMode === 'admin';

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#137a72', borderRadius: 10, colorBgLayout: '#f4f7f5' } }}>
      <Layout className="app-shell">
        <AppHeader user={user} viewMode={viewMode} onViewModeChange={changeViewMode} onLogout={logout} />
        <Content className="page-content">
          <Routes>
            <Route path="/login" element={<AuthPage onAuthenticated={setUser} />} />
            <Route path="/" element={user?.role === 'admin' || creatorPreview ? <Navigate to="/admin" replace /> : <ResourceListPage />} />
            <Route path="/asset/:type/:id" element={<ResourceDetailPage user={user} />} />
            <Route path="/upload" element={<ProtectedRoute><UploadPage /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
            <Route path="/admin" element={user?.role === 'admin' ? <AdminPage user={user} /> : creatorPreview ? <AdminPage user={user} preview /> : <AdminRoute user={user}><AdminPage user={user} /></AdminRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
        <footer className="site-footer"><Typography.Text type="secondary">一处收集，轻松安装到你的桌面宠物</Typography.Text></footer>
      </Layout>
    </ConfigProvider>
  );
}
