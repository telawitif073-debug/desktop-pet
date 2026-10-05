import { useState } from 'react';
import { C, inputStyle, labelStyle, smallBtn } from '../studioTheme';
import { FileField, PublishLayout, usePublish } from './common';
import type { PublishFilePayload, PublishPackAction, PublishPayload } from '../../global.d';
// 单只宠物自带的动作上限（发布侧与安装侧同一常量）
import { PET_ACTIONS_MAX_PER_PET } from '../../shared/actionQuota';

/**
 * 「添加宠物资源」：把一个**宠物包（zip）**提交到资源中心。
 * ---------------------------------------------------------------------------
 * 新契约（见 `.trae/documents/pet-store-successor-design.md`）：宠物 = 一个 zip 资源包，
 * 包内至少要有一个「够格本体」（本体立绘 / 模型 / 帧动画，由 `src/pet/resource.ts` 判定）；
 * 动作**随包分发**（`pet/actions.json` + `pet/actions/<动作名>/`），不再是「一张主图 + 若干独立动作包」。
 *
 * 提交流程：客户端先本地解包跑 `evaluatePetPack`（不合格就地失败，避免白传）→ 把附带动作注入包内
 * → 重新打包上传 → 服务端上传即解包复跑同一套标准。
 */
type ActionKind = 'frames' | 'clip' | 'video';
type Interaction = 'none' | 'feed' | 'rest' | 'play';

interface ActionForm {
  name: string;
  interaction: Interaction;
  kind: ActionKind;
  clipName: string;
  file: PublishFilePayload | null;
}

const INTERACTIONS: Array<{ value: Interaction; label: string }> = [
  { value: 'none', label: '不绑定' },
  { value: 'feed', label: '喂食' },
  { value: 'rest', label: '休息' },
  { value: 'play', label: '玩耍' },
];

const ACTION_KINDS: Array<{ value: ActionKind; label: string }> = [
  { value: 'frames', label: '帧图 zip' },
  { value: 'video', label: '视频 webm' },
  { value: 'clip', label: '模型 clip' },
];

const PetPublishForm = ({ onNotify }: { onNotify: (text: string) => void }) => {
  const pub = usePublish();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [version, setVersion] = useState('');
  const [file, setFile] = useState<PublishFilePayload | null>(null);
  const [preview, setPreview] = useState<PublishFilePayload | null>(null);
  const [actions, setActions] = useState<ActionForm[]>([]);

  const addAction = () =>
    setActions((prev) => [...prev, { name: '', interaction: 'none', kind: 'frames', clipName: '', file: null }]);
  const patchAction = (index: number, patch: Partial<ActionForm>) =>
    setActions((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const submit = async () => {
    const fail = (text: string) => pub.setResult({ ok: false, text });
    if (!name.trim()) return fail('请填写资源名称');
    if (!file) return fail('请先选择宠物包文件（.zip）');
    if (!/\.zip$/i.test(file.name)) return fail('宠物包必须是 .zip 压缩包');
    for (const [index, action] of actions.entries()) {
      if (!action.name.trim()) return fail(`第 ${index + 1} 个动作未填写名称`);
      if (action.kind === 'frames' && !action.file) return fail(`动作「${action.name}」缺少帧图 zip`);
      if (action.kind === 'video' && !action.file) return fail(`动作「${action.name}」缺少视频文件（webm）`);
      if (action.kind === 'clip' && !action.clipName.trim()) return fail(`动作「${action.name}」请填写模型动画 clip 名称`);
    }

    const fields: Record<string, string> = {
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      tags: JSON.stringify(tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean)),
    };
    if (version.trim()) fields.version = version.trim();

    const packActions: PublishPackAction[] = actions.map((action) => ({
      name: action.name.trim(),
      interaction: action.interaction,
      kind: action.kind,
      ...(action.kind === 'clip' ? { clipName: action.clipName.trim() } : {}),
      ...(action.file ? { file: action.file } : {}),
    }));

    const payload: PublishPayload = {
      type: 'pet',
      fields,
      file,
      preview: preview ?? undefined,
      actions: packActions.length ? packActions : undefined,
    };
    if (await pub.submit(payload, name.trim())) {
      onNotify('宠物包已提交，等待管理员审核');
      setActions([]);
    }
  };

  return (
    <PublishLayout
      pub={pub}
      title="添加宠物资源"
      description="上传一个宠物包（zip）提交到资源中心。包内至少要有一个宠物本体（本体立绘 / 模型 / 帧动画），动作可随包附带；客户端会先本地校验，服务端上传即复跑同一套标准，不合格直接拒绝。"
      submitLabel="提交审核"
      submitHint="审核通过后宠物包会出现在资源中心的宠物列表，其他客户端可搜索、下载并一键安装（含包内动作）。"
      onSubmit={() => void submit()}
    >
      <label style={labelStyle}>名称（必填）</label>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如：赛博猫咪" style={inputStyle} />

      <label style={labelStyle}>描述</label>
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        placeholder="它有什么特点？适合什么场景？"
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
      />

      <label style={labelStyle}>分类</label>
      <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={50} placeholder="图片、动画或 3D" style={inputStyle} />

      <label style={labelStyle}>标签（逗号分隔）</label>
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：猫, 可爱, 动画" style={inputStyle} />

      <label style={labelStyle}>版本（可选）</label>
      <input value={version} onChange={(event) => setVersion(event.target.value)} maxLength={20} placeholder="默认 1.0.0" style={inputStyle} />

      <FileField
        label="宠物包文件（必填）"
        accept=".zip"
        value={file}
        onChange={setFile}
        hint="一个 zip，包根即宠物包根：本体放 pet/body.png、body/xxx.glb、cover.png 等；动作放 pet/actions.json + pet/actions/<动作名>/frame_*.png（视频为 clip.webm）。单文件上限 128MB"
      />
      <FileField
        label="预览图（可选）"
        accept=".png,.jpg,.jpeg,.webp"
        value={preview}
        onChange={setPreview}
        hint="商店列表与详情展示用；留空时商店回落到包内的封面资源（cover.png / preview/…）"
      />

      <div style={{ marginBottom: 10, padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>附带动作（可选，随宠物包发布）</span>
          <span style={{ fontSize: 11, color: C.sub }}>最多 {PET_ACTIONS_MAX_PER_PET} 个，随包安装、不可跨宠物使用</span>
          <div style={{ flex: 1 }} />
          <button type="button" style={smallBtn()} onClick={addAction} disabled={actions.length >= PET_ACTIONS_MAX_PER_PET}>
            添加动作
          </button>
        </div>
        {actions.length === 0 ? (
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.7 }}>
            帧图动作上传 zip（1~30 张，按文件名顺序播放）；也可以直接上传透明 webm 视频动作，或为模型宠物填写内置动画 clip 名称。
          </div>
        ) : (
          actions.map((action, index) => (
            <div key={index} style={{ marginTop: 8, padding: 8, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panelAlt }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: C.sub }}>动作 {index + 1}</span>
                <div style={{ flex: 1 }} />
                <button type="button" style={smallBtn(true)} onClick={() => setActions((prev) => prev.filter((_, i) => i !== index))}>
                  删除
                </button>
              </div>
              <input
                value={action.name}
                onChange={(event) => patchAction(index, { name: event.target.value })}
                maxLength={30}
                placeholder="动作名称，例如：吃饭"
                style={{ ...inputStyle, marginTop: 6 }}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {INTERACTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    style={smallBtn(action.interaction === option.value)}
                    onClick={() => patchAction(index, { interaction: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
                <span style={{ width: 10 }} />
                {ACTION_KINDS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    style={smallBtn(action.kind === option.value)}
                    onClick={() => patchAction(index, { kind: option.value, file: null })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {action.kind === 'frames' && (
                <FileField
                  label="帧图 zip"
                  accept=".zip"
                  value={action.file}
                  onChange={(next) => patchAction(index, { file: next })}
                  hint="例如 frame-01.png、frame-02.png …（按文件名顺序播放，1~30 张）"
                />
              )}
              {action.kind === 'video' && (
                <FileField
                  label="视频文件（webm）"
                  accept=".webm"
                  value={action.file}
                  onChange={(next) => patchAction(index, { file: next })}
                  hint="透明 VP9 WebM（带 alpha 通道）；视频动作自带帧率，无需填帧率"
                />
              )}
              {action.kind === 'clip' && (
                <>
                  <label style={labelStyle}>模型内动画 clip 名称</label>
                  <input
                    value={action.clipName}
                    onChange={(event) => patchAction(index, { clipName: event.target.value })}
                    placeholder="例如：mtn_idle_01（留空则用动作名）"
                    style={inputStyle}
                  />
                </>
              )}
            </div>
          ))
        )}
      </div>
    </PublishLayout>
  );
};

export default PetPublishForm;
