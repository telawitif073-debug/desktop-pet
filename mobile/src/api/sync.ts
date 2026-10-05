/**
 * 云同步：登录后拉取数据恢复本地缺失部分（与桌面端同策略），
 * 本地变更 60s 防抖上传；退出 App 前由 root 监听触发 flush。
 *
 * 核心模型：LlmProfile = 智能体，每个档案自带 systemPrompt（人设）。
 * 对话按 llmActiveProfileId 隔离（profileMessages）。
 *
 * 数据安全：
 * - 拉取（pullAfterLogin）只在本地为空时采用云端版本（新设备登录自动恢复）；
 * - 上传（uploadNow）在本地智能体列表为空时**不覆盖云端**（防「误删全部智能体」被同步成不可逆丢失）。
 */
import { syncGet, syncPut } from './platform';
import { useAppStore, sanitizeMessages } from '../store/appStore';
// 宠物状态同步：REST 段与载荷契约来自共享包 pet/api（前后端同一份）
import { PET_SYNC_ROUTE, type PetStatePayload } from '../../../pet/api';
import { isDefaultVitals, normalizeVitals } from '../pet/domain';
import type { LlmProfile } from '../types';

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
}

/** 登录后拉取：本地缺失时采用云端版本（新设备登录即自动恢复智能体/聊天记录） */
export async function pullAfterLogin(): Promise<PullSummary> {
  const summary: PullSummary = { agents: 0, messages: 0 };
  if (!isLoggedIn()) return summary;
  const store = useAppStore.getState();

  // 1. 配置（LLM 档案 = 智能体列表 + 当前档案 + 对话记录）
  try {
    const remote = await syncGet('config');
    const data = (remote.data ?? {}) as Partial<{
      llmProfiles: LlmProfile[];
      llmActiveProfileId: string;
      profileMessages: Record<string, unknown>;
      // 旧版兼容字段（installedAgentsConfig/agentMessages → 合入 llmProfiles/profileMessages）
      installedAgentsConfig: unknown[];
      activeAgentId: string;
      agentMessages: Record<string, unknown>;
      installedAgentConfig: unknown;
    }>;
    // llmProfiles：优先新版，旧版 installedAgentsConfig 的 systemPrompt 合入
    if (Array.isArray(data.llmProfiles) && data.llmProfiles.length && store.llmProfiles.length === 0) {
      // 旧版兼容：尝试把 installedAgentsConfig 的人设合入
      let llmProfiles = data.llmProfiles;
      const oldAgents = Array.isArray(data.installedAgentsConfig) ? (data.installedAgentsConfig as Array<{ id?: string; name?: string; systemPrompt?: string }>) : undefined;
      if (oldAgents?.length) {
        llmProfiles = llmProfiles.map((p) => {
          const matched = oldAgents.find((a) => a.id === p.id || (a.name && p.name && a.name.includes(p.name)));
          if (matched) {
            return {
              ...p,
              systemPrompt: p.systemPrompt?.trim() || matched.systemPrompt?.trim(),
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
  } catch (e) {
    console.log('[sync] 拉取配置失败:', e instanceof Error ? e.message : e);
  }

  // 2. 聊天记录：旧版单列表兼容（新版已在 config.profileMessages 恢复）
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

  // 3. 宠物状态（本地未就绪时采用云端；随后随变更防抖上传）
  await pullPetState();

  return summary;
}

/**
 * 拉取云端宠物状态（本地仍是初值时采用云端版本）。
 * 登录后（pullAfterLogin）与冷启动水合后各调用一次；本机已有养成进度时不覆盖。
 */
export async function pullPetState(): Promise<void> {
  if (!isLoggedIn()) return;
  try {
    const remote = await syncGet(PET_SYNC_ROUTE);
    const st = useAppStore.getState();
    // 本机已玩过（非初值）则保留本地进度，不采用云端
    if (!isDefaultVitals(st.petState) || !remote.data) return;
    const payload = remote.data as Partial<PetStatePayload>;
    st.patch({ petState: normalizeVitals(payload.vitals) });
    console.log('[sync] 已从云端恢复宠物状态');
  } catch (e) {
    console.log('[sync] 拉取宠物状态失败:', e instanceof Error ? e.message : e);
  }
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
      await syncPut('config', {
        llmProfiles: store.llmProfiles,
        llmActiveProfileId: store.llmActiveProfileId,
        profileMessages: store.profileMessages,
        // 音色：已安装音色 / 当前云音色选择 / 云 TTS 凭证（服务端对 apiKey 加密落库）
        downloadedVoices: store.downloadedVoices,
        activeCloudVoiceId: store.activeCloudVoiceId,
        ttsCloudConfig: store.ttsCloudConfig,
        // 向后兼容旧版（单智能体 installedAgentConfig）
        installedAgentConfig: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)
          ? { id: store.llmActiveProfileId, name: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)?.name, systemPrompt: store.llmProfiles.find((p) => p.id === store.llmActiveProfileId)?.systemPrompt }
          : null,
      });
    } else if (kind === 'pet_state') {
      // 宠物状态：四维 + 就绪标记（契约见 pet/api PetStatePayload）
      const payload: PetStatePayload = { vitals: store.petState, ready: store.petStateReady, updatedAt: Date.now() };
      await syncPut(PET_SYNC_ROUTE, payload);
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
