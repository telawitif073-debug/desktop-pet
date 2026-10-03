import { useEffect, useRef, useState } from 'react';
import { C, labelStyle, smallBtn } from './studioTheme';
import { cutFileName, payloadBlob } from '../renderer/publishFiles';
import type { PublishFilePayload } from '../global.d';

/**
 * 宠物主体扣取（原平台 Web「宠物主体扣取」面板的桌面版）：
 * - AI 扣取：@imgly/background-removal 自动去背景（模型首次使用时联网下载，约 40MB）
 * - 手动扣取：在预览图上拖拽框选，按选区裁剪成 PNG
 * 只在主文件为单图（png/jpg/webp）时显示；扣取结果直接替换待上传的主文件。
 */
const SubjectCutout = ({
  file,
  onChange,
  onNotify,
}: {
  file: PublishFilePayload;
  onChange: (next: PublishFilePayload) => void;
  onNotify: (text: string) => void;
}) => {
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const originalRef = useRef<PublishFilePayload | null>(null);
  const [isCutResult, setIsCutResult] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const selection = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // 扣取结果文件名带 -cut 后缀：带后缀说明已处理过，记住此前的原图供「恢复原图」用
  useEffect(() => {
    if (file.name.includes('-cut')) {
      setIsCutResult(true);
      return;
    }
    originalRef.current = file;
    setIsCutResult(false);
  }, [file]);

  useEffect(() => {
    const url = URL.createObjectURL(payloadBlob(file, 'image/png'));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /** 画布内在尺寸对齐图片自然尺寸：画布只在「手动框选」时挂载，
   *  图片加载完成时它还不存在，因此切换模式/换图后都要重新同步（否则框选坐标会错位） */
  const syncCanvasSize = () => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;
    const width = image.naturalWidth || 1;
    const height = image.naturalHeight || 1;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };

  useEffect(syncCanvasSize, [mode, previewUrl]);

  const runAiExtraction = async () => {
    setBusy(true);
    setError('');
    try {
      const { removeBackground } = await import('@imgly/background-removal');
      const blob = await removeBackground(payloadBlob(file, 'image/png'), { output: { format: 'image/png' } });
      onChange({ name: cutFileName(file.name, '-ai-cut'), type: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) });
      onNotify('AI 已完成主体扣取');
    } catch (e) {
      setError(`AI 扣取失败：${e instanceof Error ? e.message : String(e)}（可改用手动框选）`);
    } finally {
      setBusy(false);
    }
  };

  /** 框选绘制：显示区坐标 → 画布自然像素坐标（预览图被 CSS 缩放时仍能正确对齐） */
  const drawSelection = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!startPoint.current || !canvas) return;
    syncCanvasSize();
    const bounds = canvas.getBoundingClientRect();
    const scaleX = bounds.width ? canvas.width / bounds.width : 1;
    const scaleY = bounds.height ? canvas.height / bounds.height : 1;
    const current = {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * scaleX)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * scaleY)),
    };
    const next = {
      x: Math.min(startPoint.current.x, current.x),
      y: Math.min(startPoint.current.y, current.y),
      width: Math.abs(current.x - startPoint.current.x),
      height: Math.abs(current.y - startPoint.current.y),
    };
    selection.current = next;
    const context = canvas.getContext('2d');
    if (!context || !imageRef.current) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(16, 49, 46, .5)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.clearRect(next.x, next.y, next.width, next.height);
    context.strokeStyle = '#d9f27c';
    context.lineWidth = Math.max(1, Math.round(canvas.width / 200));
    context.strokeRect(next.x, next.y, next.width, next.height);
  };

  const useManualCrop = async () => {
    const crop = selection.current;
    const image = imageRef.current;
    if (!crop || !image || crop.width < 8 || crop.height < 8) {
      setError('请先在图片上拖拽框选宠物主体（至少 8×8 像素）');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(crop.width));
      canvas.height = Math.max(1, Math.round(crop.height));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('画布不可用');
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法生成处理后的图片');
      onChange({ name: cutFileName(file.name, '-cut'), type: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) });
      onNotify('手动裁剪已完成');
    } catch (e) {
      setError(`手动扣取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 10, padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>宠物主体扣取</span>
        <span style={{ fontSize: 11, color: C.sub }}>先把宠物从原图提取出来，再提交资源</span>
        <div style={{ flex: 1 }} />
        {(['ai', 'manual'] as const).map((item) => (
          <button key={item} type="button" onClick={() => setMode(item)} style={smallBtn(mode === item)}>
            {item === 'ai' ? 'AI 扣取' : '手动框选'}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ position: 'relative', width: 180, flexShrink: 0 }}>
          <img
            ref={imageRef}
            src={previewUrl}
            alt="待处理宠物图片"
            style={{ display: 'block', width: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 4, background: '#181818' }}
            onLoad={syncCanvasSize}
          />
          {mode === 'manual' && (
            <canvas
              ref={canvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair' }}
              onPointerDown={(event) => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const bounds = canvas.getBoundingClientRect();
                const scaleX = bounds.width ? canvas.width / bounds.width : 1;
                const scaleY = bounds.height ? canvas.height / bounds.height : 1;
                startPoint.current = { x: (event.clientX - bounds.left) * scaleX, y: (event.clientY - bounds.top) * scaleY };
                // 指针已释放等场景下 setPointerCapture 会抛错，捕获不到指针不影响框选
                try {
                  canvas.setPointerCapture(event.pointerId);
                } catch {
                  /* 忽略：仍按普通指针事件继续拖动 */
                }
              }}
              onPointerMove={(event) => mode === 'manual' && drawSelection(event)}
              onPointerUp={() => {
                startPoint.current = null;
              }}
            />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>{file.name}</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void (mode === 'ai' ? runAiExtraction() : useManualCrop())}
              style={{ ...smallBtn(true), opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}
            >
              {busy ? '处理中…' : mode === 'ai' ? '开始 AI 扣取' : '使用框选区域'}
            </button>
            {isCutResult && originalRef.current && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const original = originalRef.current;
                  if (original) {
                    onChange(original);
                    selection.current = null;
                    onNotify('已恢复原图');
                  }
                }}
                style={smallBtn()}
              >
                恢复原图
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.7 }}>
            {mode === 'ai'
              ? 'AI 会自动识别主体并去除背景；首次使用需联网下载模型（约 40MB），之后本机缓存。'
              : '在左侧预览图上按住拖拽框选宠物主体，点「使用框选区域」按选区裁剪为 PNG。'}
          </div>
          {error && <div style={{ fontSize: 11, color: C.danger, marginTop: 6, lineHeight: 1.7 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
};

export default SubjectCutout;