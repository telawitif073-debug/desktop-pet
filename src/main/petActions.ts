import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  loadConfig,
  saveConfig,
  PET_ACTIONS_MAX,
  type LLMConfig,
  type PetAction,
  type PetActionKeyframe,
  type PetActionTransform,
} from './config';
import { createLLMService, type LLMService } from './llmService';

function getActionLLMConfig(): LLMConfig {
  const base = loadConfig().llm;
  const override = loadConfig().actionLLM;
  return {
    ...base,
    ...(override?.model ? { model: override.model } : {}),
    ...(override?.baseUrl ? { baseUrl: override.baseUrl } : {}),
    ...(typeof override?.temperature === 'number'
      ? { temperature: Math.min(2, Math.max(0, override.temperature)) }
      : {}),
  };
}

/** 动作生成专用 LLM 实例：独立于聊天与智能体覆盖，可在动作管理面板单独配置
 * （如固定使用 deepseek-chat 等非推理模型，避免思维链耗尽输出额度） */
export const actionLLMService = createLLMService(getActionLLMConfig);

function getActionsDir(): string {
  return path.join(app.getPath('userData'), 'pet-actions');
}

/** 新增帧序列动作：图片写入 userData/pet-actions/<id>/，元数据写入 config。
 * options.petAssetId 提供时标记为资源库动作（随宠物安装，换宠物时清除） */
export function addFramesAction(
  name: string,
  files: Array<{ filename: string; data: Buffer }>,
  options?: { petAssetId?: string; interaction?: 'none' | 'feed' | 'rest' | 'play'; frameRate?: number },
): PetAction {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!files.length) throw new Error('至少上传一张图片作为帧');
  if (files.length > 30) throw new Error('帧数过多（最多 30 张）');

  const config = loadConfig();
  if (config.petActions.length >= PET_ACTIONS_MAX) {
    throw new Error(`动作数量已达上限（${PET_ACTIONS_MAX} 个），请先删除部分动作`);
  }

  const id = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(getActionsDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  // 按传入顺序编号写盘，避免文件名冲突/乱序（播放顺序 = 上传顺序）
  const exts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  const frameFiles: string[] = [];
  files.forEach((file, index) => {
    const ext = path.extname(file.filename || '').toLowerCase();
    if (!exts.has(ext)) throw new Error(`不支持的图片格式: ${file.filename}`);
    const framePath = path.join(dir, `frame_${String(index).padStart(3, '0')}${ext}`);
    fs.writeFileSync(framePath, file.data);
    frameFiles.push(framePath);
  });

  const action: PetAction = {
    id,
    name: trimmedName,
    kind: 'frames',
    source: options?.petAssetId ? 'platform' : 'manual',
    frameFiles,
    frameRate: options?.frameRate ?? 6,
    ...(options?.petAssetId ? { petAssetId: options.petAssetId } : {}),
    ...(options?.interaction && options.interaction !== 'none' ? { interaction: options.interaction } : {}),
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...config.petActions, action] });
  return action;
}

/** 注册模型内置动画 clip 动作（Live2D/3D 模型宠物，播放由渲染端按形态驱动） */
export function addClipAction(
  name: string,
  clipName: string,
  options?: { petAssetId?: string; interaction?: 'none' | 'feed' | 'rest' | 'play' },
): PetAction {
  const trimmedName = name.trim();
  const trimmedClip = clipName.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');
  if (!trimmedClip) throw new Error('模型动画 clip 名称不能为空');

  const config = loadConfig();
  if (config.petActions.length >= PET_ACTIONS_MAX) {
    throw new Error(`动作数量已达上限（${PET_ACTIONS_MAX} 个），请先删除部分动作`);
  }

  const action: PetAction = {
    id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmedName,
    kind: 'clip',
    source: 'platform',
    clipName: trimmedClip,
    ...(options?.petAssetId ? { petAssetId: options.petAssetId } : {}),
    ...(options?.interaction && options.interaction !== 'none' ? { interaction: options.interaction } : {}),
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...config.petActions, action] });
  return action;
}

/** 清除资源库动作（换宠物时旧宠物的动作不可复用），并清理关联的互动绑定。
 * petAssetId 提供时仅清除属于该宠物的动作 */
export function clearPlatformActions(petAssetId?: string): number {
  const config = loadConfig();
  const removed = config.petActions.filter((a) => a.source === 'platform' && (!petAssetId || a.petAssetId === petAssetId));
  if (!removed.length) return 0;

  for (const action of removed) {
    if (action.kind === 'frames' && action.frameFiles?.length) {
      try {
        fs.rmSync(path.dirname(action.frameFiles[0]), { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to remove platform action frames dir:', e);
      }
    }
  }

  const removedIds = new Set(removed.map((a) => a.id));
  const bindings = { ...(config.petActionBindings || {}) };
  (Object.keys(bindings) as Array<keyof typeof bindings>).forEach((key) => {
    const boundId = bindings[key];
    if (boundId && removedIds.has(boundId)) delete bindings[key];
  });
  saveConfig({
    petActions: config.petActions.filter((a) => a.source !== 'platform'),
    petActionBindings: bindings,
  });
  return removed.length;
}

/** 获取当前宠物形象信息；若 config 缺少资源名（旧版本安装），从平台反查一次并回写 */
export async function resolvePetInfo(
  getDetail: (id: string) => Promise<{ name?: string }>
): Promise<{ name?: string; width?: number; height?: number }> {
  const config = loadConfig();
  const info: { name?: string; width?: number; height?: number } = {};
  if (!config.petAssetPath) return info;

  if (config.petAssetName) {
    info.name = config.petAssetName;
  } else {
    // 安装目录为 userData/pets/<资源id>/...，从路径提取 id 反查名称
    const parts = path.normalize(config.petAssetPath).split(path.sep);
    const petsIdx = parts.lastIndexOf('pets');
    const assetId = petsIdx >= 0 && parts[petsIdx + 1] ? parts[petsIdx + 1] : null;
    if (assetId) {
      try {
        const detail = await getDetail(assetId);
        if (detail?.name) {
          info.name = detail.name;
          saveConfig({ petAssetName: detail.name });
        }
      } catch { /* 平台不可达时跳过名称 */ }
    }
  }
  return info;
}

/** 数值钳制：保证 AI 产出的关键帧安全可播 */
function clampKeyframe(raw: unknown): PetActionKeyframe | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const view = f.view === 'side' || f.view === 'back' ? f.view : 'front';
  return {
    t: num(f.t, 0, 1, 0),
    dx: num(f.dx, -60, 60, 0),
    dy: num(f.dy, -60, 60, 0),
    rotation: num(f.rotation, -0.4, 0.4, 0),
    scale: num(f.scale, 0.7, 1.4, 1),
    view,
  };
}

/** 从 LLM 输出中提取 JSON：容忍 markdown 代码块、<think> 思维链包裹，以及被 token 上限截断的 JSON */
function extractJson(text: string): unknown {
  // 剥离推理模型的思维链块
  let candidate = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  if (start === -1) {
    throw new Error(`AI 输出中未找到 JSON 配置（回复开头: ${candidate.slice(0, 80) || '(空)'}）`);
  }
  const slice = candidate.slice(start);

  // 优先按最后一个闭括号直接解析
  const end = slice.lastIndexOf('}');
  if (end > 0) {
    try {
      return JSON.parse(slice.slice(0, end + 1));
    } catch { /* 可能被截断，尝试修复 */ }
  }

  // 截断修复：补齐未闭合的引号与括号（缺失数值由 clampKeyframe 的 fallback 兜底）
  const repaired = repairTruncatedJson(slice);
  try {
    return JSON.parse(repaired);
  } catch {
    throw new Error(`AI 输出不是有效的动作配置（回复开头: ${candidate.slice(0, 80) || '(空)'}）`);
  }
}

/** 补齐被截断 JSON 的未闭合字符串与 { [ 括号 */
function repairTruncatedJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  let result = text;
  if (inString) result += '"';
  if (stack.length) result += stack.reverse().join('');
  return result;
}

/** AI 生成变换动画：调 LLM 产出关键帧配置，钳制校验后写入 config。
 * petInfo 来自当前安装的宠物（名称 + 图片尺寸），使生成的动作贴合宠物形象 */
export async function generateAction(
  llm: LLMService,
  name: string,
  petInfo?: { name?: string; width?: number; height?: number }
): Promise<PetAction> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('动作名称不能为空');

  const config = loadConfig();
  if (config.petActions.length >= PET_ACTIONS_MAX) {
    throw new Error(`动作数量已达上限（${PET_ACTIONS_MAX} 个），请先删除部分动作`);
  }

  // 根据现有宠物样式组织形象描述：资源名（含物种信息）+ 图片比例
  const petDesc: string[] = [];
  if (petInfo?.name) petDesc.push(`形象/物种：「${petInfo.name}」`);
  if (petInfo?.width && petInfo?.height) {
    const ratio = petInfo.width / petInfo.height;
    petDesc.push(`原图片 ${petInfo.width}x${petInfo.height} 像素（${ratio > 1.2 ? '横向构图' : ratio < 0.83 ? '竖向构图' : '接近方形构图'}）`);
  }

  const prompt = [
    '你是桌面宠物动画设计师。为一个桌面宠物设计动作动画。',
    ...(petDesc.length ? [`当前宠物信息：${petDesc.join('，')}。动作要贴合该宠物的形象特征（体型、物种习性）。`] : []),
    `请设计名为「${trimmedName}」的动作。`,
    '宠物已有三视图素材：front=正面朝向观众，side=侧面轮廓，back=背面。系统会在播放时自动切换视图。',
    '只输出一个 JSON 对象，不要任何解释文字，格式：',
    '{"loop":true,"duration":1500,"keyframes":[{"t":0,"dx":0,"dy":0,"rotation":0,"scale":1,"view":"front"},{"t":1,"dx":0,"dy":0,"rotation":0,"scale":1,"view":"front"}]}',
    '字段规则：',
    '- loop: 是否循环播放（吃饭/走路/休息等状态动作为 true，打招呼等一次性动作为 false）',
    '- 一次性动作（loop=false）的末帧必须回到自然站立姿态（dx=0,dy=0,rotation=0,scale=1,view=front），保证动作结束后宠物自然复位',
    '- duration: 单轮时长毫秒，建议 800~3000',
    '- keyframes: 关键帧数组，2~6 个；t 为 0~1 的时间进度（首帧必须 0，末帧必须 1）',
    '- dx/dy: 相对基准位置的像素偏移，范围 -40~40（y 向下为正）',
    '- rotation: 旋转弧度，范围 -0.3~0.3；scale: 缩放，范围 0.8~1.3',
    '- view: 该关键帧使用的视图 "front"/"side"/"back"，用三视图组合表达转身、踱步等动作',
    `动画要体现「${trimmedName}」的特点，善用三视图让动作生动，例如：`,
    '- 走路 = side 视图 + rotation 左右小幅摆动 + dx 前移；转身 = front→side→back→side→front 依次切换',
    '- 吃饭 = front 视图 + dy 低头起伏；休息 = side 视图 + 缓慢下沉；玩耍 = front/back 交替跳跃',
  ].join('\n');

  const reply = await llm.chat({ messages: [{ role: 'user', content: prompt }] });
  const parsed = extractJson(reply) as Record<string, unknown>;

  const rawFrames = Array.isArray(parsed.keyframes) ? parsed.keyframes : [];
  const keyframes = rawFrames
    .map(clampKeyframe)
    .filter((f): f is PetActionKeyframe => f !== null)
    .sort((a, b) => a.t - b.t);
  if (keyframes.length < 2) throw new Error('AI 生成的关键帧无效（至少需要 2 个）');
  // 保证首末时间锚点完整，避免插值越界
  keyframes[0].t = 0;
  const lastKeyframe = keyframes[keyframes.length - 1];
  lastKeyframe.t = 1;
  // 非循环动作末帧强制归位：结束回到自然站立姿态，保证两个状态间的过渡自然
  if (parsed.loop === false) {
    lastKeyframe.dx = 0;
    lastKeyframe.dy = 0;
    lastKeyframe.rotation = 0;
    lastKeyframe.scale = 1;
    lastKeyframe.view = 'front';
  }

  const transform: PetActionTransform = {
    loop: parsed.loop !== false,
    duration: Math.min(6000, Math.max(400, typeof parsed.duration === 'number' && Number.isFinite(parsed.duration) ? parsed.duration : 1500)),
    keyframes,
  };

  const action: PetAction = {
    id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmedName,
    kind: 'transform',
    source: 'ai',
    transform,
    createdAt: Date.now(),
  };
  saveConfig({ petActions: [...loadConfig().petActions, action] });
  return action;
}

/** 删除动作：帧序列同时清理磁盘目录 */
export function removeAction(id: string): void {
  const config = loadConfig();
  const target = config.petActions.find((a) => a.id === id);
  if (!target) return;
  if (target.kind === 'frames' && target.frameFiles?.length) {
    const dir = path.dirname(target.frameFiles[0]);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to remove action frames dir:', e);
    }
  }
  saveConfig({ petActions: config.petActions.filter((a) => a.id !== id) });
}
