import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationManager, type PetStateSnapshot } from './conversationManager';
import type { AppConfig } from './config';

// conversationManager 从 getLLMConfig() 取生效 LLM 配置（API 全部由用户档案驱动），
// mock 掉以避免读真实 %APPDATA% 配置
const configMocks = vi.hoisted(() => ({ getLLMConfig: vi.fn() }));
vi.mock('./config', () => ({ getLLMConfig: configMocks.getLLMConfig }));

const mockLLM = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  model: 'base-model',
  systemPrompt: '',
};

beforeEach(() => {
  configMocks.getLLMConfig.mockReset();
  configMocks.getLLMConfig.mockReturnValue({ ...mockLLM });
});

const petState: PetStateSnapshot = { hunger: 80, mood: 80, energy: 80, affection: 50 };

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    petSystemEnabled: true,
    foodSystemEnabled: true,
    randomMoveEnabled: true,
    agentType: 'default',
    userProfile: { name: '测试用户', preferences: {} },
    petState: { hunger: 80, mood: 80, energy: 80, affection: 50 },
    petWindow: { width: 300, height: 300, opacity: 1 },
    petFeatures: {
      feedEnabled: true,
      restEnabled: true,
      playEnabled: true,
      affectionEnabled: true,
    },
    petActions: [],
    platform: { baseUrl: '', frontendUrl: '', accessToken: '', refreshToken: '', user: null },
    ...over,
  };
}

// 不传 filePath：历史仅存内存，测试不产生磁盘 IO
function makeManager(config: AppConfig): ConversationManager {
  return new ConversationManager(config, petState);
}

describe('conversationManager 智能体提示词', () => {
  it('智能体的 systemPrompt 被追加到系统提示词中', () => {
    const manager = makeManager(
      makeConfig({ installedAgentConfig: { name: 'sample-agent', systemPrompt: '你是傲娇猫娘' } })
    );
    const prompt = manager.getSystemPrompt();
    expect(prompt).toContain('你是傲娇猫娘');
    expect(prompt).toContain('桌面宠物'); // 基础人格仍在
  });

  it('智能体提示词排在用户自定义提示词之前', () => {
    configMocks.getLLMConfig.mockReturnValue({ ...mockLLM, systemPrompt: '自定义提示词内容' });
    const manager = makeManager(
      makeConfig({
        installedAgentConfig: { systemPrompt: '智能体提示词内容' },
      })
    );
    const prompt = manager.getSystemPrompt();
    const agentIdx = prompt.indexOf('智能体提示词内容');
    const customIdx = prompt.indexOf('自定义提示词内容');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThan(agentIdx);
  });

  it('智能体配置缺少 systemPrompt 或非对象时不影响默认提示词', () => {
    const noField = makeManager(makeConfig({ installedAgentConfig: { name: 'a' } }));
    expect(noField.getSystemPrompt()).not.toContain('undefined');

    const notObject = makeManager(makeConfig({ installedAgentConfig: 'raw-string' }));
    expect(notObject.getSystemPrompt()).toContain('桌面宠物');

    const nullConfig = makeManager(makeConfig({ installedAgentConfig: null }));
    expect(nullConfig.getSystemPrompt()).toContain('测试用户');
  });

  it('系统提示词包含宠物状态与用户名', () => {
    const manager = makeManager(
      makeConfig({ petState: { hunger: 10, mood: 20, energy: 90, affection: 50 } })
    );
    const prompt = manager.getSystemPrompt();
    expect(prompt).toContain('测试用户');
    expect(prompt).toContain('饿'); // hunger 10 → "现在有点饿了"
  });
});

describe('conversationManager 消息构建与历史', () => {
  it('buildMessages 依次为 system、历史、当前消息', () => {
    const manager = makeManager(makeConfig());
    manager.addUserMessage('第一条');
    manager.addAssistantMessage('回复');

    const messages = manager.buildMessages('第二条');
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: '第一条' });
    expect(messages[2]).toEqual({ role: 'assistant', content: '回复' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '第二条' });
  });

  it('buildGreetingMessages 以 system 开头并带问候指令', () => {
    const messages = makeManager(makeConfig()).buildGreetingMessages();
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('打个招呼');
  });

  it('历史超过上限（MAX_HISTORY*2）时自动裁剪', () => {
    const manager = makeManager(makeConfig());
    for (let i = 0; i < 41; i++) {
      manager.addUserMessage(`msg-${i}`);
      manager.addAssistantMessage(`reply-${i}`);
    }
    // 82 条入队，阈值 40（超出即裁剪到最近 20 条），最终保留 40 条
    expect(manager.getHistory().length).toBe(40);
    expect(manager.getHistory()[0].content).toBe('msg-21');
  });

  it('clearHistory 清空内存中的历史', () => {
    const manager = makeManager(makeConfig());
    manager.addUserMessage('hi');
    manager.clearHistory();
    expect(manager.getHistory()).toHaveLength(0);
  });
});
