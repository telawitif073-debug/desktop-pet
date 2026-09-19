import { useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Form, Input, InputNumber, Radio, Slider, Space, Typography, Upload, message } from 'antd';
import { CloudUploadOutlined, DeleteOutlined, InboxOutlined, PlusOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useNavigate } from 'react-router-dom';
import { uploadAsset, uploadPet } from '../api';
import type { PetActionUpload } from '../api';
import type { AssetType, PetFormat } from '../types';
import { getErrorMessage } from '../utils';
import SubjectExtractionPanel from '../components/SubjectExtractionPanel';

const { Dragger } = Upload;

/** 自带语音识别配置（随智能体资源下发，桌面客户端按 OpenAI 兼容格式调用） */
interface AgentAsrConfig {
  mode: 'transcribe' | 'chat';
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
}

interface AgentStructuredConfig {
  name: string;
  systemPrompt: string;
  temperature: number;
  model?: string;
  baseUrl?: string;
  /** 自带语音识别（可选）：填写后安装者无需配置语音模型即可对宠物说话 */
  asr?: AgentAsrConfig;
}

/** 宠物附带动作表单项：zip 帧图 或 模型内动画 clip */
interface PetActionForm {
  name: string;
  interaction: 'none' | 'feed' | 'rest' | 'play';
  mode: 'zip' | 'clip';
  clipName: string;
  file: File | null;
}

export default function UploadPage() {
  const [form] = Form.useForm();
  const [type, setType] = useState<AssetType>('pet');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();
  const selectedFile = fileList[0]?.originFileObj as File | null;
  const mainFileExt = selectedFile ? selectedFile.name.slice(selectedFile.name.lastIndexOf('.')).toLowerCase() : '';
  // ---- 宠物形态与附带动作（动作随宠物上传，不可跨宠物）----
  const [petFormat, setPetFormat] = useState<'auto' | PetFormat>('auto');
  const [previewList, setPreviewList] = useState<UploadFile[]>([]);
  const [actions, setActions] = useState<PetActionForm[]>([]);
  const previewFile = previewList[0]?.originFileObj as File | null;

  const setSelectedFile = (file: File | null) => {
    setFileList(file ? [{ uid: `${Date.now()}`, name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] }] : []);
  };

  const addAction = () => setActions((prev) => [...prev, { name: '', interaction: 'none', mode: 'zip', clipName: '', file: null }]);
  const removeAction = (index: number) => setActions((prev) => prev.filter((_, i) => i !== index));
  const patchAction = (index: number, patch: Partial<PetActionForm>) => setActions((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

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

  // ---- 自带语音识别（可选，默认关闭）----
  const [asrEnabled, setAsrEnabled] = useState(false);
  const [asrMode, setAsrMode] = useState<'transcribe' | 'chat'>('transcribe');
  const [asrBaseUrl, setAsrBaseUrl] = useState('');
  const [asrApiKey, setAsrApiKey] = useState('');
  const [asrModel, setAsrModel] = useState('');
  const [asrLanguage, setAsrLanguage] = useState('zh');

  const structuredConfig: AgentStructuredConfig = useMemo(() => ({
    name: agentName.trim(),
    systemPrompt: systemPrompt.trim(),
    temperature,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    // 自带语音识别：启用且接口地址/模型名齐全才写入，随配置 JSON 下发
    ...(asrEnabled && asrBaseUrl.trim() && asrModel.trim()
      ? {
          asr: {
            mode: asrMode,
            baseUrl: asrBaseUrl.trim(),
            apiKey: asrApiKey.trim(),
            model: asrModel.trim(),
            ...(asrMode === 'transcribe' && asrLanguage.trim() ? { language: asrLanguage.trim() } : {}),
          },
        }
      : {}),
  }), [agentName, systemPrompt, temperature, model, baseUrl, asrEnabled, asrMode, asrBaseUrl, asrApiKey, asrModel, asrLanguage]);

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

  const submit = async (values: Record<string, unknown>) => {
    if (type === 'pet') {
      if (!selectedFile) { messageApi.warning('请先选择资源文件'); return; }
      if ((mainFileExt === '.zip' || mainFileExt === '.glb' || mainFileExt === '.gltf') && !previewFile) {
        messageApi.warning('多图包 / Live2D / 3D 模型请上传一张预览图，便于商店展示');
        return;
      }
      for (const [index, action] of actions.entries()) {
        if (!action.name.trim()) { messageApi.warning(`第 ${index + 1} 个动作未填写名称`); return; }
        if (action.mode === 'zip' && !action.file) { messageApi.warning(`动作「${action.name || `动作${index + 1}`}」缺少帧图 zip 压缩包`); return; }
        if (action.mode === 'clip' && !action.clipName.trim()) { messageApi.warning(`动作「${action.name}」请填写模型动画 clip 名称`); return; }
      }
      setLoading(true);
      try {
        await uploadPet(
          {
            ...values,
            tags: String(values.tags || '').split(',').map((item) => item.trim()).filter(Boolean),
            ...(petFormat === 'auto' ? {} : { format: petFormat }),
          },
          selectedFile,
          previewFile,
          actions.map((action): PetActionUpload => ({
            name: action.name.trim(),
            interaction: action.interaction,
            ...(action.mode === 'clip' ? { clipName: action.clipName.trim() } : {}),
            file: action.file ?? undefined,
          })),
        );
        messageApi.success('资源已提交，等待管理员审核');
        navigate('/profile');
      } catch (err) {
        messageApi.error(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    // ---- 智能体 ----
    let file = selectedFile;
    let configSchema: unknown;

    if (configMode === 'structured') {
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
    } else {
      if (!file) { messageApi.warning('请先选择智能体配置 JSON 文件'); return; }
      if (rawParseError || !rawConfig) { messageApi.error('配置文件不是合法 JSON，无法提交'); return; }
      configSchema = rawConfig;
    }

    setLoading(true);
    try {
      await uploadAsset('agent', {
        ...values,
        dependencies: String(values.dependencies || '').split(',').map((item) => item.trim()).filter(Boolean),
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
          <Form.Item label="自带语音识别（可选）" tooltip="勾选后，安装这个智能体的人不用下载语音模型包，对着宠物说话就能被它听懂" style={{ marginBottom: asrEnabled ? 0 : 24 }}>
            <Checkbox checked={asrEnabled} onChange={(event) => setAsrEnabled(event.target.checked)}>
              让这个智能体自带语音识别
            </Checkbox>
          </Form.Item>
          {asrEnabled && (
            <>
              <Form.Item label="识别方式">
                <Radio.Group value={asrMode} onChange={(event) => setAsrMode(event.target.value)}>
                  <Radio value="transcribe">语音转写接口（如 whisper-1）</Radio>
                  <Radio value="chat">能听音频的聊天模型（如 gpt-4o-audio）</Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item label="识别接口地址" required>
                <Input placeholder="例如：https://api.openai.com/v1" value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} allowClear />
              </Form.Item>
              <Form.Item label="识别 API Key" tooltip="会随资源一起分发；安装者也可以在客户端里替换成自己的 Key">
                <Input.Password placeholder="sk-..." value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} allowClear />
              </Form.Item>
              <Form.Item label="识别模型名" required>
                <Input placeholder={asrMode === 'chat' ? 'gpt-4o-audio' : 'whisper-1'} value={asrModel} onChange={(event) => setAsrModel(event.target.value)} allowClear />
              </Form.Item>
              {asrMode === 'transcribe' && (
                <Form.Item label="语言（可选）">
                  <Input placeholder="zh（默认中文）" value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value)} allowClear />
                </Form.Item>
              )}
              <Alert type="info" showIcon style={{ marginBottom: 16 }}
                message="自带语音识别说明"
                description="勾选后，安装这个智能体的人不用下载语音模型包，对着宠物说话就能被它听懂。需要填一个支持语音识别的接口地址；Key 会随资源下发，安装者可在客户端替换成自己的。"
              />
            </>
          )}
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
              <Typography.Text type="secondary">顶层需为对象，可包含 name / systemPrompt / temperature / model / baseUrl / asr</Typography.Text>
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
      <Card className="form-card" variant="borderless">
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
              <Form.Item name="category" label="分类"><Input placeholder="图片、动画或 3D" /></Form.Item>
              <Form.Item name="tags" label="标签"><Input placeholder="用逗号分隔，例如：猫, 可爱, 动画" /></Form.Item>
              <Form.Item label="宠物形态" tooltip="“自动识别”按文件后缀判断：zip=多图包、glb/gltf=3D 模型、其余=单图（含 GIF）。Live2D 模型包同为 zip，需手动选择">
                <Radio.Group value={petFormat} onChange={(event) => setPetFormat(event.target.value)}>
                  <Radio.Button value="auto">自动识别</Radio.Button>
                  <Radio.Button value="image">单图 / GIF</Radio.Button>
                  <Radio.Button value="pack">多图包</Radio.Button>
                  <Radio.Button value="live2d">Live2D</Radio.Button>
                  <Radio.Button value="model3d">3D 模型</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item label="资源文件" required>
                <Dragger maxCount={1} fileList={fileList} beforeUpload={() => false} onChange={({ fileList: next }) => setFileList(next)}>
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p>点击或拖拽文件到这里</p>
                  <Typography.Text type="secondary">单图（png/jpg/gif/webp）、多图包 zip（帧序列）、Live2D 模型 zip（含 model3.json）、3D 模型 glb/gltf</Typography.Text>
                </Dragger>
              </Form.Item>
              <Form.Item label="预览图" required={mainFileExt === '.zip' || mainFileExt === '.glb' || mainFileExt === '.gltf'} tooltip="多图包 / Live2D / 3D 模型必须提供预览图；单图默认使用原图">
                <Dragger maxCount={1} accept="image/*" fileList={previewList} beforeUpload={() => false} onChange={({ fileList: next }) => setPreviewList(next)}>
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p>点击或拖拽预览图到这里</p>
                  <Typography.Text type="secondary">商店列表与详情展示用</Typography.Text>
                </Dragger>
              </Form.Item>
              <SubjectExtractionPanel file={selectedFile} onChange={setSelectedFile} />
              <Card
                size="small"
                style={{ marginBottom: 24 }}
                title="附带动作（可选，随宠物上传）"
                extra={<Button size="small" icon={<PlusOutlined />} onClick={addAction}>添加动作</Button>}
              >
                {actions.length === 0 ? (
                  <Typography.Text type="secondary">
                    动作随宠物安装，不可跨宠物使用。普通动作上传帧图 zip（1~30 张，按文件名排序播放）；模型宠物可直接填写模型内动画 clip 名称。最多 15 个。
                  </Typography.Text>
                ) : (
                  actions.map((action, index) => (
                    <Card
                      key={index}
                      type="inner"
                      size="small"
                      style={{ marginBottom: 8 }}
                      title={`动作 ${index + 1}`}
                      extra={<Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeAction(index)} />}
                    >
                      <Space direction="vertical" style={{ width: '100%' }} size={8}>
                        <Input
                          placeholder="动作名称，例如：吃饭"
                          value={action.name}
                          onChange={(event) => patchAction(index, { name: event.target.value })}
                          maxLength={30}
                          allowClear
                        />
                        <Space wrap>
                          <Radio.Group size="small" buttonStyle="solid" value={action.interaction} onChange={(event) => patchAction(index, { interaction: event.target.value })}>
                            <Radio.Button value="none">不绑定</Radio.Button>
                            <Radio.Button value="feed">喂食</Radio.Button>
                            <Radio.Button value="rest">休息</Radio.Button>
                            <Radio.Button value="play">玩耍</Radio.Button>
                          </Radio.Group>
                          <Radio.Group size="small" buttonStyle="solid" value={action.mode} onChange={(event) => patchAction(index, { mode: event.target.value })}>
                            <Radio.Button value="zip">帧图 zip</Radio.Button>
                            <Radio.Button value="clip">模型 clip</Radio.Button>
                          </Radio.Group>
                        </Space>
                        {action.mode === 'zip' ? (
                          <Dragger
                            maxCount={1}
                            accept=".zip,application/zip,application/x-zip-compressed"
                            fileList={action.file ? [{ uid: `${index}`, name: action.file.name, status: 'done' } as UploadFile] : []}
                            beforeUpload={() => false}
                            onChange={({ fileList: next }) => patchAction(index, { file: (next[0]?.originFileObj as File | undefined) ?? null })}
                          >
                            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                            <p>点击或拖拽帧图 zip 到这里</p>
                            <Typography.Text type="secondary">例如：frame-01.png、frame-02.png ...（按文件名顺序播放）</Typography.Text>
                          </Dragger>
                        ) : (
                          <Input
                            placeholder="模型内动画 clip 名称，例如：mtn_idle_01"
                            value={action.clipName}
                            onChange={(event) => patchAction(index, { clipName: event.target.value })}
                            allowClear
                          />
                        )}
                      </Space>
                    </Card>
                  ))
                )}
              </Card>
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
