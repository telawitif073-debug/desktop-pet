import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Radio, Select, Space, Steps, Tag, Typography } from 'antd';
import { RobotOutlined, ReloadOutlined } from '@ant-design/icons';
import type { PetDesign } from '../utils/petCanvas';
import { drawSubjectFrame, encodeSubjectGif, loadSubjectImage } from '../utils/petGif';
import { buildLiteZipFromImage, DEFAULT_SUBJECT_RIG } from '../utils/petLite';
import { exportImageGlb } from '../utils/pet3d';
import {
  getAiGenMeta,
  refinePetDesign,
  runPaintingResource,
  type AiGenMeta,
  type PaintFraming,
  type PetGenFormat,
  type PaintingResourceResult,
  type PetRefineResult,
} from '../api';

/** 填入上传表单时的附加信息：宠物形态 + 商店预览图（zip/glb 形态必带）；AI 生成只出主体透明图，无背景文件 */
export interface AiApplyOptions {
  format?: 'image' | 'live2d' | 'model3d';
  preview?: File;
}

interface Props {
  onApply: (file: File, design: PetDesign, opts?: AiApplyOptions) => void;
}

/** 元数据接口失败时的兜底选项（风格完整列表以后端 /ai/meta 为准） */
const FALLBACK_META: AiGenMeta = {
  providers: [],
  styles: [
    { id: 'default', label: '默认可爱' },
    { id: 'pixel', label: '像素复古' },
    { id: 'dreamy', label: '梦幻马卡龙' },
    { id: 'guofeng', label: '国风仙侠' },
    { id: 'aidrama', label: 'AI 短剧写真' },
  ],
};

/** 四形态统一走「生成智能体 → 检测智能体 → 抠图智能体 → 检测智能体」链路，仅成品派生方式不同 */
const FORMAT_OPTIONS: Array<{ value: PetGenFormat; label: string; tip: string }> = [
  { value: 'image', label: '图片', tip: 'AI 绘图智能体链路：绘制主体立绘并自动扣除背景，成品为透明 PNG（全身/半身可选）' },
  { value: 'gif', label: 'GIF 动图', tip: '同一条 AI 链路产出透明主体，再自动生成弹跳/呼吸/轻摆循环动画 GIF' },
  { value: 'live2d', label: 'Live2D 模型', tip: '同一条 AI 链路产出透明主体，再打包为轻量 Live2D 部件包（客户端呼吸/摆动待机）' },
  { value: 'model3d', label: '3D 模型', tip: '同一条 AI 链路产出透明主体，再生成带 idle 动画的 3D 模型（GLB）' },
];

/** 分步流程：输入描述 → 细化确认 → 成品预览 */
type StepKey = 'input' | 'refine' | 'done';
const STEP_TITLES = ['描述', '细化确认', '成品'];
const STEP_INDEX: Record<StepKey, number> = { input: 0, refine: 1, done: 2 };

const SPECIES_LABELS: Record<string, string> = {
  person: '人物', cat: '兽类（猫/狗/狼）', rabbit: '兔子', bear: '熊', fox: '狐狸', panda: '熊猫',
  dragon: '龙', penguin: '企鹅', bird: '鸟类', slime: '史莱姆', aquatic: '水生（鱼/鲸）',
};

/** 成品的占位形象参数：画面由图像模型绘制，此处仅承载名称/描述供表单填充（不会被程序化渲染） */
function minimalDesign(name: string, desc: string): PetDesign {
  return {
    name: (name || 'AI 角色').slice(0, 30),
    species: 'cat',
    bodyColor: '#ffaa55',
    bellyColor: '#ffe6c8',
    earShape: 'pointy',
    earColor: '#ffaa55',
    eyeColor: '#332211',
    pattern: 'none',
    patternColor: '#dd8833',
    hasTail: true,
    tailStyle: 'curl',
    hasWings: false,
    pawColor: '',
    cheek: true,
    desc: (desc || '').slice(0, 60),
  };
}

/** 检测报告徽标：pass=绿色通过 / fail=红色项数 / skipped=灰色跳过 */
function DetectTag({ label, report }: { label: string; report?: { pass: boolean; skipped: boolean; issues: string[] } }) {
  if (!report) return null;
  if (report.skipped) return <Tag>检测跳过（未配置视觉模型）</Tag>;
  return report.pass
    ? <Tag color="success">{label}通过</Tag>
    : <Tag color="error">{label}未过（{report.issues.length} 项）</Tag>;
}

/** AI 生成宠物：描述 →（一键直达 / 分步细化确认）→ 智能体链路生成 → 预览 → 填入上传表单 */
export default function AiPetGeneratorPanel({ onApply }: Props) {
  const [format, setFormat] = useState<PetGenFormat>('image');
  const [description, setDescription] = useState('');
  const [resource, setResource] = useState<PaintingResourceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [refineLoading, setRefineLoading] = useState(false);
  const [error, setError] = useState('');
  // 链路成品：透明 PNG dataUrl + 已加载的 HTMLImageElement（GIF 编码/预览共用）
  const [painted, setPainted] = useState<string | null>(null);
  const subjectImgRef = useRef<HTMLImageElement | null>(null);
  // 构图：全身（默认）/半身；绘图智能体识别的物种标签（person=人物），用于成品展示
  const [framing, setFraming] = useState<PaintFraming>('full');
  // 分步流程状态
  const [step, setStep] = useState<StepKey>('input');
  const [refine, setRefine] = useState<PetRefineResult | null>(null);
  const [refineText, setRefineText] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  // 风格选择：default 表示默认可爱风格（绘图智能体固定星火+CogView，无需选模型）
  const [meta, setMeta] = useState<AiGenMeta>(FALLBACK_META);
  const [style, setStyle] = useState('default');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const lastDescRef = useRef('');

  // 拉取风格列表（失败保持兜底选项）
  useEffect(() => {
    getAiGenMeta().then(setMeta).catch(() => {});
  }, []);

  /** 生成成品（一键流程传 '' 即仅用原始描述；分步流程传细化+回答拼合描述） */
  const runGenerate = async (finalDescription: string) => {
    setLoading(true);
    setError('');
    setPainted(null);
    subjectImgRef.current = null;
    lastDescRef.current = finalDescription;
    try {
      // 统一智能体链路（后端编排）：生成智能体 → 检测（不合格自动带问题重试，最多 3 轮）→ 抠图智能体 → 检测
      const r = await runPaintingResource(description.trim(), framing, style, finalDescription || undefined);
      setResource(r);
      setPainted(r.dataUrl);
      subjectImgRef.current = await loadSubjectImage(r.dataUrl);
      setStep('done');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg || (err instanceof Error ? err.message : '生成失败'));
    } finally {
      setLoading(false);
    }
  };

  const handleOneClick = () => {
    if (description.trim().length < 2) return;
    void runGenerate('');
  };

  /** 步骤一：LLM 细化描述 + 识别物种 + 产出确认问题 */
  const handleRefine = async () => {
    if (description.trim().length < 2) return;
    setRefineLoading(true);
    setError('');
    try {
      const r = await refinePetDesign(description.trim(), undefined, style);
      setRefine(r);
      setRefineText(r.refined);
      setAnswers(r.questions.map(() => ''));
      setStep('refine');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg || (err instanceof Error ? err.message : '细化失败'));
    } finally {
      setRefineLoading(false);
    }
  };

  /** 分步流程最终传给生成链路的描述：细化文案 + 问题回答拼合 */
  const composedDescription = (() => {
    if (!refine) return '';
    const base = refineText.trim() || refine.refined;
    const extras = refine.questions
      .map((q, i) => (answers[i]?.trim() ? `${q}：${answers[i].trim()}` : ''))
      .filter(Boolean);
    return extras.length ? `${base}\n补充要求：${extras.join('；')}` : base;
  })();

  const handleFinalGenerate = () => {
    if (!refine) return;
    void runGenerate(composedDescription);
  };

  /** 回到第一步并清空流程产物 */
  const resetFlow = () => {
    setResource(null);
    setPainted(null);
    subjectImgRef.current = null;
    setRefine(null);
    setRefineText('');
    setAnswers([]);
    setStep('input');
  };

  // 成品预览：GIF 形态播放动画，其余形态展示透明 PNG 静态图
  useEffect(() => {
    if (step !== 'done' || format !== 'gif' || !subjectImgRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stop = false;
    const loop = () => {
      if (stop) return;
      drawSubjectFrame(canvas, subjectImgRef.current as HTMLImageElement, performance.now() % 1200);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stop = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [step, format, painted]);

  const handleApply = async () => {
    if (!resource || !painted) return;
    setApplying(true);
    setError('');
    try {
      const name = resource.name || 'ai-pet';
      const design = minimalDesign(resource.name, resource.refined);
      const img = subjectImgRef.current;
      if (format === 'image') {
        // 抠图后固定导出透明 PNG，扩展名恒为 .png
        const blob = await (await fetch(painted)).blob();
        onApply(new File([blob], `${name}.png`, { type: 'image/png' }), design, { format: 'image' });
      } else if (format === 'gif') {
        if (!img) throw new Error('主体图未加载，请重新生成');
        const blob = encodeSubjectGif(img);
        onApply(new File([blob], `${name}.gif`, { type: 'image/gif' }), design, { format: 'image' });
      } else if (format === 'live2d') {
        const { zip, preview } = await buildLiteZipFromImage(painted, DEFAULT_SUBJECT_RIG);
        onApply(
          new File([zip], `${name}.zip`, { type: 'application/zip' }),
          design,
          { format: 'live2d', preview: new File([preview], `${name}.png`, { type: 'image/png' }) },
        );
      } else {
        const glb = await exportImageGlb(painted);
        const previewBlob = await (await fetch(painted)).blob();
        onApply(
          new File([glb], `${name}.glb`, { type: 'model/gltf-binary' }),
          design,
          { format: 'model3d', preview: new File([previewBlob], `${name}.png`, { type: 'image/png' }) },
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '资源文件生成失败');
    } finally {
      setApplying(false);
    }
  };

  const failedReports = resource
    ? [resource.detect.generated, resource.detect.cutout].filter((r) => !r.skipped && !r.pass)
    : [];

  return (
    <Card size="small" title={<Space><RobotOutlined /> AI 生成宠物</Space>} style={{ marginBottom: 16 }}>
      <Steps size="small" current={STEP_INDEX[step]} items={STEP_TITLES.map((title) => ({ title }))} style={{ marginBottom: 12 }} />
      {step === 'input' && (
        <>
          <Radio.Group
            value={format}
            onChange={(e) => {
              setFormat(e.target.value as PetGenFormat);
              resetFlow();
            }}
            style={{ marginBottom: 10 }}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            {FORMAT_OPTIONS.map((opt) => (
              <Radio.Button key={opt.value} value={opt.value} title={opt.tip}>{opt.label}</Radio.Button>
            ))}
          </Radio.Group>
          <Typography.Paragraph type="secondary" style={{ margin: 0, marginBottom: 8, fontSize: 12 }}>
            {FORMAT_OPTIONS.find((opt) => opt.value === format)?.tip}
          </Typography.Paragraph>
          <Space wrap size={4} style={{ marginBottom: 8 }} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>构图</Typography.Text>
            <Radio.Group
              value={framing}
              onChange={(e) => setFraming(e.target.value as PaintFraming)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="full">全身</Radio.Button>
              <Radio.Button value="half">半身</Radio.Button>
            </Radio.Group>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>风格</Typography.Text>
            <Select
              size="small"
              style={{ width: 130 }}
              value={style}
              onChange={setStyle}
              options={meta.styles.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Space>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="描述想要的宠物或人物，例如：一位猫娘少女，银白色短发，白色猫耳，穿浅蓝色洛丽塔连衣裙"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onPressEnter={handleOneClick}
              maxLength={200}
            />
            <Button loading={refineLoading} onClick={handleRefine}>分步生成</Button>
            <Button type="primary" loading={loading} onClick={handleOneClick}>一键生成</Button>
          </Space.Compact>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
            四种形态均由智能体链路生成：绘图智能体加工提示词 → 图像模型绘制 → 检测智能体验收（不合格自动带问题重试）→ 抠图智能体去背 → 再检测验收。分步生成可先细化描述并确认。
          </Typography.Paragraph>
        </>
      )}
      {step === 'refine' && refine && (
        <>
          <Space wrap align="center" style={{ marginBottom: 6 }}>
            <Tag color="processing">识别物种：{SPECIES_LABELS[refine.species] ?? refine.species}</Tag>
            <Tag color="purple">初稿名：{refine.design.name}</Tag>
          </Space>
          <Typography.Paragraph type="secondary" style={{ margin: 0, marginBottom: 4, fontSize: 12 }}>
            细化描述（可编辑，将用于生成）：
          </Typography.Paragraph>
          <Input.TextArea
            rows={3}
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            maxLength={800}
            placeholder="AI 细化后的描述"
          />
          {refine.questions.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Typography.Paragraph type="secondary" style={{ margin: 0, marginBottom: 4, fontSize: 12 }}>
                确认问题（回答将拼入描述，可留空跳过）：
              </Typography.Paragraph>
              {refine.questions.map((q, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <Typography.Text style={{ fontSize: 12 }}>{i + 1}. {q}</Typography.Text>
                  <Input
                    size="small"
                    style={{ marginTop: 2 }}
                    value={answers[i] ?? ''}
                    onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
                    placeholder="选填"
                    maxLength={100}
                  />
                </div>
              ))}
            </div>
          )}
          <Space style={{ marginTop: 10 }} wrap>
            <Button onClick={resetFlow}>上一步</Button>
            <Button type="primary" loading={loading} onClick={handleFinalGenerate}>生成成品</Button>
          </Space>
        </>
      )}
      {error && <Alert type="error" showIcon style={{ marginTop: 10 }} message={error} />}
      {step === 'done' && resource && (
        <div style={{ marginTop: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            {painted && format !== 'gif'
              ? <img src={painted} width={190} height={190} alt="AI 生成主体" style={{ border: '1px solid #eee', borderRadius: 8, objectFit: 'contain', background: 'repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%) 0 0 / 16px 16px' }} />
              : <canvas ref={canvasRef} style={{ width: 190, height: 190, border: '1px solid #eee', borderRadius: 8, background: 'repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%) 0 0 / 16px 16px' }} />}
            <div style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 2 }}>
              {format === 'gif' ? '待机动画预览（成品为透明 GIF）' : format === 'model3d' ? '主体纹理（成品为带动画的 GLB）' : '宠物主体（背景已扣除）'}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Typography.Text strong>{resource.name}</Typography.Text>
            <div>
              <Tag color="processing" style={{ marginLeft: 0 }}>{SPECIES_LABELS[resource.species] ?? resource.species}</Tag>
              <DetectTag label="生成检测" report={resource.detect.generated} />
              <DetectTag label="抠图检测" report={resource.detect.cutout} />
              {resource.attempts > 1 && <Tag color="orange">重试 {resource.attempts} 轮</Tag>}
            </div>
            {resource.refined && <div><Typography.Text type="secondary">{resource.refined.slice(0, 60)}</Typography.Text></div>}
            <div style={{ marginTop: 8 }}>
              <Button icon={<ReloadOutlined />} size="small" onClick={() => void runGenerate(lastDescRef.current)} loading={loading}>重新生成</Button>{' '}
              <Button type="primary" size="small" onClick={handleApply} loading={applying}>填入上传表单</Button>{' '}
              <Button size="small" onClick={resetFlow}>重新开始</Button>
            </div>
          </div>
        </div>
      )}
      {step === 'done' && failedReports.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 10 }}
          message="检测智能体发现以下问题（已达重试上限，请目检确认或重新生成）"
          description={failedReports.flatMap((r) => r.issues).map((s, i) => <div key={i}>· {s}</div>)}
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
        {format === 'image'
          ? '生成透明主体 PNG，填入后按图片形态提交审核。客户端安装该宠物后会自动生成配套动作（吃饭/走路/休息/玩耍）。'
          : format === 'gif'
          ? '生成带循环待机动画的透明 GIF，填入后按图片形态提交审核；客户端安装后会自动生成配套动作。'
          : format === 'live2d'
          ? '生成轻量 Live2D 部件包（呼吸/摆动待机），填入后自动选择 Live2D 形态，仍需提交审核。'
          : '生成带 idle 动画的 3D 模型（GLB），填入后自动选择 3D 模型形态，仍需提交审核。'}
      </Typography.Paragraph>
    </Card>
  );
}
