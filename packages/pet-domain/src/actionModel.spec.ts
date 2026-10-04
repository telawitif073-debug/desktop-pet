import { describe, expect, it } from 'vitest';
import {
  ACTION_MODEL_SCHEMA_VERSION,
  DEFAULT_WEIGHTS,
  actionPayloadDirName,
  collectReferences,
  migrateActionModel,
  modelFromActions,
  validatePetActionModel,
  type PetActionLike,
  type PetActionModel,
  type PetActionSpec,
} from './actionModel';

const action = (partial: Partial<PetActionLike> & { name: string }): PetActionLike => ({
  id: partial.id ?? `a_${partial.name}`,
  kind: 'frames',
  frameFiles: ['/tmp/frame_000.png'],
  frameRate: 6,
  ...partial,
});

/** 最小合法模型（用于各校验用例做基线） */
function validModel(overrides: Partial<PetActionModel> = {}): PetActionModel {
  const base: PetActionModel = {
    schemaVersion: ACTION_MODEL_SCHEMA_VERSION,
    idle: ['待机'],
    interaction: { feed: ['吃饭'], rest: [], play: [] },
    clicks: [],
    drag: [],
    moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [] },
    categories: [{ id: '小动作', weight: 80, actions: ['伸懒腰'] }],
    events: { workStatus: ['思考', ['忙碌', '记录']] },
    weights: { ...DEFAULT_WEIGHTS },
    actions: {
      待机: { ref: '待机', frameRate: 6, loop: false, holdLeadSec: 0, holdTailSec: 0, interaction: 'none', priority: 0, noMirror: false },
      吃饭: { ref: '吃饭', frameRate: 8, loop: false, holdLeadSec: 0.5, holdTailSec: 0.5, interaction: 'feed', priority: 0, noMirror: false },
      伸懒腰: { ref: '伸懒腰', frameRate: 6, loop: false, holdLeadSec: 0, holdTailSec: 0, interaction: 'none', priority: 0, noMirror: false },
      思考: { ref: '思考', frameRate: 4, loop: true, holdLeadSec: 0, holdTailSec: 0, interaction: 'none', priority: 0, noMirror: false },
      忙碌: { ref: '忙碌', frameRate: 4, loop: true, holdLeadSec: 0, holdTailSec: 0, interaction: 'none', priority: 0, noMirror: false },
      记录: { ref: '记录', frameRate: 4, loop: true, holdLeadSec: 0, holdTailSec: 0, interaction: 'none', priority: 0, noMirror: false },
    },
  };
  return { ...base, ...overrides };
}

describe('动作配置标准 · 校验（不静默兜底）', () => {
  it('合法模型通过校验，且引用集合可枚举', () => {
    const model = validModel();
    expect(validatePetActionModel(model)).toEqual({ ok: true, errors: [] });
    expect(collectReferences(model)).toContain('忙碌');
  });

  it('schemaVersion 不对 → 报错', () => {
    const r = validatePetActionModel({ ...validModel(), schemaVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('schemaVersion');
  });

  it('动作名重复 → 报错（池内按名字引用，必须唯一）', () => {
    const model = validModel();
    model.actions['待机#2'] = { ...model.actions['待机'], ref: '待机' };
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('动作名重复');
  });

  it('帧率越界 / 负数停顿 / 非法 priority → 逐条报错', () => {
    const model = validModel();
    model.actions['待机'] = { ...model.actions['待机'], frameRate: 60, holdLeadSec: -1, priority: -2 };
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/frameRate/);
    expect(r.errors.join(' ')).toMatch(/holdLeadSec/);
    expect(r.errors.join(' ')).toMatch(/priority/);
  });

  it('权重合计 ≠ 100 → 报错（并给出当前合计）', () => {
    const model = validModel();
    model.categories = [{ id: '小动作', weight: 70, actions: ['伸懒腰'] }];
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('权重合计必须为 100');
    expect(r.errors.join(' ')).toContain('90');
  });

  it('池内引用了未定义的动作 → 报错（清单↔定义互校）', () => {
    const model = validModel();
    model.interaction.feed = ['不存在的动作'];
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('未定义的动作');
  });

  it('事件档位：空字符串 / 空数组 / 非法类型 → 报错', () => {
    const model = validModel();
    model.events = { bad: ['', [], 42 as unknown as string] };
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/空字符串|空候选数组|必须是字符串或字符串数组/);
  });

  it('互动池 / moves / categories 结构非法 → 报错', () => {
    const model = validModel();
    // @ts-expect-error 故意写坏结构，验证校验能挡住
    model.interaction.feed = 'not-an-array';
    // @ts-expect-error 同上
    model.moves = { default: { minDist: 100, maxDist: 10 } };
    // 重复 id / 负权重在类型上合法，属于语义错误 → 由校验器报出
    model.categories = [
      { id: 'x', weight: -5, actions: [] },
      { id: 'x', weight: 1, actions: ['待机'] },
    ];
    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    const joined = r.errors.join(' ');
    expect(joined).toMatch(/interaction\.feed/);
    expect(joined).toMatch(/minDist 不能大于 maxDist/);
    expect(joined).toMatch(/categories id 重复/);
  });

  it('非对象输入不抛错', () => {
    expect(validatePetActionModel(null).ok).toBe(false);
    expect(validatePetActionModel('nope').ok).toBe(false);
  });
});

describe('旧配置迁移（PetAction[] → schemaVersion 2）', () => {
  it('互动动作按 interaction 归池；历史同名动作按名字归池并留下说明', () => {
    const { model, notes } = modelFromActions([
      action({ name: '吃饭', interaction: 'feed' }),
      action({ name: '休息' }), // 未标 interaction，但名字是历史约定
      action({ name: '玩耍', interaction: 'play' }),
      action({ name: '自定义动作' }),
    ]);
    expect(model.interaction.feed).toEqual(['吃饭']);
    expect(model.interaction.rest).toEqual(['休息']);
    expect(model.interaction.play).toEqual(['玩耍']);
    expect(notes.join(' ')).toContain('按历史同名约定归入 rest 池');
    expect(model.actions['休息'].interaction).toBe('rest');
  });

  it('未标互动的动作进「手动上传」分类，且权重让合计仍为 100', () => {
    const { model } = modelFromActions([action({ name: '自定义A' }), action({ name: '自定义B' })]);
    expect(model.categories).toHaveLength(1);
    expect(model.categories[0]).toMatchObject({ id: '手动上传', actions: ['自定义A', '自定义B'] });
    const sum = model.weights.idle + model.weights.turn + model.weights.move + model.categories.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
  });

  it('没有手动动作时把权重余量并入 idle，仍然满足不变量', () => {
    const { model } = modelFromActions([action({ name: '吃饭', interaction: 'feed' })]);
    const sum = model.weights.idle + model.weights.turn + model.weights.move + model.categories.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
    expect(model.weights.idle).toBe(90);
  });

  it('clip 动作进 modelClips（模型内置动画，无帧序列），不占帧池', () => {
    const { model, notes } = modelFromActions([action({ name: '挥手', kind: 'clip', clipName: 'wave' })]);
    expect(model.modelClips).toEqual(['挥手']);
    expect(model.categories).toHaveLength(0);
    expect(notes.join(' ')).toContain('modelClips');
  });

  it('帧率被夹到 1~24；重复名只保留第一个并记说明', () => {
    const { model, notes } = modelFromActions([
      action({ name: '快', frameRate: 99 }),
      action({ name: '慢', frameRate: 0 }),
      action({ name: '重名' }),
      action({ name: '重名' }),
    ]);
    expect(model.actions['快'].frameRate).toBe(24);
    expect(model.actions['慢'].frameRate).toBe(1);
    expect(notes.join(' ')).toContain('动作名重复');
  });

  it('迁移产物本身必须通过校验（关键性质：迁移不会造出不合法配置）', () => {
    const { model } = modelFromActions([
      action({ name: '吃饭', interaction: 'feed' }),
      action({ name: '休息' }),
      action({ name: '玩耍', interaction: 'play' }),
      action({ name: '自定义' }),
      action({ name: '模型动画', kind: 'clip' }),
    ]);
    const r = validatePetActionModel(model);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('空动作列表：迁移不抛错，并提示将无可播互动动作', () => {
    const { model, notes } = modelFromActions([]);
    expect(model.idle).toEqual([]);
    expect(validatePetActionModel(model).ok).toBe(true);
    expect(notes.join(' ')).toContain('没有任何互动动作');
  });
});

describe('视频动作与 v2 → v3 迁移（schemaVersion 3）', () => {
  it('video 动作经 modelFromActions 记 kind=video 并带 videoFile，且模型合法', () => {
    const { model, notes } = modelFromActions([
      action({ name: '打招呼', kind: 'video', videoFile: 'clip.webm', frameFiles: undefined }),
    ]);
    const spec = model.actions['打招呼'];
    expect(spec.kind).toBe('video');
    expect(spec.videoFile).toBe('clip.webm');
    expect(validatePetActionModel(model).ok).toBe(true);
    expect(notes.join(' ')).toContain('kind=video');
  });

  it('video 动作缺 videoFile → 报错；帧率缺失本身不算错（视频自带帧率）', () => {
    const model = validModel();
    const spec: PetActionSpec = { ...model.actions['待机'], ref: '打招呼', kind: 'video' };
    delete spec.frameRate;
    model.actions['打招呼'] = spec;

    const r = validatePetActionModel(model);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('videoFile 是 video 动作的必填项');
    expect(r.errors.join(' ')).not.toContain('frameRate');
  });

  it('v2 模型仍被接受；migrateActionModel 补默认 kind（modelClips→clip、其余→frames）且幂等', () => {
    const v2 = { ...validModel(), schemaVersion: 2, modelClips: ['待机'] } as unknown as PetActionModel;
    for (const one of Object.values(v2.actions)) delete (one as { kind?: string }).kind;
    expect(validatePetActionModel(v2).ok).toBe(true);

    const migrated = migrateActionModel(v2) as PetActionModel;
    expect(migrated.schemaVersion).toBe(ACTION_MODEL_SCHEMA_VERSION);
    expect(migrated.actions['待机'].kind).toBe('clip');
    expect(migrated.actions['吃饭'].kind).toBe('frames');
    expect(validatePetActionModel(migrated).ok).toBe(true);
    // 纯函数：不改入参
    expect((v2.actions['待机'] as { kind?: string }).kind).toBeUndefined();
    // 幂等：已是当前版本直接原样返回
    expect(migrateActionModel(migrated)).toBe(migrated);
  });

  it('未知 schemaVersion 不被臆造迁移（交校验器拒绝）', () => {
    const weird = { ...validModel(), schemaVersion: 99 } as unknown as PetActionModel;
    expect(migrateActionModel(weird)).toBe(weird);
    expect(validatePetActionModel(weird).ok).toBe(false);
  });
});

describe('包内动作载荷目录名（发布 / 安装必须同口径）', () => {
  it('合法名字直接用作目录名（可读、去首尾空格）', () => {
    expect(actionPayloadDirName('wave')).toBe('wave');
    expect(actionPayloadDirName('吃饭')).toBe('吃饭');
    expect(actionPayloadDirName('  idle_01  ')).toBe('idle_01');
  });

  it('含非法字符 → 转义并追加原名哈希；不同原名不撞车且可复现', () => {
    const slash = actionPayloadDirName('a/b');
    expect(slash).not.toBe('a/b');
    expect(slash).toMatch(/^a_b~/);
    expect(actionPayloadDirName('a/b')).toBe(slash); // 确定性
    expect(actionPayloadDirName('a\\b')).not.toBe(slash); // 不同原名 → 不同目录
  });

  it('Windows 保留名与空名 → 兜底 action~hash（仍可复现）', () => {
    expect(actionPayloadDirName('CON')).toMatch(/^action~/);
    expect(actionPayloadDirName('   ')).toMatch(/^action~/);
  });
});
