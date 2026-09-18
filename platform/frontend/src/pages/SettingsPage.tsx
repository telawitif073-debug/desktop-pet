import { useEffect, useState } from 'react';
import { Alert, Button, Card, Slider, Switch, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import type { PetWindowSettings, PetFeaturesSettings } from '../types';
import { getErrorMessage } from '../utils';

// Electron 客户端桥接（浏览器环境下为空）
const electronConfig = window.electronAPI?.config;

const DEFAULTS: PetWindowSettings = { width: 300, height: 300, opacity: 1 };
const FEATURE_DEFAULTS: PetFeaturesSettings = { feedEnabled: true, restEnabled: true, playEnabled: true, affectionEnabled: true };

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
  const [randomMove, setRandomMove] = useState(false);
  const [loading, setLoading] = useState(electronConfig ? true : false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (!electronConfig) return;
    electronConfig.get().then((config) => {
      if (config.petWindow) setSettings({ ...DEFAULTS, ...config.petWindow });
      if (config.petFeatures) setFeatures({ ...FEATURE_DEFAULTS, ...config.petFeatures });
      setRandomMove(config.randomMoveEnabled === true);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!electronConfig) return;
    try {
      await electronConfig.set({ petWindow: settings, petFeatures: features, randomMoveEnabled: randomMove });
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
            <Typography.Text strong>随机漫步</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>宠物每隔一段时间在桌面上随机左右走动（精力不足时自动休息）</Typography.Text>
          </div>
          <Switch disabled={!electronConfig} checked={randomMove} onChange={setRandomMove} />
        </div>
      </div>
      {electronConfig && <Button type="primary" icon={<SaveOutlined />} onClick={save} style={{ marginTop: 32 }}>保存设置</Button>}
    </Card>
  </div>;
}
