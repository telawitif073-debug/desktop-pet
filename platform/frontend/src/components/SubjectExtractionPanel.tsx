import { useEffect, useRef, useState } from 'react';
import { Button, Card, Segmented, Space, Spin, Typography, Upload, message } from 'antd';
import { AimOutlined, CheckOutlined, ClearOutlined, ScissorOutlined } from '@ant-design/icons';
import { removeBackground } from '@imgly/background-removal';

interface SubjectExtractionPanelProps {
  file: File | null;
  onChange: (file: File | null) => void;
}

type ExtractionMode = 'ai' | 'manual';

function fileFromCanvas(canvas: HTMLCanvasElement, name: string) {
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法生成处理后的图片'));
        return;
      }
      resolve(new File([blob], name.replace(/\.[^.]+$/, '') + '-cut.png', { type: 'image/png' }));
    }, 'image/png');
  });
}

export default function SubjectExtractionPanel({ file, onChange }: SubjectExtractionPanelProps) {
  const [mode, setMode] = useState<ExtractionMode>('ai');
  const [previewUrl, setPreviewUrl] = useState('');
  const [processing, setProcessing] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const selection = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const runAiExtraction = async () => {
    if (!file) return;
    setProcessing(true);
    try {
      const result = await removeBackground(file, {
        output: { format: 'image/png' },
      });
      onChange(new File([result], file.name.replace(/\.[^.]+$/, '') + '-ai-cut.png', { type: 'image/png' }));
      messageApi.success('AI 已完成主体扣取');
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : 'AI 扣取失败，请重试');
    } finally {
      setProcessing(false);
    }
  };

  const drawSelection = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!startPoint.current || !canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const current = {
      x: Math.max(0, Math.min(canvasRef.current.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(canvasRef.current.height, event.clientY - bounds.top)),
    };
    const next = {
      x: Math.min(startPoint.current.x, current.x),
      y: Math.min(startPoint.current.y, current.y),
      width: Math.abs(current.x - startPoint.current.x),
      height: Math.abs(current.y - startPoint.current.y),
    };
    selection.current = next;
    const context = canvasRef.current.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    context.drawImage(imageRef.current!, 0, 0, canvasRef.current.width, canvasRef.current.height);
    context.fillStyle = 'rgba(16, 49, 46, .5)';
    context.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    context.clearRect(next.x, next.y, next.width, next.height);
    context.strokeStyle = '#d9f27c';
    context.lineWidth = 3;
    context.strokeRect(next.x, next.y, next.width, next.height);
  };

  const finishManualCrop = async () => {
    const crop = selection.current;
    const image = imageRef.current;
    if (!crop || !image || crop.width < 8 || crop.height < 8) {
      messageApi.warning('请先在图片上拖拽框选宠物主体');
      return;
    }
    setProcessing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = crop.width;
      canvas.height = crop.height;
      canvas.getContext('2d')?.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      onChange(await fileFromCanvas(canvas, file?.name || 'pet.png'));
      messageApi.success('手动裁剪已完成');
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '手动扣取失败');
    } finally {
      setProcessing(false);
    }
  };

  const reset = () => {
    if (file) onChange(file);
    selection.current = null;
  };

  return <Card className="subject-extraction" variant="borderless" title={<Space><ScissorOutlined />宠物主体扣取</Space>}>
    {contextHolder}
    <Typography.Paragraph type="secondary">先把宠物从原图中提取出来，再提交资源。AI 模式自动去除背景，手动模式按框选区域裁剪。</Typography.Paragraph>
    <Segmented block value={mode} onChange={(value) => setMode(value as ExtractionMode)} options={[{ label: 'AI 扣取', value: 'ai' }, { label: '手动扣取', value: 'manual' }]} />
    <div className="subject-preview">
      {file ? <><img ref={imageRef} src={previewUrl} alt="待处理宠物图片" onLoad={(event) => { const image = event.currentTarget; if (canvasRef.current) { canvasRef.current.width = image.naturalWidth; canvasRef.current.height = image.naturalHeight; } }} /><canvas ref={canvasRef} onPointerDown={(event) => { if (mode !== 'manual' || !canvasRef.current) return; const bounds = canvasRef.current.getBoundingClientRect(); startPoint.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; canvasRef.current.setPointerCapture(event.pointerId); }} onPointerMove={(event) => mode === 'manual' && drawSelection(event)} onPointerUp={() => { startPoint.current = null; }} /></> : <Upload.Dragger showUploadList={false} accept="image/png,image/jpeg,image/webp" beforeUpload={(next) => { onChange(next); return false; }}><AimOutlined className="subject-upload-icon" /><p>选择宠物图片</p></Upload.Dragger>}
    </div>
    {file && <Space wrap className="subject-actions">
      {mode === 'ai' ? <Button type="primary" icon={<AimOutlined />} loading={processing} onClick={runAiExtraction}>开始 AI 扣取</Button> : <Button type="primary" icon={<ScissorOutlined />} loading={processing} onClick={finishManualCrop}>使用框选区域</Button>}
      <Button icon={<ClearOutlined />} onClick={reset}>恢复原图</Button>
    </Space>}
    {processing && <div className="subject-processing"><Spin /> 正在处理图片，首次 AI 扣取需要加载模型</div>}
  </Card>;
}
