import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Slider, Switch, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import type { PetWindowSettings, PetFeaturesSettings, PetSensesSettings } from '../types';
import { getErrorMessage } from '../utils';

// Electron 客户端桥接（浏览器环境下为空）
const electronConfig = window.electronAPI?.config;

const DEFAULTS: PetWindowSettings = { width: 300, height: 300, opacity: 1, alwaysOnTop: true };
const FEATURE_DEFAULTS: PetFeaturesSettings = { feedEnabled: true, restEnabled: true, playEnabled: true, affectionEnabled: true };
const SENSES_DEFAULTS: PetSensesSettings = { screen: false, mic: false, camera: false };

// 感知能力开关条目（隐私敏感，默认全关；均为持续感知，开启后宠物在后台持续使用对应能力）
const SENSE_ITEMS: Array<{ key: keyof PetSensesSettings; label: string; desc: string }> = [
  { key: 'screen', label: '持续查看桌面', desc: '宠物每 10 分钟看一次你的屏幕并主动发表简短评论（需智谱 API，自动使用免费视觉模型 glm-4v-flash）' },
  { key: 'mic', label: '持续聆听语音', desc: '宠物听到自己名字会回应一声并聆听你的需求（8 秒内说出需求）；也可以连名带事一句话说完，例如「小宠，帮我看看桌面」' },
  { key: 'camera', label: '持续查看摄像头', desc: '宠物每 15 分钟看一眼摄像头画面并主动评论（需智谱 API，自动使用免费视觉模型 glm-4v-flash）' },
];

// 互动功能开关条目（关闭后隐藏对应按钮与进度条，并冻结数值衰减）
const FEATURE_ITEMS: Array<{ key: keyof PetFeaturesSettings; label: string; desc: string }> = [
  { key: 'feedEnabled', label: '喂食', desc: '关闭后隐藏喂食按钮与饱食进度' },
  { key: 'restEnabled', label: '休息', desc: '关闭后隐藏休息按钮与精力进度' },
  { key: 'playEnabled', label: '玩耍', desc: '关闭后隐藏玩耍按钮与心情进度' },
  { key: 'affectionEnabled', label: '好感度', desc: '关闭后隐藏好感度显示' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<PetWindowSettings>(DEFAULTS);
  const [features, setFeatures] = useState<PetFeaturesSettings>(FEATURE_DEFAULTS);
  const [senses, setSenses] = useState<PetSensesSettings>(SENSES_DEFAULTS);
  const [petName, setPetName] = useState('小宠');
  const [randomMove, setRandomMove] = useState(false);
  const [loading, setLoading] = useState(electronConfig ? true : false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (!electronConfig) return;
    electronConfig.get().then((config) => {
      if (config.petWindow) setSettings({ ...DEFAULTS, ...config.petWindow });
      if (config.petFeatures) setFeatures({ ...FEATURE_DEFAULTS, ...config.petFeatures });
      if (config.petSenses) setSenses({ ...SENSES_DEFAULTS, ...config.petSenses });
      setPetName(typeof config.petName === 'string' && config.petName.trim() ? config.petName : '小宠');
      setRandomMove(config.randomMoveEnabled === true);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!electronConfig) return;
    try {
      await electronConfig.set({ petWindow: settings, petFeatures: features, petSenses: senses, petName: petName.trim().slice(0, 12) || '小宠', randomMoveEnabled: randomMove });
      messageApi.success('设置已保存，宠物窗口实时生效');
    }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };

  return <div className="content-wrap"><div className="page-heading"><div><span className="eyebrow">SETTINGS</span><Typography.Title>设置</Typography.Title><Typography.Paragraph>调整桌面宠物窗口的显示效果，保存后实时生效。</Typography.Paragraph></div></div>{contextHolder}
    {!electronConfig && <Alert type="info" showIcon message="以下设置需要在桌面宠物客户端中打开资源库才能调整" style={{ marginBottom: 24 }} />}
    <Card title="宠物页面设置" style={{ maxWidth: 560 }} loading={loading}>
      <Typography.Title level={5}>窗口大小</Typography.Title>
      <div style={{ padding: '0 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ width: 32, flexShrink: 0, color: '#666' }}>宽度</span>
          <Slider min={200} max={560} step={20} disabled={!electronConfig} value={settings.width} onChange={(width) => setSettings((cur) => ({ ...cur, width }))} marks={{ 200: '200', 560: '560' }} style={{ flex: 1 }} />
          <Typography.Text code>{settings.width}px</Typography.Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 32 }}>
          <span style={{ width: 32, flexShrink: 0, color: '#666' }}>高度</span>
          <Slider min={200} max={560} step={20} disabled={!electronConfig} value={settings.height} onChange={(height) => setSettings((cur) => ({ ...cur, height }))} marks={{ 200: '200', 560: '560' }} style={{ flex: 1 }} />
          <Typography.Text code>{settings.height}px</Typography.Text>
        </div>
      </div>
      <Typography.Title level={5} style={{ marginTop: 40 }}>窗口透明度</Typography.Title>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 8px' }}>
        <Slider min={20} max={100} step={5} disabled={!electronConfig} value={Math.round(settings.opacity * 100)} onChange={(value) => setSettings((cur) => ({ ...cur, opacity: value / 100 }))} marks={{ 20: '20%', 50: '50%', 100: '100%' }} style={{ flex: 1 }} />
        <Typography.Text code>{Math.round(settings.opacity * 100)}%</Typography.Text>
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>提示：窗口大小改变后宠物会自动等比缩放以完整显示；聊天面板打开时窗口固定为 650×450。</Typography.Paragraph>
      <Typography.Title level={5} style={{ marginTop: 40 }}>互动功能开关</Typography.Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 8px' }}>
        {FEATURE_ITEMS.map((item) => (
          <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <Typography.Text strong>{item.label}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.desc}</Typography.Text>
            </div>
            <Switch disabled={!electronConfig} checked={features[item.key]} onChange={(value) => setFeatures((cur) => ({ ...cur, [item.key]: value }))} />
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <Typography.Text strong>窗口置顶</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>宠物窗口保持在其他应用之上；关闭后切换窗口时宠物会被遮挡</Typography.Text>
          </div>
          <Switch disabled={!electronConfig} checked={settings.alwaysOnTop !== false} onChange={(value) => setSettings((cur) => ({ ...cur, alwaysOnTop: value }))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <Typography.Text strong>随机漫步</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>宠物每隔一段时间在桌面上随机左右走动（精力不足时自动休息）</Typography.Text>
          </div>
          <Switch disabled={!electronConfig} checked={randomMove} onChange={setRandomMove} />
        </div>
      </div>
      <Typography.Title level={5} style={{ marginTop: 40 }}>宠物信息</Typography.Title>
      <div style={{ padding: '0 8px', maxWidth: 420 }}>
        <Typography.Text strong>宠物名字</Typography.Text>
        <br />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>语音唤醒词：开启「持续聆听语音」后，叫它的名字它就会回应并聆听需求（建议 2 字以上减少误听）</Typography.Text>
        <Input value={petName} maxLength={12} onChange={(e) => setPetName(e.target.value)} placeholder="小宠" style={{ marginTop: 8 }} />
      </div>
      <Typography.Title level={5} style={{ marginTop: 40 }}>感知能力</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: '0 8px 16px', fontSize: 12 }}>涉及隐私，默认全部关闭；开启后聊天面板出现对应功能按钮</Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 8px' }}>
        {SENSE_ITEMS.map((item) => (
          <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <Typography.Text strong>{item.label}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.desc}</Typography.Text>
            </div>
            <Switch disabled={!electronConfig} checked={senses[item.key]} onChange={(value) => setSenses((cur) => ({ ...cur, [item.key]: value }))} />
          </div>
        ))}
      </div>
      {electronConfig && <Button type="primary" icon={<SaveOutlined />} onClick={save} style={{ marginTop: 32 }}>保存设置</Button>}
    </Card>
  </div>;
}
