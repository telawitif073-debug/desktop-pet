/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物动作播放决策（纯函数，无 electron / 无 DOM / 无 IO）
 * ---------------------------------------------------------------------------
 * 设计来源：参考项目 dsh-pet 的 `src/shared/pickers.ts` + `src/host/anim.ts`
 * （分析见 `.trae/documents/pet-resource-system-refactor.md`）。核心思想：
 *   1. **决策与渲染分离**：谁该播、播哪一个是纯函数，可离线单测；
 *   2. **不连播**：同一池内优先排除「当前正在播的动作」，排除后池空则退回原池
 *      （宁可重复，也不要返回 undefined —— 避免"点了没反应"）；
 *   3. **镜像门控**：`noMirror` 分类在宠物朝右（镜像）时整类排除，剩余权重重新归一化；
 *   4. **显式失败原因**：`unknown-action` / `unknown-event` / `tier-out-of-range` / `no-action`，
 *      调用方可据此提示或记录，而不是静默什么都不播；
 *   5. **档位轮换**：长时事件（如工作状态）在同一档位有多个候选时，播完自动换下一个候选。
 *
 * 优先级（从高到低）：显式点播 → 事件档位 → 互动（喂食/休息/玩耍）→ 点击回应 → 拖拽 → 随机链。
 * 说明：显式点播（右键菜单「播放」按钮）由调用方直接播 id，不经本模块；
 * 本模块处理的是「按语义触发」的路径。
 */
import type { ActionCategory, EventSlot, PetActionModel, PetInteraction } from './actionModel';
import { modelFromActions, type PetActionLike } from './actionModel';

/** 可注入随机源（[0,1)）；默认 Math.random，测试注入固定序列 */
export type Rng = () => number;

export type PlaybackTrigger = 'explicit' | 'event' | PetInteraction | 'click' | 'drag' | 'random';

export type PlaybackFailure =
  | 'unknown-action'
  | 'unknown-event'
  | 'tier-out-of-range'
  | 'no-action'
  | 'all-filtered';

export interface PlaybackRequest {
  trigger: PlaybackTrigger;
  /** trigger==='explicit' 时给动作名（按名字引用，与池内一致） */
  actionName?: string;
  /** trigger==='event' 时给事件名与档位（缺省档位 0） */
  eventName?: string;
  tier?: number;
  /** 当前正在播的动作名（用于不连播） */
  currentAction?: string;
  /** 宠物朝向：'right' = 镜像，`noMirror` 内容会被排除 */
  facing?: 'left' | 'right';
  /** 宠物固定：随机链不抽「转向/移动」两档（份额自然并入随机动作分类） */
  fixed?: boolean;
}

export interface PlaybackDecision {
  ok: boolean;
  /** 命中后要播的动作名（与 model.actions 的键一致） */
  actionName?: string;
  /** 命中的池/来源，便于日志与诊断 */
  pool?: string;
  reason?: PlaybackFailure;
  evidence: string[];
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** 从池中等概率抽一个；优先排除 exclude；排除后为空则退回原池（宁可重复也不返回 null） */
export function pickFromPool(pool: string[], exclude: string | undefined, rng: Rng): string | null {
  const candidates = pool.filter(isNonEmpty);
  if (!candidates.length) return null;
  const filtered = exclude ? candidates.filter((n) => n !== exclude) : candidates;
  const src = filtered.length ? filtered : candidates;
  const index = Math.min(src.length - 1, Math.max(0, Math.floor(rng() * src.length)));
  return src[index];
}

/** 事件档位取值：字符串槽位原样返回；数组槽位随机抽 1 并尽量避开 exclude */
export function pickSlot(slot: EventSlot, exclude: string | undefined, rng: Rng): string | null {
  if (typeof slot === 'string') return isNonEmpty(slot) ? slot : null;
  const candidates = slot.filter(isNonEmpty);
  if (!candidates.length) return null;
  const filtered = exclude ? candidates.filter((n) => n !== exclude) : candidates;
  const src = filtered.length ? filtered : candidates;
  const index = Math.min(src.length - 1, Math.max(0, Math.floor(rng() * src.length)));
  return src[index];
}

/** 该动作名是否属于 noMirror 分类（朝右时不应播） */
export function isNoMirrorAction(model: PetActionModel, actionName: string): boolean {
  if (model.actions[actionName]?.noMirror) return true;
  return model.categories.some((c) => c.noMirror === true && c.actions.includes(actionName));
}

/** 按权重抽一个分类；noMirror 分类在镜像时被排除，剩余权重重新归一化 */
export function pickWeightedCategory(categories: ActionCategory[], facing: 'left' | 'right', rng: Rng): ActionCategory | null {
  const usable = (categories ?? []).filter((c) => c && c.actions.some(isNonEmpty));
  if (!usable.length) return null;
  const filtered = facing === 'right' ? usable.filter((c) => c.noMirror !== true) : usable;
  const eligible = filtered.length ? filtered : usable;
  const total = eligible.reduce((s, c) => s + Math.max(0, c.weight), 0);
  if (total <= 0) return eligible[Math.min(eligible.length - 1, Math.max(0, Math.floor(rng() * eligible.length)))];
  let t = rng() * total;
  for (const c of eligible) {
    t -= Math.max(0, c.weight);
    if (t <= 0) return c;
  }
  return eligible[eligible.length - 1];
}

/** 随机链掷骰：idle / turn / move / action（fixed 时 turn/move 权重按 0 算，不归一化） */
export function rollKind(roll: number, weights: PetActionModel['weights'], opts: { fixed?: boolean } = {}): 'idle' | 'turn' | 'move' | 'action' {
  const turn = opts.fixed ? 0 : weights.turn;
  const move = opts.fixed ? 0 : weights.move;
  const top = weights.idle + turn + move;
  if (roll < weights.idle / 100) return 'idle';
  if (roll < (weights.idle + turn) / 100) return 'turn';
  if (roll < top / 100) return 'move';
  return 'action';
}

/** 长时事件档内轮换：多候选档位返回「不同于当前」的候选；单候选/不属于该池返回 null */
export function nextEventAnim(pool: EventSlot[] | undefined, current: string | undefined, rng: Rng): string | null {
  if (!pool?.length) return null;
  const index = pool.findIndex((slot) =>
    typeof slot === 'string' ? slot === current : Array.isArray(slot) && current !== undefined && slot.includes(current),
  );
  if (index === -1) return null;
  const slot = pool[index];
  if (typeof slot === 'string') return null;
  if (slot.length <= 1) return null;
  return pickSlot(slot, current, rng);
}

/**
 * 解析一次触发应播哪个动作。纯函数：同输入 + 同随机源 → 同结果。
 * 失败一律给出可枚举原因，绝不静默返回"什么都不播"。
 */
export function resolvePlayback(request: PlaybackRequest, model: PetActionModel, rng: Rng = Math.random): PlaybackDecision {
  const evidence: string[] = [];
  const facing = request.facing ?? 'left';

  // 1) 显式点播（按名字）
  if (request.trigger === 'explicit') {
    const name = request.actionName?.trim();
    if (!name) return { ok: false, reason: 'unknown-action', evidence: ['显式点播未给动作名'] };
    if (!model.actions[name] && !(model.modelClips ?? []).includes(name)) {
      return { ok: false, reason: 'unknown-action', evidence: [`动作「${name}」不在模型中（清单↔定义互校失败）`] };
    }
    if (facing === 'right' && isNoMirrorAction(model, name)) {
      return { ok: false, reason: 'all-filtered', evidence: [`动作「${name}」属于 noMirror 内容，镜像时不播`] };
    }
    return { ok: true, actionName: name, pool: 'explicit', evidence: ['显式点播'] };
  }

  // 2) 事件档位
  if (request.trigger === 'event') {
    const name = request.eventName?.trim();
    if (!name) return { ok: false, reason: 'unknown-event', evidence: ['事件触发未给事件名'] };
    const pool = model.events?.[name];
    if (!pool?.length) return { ok: false, reason: 'unknown-event', evidence: [`事件「${name}」没有配置档位`] };
    const tier = Math.max(0, Math.trunc(request.tier ?? 0));
    if (tier >= pool.length) {
      return { ok: false, reason: 'tier-out-of-range', evidence: [`事件「${name}」档位 ${tier} 超出范围（共 ${pool.length} 档）`] };
    }
    const picked = pickSlot(pool[tier], request.currentAction, rng);
    if (!picked) return { ok: false, reason: 'no-action', evidence: [`事件「${name}」档位 ${tier} 为空`] };
    if (facing === 'right' && isNoMirrorAction(model, picked)) {
      evidence.push(`档位候选「${picked}」属 noMirror，镜像时跳过`);
      return { ok: false, reason: 'all-filtered', evidence };
    }
    return { ok: true, actionName: picked, pool: `event:${name}[${tier}]`, evidence: [`事件档位命中（${pool.length} 档）`] };
  }

  // 3) 互动 / 点击 / 拖拽：池内不连播
  if (request.trigger === 'feed' || request.trigger === 'rest' || request.trigger === 'play') {
    const pool = model.interaction?.[request.trigger] ?? [];
    const picked = pickFromPool(pool, request.currentAction, rng);
    if (!picked) return { ok: false, reason: 'no-action', evidence: [`互动池 ${request.trigger} 为空`] };
    return { ok: true, actionName: picked, pool: `interaction:${request.trigger}`, evidence: ['互动池命中（已避开当前动作）'] };
  }
  if (request.trigger === 'click' || request.trigger === 'drag') {
    const pool = request.trigger === 'click' ? model.clicks ?? [] : model.drag ?? [];
    const picked = pickFromPool(pool, request.currentAction, rng);
    if (!picked) return { ok: false, reason: 'no-action', evidence: [`${request.trigger} 池为空`] };
    return { ok: true, actionName: picked, pool: request.trigger, evidence: ['输入触发池命中'] };
  }

  // 4) 随机链：idle / turn / move / 加权分类
  const kind = rollKind(rng(), model.weights, { fixed: request.fixed });
  evidence.push(`随机链掷骰结果：${kind}${request.fixed ? '（宠物固定：turn/move 权重按 0 算）' : ''}`);
  if (kind === 'idle') {
    const picked = pickFromPool(model.idle ?? [], request.currentAction, rng);
    if (!picked) {
      // idle 为空时退回随机动作分类（而不是什么都不播）
      const fallback = pickWeightedCategory(model.categories ?? [], facing, rng);
      const fromCat = fallback ? pickFromPool(fallback.actions, request.currentAction, rng) : null;
      if (fromCat) return { ok: true, actionName: fromCat, pool: `category:${fallback?.id}`, evidence: [...evidence, 'idle 池为空 → 退回随机动作分类'] };
      return { ok: false, reason: 'no-action', evidence: [...evidence, 'idle 池与随机动作分类都为空'] };
    }
    return { ok: true, actionName: picked, pool: 'idle', evidence };
  }
  if (kind === 'turn') {
    // 本项目暂未把「转向」单独建池：转向动作按惯例放在 idle/分类里；此处退回分类，避免静默不播
    const cat = pickWeightedCategory(model.categories ?? [], facing, rng);
    const picked = cat ? pickFromPool(cat.actions, request.currentAction, rng) : null;
    if (picked) return { ok: true, actionName: picked, pool: `category:${cat?.id}`, evidence: [...evidence, '未单独配置 turn 池 → 走随机动作分类'] };
    const idlePick = pickFromPool(model.idle ?? [], request.currentAction, rng);
    if (idlePick) return { ok: true, actionName: idlePick, pool: 'idle', evidence: [...evidence, 'turn 无候选 → 退回 idle'] };
    return { ok: false, reason: 'no-action', evidence: [...evidence, 'turn 无任何候选'] };
  }
  if (kind === 'move') {
    const moveNames = (model.moves?.actions ?? []).map((m) => m.name).filter(isNonEmpty);
    const picked = pickFromPool(moveNames, request.currentAction, rng);
    if (picked) return { ok: true, actionName: picked, pool: 'move', evidence };
    const idlePick = pickFromPool(model.idle ?? [], request.currentAction, rng);
    if (idlePick) return { ok: true, actionName: idlePick, pool: 'idle', evidence: [...evidence, 'moves.actions 为空 → 退回 idle'] };
    return { ok: false, reason: 'no-action', evidence: [...evidence, 'moves.actions 与 idle 都为空'] };
  }

  const category = pickWeightedCategory(model.categories ?? [], facing, rng);
  if (!category) return { ok: false, reason: 'no-action', evidence: [...evidence, '没有可用的随机动作分类'] };
  const picked = pickFromPool(category.actions, request.currentAction, rng);
  if (!picked) return { ok: false, reason: 'no-action', evidence: [...evidence, `分类「${category.id}」为空`] };
  return { ok: true, actionName: picked, pool: `category:${category.id}`, evidence };
}

/** 移动参数：默认值 + 逐动作覆盖（与参考项目 moves.default/actions 同构） */
export function moveParamsFor(model: PetActionModel, actionName: string): { minDist: number; maxDist: number; margin: number; leadSec: number; tailSec: number } {
  const base = model.moves?.default ?? { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 };
  const override = model.moves?.actions?.find((m) => m.name === actionName)?.params ?? {};
  return { ...base, ...override };
}

/** 首尾停顿（秒）：播放/位移调度用；缺省 0 */
export function holdSecondsFor(model: PetActionModel, actionName: string): { lead: number; tail: number } {
  const spec = model.actions[actionName];
  return { lead: Math.max(0, spec?.holdLeadSec ?? 0), tail: Math.max(0, spec?.holdTailSec ?? 0) };
}

/**
 * 互动触发（喂食/休息/玩耍）的完整解析，供渲染端直接调用：
 *   1. **绑定优先**：`petActionBindings[kind]` 指向的动作若存在且可播 → 直接用它
 *      （保留既有「用户显式绑定」语义，绝不因为重构而失效）；
 *   2. 否则按**标准模型**的互动池选（不连播当前动作），池内为空则给出显式原因。
 * 返回 actionId（渲染端播放用）与 actionName（诊断用）。
 */
export function resolveInteractionTrigger(args: {
  kind: PetInteraction;
  /** config.petActionBindings[kind] */
  boundActionId?: string;
  actions: PetActionLike[];
  /** 当前正在播的动作名（不连播） */
  currentActionName?: string;
  /** 显式配置的标准模型；缺省则由 actions 现场构建（迁移规则一致） */
  model?: PetActionModel;
  rng?: Rng;
}): { ok: boolean; actionId?: string; actionName?: string; pool?: string; reason?: PlaybackFailure; evidence: string[] } {
  const { kind, boundActionId, actions } = args;
  // 可播判定必须涵盖三种载体：clip 看 clipName、video 看 videoFile、frames 看帧文件。
  // （漏掉 video 会让「绑定到视频动作」的互动判定成「无可播资源」而莫名回退到池子。）
  const playable = (a: PetActionLike): boolean =>
    a.kind === 'clip' ? !!a.clipName : a.kind === 'video' ? !!a.videoFile : (a.frameFiles?.length ?? 0) > 0;

  if (boundActionId) {
    const bound = actions.find((a) => a.id === boundActionId);
    if (bound && playable(bound)) {
      return { ok: true, actionId: bound.id, actionName: bound.name, pool: 'binding', evidence: [`按绑定 ${kind} → 「${bound.name}」`] };
    }
    if (bound && !playable(bound)) {
      // 绑定存在但资源不可播（例如帧文件被删）：继续走池子，但要说明为什么没用绑定
      const fallbackModel = args.model ?? modelFromActions(actions).model;
      const decision = resolvePlayback({ trigger: kind, currentAction: args.currentActionName }, fallbackModel, args.rng ?? Math.random);
      return {
        ok: decision.ok,
        actionId: decision.ok ? actions.find((a) => a.name === decision.actionName)?.id : undefined,
        actionName: decision.actionName,
        pool: decision.pool,
        reason: decision.reason,
        evidence: [`绑定动作「${bound.name}」无可播资源 → 回退互动池`, ...decision.evidence],
      };
    }
  }

  const model = args.model ?? modelFromActions(actions).model;
  const decision = resolvePlayback({ trigger: kind, currentAction: args.currentActionName }, model, args.rng ?? Math.random);
  const target = decision.ok ? actions.find((a) => a.name === decision.actionName) : undefined;
  if (decision.ok && !target) {
    return { ok: false, actionId: undefined, actionName: decision.actionName, pool: decision.pool, reason: 'unknown-action', evidence: [...decision.evidence, `模型命中「${decision.actionName}」但动作列表里没有同名动作`] };
  }
  return { ok: decision.ok, actionId: target?.id, actionName: decision.actionName, pool: decision.pool, reason: decision.reason, evidence: decision.evidence };
}
