import { describe, expect, it } from 'vitest';
import { moodDeltaFromText } from './moodLink';

describe('moodDeltaFromText 聊天联动宠物心情（口径对齐手机端）', () => {
  it('命中正面词返回 +8（包含叠词与语气词）', () => {
    expect(moodDeltaFromText('谢谢你，我好开心呀')).toBe(8);
    expect(moodDeltaFromText('哈哈，主人真棒')).toBe(8);
  });

  it('命中负面词返回 -8', () => {
    expect(moodDeltaFromText('我有点生气了，不想理你')).toBe(-8);
    expect(moodDeltaFromText('好委屈，想哭')).toBe(-8);
  });

  it('正负词同时出现视为中性，不调整', () => {
    expect(moodDeltaFromText('我虽然生气，但现在很开心')).toBe(0);
  });

  it('无情绪词或空文本不调整', () => {
    expect(moodDeltaFromText('今天的天气是晴。')).toBe(0);
    expect(moodDeltaFromText('')).toBe(0);
  });

  it('只取正文前 300 字（长文尾部偶发词不参与判定）', () => {
    const long = '嗯。'.repeat(200) + '我很开心';
    expect(moodDeltaFromText(long)).toBe(0);
    expect(moodDeltaFromText('我很开心' + '嗯。'.repeat(200))).toBe(8);
  });
});