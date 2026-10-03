/**
 * 智能体系统提示词拼装（主进程运行时与渲染端预览共用，改动需两侧同时生效）。
 * 角色（role）与说话风格（style）在手机端会注入人设；桌面端此前只用了 systemPrompt，
 * 这里统一成一处纯函数，避免「编辑器里填了却没生效」。
 */

export interface AgentPromptPartsInput {
  /** 人设主体（系统提示词） */
  systemPrompt?: string;
  /** 角色定位（医生/训练师/经纪人…） */
  role?: string;
  /** 说话风格（温柔/毒舌/专业…） */
  style?: string;
}

/** 返回按顺序拼装的提示词片段（已剔除空项） */
export function composeAgentPromptParts(input: AgentPromptPartsInput): string[] {
  const parts: string[] = [];
  const prompt = (input.systemPrompt ?? '').trim();
  if (prompt) parts.push(prompt);
  const role = (input.role ?? '').trim();
  if (role) parts.push(`你的角色定位：${role}。请始终以这个身份与口吻和主人交流。`);
  const style = (input.style ?? '').trim();
  if (style) parts.push(`说话风格：${style}。`);
  return parts;
}

/** 预览用：拼装为一段文本（与运行时注入顺序一致） */
export function composeAgentPrompt(input: AgentPromptPartsInput): string {
  return composeAgentPromptParts(input).join('\n\n');
}