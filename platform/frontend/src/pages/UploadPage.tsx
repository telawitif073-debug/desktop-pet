import { useState } from 'react';
import { Button, Card, Form, Input, Radio, Space, Typography, Upload, message } from 'antd';
import { CloudUploadOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useNavigate } from 'react-router-dom';
import { uploadAsset } from '../api';
import type { AssetType } from '../types';
import { getErrorMessage } from '../utils';
import SubjectExtractionPanel from '../components/SubjectExtractionPanel';

const { Dragger } = Upload;

export default function UploadPage() {
  const [type, setType] = useState<AssetType>('pet');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const selectedFile = fileList[0]?.originFileObj ?? null;

  const setSelectedFile = (file: File | null) => {
    setFileList(file ? [{ uid: `${Date.now()}`, name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] }] : []);
  };

  const submit = async (values: Record<string, unknown>) => {
    const file = selectedFile;
    if (!file) { messageApi.warning('请先选择资源文件'); return; }
    setLoading(true);
    try {
      await uploadAsset(type, { ...values, tags: type === 'pet' ? String(values.tags || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined, dependencies: type === 'agent' ? String(values.dependencies || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined, configSchema: type === 'agent' && values.configSchema ? JSON.parse(String(values.configSchema)) : undefined }, file);
      messageApi.success('资源已提交，等待管理员审核'); navigate('/profile');
    } catch (err) { messageApi.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  };

  return <div className="content-wrap narrow-page"><div className="page-heading"><span className="eyebrow">SHARE YOUR WORK</span><Typography.Title>上传一个新资源</Typography.Title><Typography.Paragraph>填写清晰的说明，审核通过后它会出现在公共资源库中。</Typography.Paragraph></div>{contextHolder}<Card className="form-card" bordered={false}><Form layout="vertical" onFinish={submit} requiredMark={false}><Form.Item label="资源类型"><Radio.Group value={type} onChange={(event) => { setType(event.target.value); setFileList([]); }}><Radio.Button value="pet">宠物资源</Radio.Button><Radio.Button value="agent">智能体</Radio.Button></Radio.Group></Form.Item><Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入资源名称' }]}><Input size="large" placeholder="例如：赛博猫咪表情包" /></Form.Item><Form.Item name="description" label="描述"><Input.TextArea rows={4} placeholder="它有什么特点？适合什么场景？" /></Form.Item>{type === 'pet' ? <><Form.Item name="category" label="分类"><Input placeholder="图片、动画或 3D" /></Form.Item><Form.Item name="tags" label="标签"><Input placeholder="用逗号分隔，例如：猫, 可爱, 动画" /></Form.Item><SubjectExtractionPanel file={selectedFile} onChange={setSelectedFile} /></> : <><Form.Item name="type" label="智能体类型" initialValue="chat"><Radio.Group options={[{ label: '对话', value: 'chat' }, { label: '任务', value: 'task' }, { label: '混合', value: 'mixed' }]} /></Form.Item><Form.Item name="dependencies" label="依赖"><Input placeholder="用逗号分隔，可留空" /></Form.Item><Form.Item name="configSchema" label="配置 JSON"><Input.TextArea rows={5} placeholder='例如：{"systemPrompt":"你是一个友好的助手"}' /></Form.Item></>}<Form.Item label="资源文件" required><Dragger maxCount={1} fileList={fileList} beforeUpload={() => false} onChange={({ fileList: next }) => setFileList(next)}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p>点击或拖拽文件到这里</p><Typography.Text type="secondary">支持图片、压缩包、JSON、TXT 等格式</Typography.Text></Dragger></Form.Item><Space><Button onClick={() => navigate(-1)}>取消</Button><Button type="primary" htmlType="submit" icon={<CloudUploadOutlined />} loading={loading}>提交审核</Button></Space></Form></Card></div>;
}
