/**
 * 云同步：登录后拉取四类数据恢复本地缺失部分（与桌面端同策略），
 * 本地变更 60s 防抖上传；退出 App 前由 root 监听触发 flush。
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

  // 1. 配置（LLM 档案 + 当前宠物引用）
  try {
    const remote = await syncGet('config');
    const data = (remote.data ?? {}) as Partial<{
      llmProfiles: LlmProfile[];
      llmActiveProfileId: string;
      petSelfDescription: string;
      installedAgentConfig: unknown;
      currentPet: CurrentPetRef | null;
    }>;
    if (Array.isArray(data.llmProfiles) && data.llmProfiles.length && store.llmProfiles.length === 0) {
      store.patch({
        llmProfiles: data.llmProfiles,
        llmActiveProfileId: data.llmActiveProfileId ?? '',
        petSelfDescription: data.petSelfDescription ?? '',
        installedAgent: (data.installedAgentConfig as never) ?? null,
      });
      console.log(`[sync] 已从云端恢复 LLM 配置（${data.llmProfiles.length} 个档案）`);
    }
    // 当前宠物：本地无宠物时按云端 ID 拉平台详情恢复（资源文件由 PetView 懒下载）
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
          // 并入已下载列表：否则宠物页显示「我的宠物（0）」但有当前形象
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

  // 3. 聊天记录：本地空时恢复（消毒：剥离流式残留，避免卡死气泡）
  try {
    const remote = await syncGet('chat-history');
    if (Array.isArray(remote.data) && remote.data.length && store.messages.length === 0) {
      const clean = sanitizeMessages(remote.data);
      if (clean.length) {
        store.patch({ messages: clean });
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
        installedAgentConfig: store.installedAgent,
        currentPet,
      });
    } else if (kind === 'pet_state') {
      await syncPut('pet-state', store.petState);
    } else {
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
