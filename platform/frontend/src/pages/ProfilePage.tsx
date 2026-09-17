import { useEffect, useState } from 'react';
import { Button, Card, Empty, Form, Input, Modal, Popconfirm, Radio, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, SwapOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { assetUrl, deleteAsset, deleteDownloaded, listDownloaded, listMine, updateAsset } from '../api';
import type { Asset, AssetType, DownloadedEntry } from '../types';
import { formatDate, getErrorMessage } from '../utils';

// Electron 客户端桥接（浏览器环境下为空）
const electronPlatform = window.electronAPI?.platform;
// 从安装路径 userData/pets|agents/{资源id}/... 中解析当前生效的资源 id
const ACTIVE_ID_PATTERN = /[\\/](?:pets|agents)[\\/]([0-9a-f-]{36})[\\/]/i;

export default function ProfilePage() {
  const [type, setType] = useState<AssetType>('pet');
  const [items, setItems] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm();
  const [downloaded, setDownloaded] = useState<DownloadedEntry[]>([]);
  const [downloadLoading, setDownloadLoading] = useState(true);
  const [activeIds, setActiveIds] = useState<{ pet: string | null; agent: string | null }>({ pet: null, agent: null });
  const [applying, setApplying] = useState<string | null>(null);

  const load = () => { setLoading(true); listMine(type).then(setItems).catch((err) => messageApi.error(getErrorMessage(err))).finally(() => setLoading(false)); };
  useEffect(load, [type]);

  // 已下载资源 + 客户端内当前生效的形象（仅 Electron 客户端能读取与更换）
  useEffect(() => {
    listDownloaded().then((entries) => setDownloaded(entries.filter((entry) => entry.asset))).catch(() => setDownloaded([])).finally(() => setDownloadLoading(false));
    if (electronPlatform) {
      Promise.all([electronPlatform.getInstalledPet(), electronPlatform.getInstalledAgent()])
        .then(([pet, agent]) => setActiveIds({
          pet: pet?.path ? pet.path.match(ACTIVE_ID_PATTERN)?.[1] ?? null : null,
          agent: agent?.id ?? null,
        }))
        .catch(() => setActiveIds({ pet: null, agent: null }));
    }
  }, []);

  const openEdit = (asset: Asset) => { setEditing(asset); form.setFieldsValue({ name: asset.name, description: asset.description, category: asset.category, tags: asset.tags?.join(', '), version: asset.version, type: asset.type }); };
  const save = async (values: Record<string, unknown>) => {
    if (!editing) return;
    try { const next = await updateAsset(type, editing.id, { ...values, tags: type === 'pet' ? String(values.tags || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined }); setItems((current) => current.map((item) => item.id === next.id ? next : item)); setEditing(null); messageApi.success('资源已更新'); }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };
  const remove = async (id: string) => { try { await deleteAsset(type, id); setItems((current) => current.filter((item) => item.id !== id)); messageApi.success('资源已删除'); } catch (err) { messageApi.error(getErrorMessage(err)); } };

  // 把某个已下载资源安装为当前宠物形象 / 智能体
  const applyDownloaded = async (entry: DownloadedEntry) => {
    if (!electronPlatform || !entry.asset) return;
    setApplying(entry.assetId);
    try {
      await electronPlatform.install(entry.assetType, entry.assetId);
      setActiveIds((current) => ({ ...current, [entry.assetType]: entry.assetId }));
      messageApi.success(entry.assetType === 'pet' ? `已更换宠物形象：${entry.asset.name}` : `已更换智能体：${entry.asset.name}`);
    }
    catch (err) { messageApi.error(getErrorMessage(err)); }
    finally { setApplying(null); }
  };

  // 删除已下载资源：移除本地安装文件（客户端内）并清除下载记录
  const removeDownloaded = async (entry: DownloadedEntry) => {
    try {
      if (electronPlatform) await electronPlatform.uninstall(entry.assetType, entry.assetId);
      await deleteDownloaded(entry.assetType, entry.assetId);
      setDownloaded((current) => current.filter((item) => !(item.assetType === entry.assetType && item.assetId === entry.assetId)));
      setActiveIds((current) => ({ ...current, [entry.assetType]: current[entry.assetType] === entry.assetId ? null : current[entry.assetType] }));
      messageApi.success('已删除该下载资源');
    }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };

  const statusTag = (status: string) => <Tag color={status === 'approved' ? 'green' : status === 'rejected' ? 'red' : 'gold'}>{status === 'approved' ? '已通过' : status === 'rejected' ? '已驳回' : '审核中'}</Tag>;

  return <div className="content-wrap"><div className="page-heading profile-heading"><div><span className="eyebrow">YOUR LIBRARY</span><Typography.Title>我的资源</Typography.Title><Typography.Paragraph>管理你上传的作品，查看审核状态并继续完善它们。</Typography.Paragraph></div><Button type="primary"><Link to="/upload">上传新资源</Link></Button></div>{contextHolder}<Tabs activeKey={type} onChange={(value) => setType(value as AssetType)} items={[{ key: 'pet', label: '宠物资源' }, { key: 'agent', label: '智能体' }]} />{loading ? <div className="loading-state"><Spin /></div> : items.length ? <div className="mine-list">{items.map((asset) => <Card key={asset.id} className="mine-card" bordered={false}><div><Typography.Title level={5}>{asset.name}</Typography.Title><Typography.Paragraph ellipsis={{ rows: 1 }} type="secondary">{asset.description || '暂无描述'}</Typography.Paragraph>{statusTag(asset.status)}</div><Space><Button icon={<EditOutlined />} onClick={() => openEdit(asset)}>编辑</Button><Popconfirm title="确定删除这个资源吗？" onConfirm={() => remove(asset.id)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space></Card>)}</div> : <Empty description="你还没有上传资源" />}

      <section className="downloaded-section">
        <div className="page-heading"><Typography.Title level={3}>已下载资源</Typography.Title><Typography.Paragraph>下载的资源会安装到桌面宠物客户端的数据目录，在这里可以随时换回喜欢的形象。</Typography.Paragraph></div>
        {downloadLoading ? <div className="loading-state"><Spin /></div> : downloaded.length ? <div className="mine-list">{downloaded.map((entry) => {
          const asset = entry.asset!;
          const isActive = activeIds[entry.assetType] === entry.assetId;
          return <Card key={`${entry.assetType}-${entry.assetId}`} className="mine-card downloaded-card" bordered={false}>
            <div className="downloaded-info">
              {asset.previewUrl ? <div className="downloaded-thumb"><img src={assetUrl(asset.previewUrl)} alt={asset.name} /></div> : <div className="downloaded-thumb downloaded-thumb-empty">{asset.name.slice(0, 1)}</div>}
              <div>
                <div className="downloaded-title"><Typography.Title level={5}>{asset.name}</Typography.Title>{isActive && <Tag color="cyan">当前使用</Tag>}</div>
                <Space size={6} wrap><Tag color={entry.assetType === 'pet' ? 'geekblue' : 'purple'}>{entry.assetType === 'pet' ? '宠物形象' : '智能体'}</Tag>{statusTag(asset.status)}<Typography.Text type="secondary">下载于 {formatDate(entry.downloadedAt)}</Typography.Text></Space>
              </div>
            </div>
            <Space>
              {electronPlatform
                ? <Button type={isActive ? 'default' : 'primary'} icon={<SwapOutlined />} loading={applying === entry.assetId} disabled={isActive} onClick={() => applyDownloaded(entry)}>{isActive ? '使用中' : entry.assetType === 'pet' ? '设为宠物形象' : '设为智能体'}</Button>
                : <Typography.Text type="secondary">在桌面宠物客户端中可一键更换</Typography.Text>}
              <Popconfirm title="确定删除这个已下载资源吗？" description={electronPlatform ? '本地安装文件将一并移除；若正在使用，重启客户端后恢复默认形象。' : '仅移除下载记录。'} onConfirm={() => removeDownloaded(entry)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>
            </Space>
          </Card>;
        })}</div> : <Empty description="还没有下载记录，去探索资源挑一个吧" />}
      </section>

      <Modal title="编辑资源" open={!!editing} onCancel={() => setEditing(null)} footer={null}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input /></Form.Item><Form.Item name="description" label="描述"><Input.TextArea rows={4} /></Form.Item>{type === 'pet' ? <><Form.Item name="category" label="分类"><Input /></Form.Item><Form.Item name="tags" label="标签"><Input /></Form.Item></> : <Form.Item name="type" label="类型"><Radio.Group options={[{ label: '对话', value: 'chat' }, { label: '任务', value: 'task' }, { label: '混合', value: 'mixed' }]} /></Form.Item>}<Form.Item name="version" label="版本"><Input /></Form.Item><Button type="primary" htmlType="submit">保存更改</Button></Form></Modal></div>;
}
