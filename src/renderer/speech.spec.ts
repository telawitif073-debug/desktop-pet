import { describe, expect, it } from 'vitest';
import { resolveSpeakPlan, speakContextFromConfig, type SpeakContext } from './speech';
import type { InstalledVoice } from '../global.d';

function voice(id: string, engine: InstalledVoice['config']['engine']): InstalledVoice {
  return {
    id,
    name: id,
    installedAt: 1,
    config: { engine, voiceId: id === 'sys-1' ? 'Tingting' : engine === 'cloud' ? 'alloy' : '' },
  };
}

const cloudA = voice('cloud-a', 'cloud');
const cloudB = voice('cloud-b', 'cloud');
const gpts = voice('gpts-1', 'gptsovits');
const sys = voice('sys-1', 'system');

const edgeSettings = { enabled: true, tone: 'natural' as const, rate: 1, pitch: 1, volume: 1 };

describe('resolveSpeakPlan 朗读降级顺序（T9）', () => {
  it('智能体专属音色优先，其次全局云音色，最后 Edge 与系统兜底', () => {
    const ctx: SpeakContext = {
      speech: edgeSettings,
      downloadedVoices: [cloudA, cloudB, gpts],
      activeCloudVoiceId: 'cloud-b',
      boundVoiceId: 'cloud-a',
    };
    expect(resolveSpeakPlan(ctx)).toEqual([
      { kind: 'installed', voiceId: 'cloud-a' },
      { kind: 'global-cloud', voiceId: 'cloud-b' },
      { kind: 'edge', voice: 'zh-CN-XiaoxiaoNeural' },
      { kind: 'system', voice: '' },
    ]);
  });

  it('绑定音色与全局音色相同时不重复入队', () => {
    const plan = resolveSpeakPlan({
      speech: edgeSettings,
      downloadedVoices: [cloudA],
      activeCloudVoiceId: 'cloud-a',
      boundVoiceId: 'cloud-a',
    });
    expect(plan.map((s) => s.kind)).toEqual(['installed', 'edge', 'system']);
  });

  it('绑定音色已被删除时不入队（自动跟随全局音色）', () => {
    const plan = resolveSpeakPlan({
      speech: edgeSettings,
      downloadedVoices: [cloudB],
      activeCloudVoiceId: 'cloud-b',
      boundVoiceId: 'cloud-gone',
    });
    expect(plan[0]).toEqual({ kind: 'global-cloud', voiceId: 'cloud-b' });
  });

  it('选择系统音色时以该音色为主，且不再插入 Edge 步骤', () => {
    const plan = resolveSpeakPlan({
      speech: { ...edgeSettings, voice: 'sys:Microsoft Huihui' },
      downloadedVoices: [],
      activeCloudVoiceId: '',
    });
    expect(plan).toEqual([{ kind: 'system', voice: 'Microsoft Huihui' }]);
  });

  it('选择 Edge 具体音色时使用该音色，兜底为系统默认', () => {
    const plan = resolveSpeakPlan({
      speech: { ...edgeSettings, voice: 'edge:zh-CN-YunxiNeural' },
    });
    expect(plan).toEqual([
      { kind: 'edge', voice: 'zh-CN-YunxiNeural' },
      { kind: 'system', voice: '' },
    ]);
  });

  it('旧版 voiceURI 数据按系统音色迁移', () => {
    const plan = resolveSpeakPlan({
      speech: { ...edgeSettings, voice: '', voiceURI: 'Microsoft Huihui' },
    });
    expect(plan).toEqual([{ kind: 'system', voice: 'Microsoft Huihui' }]);
  });

  it('无任何配置时为 Edge 默认 + 系统兜底', () => {
    expect(resolveSpeakPlan({})).toEqual([
      { kind: 'edge', voice: 'zh-CN-XiaoxiaoNeural' },
      { kind: 'system', voice: '' },
    ]);
  });

  it('gptsovits 音色与 cloud 同走云合成链路（顺序一致）', () => {
    const plan = resolveSpeakPlan({
      speech: edgeSettings,
      downloadedVoices: [gpts],
      activeCloudVoiceId: 'gpts-1',
    });
    expect(plan[0]).toEqual({ kind: 'global-cloud', voiceId: 'gpts-1' });
  });

  it('系统引擎的已安装音色也作为候选入队（由执行器走系统 TTS）', () => {
    const plan = resolveSpeakPlan({
      speech: edgeSettings,
      downloadedVoices: [sys],
      activeCloudVoiceId: 'sys-1',
    });
    expect(plan[0]).toEqual({ kind: 'global-cloud', voiceId: 'sys-1' });
  });
});

describe('speakContextFromConfig 从配置组装朗读上下文（T9）', () => {
  it('取激活档案的 boundVoiceId 与音色库配置', () => {
    const ctx = speakContextFromConfig({
      speech: edgeSettings,
      downloadedVoices: [cloudA],
      activeCloudVoiceId: 'cloud-a',
      llmProfiles: [
        { id: 'p1', boundVoiceId: 'cloud-a' },
        { id: 'p2', boundVoiceId: 'cloud-b' },
      ],
      llmActiveProfileId: 'p2',
    });
    expect(ctx.boundVoiceId).toBe('cloud-b');
    expect(ctx.activeCloudVoiceId).toBe('cloud-a');
    expect(ctx.speech).toEqual(edgeSettings);
  });

  it('激活档案被停用时按首个启用档案取绑定音色', () => {
    const ctx = speakContextFromConfig({
      llmProfiles: [
        { id: 'p1', enabled: false, boundVoiceId: 'cloud-a' },
        { id: 'p2', boundVoiceId: 'cloud-b' },
      ],
      llmActiveProfileId: 'p1',
    });
    expect(ctx.boundVoiceId).toBe('cloud-b');
  });

  it('无档案或配置为空时 boundVoiceId 为空', () => {
    expect(speakContextFromConfig(null).boundVoiceId).toBeUndefined();
    expect(speakContextFromConfig({}).boundVoiceId).toBeUndefined();
  });
});