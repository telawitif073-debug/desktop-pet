import { useEffect, useState } from 'react';
import { Button, Card, Empty, Image, Pagination, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import { CheckOutlined, CloseOutlined, EyeOutlined } from '@ant-design/icons';
import { Link, Navigate } from 'react-router-dom';
import { approveAsset, assetUrl, listAssets, rejectAsset } from '../api';
import type { Asset, AssetType, PageResponse, User } from '../types';
import { formatDate, getErrorMessage } from '../utils';

export default function AdminPage({ user }: { user: User | null }) {
  const [type, setType] = useState<AssetType>('pet');
  const [result, setResult] = useState<PageResponse>({ items: [], total: 0, page: 1, limit: 10, totalPages: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [messageApi, contextHolder] = message.useMessage();

  const load = () => {
    setLoading(true);
    listAssets(type, { status: 'pending', page, limit: 10, sort: 'createdAt' })
      .then(setResult).catch((err) => messageApi.error(getErrorMessage(err))).finally(() => setLoading(false));
  };
  useEffect(load, [type, page]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const updateStatus = async (asset: Asset, action: 'approve' | 'reject') => {
    setBusyId(asset.id);
    try {
      await (action === 'approve' ? approveAsset(type, asset.id) : rejectAsset(type, asset.id));
      messageApi.success(action === 'approve' ? '资源已通过审核' : '资源已驳回');
      setResult({ ...result, items: result.items.filter((item) => item.id !== asset.id), total: result.total - 1 });
    } catch (err) { messageApi.error(getErrorMessage(err)); }
    finally { setBusyId(''); }
  };

  return <div className="content-wrap admin-page">
    {contextHolder}
    <div className="page-heading"><span className="eyebrow">MODERATION DESK</span><Typography.Title>审核工作台</Typography.Title><Typography.Paragraph>检查创作者提交的资源，确认内容质量后再发布到公共资源库。</Typography.Paragraph></div>
    <Tabs activeKey={type} onChange={(value) => { setType(value as AssetType); setPage(1); }} items={[{ key: 'pet', label: '待审宠物' }, { key: 'agent', label: '待审智能体' }]} />
    {loading ? <div className="loading-state"><Spin /></div> : result.items.length ? <div className="moderation-list">{result.items.map((asset) => <Card key={asset.id} variant="borderless" className="moderation-card"><div className="moderation-thumb">{asset.previewUrl ? <Image preview src={assetUrl(asset.previewUrl)} alt="" /> : <span>{asset.name.slice(0, 1)}</span>}</div><div className="moderation-info"><div className="moderation-title"><Typography.Title level={4}>{asset.name}</Typography.Title><Tag color="gold">待审核</Tag></div><Typography.Paragraph ellipsis={{ rows: 2 }}>{asset.description || '暂无描述'}</Typography.Paragraph><Typography.Text type="secondary">作者：{asset.author?.username || '未知'} · 提交于 {formatDate(asset.createdAt)}</Typography.Text></div><Space className="moderation-actions"><Button icon={<EyeOutlined />}><Link to={`/asset/${type}/${asset.id}`}>查看</Link></Button><Button type="primary" icon={<CheckOutlined />} loading={busyId === asset.id} onClick={() => updateStatus(asset, 'approve')}>通过</Button><Button danger icon={<CloseOutlined />} loading={busyId === asset.id} onClick={() => updateStatus(asset, 'reject')}>驳回</Button></Space></Card>)}</div> : <Empty description="当前没有待审核资源" />}
    {!!result.total && <Pagination className="pagination" current={page} pageSize={result.limit} total={result.total} showSizeChanger={false} onChange={setPage} />}
  </div>;
}
