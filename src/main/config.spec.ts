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
    expect(cfg.systemPrompt).toContain('智能助手');
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

describe('生效档案选择与档案启停（T2）', () => {
  it('停用的激活档案不生效，回落首个启用档案', () => {
    configModule.saveConfig({
      llmProfiles: [{ ...profileA, enabled: false }, profileB],
      llmActiveProfileId: 'p_a',
    });
    expect(configModule.resolveActiveProfile()?.id).toBe('p_b');
    expect(configModule.getLLMConfig().apiKey).toBe('key-b');
  });

  it('全部停用时无生效档案（getLLMConfig 返回空 API 配置）', () => {
    configModule.saveConfig({
      llmProfiles: [{ ...profileA, enabled: false }],
      llmActiveProfileId: 'p_a',
    });
    expect(configModule.resolveActiveProfile()).toBeUndefined();
    expect(configModule.resolveActiveProfileId()).toBe('');
    expect(configModule.getLLMConfig().apiKey).toBe('');
  });

  it('激活档案被删除后回落首个可用档案', () => {
    configModule.saveConfig({ llmProfiles: [profileA, profileB], llmActiveProfileId: 'p_a' });
    configModule.saveConfig({ llmProfiles: [profileB] });
    expect(configModule.resolveActiveProfileId()).toBe('p_b');
  });

  it('未启用（无 enabled 字段）的旧档案视为启用', () => {
    configModule.saveConfig({ llmProfiles: [profileA], llmActiveProfileId: 'p_a' });
    expect(configModule.isProfileEnabled(profileA)).toBe(true);
    expect(configModule.resolveActiveProfileId()).toBe('p_a');
  });
});

describe('旧档迁移与音色配置归一化（T2）', () => {
  const legacyProfile = {
    id: 'p_old',
    name: '旧档案',
    apiKey: 'legacy-key',
    baseUrl: 'https://old.test/v1',
    model: 'old-model',
  };

  it('旧 6 字段档案升级：补 enabled=true，并回写磁盘（幂等）', () => {
    const diskPath = path.join(userDataDir, 'config.json');
    fs.writeFileSync(
      diskPath,
      JSON.stringify({ llmProfiles: [legacyProfile], llmActiveProfileId: 'p_old' }),
      'utf-8',
    );

    const profiles = configModule.loadConfig().llmProfiles ?? [];
    expect(profiles).toHaveLength(1);
    expect(profiles[0].enabled).toBe(true);
    expect(profiles[0].apiKey).toBe('legacy-key'); // 原有字段不丢
    expect(profiles[0].name).toBe('旧档案');

    // 升级结果已回写磁盘
    const onDisk = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
    expect(onDisk.llmProfiles[0].enabled).toBe(true);

    // 幂等：再次加载不产生新的结构变化
    expect((configModule.saveConfig({}).llmProfiles ?? [])[0].enabled).toBe(true);
  });

  it('旧配置缺少新增字段时补默认值（profileMessages/音色/开关）', () => {
    const diskPath = path.join(userDataDir, 'config.json');
    fs.writeFileSync(diskPath, JSON.stringify({ agentType: 'legacy' }), 'utf-8');

    const cfg = configModule.loadConfig();
    expect(cfg.profileMessages).toEqual({});
    expect(cfg.downloadedVoices).toEqual([]);
    expect(cfg.activeCloudVoiceId).toBe('');
    expect(cfg.ttsCloudConfig).toEqual({ engine: 'openai', baseUrl: '', apiKey: '', model: '' });
    expect(cfg.showThinking).toBe(false);
    expect(cfg.thinkingLang).toBe('auto');
  });

  it('音色库归一化：剔除非法条目、补默认值；云 TTS 凭证引擎缺省 openai', () => {
    const diskPath = path.join(userDataDir, 'config.json');
    fs.writeFileSync(
      diskPath,
      JSON.stringify({
        downloadedVoices: [
          { id: 'v1', name: '', installedAt: 1, config: { engine: 'cloud', voiceId: 'alloy' } },
          { id: '', config: { engine: 'cloud', voiceId: 'x' } },
          { id: 'v2', config: { voiceId: 'y' } }, // 缺 engine → 丢弃
          'bad',
        ],
        ttsCloudConfig: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'tts-1' },
      }),
      'utf-8',
    );

    const cfg = configModule.loadConfig();
    const voices = cfg.downloadedVoices ?? [];
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe('v1');
    expect(voices[0].name).toBe('v1'); // name 缺省回落 id
    expect(cfg.ttsCloudConfig).toEqual({
      engine: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'tts-1',
    });
  });

  it('配置文件损坏时回落默认值且不抛异常', () => {
    const diskPath = path.join(userDataDir, 'config.json');
    fs.writeFileSync(diskPath, '{ this is not json', 'utf-8');
    const cfg = configModule.loadConfig();
    expect(cfg.llmProfiles).toEqual([]);
    expect(cfg.ttsCloudConfig?.engine).toBe('openai');
  });

  it('未绑定历史保留键与渲染端约定一致（跨进程漂移哨兵）', () => {
    expect(configModule.UNBOUND_PROFILE_ID).toBe('__unbound__');
  });

  // 宠工坊窗口尺寸字段已随独立窗口一起移除（改为资源中心内嵌视图，无窗口尺寸可记忆）：
  // 类型与所有写入路径都不再涉及该字段，故不再保留归一化用例。
});
