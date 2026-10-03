import { useState } from 'react';
import { C, inputStyle, labelStyle, smallBtn } from '../studioTheme';
import { ChoiceRow, FileField, PublishLayout, usePublish } from './common';
import SubjectCutout from '../SubjectCutout';
import { isImageName, needsPreview } from '../../renderer/publishFiles';
import type { PublishFilePayload, PublishPayload } from '../../global.d';

/**
 * 「添加宠物资源」：宠物形象发布（原通用发布表单的宠物部分）。
 * 字段与宠物资源管理一致：名称/描述/分类/标签/形态/主文件/预览图/主体扣取/随宠物附带动作。
 * 智能体与音色的发布分别在各自主页（发布智能体 / 发布音色），不再混在同一个表单里。
 */
type PetFormatChoice = 'auto' | 'image' | 'pack' | 'live2d' | 'model3d';
type Interaction = 'none' | 'feed' | 'rest' | 'play';

interface ActionForm {
  name: string;
  interaction: Interaction;
  mode: 'zip' | 'clip';
  clipName: string;
  file: PublishFilePayload | null;
}

const PET_FORMATS: Array<{ value: PetFormatChoice; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'image', label: '单图 / GIF' },
  { value: 'pack', label: '多图包' },
  { value: 'live2d', label: 'Live2D' },
  { value: 'model3d', label: '3D 模型' },
];

const INTERACTIONS: Array<{ value: Interaction; label: string }> = [
  { value: 'none', label: '不绑定' },
  { value: 'feed', label: '喂食' },
  { value: 'rest', label: '休息' },
  { value: 'play', label: '玩耍' },
];

const PetPublishForm = ({ onNotify }: { onNotify: (text: string) => void }) => {
  const pub = usePublish();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [petFormat, setPetFormat] = useState<PetFormatChoice>('auto');
  const [file, setFile] = useState<PublishFilePayload | null>(null);
  const [preview, setPreview] = useState<PublishFilePayload | null>(null);
  const [actions, setActions] = useState<ActionForm[]>([]);

  const addAction = () =>
    setActions((prev) => [...prev, { name: '', interaction: 'none', mode: 'zip', clipName: '', file: null }]);
  const patchAction = (index: number, patch: Partial<ActionForm>) =>
    setActions((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const submit = async () => {
    const fail = (text: string) => pub.setResult({ ok: false, text });
    if (!name.trim()) return fail('请填写资源名称');
    if (!file) return fail('请先选择宠物资源文件');
    if (needsPreview(file.name) && !preview) return fail('多图包 / Live2D / 3D 模型请上传一张预览图，便于商店展示');
    for (const [index, action] of actions.entries()) {
      if (!action.name.trim()) return fail(`第 ${index + 1} 个动作未填写名称`);
      if (action.mode === 'zip' && !action.file) return fail(`动作「${action.name}」缺少帧图 zip 压缩包`);
      if (action.mode === 'clip' && !action.clipName.trim()) return fail(`动作「${action.name}」请填写模型动画 clip 名称`);
    }
    // 后端按下标取 actionFiles（metas[i] ↔ actionFiles[i]）：帧图动作必须排在 clip 动作之前
    const zipActions = actions.filter((action) => action.mode === 'zip');
    const clipActions = actions.filter((action) => action.mode === 'clip');
    const fields: Record<string, string> = {
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      tags: JSON.stringify(tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean)),
    };
    if (petFormat !== 'auto') fields.format = petFormat;
    const payload: PublishPayload = {
      type: 'pet',
      fields,
      file,
      preview: preview ?? undefined,
      actionFiles: zipActions.map((action) => action.file).filter((item): item is PublishFilePayload => !!item),
      actionsMeta: [
        ...zipActions.map((action) => ({ name: action.name.trim(), interaction: action.interaction })),
        ...clipActions.map((action) => ({
          name: action.name.trim(),
          interaction: action.interaction,
          clipName: action.clipName.trim(),
        })),
      ],
    };
    if (await pub.submit(payload, name.trim())) {
      onNotify('宠物资源已提交，等待管理员审核');
      setActions([]);
    }
  };

  return (
    <PublishLayout
      pub={pub}
      title="添加宠物资源"
      description="把一个宠物形象（单图 / GIF / 多图包 / Live2D / 3D 模型）提交到资源中心，可随形象附带动作；审核通过后所有客户端都能搜索、下载并安装。"
      submitLabel="提交审核"
      submitHint="审核通过后资源会出现在资源中心的宠物列表，其他客户端可搜索、下载并一键安装。"
      onSubmit={() => void submit()}
    >
      <label style={labelStyle}>名称（必填）</label>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如：赛博猫咪表情包" style={inputStyle} />

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

      <ChoiceRow label="宠物形态" value={petFormat} options={PET_FORMATS} onChange={setPetFormat} />
      <div style={{ fontSize: 11, color: C.sub, marginTop: -6, marginBottom: 10, lineHeight: 1.6 }}>
        「自动识别」按后缀判断：zip=多图包、glb/gltf=3D、其余=单图（含 GIF）；Live2D 与多图包同为 zip，需手动指定。
      </div>

      <FileField
        label="宠物资源文件（必填）"
        accept=".png,.jpg,.jpeg,.gif,.webp,.zip,.glb,.gltf"
        value={file}
        onChange={setFile}
        hint="单图（png/jpg/gif/webp）、多图包 zip、Live2D 模型 zip（含 model2/model3.json）、3D 模型 glb；单文件上限 50MB"
      />
      <FileField
        label="预览图"
        accept=".png,.jpg,.jpeg,.webp"
        value={preview}
        onChange={setPreview}
        hint={file && needsPreview(file.name) ? '当前主文件是多图包 / 模型，必须提供预览图' : '商店列表与详情展示用；单图可留空，默认用原图'}
      />

      {file && isImageName(file.name) && <SubjectCutout file={file} onChange={setFile} onNotify={onNotify} />}

      <div style={{ marginBottom: 10, padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>附带动作（可选，随宠物上传）</span>
          <span style={{ fontSize: 11, color: C.sub }}>最多 15 个，随宠物安装、不可跨宠物使用</span>
          <div style={{ flex: 1 }} />
          <button type="button" style={smallBtn()} onClick={addAction} disabled={actions.length >= 15}>
            添加动作
          </button>
        </div>
        {actions.length === 0 ? (
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.7 }}>
            帧图动作上传 zip（1~30 张，按文件名顺序播放）；模型宠物可直接填写模型内动画 clip 名称。
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
                {(['zip', 'clip'] as const).map((mode) => (
                  <button key={mode} type="button" style={smallBtn(action.mode === mode)} onClick={() => patchAction(index, { mode })}>
                    {mode === 'zip' ? '帧图 zip' : '模型 clip'}
                  </button>
                ))}
              </div>
              {action.mode === 'zip' ? (
                <FileField
                  label="帧图 zip"
                  accept=".zip"
                  value={action.file}
                  onChange={(next) => patchAction(index, { file: next })}
                  hint="例如 frame-01.png、frame-02.png …（按文件名顺序播放，单文件上限 50MB）"
                />
              ) : (
                <>
                  <label style={labelStyle}>模型内动画 clip 名称</label>
                  <input
                    value={action.clipName}
                    onChange={(event) => patchAction(index, { clipName: event.target.value })}
                    placeholder="例如：mtn_idle_01"
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