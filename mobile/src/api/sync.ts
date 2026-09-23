/**
 * 云同步：登录后拉取四类数据恢复本地缺失部分（与桌面端同策略），
 * 本地变更 60s 防抖上传；退出 App 前由 root 监听触发 flush。
 *
 * 核心模型：LlmProfile = 智能体，每个档案自带 systemPrompt（人设）+ petAssetId（绑定形象）。
 * 对话按 llmActiveProfileId 隔离（profileMessages）。
 */
import { getAssetDetail, syncGet, syncPut } from './platform';
import { useAppStore, sanitizeMessages, type PetAssetRef } from '../store/appStore';
import { normalizeFormat, type LlmProfile, type PetState } from '../types';

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

/** 登录后拉取：本地缺失时采用云端版本 */
export async function pullAfterLogin(): Promise<void> {
  if (!isLoggedIn()) return;
  const store = useAppStore.getState();

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
      console.log(`[sync] 已从云端恢复 LLM 配置（${llmProfiles.length} 个智能体）`);
    }
    // profileMessages：优先新版，旧版 agentMessages 合入
    const pm = data.profileMessages ?? data.agentMessages;
    if (pm && typeof pm === 'object' && Object.keys(pm).length) {
      const cleaned: Record<string, ReturnType<typeof sanitizeMessages>> = {};
      for (const [k, v] of Object.entries(pm as Record<string, unknown>)) {
        cleaned[k] = sanitizeMessages(v);
      }
      if (Object.keys(cleaned).length && Object.keys(store.profileMessages).length === 0) {
        const aid = store.llmActiveProfileId;
        store.patch({
          profileMessages: cleaned,
          messages: (aid && cleaned[aid]) || [],
        });
        console.log(`[sync] 已从云端恢复 ${Object.keys(cleaned).length} 个智能体的聊天记录`);
      }
    }
    // 当前宠物：本地无宠物时按云端 ID 拉平台详情恢复
    if (data.currentPet?.id && !store.petAsset) {
      try {
        const detail = await getAssetDetail('pet', data.currentPet.id);
        const petAsset: PetAssetRef = {
          id: detail.id,
          name: detail.name,
          format: normalizeFormat(detail.format),
          fileUrl: detail.fileUrl,
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
  } catch (e) {
    console.log('[sync] 拉取配置失败:', e instanceof Error ? e.message : e);
  }

  // 2. 宠物状态：本地未就绪时恢复
  try {
    const remote = await syncGet('pet-state');
    if (remote.data) {
      const state = remote.data as PetState;
      if (!store.petStateReady) {
        store.patch({ petState: state, petStateReady: true });
        console.log('[sync] 已从云端恢复宠物状态');
      }
    }
  } catch (e) {
    console.log('[sync] 拉取宠物状态失败:', e instanceof Error ? e.message : e);
  }

  // 3. 聊天记录：旧版单列表兼容（新版已在 config.profileMessages 恢复）
  try {
    const remote = await syncGet('chat-history');
    if (Array.isArray(remote.data) && remote.data.length && store.messages.length === 0) {
      const clean = sanitizeMessages(remote.data);
      if (clean.length) {
        const cur = useAppStore.getState();
        cur.patch({
          messages: clean,
          profileMessages: { ...cur.profileMessages, ...(cur.llmActiveProfileId ? { [cur.llmActiveProfileId]: clean } : {}) },
        });
        console.log(`[sync] 已从云端恢复聊天记录（${clean.length} 条）`);
      }
    }
  } catch (e) {
    console.log('[sync] 拉取聊天记录失败:', e instanceof Error ? e.message : e);
  }
}

/** 上传单类数据（本地为准，覆盖云端） */
async function uploadNow(kind: 'config' | 'pet_state' | 'chat_history'): Promise<void> {
  if (!isLoggedIn()) return;
  const store = useAppStore.getState();
  try {
    if (kind === 'config') {
      const currentPet: CurrentPetRef | null = store.petAsset
        ? { id: store.petAsset.id, name: store.petAsset.name, format: store.petAsset.format }
        : null;
      await syncPut('config', {
        llmProfiles: store.llmProfiles,
        llmActiveProfileId: store.llmActiveProfileId,
        petSelfDescription: store.petSelfDescription,
        profileMessages: store.profileMessages,
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
