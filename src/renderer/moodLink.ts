/**
 * 聊天联动宠物心情（FR-16）：正则口径与手机端 ChatScreen 完全一致——
 * 对回复正文前 300 字做正负情绪词匹配，正负同时出现视为中性不调整；命中则 ±8。
 */
const POSITIVE = /(开心|高兴|喜欢|谢谢|感谢|么么|愉快|爱你|真棒|好耶|嘻嘻|哈哈|摸摸|夸你|原谅你)/;
const NEGATIVE = /(生气|讨厌|不理你|不想理|烦死了|无聊|凶|哭|委屈|骂你|打你|坏主人)/;

/** 单次回复的心情增减（0 = 不调整）；limit 只取正文开头，避免长文里的偶然词命中 */
export function moodDeltaFromText(text: string, limit = 300): number {
  const sample = (text ?? '').slice(0, limit);
  if (!sample) return 0;
  const negative = NEGATIVE.test(sample);
  const positive = POSITIVE.test(sample);
  if (negative && !positive) return -8;
  if (positive && !negative) return 8;
  return 0;
}