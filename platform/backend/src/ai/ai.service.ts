import { Injectable } from '@nestjs/common';

/** 生成形态：image=单图（Canvas 参数化） gif=多帧动图 live2d=轻量 Live2D 包 model3d=3D 模型（GLB） */
export type PetGenFormat = 'image' | 'gif' | 'live2d' | 'model3d';

/** 形象参数：由 LLM 根据文字描述产出，前端 Canvas 按参数绘制卡通宠物 */
export interface PetDesign {
  name: string;
  /** 物种原型：决定整体轮廓（头身一体/两段式、鳍肢/四肢、喙/吻等），不同物种外形差异显著 */
  species: 'cat' | 'rabbit' | 'bear' | 'fox' | 'panda' | 'dragon' | 'penguin' | 'bird' | 'slime' | 'aquatic';
  bodyColor: string;
  bellyColor: string;
  earShape: 'pointy' | 'round' | 'long' | 'none';
  earColor: string;
  eyeColor: string;
  pattern: 'none' | 'stripes' | 'spots';
  patternColor: string;
  hasTail: boolean;
  tailStyle: 'curl' | 'straight' | 'fluffy' | 'none';
  /** 翅膀（龙/鸟等），画在身体后侧 */
  hasWings: boolean;
  /** 四肢/鳍颜色（缺省跟随 bodyColor，熊猫为黑色） */
  pawColor: string;
  cheek: boolean;
  desc: string;
}

/** 细化结果（分步生成步骤一）：识别物种 + 细化描述 + 确认问题（≤3） + 形象参数初稿 */
export interface PetRefineResult {
  species: PetDesign['species'];
  refined: string;
  questions: string[];
  design: PetDesign;
}

/** GIF 动效参数：前端按参数逐帧渲染后编码为动图 */
export interface PetMotion {
  bounceAmp: number;   // 上下弹跳幅度 px（0-30）
  bounceSpeed: number; // 弹跳速度（0.5-3）
  blinkRate: number;   // 眨眼频率 次/10s（0-6）
  tailWag: number;     // 尾巴摆动幅度 deg（0-30）
  tailSpeed: number;   // 尾巴速度（0.5-3）
  swayAmp: number;     // 左右摇摆幅度 px（0-20）
}

/** live2d-lite 绑定参数：客户端轻量渲染器按参数驱动分层部件 */
export interface PetRig {
  breathAmp: number;     // 呼吸缩放幅度（0-0.15）
  breathSpeed: number;   // 呼吸速度（0.5-3）
  blinkInterval: number; // 眨眼间隔 s（2-8）
  headTiltAmp: number;   // 头部摆动幅度 deg（0-10）
  headTiltSpeed: number; // 头部速度（0.5-3）
  tailWagAmp: number;    // 尾巴摆动幅度 deg（0-30）
  tailSpeed: number;     // 尾巴速度（0.5-3）
  swayAmp: number;       // 整体摇摆幅度 px（0-15）
}

/** 3D 模型比例参数：前端 three.js 程序化建模 */
export interface PetModel3D {
  headSize: number;   // 头身比（0.7-1.5）
  bodyChub: number;   // 身体圆润度（0.8-1.3）
  earLength: number;  // 耳朵长度系数（0.6-1.6）
  tailLength: number; // 尾巴长度系数（0.5-1.6）
  eyeSize: number;    // 眼睛大小系数（0.7-1.5）
  idleBounce: number; // 待机弹跳幅度（0-0.1）
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const SPECIES_OPTIONS = ['cat', 'rabbit', 'bear', 'fox', 'panda', 'dragon', 'penguin', 'bird', 'slime', 'aquatic'] as const;

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
}

function oneOf<T extends string>(v: unknown, options: T[], fallback: T): T {
  return typeof v === 'string' && (options as string[]).includes(v) ? (v as T) : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** 数值钳制：保证 LLM 产出的形象参数安全可用 */
export function clampPetDesign(raw: unknown): PetDesign {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bodyColor = color(f.bodyColor, '#ffaa55');
  return {
    name: (typeof f.name === 'string' && f.name.trim().slice(0, 30)) || '我的宠物',
    species: oneOf(f.species, [...SPECIES_OPTIONS], 'cat'),
    bodyColor,
    bellyColor: color(f.bellyColor, '#ffe6c8'),
    earShape: oneOf(f.earShape, ['pointy', 'round', 'long', 'none'], 'pointy'),
    earColor: color(f.earColor, bodyColor),
    eyeColor: color(f.eyeColor, '#332211'),
    pattern: oneOf(f.pattern, ['none', 'stripes', 'spots'], 'none'),
    patternColor: color(f.patternColor, '#dd8833'),
    hasTail: bool(f.hasTail, true),
    tailStyle: oneOf(f.tailStyle, ['curl', 'straight', 'fluffy', 'none'], 'curl'),
    hasWings: bool(f.hasWings, false),
    pawColor: color(f.pawColor, bodyColor),
    cheek: bool(f.cheek, true),
    desc: (typeof f.desc === 'string' && f.desc.slice(0, 60)) || '',
  };
}

export function clampPetMotion(raw: unknown): PetMotion {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    bounceAmp: num(f.bounceAmp, 8, 0, 30),
    bounceSpeed: num(f.bounceSpeed, 1.2, 0.5, 3),
    blinkRate: num(f.blinkRate, 2, 0, 6),
    tailWag: num(f.tailWag, 14, 0, 30),
    tailSpeed: num(f.tailSpeed, 1.5, 0.5, 3),
    swayAmp: num(f.swayAmp, 4, 0, 20),
  };
}

export function clampPetRig(raw: unknown): PetRig {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    breathAmp: num(f.breathAmp, 0.05, 0, 0.15),
    breathSpeed: num(f.breathSpeed, 1.2, 0.5, 3),
    blinkInterval: num(f.blinkInterval, 4, 2, 8),
    headTiltAmp: num(f.headTiltAmp, 4, 0, 10),
    headTiltSpeed: num(f.headTiltSpeed, 0.8, 0.5, 3),
    tailWagAmp: num(f.tailWagAmp, 12, 0, 30),
    tailSpeed: num(f.tailSpeed, 1.2, 0.5, 3),
    swayAmp: num(f.swayAmp, 3, 0, 15),
  };
}

export function clampPetModel3D(raw: unknown): PetModel3D {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    headSize: num(f.headSize, 1.0, 0.7, 1.5),
    bodyChub: num(f.bodyChub, 1.0, 0.8, 1.3),
    earLength: num(f.earLength, 1.0, 0.6, 1.6),
    tailLength: num(f.tailLength, 1.0, 0.5, 1.6),
    eyeSize: num(f.eyeSize, 1.0, 0.7, 1.5),
    idleBounce: num(f.idleBounce, 0.04, 0, 0.1),
  };
}

/** 各形态的参数输出要求（追加在形象设计提示词之后） */
const FORMAT_FIELDS: Record<PetGenFormat, string> = {
  image: '',
  gif: `
另需输出 motion 动效参数对象（与形象同级）：
"motion":{"bounceAmp":8,"bounceSpeed":1.2,"blinkRate":2,"tailWag":14,"tailSpeed":1.5,"swayAmp":4}
- bounceAmp: 上下弹跳幅度 0-30（活泼的宠物更大）
- bounceSpeed: 弹跳速度 0.5-3；blinkRate: 每 10 秒眨眼次数 0-6
- tailWag: 尾巴摆动幅度 0-30（度）；tailSpeed: 0.5-3
- swayAmp: 左右摇摆幅度 0-20（慵懒/庄重的宠物接近 0）
动效要贴合性格：元气宠物弹跳大频率高，慵懒宠物轻微摇摆。`,
  live2d: `
另需输出 rig 绑定动效参数对象（与形象同级），用于 Live2D 式分层待机动画：
"rig":{"breathAmp":0.05,"breathSpeed":1.2,"blinkInterval":4,"headTiltAmp":4,"headTiltSpeed":0.8,"tailWagAmp":12,"tailSpeed":1.2,"swayAmp":3}
- breathAmp: 呼吸起伏 0-0.15；breathSpeed: 0.5-3
- blinkInterval: 眨眼间隔秒 2-8；headTiltAmp: 头部轻摆角度 0-10；headTiltSpeed: 0.5-3
- tailWagAmp: 尾巴摆幅 0-30；tailSpeed: 0.5-3；swayAmp: 身体左右轻晃 0-15
参数要贴合性格：沉稳宠物幅度小速度慢，活泼宠物幅度大。`,
  model3d: `
另需输出 model3d 比例参数对象（与形象同级），用于 3D 建模比例：
"model3d":{"headSize":1.0,"bodyChub":1.0,"earLength":1.0,"tailLength":1.0,"eyeSize":1.0,"idleBounce":0.04}
- headSize: 头身比 0.7-1.5（Q 版宠物更大）；bodyChub: 圆润度 0.8-1.3
- earLength: 耳长系数 0.6-1.6（兔子更大）；tailLength: 尾长 0.5-1.6
- eyeSize: 眼睛大小 0.7-1.5；idleBounce: 待机弹跳 0-0.1`,
};

/** 可选风格：注入提示词影响 LLM 产出的配色与形状倾向（前端展示 label） */
export const PET_STYLES: Array<{ id: string; label: string; prompt: string }> = [
  { id: 'default', label: '默认可爱', prompt: '配色和谐明快，圆润可爱，符合大众审美的经典卡通桌宠。' },
  { id: 'pixel', label: '像素复古', prompt: '复古像素游戏风：高饱和对比色、大色块，花纹优先 stripes/spots 模拟像素感，desc 注明"像素风"。' },
  { id: 'flat', label: '扁平简约', prompt: '扁平化设计：纯色大色块无渐变，pattern 尽量 none，配色明快、对比强烈、造型极简。' },
  { id: 'doodle', label: '手绘涂鸦', prompt: '蜡笔手绘涂鸦风：柔和低饱和配色，cheek 必须为 true，pattern 优先 spots，憨态可掬。' },
  { id: 'dreamy', label: '梦幻马卡龙', prompt: '马卡龙梦幻风：低饱和粉彩色系（粉/薄荷/淡紫/奶油），形状圆润（round 耳优先），轻盈软萌。' },
  { id: 'cool', label: '酷炫暗黑', prompt: '暗黑酷炫风：深色系配色（黑/深紫/暗红/荧光点缀），earShape 优先 pointy，眼神犀利（eyeColor 亮色），desc 注明。' },
  { id: 'guofeng', label: '国风唯美写实', prompt: '国风唯美写实 CG 插画：精致五官、飘逸发丝/毛发、古典服饰与饰品纹理细节、柔和电影感光影、游戏立绘质感。' },
  { id: 'aidrama', label: 'AI 短剧写真', prompt: '仿真人 AI 短剧角色质感（对标精品短剧男女主）：写实 CG 皮感、白皙透亮零毛孔、杏仁大眼水润瞳孔、浓密睫毛、精致挺鼻、流畅小 V 脸、发丝根根分明、电影级柔光打光；女主柔美微垂眼尾，男主剑眉星目硬朗轮廓；服饰华贵细节丰富（古装刺绣华服或都市高定）。' },
];

/** 形象 JSON 示例（仅示意字段结构，值用占位文本防锚点；generate 提示词用） */
const DESIGN_EXAMPLE =
  '{"name":"（名字）","species":"cat","bodyColor":"#ffaa55","bellyColor":"#ffe6c8","earShape":"pointy","earColor":"#ffaa55","eyeColor":"#332211","pattern":"none","patternColor":"#dd8833","hasTail":true,"tailStyle":"curl","hasWings":false,"pawColor":"#ffaa55","cheek":true,"desc":"（一句话形象说明）"}';

/** 防锚点声明：弱模型（如 spark lite）会把示例值照抄进输出，必须显式禁止 */
const ANCHOR_RULE =
  '重要：上方示例仅示意 JSON 结构与字段格式，所有字段实际内容必须完全来自用户描述（描述是企鹅就输出 penguin 及其配色，是兔子就输出 rabbit），禁止把示例里的猫/橘色/占位文本代入用户请求。';

const SPECIES_RULES = [
  'species 物种原型决定整体轮廓，必须按描述选最贴近的一种，禁止一律输出 cat：',
  '- cat=猫/狗/狼等兽类（两段式头+椭圆身） rabbit=兔（long 长耳+小圆尾） bear=熊（round 圆耳+胖身） fox=狐（pointy 尖耳+fluffy 蓬松大尾） panda=熊猫（round 耳+pawColor 黑+earColor 黑+eyeColor 黑） dragon=龙/蜥蜴/幻想爬行（earShape pointy 作龙角+hasWings true+straight 长尾）',
  '- penguin=企鹅（直立水滴头身一体+鳍肢+橙喙+无外耳） bird=鸟/鸡/鸭（圆头身+喙+翅膀+尾羽） slime=史莱姆/果冻/圆团（头身一体半圆果冻+无耳无肢无尾） aquatic=鱼/鲸/海豚（流线纺锤头身一体+尾鳍+侧鳍+无腿）',
  '- hasWings: 有翅膀（龙/鸟/蝙蝠/天使等）输出 true，penguin 也有（鳍肢状）',
  '- earShape: pointy(尖耳/猫狐)/round(圆耳/熊鼠)/long(长耳/兔)/none(企鹅鸟鱼史莱姆等无外耳)',
  '- tailStyle: curl(卷尾/猫)/straight(直尾/狗)/fluffy(蓬松/狐松鼠)/none(企鹅鸟蛙等无尾)',
  '- pawColor: 四肢/鳍/翅颜色，通常与 bodyColor 相同，熊猫为黑色，企鹅鳍为 bodyColor 喙为橙',
];

const DESIGN_FIELD_RULES = [
  '- name: 宠物名字（简短）；desc: 一句话形象说明（30 字内）',
  '- bodyColor/bellyColor/earColor/eyeColor/patternColor: 6 位 hex 颜色（#rrggbb），配色要和谐可爱',
  '- pattern: 花纹 none/stripes(条纹)/spots(斑点)，patternColor 为花纹色；cheek: 是否有腮红',
];

const SPECIES_COMBO_RULE =
  '严格遵守物种特征组合（如"企鹅"=penguin+earShape none+鳍肢+喙，"史莱姆"=slime+全部 none+果冻团，"熊猫"=panda+pawColor 黑+earColor 黑），物种与描述不符视为错误输出。';

/** 提供商路由：全部走 OpenAI 兼容 /chat/completions 协议，baseUrl 可用 env AI_BASE_<PROVIDER> 覆盖 */
export interface ProviderRoute {
  provider: string;
  label: string;
  keyEnv: string;
  baseUrl: string;
  models: Array<{ id: string; label: string }>;
}

/** 多提供商模型注册表（id 全局唯一；模型名以各官方文档为准，baseUrl/Key 均可通过 env 切换） */
const PROVIDER_ROUTES: ProviderRoute[] = [
  {
    provider: 'deepseek', label: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat（通用·快）' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner（推理·慢）' },
      { id: 'deepseek-flash', label: 'deepseek-flash（V4）' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（V4 Pro）' },
    ],
  },
  {
    provider: 'dashscope', label: '阿里通义千问', keyEnv: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max', label: 'qwen3.8-max（旗舰）' },
      { id: 'qwen3.7-plus', label: 'qwen3.7-plus' },
      { id: 'qwen3.5-flash', label: 'qwen3.5-flash（快）' },
      { id: 'qwen-plus', label: 'qwen-plus（稳定名）' },
      { id: 'qwen-turbo', label: 'qwen-turbo（性价比）' },
    ],
  },
  {
    provider: 'zhipu', label: '智谱 GLM', keyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6（旗舰）' },
      { id: 'glm-4.5-air', label: 'GLM-4.5-Air' },
      { id: 'glm-4-flash', label: 'glm-4-flash（免费）' },
    ],
  },
  {
    provider: 'moonshot', label: '月之暗面 Kimi', keyEnv: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2-0905-preview', label: 'Kimi-K2' },
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
    ],
  },
  {
    provider: 'minimax', label: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M2', label: 'MiniMax-M2' },
      { id: 'MiniMax-Text-01', label: 'MiniMax-Text-01' },
    ],
  },
  {
    provider: 'ark', label: '字节豆包', keyEnv: 'ARK_API_KEY', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { id: 'doubao-seed-1-6', label: 'Doubao-Seed-1.6' },
      { id: 'doubao-seed-1-6-flash', label: 'Doubao-Seed-1.6-Flash' },
      { id: 'doubao-1-5-pro-32k', label: 'Doubao-1.5-pro-32k' },
    ],
  },
  {
    provider: 'qianfan', label: '百度文心', keyEnv: 'QIANFAN_API_KEY', baseUrl: 'https://qianfan.baidubce.com/v2',
    models: [
      { id: 'ernie-4.0-8k-latest', label: 'ERNIE-4.0' },
      { id: 'ernie-speed-128k', label: 'ERNIE-Speed-128K' },
    ],
  },
  {
    provider: 'spark', label: '讯飞星火', keyEnv: 'SPARK_API_KEY', baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: [
      { id: '4.0Ultra', label: 'Spark 4.0 Ultra' },
      { id: 'generalv3.5', label: 'Spark Max' },
      { id: 'lite', label: 'Spark Lite' },
    ],
  },
  {
    provider: 'hunyuan', label: '腾讯混元', keyEnv: 'HUNYUAN_API_KEY', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: [
      { id: 'hunyuan-turbo', label: 'Hunyuan-Turbo' },
      { id: 'hunyuan-lite', label: 'Hunyuan-Lite' },
    ],
  },
  {
    provider: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    ],
  },
  {
    provider: 'gemini', label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    ],
  },
  {
    provider: 'openrouter', label: 'OpenRouter（聚合）', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'x-ai/grok-4.3', label: 'Grok 4.3' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
  },
  {
    provider: 'siliconflow', label: 'SiliconFlow（聚合）', keyEnv: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5-72B' },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3' },
      { id: 'THUDM/glm-4-9b-chat', label: 'GLM-4-9B' },
    ],
  },
];

@Injectable()
export class AiService {
  /** 可选模型列表（按提供商分组；available 标记对应 API Key env 是否已配置） */
  listModels(): Array<{ provider: string; label: string; available: boolean; models: Array<{ id: string; label: string }> }> {
    return PROVIDER_ROUTES.map((r) => ({
      provider: r.provider,
      label: r.label,
      available: !!process.env[r.keyEnv],
      models: r.models,
    }));
  }

  /** 解析用户选择的模型 → 路由（模型/Key/baseUrl）；未指定时回退各形态默认 DeepSeek 模型 */
  private resolveRoute(requested: string | undefined, format: PetGenFormat): { model: string; baseUrl: string; apiKey: string } {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('后端未配置 DEEPSEEK_API_KEY，无法使用 AI 生成');
    const fallback = process.env[`AI_MODEL_${format.toUpperCase()}`] || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    const hit = requested && PROVIDER_ROUTES.flatMap((r) => r.models.map((m) => ({ ...m, route: r }))).find((m) => m.id === requested);
    if (hit) {
      const key = process.env[hit.route.keyEnv];
      if (!key) throw new Error(`${hit.route.label} 未配置 API Key（env ${hit.route.keyEnv}），请选择其他模型或配置后重试`);
      const baseUrl = (process.env[`AI_BASE_${hit.route.provider.toUpperCase()}`] || hit.route.baseUrl).replace(/\/+$/, '');
      return { model: hit.id, baseUrl, apiKey: key };
    }
    return { model: fallback, baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''), apiKey };
  }

  /** 调用文本 LLM 输出 JSON（容忍代码块与思维链包裹） */
  private async callLlm(route: { model: string; baseUrl: string; apiKey: string }, systemPrompt: string, userPrompt: string): Promise<unknown> {
    const { model, baseUrl, apiKey } = route;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        temperature: 1.0,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败(${res.status}): ${text.slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : cleaned;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('AI 输出中未找到形象配置');
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error('AI 输出的形象配置不是有效 JSON');
    }
  }

  /** 文字描述 → 宠物形象参数（按形态附加动效/绑定/比例参数，前端程序化生成资源；可选模型与风格；refined 为分步流程的细化描述，优先拼入） */
  async generatePetDesign(
    description: string,
    format: PetGenFormat,
    model?: string,
    style?: string,
    refined?: string,
  ): Promise<{
    design: PetDesign;
    motion?: PetMotion;
    rig?: PetRig;
    model3d?: PetModel3D;
  }> {
    // 风格注入：默认风格不额外注入，未知风格回退默认
    const styleDef = PET_STYLES.find((s) => s.id === style && s.id !== 'default');
    const styleLine = styleDef ? `\n风格要求：${styleDef.prompt}` : '';
    // 分步流程：细化描述优先，原始描述附后作参照
    const finalDesc = refined && refined.trim() ? `${refined.trim()}\n（用户原始描述：${description}）` : description;
    const prompt = [
      '你是宠物形象设计师。根据描述设计一只卡通桌宠形象。',
      `描述：${finalDesc}`,
      '只输出一个 JSON 对象，不要解释文字，格式：',
      DESIGN_EXAMPLE,
      ANCHOR_RULE,
      ...SPECIES_RULES,
      ...DESIGN_FIELD_RULES,
      SPECIES_COMBO_RULE,
      FORMAT_FIELDS[format],
    ].filter(Boolean).join('\n') + styleLine;

    const parsed = await this.callLlm(
      this.resolveRoute(model, format),
      '你是严格输出 JSON 的助手，不要输出任何 JSON 以外的内容。',
      prompt,
    );
    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const result: { design: PetDesign; motion?: PetMotion; rig?: PetRig; model3d?: PetModel3D } = {
      design: clampPetDesign(obj),
    };
    if (format === 'gif') result.motion = clampPetMotion(obj.motion);
    if (format === 'live2d') result.rig = clampPetRig(obj.rig);
    if (format === 'model3d') result.model3d = clampPetModel3D(obj.model3d);
    return result;
  }

  /** 步骤三（AI 精绘形态）：图像生成模型绘制成品插画（区别于 Canvas 几何拼图），后端转 dataUrl 便于前端直接展示/转文件。
   * kind=subject（默认）只画主体（人物或动物均可，纯色简洁背景便于抠图）；kind=scene 只画背景场景（无角色，独立文件）。
   * imagePrompt 为绘图智能体（painting-agent.ts，讯飞星火）产出的最终提示词，优先使用；缺省时按 framing 本地拼装兜底 */
  async generatePetImage(description: string, model?: string, style?: string, refined?: string, kind: 'subject' | 'scene' = 'subject', imagePrompt?: string, framing: 'full' | 'half' = 'full'): Promise<{ url: string; prompt: string; dataUrl: string }> {
    const styleDef = PET_STYLES.find((s) => s.id === style && s.id !== 'default');
    const styleLine = styleDef ? `画面风格：${styleDef.prompt}` : '';
    const base = (refined && refined.trim()) || description;
    const agentPrompt = imagePrompt && imagePrompt.trim();
    const prompt = kind === 'scene'
      ? [
          `桌宠背景场景插画：${base}所处的环境。`,
          '只画环境场景，不出现任何角色/动物/人物/宠物/文字；画面作为桌宠背后的背景使用，主体区域（中央偏下）留白较多、不放过多的抢眼细节，景深柔和，高质量数字插画，横版构图。',
          styleLine,
        ].join('')
      : agentPrompt || [
          `精致的角色立绘插画：${base}。`,
          `单个角色${framing === 'half' ? '半身构图（腰部以上）' : '全身构图（头到脚完整呈现）'}居中，正面视角（面向观众），尾巴/发梢/翅膀等所有延伸部位与画面四边留出空白边距、不得接触画面边缘，可以是人物或动物/幻想生物，五官与神态生动，造型精致讨喜，细节丰富，高质量数字插画。背景为如证件照般平涂均匀的浅绿色单色画布（#E9FFEB，绿幕抠像底色），主体不投影子、脚下无地面阴影、无光晕、无渐变、无地面、无任何场景/道具/环境，无文字无水印。`,
          styleLine,
        ].join('');

    // 图像路由：默认智谱 CogView-3-Flash（免费）；baseUrl 可用 AI_BASE_ZHIPU 覆盖，模型可用 AI_IMAGE_MODEL 覆盖
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) throw new Error('后端未配置 ZHIPU_API_KEY，无法使用 AI 精绘（免费模型 cogview-3-flash）');
    const usedModel = model || process.env.AI_IMAGE_MODEL || 'cogview-3-flash';
    const baseUrl = (process.env.AI_BASE_ZHIPU || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
    // 免费档有并发/频率限制（429 code 1302），退避重试两次
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt));
      res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: usedModel, prompt, size: '1024x1024' }),
      });
      if (res.status !== 429) break;
    }
    if (!res) throw new Error('图像生成请求未发出');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`图像生成失败(${res.status}): ${text.slice(0, 160)}`);
    }
    const data = (await res.json()) as { data?: Array<{ url?: string }> };
    const url = data.data?.[0]?.url;
    if (!url) throw new Error('图像生成接口未返回图片地址');
    // 代理下载转 base64：规避跨域，前端可直接 <img> 展示并转 File 填入上传表单
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`图片下载失败(${imgRes.status})`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    // CDN 的 content-type 可能与真实字节不符（如声明 png 实为 jpeg），按魔数修正
    const mime = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
      : buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
        : (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
    return { url, prompt, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }

  /** 步骤一：细化用户描述并识别物种（产出细化文案 + ≤3 个确认问题 + 形象参数初稿，供分步生成流程逐步确认） */
  async refinePetDesign(description: string, model?: string, style?: string): Promise<PetRefineResult> {
    const styleDef = PET_STYLES.find((s) => s.id === style && s.id !== 'default');
    const styleLine = styleDef ? `\n风格要求：${styleDef.prompt}` : '';
    const prompt = [
      '你是宠物形象设计师。用户给出了一段宠物描述，请完成三件事：',
      `用户描述：${description}`,
      '1. 将描述细化为一段更具体、更有画面感的设计文案（refined，60~150 字）：补充体型比例、五官表情、标志性特征等细节，但不得改变用户本意；用户已给出的动物物种与颜色必须原样保留，禁止替换或无视；',
      '2. 识别物种（species）并按该物种产出形象参数初稿（design，species 必须与识别结果一致）；',
      '3. 若描述存在多种合理解读或缺少会影响设计的关键信息，提出确认问题（questions，字符串数组，最多 3 个，每条一个简短具体的问题，如性格气质/花纹偏好）；信息足够则输出空数组 []。用户可能不回答，问题答案缺失时你的初稿需自行合理补全。',
      '重要：下方示例仅示意 JSON 结构与字段格式，species/refined/design 的实际内容必须完全来自用户描述（描述是企鹅就输出 penguin 并保留其颜色），禁止把示例里的猫/橘色等代入用户请求。',
      '只输出一个 JSON 对象，不要解释文字，格式：',
      '{"species":"cat","refined":"（此处填写围绕用户描述细化后的文案）","questions":["（可选问题，无则空数组）"],"design":{"name":"小橘","species":"cat","bodyColor":"#ffaa55","bellyColor":"#ffe6c8","earShape":"pointy","earColor":"#ffaa55","eyeColor":"#332211","pattern":"none","patternColor":"#dd8833","hasTail":true,"tailStyle":"curl","hasWings":false,"pawColor":"#ffaa55","cheek":true,"desc":"（一句话形象说明）"}}',
      SPECIES_COMBO_RULE,
      ...SPECIES_RULES,
      ...DESIGN_FIELD_RULES,
      FORMAT_FIELDS.image,
    ].filter(Boolean).join('\n') + styleLine;

    const parsed = await this.callLlm(
      this.resolveRoute(model, 'image'),
      '你是严格输出 JSON 的助手，不要输出任何 JSON 以外的内容。',
      prompt,
    );
    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    // design 参数在嵌套对象里；兼容 LLM 直接平铺输出的情况
    const designObj = (obj.design && typeof obj.design === 'object' ? obj.design : obj) as Record<string, unknown>;
    const rawSpecies = [obj.species, designObj.species].find(
      (s) => typeof s === 'string' && (SPECIES_OPTIONS as readonly string[]).includes(s),
    );
    const design = clampPetDesign({ ...designObj, species: rawSpecies });
    const refined = typeof obj.refined === 'string' && obj.refined.trim() ? obj.refined.trim().slice(0, 800) : description;
    const questions = Array.isArray(obj.questions)
      ? obj.questions.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, 3)
      : [];
    return { species: design.species, refined, questions, design };
  }
}
