/**
 * 云同步：登录后拉取四类数据恢复本地缺失部分（与桌面端同策略），
 * 本地变更 60s 防抖上传；退出 App 前由 root 监听触发 flush。
 *
 * 核心模型：LlmProfile = 智能体，每个档案自带 systemPrompt（人设）+ petAssetId（绑定形象）。
 * 对话按 llmActiveProfileId 隔离（profileMessages）。
 *
 * 数据安全：
 * - 拉取（pullAfterLogin）只在本地为空时采用云端版本（新设备登录自动恢复）；
 * - 上传（uploadNow）在本地智能体列表为空时**不覆盖云端**（防「误删全部智能体」被同步成不可逆丢失）。
 */
import { getAssetDetail, syncGet, syncPut } from './platform';
import { useAppStore, sanitizeMessages, type PetAssetRef } from '../store/appStore';
import { unzipPetPack } from '../pet/petFiles';
import { petEntryOf, petFormatOfPack, type LlmProfile, type PetState } from '../types';

/** 跨设备共享的当前宠物引用（与桌面端 cloudSync.ts currentPet 同构） */
interface CurrentPetRef {
  id: string;
  name?: string;
  format?: string;
}

const UPLOAD_DELAY = 60_000;
const timers: Partial<Record<'config' | 'pet_state' | 'chat_history', ReturnType<typeof setTimeout>>> = {};

function isLoggedIn(): boolean {
  return !!useAppStore.getState().token;
}

export interface PullSummary {
  /** 从云端恢复的智能体数量 */
  agents: number;
  /** 恢复的聊天记录条数（按智能体累计） */
  messages: number;
  /** 自动下载的宠物形象数量 */
  pets: number;
}

/**
 * 新设备登录后自动恢复形象：把该账号智能体绑定过的宠物形象拉进已下载列表并下载本地文件
 * （离线可用），当前激活智能体绑定的形象同时设为当前宠物（严格绑定）。
 * 已有条目但缺本地文件（如仅由 currentPet 恢复的引用）也会补下。
 * 只在「本地原本没有智能体」（新设备/重装）时执行，避免用户主动删除形象后每次登录又被下回来。
 */
async function restoreBoundPets(): Promise<void> {
  const st = useAppStore.getState();
  const ids: string[] = [];
  const push = (id?: string): void => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(st.llmProfiles.find((p) => p.id === st.llmActiveProfileId)?.petAssetId);
  for (const p of st.llmProfiles) push(p.petAssetId);
  for (const id of ids) {
    const known = useAppStore.getState().downloadedPets.find((p) => p.id === id);
    if (known?.localPath) continue;
    let ref = known;
    if (!ref) {
      try {
        const detail = await getAssetDetail('pet', id);
        const entry = petEntryOf(detail);
        ref = {
          id: detail.id,
          name: detail.name,
          format: petFormatOfPack(detail),
          packUrl: detail.packUrl ?? '',
          entryPath: entry?.path,
        };
      } catch (e) {
        console.log('[sync] 恢复宠物形象失败:', id, e instanceof Error ? e.message : e);
        continue;
      }
    }
    // 宠物包解压失败不阻断登录（之后进商店/编辑时会补上）
    const packUrl = ref.packUrl;
    const localPath = packUrl
      ? await unzipPetPack(ref.id, packUrl)
          .then((dir) => (ref!.entryPath ? `${dir}/${ref!.entryPath}` : undefined))
          .catch(() => undefined)
      : undefined;
    const cur = useAppStore.getState();
    cur.patch({
      downloadedPets: known
        ? cur.downloadedPets.map((p) => (p.id === ref!.id && localPath ? { ...p, localPath } : p))
        : [...cur.downloadedPets.filter((p) => p.id !== ref!.id), localPath ? { ...ref, localPath } : ref],
    });
    console.log(`[sync] 已恢复宠物形象（${ref.name}${localPath ? '，已下载到本地' : '，仅远端'}）`);
  }
  // 当前宠物：严格绑定到激活智能体的形象（本地没有或指向的已不在列表时归位）
  const cur = useAppStore.getState();
  const bound = cur.llmProfiles.find((p) => p.id === cur.llmActiveProfileId)?.petAssetId;
  const boundRef = bound ? cur.downloadedPets.find((p) => p.id === bound) : undefined;
  if (boundRef && cur.petAsset?.id !== boundRef.id) {
    cur.patch({ petAsset: boundRef });
    console.log(`[sync] 当前宠物已按激活智能体的绑定归位（${boundRef.name}）`);
  }
}

/** 登录后拉取：本地缺失时采用云端版本（新设备登录即自动恢复智能体/聊天记录/形象） */
export async function pullAfterLogin(): Promise<PullSummary> {
  const summary: PullSummary = { agents: 0, messages: 0, pets: 0 };
  if (!isLoggedIn()) return summary;
  const store = useAppStore.getState();
  // 本地是否为空（新设备 / 重装）：为空才采用云端数据与自动下载形象
  const freshDevice = store.llmProfiles.length === 0;
  /** 拉取前本地已有的形象（用于统计这次新恢复了几个） */
  const petsBefore = new Set(store.downloadedPets.map((p) => p.id));

  // 1. 配置（LLM 档案 = 智能体列表 + 当前档案 + 对话记录 + 当前宠物）
  try {
    const remote = await syncGet('config');
    const data = (remote.data ?? {}) as Partial<{
      llmProfiles: LlmProfile[];
      llmActiveProfileId: string;
      petSelfDescription: string;
      profileMessages: Record<string, unknown>;
      // 旧版兼容字段（installedAgents/agentMessages → 合入 llmProfiles/profileMessages）
      installedAgentsConfig: unknown[];
      activeAgentId: string;
      agentMessages: Record<string, unknown>;
      installedAgentConfig: unknown;
      currentPet: CurrentPetRef | null;
    }>;
    // llmProfiles：优先新版，旧版 installedAgentsConfig 的 systemPrompt 合入
    if (Array.isArray(data.llmProfiles) && data.llmProfiles.length && store.llmProfiles.length === 0) {
      // 旧版兼容：尝试把 installedAgentsConfig 的人设合入
      let llmProfiles = data.llmProfiles;
      const oldAgents = Array.isArray(data.installedAgentsConfig) ? (data.installedAgentsConfig as Array<{ id?: string; name?: string; systemPrompt?: string; petAssetId?: string }>) : undefined;
      if (oldAgents?.length) {
        llmProfiles = llmProfiles.map((p) => {
          const matched = oldAgents.find((a) => a.id === p.id || (a.name && p.name && a.name.includes(p.name)));
          if (matched) {
            return {
              ...p,
              systemPrompt: p.systemPrompt?.trim() || matched.systemPrompt?.trim(),
              petAssetId: p.petAssetId || matched.petAssetId,
            };
          }
          return p;
        });
      }
      let llmActiveProfileId = data.llmActiveProfileId ?? '';
      if (!llmActiveProfileId && data.activeAgentId) {
        const direct = llmProfiles.find((p) => p.id === data.activeAgentId);
        llmActiveProfileId = direct?.id ?? llmProfiles[0]?.id ?? '';
      }
      // 外部边界清洗：桌面端导入/导出会剥掉 Key、云端旧档可能缺字段——
      // 缺失字段一律归零为空串，避免 UI 对 undefined 做 .trim()/模板拼接时崩溃
      llmProfiles = llmProfiles.map((p) => ({
        ...p,
        apiKey: p.apiKey ?? '',
        baseUrl: p.baseUrl ?? '',
        model: p.model ?? '',
        systemPrompt: p.systemPrompt ?? '',
      }));
      store.patch({
        llmProfiles,
        llmActiveProfileId,
        petSelfDescription: data.petSelfDescription ?? '',
      });
      summary.agents = llmProfiles.length;
      console.log(`[sync] 已从云端恢复 LLM 配置（${llmProfiles.length} 个智能体）`);
    }
    // 音色：本地无已安装音色时整体恢复；云 TTS 凭证本地为空时恢复（apiKey 服务端已解密）
    const cur0 = useAppStore.getState();
    const voicePatch: Record<string, unknown> = {};
    if (cur0.downloadedVoices.length === 0 && Array.isArray((data as { downloadedVoices?: unknown[] }).downloadedVoices)) {
      voicePatch.downloadedVoices = (data as { downloadedVoices: unknown[] }).downloadedVoices;
      voicePatch.activeCloudVoiceId = (data as { activeCloudVoiceId?: string }).activeCloudVoiceId ?? '';
    }
    const cloud = (data as { ttsCloudConfig?: { baseUrl?: string; apiKey?: string; model?: string } }).ttsCloudConfig;
    if (!cur0.ttsCloudConfig.apiKey && cloud?.apiKey) {
      voicePatch.ttsCloudConfig = {
        baseUrl: cloud.baseUrl ?? '',
        apiKey: cloud.apiKey,
        model: cloud.model ?? '',
      };
    }
    if (Object.keys(voicePatch).length) {
      store.patch(voicePatch);
      console.log('[sync] 已从云端恢复音色配置');
    }
    // profileMessages：优先新版，旧版 agentMessages 合入
    const pm = data.profileMessages ?? data.agentMessages;
    if (pm && typeof pm === 'object' && Object.keys(pm).length) {
      const cleaned: Record<string, ReturnType<typeof sanitizeMessages>> = {};
      for (const [k, v] of Object.entries(pm as Record<string, unknown>)) {
        cleaned[k] = sanitizeMessages(v);
      }
      if (Object.keys(cleaned).length && Object.keys(store.profileMessages).length === 0) {
        // 用实时状态取当前档案（store 是函数入口的快照，此时档案可能刚从云端写入）
        const aid = useAppStore.getState().llmActiveProfileId;
        store.patch({
          profileMessages: cleaned,
          messages: (aid && cleaned[aid]) || [],
        });
        summary.messages = Object.values(cleaned).reduce((n, m) => n + m.length, 0);
        console.log(`[sync] 已从云端恢复 ${Object.keys(cleaned).length} 个智能体的聊天记录`);
      }
    }
    // 当前宠物：本地无宠物时按云端 ID 拉平台详情恢复
    if (data.currentPet?.id && !store.petAsset) {
      try {
        const detail = await getAssetDetail('pet', data.currentPet.id);
        const entry = petEntryOf(detail);
        const petAsset: PetAssetRef = {
          id: detail.id,
          name: detail.name,
          format: petFormatOfPack(detail),
          packUrl: detail.packUrl ?? '',
          entryPath: entry?.path,
        };
        const cur = useAppStore.getState();
        cur.patch({
          petAsset,
          downloadedPets: cur.downloadedPets.some((p) => p.id === petAsset.id)
            ? cur.downloadedPets
            : [...cur.downloadedPets, petAsset],
        });
        console.log(`[sync] 已从云端恢复当前宠物（${petAsset.name}）`);
      } catch (e) {
        console.log('[sync] 恢复云端宠物失败:', e instanceof Error ? e.message : e);
      }
    }
    // 形象文件：新设备登录时把各智能体绑定过的形象一并下载到本地（离线可用）
    if (freshDevice) {
      await restoreBoundPets();
      summary.pets = useAppStore.getState().downloadedPets.filter((p) => !petsBefore.has(p.id)).length;
    }
  } catch (e) {
    console.log('[sync] 拉取配置失败:', e instanceof Error ? e.message : e);
  }

  // 2. 宠物状态：本地未就绪时恢复
  try {
    const remote = await syncGet('pet-state');
    if (remote.data) {
      const state = remote.data as PetState;
      if (!store.petStateReady) {
        // 云端存档可能来自旧版本（关闭状态时三项已衰减到 0）：恢复后以本地开关为准，
        // 状态功能关闭时三项强制归位 80（好感度保留云端值）
        const next = store.petStateEnabled
          ? state
          : { ...state, hunger: 80, mood: 80, energy: 80 };
        store.patch({ petState: next, petStateReady: true });
        console.log('[sync] 已从云端恢复宠物状态');
      }
    }
  } catch (e) {
    console.log('[sync] 拉取宠物状态失败:', e instanceof Error ? e.message : e);
  }

  // 3. 聊天记录：旧版单列表兼容（新版已在 config.profileMessages 恢复）
  try {
    const remote = await syncGet('chat-history');
    // 用实时状态判断（config 恢复可能刚写入 messages，不能再用入口快照，否则会被旧版空数据/陈旧数据覆盖）
    const localMessages = useAppStore.getState().messages.length;
    if (Array.isArray(remote.data) && remote.data.length && localMessages === 0) {
      const clean = sanitizeMessages(remote.data);
      if (clean.length) {
        const cur = useAppStore.getState();
        cur.patch({
          messages: clean,
          profileMessages: { ...cur.profileMessages, ...(cur.llmActiveProfileId ? { [cur.llmActiveProfileId]: clean } : {}) },
        });
        summary.messages = Math.max(summary.messages, clean.length);
        console.log(`[sync] 已从云端恢复聊天记录（${clean.length} 条）`);
      }
    }
  } catch (e) {
    console.log('[sync] 拉取聊天记录失败:', e instanceof Error ? e.message : e);
  }

  return summary;
}

/** 上传单类数据（本地为准，覆盖云端；智能体列表为空时跳过 config，避免误删被同步成不可逆丢失） */
async function uploadNow(kind: 'config' | 'pet_state' | 'chat_history'): Promise<void> {
  if (!isLoggedIn()) return;
  const store = useAppStore.getState();
  try {
    if (kind === 'config') {
      // 防护：本地一个智能体都没有时不覆盖云端（云端可能正是用户误删前的数据）
      if (store.llmProfiles.length === 0) {
        console.log('[sync] 本地智能体列表为空，跳过 config 上传（不覆盖云端），下次登录可恢复');
        return;
      }
      const currentPet: CurrentPetRef | null = store.petAsset
        ? { id: store.petAsset.id, name: store.petAsset.name, format: store.petAsset.format }
        : null;
      await syncPut('config', {
        llmProfiles: store.llmProfiles,
        llmActiveProfileId: store.llmActiveProfileId,
        petSelfDescription: store.petSelfDescription,
        profileMessages: store.profileMessages,
        // 音色：已安装音色 / 当前云音色选择 / 云 TTS 凭证（服务端对 apiKey 加密落库）
        downloadedVoices: store.downloadedVoices,
        activeCloudVoiceId: store.activeCloudVoiceId,
        ttsCloudConfig: store.ttsCloudConfig,
        // 向后兼容旧版（单智能体 installedAgentConfig）
        installedAgentConfig: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)
          ? { id: store.llmActiveProfileId, name: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)?.name, systemPrompt: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)?.systemPrompt }
          : null,
        currentPet,
      });
    } else if (kind === 'pet_state') {
      await syncPut('pet-state', store.petState);
    } else {
      // chat-history: 上传当前智能体的消息
      await syncPut('chat-history', store.messages);
    }
  } catch (e) {
    console.log(`[sync] 上传 ${kind} 失败:`, e instanceof Error ? e.message : e);
  }
}

/** 本地变更防抖上传（60s 合并多次变更） */
export function scheduleUpload(kind: 'config' | 'pet_state' | 'chat_history'): void {
  if (!isLoggedIn() || timers[kind]) return;
  timers[kind] = setTimeout(() => {
    timers[kind] = undefined;
    void uploadNow(kind);
  }, UPLOAD_DELAY);
}

/** 退出前 flush 全部待上传数据 */
export function flushAllOnQuit(): void {
  (['config', 'pet_state', 'chat_history'] as const).forEach((kind) => {
    if (timers[kind]) {
      clearTimeout(timers[kind]);
      timers[kind] = undefined;
      void uploadNow(kind);
    }
  });
}
