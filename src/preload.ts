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
    send: (message: string) => ipcRenderer.invoke('chat:send', message),
    clear: () => ipcRenderer.invoke('chat:clear'),
    greet: () => ipcRenderer.invoke('chat:greet'),
    getHistory: () => ipcRenderer.invoke('chat:history'),
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
  },

  // Pet actions（动作系统：AI 生成变换动画 / 手动上传帧序列 / 删除）
  actions: {
    generate: (name: string) => ipcRenderer.invoke('actions:generate', name),
    addFrames: (name: string, files: Array<{ filename: string; data: Uint8Array }>) =>
      ipcRenderer.invoke('actions:add-frames', name, files),
    remove: (id: string) => ipcRenderer.invoke('actions:remove', id),
  },

  // AI 生成宠物（用户自备 Key 本地生成：任务式流水线 + 结果安装）
  aiGen: {
    generateSprite: (description: string, style?: string) =>
      ipcRenderer.invoke('ai:generate-sprite', description, style),
    generateLive2d: (description: string, style?: string) =>
      ipcRenderer.invoke('ai:generate-live2d', description, style),
    jobStatus: (jobId: string) => ipcRenderer.invoke('ai:gen-job-status', jobId),
    install: (jobId: string) => ipcRenderer.invoke('ai:gen-install', jobId),
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
