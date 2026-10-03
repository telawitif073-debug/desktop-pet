import { describe, expect, it } from 'vitest';
import {
  UNBOUND_PROFILE_ID,
  activationBlockReason,
  createProfile,
  duplicateProfile,
  filterProfiles,
  inheritUnboundMessages,
  isProfileEnabled,
  nextActiveAfterDelete,
  profileAvatar,
  toggleBlockReason,
  withoutProfileMessages,
} from './studioProfiles';
import type { LlmProfile } from '../global.d';

function profile(over: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: 'p1',
    name: '医疗助手',
    apiKey: 'sk-a',
    baseUrl: 'https://api.test/v1',
    model: 'glm-4-flash',
    ...over,
  };
}

describe('studioProfiles 列表操作（T3）', () => {
  it('未绑定历史保留键与主进程约定一致（跨进程漂移哨兵）', () => {
    expect(UNBOUND_PROFILE_ID).toBe('__unbound__');
  });

  it('createProfile：空白 Key/模型、默认启用、未绑定形象，同毫秒创建也不会重 id', () => {
    const a = createProfile([], 1000);
    const b = createProfile([a], 1000);
    expect(a.apiKey).toBe('');
    expect(a.model).toBe('');
    expect(a.petAssetId).toBe('');
    expect(a.enabled).toBe(true);
    expect(a.name).toBe('智能体 1');
    expect(b.name).toBe('智能体 2');
    expect(a.id).not.toBe(b.id);
  });

  it('duplicateProfile：名称加副本、保留 Key/人设/绑定/专属音色，仅换新 id', () => {
    const source = profile({ petAssetId: 'pet-1', boundVoiceId: 'local-1', systemPrompt: '人设' });
    const copy = duplicateProfile(source, [source], 2000);
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('医疗助手 副本');
    expect(copy.apiKey).toBe('sk-a');
    expect(copy.systemPrompt).toBe('人设');
    expect(copy.petAssetId).toBe('pet-1');
    expect(copy.boundVoiceId).toBe('local-1');
  });

  it('filterProfiles：按名称/模型/角色/风格/标签命中，空查询返回全部', () => {
    const list = [
      profile({ id: 'a', name: '医疗助手', domainTags: ['医疗'] }),
      profile({ id: 'b', name: '训练师', model: 'deepseek-chat', role: '教练', style: '毒舌' }),
    ];
    expect(filterProfiles(list, '')).toHaveLength(2);
    expect(filterProfiles(list, '   ')).toHaveLength(2);
    expect(filterProfiles(list, '医疗').map((p) => p.id)).toEqual(['a']);
    expect(filterProfiles(list, 'DEEPSEEK').map((p) => p.id)).toEqual(['b']);
    expect(filterProfiles(list, '毒舌').map((p) => p.id)).toEqual(['b']);
    expect(filterProfiles(list, '教练').map((p) => p.id)).toEqual(['b']);
    expect(filterProfiles(list, '不存在')).toHaveLength(0);
  });

  it('profileAvatar：自定义头像优先，否则取名称首字符，空名回落 ?', () => {
    expect(profileAvatar(profile({ avatar: '🐱' }))).toBe('🐱');
    expect(profileAvatar(profile({ name: '医疗助手' }))).toBe('医');
    expect(profileAvatar(profile({ name: 'alice' }))).toBe('A');
    expect(profileAvatar(profile({ name: '' }))).toBe('?');
  });

  it('nextActiveAfterDelete：删除非激活项保持不变；删除激活项切到首个启用档案', () => {
    const remaining = [
      profile({ id: 'b', name: 'B', enabled: false }),
      profile({ id: 'c', name: 'C' }),
    ];
    expect(nextActiveAfterDelete(remaining, 'x', 'b')).toBe('b'); // 删的不是激活项
    expect(nextActiveAfterDelete(remaining, 'b', 'b')).toBe('c'); // 激活项被删 → 首个启用的
    expect(nextActiveAfterDelete([profile({ id: 'b', enabled: false })], 'b', 'b')).toBe('');
  });

  it('withoutProfileMessages：只移除目标档案并保持其他档案（不可变）', () => {
    const input = { a: [{ role: 'user' as const, content: 'A' }], b: [{ role: 'user' as const, content: 'B' }] };
    const next = withoutProfileMessages(input, 'a');
    expect(Object.keys(next)).toEqual(['b']);
    expect(Object.keys(input)).toEqual(['a', 'b']); // 原对象未被修改
    expect(withoutProfileMessages(undefined, 'a')).toEqual({});
  });
});

describe('studioProfiles 首个档案继承未绑定历史（T2 交接项）', () => {
  it('把 __unbound__ 历史搬进新档案并清空保留键', () => {
    const messages = {
      [UNBOUND_PROFILE_ID]: [
        { role: 'user' as const, content: '旧问题' },
        { role: 'assistant' as const, content: '旧回答' },
      ],
    };
    const result = inheritUnboundMessages(messages, 'p_new');
    expect(result.inherited).toBe(2);
    expect(result.messages.p_new).toHaveLength(2);
    expect(result.messages[UNBOUND_PROFILE_ID]).toBeUndefined();
    expect(messages[UNBOUND_PROFILE_ID]).toHaveLength(2); // 原对象未被修改
  });

  it('没有未绑定历史时不产生继承', () => {
    expect(inheritUnboundMessages(undefined, 'p_new')).toEqual({ messages: {}, inherited: 0 });
    expect(inheritUnboundMessages({}, 'p_new').inherited).toBe(0);
    expect(inheritUnboundMessages({ [UNBOUND_PROFILE_ID]: [] }, 'p_new').inherited).toBe(0);
  });

  it('目标档案已有历史时不覆盖', () => {
    const messages = {
      [UNBOUND_PROFILE_ID]: [{ role: 'user' as const, content: '旧' }],
      p_new: [{ role: 'user' as const, content: '已有' }],
    };
    const result = inheritUnboundMessages(messages, 'p_new');
    expect(result.inherited).toBe(0);
    expect(result.messages.p_new).toEqual([{ role: 'user', content: '已有' }]);
    expect(result.messages[UNBOUND_PROFILE_ID]).toHaveLength(1);
  });
});

describe('studioProfiles 切换与启停校验（T3）', () => {
  const state = { activeId: 'p1', installedPetId: 'pet-1', hasInstalledPet: true };

  it('已是当前对话对象 → 拦截', () => {
    expect(activationBlockReason(profile({ id: 'p1' }), state)).toContain('已是当前对话对象');
  });

  it('已停用 → 拦截，提示先启用', () => {
    expect(activationBlockReason(profile({ id: 'p2', enabled: false }), state)).toContain('已停用');
  });

  it('未绑定形象的档案跟随本机当前形象 → 放行（即使本机未安装商店形象）', () => {
    expect(activationBlockReason(profile({ id: 'p2' }), { ...state, hasInstalledPet: false })).toBeNull();
    expect(
      activationBlockReason(profile({ id: 'p2', petAssetId: '' }), { ...state, hasInstalledPet: false }),
    ).toBeNull();
  });

  it('绑定了形象但本机未安装 → 拦截并引导去商店', () => {
    expect(
      activationBlockReason(profile({ id: 'p2', petAssetId: 'pet-1' }), { ...state, hasInstalledPet: false }),
    ).toContain('资源商店');
  });

  it('绑定的形象不是本机当前形象 → 拦截并给出两条出路', () => {
    const reason = activationBlockReason(profile({ id: 'p2', petAssetId: 'pet-other' }), state);
    expect(reason).toContain('不是本机当前形象');
    expect(reason).toContain('改绑当前形象');
  });

  it('绑定形象与本机一致 → 允许', () => {
    expect(activationBlockReason(profile({ id: 'p2', petAssetId: 'pet-1' }), state)).toBeNull();
  });

  it('toggleBlockReason：可启用；停用激活项被拦截；停用非激活项放行', () => {
    expect(toggleBlockReason(profile({ id: 'p2', enabled: false }), 'p1')).toBeNull();
    expect(toggleBlockReason(profile({ id: 'p1' }), 'p1')).toContain('不能停用');
    expect(toggleBlockReason(profile({ id: 'p2' }), 'p1')).toBeNull();
  });

  it('isProfileEnabled：旧档缺字段视为启用，显式 false 为停用', () => {
    expect(isProfileEnabled(profile())).toBe(true);
    expect(isProfileEnabled(profile({ enabled: false }))).toBe(false);
  });
});