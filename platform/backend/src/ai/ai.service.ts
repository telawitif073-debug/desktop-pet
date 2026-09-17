import { Injectable } from '@nestjs/common';

/** 形象参数：由 LLM 根据文字描述产出，前端 Canvas 按参数绘制卡通宠物 */
export interface PetDesign {
  name: string;
  bodyColor: string;
  bellyColor: string;
  earShape: 'pointy' | 'round' | 'long';
  earColor: string;
  eyeColor: string;
  pattern: 'none' | 'stripes' | 'spots';
  patternColor: string;
  hasTail: boolean;
  tailStyle: 'curl' | 'straight' | 'fluffy';
  cheek: boolean;
  desc: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
}

function oneOf<T extends string>(v: unknown, options: T[], fallback: T): T {
  return typeof v === 'string' && (options as string[]).includes(v) ? (v as T) : fallback;
}

/** 数值钳制：保证 LLM 产出的形象参数安全可用 */
export function clampPetDesign(raw: unknown): PetDesign {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    name: (typeof f.name === 'string' && f.name.trim().slice(0, 30)) || '我的宠物',
    bodyColor: color(f.bodyColor, '#ffaa55'),
    bellyColor: color(f.bellyColor, '#ffe6c8'),
    earShape: oneOf(f.earShape, ['pointy', 'round', 'long'], 'pointy'),
    earColor: color(f.earColor, '#ffaa55'),
    eyeColor: color(f.eyeColor, '#332211'),
    pattern: oneOf(f.pattern, ['none', 'stripes', 'spots'], 'none'),
    patternColor: color(f.patternColor, '#dd8833'),
    hasTail: f.hasTail !== false,
    tailStyle: oneOf(f.tailStyle, ['curl', 'straight', 'fluffy'], 'curl'),
    cheek: f.cheek !== false,
    desc: (typeof f.desc === 'string' && f.desc.slice(0, 60)) || '',
  };
}

@Injectable()
export class AiService {
  /** 文字描述 → 宠物形象参数（LLM 输出 JSON，服务端钳制校验后返回） */
  async generatePetDesign(description: string): Promise<PetDesign> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('后端未配置 DEEPSEEK_API_KEY，无法使用 AI 生成');
    }
    const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    const prompt = [
      '你是宠物形象设计师。根据描述设计一只卡通桌宠形象。',
      `描述：${description}`,
      '只输出一个 JSON 对象，不要解释文字，格式：',
      '{"name":"橘猫","bodyColor":"#ffaa55","bellyColor":"#ffe6c8","earShape":"pointy","earColor":"#ffaa55","eyeColor":"#332211","pattern":"stripes","patternColor":"#dd8833","hasTail":true,"tailStyle":"curl","cheek":true,"desc":"一只圆滚滚的橘猫"}',
      '字段规则：',
      '- name: 宠物名字（简短）；desc: 一句话形象说明（30 字内）',
      '- bodyColor/bellyColor/earColor/eyeColor/patternColor: 6 位 hex 颜色（#rrggbb），配色要和谐可爱',
      '- earShape: 耳朵形状 pointy(尖耳/猫狗) round(圆耳/熊鼠) long(长耳/兔)',
      '- pattern: 花纹 none/stripes(条纹)/spots(斑点)，patternColor 为花纹色',
      '- tailStyle: 尾巴 curl(卷尾/猫) straight(直尾/狗) fluffy(蓬松/狐狸)',
      '- cheek: 是否有腮红',
      '严格按照用户描述选择物种特征（如"熊猫"=黑白+圆耳，"兔子"=long 耳+短尾，"史莱姆"=round 耳+无尾+单色）。',
    ].join('\n');

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严格输出 JSON 的助手，不要输出任何 JSON 以外的内容。' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        temperature: 1.0,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败(${res.status}): ${text.slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';
    // 提取 JSON：容忍代码块与思维链包裹
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : cleaned;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('AI 输出中未找到形象配置');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error('AI 输出的形象配置不是有效 JSON');
    }
    return clampPetDesign(parsed);
  }
}
