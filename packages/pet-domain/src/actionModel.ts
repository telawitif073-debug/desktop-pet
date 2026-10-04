/**
 * 宠物动作配置标准（schemaVersion 2）——纯逻辑，无 electron / 无 DOM / 无 IO
 * ---------------------------------------------------------------------------
 * 设计来源：参考项目 dsh-pet 的 `assets/config.jsonc`（分析见
 * `.trae/documents/pet-resource-system-refactor.md`）。要点逐条落到本项目：
 *   1. **语义化动作池**：待机（idle）/ 互动（feed·rest·play，对应右键喂食·休息·玩耍）/
 *      点击回应（clicks）/ 拖拽（drag）/ 移动（moves，默认参数 + 逐动作覆盖）/
 *      随机动作分类（categories，带权重）/ 事件档位（events，索引即档位，不进随机链）；
 *   2. **权重不变量**：`idle + turn + move + Σcategories[].weight === 100`，加载即校验；
 *   3. **名字即契约**：池内按**动作名**引用，且名字必须唯一、必须能在 `actions` 里找到
 *      （清单↔定义互校）——避免参考项目里「名字写错 → 点了没反应」的静默失败；
 *   4. **校验失败即报错**：不静默兜底；错误可枚举、可测试、可在 UI 上展示；
 *   5. **旧配置可无损迁移**：`PetAction[]`（kind/name/interaction/frameRate）→ 本模型，
 *      迁移规则显式写在这里，并被单测钉住。
 *
 * 与运行时（渲染端播放）的分工：本模块只描述「有什么动作、怎么分组、什么权重」；
 * 具体该播哪一个由 `src/shared/petPlayback.ts` 的纯决策函数决定。
 */

/** 与 src/main/config.ts 的 PetAction 结构兼容的最小形状（避免 shared 依赖主进程模块） */
export interface PetActionLike {
  id: string;
  name: string;
  /** 载体：帧序列 / 模型内置动画 clip / 视频文件（透明 webm 等） */
  kind: 'frames' | 'clip' | 'video';
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  frameRate?: number;
  frameFiles?: string[];
  clipName?: string;
  /** kind='video' 时的视频文件（透明 VP9 webm；由渲染端直接播放，不转帧序列） */
  videoFile?: string;
  petAssetId?: string;
  builtinPetId?: string;
}

export type PetInteraction = 'feed' | 'rest' | 'play';

export interface MoveParams {
  minDist: number;
  maxDist: number;
  margin: number;
  leadSec: number;
  tailSec: number;
}

export interface MoveSpec {
  name: string;
  params?: Partial<MoveParams>;
}

export interface ActionCategory {
  id: string;
  weight: number;
  /** 带文字/镜像会颠倒的动作：朝右（镜像）时不播该类 */
  noMirror?: boolean;
  actions: string[];
}

/** 事件档位：单个动作名（固定播）或候选数组（档内随机抽 1，尽量不连播同一个） */
export type EventSlot = string | string[];

export interface PetActionSpec {
  /** 动作名（= 池内引用键；必须唯一） */
  ref: string;
  /**
   * 载体种类（v3 起显式声明，缺省视为帧序列）：
   *  - `frames` 帧序列（frame_000.png…，由 frameRate 驱动）
   *  - `clip`   模型内置动画（Live2D/3D，按名字驱动）
   *  - `video`  视频文件（透明 webm；自带帧率，**不需要 frameRate**）
   */
  kind?: 'frames' | 'clip' | 'video';
  /** kind='video' 时的视频文件相对路径（必需项，见 validatePetActionModel） */
  videoFile?: string;
  /** 帧序列播放帧率；视频动作不需要（给了就要合法） */
  frameRate?: number;
  loop: boolean;
  /** 动作首尾原地停顿（秒）：移动/衔接类动作用来对齐位移与动画时长 */
  holdLeadSec: number;
  holdTailSec: number;
  interaction: 'none' | PetInteraction;
  /** 数值越大越优先（同一触发器下有多个候选时先按 priority 降序） */
  priority: number;
  noMirror: boolean;
  /** 模型内置动画 clip（Live2D/3D）：没有帧序列，按名字驱动 */
  clip?: boolean;
}

export interface PetActionModel {
  schemaVersion: typeof ACTION_MODEL_SCHEMA_VERSION;
  idle: string[];
  interaction: Record<PetInteraction, string[]>;
  clicks: string[];
  drag: string[];
  moves: { default: MoveParams; actions: MoveSpec[] };
  categories: ActionCategory[];
  events: Record<string, EventSlot[]>;
  weights: { idle: number; turn: number; move: number };
  actions: Record<string, PetActionSpec>;
  /** 模型内置动画（Live2D/3D clip）：按名字驱动，无帧序列 */
  modelClips?: string[];
}

export const ACTION_MODEL_SCHEMA_VERSION = 3 as const;
/** 仍被接受的旧版本（加载时应先过 {@link migrateActionModel}） */
export const ACTION_MODEL_SUPPORTED_SCHEMAS: readonly number[] = [2, ACTION_MODEL_SCHEMA_VERSION];
export const WEIGHT_TOTAL = 100;
export const FRAME_RATE_RANGE: [number, number] = [1, 24];
export const DEFAULT_MOVE_PARAMS: MoveParams = { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 };
export const DEFAULT_WEIGHTS = { idle: 10, turn: 5, move: 5 };

/** 历史约定：右键「喂食/休息/玩耍」在未绑定时回退到同名动作 —— 迁移时按此归池 */
export const INTERACTION_LABELS: Record<PetInteraction, string> = { feed: '吃饭', rest: '休息', play: '玩耍' };

// ---------------------------------------------------------------------------
// 包内动作载荷布局（发布端写入 / 安装端读取，必须同口径）
// ---------------------------------------------------------------------------
/** 包内动作载荷目录（帧图 / 视频） */
export const ACTION_PAYLOAD_DIR = 'pet/actions';
/** 包内动作清单文件（{@link PetActionModel} 的 JSON 快照） */
export const ACTION_PAYLOAD_MANIFEST = 'pet/actions.json';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** FNV-1a 32bit → 8 位十六进制（纯函数，跨端可复现） */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 动作名 → 包内载荷目录名（`pet/actions/<dir>/`，帧图 `frame_000.png…`、视频 `clip.webm`）。
 * 发布端写入、安装端读取都用它，因此必须**确定性**且**不撞车**：
 * 名字本身合法时直接用（可读）；需要转义或是 Windows 保留名时追加原名哈希，
 * 保证「不同动作名 → 不同目录」，安装端才能只凭动作名找回帧图（无需在清单里写路径）。
 */
export function actionPayloadDirName(actionName: string): string {
  const name = String(actionName ?? '').trim();
  const sanitized = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 40);
  const usable = sanitized && !WINDOWS_RESERVED.test(sanitized) ? sanitized : '';
  return usable === name && usable ? usable : `${usable || 'action'}~${shortHash(name)}`;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 旧模型迁移到当前 schemaVersion（**纯函数，不修改入参**）。
 * v2 → v3 只有一处变化：动作规格新增 `kind`（载体种类）与 `videoFile`（视频动作的文件）。
 * 因此迁移只需按既有信息补默认 `kind`：
 *  - 已登记在 `modelClips` 里的名字 → `'clip'`（模型内置动画）
 *  - 其余 → `'frames'`（帧序列）
 * 已带 `kind` 的规格原样保留，故对 v3 数据是幂等的；未知版本不臆造，交给校验器报错。
 */
export function migrateActionModel(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const m = raw as Partial<PetActionModel>;
  if (m.schemaVersion === ACTION_MODEL_SCHEMA_VERSION) return raw;
  if (m.schemaVersion !== 2) return raw;
  const clips = new Set(Array.isArray(m.modelClips) ? m.modelClips : []);
  const actions: Record<string, PetActionSpec> = {};
  for (const [key, spec] of Object.entries(m.actions ?? {})) {
    actions[key] =
      spec && typeof spec === 'object'
        ? { kind: clips.has(key) ? 'clip' : 'frames', ...spec }
        : (spec as PetActionSpec);
  }
  return { ...m, schemaVersion: ACTION_MODEL_SCHEMA_VERSION, actions };
}

/** 校验动作名在所有池中的引用是否存在、是否重复（清单↔定义互校）。
 *  对外防御：任何字段结构异常都不能抛错（校验器要先能安全地描述"哪里坏了"）。 */
export function collectReferences(model: Partial<PetActionModel> | null | undefined): string[] {
  if (!model || typeof model !== 'object') return [];
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isNonEmptyString) : []);
  const refs: string[] = [
    ...list(model.idle),
    ...list(model.interaction?.feed),
    ...list(model.interaction?.rest),
    ...list(model.interaction?.play),
    ...list(model.clicks),
    ...list(model.drag),
    ...list((model.moves?.actions ?? []).map((m) => m?.name)),
    ...(Array.isArray(model.categories) ? model.categories.flatMap((c) => list(c?.actions)) : []),
  ];
  for (const slots of Object.values(model.events ?? {})) {
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) refs.push(...(Array.isArray(slot) ? list(slot) : list([slot])));
  }
  return refs;
}

/**
 * 严格校验：任何缺失/非法都进 errors，**不做静默修正**。
 * 校验项对应用户可感知的失败模式：名字写错（点了没反应）、权重写错（概率失真）、
 * 帧率非法（播放速度异常）、事件档位错位（状态含义错乱）。
 */
export function validatePetActionModel(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['配置不是对象'] };
  const m = raw as Partial<PetActionModel>;

  if (typeof m.schemaVersion !== 'number' || !ACTION_MODEL_SUPPORTED_SCHEMAS.includes(m.schemaVersion)) {
    errors.push(
      `schemaVersion 必须是 ${ACTION_MODEL_SUPPORTED_SCHEMAS.join(' 或 ')}（当前 ${String(m.schemaVersion)}）`,
    );
  }

  const actions = m.actions;
  if (!actions || typeof actions !== 'object') {
    errors.push('缺少 actions 定义表');
  } else {
    // 注意：actions 为空对象是**合法**状态（新装用户还没有任何动作），
    // 只要池里不引用任何名字即可；resolvePlayback 会以 no-action 明确表达"无可播动作"。
    const names = Object.keys(actions);
    void names;
    for (const [key, spec] of Object.entries(actions)) {
      if (!spec || typeof spec !== 'object') {
        errors.push(`actions["${key}"] 不是对象`);
        continue;
      }
      const s = spec as Partial<PetActionSpec>;
      if (s.ref !== key) errors.push(`actions["${key}"].ref 必须与键一致（当前 ${String(s.ref)}）`);
      if (s.kind !== undefined && s.kind !== 'frames' && s.kind !== 'clip' && s.kind !== 'video') {
        errors.push(`actions["${key}"].kind 非法（${String(s.kind)}，只能是 frames/clip/video）`);
      }
      const frameRateBad =
        !isFiniteNumber(s.frameRate) || s.frameRate < FRAME_RATE_RANGE[0] || s.frameRate > FRAME_RATE_RANGE[1];
      if (s.kind === 'video') {
        // 视频动作：必须给出视频文件；帧率由视频自带，可省（给了就要合法）
        if (!isNonEmptyString(s.videoFile)) errors.push(`actions["${key}"].videoFile 是 video 动作的必填项`);
        if (s.frameRate !== undefined && frameRateBad) {
          errors.push(`actions["${key}"].frameRate 必须在 ${FRAME_RATE_RANGE[0]}~${FRAME_RATE_RANGE[1]} 之间`);
        }
      } else if (frameRateBad) {
        errors.push(`actions["${key}"].frameRate 必须在 ${FRAME_RATE_RANGE[0]}~${FRAME_RATE_RANGE[1]} 之间`);
      }
      if (typeof s.loop !== 'boolean') errors.push(`actions["${key}"].loop 必须是布尔`);
      for (const field of ['holdLeadSec', 'holdTailSec'] as const) {
        if (!isFiniteNumber(s[field]) || (s[field] as number) < 0) errors.push(`actions["${key}"].${field} 必须是非负数`);
      }
      if (s.interaction !== 'none' && s.interaction !== 'feed' && s.interaction !== 'rest' && s.interaction !== 'play') {
        errors.push(`actions["${key}"].interaction 非法（${String(s.interaction)}）`);
      }
      if (!Number.isInteger(s.priority) || (s.priority as number) < 0) errors.push(`actions["${key}"].priority 必须是非负整数`);
      if (typeof s.noMirror !== 'boolean') errors.push(`actions["${key}"].noMirror 必须是布尔`);
    }
    const dupes = new Set<string>();
    const seen = new Set<string>();
    for (const spec of Object.values(actions)) {
      const ref = (spec as PetActionSpec | undefined)?.ref;
      if (typeof ref === 'string') {
        if (seen.has(ref)) dupes.add(ref);
        seen.add(ref);
      }
    }
    if (dupes.size) errors.push(`动作名重复：${[...dupes].join('、')}（池内按名字引用，必须唯一）`);
  }

  for (const pool of ['idle', 'clicks', 'drag'] as const) {
    const value = m[pool];
    if (!Array.isArray(value)) errors.push(`${pool} 必须是数组`);
    else if (value.some((v) => !isNonEmptyString(v))) errors.push(`${pool} 含非法条目`);
  }
  if (!m.interaction || typeof m.interaction !== 'object') {
    errors.push('缺少 interaction 池');
  } else {
    for (const kind of ['feed', 'rest', 'play'] as const) {
      const pool = m.interaction[kind];
      if (!Array.isArray(pool)) errors.push(`interaction.${kind} 必须是数组`);
      else if (pool.some((v) => !isNonEmptyString(v))) errors.push(`interaction.${kind} 含非法条目`);
    }
  }

  if (!m.moves || typeof m.moves !== 'object') {
    errors.push('缺少 moves');
  } else {
    const def = m.moves.default as Partial<MoveParams> | undefined;
    if (!def || typeof def !== 'object') errors.push('moves.default 缺失');
    else {
      for (const field of ['minDist', 'maxDist', 'margin', 'leadSec', 'tailSec'] as const) {
        if (!isFiniteNumber(def[field]) || (def[field] as number) < 0) errors.push(`moves.default.${field} 必须是非负数`);
      }
      if (isFiniteNumber(def.minDist) && isFiniteNumber(def.maxDist) && def.minDist > def.maxDist) {
        errors.push('moves.default.minDist 不能大于 maxDist');
      }
    }
    if (!Array.isArray(m.moves.actions)) errors.push('moves.actions 必须是数组');
    else if (m.moves.actions.some((a) => !a || !isNonEmptyString(a.name))) errors.push('moves.actions 含非法条目');
  }

  if (!Array.isArray(m.categories)) {
    errors.push('categories 必须是数组');
  } else {
    const ids = new Set<string>();
    for (const c of m.categories) {
      if (!c || !isNonEmptyString(c.id)) {
        errors.push('categories 含缺 id 的条目');
        continue;
      }
      if (ids.has(c.id)) errors.push(`categories id 重复：${c.id}`);
      ids.add(c.id);
      if (!isFiniteNumber(c.weight) || c.weight < 0) errors.push(`categories["${c.id}"].weight 必须是非负数`);
      if (!Array.isArray(c.actions) || c.actions.some((a) => !isNonEmptyString(a))) errors.push(`categories["${c.id}"].actions 非法`);
      if (c.noMirror !== undefined && typeof c.noMirror !== 'boolean') errors.push(`categories["${c.id}"].noMirror 必须是布尔`);
    }
  }

  if (!m.events || typeof m.events !== 'object') {
    errors.push('缺少 events');
  } else {
    for (const [name, pool] of Object.entries(m.events)) {
      if (!Array.isArray(pool)) {
        errors.push(`events["${name}"] 必须是档位数组`);
        continue;
      }
      pool.forEach((slot, index) => {
        if (typeof slot === 'string') {
          if (!isNonEmptyString(slot)) errors.push(`events["${name}"][${index}] 空字符串非法`);
        } else if (Array.isArray(slot)) {
          if (slot.length === 0) errors.push(`events["${name}"][${index}] 空候选数组非法`);
          else if (slot.some((s) => !isNonEmptyString(s))) errors.push(`events["${name}"][${index}] 含非法候选`);
        } else {
          errors.push(`events["${name}"][${index}] 必须是字符串或字符串数组`);
        }
      });
    }
  }

  if (!m.weights || typeof m.weights !== 'object') {
    errors.push('缺少 weights');
  } else {
    for (const key of ['idle', 'turn', 'move'] as const) {
      if (!isFiniteNumber(m.weights[key]) || m.weights[key] < 0) errors.push(`weights.${key} 必须是非负数`);
    }
  }

  // 权重不变量：仅在两侧都合法时检查，避免重复报错
  const weightsOk = m.weights && ['idle', 'turn', 'move'].every((k) => isFiniteNumber((m.weights as never)[k]));
  const catsOk = Array.isArray(m.categories) && m.categories.every((c) => c && isFiniteNumber(c.weight));
  if (weightsOk && catsOk) {
    const sum =
      (m.weights as { idle: number; turn: number; move: number }).idle +
      (m.weights as { idle: number; turn: number; move: number }).turn +
      (m.weights as { idle: number; turn: number; move: number }).move +
      (m.categories as ActionCategory[]).reduce((s, c) => s + c.weight, 0);
    if (sum !== WEIGHT_TOTAL) {
      errors.push(`权重合计必须为 ${WEIGHT_TOTAL}（idle+turn+move+Σcategories），当前 ${sum}`);
    }
  }

  // 清单↔定义互校（放在最后：确保 actions 结构已确认合法；actions 为空对象时仍需检查，
  // 因为「池里写了名字但定义表是空的」正是最典型的配置错误）
  if (actions && typeof actions === 'object') {
    const known = new Set(Object.keys(actions));
    const missing = [...new Set(collectReferences(raw as PetActionModel))].filter((ref) => !known.has(ref));
    if (missing.length) errors.push(`池内引用了未定义的动作：${missing.join('、')}`);
  }

  return { ok: errors.length === 0, errors };
}

const clampFrameRate = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 6;
  return Math.min(FRAME_RATE_RANGE[1], Math.max(FRAME_RATE_RANGE[0], Math.round(n * 10) / 10));
};

/**
 * 由现有动作列表构建标准模型（同时用于旧配置迁移）。
 * 迁移规则（显式、可测）：
 *   - `interaction` 为 feed/rest/play → 进对应互动池；
 *   - 未标 interaction 但名字是历史约定（吃饭/休息/玩耍）→ 按名字归池（保留旧「同名回退」语义，
 *     但把它变成显式配置，而不是运行期猜测）；
 *   - `kind === 'clip'` → 记入 `modelClips`（模型内置动画，按名字驱动）；
 *   - 其余动作 → 单个分类「手动上传」，权重 = 100 − 默认三档之和（保证不变量成立）。
 */
export function modelFromActions(
  actions: PetActionLike[],
  options: { weights?: PetActionModel['weights']; now?: number } = {},
): { model: PetActionModel; notes: string[] } {
  const notes: string[] = [];
  const weights = options.weights ?? { ...DEFAULT_WEIGHTS };
  const actionsMap: Record<string, PetActionSpec> = {};
  const pools: PetActionModel = {
    schemaVersion: ACTION_MODEL_SCHEMA_VERSION,
    idle: [],
    interaction: { feed: [], rest: [], play: [] },
    clicks: [],
    drag: [],
    moves: { default: { ...DEFAULT_MOVE_PARAMS }, actions: [] },
    categories: [],
    events: {},
    weights,
    actions: actionsMap,
  };
  const manual: string[] = [];
  const clips: string[] = [];

  const nameToInteraction = new Map<string, PetInteraction>(
    (Object.entries(INTERACTION_LABELS) as Array<[PetInteraction, string]>).map(([kind, label]) => [label, kind]),
  );

  for (const action of actions) {
    if (!action || !isNonEmptyString(action.name)) {
      notes.push(`跳过无名动作（id=${String(action?.id)}）`);
      continue;
    }
    if (actionsMap[action.name]) {
      notes.push(`动作名重复，后一个被跳过：${action.name}`);
      continue;
    }
    if (action.kind === 'clip') {
      clips.push(action.name);
      notes.push(`模型 clip 动作「${action.name}」记入 modelClips（无帧序列）`);
      continue;
    }
    const declared: 'none' | PetInteraction =
      action.interaction && action.interaction !== 'none' ? action.interaction : 'none';
    const byName = declared === 'none' ? nameToInteraction.get(action.name) : undefined;
    const interaction: 'none' | PetInteraction = declared === 'none' ? (byName ?? 'none') : declared;
    if (byName) {
      notes.push(`动作「${action.name}」未标互动，按历史同名约定归入 ${byName} 池`);
    }
    const isVideo = action.kind === 'video';
    if (isVideo) {
      notes.push(`视频动作「${action.name}」记为 kind=video（直接播视频，无帧序列）`);
    }
    actionsMap[action.name] = {
      ref: action.name,
      // 视频动作自带帧率，此值不参与播放；给个合规默认即可（仍受 FRAME_RATE_RANGE 校验）
      frameRate: clampFrameRate(action.frameRate),
      kind: isVideo ? 'video' : 'frames',
      ...(isVideo && isNonEmptyString(action.videoFile) ? { videoFile: action.videoFile } : {}),
      loop: false,
      holdLeadSec: 0.35,
      holdTailSec: 0.35,
      interaction,
      priority: 0,
      noMirror: false,
    };
    if (interaction === 'none') manual.push(action.name);
    else pools.interaction[interaction].push(action.name);
  }

  if (clips.length) pools.modelClips = clips;
  if (manual.length) {
    const weight = Math.max(0, WEIGHT_TOTAL - weights.idle - weights.turn - weights.move);
    pools.categories.push({ id: '手动上传', weight, actions: manual });
    notes.push(`未标互动的动作 ${manual.length} 个 → 分类「手动上传」（权重 ${weight}）`);
  } else {
    // 没有手动动作时，把余量并入 idle，保证权重合计仍为 100
    const rest = WEIGHT_TOTAL - weights.idle - weights.turn - weights.move;
    if (rest > 0) {
      pools.weights = { idle: weights.idle + rest, turn: weights.turn, move: weights.move };
      notes.push(`无未标互动动作，把权重余量 ${rest} 并入 idle 以保证合计 100`);
    }
  }
  if (!pools.interaction.feed.length && !pools.interaction.rest.length && !pools.interaction.play.length) {
    notes.push('没有任何互动动作（右键喂食/休息/玩耍将无可播动作）');
  }
  return { model: pools, notes };
}

/** 便捷判断：该名字是否属于某个互动池（供 UI 标注用） */
export function interactionOf(model: PetActionModel, name: string): 'none' | PetInteraction {
  return model.actions[name]?.interaction ?? 'none';
}
