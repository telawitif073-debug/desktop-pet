import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Progress, Segmented, Select, Space, Typography, message } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import JSZip from 'jszip';
import { getAiGenMeta, getSpriteJob, startSpritePet, startLive2dPet, type AiGenMeta, type SpriteJobView } from '../api';

/** 生成路径：精灵表（视频截帧，纯云侧） / Live2D（See-through 拆层 + PSD2Live 建模，需本机部署） */
type GenPath = 'sprite' | 'live2d';

/** 动画配置（与后端 animations.json、客户端 SpriteAnimator 约定一致） */
interface AnimationsConfig {
  frameWidth: number;
  frameHeight: number;
  animations: Record<string, { row: number; frames: number; fps: number }>;
}

const STATE_LABELS: Array<[string, string]> = [
  ['idle', '待机'],
  ['moving', '移动'],
  ['eating', '进食'],
  ['resting', '休息'],
  ['playing', '玩耍'],
];

const STAGE_LABELS: Record<SpriteJobView['stage'], string> = {
  base: '生成基准图',
  video: '生成状态视频',
  frames: '视频截帧抠图',
  assemble: '拼合精灵表',
  layers: 'See-through 拆层',
  rig: 'PSD2Live 建模',
  pack: '打包模型',
};

/** 填入上传表单的负载：zip + 预览图 + 格式 */
export interface AiPetApplyPayload {
  file: File;
  preview: File | null;
  name: string;
  format: 'sprite' | 'live2d';
}

interface Props {
  onApply: (payload: AiPetApplyPayload) => void;
}

/** 用 <img> 预加载 dataUrl，Promise 化 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('精灵表图片加载失败'));
    img.src = src;
  });
}

/** dataUrl → File */
async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

/** dataUrl（zip）→ File */
async function zipDataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: 'application/zip' });
}

/** AI 生成宠物面板：描述 → 后端异步任务（精灵表 / Live2D 双路径）→ 预览 → 填入上传表单 */
export default function AiPetStudioPanel({ onApply }: Props) {
  const [meta, setMeta] = useState<AiGenMeta | null>(null);
  const [description, setDescription] = useState('');
  const [style, setStyle] = useState<string>('default');
  const [genPath, setGenPath] = useState<GenPath>('sprite');
  const [job, setJob] = useState<SpriteJobView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [state, setState] = useState<string>('idle');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetImgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    getAiGenMeta().then(setMeta).catch(() => setMeta(null));
  }, []);

  // 任务进行中轮询（4s）
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        setJob(await getSpriteJob(job.id));
      } catch {
        // 任务可能被重启清掉：停止即可，保持最后一次快照
        clearInterval(timer);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [job]);

  const anims = useMemo<AnimationsConfig | null>(() => {
    const raw = job?.result;
    if (!raw || raw.kind !== 'sprite' || !raw.animations || typeof raw.animations !== 'object') return null;
    const obj = raw.animations as unknown as Record<string, unknown>;
    if (typeof obj.frameWidth !== 'number' || typeof obj.frameHeight !== 'number' || !obj.animations) return null;
    return obj as unknown as AnimationsConfig;
  }, [job]);

  // 精灵表完成后预加载（Live2D 结果用 <img> 直接展示预览，无需预加载）
  useEffect(() => {
    const sheet = job?.result?.kind === 'sprite' ? job.result.sheetDataUrl : undefined;
    if (job?.status !== 'done' || !sheet) return;
    loadImage(sheet).then((img) => { sheetImgRef.current = img; }).catch(() => { sheetImgRef.current = null; });
    return () => {
      sheetImgRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [job]);

  // 精灵表动画循环（按状态 fps 步进帧序号，非 1:1 raf）
  useEffect(() => {
    if (job?.status !== 'done' || !anims) return;
    let frame = 0;
    let last = 0;
    const draw = (ts: number) => {
      rafRef.current = requestAnimationFrame(draw);
      const img = sheetImgRef.current;
      const canvas = canvasRef.current;
      const cfg = anims.animations[state];
      if (!img || !canvas || !cfg) return;
      const interval = 1000 / cfg.fps;
      if (ts - last < interval) return;
      last = ts;
      frame = (frame + 1) % cfg.frames;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, frame * anims.frameWidth, cfg.row * anims.frameHeight, anims.frameWidth, anims.frameHeight, 0, 0, canvas.width, canvas.height);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [job, anims, state]);

  const submit = useCallback(async () => {
    if (description.trim().length < 2) { message.warning('请先输入宠物描述（至少 2 个字）'); return; }
    setSubmitting(true);
    try {
      const { jobId } = genPath === 'sprite'
        ? await startSpritePet(description.trim(), style)
        : await startLive2dPet(description.trim(), style);
      setJob({ id: jobId, status: 'running', stage: 'base', done: 0, total: genPath === 'sprite' ? 12 : 4 });
      setState('idle');
    } catch (err) {
      message.error(err instanceof Error && err.message ? err.message : '任务发起失败');
    } finally {
      setSubmitting(false);
    }
  }, [description, style, genPath]);

  /** 打包产物为 zip 并填入上传表单（sprite：spritesheet+animations.json；live2d：模型文件族原样） */
  const apply = useCallback(async () => {
    const result = job?.result;
    if (!result) return;
    setApplyLoading(true);
    try {
      if (result.kind === 'sprite' && result.sheetDataUrl && result.animations) {
        const zip = new JSZip();
        zip.file('spritesheet.png', result.sheetDataUrl.replace(/^data:image\/png;base64,/, ''), { base64: true });
        zip.file('animations.json', JSON.stringify(result.animations, null, 2));
        const blob = await zip.generateAsync({ type: 'blob' });
        const file = new File([blob], `${result.name || 'ai-pet'}-sprite.zip`, { type: 'application/zip' });
        const preview = await dataUrlToFile(result.previewDataUrl, `${result.name || 'ai-pet'}-preview.png`).catch(() => null);
        onApply({ file, preview, name: result.name || 'AI 宠物', format: 'sprite' });
      } else if (result.kind === 'live2d' && result.zipDataUrl) {
        const file = await zipDataUrlToFile(result.zipDataUrl, `${result.name || 'ai-pet'}-live2d.zip`);
        const preview = await dataUrlToFile(result.previewDataUrl, `${result.name || 'ai-pet'}-preview.png`).catch(() => null);
        onApply({ file, preview, name: result.name || 'AI 宠物', format: 'live2d' });
      }
    } finally {
      setApplyLoading(false);
    }
  }, [job, onApply]);

  const running = job?.status === 'running';
  const percent = job ? Math.round((job.done / job.total) * 100) : 0;
  const isSpriteDone = job?.status === 'done' && job.result?.kind === 'sprite';
  const isLive2dDone = job?.status === 'done' && job.result?.kind === 'live2d';
  const pathUnavailable = genPath === 'sprite' ? meta && !meta.capabilities.wanVideo : meta && !meta.capabilities.live2d;

  return (
    <Card
      size="small"
      style={{ marginBottom: 24 }}
      title={<Space><ThunderboltOutlined />AI 生成宠物</Space>}
      extra={pathUnavailable ? <Typography.Text type="warning" style={{ fontSize: 12 }}>当前路径未启用</Typography.Text> : undefined}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {genPath === 'sprite' && meta && !meta.capabilities.wanVideo && (
          <Alert type="info" showIcon message="精灵表路径需要平台后端配置 DASHSCOPE_API_KEY（通义万相图生视频）" />
        )}
        {genPath === 'live2d' && meta && !meta.capabilities.live2d && (
          <Alert
            type="info"
            showIcon
            message="Live2D 路径需要后端本机部署 See-through（SEETHROUGH_HOME/SEETHROUGH_PYTHON）与 PSD2Live 便携版（PSD2LIVE_HOME）"
          />
        )}
        <Segmented
          block
          value={genPath}
          onChange={(v) => setGenPath(v as GenPath)}
          disabled={running}
          options={[
            { value: 'sprite', label: '精灵表（动画）' },
            { value: 'live2d', label: 'Live2D 模型' },
          ]}
        />
        <Input.TextArea
          rows={2}
          placeholder="描述你想要的宠物，例如：一只橘色的圆脸小猫，戴着蓝色围巾"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
          showCount
          disabled={running}
        />
        <Space wrap>
          <Select
            style={{ width: 160 }}
            value={style}
            onChange={setStyle}
            disabled={running}
            options={(meta?.styles ?? [{ id: 'default', label: '默认可爱' }]).map((s) => ({ value: s.id, label: s.label }))}
          />
          <Button type="primary" onClick={submit} loading={submitting} disabled={running}>
            {running ? '生成中…' : genPath === 'sprite' ? '生成（约 5-25 分钟）' : '生成（约 10-30 分钟）'}
          </Button>
        </Space>
        {running && (
          <div>
            <Progress percent={percent} size="small" status="active" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {STAGE_LABELS[job!.stage]}{job!.current ? `（${job!.current}）` : ''} · {job!.done}/{job!.total}
            </Typography.Text>
          </div>
        )}
        {job?.status === 'failed' && (
          <Alert type="error" showIcon message="生成失败" description={job.error} />
        )}
        {isSpriteDone && job.result && (
          <>
            <div style={{ textAlign: 'center' }}>
              <canvas ref={canvasRef} width={256} height={256} style={{ maxWidth: 256, width: '100%', imageRendering: 'auto' }} />
            </div>
            <Segmented
              block
              value={state}
              onChange={(v) => setState(v as string)}
              options={STATE_LABELS.map(([id, label]) => ({ value: id, label }))}
            />
            <Button type="primary" onClick={apply} loading={applyLoading}>
              填入上传表单（精灵表 zip + 预览图）
            </Button>
          </>
        )}
        {isLive2dDone && job.result && (
          <>
            <div style={{ textAlign: 'center' }}>
              <img src={job.result.previewDataUrl} alt="Live2D 预览" style={{ maxWidth: 256, width: '100%' }} />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已生成 .moc3 模型（含 6 秒待机动作与物理）；实际效果以客户端加载为准，可用 .cmo3 在 Cubism Editor 中微调。
            </Typography.Text>
            <Button type="primary" onClick={apply} loading={applyLoading}>
              填入上传表单（Live2D 模型 zip + 预览图）
            </Button>
          </>
        )}
      </Space>
    </Card>
  );
}
