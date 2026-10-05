import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import type { AgentCapabilityKind, LlmProfile } from '../global.d';
import AgentEditor from './AgentEditor';
import AgentPublishForm from './publish/AgentPublishForm';
import VoicePublishForm from './publish/VoicePublishForm';
import {
  exportAgentJson,
  mergeImportedProfiles,
  normalizeAgentText,
  type CapabilityOffer,
  type ImportOutcome,
} from '../renderer/agentPort';
import { capabilityDesc, capabilityLabel } from '../renderer/agentCapabilities';
import {
  activationBlockReason,
  createProfile,
  duplicateProfile,
  filterProfiles,
  inheritUnboundMessages,
  isProfileEnabled,
  nextActiveAfterDelete,
  profileAvatar,
  toggleBlockReason,
  withoutProfileMessages,
} from '../renderer/studioProfiles';

/**
 * 创作中心（资源中心窗口内嵌的内容页，hash 路由 #/workshop/embedded）：两个工作区 智能体 / 音色。
 * - 智能体：列表（搜索/卡片/启停/激活标记/复制/删除/切换/批量导入/导出）+ 编辑器 + 「发布智能体」
 * - 音色：本机音色库 + 「发布音色」（OpenAI 兼容 / GPT-SoVITS / 粘贴 JSON）
 * - 右上「资源中心」：打开平台 Web 窗口（浏览/安装、我的资源与审核状态、管理后台）；内嵌时该入口隐藏
 * 两处发布共用同一套发布底座（登录态 / 提交 / 结果口径），数据统一走主进程 platform:upload。
 * 所有写操作走 config:set（saveConfig）→ 持久化并触发防抖云同步。
 */

type Workspace = 'agents' | 'voices' | 'pets';

const WORKSPACES: Array<{ id: Workspace; label: string; hint: string }> = [
  { id: 'agents', label: '智能体', hint: '智能体列表、编辑器与发布' },
  { id: 'voices', label: '音色', hint: '音色库与发布音色' },
  { id: 'pets', label: '宠物', hint: '本机宠物库与桌宠窗口' },
];

/** 历史入口（动作/发布等）→ 现行工作区 */
const LEGACY_WORKSPACE: Record<string, Workspace> = {
  actions: 'agents',
  publish: 'agents',
};

const C = {
  bg: '#1e1f22',
  panel: '#252526',
  panelAlt: '#2a2a2c',
  border: '#3a3b3d',
  text: '#d6d7d9',
  sub: '#8b8f96',
  accent: '#4a9eff',
  danger: '#ff9f9f',
  warn: '#ffd479',
  dangerBg: '#3a2626',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  marginBottom: 8,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  background: C.panelAlt,
  color: C.text,
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
};

function smallBtn(danger = false): React.CSSProperties {
  return {
    padding: '3px 9px',
    border: `1px solid ${danger ? '#7a4444' : '#555'}`,
    borderRadius: 4,
    background: danger ? C.dangerBg : '#333',
    color: danger ? C.danger : '#ccc',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

/**
 * embedded=true：当前实例嵌在资源中心窗口内容区里（`#/workshop/embedded`），
 * 资源中心顶栏/导航就在上方，因此不再重复放「资源中心」入口按钮。
 */
const Studio = ({ brand = '创作中心', embedded = false }: { brand?: string; embedded?: boolean }) => {
  const { config, loadConfig, saveConfig } = useChatStore();
  const [workspace, setWorkspace] = useState<Workspace>('agents');
  /** 智能体工作区右栏：编辑器 / 发布表单（发布入口就在本页，无需另开界面） */
  const [agentPane, setAgentPane] = useState<'editor' | 'publish'>('editor');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 批量导入 / 导出 / 能力确认
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);
  const [capOffers, setCapOffers] = useState<CapabilityOffer[] | null>(null);
  const [capChecked, setCapChecked] = useState<Record<string, AgentCapabilityKind[]>>({});

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 配置广播：其他窗口改动配置后同步刷新，避免旧副本把新改动覆盖掉
  useEffect(() => {
    const cleanup = window.electronAPI?.onConfigChanged((next) => useChatStore.setState({ config: next }));
    return () => cleanup?.();
  }, []);

  // 入口指定落地工作区（资源中心导航「创作中心」/个人中心「上传新资源」）：
  // 历史 tab（actions / publish）统一落到「智能体」页
  useEffect(() => {
    const cleanup = window.electronAPI?.onStudioWorkspace((tab) => {
      const target = LEGACY_WORKSPACE[tab] ?? tab;
      if (target === 'agents' || target === 'voices' || target === 'pets') setWorkspace(target);
      if (target === 'agents') setAgentPane('editor');
    });
    return () => cleanup?.();
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  };

  const profiles = config?.llmProfiles ?? [];
  const activeId = config?.llmActiveProfileId ?? '';
  const installedVoices = config?.downloadedVoices ?? [];
  /** 本机宠物库（宠物工作区展示；安装/解包由主进程宠物模块负责） */
  const installedPets = config?.pet?.downloadedPets ?? [];
  const visible = useMemo(() => filterProfiles(profiles, query), [profiles, query]);
  const selected = profiles.find((p) => p.id === selectedId);

  /** 选中档案（编辑器内容由 AgentEditor 以 key={profile.id} 自行重建） */
  const selectProfile = (profile: LlmProfile) => {
    setSelectedId(profile.id);
    setConfirmId('');
  };

  /** 新增：首个档案时继承「未绑定」历史（T2 交接项），并成为当前激活档案 */
  const addProfile = async () => {
    const profile = createProfile(profiles);
    const isFirst = profiles.length === 0;
    const inherited = isFirst
      ? inheritUnboundMessages(config?.profileMessages, profile.id)
      : { messages: undefined, inherited: 0 };
    await saveConfig({
      llmProfiles: [...profiles, profile],
      ...(isFirst ? { llmActiveProfileId: profile.id } : {}),
      ...(inherited.messages ? { profileMessages: inherited.messages } : {}),
    });
    selectProfile(profile);
    showNotice(
      inherited.inherited
        ? `已创建「${profile.name}」并继承原有 ${inherited.inherited} 条对话记录：填写 Key 与模型后点保存`
        : `已创建「${profile.name}」：填写 Key 与模型后点保存生效`,
    );
  };

  const duplicate = async (profile: LlmProfile) => {
    const copy = duplicateProfile(profile, profiles);
    await saveConfig({ llmProfiles: [...profiles, copy] });
    selectProfile(copy);
    showNotice(`已复制为「${copy.name}」（含 Key、人设与绑定设置）`);
  };

  const remove = async (profile: LlmProfile) => {
    const remaining = profiles.filter((item) => item.id !== profile.id);
    await saveConfig({
      llmProfiles: remaining,
      llmActiveProfileId: nextActiveAfterDelete(remaining, profile.id, activeId),
      profileMessages: withoutProfileMessages(config?.profileMessages, profile.id),
    });
    if (selectedId === profile.id) setSelectedId('');
    setConfirmId('');
    showNotice(`已删除「${profile.name}」，其对话记录一并删除`);
  };

  const toggleEnabled = async (profile: LlmProfile) => {
    const reason = toggleBlockReason(profile, activeId);
    if (reason) {
      showNotice(reason);
      return;
    }
    const enabled = !isProfileEnabled(profile);
    await saveConfig({
      llmProfiles: profiles.map((item) => (item.id === profile.id ? { ...item, enabled } : item)),
    });
    showNotice(enabled ? `已启用「${profile.name}」` : `已停用「${profile.name}」`);
  };

  /** 切换激活：停用/已是当前项会被拦截并给出指引 */
  const activate = async (profile: LlmProfile) => {
    setBusy(true);
    try {
      const reason = activationBlockReason(profile, activeId);
      if (reason) {
        showNotice(reason);
        return;
      }
      await saveConfig({ llmActiveProfileId: profile.id });
      showNotice(`已切换到「${profile.name}」：对话与历史随之切换`);
    } finally {
      setBusy(false);
    }
  };

  /** 全字段编辑器保存：把补丁合并进该档案后落盘（走 config:set → 持久化 + 防抖云同步） */
  const saveEditorPatch = async (profileId: string, patch: Partial<LlmProfile>) => {
    await saveConfig({
      llmProfiles: profiles.map((item) => (item.id === profileId ? { ...item, ...patch } : item)),
    });
  };

  /** 批量导入解析：按名称合并（同名更新、新名新增），检测到自带能力时弹确认 */
  const parseBatchImport = () => {
    const result = normalizeAgentText(importText);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    const outcome = mergeImportedProfiles(profiles, result.items);
    setImportError('');
    setImportOutcome(outcome);
    showNotice(
      `识别 ${result.items.length} 条配置：新增 ${outcome.added} 个、更新 ${outcome.updated} 个` +
        `${result.skipped ? `，跳过 ${result.skipped} 条无效条目` : ''}` +
        `${outcome.missingKeys ? `；其中 ${outcome.missingKeys} 个缺少 API Key，导入后请在编辑器补全` : ''}`,
    );
  };

  /** 批量导入确认：写入档案；若检测到自带能力则弹「为它添加这些能力」 */
  const confirmBatchImport = async () => {
    if (!importOutcome) return;
    await saveConfig({ llmProfiles: importOutcome.list });
    const offers = importOutcome.capabilityOffers;
    setImportOpen(false);
    setImportText('');
    setImportOutcome(null);
    if (offers?.length) {
      const checked: Record<string, AgentCapabilityKind[]> = {};
      for (const offer of offers) checked[offer.profileId] = [...offer.kinds];
      setCapChecked(checked);
      setCapOffers(offers);
      return;
    }
    showNotice('导入完成');
  };

  /** 应用能力确认结果：把勾选的能力写进对应档案（规格沿用其 JSON 声明） */
  const applyCapabilityOffers = async () => {
    if (!capOffers) return;
    const byId = new Map(capOffers.map((offer) => [offer.profileId, offer]));
    await saveConfig({
      llmProfiles: profiles.map((profile) => {
        const offer = byId.get(profile.id);
        if (!offer) return profile;
        return {
          ...profile,
          capabilities: {
            enabled: capChecked[profile.id] ?? [],
            spec: { ...offer.spec, source: 'import' as const },
          },
        };
      }),
    });
    setCapOffers(null);
    showNotice('已为导入的智能体添加所选能力');
  };

  /** 导出全部智能体为 .json 文件（不含 API Key / id / 绑定，走系统保存对话框） */
  const exportAll = async () => {
    if (!profiles.length) {
      showNotice('还没有可导出的智能体：先新增或导入一个');
      return;
    }
    const content = exportAgentJson(profiles);
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await window.electronAPI?.files.saveText({
      defaultFileName: `desktop-pet-agents-${stamp}.json`,
      content,
      title: '导出智能体配置（不含 API Key）',
    });
    if (result?.saved) showNotice(`已导出到 ${result.path ?? ''}`);
    else if (result?.error) showNotice(`导出失败：${result.error}`);
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        color: C.text,
        fontFamily: "system-ui, 'Microsoft YaHei', sans-serif",
        fontSize: 13,
        userSelect: 'text',
        overflow: 'hidden',
      }}
    >
      {/* 顶栏：品牌 + 三工作区 + 上传资源入口（平台 Web 的发布/审核仍在独立窗口） */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '10px 16px',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>{brand}</div>
        <nav style={{ display: 'flex', gap: 6 }}>
          {WORKSPACES.map((item) => {
            const on = workspace === item.id;
            return (
              <button
                key={item.id}
                type="button"
                title={item.hint}
                onClick={() => setWorkspace(item.id)}
                style={{
                  padding: '5px 14px',
                  border: `1px solid ${on ? C.accent : C.border}`,
                  borderRadius: 4,
                  background: on ? 'rgba(74,158,255,.15)' : 'transparent',
                  color: on ? C.accent : C.sub,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        {notice && (
          <div style={{ fontSize: 12, color: '#ffd479', maxWidth: '52%', textAlign: 'right' }}>{notice}</div>
        )}
        {/* 资源中心：发布已收口到「上传/发布」工作区，这里只保留浏览/安装/审核/管理入口；
            内嵌在资源中心窗口时该入口多余（顶栏就在上方），不再显示 */}
        {!embedded && (
          <button
            type="button"
            onClick={() => void window.electronAPI?.platform.openStore()}
            title="打开资源中心（浏览与安装资源、我的资源与审核状态、管理后台）"
            style={{ ...smallBtn(), padding: '5px 12px', borderColor: C.accent, color: C.accent, flexShrink: 0 }}
          >
            资源中心
          </button>
        )}
      </header>

      {/* 音色：左「本机音色库」+ 右「发布音色」 */}
      {workspace === 'voices' && (
        <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <section
            style={{
              width: 380, flexShrink: 0, borderRight: `1px solid ${C.border}`,
              padding: '14px 16px', overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              本机音色库（{installedVoices.length}）
            </div>
            <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.8, marginBottom: 8 }}>
              已安装到本机的音色可在这里查看；平台音色商店的浏览 / 试听 / 安装在
              <span style={{ color: C.text }}> T9 </span>
              接入，本机自建音色、云 TTS 服务配置与全局音色选择已在「聊天设置 → 语音朗读 → 音色库管理」可用。
            </div>
            {installedVoices.length === 0 ? (
              <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.8 }}>
                还没有安装音色。可以先用右侧「发布音色」把自己的音色配置提交到资源中心。
              </div>
            ) : (
              installedVoices.map((voice) => (
                <div
                  key={voice.id}
                  style={{ padding: 8, marginBottom: 6, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6 }}
                >
                  <div style={{ fontSize: 12, color: C.text }}>{voice.name}</div>
                  <div style={{ fontSize: 11, color: C.sub }}>
                    {voice.config?.engine === 'gptsovits' ? 'GPT-SoVITS' : voice.config?.engine === 'system' ? '系统音色' : '云音色'}
                    {voice.fromStore ? ' · 来自资源中心' : ' · 本机自建'}
                  </div>
                </div>
              ))
            )}
          </section>
          <VoicePublishForm onNotify={showNotice} />
        </main>
      )}

      {/* 宠物：本机宠物库 + 打开桌宠悬浮窗（安装/解包后续接入 main/pet/petPack.ts） */}
      {workspace === 'pets' && (
        <main style={{ flex: 1, padding: 16, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>本机宠物库（{installedPets.length}）</div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.8, marginBottom: 10 }}>
            已安装到本机的宠物形象在这里查看；桌宠悬浮窗可从菜单「窗口 → 宠物」打开，或点右侧按钮。
          </div>
          <button
            type="button"
            onClick={() => void window.electronAPI?.pet.open()}
            style={{ ...smallBtn(), padding: '5px 12px', borderColor: C.accent, color: C.accent, marginBottom: 12 }}
          >
            打开桌宠窗口
          </button>
          {installedPets.length === 0 ? (
            <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.8 }}>还没有安装宠物。</div>
          ) : (
            installedPets.map((pet) => (
              <div
                key={pet.id}
                style={{ padding: 8, marginBottom: 6, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6 }}
              >
                <div style={{ fontSize: 12, color: C.text }}>{pet.name}</div>
                <div style={{ fontSize: 11, color: C.sub }}>
                  {pet.format || '未知格式'}
                  {pet.fromStore ? ' · 来自资源中心' : ' · 本机'}
                </div>
              </div>
            ))
          )}
        </main>
      )}

      {/* 智能体：左列表（新增 / 导入 / 导出 / 发布入口）+ 右编辑器或发布表单 */}
      {workspace === 'agents' && (
        <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <section
            style={{
              width: 380,
              flexShrink: 0,
              borderRight: `1px solid ${C.border}`,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 6, padding: 10, flexShrink: 0 }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称 / 模型 / 标签"
                style={{ ...inputStyle, marginBottom: 0 }}
              />
              <button type="button" onClick={() => void addProfile()} style={{ ...smallBtn(), padding: '4px 12px' }}>
                新增
              </button>
              <button
                type="button"
                title="批量导入：兼容 JSON / YAML 子集 / 人设卡，按名称合并"
                onClick={() => setImportOpen((open) => !open)}
                style={smallBtn(importOpen)}
              >
                批量导入
              </button>
              <button
                type="button"
                title="把本机智能体配置提交到资源中心（审核通过后公开）"
                onClick={() => setAgentPane(agentPane === 'publish' ? 'editor' : 'publish')}
                style={smallBtn(agentPane === 'publish')}
              >
                发布智能体
              </button>
              <button type="button" title="导出全部智能体配置（不含 API Key）" onClick={() => void exportAll()} style={smallBtn()}>
                导出
              </button>
            </div>

            {importOpen && (
              <div style={{ margin: '0 10px 10px', padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel }}>
                <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 6 }}>
                  粘贴从本应用或手机端导出的智能体配置（JSON / YAML），或人设卡（agent_name / persona）。
                  按名称合并：同名更新配置，新名称新增为独立智能体。导出文件不含 API Key，导入后请补全。
                </div>
                <textarea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  rows={5}
                  placeholder='[{"name":"医疗助手","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}]'
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
                />
                {importError && <div style={{ fontSize: 11, color: C.danger, marginBottom: 6 }}>{importError}</div>}
                {importOutcome && (
                  <div style={{ fontSize: 11, color: C.warn, marginBottom: 6 }}>
                    预览：新增 {importOutcome.added} 个 · 更新 {importOutcome.updated} 个
                    {importOutcome.missingKeys ? ` · 缺密钥 ${importOutcome.missingKeys} 个` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={parseBatchImport} style={smallBtn(true)}>
                    解析并预览
                  </button>
                  <button
                    type="button"
                    disabled={!importOutcome}
                    onClick={() => void confirmBatchImport()}
                    style={{ ...smallBtn(), ...(importOutcome ? {} : { opacity: 0.5, cursor: 'default' }) }}
                  >
                    确认导入
                  </button>
                </div>
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 12px' }}>
              {profiles.length === 0 && (
                <div style={{ padding: '18px 12px', border: `1px dashed ${C.border}`, borderRadius: 6, color: C.sub, fontSize: 12, lineHeight: 1.7 }}>
                  还没有智能体。点「新增」创建第一个：每个智能体可绑定人设与专属音色，对话记录互相隔离。
                </div>
              )}
              {profiles.length > 0 && visible.length === 0 && (
                <div style={{ padding: '12px', color: C.sub, fontSize: 12 }}>没有匹配「{query}」的智能体</div>
              )}
              {visible.map((profile) => {
                const isActive = profile.id === activeId;
                const enabled = isProfileEnabled(profile);
                const isSelected = profile.id === selectedId;
                const messages = config?.profileMessages?.[profile.id]?.length ?? 0;
                return (
                  <div
                    key={profile.id}
                    onClick={() => selectProfile(profile)}
                    style={{
                      marginBottom: 8,
                      padding: 10,
                      border: `1px solid ${isSelected ? C.accent : C.border}`,
                      borderRadius: 6,
                      background: isSelected ? 'rgba(74,158,255,.08)' : C.panel,
                      cursor: 'pointer',
                      opacity: enabled ? 1 : 0.55,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          flexShrink: 0,
                          borderRadius: 13,
                          background: C.panelAlt,
                          border: `1px solid ${C.border}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                        }}
                      >
                        {profileAvatar(profile)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {profile.name || '(未命名)'}
                          </span>
                          {isActive && (
                            <span style={{ fontSize: 10, color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 3, padding: '0 4px' }}>
                              当前
                            </span>
                          )}
                          {!enabled && <span style={{ fontSize: 10, color: C.sub }}>已停用</span>}
                        </div>
                        <div style={{ fontSize: 11, color: C.sub, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {profile.model || '未填模型'}
                          {messages ? ` · ${messages} 条对话` : ''}
                        </div>
                      </div>
                      <label
                        title={enabled ? '停用该智能体' : '启用该智能体'}
                        onClick={(event) => event.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.sub, cursor: 'pointer', flexShrink: 0 }}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => void toggleEnabled(profile)}
                        />
                        启用
                      </label>
                    </div>

                    {(profile.domainTags?.length || profile.role || profile.style) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {[...(profile.domainTags ?? []), profile.role, profile.style]
                          .filter((tag): tag is string => !!tag)
                          .map((tag) => (
                            <span
                              key={tag}
                              style={{ fontSize: 10, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 3, padding: '0 5px' }}
                            >
                              {tag}
                            </span>
                          ))}
                      </div>
                    )}

                    {confirmId === profile.id ? (
                      <div
                        onClick={(event) => event.stopPropagation()}
                        style={{ marginTop: 8, padding: 8, border: `1px solid #7a4444`, borderRadius: 4, background: C.dangerBg, fontSize: 11, color: '#ffbdbd', lineHeight: 1.6 }}
                      >
                        删除「{profile.name}」后，其 {messages} 条对话记录会一并删除且不可恢复。
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button type="button" onClick={() => void remove(profile)} style={smallBtn(true)}>
                            确认删除
                          </button>
                          <button type="button" onClick={() => setConfirmId('')} style={smallBtn()}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div onClick={(event) => event.stopPropagation()} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          type="button"
                          disabled={busy}
                          title="切换为该智能体"
                          onClick={() => void activate(profile)}
                          style={{ ...smallBtn(), ...(isActive ? { opacity: 0.5, cursor: 'default' } : {}) }}
                        >
                          切换
                        </button>
                        <button type="button" title="复制该智能体（含 Key）" onClick={() => void duplicate(profile)} style={smallBtn()}>
                          复制
                        </button>
                        <button type="button" title="删除该智能体" onClick={() => setConfirmId(profile.id)} style={smallBtn(true)}>
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {agentPane === 'publish' ? (
            <AgentPublishForm profiles={profiles} onNotify={showNotice} />
          ) : (
            <section style={{ flex: 1, padding: 16, overflowY: 'auto', minWidth: 0 }}>
              {!selected ? (
                <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.9 }}>
                  从左侧选择一个智能体进行编辑，或点「新增」创建；也可以点「发布智能体」把本机配置提交到资源中心。
                  <br />
                  每个智能体 = 一套 API + 人设 + 专属音色，对话按智能体隔离。
                </div>
              ) : (
                <AgentEditor
                  key={selected.id}
                  profile={selected}
                  voices={installedVoices}
                  onSave={(patch) => saveEditorPatch(selected.id, patch)}
                  onNotify={showNotice}
                />
              )}
            </section>
          )}
        </main>
      )}
    {/* 批量导入后：为检测到自带能力的智能体确认添加（可逐项取消） */}
      {capOffers && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 560,
              maxHeight: '100%',
              overflowY: 'auto',
              padding: 16,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              background: C.panel,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>为导入的智能体添加这些能力？</div>
            {capOffers.map((offer) => (
              <div key={offer.profileId} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{offer.name}</div>
                {offer.reasons.length > 0 && (
                  <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7 }}>检测到：{offer.reasons.join('；')}</div>
                )}
                {offer.kinds.map((kind) => {
                  const on = (capChecked[offer.profileId] ?? []).includes(kind);
                  return (
                    <label
                      key={kind}
                      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6, fontSize: 12, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setCapChecked((prev) => {
                            const cur = prev[offer.profileId] ?? [];
                            return {
                              ...prev,
                              [offer.profileId]: on ? cur.filter((k) => k !== kind) : [...cur, kind],
                            };
                          })
                        }
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        {capabilityLabel(kind)}
                        <span style={{ color: C.sub, fontSize: 11, display: 'block', lineHeight: 1.6 }}>
                          {capabilityDesc(kind)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7 }}>
              这些能力直接合成进该智能体：搭话间隔 / 时段 / 示例任务都沿用它的 JSON 声明，可随时在编辑器里调整或关闭。
            </div>
            {capOffers.some((offer) => (capChecked[offer.profileId] ?? []).includes('web')) && (
              <div style={{ fontSize: 11, color: C.warn, marginTop: 6, lineHeight: 1.7 }}>
                联网查询还需要在编辑器「智能体能力」里填一个搜索服务的 API Key（博查 / Serper / Tavily）才会生效。
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setCapOffers(null)} style={smallBtn()}>
                全部不添加
              </button>
              <button
                type="button"
                onClick={() => void applyCapabilityOffers()}
                style={{ ...smallBtn(), background: C.accent, borderColor: C.accent, color: '#fff' }}
              >
                添加选中能力
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Studio;