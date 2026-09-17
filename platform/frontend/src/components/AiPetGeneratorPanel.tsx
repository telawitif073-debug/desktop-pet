import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import { RobotOutlined, ReloadOutlined } from '@ant-design/icons';
import { generatePetDesign } from '../api';
import { drawPetDesign, type PetDesign } from '../utils/petCanvas';

interface Props {
  onApply: (file: File, design: PetDesign) => void;
}

/** AI 生成宠物：文字描述 → LLM 产出形象参数 → Canvas 参数化绘制 → 填入上传表单 */
export default function AiPetGeneratorPanel({ onApply }: Props) {
  const [description, setDescription] = useState('');
  const [design, setDesign] = useState<PetDesign | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (design && canvasRef.current) drawPetDesign(canvasRef.current, design);
  }, [design]);

  const handleGenerate = async () => {
    if (description.trim().length < 2) return;
    setLoading(true);
    setError('');
    try {
      setDesign(await generatePetDesign(description.trim()));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg || (err instanceof Error ? err.message : '生成失败'));
      setDesign(null);
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!design || !canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `${design.name || 'ai-pet'}.png`, { type: 'image/png' });
      onApply(file, design);
    }, 'image/png');
  };

  return (
    <Card size="small" title={<Space><RobotOutlined /> AI 生成宠物形象</Space>} style={{ marginBottom: 16 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder="描述想要的宠物，例如：一只圆滚滚的橘猫，带深色条纹"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onPressEnter={handleGenerate}
          maxLength={200}
        />
        <Button type="primary" loading={loading} onClick={handleGenerate}>生成</Button>
      </Space.Compact>
      {error && <Alert type="error" showIcon style={{ marginTop: 10 }} message={error} />}
      {design && (
        <div style={{ marginTop: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <canvas ref={canvasRef} style={{ width: 150, height: 150, border: '1px solid #eee', borderRadius: 8, background: '#fafafa' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <Typography.Text strong>{design.name}</Typography.Text>
            {design.desc && <div><Typography.Text type="secondary">{design.desc}</Typography.Text></div>}
            <div style={{ marginTop: 8 }}>
              <Button icon={<ReloadOutlined />} size="small" onClick={handleGenerate} loading={loading}>重新生成</Button>{' '}
              <Button type="primary" size="small" onClick={handleApply}>填入上传表单</Button>
            </div>
          </div>
        </div>
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
        生成后点击"填入上传表单"，形象图片与名称/描述会自动填充，仍需提交审核。客户端安装该宠物后会自动生成配套动作（吃饭/走路/休息/玩耍）。
      </Typography.Paragraph>
    </Card>
  );
}
