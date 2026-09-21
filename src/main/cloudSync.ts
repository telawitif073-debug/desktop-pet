/**
 * 用户数据云同步：桌面端与手机端共用平台后端 /api/sync/*（LLM Key 由服务端 AES-256-GCM 加密落库）。
 * 策略（v1）：
 * - 登录后拉取：config 仅在本地 llmProfiles 为空时采用云端（重装/换机恢复）；pet-state、
 *   聊天记录仅在本地为空时恢复——已有本地数据时本地为准（本轮权威版本）。
 * - 本地变更 60s 防抖上传（config 的 LLM 字段变更 / 宠物状态持久化 / 聊天消息变更时调度），
 *   退出前尽力 flush。
 * 冲突策略：last-write-wins（后写覆盖）。
 */

import fs from 'fs';
import { loadConfig, saveConfig, type AppConfig } from './config';
import { platformClient } from './platformClient';

/** 跨设备共享的当前宠物引用（本地路径不跨设备，只同步平台资源 ID，换机后按 ID 重新下载安装） */
interface CurrentPetRef {
  id: string;
  name?: string;
  format?: string;
}

export type SyncKind = 'config' | 'pet_state' | 'chat_history';

const UPLOAD_DELAY = 60 * 1000;
const timers: Partial<Record<SyncKind, NodeJS.Timeout>> = {};

// 聊天历史由 main.ts 创建的 ConversationManager 单例持有，此处通过注入解耦
interface ChatHistoryStore {
  exportHistory(): Array<{ role: 'user' | 'assistant'; content: string }>;
  restoreFromCloud(messages: unknown): boolean;
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

/** 登录后拉取云端数据恢复本地缺失部分，返回恢复结果（供 main.ts 应用到内存与刷新 UI） */
export async function pullAfterLogin(): Promise<{
  petState?: AppConfig['petState'];
  petReinstalled?: boolean;
}> {
  if (!loggedIn()) return {};
  const cfg = loadConfig();
  const restored: { petState?: AppConfig['petState']; petReinstalled?: boolean } = {};

  // 1. 配置（LLM profiles + 聊天人设 + 当前宠物引用）
  try {
    const remote = await platformClient.syncGet('config');
    if (remote?.data) {
      const data = remote.data as Partial<AppConfig> & { currentPet?: CurrentPetRef | null };
      // 1a. LLM 档案：本地为空时从云端恢复
      if (!(cfg.llmProfiles?.length) && Array.isArray(data.llmProfiles) && data.llmProfiles.length) {
        saveConfig({
          llmProfiles: data.llmProfiles,
          llmActiveProfileId: data.llmActiveProfileId,
          petSelfDescription: data.petSelfDescription,
          installedAgentConfig: data.installedAgentConfig,
        });
        console.log(`[cloudSync] 已从云端恢复 LLM 配置（${data.llmProfiles.length} 个档案）`);
      }
      // 1b. 当前宠物：本地无宠物（或本地资源文件已丢失，如重装/换机）时按云端 ID 重新下载安装
      const localPetMissing =
        !cfg.petAssetId || !cfg.petAssetPath || !fs.existsSync(cfg.petAssetPath);
      if (data.currentPet?.id && localPetMissing) {
        try {
          await platformClient.install('pet', data.currentPet.id);
          restored.petReinstalled = true;
          console.log(`[cloudSync] 已从云端恢复当前宠物（${data.currentPet.name ?? data.currentPet.id}）`);
        } catch (err) {
          console.log('[cloudSync] 恢复云端宠物失败:', errorMessage(err));
        }
      }
    }
  } catch (err) {
    console.log('[cloudSync] 拉取配置失败:', errorMessage(err));
  }

  // 2. 宠物状态：本地缺失（首次/重装）时恢复
  try {
    const remote = await platformClient.syncGet('pet_state');
    if (remote?.data && !cfg.petState) {
      const state = remote.data as AppConfig['petState'];
      saveConfig({ petState: state });
      restored.petState = state;
      console.log('[cloudSync] 已从云端恢复宠物状态');
    }
  } catch (err) {
    console.log('[cloudSync] 拉取宠物状态失败:', errorMessage(err));
  }

  // 3. 聊天记录：本地历史为空时恢复
  try {
    const remote = await platformClient.syncGet('chat_history');
    if (remote?.data && chatStore?.restoreFromCloud(remote.data)) {
      console.log('[cloudSync] 已从云端恢复聊天记录');
    }
  } catch (err) {
    console.log('[cloudSync] 拉取聊天记录失败:', errorMessage(err));
  }

  return restored;
}

/** 上传某类数据的本地版本（本地为准，覆盖云端） */
export async function uploadNow(kind: SyncKind): Promise<void> {
  if (!loggedIn()) return;
  try {
    if (kind === 'config') {
      // 仅同步跨设备相关的配置：LLM 档案（Key 服务端加密）+ 当前档案 + 聊天人设/宠物自我描述 + 当前宠物引用
      const cfg = loadConfig();
      const currentPet: CurrentPetRef | null = cfg.petAssetId
        ? { id: cfg.petAssetId, name: cfg.petAssetName, format: cfg.petAssetFormat }
        : null;
      await platformClient.syncPut('config', {
        llmProfiles: cfg.llmProfiles ?? [],
        llmActiveProfileId: cfg.llmActiveProfileId ?? '',
        petSelfDescription: cfg.petSelfDescription ?? '',
        installedAgentConfig: cfg.installedAgentConfig ?? null,
        currentPet,
      });
    } else if (kind === 'pet_state') {
      const state = loadConfig().petState;
      if (state) await platformClient.syncPut('pet_state', state);
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
  (['config', 'pet_state', 'chat_history'] as SyncKind[]).forEach((kind) => {
    if (timers[kind]) {
      clearTimeout(timers[kind]);
      timers[kind] = undefined;
      void uploadNow(kind);
    }
  });
}
