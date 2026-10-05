import fs from 'fs';
import type { AppConfig, StoredChatMessage } from './config';
import {
  UNBOUND_PROFILE_ID,
  getLLMConfig,
  resolveActiveProfile,
  resolveActiveProfileId,
  sanitizeMessages,
  saveConfig,
} from './config';
import { composeAgentPromptParts } from '../shared/agentPrompt';
import { thinkingLangSystemPrompt, type ChatMessage } from './llmService';

const MAX_HISTORY = 20;

function buildSystemPrompt(config: AppConfig): string {
  // 生效 LLM 配置来自用户配置的激活档案（无默认 API）
  const userConfig = getLLMConfig();
  const userName = config.userProfile.name || '用户';

  const basePrompt = `你是一个智能助手，正在为用户${userName}提供帮助。

精准时间：今天是${new Date().getFullYear()}年${new Date().getMonth() + 1}月${new Date().getDate()}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()]} ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}（这是确切的当前时间，涉及日期、星期、时刻、提醒的问题以此为准，不要编造）

你的性格特点：
- 说话简洁有趣，友好自然
- 关心用户的情绪和需求
- 回复简短自然，像聊天一样，一般不超过两三句话
- 用中文回复`;

  const customPrompt = userConfig.systemPrompt?.trim();
  const installedAgentConfig = config.installedAgentConfig;
  const agentPrompt = installedAgentConfig && typeof installedAgentConfig === 'object'
    ? (installedAgentConfig as { systemPrompt?: unknown }).systemPrompt
    : null;
  // 角色 / 风格：与渲染端预览共用同一拼装口径（src/shared/agentPrompt.ts）
  const profile = resolveActiveProfile();
  const roleStyleParts = composeAgentPromptParts({ role: profile?.role, style: profile?.style });
  const prompts = [
    typeof agentPrompt === 'string' ? agentPrompt.trim() : '',
    customPrompt || '',
    ...roleStyleParts,
    // 思考语言约束（双保险之一：另一处在 llmService 追加到末条用户消息）
    thinkingLangSystemPrompt(config.showThinking === true, config.thinkingLang),
  ].filter(Boolean);
  return prompts.length > 0 ? `${basePrompt}\n\n${prompts.join('\n\n')}` : basePrompt;
}

export class ConversationManager {
  private history: StoredChatMessage[] = [];
  private config: AppConfig;
  /** 内存历史当前归属的档案 id（写回 profileMessages 时用于定位，'' = 无可用档案） */
  private activeId: string;

  constructor(config: AppConfig, legacyHistoryPath?: string) {
    this.config = config;
    this.activeId = resolveActiveProfileId(config);
    this.migrateLegacyHistory(legacyHistoryPath);
    this.reload();
  }

  /**
   * 旧版单档案聊天记录（chat-history.json）迁移到当前档案（无档案时挂 UNBOUND_PROFILE_ID）。
   * 仅当本地还没有任何按档案存储的记录时执行（不覆盖新结构），迁移成功后删除旧文件。
   * @returns 迁移的消息条数（0 = 无需迁移）
   */
  migrateLegacyHistory(legacyPath?: string): number {
    if (!legacyPath) return 0;
    if (Object.keys(this.config.profileMessages ?? {}).length) return 0;
    try {
      if (!fs.existsSync(legacyPath)) return 0;
      const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      const history = sanitizeMessages(parsed?.history);
      if (!history.length) return 0;
      this.config = saveConfig({ profileMessages: { [this.storageKey]: history } });
      fs.rmSync(legacyPath, { force: true });
      return history.length;
    } catch {
      return 0;
    }
  }

  /** 内存历史在 profileMessages 中的落盘键：无可用档案时用保留键，保证记录不因「未建档案」丢失 */
  private get storageKey(): string {
    return this.activeId || UNBOUND_PROFILE_ID;
  }

  /** 按当前落盘键载入内存历史（内存变更均即时落盘，因此直接读取即一致） */
  private reload(): void {
    this.history = sanitizeMessages(this.config.profileMessages?.[this.storageKey]);
  }

  /** 把内存历史写回当前落盘键（整体替换 profileMessages，保留其他档案） */
  private persist(): void {
    this.config = saveConfig({
      profileMessages: { ...(this.config.profileMessages ?? {}), [this.storageKey]: this.history },
    });
  }

  updateConfig(config: AppConfig): void {
    const next = resolveActiveProfileId(config);
    this.config = config;
    // 档案切换（激活档案被切换/停用/删除）时按新档案重新载入历史
    if (next !== this.activeId) {
      this.activeId = next;
      this.reload();
    }
  }

  getSystemPrompt(): string {
    return buildSystemPrompt(this.config);
  }

  buildMessages(userMessage?: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.getSystemPrompt() },
    ];

    // 最近 MAX_HISTORY 条历史：只带 role/content（思考过程不回灌模型，省 token 也避免接口拒收多余字段）
    messages.push(
      ...this.history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content }))
    );

    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    return messages;
  }

  addUserMessage(content: string): void {
    this.history.push({ role: 'user', content });
    this.trimHistory();
    this.persist();
  }

  /** 写入助手回复；reasoning 为本次思考过程（开启 showThinking 时才有，随消息持久化供重启后回看） */
  addAssistantMessage(content: string, reasoning?: string): void {
    const trimmed = reasoning?.trim();
    this.history.push(trimmed ? { role: 'assistant', content, reasoning: trimmed } : { role: 'assistant', content });
    this.trimHistory();
    this.persist();
  }

  clearHistory(): void {
    this.history = [];
    this.persist();
  }

  getHistory(): StoredChatMessage[] {
    return [...this.history];
  }

  /** 当前生效档案 id（'' = 无可用档案；此时聊天记录挂在 UNBOUND_PROFILE_ID 下） */
  getActiveProfileId(): string {
    return this.activeId;
  }

  /** 云同步：导出当前档案的历史消息（供 /api/sync/chat-history，旧版单列表接口） */
  exportHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.history.map((m) => ({ role: m.role, content: m.content }));
  }

  /** 云同步：导出全部档案的聊天记录（供 config.profileMessages 载荷） */
  exportAllProfiles(): Record<string, StoredChatMessage[]> {
    return { ...(this.config.profileMessages ?? {}), [this.storageKey]: this.history };
  }

  /** 云同步恢复（旧版单列表接口）：本地当前档案无记录时用云端数据填充，返回是否发生恢复 */
  restoreFromCloud(messages: unknown): boolean {
    if ((this.config.profileMessages?.[this.storageKey] ?? []).length > 0) return false;
    const valid = sanitizeMessages(messages);
    if (!valid.length) return false;
    this.history = valid;
    this.persist();
    return true;
  }

  /**
   * 云同步恢复（新版按档案字典）：本地一个档案记录都没有时整体采用云端版本（外部边界清洗）。
   * @returns 恢复的档案数量（0 = 未恢复）
   */
  restoreAllProfilesFromCloud(value: unknown): number {
    if (Object.keys(this.config.profileMessages ?? {}).length) return 0;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    const clean: Record<string, StoredChatMessage[]> = {};
    for (const [id, messages] of Object.entries(value as Record<string, unknown>)) {
      if (!id) continue;
      const parsed = sanitizeMessages(messages);
      if (parsed.length) clean[id] = parsed;
    }
    if (!Object.keys(clean).length) return 0;
    this.config = saveConfig({ profileMessages: clean });
    this.reload();
    return Object.keys(clean).length;
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY * 2) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}
