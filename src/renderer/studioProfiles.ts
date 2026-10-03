/**
 * 创作中心「智能体」工作区纯逻辑（与 React 解耦，便于 vitest 覆盖）：
 * 列表搜索/头像/复制/删除级联/切换校验/首个档案继承未绑定历史（T2 交接项）。
 */

import type { LlmProfile, StoredChatMessage } from '../global.d';
import { newProfileId } from './agentPort';

/** 尚无任何档案时聊天记录挂靠的保留键（须与主进程 config.ts 的 UNBOUND_PROFILE_ID 一致） */
export const UNBOUND_PROFILE_ID = '__unbound__';

/** 新建档案：空 Key/模型（避免把上一个 API 内容带进来），默认启用、未绑定形象 */
export function createProfile(profiles: LlmProfile[], now = Date.now()): LlmProfile {
  return {
    id: newProfileId(now),
    name: `智能体 ${profiles.length + 1}`,
    apiKey: '',
    baseUrl: '',
    model: '',
    systemPrompt: '',
    petAssetId: '',
    enabled: true,
  };
}

/** 复制档案：名称加「副本」，保留 Key/人设/绑定/启停与专属音色，仅换新 id */
export function duplicateProfile(profile: LlmProfile, profiles: LlmProfile[], now = Date.now()): LlmProfile {
  return {
    ...profile,
    id: `p_${now.toString(36)}_c${profiles.length}`,
    name: `${profile.name} 副本`,
  };
}

/** 列表搜索：命中名称/模型/角色/风格/简介/领域标签（空查询返回全部） */
export function filterProfiles(profiles: LlmProfile[], query: string): LlmProfile[] {
  const q = query.trim().toLowerCase();
  if (!q) return profiles;
  return profiles.filter((p) => {
    const haystack = [p.name, p.model, p.role, p.style, p.intro, ...(p.domainTags ?? [])]
      .filter((item): item is string => typeof item === 'string')
      .join('\n')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** 卡片头像：自定义 avatar 优先，缺省取名称首字符 */
export function profileAvatar(profile: LlmProfile): string {
  const avatar = (profile.avatar ?? '').trim();
  if (avatar) return avatar;
  const name = (profile.name ?? '').trim();
  return name ? name.charAt(0).toUpperCase() : '?';
}

/** 删除档案后的激活项：删的是激活项则切到剩余的首个启用档案；否则保持不变 */
export function nextActiveAfterDelete(
  remaining: LlmProfile[],
  deletedId: string,
  currentActiveId: string,
): string {
  if (deletedId !== currentActiveId) return currentActiveId;
  return remaining.find((p) => p.enabled !== false)?.id ?? '';
}

/** 删除档案时级联移除其聊天记录（profileMessages 为整体替换语义） */
export function withoutProfileMessages(
  messages: Record<string, StoredChatMessage[]> | undefined,
  deletedId: string,
): Record<string, StoredChatMessage[]> {
  const next = { ...(messages ?? {}) };
  delete next[deletedId];
  return next;
}

/**
 * T2 交接项：创建首个档案时继承「未绑定」历史。
 * 旧版单档案 chat-history.json 迁移后挂在 UNBOUND_PROFILE_ID 下；
 * 用户建首个档案时把它搬进新档案并清空保留键，避免「建档案后老对话看起来消失」。
 * @returns 新的 profileMessages 与实际继承条数（0 = 未继承）
 */
export function inheritUnboundMessages(
  messages: Record<string, StoredChatMessage[]> | undefined,
  newProfileId: string,
): { messages: Record<string, StoredChatMessage[]>; inherited: number } {
  const current = { ...(messages ?? {}) };
  const unbound = current[UNBOUND_PROFILE_ID] ?? [];
  if (!unbound.length || (current[newProfileId]?.length ?? 0) > 0) {
    return { messages: current, inherited: 0 };
  }
  current[newProfileId] = unbound;
  delete current[UNBOUND_PROFILE_ID];
  return { messages: current, inherited: unbound.length };
}

/** 切换激活前的严格绑定校验：返回拦截原因（null = 允许） */
export function activationBlockReason(
  profile: LlmProfile,
  state: { activeId: string; installedPetId?: string; hasInstalledPet: boolean },
): string | null {
  if (profile.id === state.activeId) return '该智能体已是当前对话对象';
  if (profile.enabled === false) return '该智能体已停用：请先启用再切换';
  const bound = (profile.petAssetId ?? '').trim();
  // 未绑定形象：跟随本机当前形象（含内置默认形象），直接放行——
  // 桌面为单形象模型，若在此拦截会让「刚装好还没下形象」的用户无法切换任何智能体
  if (!bound) return null;
  if (!state.hasInstalledPet) {
    return '该智能体绑定的形象不在本机：请先在资源商店安装该形象（右键宠物 → 打开商店 → 宠物）';
  }
  if (bound !== (state.installedPetId ?? '').trim()) {
    return '该智能体绑定的形象不是本机当前形象：请先在商店安装它，或在编辑器中改绑当前形象';
  }
  return null;
}

/** 启停校验：启用永远允许；停用激活中的智能体需先切换（与手机端口径一致） */
export function toggleBlockReason(profile: LlmProfile, activeId: string): string | null {
  if (profile.enabled === false) return null;
  if (profile.id === activeId) return '当前正在对话的智能体不能停用：请先切换到其他智能体';
  return null;
}

/** 档案是否可用于对话（面板/列表共用的「启用」判定） */
export function isProfileEnabled(profile: LlmProfile): boolean {
  return profile.enabled !== false;
}