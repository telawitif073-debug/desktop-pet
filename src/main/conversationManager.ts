import fs from 'fs';
import path from 'path';
import type { AppConfig, LLMConfig, UserProfile } from './config';
import type { ChatMessage } from './llmService';

const MAX_HISTORY = 20;

export interface PetStateSnapshot {
  hunger: number;
  mood: number;
  energy: number;
  affection: number;
}

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '深夜了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 22) return '晚上好';
  return '夜深了';
}

function describePetState(state: PetStateSnapshot): string {
  const parts: string[] = [];
  if (state.hunger < 30) parts.push('现在有点饿了');
  else if (state.hunger > 80) parts.push('吃得很饱');

  if (state.mood < 30) parts.push('心情不太好');
  else if (state.mood > 80) parts.push('心情很好');

  if (state.energy < 30) parts.push('有点累了想休息');
  else if (state.energy > 80) parts.push('精力充沛');

  if (state.affection > 80) parts.push('和你很亲近');
  else if (state.affection < 20) parts.push('还不太熟悉你');

  return parts.length > 0 ? `我${parts.join('，')}。` : '我现在状态不错。';
}

function buildSystemPrompt(
  config: AppConfig,
  petState: PetStateSnapshot
): string {
  const userConfig = config.llm;
  const userName = config.userProfile.name || '主人';

  const basePrompt = `你是一个可爱的桌面宠物，正在陪伴用户${userName}。
${getTimeGreeting()}！你现在的状态：${describePetState(petState)}

你的性格特点：
- 活泼可爱，说话简洁有趣，偶尔撒娇
- 关心主人的情绪和健康
- 回复简短自然，像聊天一样，一般不超过两三句话
- 用中文回复
- 偶尔提到自己的状态（饿、开心、累等），自然融入对话`;

  const customPrompt = userConfig.systemPrompt?.trim();
  return customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;
}

export class ConversationManager {
  private history: ChatMessage[] = [];
  private config: AppConfig;
  private petState: PetStateSnapshot;
  private filePath: string | null;

  constructor(config: AppConfig, petState: PetStateSnapshot, filePath?: string) {
    this.config = config;
    this.petState = petState;
    this.filePath = filePath ?? null;
    this.loadHistory();
  }

  private loadHistory(): void {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(parsed?.history)) {
        this.history = parsed.history.filter(
          (m: ChatMessage) =>
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string'
        );
      }
    } catch {
      this.history = [];
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ history: this.history }, null, 2),
        'utf-8'
      );
    } catch (e) {
      console.error('Failed to save chat history:', e);
    }
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  updatePetState(state: PetStateSnapshot): void {
    this.petState = state;
  }

  getSystemPrompt(): string {
    return buildSystemPrompt(this.config, this.petState);
  }

  buildMessages(userMessage?: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.getSystemPrompt() },
    ];

    // Include last MAX_HISTORY messages from history
    const recent = this.history.slice(-MAX_HISTORY);
    messages.push(...recent);

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

  addAssistantMessage(content: string): void {
    this.history.push({ role: 'assistant', content });
    this.trimHistory();
    this.persist();
  }

  buildGreetingMessages(): ChatMessage[] {
    const greetingPrompt = `${getTimeGreeting()}！主动跟主人打个招呼，根据当前时间和你的状态说一句简短的话。`;
    return [
      { role: 'system', content: this.getSystemPrompt() },
      { role: 'user', content: greetingPrompt },
    ];
  }

  clearHistory(): void {
    this.history = [];
    this.persist();
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY * 2) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}
