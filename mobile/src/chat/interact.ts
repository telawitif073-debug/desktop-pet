/**
 * 宠物互动实装：喂食/玩耍/休息后触发智能体真实回应（流式写入聊天记录）。
 * 互动事件作为临时 user 消息发给 LLM 但不落库（聊天页只显示宠物的回应）；
 * 未配置 LLM 时静默跳过（仅状态数值变化）；TTS 开启时朗读回应。
 */
import { isConfigured, streamChat } from './llm';
import { scheduleUpload } from '../api/sync';
import { speak } from '../native/Voice';
import { useAppStore } from '../store/appStore';
import type { ChatMsg } from '../types';

export type PetAction = 'feed' | 'play' | 'rest';

/** 互动事件提示词：让模型以宠物身份回应这次互动 */
const ACTION_EVENT: Record<PetAction, string> = {
  feed: '（主人刚刚给你喂了吃的。请以宠物的身份用一两句话自然地回应这次互动，不要复述括号里的内容）',
  play: '（主人刚刚陪你玩了一会儿。请以宠物的身份用一两句话自然地回应这次互动，不要复述括号里的内容）',
  rest: '（主人让你休息了一会儿。请以宠物的身份用一两句话自然地回应这次互动，不要复述括号里的内容）',
};

export function petInteract(action: PetAction): void {
  if (!isConfigured()) return;
  const store = useAppStore.getState();
  // 上下文 = 现有历史（剔除旧报错消息）+ 互动事件（临时 user 消息，不落库）
  const history: ChatMsg[] = [
    ...store.messages.filter((m) => !(m.role === 'assistant' && m.error)),
    { role: 'user', content: ACTION_EVENT[action] },
  ];
  const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  store.appendMessages([{ id, role: 'assistant', content: '', pending: true, streaming: true }]);
  // 思考阶段计时（与聊天页一致：首个思考增量 → 首个正文增量），避免出现无秒数「已深度思考」
  let thinkStart = 0;
  let thinkEnd = 0;
  streamChat(history, {
    onReasoning: (d) => {
      if (!thinkStart) thinkStart = Date.now();
      useAppStore.getState().appendMessageChunk(id, { reasoningDelta: d });
    },
    onContent: (d) => {
      if (thinkStart && !thinkEnd) thinkEnd = Date.now();
      useAppStore.getState().appendMessageChunk(id, { contentDelta: d });
    },
  })
    .then(({ content, reasoning }) => {
      const cur = useAppStore.getState();
      const target = cur.messages.find((m) => m.id === id);
      // 有思考增量就一定有计时；非流式降级无增量时不显示用时
      const thinkSeconds = thinkStart
        ? Math.max(1, Math.round(((thinkEnd || Date.now()) - thinkStart) / 1000))
        : undefined;
      const patch: Partial<ChatMsg> = { pending: false, streaming: false };
      if (thinkSeconds) patch.thinkSeconds = thinkSeconds;
      if (!target?.content && content) patch.content = content;
      if (!target?.reasoning && reasoning) patch.reasoning = reasoning;
      cur.patchMessage(id, patch);
      const st = useAppStore.getState();
      if (st.ttsEnabled) {
        void speak(content, { rate: st.speechRate, pitch: st.speechPitch, voice: st.speechVoice || undefined });
      }
    })
    .catch(() => {
      // 互动回应失败静默丢弃占位消息（状态数值已变化，不打扰用户）
      useAppStore.getState().removeMessage(id);
    })
    .finally(() => scheduleUpload('chat_history'));
}
