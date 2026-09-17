import { useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Radio, Slider, Space, Typography, Upload, message } from 'antd';
import { CloudUploadOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useNavigate } from 'react-router-dom';
import { uploadAsset } from '../api';
import type { AssetType } from '../types';
import { getErrorMessage } from '../utils';
import SubjectExtractionPanel from '../components/SubjectExtractionPanel';
import AiPetGeneratorPanel from '../components/AiPetGeneratorPanel';
import type { PetDesign } from '../utils/petCanvas';

const { Dragger } = Upload;

interface AgentStructuredConfig {
  name: string;
  systemPrompt: string;
  temperature: number;
  model?: string;
  baseUrl?: string;
}

export default function UploadPage() {
  const [form] = Form.useForm();
  const [type, setType] = useState<AssetType>('pet');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();
  const selectedFile = fileList[0]?.originFileObj as File | null;

  const setSelectedFile = (file: File | null) => {
    setFileList(file ? [{ uid: `${Date.now()}`, name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] }] : []);
  };

  // ---- 智能体细化配置（结构化模式）----
  const [configMode, setConfigMode] = useState<'structured' | 'raw'>('structured');
  const [agentName, setAgentName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState<number>(0.8);
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // raw 模式：上传现成 JSON 文件时的解析结果
  const [rawConfig, setRawConfig] = useState<Record<string, unknown> | null>(null);
  const [rawParseError, setRawParseError] = useState('');

  const structuredConfig: AgentStructuredConfig = useMemo(() => ({
    name: agentName.trim(),
    systemPrompt: systemPrompt.trim(),
    temperature,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  }), [agentName, systemPrompt, temperature, model, baseUrl]);

  const configPreview = useMemo(() => {
    const config = configMode === 'structured' ? structuredConfig : rawConfig;
    if (!config) return '';
    return JSON.stringify(config, null, 2);
  }, [configMode, structuredConfig, rawConfig]);

  const handleRawFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setRawConfig(null);
        setRawParseError('JSON 顶层必须是一个对象（例如 {"systemPrompt":"..."}）');
        return;
      }
      setRawConfig(parsed as Record<string, unknown>);
      setRawParseError('');
    } catch {
      setRawConfig(null);
      setRawParseError('文件不是合法 JSON，请检查格式');
    }
  };

  const handleApplyAiPet = (file: File, design: PetDesign) => {
    setSelectedFile(file);
    form.setFieldsValue({
      name: design.name || form.getFieldValue('name'),
      description: design.desc || form.getFieldValue('description'),
      category: 'AI 生成',
    });
    messageApi.success(`已填入「${design.name}」的生成图片，可直接提交审核`);
  };

  const submit = async (values: Record<string, unknown>) => {
    const resourceType = type;
    let file = selectedFile;
    let configSchema: unknown;

    if (resourceType === 'agent' && configMode === 'structured') {
      // 结构化模式：由表单自动生成配置 JSON 作为资源文件，无需手动上传
      const finalConfig: AgentStructuredConfig = {
        ...structuredConfig,
        name: structuredConfig.name || String(values.name || '').trim(),
      };
      if (!finalConfig.systemPrompt && !finalConfig.model && !finalConfig.baseUrl) {
        messageApi.warning('请至少填写系统提示词 / 模型 / 接口地址中的一项，否则智能体不会有实际效果');
        return;
      }
      file = new File([JSON.stringify(finalConfig, null, 2)], `${finalConfig.name || 'agent'}.agent.json`, { type: 'application/json' });
      configSchema = finalConfig;
    } else if (resourceType === 'agent' && configMode === 'raw') {
      if (!file) { messageApi.warning('请先选择智能体配置 JSON 文件'); return; }
      if (rawParseError || !rawConfig) { messageApi.error('配置文件不是合法 JSON，无法提交'); return; }
      configSchema = rawConfig;
    } else if (!file) {
      messageApi.warning('请先选择资源文件');
      return;
    }

    setLoading(true);
    try {
      await uploadAsset(resourceType, {
        ...values,
        tags: resourceType === 'pet' ? String(values.tags || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined,
        dependencies: resourceType === 'agent' ? String(values.dependencies || '').split(',').map((item) => item.trim()).filter(Boolean) : undefined,
        configSchema,
      }, file as File);
      messageApi.success('资源已提交，等待管理员审核');
      navigate('/profile');
    } catch (err) {
      messageApi.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const agentForm = (
    <>
      <Form.Item label="配置方式">
        <Radio.Group value={configMode} onChange={(event) => { setConfigMode(event.target.value); setRawConfig(null); setRawParseError(''); }}>
          <Radio.Button value="structured">结构化配置</Radio.Button>
          <Radio.Button value="raw">上传 JSON 文件</Radio.Button>
        </Radio.Group>
      </Form.Item>

      {configMode === 'structured' ? (
        <>
          <Form.Item label="智能体名称" tooltip="对话窗口标题展示的名称，留空则与资源名称一致">
            <Input placeholder="例如：傲娇猫娘助手" value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={30} allowClear />
          </Form.Item>
          <Form.Item label="系统提示词" tooltip="决定智能体的性格与说话方式，客户端会将其追加到宠物人格之后">
            <Input.TextArea rows={4} placeholder="例如：你是一只傲娇的猫娘，说话简洁带一点傲娇，关心主人的情绪。" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} showCount maxLength={1000} />
          </Form.Item>
          <Form.Item label="采样温度（temperature）" tooltip="越高回复越发散有创意，越低越稳定克制；客户端实际请求将使用此值">
            <Space size="large" align="center" style={{ width: '100%' }}>
              <Slider min={0} max={2} step={0.1} value={temperature} onChange={(value) => setTemperature(value)} style={{ width: 240, marginBottom: 0 }} />
              <InputNumber min={0} max={2} step={0.1} value={temperature} onChange={(value) => setTemperature(value ?? 0.8)} />
            </Space>
          </Form.Item>
          <Form.Item label="指定模型（可选）" tooltip="留空则使用桌面客户端里配置的全局模型">
            <Input placeholder="例如：deepseek-chat" value={model} onChange={(event) => setModel(event.target.value)} allowClear />
          </Form.Item>
          <Form.Item label="指定接口地址（可选）" tooltip="留空则使用桌面客户端里配置的全局 API 地址">
            <Input placeholder="例如：https://api.deepseek.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} allowClear />
          </Form.Item>
          <Alert type="info" showIcon style={{ marginBottom: 16 }}
            message="提交时将自动生成配置 JSON 作为资源文件，无需手动上传文件"
            description="安装后：系统提示词立即生效，温度/模型/接口地址会覆盖客户端手动配置。"
          />
        </>
      ) : (
        <>
          <Form.Item label="配置文件（JSON）" required>
            <Dragger maxCount={1} accept=".json,application/json,text/plain" fileList={fileList} beforeUpload={() => false} onChange={({ fileList: next }) => { setFileList(next); const f = next[0]?.originFileObj as File | undefined; if (f) handleRawFile(f); else { setRawConfig(null); setRawParseError(''); } }}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p>点击或拖拽配置 JSON 到这里</p>
              <Typography.Text type="secondary">顶层需为对象，可包含 name / systemPrompt / temperature / model / baseUrl</Typography.Text>
            </Dragger>
          </Form.Item>
          {rawParseError && <Alert type="error" showIcon style={{ marginBottom: 16 }} message="配置文件解析失败" description={rawParseError} />}
          {rawConfig && <Alert type="success" showIcon style={{ marginBottom: 16 }} message={`解析成功：包含字段 ${Object.keys(rawConfig).join('、')}`} />}
          <Form.Item name="dependencies" label="依赖"><Input placeholder="用逗号分隔，可留空" /></Form.Item>
        </>
      )}

      {configPreview && (
        <Form.Item label="配置预览（提交内容）">
          <pre style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, background: '#f6f6f6', borderRadius: 6, padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{configPreview}</pre>
        </Form.Item>
      )}
    </>
  );

  return (
    <div className="content-wrap narrow-page">
      <div className="page-heading">
        <span className="eyebrow">SHARE YOUR WORK</span>
        <Typography.Title>上传一个新资源</Typography.Title>
        <Typography.Paragraph>填写清晰的说明，审核通过后它会出现在公共资源库中。</Typography.Paragraph>
      </div>
      {contextHolder}
      <Card className="form-card" bordered={false}>
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item label="资源类型">
            <Radio.Group value={type} onChange={(event) => { setType(event.target.value); setFileList([]); }}>
              <Radio.Button value="pet">宠物资源</Radio.Button>
              <Radio.Button value="agent">智能体</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入资源名称' }]}>
            <Input size="large" placeholder="例如：赛博猫咪表情包" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={4} placeholder="它有什么特点？适合什么场景？" />
          </Form.Item>
          {type === 'pet' ? (
            <>
              <AiPetGeneratorPanel onApply={handleApplyAiPet} />
              <Form.Item name="category" label="分类"><Input placeholder="图片、动画或 3D" /></Form.Item>
              <Form.Item name="tags" label="标签"><Input placeholder="用逗号分隔，例如：猫, 可爱, 动画" /></Form.Item>
              <Form.Item label="资源文件" required>
                <Dragger maxCount={1} fileList={fileList} beforeUpload={() => false} onChange={({ fileList: next }) => setFileList(next)}>
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p>点击或拖拽文件到这里</p>
                  <Typography.Text type="secondary">支持图片、压缩包、JSON、TXT 等格式</Typography.Text>
                </Dragger>
              </Form.Item>
              <SubjectExtractionPanel file={selectedFile} onChange={setSelectedFile} />
            </>
          ) : (
            <>
              <Form.Item name="type" label="智能体类型" initialValue="chat">
                <Radio.Group options={[{ label: '对话', value: 'chat' }, { label: '任务', value: 'task' }, { label: '混合', value: 'mixed' }]} />
              </Form.Item>
              {agentForm}
            </>
          )}
          <Space>
            <Button onClick={() => navigate(-1)}>取消</Button>
            <Button type="primary" htmlType="submit" icon={<CloudUploadOutlined />} loading={loading}>提交审核</Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
