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

const baseLLM = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  model: 'base-model',
  systemPrompt: '基础提示词',
};

beforeEach(async () => {
  // 每个用例重置模块级缓存 cachedConfig，并使用全新的临时 userData 目录
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-config-test-'));
  configModule = await import('./config');
  configModule.saveConfig({ llm: { ...baseLLM } });
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('getLLMConfig 智能体参数覆盖', () => {
  it('未安装智能体时返回基础 LLM 配置（temperature 为空）', () => {
    const cfg = configModule.getLLMConfig();
    expect(cfg.model).toBe('base-model');
    expect(cfg.baseUrl).toBe('https://api.test/v1');
    expect(cfg.temperature).toBeUndefined();
  });

  it('智能体的 temperature / model / baseUrl 覆盖基础配置，其余字段继承', () => {
    configModule.saveConfig({
      installedAgentConfig: {
        name: 'sample-agent',
        temperature: 0.3,
        model: 'agent-model',
        baseUrl: 'https://agent.test/v1',
      },
    });
    const cfg = configModule.getLLMConfig();
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.model).toBe('agent-model');
    expect(cfg.baseUrl).toBe('https://agent.test/v1');
    expect(cfg.apiKey).toBe('test-key');
    expect(cfg.systemPrompt).toBe('基础提示词');
  });

  it('temperature 超范围被钳制到 [0, 2]', () => {
    configModule.saveConfig({ installedAgentConfig: { temperature: 5 } });
    expect(configModule.getLLMConfig().temperature).toBe(2);

    configModule.saveConfig({ installedAgentConfig: { temperature: -1 } });
    expect(configModule.getLLMConfig().temperature).toBe(0);
  });

  it('非法类型的覆盖字段被忽略（temperature 非数字、model 为空串、baseUrl 非字符串）', () => {
    configModule.saveConfig({
      installedAgentConfig: { temperature: 'high', model: '', baseUrl: 123 },
    });
    const cfg = configModule.getLLMConfig();
    expect(cfg.temperature).toBeUndefined();
    expect(cfg.model).toBe('base-model');
    expect(cfg.baseUrl).toBe('https://api.test/v1');
  });

  it('installedAgentConfig 为字符串或 null 时不产生任何覆盖', () => {
    configModule.saveConfig({ installedAgentConfig: 'not-an-object' });
    expect(configModule.getLLMConfig().model).toBe('base-model');

    configModule.saveConfig({ installedAgentConfig: null });
    expect(configModule.getLLMConfig().temperature).toBeUndefined();
  });

  it('重启（重新从磁盘加载配置）后智能体覆盖依然生效', async () => {
    configModule.saveConfig({
      installedAgentConfig: { temperature: 1.1, model: 'agent-model' },
    });

    // 模拟应用重启：重置模块缓存后重新加载（此时磁盘上已有 config.json）
    vi.resetModules();
    configModule = await import('./config');
    expect(configModule.getLLMConfig().model).toBe('agent-model');
    expect(configModule.getLLMConfig().temperature).toBe(1.1);
  });
});
