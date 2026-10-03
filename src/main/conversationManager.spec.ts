import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AppConfig } from './config';
import type { ConversationManager, PetStateSnapshot } from './conversationManager';

// config.ts 依赖 electron app.getPath('userData')：用临时目录替代真实 userData，
// 使「按档案隔离落盘」「旧单档案迁移」等用例可以走真实读写。
// 不 mock ./config：getLLMConfig 也走真实配置（用例用 saveConfig 写档案来控制人设）。
let userDataDir = '';
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
}));

type ConversationModule = typeof import('./conversationManager');
let conv: ConversationModule;
let configModule: typeof import('./config');

beforeEach(async () => {
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-conv-test-'));
  configModule = await import('./config');
  conv = await import('./conversationManager');
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const petState: PetStateSnapshot = { hunger: 80, mood: 80, energy: 80, affection: 50 };

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    petSystemEnabled: true,
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

// 不落盘场景（无档案）：历史仅存内存，测试不产生磁盘 IO
function makeManager(config: AppConfig): ConversationManager {
  return new conv.ConversationManager(config, petState);
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
    // 档案 systemPrompt 即「用户自定义提示词」（getLLMConfig 驱动）
    configModule.saveConfig({
      llmProfiles: [
        {
          id: 'p1',
          name: '档案1',
          apiKey: 'k',
          baseUrl: 'https://api.test/v1',
          model: 'm',
          systemPrompt: '自定义提示词内容',
        },
      ],
      llmActiveProfileId: 'p1',
    });
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

describe('conversationManager 多档案消息隔离（T2）', () => {
  const profileA = { id: 'p_a', name: '档案A', apiKey: 'ka', baseUrl: 'https://a/v1', model: 'ma' };
  const profileB = { id: 'p_b', name: '档案B', apiKey: 'kb', baseUrl: 'https://b/v1', model: 'mb' };

  /** 写入两个档案并激活其中一个，返回绑定真实配置的管理器 */
  function setup(activeId = 'p_a'): ConversationManager {
    configModule.saveConfig({
      llmProfiles: [profileA, profileB],
      llmActiveProfileId: activeId,
      profileMessages: {},
    });
    return new conv.ConversationManager(configModule.loadConfig(), petState);
  }

  /** 切换激活档案（与 config:set → updateConfig 的真实链路一致） */
  function activate(manager: ConversationManager, id: string): void {
    configModule.saveConfig({ llmActiveProfileId: id });
    manager.updateConfig(configModule.loadConfig());
  }

  it('各档案消息分别落盘，切换档案后互不串档', () => {
    const manager = setup('p_a');
    manager.addUserMessage('A 的问题');
    manager.addAssistantMessage('A 的回答');
    expect(configModule.loadConfig().profileMessages?.p_a).toHaveLength(2);

    activate(manager, 'p_b');
    expect(manager.getHistory()).toHaveLength(0);
    manager.addUserMessage('B 的问题');

    const messages = configModule.loadConfig().profileMessages ?? {};
    expect(messages.p_b).toHaveLength(1);
    expect(messages.p_a).toHaveLength(2); // A 的历史未被覆盖

    activate(manager, 'p_a');
    expect(manager.getHistory().map((m) => m.content)).toEqual(['A 的问题', 'A 的回答']);
  });

  it('重启（新建管理器实例）后按激活档案恢复历史', () => {
    const manager = setup('p_b');
    manager.addUserMessage('B 的问题');
    const restarted = new conv.ConversationManager(configModule.loadConfig(), petState);
    expect(restarted.getHistory().map((m) => m.content)).toEqual(['B 的问题']);
  });

  it('clearHistory 只清当前档案，其他档案不受影响', () => {
    const manager = setup('p_a');
    manager.addUserMessage('A 的问题');
    activate(manager, 'p_b');
    manager.addUserMessage('B 的问题');
    manager.clearHistory();

    const messages = configModule.loadConfig().profileMessages ?? {};
    expect(messages.p_b ?? []).toHaveLength(0);
    expect(messages.p_a).toHaveLength(1);
  });

  it('激活档案被停用后自动让位首个启用档案的历史', () => {
    const manager = setup('p_a');
    manager.addUserMessage('A 的问题');
    configModule.saveConfig({ llmProfiles: [{ ...profileA, enabled: false }, profileB] });
    manager.updateConfig(configModule.loadConfig());
    expect(manager.getActiveProfileId()).toBe('p_b');
    expect(manager.getHistory()).toHaveLength(0);
  });

  it('exportAllProfiles 导出全部档案（含未激活档案）', () => {
    const manager = setup('p_a');
    manager.addUserMessage('A 的问题');
    activate(manager, 'p_b');
    manager.addUserMessage('B 的问题');

    const all = manager.exportAllProfiles();
    expect(Object.keys(all).sort()).toEqual(['p_a', 'p_b']);
    expect(all.p_a[0].content).toBe('A 的问题');
    expect(all.p_b[0].content).toBe('B 的问题');
  });

  it('云端 profileMessages 在本地为空时整体恢复（含外部边界清洗）', () => {
    configModule.saveConfig({ llmProfiles: [profileA, profileB], llmActiveProfileId: 'p_a' });
    const manager = new conv.ConversationManager(configModule.loadConfig(), petState);

    const restored = manager.restoreAllProfilesFromCloud({
      p_a: [{ role: 'user', content: '云端 A' }],
      p_b: [{ role: 'user', content: '云端 B' }, { role: 'system', content: '应被丢弃' }],
      p_c: 'not-an-array',
    });

    expect(restored).toBe(2);
    expect(manager.getHistory().map((m) => m.content)).toEqual(['云端 A']);
    expect(configModule.loadConfig().profileMessages?.p_b).toHaveLength(1);
  });

  it('本地已有任何档案记录时不用云端覆盖', () => {
    const manager = setup('p_a');
    manager.addUserMessage('本地 A');
    expect(manager.restoreAllProfilesFromCloud({ p_a: [{ role: 'user', content: '云端 A' }] })).toBe(0);
    expect(manager.getHistory().map((m) => m.content)).toEqual(['本地 A']);
  });
});

describe('conversationManager 旧单档案聊天记录迁移（T2）', () => {
  const legacyProfile = { id: 'p_a', name: '档案A', apiKey: 'ka', baseUrl: 'https://a/v1', model: 'ma' };

  function writeLegacy(name: string, history: unknown): string {
    const legacyPath = path.join(userDataDir, name);
    fs.writeFileSync(legacyPath, JSON.stringify({ history }), 'utf-8');
    return legacyPath;
  }

  it('chat-history.json 迁移到激活档案并删除旧文件', () => {
    configModule.saveConfig({ llmProfiles: [legacyProfile], llmActiveProfileId: 'p_a' });
    const legacyPath = writeLegacy('chat-history.json', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'system', content: '系统提示词不应落盘' },
    ]);

    const manager = new conv.ConversationManager(configModule.loadConfig(), petState, legacyPath);

    expect(manager.getHistory().map((m) => m.content)).toEqual(['旧问题', '旧回答']);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(configModule.loadConfig().profileMessages?.p_a).toHaveLength(2);
  });

  it('已有按档案记录时不覆盖新结构（旧文件保留待人工处理）', () => {
    configModule.saveConfig({
      llmProfiles: [legacyProfile],
      llmActiveProfileId: 'p_a',
      profileMessages: { p_a: [{ role: 'user', content: '新结构' }] },
    });
    const legacyPath = writeLegacy('chat-history.json', [{ role: 'user', content: '旧问题' }]);

    const manager = new conv.ConversationManager(configModule.loadConfig(), petState, legacyPath);

    expect(manager.getHistory().map((m) => m.content)).toEqual(['新结构']);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('没有可用档案时旧记录迁移到未绑定键（聊天记录不丢）', () => {
    const legacyPath = writeLegacy('chat-history.json', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
    ]);
    const manager = new conv.ConversationManager(configModule.loadConfig(), petState, legacyPath);

    expect(manager.getHistory().map((m) => m.content)).toEqual(['旧问题', '旧回答']);
    expect(manager.getActiveProfileId()).toBe('');
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(configModule.loadConfig().profileMessages?.__unbound__).toHaveLength(2);
  });

  it('未绑定历史在用户创建首个档案后仍保留在未绑定键下（不丢失）', () => {
    const legacyPath = writeLegacy('chat-history.json', [{ role: 'user', content: '旧问题' }]);
    const manager = new conv.ConversationManager(configModule.loadConfig(), petState, legacyPath);

    configModule.saveConfig({
      llmProfiles: [legacyProfile],
      llmActiveProfileId: 'p_a',
    });
    manager.updateConfig(configModule.loadConfig());

    // 新档案从空历史开始，旧记录仍在未绑定键下（T3 创建首个档案时可选择继承）
    expect(manager.getHistory()).toHaveLength(0);
    expect(configModule.loadConfig().profileMessages?.__unbound__).toHaveLength(1);
  });
});
