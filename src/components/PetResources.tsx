import { useEffect, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { C, inputStyle, labelStyle, smallBtn } from './studioTheme';
import type { BuiltinPetSummary, PetAction, PetLibrarySummary } from '../global.d';

/**
 * 宠工坊「宠物资源」页的左栏：本机宠物形象 + 动作管理（原「动作」页的全部功能） + 互动绑定。
 * - 动作数据沿用 petActions / petActionBindings（无新增字段，数据结构完全兼容）
 * - 上传帧图 / 删除走 actions IPC，播放转交宠物窗渲染（动作只能在宠物窗画布上播）
 */
const INTERACTIONS: Array<{ key: 'feed' | 'rest' | 'play'; label: string }> = [
  { key: 'feed', label: '喂食' },
  { key: 'rest', label: '休息' },
  { key: 'play', label: '玩耍' },
];

const PetResources = ({ onNotify }: { onNotify: (text: string) => void }) => {
  const { config, loadConfig, saveConfig } = useChatStore();
  const actions: PetAction[] = config?.petActions ?? [];
  const bindings = config?.petActionBindings ?? {};
  const [uploadName, setUploadName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [builtinPets, setBuiltinPets] = useState<BuiltinPetSummary[]>([]);
  const [builtinBusy, setBuiltinBusy] = useState(false);
  // 上游资源库：列表只存元数据（可能上千张），预览图按需 library.read 取，避免一次 IPC 搬几百 MB
  const [libraryAssets, setLibraryAssets] = useState<PetLibrarySummary[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryLimit, setLibraryLimit] = useState(30);
  const [previews, setPreviews] = useState<Record<string, string>>({});

  // 动作增删后主进程广播 pet:actions-changed（宠物窗与其他窗口同步）：重新拉配置刷新列表
  useEffect(() => {
    const cleanup = window.electronAPI?.onPetActionsChanged(() => void loadConfig());
    return () => cleanup?.();
  }, [loadConfig]);

  /** 内置演示宠物列表（随包分发，目录缺失时返回空列表） */
  const reloadBuiltin = async () => {
    const result = await window.electronAPI?.builtin.list();
    setBuiltinPets(result?.pets ?? []);
  };

  useEffect(() => {
    void reloadBuiltin();
  }, []);

  /** 上游资源库列表（随包分发，缺索引时返回空数组） */
  const reloadLibrary = async () => {
    const result = await window.electronAPI?.library.list();
    setLibraryAssets(result?.assets ?? []);
  };

  useEffect(() => {
    void reloadLibrary();
  }, []);

  const previewAsset = async (file: string) => {
    if (previews[file]) {
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[file];
        return next;
      });
      return;
    }
    const result = await window.electronAPI?.library.read(file);
    if (result?.dataUrl) setPreviews((prev) => ({ ...prev, [file]: result.dataUrl as string }));
    else onNotify(result?.error || '预览失败');
  };

  const applyAsset = async (file: string) => {
    setLibraryBusy(true);
    try {
      const result = await window.electronAPI?.library.apply(file);
      if (result?.success) {
        onNotify('已设为宠物形象（来自上游资源库，可随时换回）');
        await loadConfig();
        await reloadBuiltin();
      } else {
        onNotify(result?.error || '设置失败');
      }
    } finally {
      setLibraryBusy(false);
    }
  };

  const addAssetAsAction = async (file: string) => {
    setLibraryBusy(true);
    try {
      const result = await window.electronAPI?.library.addAction(file);
      if (result?.success) {
        onNotify('已加为动作（单帧），可在宠物窗播放或绑定互动');
        await loadConfig();
      } else {
        onNotify(result?.error || '添加失败');
      }
    } finally {
      setLibraryBusy(false);
    }
  };

  const libraryQueryText = libraryQuery.trim().toLowerCase();
  const libraryFiltered = libraryAssets.filter(
    (asset) =>
      !libraryQueryText ||
      `${asset.repo} ${asset.originalPath} ${asset.license}`.toLowerCase().includes(libraryQueryText)
  );
  const libraryShown = libraryFiltered.slice(0, libraryLimit);

  const applyBuiltin = async (id: string) => {
    setBuiltinBusy(true);
    try {
      const result = await window.electronAPI?.builtin.apply(id);
      if (result?.success) {
        const name = builtinPets.find((item) => item.id === id)?.name ?? id;
        onNotify(`已启用内置演示宠物「${name}」：右键喂食 / 休息 / 玩耍即可看到动作`);
        await loadConfig();
        await reloadBuiltin();
      } else {
        onNotify(result?.error || '启用失败');
      }
    } finally {
      setBuiltinBusy(false);
    }
  };

  const resetBuiltin = async () => {
    setBuiltinBusy(true);
    try {
      const result = await window.electronAPI?.builtin.reset();
      if (result?.success) {
        onNotify('已还原为内置默认形象');
        await loadConfig();
        await reloadBuiltin();
      } else {
        onNotify(result?.error || '还原失败');
      }
    } finally {
      setBuiltinBusy(false);
    }
  };

  const upload = async () => {
    if (!uploadName.trim()) {
      onNotify('请先填写动作名称');
      return;
    }
    if (!files.length) {
      onNotify('请先选择图片（可多选，按选择顺序播放）');
      return;
    }
    setBusy(true);
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({ filename: file.name, data: new Uint8Array(await file.arrayBuffer()) }))
      );
      const result = await window.electronAPI?.actions.addFrames(uploadName.trim(), payload);
      if (result?.success) {
        onNotify(`动作「${uploadName.trim()}」已添加（${files.length} 帧）`);
        setUploadName('');
        setFiles([]);
        await loadConfig();
      } else {
        onNotify(result?.error || '添加失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (action: PetAction) => {
    const result = await window.electronAPI?.actions.remove(action.id);
    onNotify(result?.success ? `已删除「${action.name}」` : result?.error || '删除失败');
    if (result?.success) await loadConfig();
  };

  const bind = async (slot: 'feed' | 'rest' | 'play', actionId: string) => {
    const next = { ...bindings } as Record<string, string | undefined>;
    if (actionId) next[slot] = actionId;
    else delete next[slot];
    await saveConfig({ petActionBindings: next });
    onNotify(
      actionId
        ? `「${INTERACTIONS.find((item) => item.key === slot)?.label}」已绑定动作「${actions.find((a) => a.id === actionId)?.name ?? ''}」`
        : '已解除绑定（将回退同名动作）'
    );
  };

  const petName = config?.petAssetName || '内置默认形象';
  const petFormat = config?.petAssetFormat || (config?.petAssetPath ? 'image' : 'default');
  const activeBuiltin = builtinPets.find((item) => item.id === config?.builtinPet);
  // 来源三态：平台资源中心 / 本机内置演示（附许可） / 本机内置默认
  const petSource = config?.petAssetId
    ? `资源中心（${config.petAssetId.slice(0, 8)}…）`
    : config?.builtinPet
      ? `本机内置演示 · ${activeBuiltin?.license || '原创绘制'}`
      : '本机内置';

  return (
    <section style={{ width: 420, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>当前宠物资源</div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 1.9 }}>
          形象：{petName}
          <br />
          形态：{petFormat}
          <br />
          来源：{petSource}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button type="button" style={smallBtn()} onClick={() => void window.electronAPI?.platform.openStore()}>
            去资源中心换形象
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>内置演示宠物</div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
            原创绘制、随包分发，不需登录即可使用；启用后自动装载「吃饭 / 休息 / 玩耍」三套动作。
          </div>
          {builtinPets.length === 0 ? (
            <div style={{ fontSize: 12, color: C.sub }}>未找到内置宠物资源。</div>
          ) : (
            builtinPets.map((pet) => (
              <div
                key={pet.id}
                style={{
                  padding: 8,
                  marginBottom: 6,
                  background: C.panel,
                  border: `1px solid ${pet.active ? C.accent : C.border}`,
                  borderRadius: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C.text }}>
                      {pet.name}
                      {pet.active ? ' · 使用中' : ''}
                    </div>
                    <div style={{ fontSize: 11, color: C.sub }}>
                      {pet.actionCount} 动作 · {pet.frameCount} 帧 · {pet.author}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={builtinBusy || pet.active}
                    style={{ ...smallBtn(), opacity: builtinBusy || pet.active ? 0.55 : 1 }}
                    onClick={() => void applyBuiltin(pet.id)}
                  >
                    {pet.active ? '使用中' : '启用'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.6 }}>{pet.description}</div>
              </div>
            ))
          )}
          {config?.builtinPet ? (
            <button
              type="button"
              disabled={builtinBusy}
              style={{ ...smallBtn(true), width: '100%', marginTop: 4, padding: 6, opacity: builtinBusy ? 0.6 : 1 }}
              onClick={() => void resetBuiltin()}
            >
              还原默认形象
            </button>
          ) : null}
        </div>

        <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            上游资源库（{libraryAssets.length}）
          </div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
            从 GitHub「pet」开源项目导入的静态美术（已归一化为 PNG，并保留来源仓库 / 许可 / 原始路径）。
            任意一张都可以「设为形象」或「加为动作」，因此导入的素材不会被闲置。
          </div>
          {libraryAssets.length === 0 ? (
            <div style={{ fontSize: 12, color: C.sub }}>未找到上游资源库（缺少 resources/pet-asset-library/index.json）。</div>
          ) : (
            <>
              <input
                value={libraryQuery}
                onChange={(event) => setLibraryQuery(event.target.value)}
                placeholder="按仓库 / 原始路径 / 许可筛选"
                style={inputStyle}
              />
              {libraryShown.length === 0 ? (
                <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>没有匹配的素材。</div>
              ) : (
                libraryShown.map((asset) => (
                  <div
                    key={asset.file}
                    style={{
                      padding: 8,
                      marginBottom: 6,
                      background: C.panel,
                      border: `1px solid ${C.border}`,
                      borderRadius: 6,
                      opacity: asset.available ? 1 : 0.5,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12,
                            color: C.text,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {asset.file.split('/').pop()}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: C.sub,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {asset.repo} · {asset.license || '未声明'}
                          {asset.format === 'svg' ? ' · 矢量（仅预览）' : ''}
                        </div>
                      </div>
                      <button type="button" style={smallBtn()} onClick={() => void previewAsset(asset.file)}>
                        {previews[asset.file] ? '收起' : '预览'}
                      </button>
                      <button
                        type="button"
                        disabled={libraryBusy || !asset.available || asset.format === 'svg'}
                        title={asset.format === 'svg' ? '矢量素材需先栅格化为 PNG（scripts/pets/rasterize-svg.cjs）' : ''}
                        style={{ ...smallBtn(), opacity: libraryBusy || !asset.available || asset.format === 'svg' ? 0.55 : 1 }}
                        onClick={() => void addAssetAsAction(asset.file)}
                      >
                        加为动作
                      </button>
                      <button
                        type="button"
                        disabled={libraryBusy || !asset.available || asset.format === 'svg'}
                        title={asset.format === 'svg' ? '矢量素材需先栅格化为 PNG（scripts/pets/rasterize-svg.cjs）' : ''}
                        style={{ ...smallBtn(true), opacity: libraryBusy || !asset.available || asset.format === 'svg' ? 0.55 : 1 }}
                        onClick={() => void applyAsset(asset.file)}
                      >
                        设为形象
                      </button>
                    </div>
                    {previews[asset.file] ? (
                      <img
                        src={previews[asset.file]}
                        alt={asset.file}
                        style={{ marginTop: 6, maxWidth: '100%', maxHeight: 160, background: C.panelAlt, borderRadius: 4 }}
                      />
                    ) : null}
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.5 }}>
                      原路径：{asset.originalPath}
                      {asset.available ? '' : '（文件缺失）'}
                    </div>
                  </div>
                ))
              )}
              {libraryFiltered.length > libraryShown.length ? (
                <button
                  type="button"
                  style={{ ...smallBtn(), width: '100%', marginTop: 4, padding: 6 }}
                  onClick={() => setLibraryLimit((limit) => limit + 60)}
                >
                  显示更多（还有 {libraryFiltered.length - libraryShown.length} 张）
                </button>
              ) : null}
            </>
          )}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          动作（{actions.length}/15）
        </div>
        <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
          手动添加帧序列（多张图片按选择顺序播放，建议 ≤30 帧）；动作随宠物安装，不可跨宠物使用。
        </div>
        <input
          value={uploadName}
          onChange={(event) => setUploadName(event.target.value)}
          placeholder="动作名称，例如：吃饭"
          style={inputStyle}
        />
        <label
          style={{
            display: 'block', padding: '8px 10px', border: `1px dashed ${files.length ? C.accent : C.border}`,
            borderRadius: 6, background: C.panelAlt, color: files.length ? C.text : C.sub, fontSize: 12, cursor: 'pointer',
          }}
        >
          <input
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.gif,.webp"
            style={{ display: 'none' }}
            onChange={(event) => setFiles(Array.from(event.target.files || []))}
          />
          {files.length ? `已选 ${files.length} 张图片 · 点击更换` : '点击选择帧图（可多选）'}
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void upload()}
          style={{ ...smallBtn(true), width: '100%', marginTop: 8, padding: '6px', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? '添加中…' : '添加动作'}
        </button>

        <div style={{ marginTop: 12 }}>
          {actions.length === 0 ? (
            <div style={{ fontSize: 12, color: C.sub }}>还没有动作，先上传帧图。</div>
          ) : (
            actions.map((action) => (
              <div
                key={action.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, marginBottom: 6, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {action.name}
                  </div>
                  <div style={{ fontSize: 11, color: C.sub }}>
                    {action.kind === 'clip' ? `模型动画（${action.clipName}）` : `帧序列（${action.frameFiles?.length || 0} 帧）`}
                    {action.source === 'ai' ? ' · AI 生成' : action.source === 'platform' ? ' · 资源库' : ' · 手动上传'}
                  </div>
                </div>
                <button type="button" style={smallBtn()} onClick={() => void window.electronAPI?.actions.play(action.id)}>
                  播放
                </button>
                <button type="button" style={smallBtn(true)} onClick={() => void remove(action)}>
                  删除
                </button>
              </div>
            ))
          )}
        </div>

        <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>互动绑定</div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
            绑定后，宠物右键菜单的对应互动会优先播放选定动作；未绑定则回退同名动作。
          </div>
          {INTERACTIONS.map((item) => (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ ...labelStyle, width: 34, marginBottom: 0 }}>{item.label}</span>
              <select
                value={bindings[item.key] ?? ''}
                onChange={(event) => void bind(item.key, event.target.value)}
                style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
              >
                <option value="">不绑定（回退同名动作）</option>
                {actions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default PetResources;