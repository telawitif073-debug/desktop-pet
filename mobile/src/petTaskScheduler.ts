/**
 * 宠物定时任务·运行时（存储落地 + 调度触发 + 到点消息生成）。
 * - 意图落地：handlePetIntent 把识别结果落到 store（建任务/查询/取消/暂停/继续）
 * - 调度：App 前台期间每 15s 扫描到期任务；冷启动/回前台补触发 2 小时内错过的
 *   （更久的：重复任务顺延、一次性任务作废，不打扰）
 * - 到点消息：优先调用该智能体 LLM 按人设主动开场；无有效 API / 调用失败降级为模板文案
 * 纯 JS 实现（走热更新即可发布，无需重装 APK）。
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAppStore } from './store/appStore';
import type { ChatMsg, PetTask } from './types';
import {
  CLARIFY_REPLY,
  cancelReply,
  createReply,
  fallbackMessage,
  formatDueLabel,
  pauseReply,
  queryReply,
  resumeReply,
  taskDisplay,
  type PetIntent,
  type PetTaskKind,
  type TaskDirective,
} from './petTasks';
import { generateActiveMessage, generatePersonaReply } from './petActiveMessage';

/** 扫描间隔 */
const TICK_MS = 15000;
/** 补触发窗口：错过的任务 2 小时内仍补触发一次 */
const GRACE_MS = 2 * 60 * 60 * 1000;
/** 单智能体未完成任务上限（防止任务无限堆积） */
const MAX_PENDING_TASKS = 20;
/** 单智能体每日新建上限（对齐人设卡 frequency_control.max_active_tasks_per_day） */
const MAX_DAILY_TASKS = 20;
const DAY_MS = 86400000;

const inFlight = new Set<string>();

/** 该智能体未启用「定时任务」能力时的回复（能力来自它自己的 JSON 声明，可在智能体编辑里开启） */
export const NO_CAPABILITY_REPLY =
  '这个智能体还没有开启「根据我的需求排定时任务」的能力哦。可以在「智能体管理 → 编辑 → 智能体能力」里为它打开。';

/** 能力未开启时交给该智能体自己说的话（事实里带上开启路径，模型会原样保留） */
const NO_CAPABILITY_FACT =
  '用户让 ta 安排定时提醒，但作为这个智能体的你还没有被开启「根据我的需求排定时任务」这项能力，这次帮不了 ta。' +
  '需要到「智能体管理 → 编辑 → 智能体能力」里为你打开这项能力。';

/**
 * 把本地动作的结果交给该智能体用自己的口吻说出（计时事实由 App 计算，措辞由它自己产出）。
 * 无可用 API 或调用失败时回退中性文案，保证离线也能用。
 */
async function speak(profileId: string, fact: string, fallback: string): Promise<string> {
  const owner = useAppStore.getState().llmProfiles.find((p) => p.id === profileId);
  if (!owner) return fallback;
  try {
    const text = (await generatePersonaReply(owner, fact)).trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** 正文里是否已经说了时间（模型自己说清了就不必再补一条系统口径的确认） */
export function mentionsDue(text: string): boolean {
  return /(\d{1,2}\s*[:：]\s*\d{2})|([0-9一二两三四五六七八九十]{1,3}\s*[点时])|(半)/.test(text);
}

/** 建任务入参（本地意图 / 模型指令共用） */
interface ScheduleInput {
  kind: PetTaskKind;
  content: string;
  rawText: string;
  due: number;
  repeat: 'none' | 'daily' | 'weekly';
}

type ScheduleResult =
  | { ok: true; label: string; task: PetTask }
  | { ok: false; reason: 'dup' | 'limit' | 'daily' | 'no-capability'; dupLabel?: string };

/**
 * 建任务统一入口：能力校验（该智能体必须启用「定时任务」能力，能力来自它的 JSON 声明）
 * + 防重复（同内容同时刻 60s 内不重排）+ 未完成上限 + 每日新建上限（用该智能体自己的
 * frequency_control.max_active_tasks_per_day，缺省 20）。本地固定句式与模型指令都走这里。
 */
function scheduleTask(profileId: string, input: ScheduleInput): ScheduleResult {
  const store = useAppStore.getState();
  const owner = store.llmProfiles.find((p) => p.id === profileId);
  if (!owner?.capabilities?.enabled?.includes('tasks')) return { ok: false, reason: 'no-capability' };
  const dailyLimit = owner.capabilities.spec.maxActiveTasksPerDay ?? MAX_DAILY_TASKS;
  const mine = store.petTasks.filter((k) => k.profileId === profileId);
  const active = mine.filter((k) => k.status === 'pending' || k.status === 'paused');
  // 防重复（对齐人设卡 frequency_control.avoid_spam）：同一件事、同一触发时间不重复排
  const dup = active.find((k) => k.content === input.content && Math.abs(k.due - input.due) < 60000);
  if (dup) return { ok: false, reason: 'dup', dupLabel: formatDueLabel(dup.due, dup.repeat) };
  if (active.length >= MAX_PENDING_TASKS) return { ok: false, reason: 'limit' };
  // 每日新建上限（该智能体自己的 frequency_control.max_active_tasks_per_day）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = mine.filter((k) => k.createdAt >= todayStart.getTime()).length;
  if (todayCount >= dailyLimit) return { ok: false, reason: 'daily' };
  const task: PetTask = {
    id: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    profileId,
    kind: input.kind,
    rawText: input.rawText,
    content: input.content,
    timeLabel: formatDueLabel(input.due, input.repeat),
    due: input.due,
    repeat: input.repeat,
    status: 'pending',
    createdAt: Date.now(),
  };
  store.addPetTask(task);
  return { ok: true, label: task.timeLabel, task };
}

/** 把识别到的意图落到 store，返回给用户的回复文案（措辞由该智能体按人设产出，失败回退中性文案） */
export async function handlePetIntent(intent: PetIntent, profileId: string): Promise<string> {
  const store = useAppStore.getState();
  const mine = (): PetTask[] => useAppStore.getState().petTasks.filter((k) => k.profileId === profileId);
  switch (intent.kind) {
    case 'query': {
      const list = mine().filter((k) => k.status === 'pending' || k.status === 'paused');
      const fact = list.length
        ? `用户问 ta 有哪些事被你记着。现在进行中的共 ${list.length} 件：${list
            .map((k) => `${k.status === 'paused' ? '（已暂停）' : ''}${formatDueLabel(k.due, k.repeat)} ${taskDisplay(k.content)}`)
            .join('；')}`
        : '用户问 ta 有哪些事被你记着，现在一件都没有。';
      return speak(profileId, fact, queryReply(list));
    }
    case 'pause': {
      const list = mine().filter((k) => k.status === 'pending');
      store.patchPetTasks(list.map((k) => ({ id: k.id, status: 'paused' as const })));
      const fact = list.length
        ? `用户让你先别提醒，你已经把 ${list.length} 件事暂停了（ta 说「继续提醒」就能恢复）`
        : '用户让你先别提醒，但你手上本来就没有进行中的事。';
      return speak(profileId, fact, pauseReply(list.length));
    }
    case 'resume': {
      const list = mine().filter((k) => k.status === 'paused');
      store.patchPetTasks(list.map((k) => ({ id: k.id, status: 'pending' as const })));
      const fact = list.length ? `用户让你继续提醒，你已经把之前暂停的 ${list.length} 件事恢复了` : '用户让你继续提醒，但没有被暂停的事。';
      return speak(profileId, fact, resumeReply(list.length));
    }
    case 'cancel': {
      const all = mine().filter((k) => k.status === 'pending' || k.status === 'paused');
      const targets = pickCancelTargets(all, intent.hint);
      store.patchPetTasks(targets.map((k) => ({ id: k.id, status: 'canceled' as const })));
      const labels = targets.map((k) => `${formatDueLabel(k.due, k.repeat)} — ${taskDisplay(k.content)}`);
      const fact = labels.length
        ? `用户让你别提醒了，你已经取消这 ${labels.length} 件：${labels.join('；')}`
        : '用户让你别提醒了，但你手上本来就没有可取消的事。';
      return speak(profileId, fact, cancelReply(labels));
    }
    case 'clarify':
      return speak(
        profileId,
        '用户想让你在某个时间做件事，但没说清是什么时候。你需要用自己的口吻问 ta 具体时间（比如 ta 可以说「1分钟后提醒我喝水」或「明早8点叫我起床」）。',
        CLARIFY_REPLY,
      );
    case 'create': {
      const r = scheduleTask(profileId, {
        kind: intent.taskKind,
        content: intent.content,
        rawText: intent.rawText,
        due: intent.schedule.due,
        repeat: intent.schedule.repeat,
      });
      if (!r.ok) {
        if (r.reason === 'no-capability') return speak(profileId, NO_CAPABILITY_FACT, NO_CAPABILITY_REPLY);
        if (r.reason === 'dup') {
          return speak(
            profileId,
            `用户又让你做同一件事，但 ${r.dupLabel}「${intent.display}」你早就答应过了，不用再排一次；提醒 ta 你记着呢。`,
            `这件事我记着呢：${r.dupLabel} 会提醒你「${intent.display}」，不用重复说。`,
          );
        }
        if (r.reason === 'limit') {
          return speak(
            profileId,
            `用户让你再记一件事，但你手上未完成的事已经有 ${MAX_PENDING_TASKS} 件了，这次记不下；让 ta 先完成或取消一些。`,
            `你手上的事已经攒了 ${MAX_PENDING_TASKS} 件啦，先完成或取消一些，我再帮你记新的。`,
          );
        }
        return speak(
          profileId,
          `用户让你再记一件事，但今天已经安排了 ${MAX_DAILY_TASKS} 件，今天不再接了；让 ta 明天再说。`,
          `今天已经安排了 ${MAX_DAILY_TASKS} 件事啦，明天再继续吧。`,
        );
      }
      const what = intent.taskKind === 'active_chat' ? '主动找 ta 聊' : '提醒 ta';
      return speak(
        profileId,
        `用户让你在 ${r.label} ${what}「${intent.display}」，你已经答应下来并按这个时间安排好了。`,
        createReply(r.label, intent.display, intent.taskKind),
      );
    }
  }
}

/**
 * 模型建任务：把智能体回复里的任务指令落库（同样走防重复/上限），
 * 返回给用户的一行确认文案 —— 成功必须可见，失败也要说清楚（避免「模型口头答应却没排上」）。
 * 文案同样交给该智能体按人设说出（失败回退中性文案）。
 */
export async function createTaskFromDirective(
  profileId: string,
  d: TaskDirective,
  userText = '',
): Promise<{ ok: boolean; text: string }> {
  const display = taskDisplay(d.content);
  const r = scheduleTask(profileId, {
    kind: d.kind,
    content: d.content,
    rawText: userText.trim() || d.content,
    due: d.due,
    repeat: d.repeat,
  });
  if (r.ok) {
    return {
      ok: true,
      text: await speak(
        profileId,
        `用户让你在 ${r.label} ${d.kind === 'active_chat' ? '主动找 ta 聊' : '提醒 ta'}「${display}」，你已经答应下来并按这个时间安排好了。`,
        `已答应你：${r.label} · ${display}`,
      ),
    };
  }
  if (r.reason === 'no-capability') return { ok: false, text: await speak(profileId, NO_CAPABILITY_FACT, NO_CAPABILITY_REPLY) };
  if (r.reason === 'dup') {
    return {
      ok: false,
      text: await speak(
        profileId,
        `用户让你做一件事，但 ${r.dupLabel}「${display}」你早就答应过了，不用再排一次；提醒 ta 你记着呢。`,
        `这件事我记着呢：${r.dupLabel} · ${display}`,
      ),
    };
  }
  if (r.reason === 'limit') {
    return {
      ok: false,
      text: await speak(
        profileId,
        `用户让你再记一件事，但你手上未完成的事已经有 ${MAX_PENDING_TASKS} 件了，这次记不下；让 ta 先完成或取消一些。`,
        `你手上的事已经攒了 ${MAX_PENDING_TASKS} 件啦，先取消一些我再记。`,
      ),
    };
  }
  return {
    ok: false,
    text: await speak(
      profileId,
      `用户让你再记一件事，但今天已经安排了 ${MAX_DAILY_TASKS} 件，今天不再接了；让 ta 明天再说。`,
      '今天安排的事已经满了，明天再继续吧。',
    ),
  };
}

/** 取消指代匹配：提示词命中任务内容/原话（含 2 字滑窗）则只取消该任务，否则全部取消 */
function pickCancelTargets(tasks: PetTask[], hint: string): PetTask[] {
  const h = hint.trim();
  if (h.length >= 2) {
    const hit = tasks.filter((k) => {
      const c = `${k.content}${k.rawText}`;
      if (c.includes(h) || h.includes(k.content)) return true;
      for (let i = 0; i + 2 <= h.length; i++) {
        if (c.includes(h.slice(i, i + 2))) return true;
      }
      return false;
    });
    if (hit.length) return hit;
  }
  return tasks;
}

/** 扫描到期任务并触发（一次最多处理 3 个，其余下一轮） */
async function tick(): Promise<void> {
  const st = useAppStore.getState();
  if (!st.hydrated) return;
  const now = Date.now();
  const due = st.petTasks
    .filter((k) => k.status === 'pending' && k.due <= now && !inFlight.has(k.id))
    .slice(0, 3);
  for (const task of due) {
    inFlight.add(task.id);
    void fireTask(task, now)
      .catch(() => undefined)
      .finally(() => inFlight.delete(task.id));
  }
}

/** 触发一个任务：生成主动消息 → 落到对应智能体的对话（无论是否当前激活档案）→ 更新任务状态 */
async function fireTask(task: PetTask, now: number): Promise<void> {
  const owner = useAppStore.getState().llmProfiles.find((p) => p.id === task.profileId);
  // 智能体已删除：任务作废
  if (!owner) {
    useAppStore.getState().patchPetTasks([{ id: task.id, status: 'canceled' }]);
    return;
  }
  // 超出补触发窗口：重复任务顺延、一次性任务作废（不再打扰）
  if (now - task.due > GRACE_MS) {
    useAppStore.getState().patchPetTasks([
      task.repeat === 'none'
        ? { id: task.id, status: 'done', firedAt: now }
        : { id: task.id, due: nextRepeatDue(task, now), firedAt: now },
    ]);
    return;
  }
  let content = '';
  if (owner.apiKey && owner.baseUrl && owner.model) {
    try {
      content = await generateActiveMessage(owner, {
        topic: task.content,
        rawText: task.rawText,
        kind: task.kind,
      });
    } catch {
      content = '';
    }
  }
  if (!content) content = fallbackMessage(task);
  const msg: ChatMsg = {
    id: `k-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content,
  };
  useAppStore.getState().pushPetTaskMessage(task.profileId, msg);
  useAppStore.getState().patchPetTasks([
    task.repeat === 'none'
      ? { id: task.id, status: 'done', firedAt: now }
      : { id: task.id, due: nextRepeatDue(task, now), firedAt: now },
  ]);
}

/** 重复任务的下一次触发时间（跳过已过去的周期） */
function nextRepeatDue(task: PetTask, now: number): number {
  const step = task.repeat === 'daily' ? DAY_MS : 7 * DAY_MS;
  let due = task.due + step;
  while (due <= now) due += step;
  return due;
}

/** 定时任务调度器：挂在主壳（登录后的常驻页面）。默认导出便于单处挂载 */
export function usePetTaskScheduler(): void {
  const hydrated = useAppStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    void tick();
    const id = setInterval(() => {
      void tick();
    }, TICK_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void tick();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [hydrated]);
}