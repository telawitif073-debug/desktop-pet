import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Listener = (...args: unknown[]) => void;

function createListener(channel: string) {
  return (callback: Listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Chat
  chat: {
    send: (message: string, images?: string[]) => ipcRenderer.invoke('chat:send', message, images),
    clear: () => ipcRenderer.invoke('chat:clear'),
    greet: () => ipcRenderer.invoke('chat:greet'),
    getHistory: () => ipcRenderer.invoke('chat:history'),
  },

  // Sense（感知能力）
  sense: {
    captureScreen: () => ipcRenderer.invoke('sense:capture-screen'),
    /** 摄像头定时帧上送（主进程视觉理解后触发主动对话） */
    cameraFrame: (dataUrl: string) => ipcRenderer.invoke('sense:camera-frame', dataUrl),
  },

  // sherpa-onnx 离线语音识别（语音唤醒）：模型由用户在聊天设置导入，平台不内置
  sherpa: {
    /** 查询模型是否已导入（ok=false 时主进程节流气泡提示） */
    getModel: () => ipcRenderer.invoke('sherpa:get-model') as Promise<{ ok: boolean; path?: string }>,
    /** 导入模型包（本地 zip 路径或下载 URL），校验解压后模型目录就绪 */
    importModel: (source: string) =>
      ipcRenderer.invoke('sherpa:import-model', source) as Promise<{ ok: boolean; path?: string; error?: string }>,
  },

  // 云端语音识别（宠物「听懂说话」的在线来源）：渲染端只传音频，接口配置与 Key 留在主进程
  asr: {
    /** 转写一段 WAV 音频（base64），按设置的来源（在线接口/智能体自带）由主进程调用上游 */
    transcribe: (payload: { wavBase64: string }) =>
      ipcRenderer.invoke('asr:transcribe', payload) as Promise<{ ok: boolean; text?: string; error?: string }>,
  },

  // Config
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial: Record<string, unknown>) => ipcRenderer.invoke('config:set', partial),
  },

  // Platform resource store
  platform: {
    search: (type: 'pet' | 'agent', query: string, page?: number) =>
      ipcRenderer.invoke('platform:search', type, query, page),
    getDetail: (type: 'pet' | 'agent', id: string) =>
      ipcRenderer.invoke('platform:getDetail', type, id),
    download: (type: 'pet' | 'agent', id: string) =>
      ipcRenderer.invoke('platform:download', type, id),
    install: (type: 'pet' | 'agent', id: string) =>
      ipcRenderer.invoke('platform:install', type, id),
    uninstall: (type: 'pet' | 'agent', id: string) =>
      ipcRenderer.invoke('platform:uninstall', type, id),
    getInstalledPet: () => ipcRenderer.invoke('platform:getInstalledPet'),
    getInstalledAgent: () => ipcRenderer.invoke('platform:getInstalledAgent'),
    login: (identifier: string, password: string) =>
      ipcRenderer.invoke('platform:login', identifier, password),
    logout: () => ipcRenderer.invoke('platform:logout'),
    openStore: () => ipcRenderer.invoke('platform:open-store'),
  },

  // Pet state sync
  pet: {
    stateUpdate: (state: { hunger: number; mood: number; energy: number; affection: number }) =>
      ipcRenderer.invoke('pet:state-update', state),
    // 随机漫步：请求主进程平移窗口（主进程校验互斥/开关/精力），状态经 onWanderState 回报
    wanderStart: (opts: { dx: number; durationMs: number }) =>
      ipcRenderer.invoke('pet:wander-start', opts),
    onWanderState: createListener('pet:wander-state'),
    // 气泡窗口扩展：智能体气泡显示期间窗口向上扩展（底边锁定），返回实际扩展高度 px
    setBubbleExpand: (on: boolean) =>
      ipcRenderer.invoke('pet:set-bubble-expand', on) as Promise<number>,
    onBubbleExpandChanged: createListener('pet:bubble-expand-changed'),
  },

  // Pet actions（动作系统：手动上传帧序列 / 删除）
  actions: {
    addFrames: (name: string, files: Array<{ filename: string; data: Uint8Array }>) =>
      ipcRenderer.invoke('actions:add-frames', name, files),
    remove: (id: string) => ipcRenderer.invoke('actions:remove', id),
  },

  // Edge TTS 语音合成（免费在线，主进程合成 mp3；失败返回 null 由渲染端回退系统 TTS）
  tts: {
    speak: (args: { text: string; voice?: string; tone?: string; rate?: number; pitch?: number; volume?: number }) =>
      ipcRenderer.invoke('tts:speak', args) as Promise<string | null>,
  },

  // Window control
  window: {
    toggleChat: (open: boolean) => ipcRenderer.invoke('window:toggle-chat', open),
    toggleActions: (open: boolean) => ipcRenderer.invoke('window:toggle-actions', open),
    isChatOpen: () => ipcRenderer.invoke('window:is-chat-open'),
    setIgnoreMouseEvents: (ignore: boolean) => ipcRenderer.send('window:set-ignore-mouse', ignore),
    beginDrag: () => ipcRenderer.send('pet:begin-drag'),
    dragMove: (delta: { dx: number; dy: number }) => ipcRenderer.send('pet:drag-move', delta),
    endDrag: () => ipcRenderer.send('pet:end-drag'),
    showContextMenu: () => ipcRenderer.send('pet:show-context-menu'),
  },

  // Event listeners
  onChatChunk: createListener('chat:chunk'),
  onGreetingTrigger: createListener('chat:greeting-trigger'),
  onPetSettingsChanged: createListener('pet:settings-changed'),
  onPetFeaturesChanged: createListener('pet:features-changed'),
  onPetAssetChanged: createListener('pet:asset-changed'),
  onPetContextAction: createListener('pet:context-action'),
  onPetActionsChanged: createListener('pet:actions-changed'),
  onPlayAction: createListener('pet:play-action'),
  onToggleActions: createListener('pet:toggle-actions'),
  onAgentMessage: createListener('pet:agent-message'),
});
