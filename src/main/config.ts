import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { validatePetActionModel, type PetActionModel } from '../pet'; // 宠物主体功能模块（统一入口）
// 动作配额的本体（渲染端也要用，故放在 shared；见下方再导出）
import { ACTIONS_OWNER_USER, PET_ACTIONS_MAX_USER, actionOwnerKey, actionQuotaLimit } from '../shared/actionQuota';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** 采样温度；未配置时 llmService 用默认值 0.8（平台/智能体不再提供覆盖） */
  temperature?: number;
  /** 是否显示/请求思考过程（随 AppConfig.showThinking 生效；未开启不注入 thinking 参数） */
  showThinking?: boolean;
  /** 思考语言：auto=跟随模型 zh/en=强制模型用对应语言思考（注入末条用户消息 + 系统提示词） */
  thinkingLang?: 'auto' | 'zh' | 'en';
}

/** 多 API 配置档案：聊天设置中可保存多个 API 并一键切换生效。
 *  LlmProfile = 智能体（与手机端 mobile/src/types.ts 同构）：档案自带人设、绑定形象与专属音色，
 *  对话与定时任务都按档案隔离。 */
export interface LlmProfile {
  id: string;
  /** 展示名（如"DeepSeek 官方"） */
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 档案级系统提示词；空 = 沿用默认 llm 的提示词 */
  systemPrompt?: string;
  /** 绑定的宠物形象 ID（一个智能体必须且只能绑定一个宠物形象） */
  petAssetId?: string;
  // ── 智能体扩展字段（与手机端一致；均可选，旧 6 字段档案自动升级）──
  /** 头像（emoji 或文字，不填默认取 name 首字符） */
  avatar?: string;
  /** 简介 */
  intro?: string;
  /** 领域标签（医疗/训练/内容/陪伴/电商等） */
  domainTags?: string[];
  /** 角色（医生/训练师/经纪人/管家等） */
  role?: string;
  /** 风格（温柔/毒舌/专业/搞笑/简短等） */
  style?: string;
  /** 欢迎语（切换/新会话时展示） */
  greeting?: string;
  /** 示例问题（供用户快速提问） */
  exampleQuestions?: string[];
  /** 启停：false 时不参与激活选择，聊天不可用该档案 */
  enabled?: boolean;
  /** 多智能体编排配置（含外部依赖与凭证引用） */
  multiConfig?: AgentMultiConfig;
  /** 智能体自带能力（导入 JSON 的能力声明 + 用户勾选） */
  capabilities?: AgentCapabilities;
  /** 专属朗读音色：已安装音色 id（downloadedVoices[].id）；缺省或音色已删除 = 跟随全局音色。
   *  属于本机偏好，导出智能体时不外带 */
  boundVoiceId?: string;
}

// ── 智能体能力（对齐 mobile/src/types.ts）────────────────────────────────

/** 智能体自带能力种类：tasks=按用户需求排定时任务；proactive=无需排期的主动搭话；
 *  web=需要时联网查询（用户自配搜索服务）；weather/stock/football=平台免费技能 */
export type AgentCapabilityKind = 'tasks' | 'proactive' | 'web' | 'weather' | 'stock' | 'football';

/** 联网搜索服务提供商（用户自配 Key；接口地址留空用默认） */
export type WebSearchProvider = 'bocha' | 'serper' | 'tavily';

/** 联网查询规格（属于该智能体自己，随档案云同步） */
export interface WebSearchSpec {
  provider: WebSearchProvider;
  apiKey: string;
  /** 自定义接口地址（留空用该提供商默认地址） */
  endpoint?: string;
}

/** 能力规格：从该智能体自己的 JSON 读到的设置（缺省用应用兜底值） */
export interface AgentCapabilitySpec {
  /** 联网查询配置（仅 web 能力用） */
  web?: WebSearchSpec;
  /** 主动搭话间隔（分钟） */
  intervalMinutes?: number;
  /** 搭话时段 [start, end) */
  wakingHours?: [number, number];
  /** 示例任务（example_tasks[].user_input） */
  exampleTasks?: string[];
  /** 每日任务上限 */
  maxActiveTasksPerDay?: number;
  /** 检测时间 */
  detectedAt?: number;
  /** 来源：import=导入 JSON 检测；manual=编辑表单手动开启 */
  source?: 'import' | 'manual';
}

/** 该智能体启用的能力（导入时由用户勾选，编辑表单可调整） */
export interface AgentCapabilities {
  enabled: AgentCapabilityKind[];
  spec: AgentCapabilitySpec;
}

// ── 多智能体编排（对齐 mobile/src/types.ts）──────────────────────────────

/** 外部依赖类型：大模型 / 远程子智能体 / 工具 / 记忆库 / 其他 */
export type MultiAgentDepType = 'model' | 'agent_api' | 'tool_api' | 'memory' | 'other';
export type MultiAgentDepProtocol = 'openai' | 'rest' | 'a2a' | 'mcp' | 'other';
export type MultiAgentDepAuth = 'api_key' | 'bearer' | 'oauth' | 'none';

/** 单条外部依赖（识别自配置中的 ${VAR} / {{VAR}} / env:VAR / secret:VAR 占位符） */
export interface MultiAgentDependency {
  /** 占位符变量名（如 MODEL_API） */
  key: string;
  type: MultiAgentDepType;
  protocol: MultiAgentDepProtocol;
  auth: MultiAgentDepAuth;
  /** 用途说明（中文，可被用户改写） */
  usage: string;
  /** 示例值 */
  example: string;
  /** 内部凭证引用，如 cred://dep_1（运行时注入真实值） */
  ref: string;
}

/** 多智能体编排配置（随 LlmProfile 云同步；credentials 上云加密，导出剥离） */
export interface AgentMultiConfig {
  /** 用户原始配置文本（含 ${KEY} 占位符） */
  raw: string;
  format: 'yaml' | 'json';
  /** 依赖清单（含 cred:// 引用） */
  deps: MultiAgentDependency[];
  /** 占位符 key → 真实值（仅本地明文；云同步加密存储；导出剥离） */
  credentials: Record<string, string>;
}

// ── 音色（对齐 mobile/src/types.ts；桌面上线三引擎，Edge 为桌面特有引擎）────

/**
 * 音色引擎配置（商店发布/JSON 导入的就是这份配置，绝不含 API Key）：
 * - system：系统 TTS（桌面为 Web Speech 离线音色，机械感）
 * - cloud ：OpenAI 兼容 /audio/speech 云合成，voiceId=音色名（可填克隆音色 id），
 *           接口/模型/Key 由「云 TTS 服务配置」统一提供（用户自己的凭证）
 * - gptsovits：用户自建 GPT-SoVITS 引擎（api_v2，默认端口 9880），
 *           refAudioPath=引擎所在机器上的参考音频路径 + promptText=参考音频说的话，
 *           零样本克隆无需训练；地址可音色自带或跟随全局配置
 */
export interface VoiceConfig {
  engine: 'system' | 'cloud' | 'gptsovits';
  /** engine=system：系统音色 name（空=系统默认） */
  voiceName?: string;
  /** engine=cloud/gptsovits：接口根地址，空=用全局云服务配置 */
  baseUrl?: string;
  /** engine=cloud：模型（tts-1 / gpt-4o-mini-tts / CosyVoice-300M-SFT 等），空=用全局配置 */
  model?: string;
  /** 音色 ID：OpenAI 系 alloy/echo/...；克隆音色填平台给的 voice id；gptsovits 无需填写 */
  voiceId: string;
  /** 风格指令（支持 instructions 的模型生效，如「温柔的大姐姐，语速偏慢」） */
  instructions?: string;
  /** 发布者给的推荐试听文本（安装后试听默认念这句） */
  sampleText?: string;
  // ── engine=gptsovits 专用 ──
  /** 参考音频路径（GPT-SoVITS 引擎所在机器上的绝对路径或 URL，3~10 秒干净人声） */
  refAudioPath?: string;
  /** 参考音频所说的话（需与音频内容一致） */
  promptText?: string;
  /** 参考音频语言（zh/en/ja/ko/yue，默认 zh） */
  promptLang?: string;
  /** 待合成文本语言（auto/zh/en/ja/ko/yue，默认 zh） */
  textLang?: string;
}

/** 已安装到本机的音色（商店资产或本机自建；随 config 云同步） */
export interface InstalledVoice {
  /** 商店资产 id；本机自建为 local- 前缀 */
  id: string;
  name: string;
  description?: string;
  config: VoiceConfig;
  /** 商店试听音频绝对地址（可空；为空时用本机配置现场合成试听） */
  sampleUrl?: string | null;
  version?: string;
  installedAt: number;
  fromStore?: boolean;
}

/** 用户自配的云 TTS 服务凭证（全局共享，apiKey 随云同步加密落库）
 *  engine：openai=OpenAI 兼容 /audio/speech（默认）；gptsovits=自建 GPT-SoVITS api_v2（只需地址，无需 Key） */
export interface TtsCloudConfig {
  engine?: 'openai' | 'gptsovits';
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ── 宠物定时任务（对齐 mobile/src/types.ts，运行时见 T8）───────────────────

/** 宠物定时任务：用户让宠物在指定时间做的事（提醒/主动搭话），到点由智能体主动发消息 */
export interface PetTask {
  id: string;
  /** 归属智能体档案（每个智能体自己的任务） */
  profileId: string;
  /** reminder=提醒类；active_chat=主动搭话类 */
  kind: 'reminder' | 'active_chat';
  /** 用户原话（整句） */
  rawText: string;
  /** 任务内容（剥离时间短语后的原句） */
  content: string;
  /** 创建时的时间展示（今天 15:30 / 每天 08:00） */
  timeLabel: string;
  /** 触发时间戳（ms） */
  due: number;
  /** 一次性 / 每天 / 每周 */
  repeat: 'none' | 'daily' | 'weekly';
  status: 'pending' | 'paused' | 'done' | 'canceled';
  createdAt: number;
  /** 最近一次触发时间（防重复触发） */
  firedAt?: number;
}

/** 云 TTS 服务配置默认值（engine=openai） */
export const DEFAULT_TTS_CLOUD_CONFIG: TtsCloudConfig = {
  engine: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
};

/** 会话历史消息（按档案隔离存储的最小形态；system 提示词不落盘） */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（开启 showThinking 时由模型返回，随消息持久化） */
  reasoning?: string;
}

/**
 * 尚无任何智能体档案时，聊天记录挂靠的保留键：
 * 旧版单档案 chat-history.json 会迁移到这里，保证「未建档案时聊天记录不丢失」。
 * 用户创建首个档案后由档案自己的历史接管（旧记录仍保留在本键下，随 config 云同步）。
 */
export const UNBOUND_PROFILE_ID = '__unbound__';

export interface UserProfile {
  name: string;
  preferences: Record<string, unknown>;
}

export interface PlatformConfig {
  baseUrl: string;
  frontendUrl: string;
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; email: string; role: 'user' | 'admin' } | null;
}

/** 宠物窗口设置（大小 / 透明度），可在资源库"设置"页调整 */
export interface PetWindowConfig {
  width: number;
  height: number;
  opacity: number;
  /** 是否置顶显示（窗口保持在其他应用之上），默认 true */
  alwaysOnTop?: boolean;
}

/** 宠物互动功能开关（喂食/休息/玩耍/好感度），可在资源库"设置"页调整；
 * 关闭后隐藏对应按钮与进度条，并冻结对应数值的衰减 */
export interface PetFeaturesConfig {
  feedEnabled: boolean;
  restEnabled: boolean;
  playEnabled: boolean;
  affectionEnabled: boolean;
}

/** 宠物资源形态：image=单张图片（含 GIF），pack=多图帧序列包，live2d=Live2D 模型包，model3d=3D 模型（glb/gltf） */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d';

/** 宠物动作：kind=frames 为帧序列（手动上传/宠物资源包附带），
 * kind=clip 为 Live2D/3D 模型内置动画 clip（仅模型宠物可用），
 * kind=video 为视频动作（透明 webm，由渲染端直接播放，不转帧序列）。
 * petAssetId 标记动作属于哪个宠物资源（动作随宠物，不可跨宠物使用） */
export interface PetAction {
  id: string;
  name: string;
  kind: 'frames' | 'clip' | 'video';
  source: 'ai' | 'manual' | 'platform';
  frameFiles?: string[];
  frameRate?: number;
  /** kind=clip 时的模型内置动画名称 */
  clipName?: string;
  /** kind=video 时的视频文件绝对路径（webm） */
  videoFile?: string;
  /** 所属宠物资源 id（platform 来源动作） */
  petAssetId?: string;
  /** 所属内置演示宠物 id（source=manual 但由内置演示宠物安装产生，用于精确识别/清理） */
  builtinPetId?: string;
  /** 互动绑定（feed/rest/play），安装时写入 petActionBindings */
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  createdAt: number;
}

/**
 * 动作配额：**按归属分别计数**，用户自建动作与宠物自带动作互不挤占。
 * 常量本体与纯函数在 `src/shared/actionQuota.ts`（渲染端也要用，不能 import 本文件）。
 */
export {
  ACTIONS_OWNER_USER,
  PET_ACTIONS_MAX_USER,
  PET_ACTIONS_MAX_PER_PET,
  actionOwnerKey,
  actionQuotaLimit,
  actionOwnerLabel,
} from '../shared/actionQuota';

/** @deprecated 语义已拆分，请用 `PET_ACTIONS_MAX_USER`（用户自建动作）或
 *  `PET_ACTIONS_MAX_PER_PET`（单只宠物自带动作）。保留仅为兼容历史引用。 */
export const PET_ACTIONS_MAX = PET_ACTIONS_MAX_USER;

/**
 * 动作配额校验（按归属分别计数）。`incoming` 只需给出归属字段。
 * 抛错文案区分「我的动作」与「该宠物动作」，便于用户判断该删谁。
 */
export function assertActionQuota(
  existing: ReadonlyArray<PetAction>,
  incoming: Pick<PetAction, 'builtinPetId' | 'petAssetId'>,
): void {
  const owner = actionOwnerKey(incoming);
  const isUser = owner === ACTIONS_OWNER_USER;
  const limit = actionQuotaLimit(owner);
  const used = existing.filter((a) => actionOwnerKey(a) === owner).length;
  if (used >= limit) {
    const who = isUser ? '我的动作' : '该宠物动作';
    throw new Error(
      `${who}数量已达上限（${limit} 个），请先删除部分${isUser ? '自定义' : '该宠物的'}动作`,
    );
  }
}

/** 互动功能绑定的动作 id：喂食/休息/玩耍触发时优先播放绑定的资源库动作，未绑定回退同名动作 */
export interface PetActionBindings {
  feed?: string;
  rest?: string;
  play?: string;
}

/** 智能体主动对话配置：定时以气泡发起聊天（仅唤醒时段 8-22 点），状态低值时提醒 */
export interface AgentProactiveConfig {
  enabled: boolean;
  /** 发起间隔（分钟），下限 10 分钟 */
  intervalMinutes: number;
}

/** 宠物语音朗读配置（Edge TTS 免费 Neural 音色优先，系统 Web Speech 兜底） */
export interface SpeechSettings {
  /** 总开关：关闭后回复不朗读 */
  enabled: boolean;
  /** 音色：'' 或 'edge:ShortName'（Edge 神经音色）| 'sys:voiceURI'（系统声音）；空 = Edge 默认晓晓 */
  voice?: string;
  /** @deprecated 旧系统音色字段，迁移至 voice（sys: 前缀），读取时兼容 */
  voiceURI?: string;
  /** 语气预设：natural=自然 happy=开心 gentle=温柔 serious=严肃 lazy=慵懒 */
  tone: 'natural' | 'happy' | 'gentle' | 'serious' | 'lazy';
  /** 语速 0.5~2（1=正常） */
  rate: number;
  /** 声线（音调）0~2（1=正常，越高越尖锐） */
  pitch: number;
  /** 音量 0~1 */
  volume: number;
}

/** 语音配置默认值见渲染端 renderer/speech.ts DEFAULT_SPEECH（主进程仅持久化类型） */

/** 云端语音识别接口配置（OpenAI 兼容）：转写接口或多模态聊天模型均可 */
export interface VoiceAsrApiConfig {
  /** transcribe=OpenAI 兼容 /audio/transcriptions 转写接口；chat=多模态聊天模型转写（input_audio） */
  mode: 'transcribe' | 'chat';
  /** 接口根地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** transcribe: whisper-1 等；chat: gpt-4o-audio 等支持音频输入的模型 */
  model: string;
  /** 语言提示（仅 transcribe 生效，默认 zh） */
  language?: string;
}

/** 宠物「听懂说话」的来源配置：本地模型包 / 用户自配在线接口 / 已安装智能体自带（可选携带） */
export interface VoiceAsrConfig {
  /** local=本地 sherpa 模型包（默认，离线） api=用户自配在线接口 agent=智能体自带 */
  source?: 'local' | 'api' | 'agent';
  /** source=api 时的接口配置 */
  api?: VoiceAsrApiConfig;
  /** source=agent 时替换智能体自带密钥（可选；智能体自带密钥用完/不可用时填自己的） */
  agentApiKey?: string;
}

export interface AppConfig {
  petSystemEnabled: boolean;
  randomMoveEnabled: boolean;
  agentType: string;
  userProfile: UserProfile;
  petState: {
    hunger: number;
    mood: number;
    energy: number;
    affection: number;
  };
  petWindow: PetWindowConfig;
  petFeatures: PetFeaturesConfig;
  petActions: PetAction[];
  petActionBindings?: PetActionBindings;
  platform: PlatformConfig;
  petAssetPath?: string;
  /** 当前安装宠物的资源名称（如"橘猫桌面形象"） */
  petAssetName?: string;
  /** 当前安装宠物的资源 id（动作随宠物挂靠） */
  petAssetId?: string;
  /** 当前安装宠物的资源形态（image/pack/live2d/model3d），渲染端据此选择渲染方式 */
  petAssetFormat?: PetFormat;
  /** 当前使用的内置演示宠物 id（离线/未登录可用）；与 petAsset* 互斥，形象随包分发 */
  builtinPet?: string;
  /**
   * 宠物动作配置（schemaVersion 2，标准见 src/shared/petActionModel.ts）。
   * 缺省时运行时由 petActions 现场迁移生成（规则一致）；写入本字段即成为显式声明的动作体系：
   * 池划分（待机/互动/点击/拖拽/移动/随机分类/事件档位）、权重、逐动作参数都以此为准。
   */
  petActionModel?: PetActionModel;
  /** 智能体主动对话配置 */
  agentProactive?: AgentProactiveConfig;
  /** 宠物语音朗读配置（渲染端 Web Speech API） */
  speech?: SpeechSettings;
  /** 多 API 配置档案：聊天 API 全部由用户在客户端配置（平台不提供），列表内各档案同级、选中即生效 */
  llmProfiles?: LlmProfile[];
  /** 当前生效的档案 id */
  llmActiveProfileId?: string;
  /** 各档案的聊天记录（按档案 id 隔离；随 config 云同步，旧单档案 chat-history.json 自动迁移到激活档案） */
  profileMessages?: Record<string, StoredChatMessage[]>;
  /** 已安装音色（本机音色库；随 config 云同步，不含任何 API Key） */
  downloadedVoices?: InstalledVoice[];
  /** 全局音色选择（downloadedVoices[].id）；空 = 用桌面 Edge/系统音色 */
  activeCloudVoiceId?: string;
  /** 云 TTS 服务凭证（全局共享；云同步时 apiKey 由服务端加密落库） */
  ttsCloudConfig?: TtsCloudConfig;
  /** 是否显示思考过程（DeepSeek 风格思考卡，运行时见 T5） */
  showThinking?: boolean;
  /** 思考语言：auto=跟随模型 zh/en=提示模型用对应语言思考 */
  thinkingLang?: 'auto' | 'zh' | 'en';
  /** 聊天是否联动宠物心情（运行时见 T5） */
  moodFromChat?: boolean;
  /** 宠物定时任务（按档案隔离；随 config 云同步，运行时见 T8） */
  petTasks?: PetTask[];
  /** 清空对话前是否弹确认：ask=每次询问（默认） never=直接清空（用户选过"以后不再询问"，设置中可改回） */
  chatClearConfirm?: 'ask' | 'never';
  /** 感知能力开关（隐私敏感，默认全关）：screen=查看桌面（截屏附图） mic=麦克风语音输入 camera=摄像头拍照 */
  petSenses?: { screen: boolean; mic: boolean; camera: boolean };
  /** 宠物名字（语音唤醒词，听到名字回应并聆听需求） */
  petName?: string;
  /** 唤醒后对话模式：once=每次对话后需重新叫名字（默认） continuous=连续对话，叫一次名字后可持续说，超时自动结束 */
  voiceWakeMode?: 'once' | 'continuous';
  /** 语音唤醒模型包来源（本地 zip 路径或下载 URL），由用户在聊天设置中配置导入 */
  voiceModelSource?: string;
  /** 宠物「听懂说话」来源：本地模型包 / 在线接口 / 智能体自带（详见 VoiceAsrConfig） */
  voiceAsr?: VoiceAsrConfig;
  /** 宠物自我形象描述（更换形象/智能体时多模态 LLM 识别生成，注入对话 system prompt） */
  petSelfDescription?: string;
  /** 上次形象识别的指纹（资产标识+agentId），变化时才重新识别 */
  selfImageFingerprint?: string;
  agentConfigPath?: string;
  installedAgentId?: string;
  /** 已安装智能体：人设（name/systemPrompt）+ 可选自带语音识别（asr）；聊天 LLM 参数仍一律由用户配置（平台不提供 API） */
  installedAgentConfig?: unknown;
}

const DEFAULT_CONFIG: AppConfig = {
  petSystemEnabled: true,
  randomMoveEnabled: false,
  agentType: 'default',
  userProfile: {
    name: '',
    preferences: {},
  },
  petState: {
    hunger: 80,
    mood: 80,
    energy: 80,
    affection: 50,
  },
  petWindow: {
    width: 300,
    height: 300,
    opacity: 1,
  },
  petFeatures: {
    feedEnabled: true,
    restEnabled: true,
    playEnabled: true,
    affectionEnabled: true,
  },
  petActions: [],
  platform: {
    baseUrl: 'http://localhost:3001/api',
    frontendUrl: 'http://localhost:5174',
    accessToken: '',
    refreshToken: '',
    user: null,
  },
  agentProactive: {
    enabled: true,
    intervalMinutes: 30,
  },
  // ── 智能体档案 / 音色 / 对话与任务（与手机端同构的初始值）──
  llmProfiles: [],
  llmActiveProfileId: '',
  profileMessages: {},
  downloadedVoices: [],
  activeCloudVoiceId: '',
  ttsCloudConfig: { ...DEFAULT_TTS_CLOUD_CONFIG },
  showThinking: false,
  thinkingLang: 'auto',
  moodFromChat: true,
  petTasks: [],
};

let cachedConfig: AppConfig | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 档案归一化（旧 6 字段档案向新形态升级，幂等）：剔除非法条目、字符串字段补空串、
 *  enabled 缺省视为启用、petAssetId 缺省为空（未绑定，由 UI 引导绑定）。
 *  返回 changed=true 表示发生过结构升级，启动时一次性回写磁盘。 */
function normalizeProfiles(value: unknown): { profiles: LlmProfile[]; changed: boolean } {
  if (!Array.isArray(value)) return { profiles: [], changed: Array.isArray(value) === false && value != null };
  let changed = false;
  const profiles: LlmProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      changed = true;
      continue;
    }
    const p = item as LlmProfile;
    if (typeof p.id !== 'string' || !p.id) {
      changed = true;
      continue;
    }
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey : '';
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : '';
    const model = typeof p.model === 'string' ? p.model : '';
    const petAssetId = typeof p.petAssetId === 'string' ? p.petAssetId : '';
    const enabled = p.enabled !== false;
    if (
      apiKey !== p.apiKey || baseUrl !== p.baseUrl || model !== p.model ||
      petAssetId !== p.petAssetId || enabled !== p.enabled
    ) {
      changed = true;
    }
    profiles.push({ ...p, apiKey, baseUrl, model, petAssetId, enabled });
  }
  return { profiles, changed };
}

/** 历史消息归一化（外部边界清洗：只保留 user/assistant 且 content 为字符串的条目） */
export function sanitizeMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as { role?: unknown; content?: unknown; reasoning?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string') continue;
    out.push({
      role: msg.role,
      content: msg.content,
      ...(typeof msg.reasoning === 'string' && msg.reasoning ? { reasoning: msg.reasoning } : {}),
    });
  }
  return out;
}

/** profileMessages 归一化：按档案 id 清洗消息（云端旧档可能类型不对） */
function normalizeProfileMessages(value: unknown): Record<string, StoredChatMessage[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, StoredChatMessage[]> = {};
  for (const [id, messages] of Object.entries(value as Record<string, unknown>)) {
    if (!id) continue;
    const clean = sanitizeMessages(messages);
    if (clean.length) out[id] = clean;
  }
  return out;
}

/** 已安装音色归一化：剔除无 id/无合法 config 的条目，补默认值 */
function normalizeVoices(value: unknown): InstalledVoice[] {
  if (!Array.isArray(value)) return [];
  const out: InstalledVoice[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as InstalledVoice;
    if (typeof v.id !== 'string' || !v.id) continue;
    const cfg = v.config as VoiceConfig | undefined;
    if (!cfg || typeof cfg !== 'object' || typeof cfg.engine !== 'string') continue;
    out.push({
      ...v,
      name: typeof v.name === 'string' && v.name ? v.name : v.id,
      installedAt: typeof v.installedAt === 'number' ? v.installedAt : Date.now(),
      config: { ...cfg, voiceId: typeof cfg.voiceId === 'string' ? cfg.voiceId : '' },
    });
  }
  return out;
}

/** 云 TTS 凭证归一化（engine 缺省 openai，其余字符串补空串） */
function normalizeTtsCloudConfig(value: unknown): TtsCloudConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<TtsCloudConfig>;
  return {
    engine: v.engine === 'gptsovits' ? 'gptsovits' : 'openai',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    model: typeof v.model === 'string' ? v.model : '',
  };
}

/** 动作数组归一化：清洗透传进来的非法 builtinPetId（其余字段维持既有透传行为） */
export function normalizePetActions(value: unknown): PetAction[] {
  if (!Array.isArray(value)) return [];
  return (value as PetAction[]).map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.builtinPetId === undefined || typeof item.builtinPetId === 'string') return item;
    const next = { ...item };
    delete next.builtinPetId;
    return next;
  });
}

/** 定时任务归一化（必需字段缺失的条目直接丢弃） */
function normalizePetTasks(value: unknown): PetTask[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is PetTask =>
      !!t && typeof t === 'object' &&
      typeof (t as PetTask).id === 'string' &&
      typeof (t as PetTask).profileId === 'string' &&
      typeof (t as PetTask).due === 'number',
  );
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const { profiles, changed: profilesChanged } = normalizeProfiles(parsed.llmProfiles);
      const loaded: AppConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        petWindow: { ...DEFAULT_CONFIG.petWindow, ...(parsed.petWindow || {}) },
        petFeatures: { ...DEFAULT_CONFIG.petFeatures, ...(parsed.petFeatures || {}) },
        petActions: normalizePetActions(parsed.petActions),
        builtinPet: typeof parsed.builtinPet === 'string' && parsed.builtinPet ? parsed.builtinPet : undefined,
        // 标准动作模型（schemaVersion 2）：**校验失败即丢弃并告警**，绝不把坏配置带进运行期
        // （丢弃后运行时按 petActions 现场迁移，行为等价于旧配置）
        ...(() => {
          const model = (parsed as { petActionModel?: unknown }).petActionModel;
          if (model === undefined) return {};
          const result = validatePetActionModel(model);
          if (result.ok) return { petActionModel: model as PetActionModel };
          console.error(`[config] petActionModel 校验失败，已忽略该字段并回退到按动作列表迁移：\n- ${result.errors.join('\n- ')}`);
          return {};
        })(),
        petActionBindings: parsed.petActionBindings && typeof parsed.petActionBindings === 'object'
          ? (parsed.petActionBindings as PetActionBindings)
          : {},
        platform: { ...DEFAULT_CONFIG.platform, ...(parsed.platform || {}) },
        agentProactive: {
          enabled: parsed.agentProactive?.enabled ?? DEFAULT_CONFIG.agentProactive!.enabled,
          intervalMinutes: parsed.agentProactive?.intervalMinutes ?? DEFAULT_CONFIG.agentProactive!.intervalMinutes,
        },
        llmProfiles: profiles,
        llmActiveProfileId: typeof parsed.llmActiveProfileId === 'string' ? parsed.llmActiveProfileId : '',
        profileMessages: normalizeProfileMessages(parsed.profileMessages),
        downloadedVoices: normalizeVoices(parsed.downloadedVoices),
        activeCloudVoiceId: typeof parsed.activeCloudVoiceId === 'string' ? parsed.activeCloudVoiceId : '',
        ttsCloudConfig: normalizeTtsCloudConfig(parsed.ttsCloudConfig),
        showThinking: parsed.showThinking === true,
        thinkingLang: parsed.thinkingLang === 'zh' || parsed.thinkingLang === 'en' ? parsed.thinkingLang : 'auto',
        moodFromChat: parsed.moodFromChat !== false,
        petTasks: normalizePetTasks(parsed.petTasks),
      };
      if (loaded.platform.frontendUrl === 'http://localhost:5173') {
        loaded.platform.frontendUrl = DEFAULT_CONFIG.platform.frontendUrl;
      }
      // 先入缓存再回写：saveConfig 内部的 loadConfig 直接命中缓存，不会递归
      cachedConfig = loaded;
      // 旧 6 字段档案升级为新形态后一次性落盘（幂等：升级后 changed=false，不再写）
      if (profilesChanged) saveConfig(loaded);
    } else {
      cachedConfig = { ...DEFAULT_CONFIG };
      saveConfig(cachedConfig);
    }
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig!;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  cachedConfig = {
    ...current,
    ...config,
    userProfile: { ...current.userProfile, ...(config.userProfile || {}) },
    petState: { ...current.petState, ...(config.petState || {}) },
    petWindow: { ...current.petWindow, ...(config.petWindow || {}) },
    petFeatures: { ...current.petFeatures, ...(config.petFeatures || {}) },
    petActions: Array.isArray(config.petActions) ? config.petActions : current.petActions,
    petActionBindings: config.petActionBindings !== undefined
      ? (config.petActionBindings || {})
      : current.petActionBindings,
    platform: { ...current.platform, ...(config.platform || {}) },
    agentProactive: {
      enabled: config.agentProactive?.enabled ?? current.agentProactive?.enabled ?? true,
      intervalMinutes: config.agentProactive?.intervalMinutes ?? current.agentProactive?.intervalMinutes ?? 30,
    },
    petSenses: {
      screen: config.petSenses?.screen ?? current.petSenses?.screen ?? false,
      mic: config.petSenses?.mic ?? current.petSenses?.mic ?? false,
      camera: config.petSenses?.camera ?? current.petSenses?.camera ?? false,
    },
    petName: (config.petName ?? current.petName ?? '小宠').slice(0, 12),
    voiceWakeMode: config.voiceWakeMode ?? current.voiceWakeMode ?? 'once',
    // 档案与多档消息：整体替换语义（写入方必须给全量字典，删除档案消息才能生效）
    llmProfiles: config.llmProfiles !== undefined
      ? normalizeProfiles(config.llmProfiles).profiles
      : current.llmProfiles,
    profileMessages: config.profileMessages !== undefined
      ? normalizeProfileMessages(config.profileMessages)
      : current.profileMessages,
    // 音色库：整体替换（下载/删除即全量写回）
    downloadedVoices: config.downloadedVoices !== undefined
      ? normalizeVoices(config.downloadedVoices)
      : current.downloadedVoices ?? [],
    activeCloudVoiceId: config.activeCloudVoiceId !== undefined
      ? config.activeCloudVoiceId
      : current.activeCloudVoiceId ?? '',
    ttsCloudConfig: config.ttsCloudConfig !== undefined
      ? normalizeTtsCloudConfig({ ...(current.ttsCloudConfig || {}), ...config.ttsCloudConfig })
      : current.ttsCloudConfig,
    showThinking: config.showThinking ?? current.showThinking ?? false,
    thinkingLang: config.thinkingLang ?? current.thinkingLang ?? 'auto',
    moodFromChat: config.moodFromChat ?? current.moodFromChat ?? true,
    petTasks: config.petTasks !== undefined ? normalizePetTasks(config.petTasks) : current.petTasks ?? [],
  };
  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(cachedConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
  return cachedConfig;
}

/** 未配置 API 时的兜底系统提示词（保持基本人格，聊天会因缺少 Key 而提示配置） */
const FALLBACK_SYSTEM_PROMPT = '你是一个可爱的桌面宠物，用简短、俏皮的语气回复主人。';

/** 档案是否启用（旧档无该字段 = 启用） */
export function isProfileEnabled(profile: LlmProfile): boolean {
  return profile.enabled !== false;
}

/**
 * 生效档案选择（对齐手机端激活规则 + 启用态过滤）：
 * 1) llmActiveProfileId 指向且未停用 → 取它；
 * 2) 否则取首个未停用档案（激活档案被停用/删除时自动让位）；
 * 3) 全部停用或无档案 → 无生效档案（聊天给出未配置提示）。
 */
export function resolveActiveProfile(config?: AppConfig): LlmProfile | undefined {
  const cfg = config ?? loadConfig();
  const profiles = Array.isArray(cfg.llmProfiles) ? cfg.llmProfiles : [];
  if (!profiles.length) return undefined;
  const active = profiles.find((p) => p.id === cfg.llmActiveProfileId);
  if (active && isProfileEnabled(active)) return active;
  return profiles.find(isProfileEnabled);
}

/** 生效档案 id（'' = 无可用档案） */
export function resolveActiveProfileId(config?: AppConfig): string {
  return resolveActiveProfile(config)?.id ?? '';
}

/**
 * 聊天 LLM 生效配置：API 全部由用户在客户端配置（平台不提供任何默认 API）。
 * 只认 llmProfiles 档案列表：激活档案（未停用）优先，停用/删除后回落首个启用档案；
 * 一个可用档案都没有时返回空配置（apiKey/baseUrl 为空，llmService 会给出明确提示）。
 * 已安装智能体只提供人设，不再覆盖 model/baseUrl/temperature。
 */
export function getLLMConfig(): LLMConfig {
  const config = loadConfig();
  const thinking = {
    showThinking: config.showThinking === true,
    thinkingLang: config.thinkingLang ?? 'auto',
  };
  const activeProfile = resolveActiveProfile(config);
  if (!activeProfile) {
    return {
      provider: 'openai',
      apiKey: '',
      baseUrl: '',
      model: '',
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      ...thinking,
    };
  }
  return {
    provider: 'openai',
    apiKey: activeProfile.apiKey || '',
    baseUrl: activeProfile.baseUrl || '',
    model: activeProfile.model || '',
    systemPrompt: activeProfile.systemPrompt || FALLBACK_SYSTEM_PROMPT,
    ...thinking,
  };
}
