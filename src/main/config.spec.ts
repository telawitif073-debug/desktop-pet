import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config.ts 依赖 electron 的 app.getPath('userData')；用临时目录替代真实 userData，
// 避免测试污染 %APPDATA%\desktop-pet\config.json
let userDataDir = '';
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
}));

type ConfigModule = typeof import('./config');
let configModule: ConfigModule;

const profileA = {
  id: 'p_a',
  name: 'DeepSeek',
  apiKey: 'key-a',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  systemPrompt: 'A 的人格',
};
const profileB = {
  id: 'p_b',
  name: '智谱 GLM',
  apiKey: 'key-b',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-flash',
};

beforeEach(async () => {
  // 每个用例重置模块级缓存 cachedConfig，并使用全新的临时 userData 目录
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-config-test-'));
  configModule = await import('./config');
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('getLLMConfig 档案驱动（API 全部由用户配置，无默认 API）', () => {
  it('激活的档案作为生效配置', () => {
    configModule.saveConfig({ llmProfiles: [profileA, profileB], llmActiveProfileId: 'p_b' });
    const cfg = configModule.getLLMConfig();
    expect(cfg.apiKey).toBe('key-b');
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(cfg.model).toBe('glm-4-flash');
    // profileB 无 systemPrompt：使用兜底人格提示词
    expect(cfg.systemPrompt).toContain('桌面宠物');
  });

  it('llmActiveProfileId 未设置或失效时回落第一个档案', () => {
    configModule.saveConfig({ llmProfiles: [profileA, profileB] });
    expect(configModule.getLLMConfig().apiKey).toBe('key-a');

    configModule.saveConfig({ llmProfiles: [profileA, profileB], llmActiveProfileId: 'p_missing' });
    expect(configModule.getLLMConfig().apiKey).toBe('key-a');
  });

  it('没有任何档案时返回空配置（apiKey/baseUrl 为空，带兜底人格提示词）', () => {
    const cfg = configModule.getLLMConfig();
    expect(cfg.apiKey).toBe('');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.model).toBe('');
    expect(cfg.systemPrompt).not.toBe('');
  });

  it('档案 systemPrompt 为空时使用兜底人格提示词', () => {
    configModule.saveConfig({ llmProfiles: [{ ...profileA, systemPrompt: '' }], llmActiveProfileId: 'p_a' });
    expect(configModule.getLLMConfig().systemPrompt).not.toBe('');
  });

  it('平台安装的智能体不再覆盖 API 参数（平台不提供 API）', () => {
    configModule.saveConfig({ llmProfiles: [profileA], llmActiveProfileId: 'p_a' });
    configModule.saveConfig({
      installedAgentConfig: {
        name: 'sample-agent',
        systemPrompt: '智能体人设',
        model: 'agent-model',
        baseUrl: 'https://agent.test/v1',
        temperature: 0.3,
      },
    });
    const cfg = configModule.getLLMConfig();
    expect(cfg.apiKey).toBe('key-a');
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com');
    expect(cfg.temperature).toBeUndefined();
  });

  it('重启（重新从磁盘加载配置）后激活档案依然生效', async () => {
    configModule.saveConfig({ llmProfiles: [profileA, profileB], llmActiveProfileId: 'p_b' });

    // 模拟应用重启：重置模块缓存后重新加载（此时磁盘上已有 config.json）
    vi.resetModules();
    configModule = await import('./config');
    expect(configModule.getLLMConfig().model).toBe('glm-4-flash');
  });

  it('旧版客户端残留的 llm 字段不参与生效逻辑', async () => {
    configModule.saveConfig({ llmProfiles: [profileA], llmActiveProfileId: 'p_a' });
    const diskPath = path.join(userDataDir, 'config.json');
    const raw = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
    raw.llm = { apiKey: 'legacy-key', baseUrl: 'https://legacy.test/v1', model: 'legacy-model', systemPrompt: 'legacy', provider: 'openai' };
    fs.writeFileSync(diskPath, JSON.stringify(raw), 'utf-8');

    // 模拟重启后重新加载：legacy llm 被完全无视
    vi.resetModules();
    configModule = await import('./config');
    expect(configModule.getLLMConfig().apiKey).toBe('key-a');
    expect(configModule.getLLMConfig().model).toBe('deepseek-chat');
  });
});
