import { useEffect, useState } from 'react';
import { Button, Card, Empty, Form, Input, Modal, Popconfirm, Radio, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { deleteAsset, listMine, updateAsset } from '../api';
import type { Asset, AssetType } from '../types';
import { getErrorMessage } from '../utils';

export default function ProfilePage() {
  const [type, setType] = useState<AssetType>('pet');
  const [items, setItems] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm();

  const load = () => { setLoading(true); listMine(type).then(setItems).catch((err) => messageApi.error(getErrorMessage(err))).finally(() => setLoading(false)); };
  useEffect(load, [type]);

  const openEdit = (asset: Asset) => { setEditing(asset); form.setFieldsValue({ name: asset.name, description: asset.description, category: asset.category, tags: asset.tags?.join(', '), version: asset.version, type: asset.type }); };
  const save = async (values: Record<string, unknown>) => {
    if (!editing) return;
    try { const next = await updateAsset(type, editing.id, { ...values, tags: type === 'pet' ? String(values.tags || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined }); setItems((current) => current.map((item) => item.id === next.id ? next : item)); setEditing(null); messageApi.success('资源已更新'); }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };
  const remove = async (id: string) => { try { await deleteAsset(type, id); setItems((current) => current.filter((item) => item.id !== id)); messageApi.success('资源已删除'); } catch (err) { messageApi.error(getErrorMessage(err)); } };

  return <div className="content-wrap"><div className="page-heading profile-heading"><div><span className="eyebrow">YOUR LIBRARY</span><Typography.Title>我的资源</Typography.Title><Typography.Paragraph>管理你上传的作品，查看审核状态并继续完善它们。</Typography.Paragraph></div><Button type="primary"><Link to="/upload">上传新资源</Link></Button></div>{contextHolder}<Tabs activeKey={type} onChange={(value) => setType(value as AssetType)} items={[{ key: 'pet', label: '宠物资源' }, { key: 'agent', label: '智能体' }]} />{loading ? <div className="loading-state"><Spin /></div> : items.length ? <div className="mine-list">{items.map((asset) => <Card key={asset.id} className="mine-card" bordered={false}><div><Typography.Title level={5}>{asset.name}</Typography.Title><Typography.Paragraph ellipsis={{ rows: 1 }} type="secondary">{asset.description || '暂无描述'}</Typography.Paragraph><Tag color={asset.status === 'approved' ? 'green' : asset.status === 'rejected' ? 'red' : 'gold'}>{asset.status === 'approved' ? '已通过' : asset.status === 'rejected' ? '已驳回' : '审核中'}</Tag></div><Space><Button icon={<EditOutlined />} onClick={() => openEdit(asset)}>编辑</Button><Popconfirm title="确定删除这个资源吗？" onConfirm={() => remove(asset.id)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space></Card>)}</div> : <Empty description="你还没有上传资源" />}<Modal title="编辑资源" open={!!editing} onCancel={() => setEditing(null)} footer={null}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input /></Form.Item><Form.Item name="description" label="描述"><Input.TextArea rows={4} /></Form.Item>{type === 'pet' ? <><Form.Item name="category" label="分类"><Input /></Form.Item><Form.Item name="tags" label="标签"><Input /></Form.Item></> : <Form.Item name="type" label="类型"><Radio.Group options={[{ label: '对话', value: 'chat' }, { label: '任务', value: 'task' }, { label: '混合', value: 'mixed' }]} /></Form.Item>}<Form.Item name="version" label="版本"><Input /></Form.Item><Button type="primary" htmlType="submit">保存更改</Button></Form></Modal></div>;
}
