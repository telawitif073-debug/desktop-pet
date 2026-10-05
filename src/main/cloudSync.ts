/**
 * 用户数据云同步：桌面端与手机端共用平台后端 /api/sync/*（LLM Key 由服务端 AES-256-GCM 加密落库）。
 * 策略（v1）：
 * - 登录后拉取：config 仅在本地 llmProfiles 为空时采用云端（重装/换机恢复）；聊天记录仅在本地为空时恢复
 *   ——已有本地数据时本地为准（本轮权威版本）。
 * - 本地变更 60s 防抖上传（config 的 LLM 字段变更 / 聊天消息变更时调度），退出前尽力 flush。
 * 冲突策略：last-write-wins（后写覆盖）。
 */

import { loadConfig, saveConfig, type AppConfig, type PetSettings } from './config';
import { platformClient } from './platformClient';
import { PET_CONFIG_KEYS } from '@pet/api';

export type SyncKind = 'config' | 'chat_history';

const UPLOAD_DELAY = 60 * 1000;
const timers: Partial<Record<SyncKind, NodeJS.Timeout>> = {};

// 聊天历史由 main.ts 创建的 ConversationManager 单例持有，此处通过注入解耦
interface ChatHistoryStore {
  /** 导出当前档案的历史（旧版 /sync/chat-history 单列表接口） */
  exportHistory(): Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 导出全部档案的历史（新版 config.profileMessages 载荷） */
  exportAllProfiles(): Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>;
  restoreFromCloud(messages: unknown): boolean;
  restoreAllProfilesFromCloud(value: unknown): number;
}
let chatStore: ChatHistoryStore | null = null;

export function bindChatStore(store: ChatHistoryStore): void {
  chatStore = store;
}

function loggedIn(): boolean {
  return !!loadConfig().platform.accessToken;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 宠物在 config jsonb 里的 12 个键（见 `pet/api/syncKeys.ts`）——只有这些随云同步，
 * 窗口外观/功能开关/总开关等本机偏好不上云。
 */
function pickPetSyncKeys(pet: AppConfig['pet']): Partial<PetSettings> | null {
  if (!pet) return null;
  const source = pet as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PET_CONFIG_KEYS) out[key] = source[key];
  return out as Partial<PetSettings>;
}

/** 登录后拉取云端数据恢复本地缺失部分（配置 / 智能体人设 / 音色库 / 聊天记录） */
export async function pullAfterLogin(): Promise<void> {
  if (!loggedIn()) return;

  // 1. 配置（LLM profiles = 智能体 + 多档聊天记录 + 音色库 + 云 TTS 凭证）
  try {
    const remote = await platformClient.syncGet('config');
    if (remote?.data) {
      const data = remote.data as Partial<AppConfig>;
      // 1a. LLM 档案：本地为空时从云端恢复（外部边界清洗：云端旧档可能缺字段，一律归零为空串）
      if (!(loadConfig().llmProfiles?.length) && Array.isArray(data.llmProfiles) && data.llmProfiles.length) {
        saveConfig({
          llmProfiles: data.llmProfiles.map((p) => ({
            ...p,
            apiKey: p.apiKey ?? '',
            baseUrl: p.baseUrl ?? '',
            model: p.model ?? '',
            systemPrompt: p.systemPrompt ?? '',
          })),
          llmActiveProfileId: data.llmActiveProfileId,
          installedAgentConfig: data.installedAgentConfig,
        });
        console.log(`[cloudSync] 已从云端恢复 LLM 配置（${data.llmProfiles.length} 个档案）`);
      }
      // 1b. 音色：本地无已安装音色时整体恢复；云 TTS 凭证本地为空时恢复（apiKey 服务端已解密）
      const cfgNow = loadConfig();
      if (!(cfgNow.downloadedVoices?.length) && Array.isArray(data.downloadedVoices) && data.downloadedVoices.length) {
        saveConfig({
          downloadedVoices: data.downloadedVoices,
          activeCloudVoiceId: data.activeCloudVoiceId ?? '',
        });
        console.log(`[cloudSync] 已从云端恢复音色库（${data.downloadedVoices.length} 个音色）`);
      }
      const cloudTts = data.ttsCloudConfig;
      if (!loadConfig().ttsCloudConfig?.apiKey && cloudTts?.apiKey) {
        saveConfig({ ttsCloudConfig: cloudTts });
        console.log('[cloudSync] 已从云端恢复云 TTS 服务配置');
      }
      // 1c. 多档聊天记录：本地一个档案记录都没有时整体采用云端版本
      if (data.profileMessages && chatStore) {
        const restored = chatStore.restoreAllProfilesFromCloud(data.profileMessages);
        if (restored) console.log(`[cloudSync] 已从云端恢复 ${restored} 个档案的聊天记录`);
      }
      // 1d. 宠物系统：本地还没有任何宠物/形象时采用云端（12 个键，含四维与已安装宠物）
      const localPet = loadConfig().pet;
      if (data.pet && !localPet?.downloadedPets?.length && !localPet?.currentPet && !localPet?.builtinPet) {
        saveConfig({ pet: data.pet });
        console.log('[cloudSync] 已从云端恢复宠物设置');
      }
    }
  } catch (err) {
    console.log('[cloudSync] 拉取配置失败:', errorMessage(err));
  }

  // 2. 聊天记录：本地历史为空时恢复
  try {
    const remote = await platformClient.syncGet('chat_history');
    if (remote?.data && chatStore?.restoreFromCloud(remote.data)) {
      console.log('[cloudSync] 已从云端恢复聊天记录');
    }
  } catch (err) {
    console.log('[cloudSync] 拉取聊天记录失败:', errorMessage(err));
  }
}

/** 上传某类数据的本地版本（本地为准，覆盖云端） */
export async function uploadNow(kind: SyncKind): Promise<void> {
  if (!loggedIn()) return;
  try {
    if (kind === 'config') {
      const cfg = loadConfig();
      // 防护：本地一个档案都没有时不覆盖云端（云端可能正是用户误删前的数据，下次登录可恢复）
      if (!cfg.llmProfiles?.length) {
        console.log('[cloudSync] 本地智能体列表为空，跳过 config 上传（不覆盖云端），下次登录可恢复');
        return;
      }
      // 仅同步跨设备相关的配置：智能体档案（Key 服务端加密）+ 当前档案 + 多档聊天记录 +
      // 音色库与云 TTS 凭证（apiKey 服务端加密）+ 宠物系统 12 个键（四维/形象/动作/已安装宠物）
      await platformClient.syncPut('config', {
        llmProfiles: cfg.llmProfiles ?? [],
        llmActiveProfileId: cfg.llmActiveProfileId ?? '',
        profileMessages: chatStore?.exportAllProfiles() ?? {},
        downloadedVoices: cfg.downloadedVoices ?? [],
        activeCloudVoiceId: cfg.activeCloudVoiceId ?? '',
        ttsCloudConfig: cfg.ttsCloudConfig ?? null,
        installedAgentConfig: cfg.installedAgentConfig ?? null,
        pet: pickPetSyncKeys(cfg.pet),
      });
    } else if (chatStore) {
      await platformClient.syncPut('chat_history', chatStore.exportHistory());
    }
  } catch (err) {
    console.log(`[cloudSync] 上传 ${kind} 失败:`, errorMessage(err));
  }
}

/** 本地变更防抖上传（60s 合并多次变更） */
export function scheduleUpload(kind: SyncKind): void {
  if (!loggedIn() || timers[kind]) return;
  timers[kind] = setTimeout(() => {
    timers[kind] = undefined;
    void uploadNow(kind);
  }, UPLOAD_DELAY);
}

/** 退出前 flush 全部待上传数据（尽力而为，不阻塞退出） */
export function flushAllOnQuit(): void {
  (['config', 'chat_history'] as SyncKind[]).forEach((kind) => {
    if (timers[kind]) {
      clearTimeout(timers[kind]);
      timers[kind] = undefined;
      void uploadNow(kind);
    }
  });
}
