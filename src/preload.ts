import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { VoiceConfig } from './global.d';

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
    /** 重试失败回复：不重复写入用户消息，直接用历史里的末条问题重新补全 */
    retry: () => ipcRenderer.invoke('chat:retry'),
    clear: () => ipcRenderer.invoke('chat:clear'),
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

  // 宠物自我形象识别：渲染端传当前形象画布截图，主进程指纹去重后调多模态 LLM 记住外观
  self: {
    recognize: (dataUrl: string) =>
      ipcRenderer.invoke('self:recognize', dataUrl) as Promise<{
        ok: boolean;
        skipped?: boolean;
        description?: string;
        error?: string;
      }>,
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
    /** 发布资源（宠工坊「上传/发布」）：文件字节随 IPC 传入，主进程发 multipart 到平台 */
    upload: (payload: unknown) => ipcRenderer.invoke('platform:upload', payload),
    /** 平台账号状态（是否已登录 + 用户信息） */
    authStatus: () => ipcRenderer.invoke('platform:auth-status'),
    /** 读取本机保存的平台令牌（平台 Web 窗口启动时沿用桌面端登录态） */
    authTokens: () => ipcRenderer.invoke('platform:auth-tokens'),
    /** 平台 Web 窗口登录/续期后同步令牌到主进程 */
    syncAuth: (tokens: { accessToken: string; refreshToken?: string; user?: unknown }) =>
      ipcRenderer.invoke('platform:auth-sync', tokens),
    clearAuth: () => ipcRenderer.invoke('platform:auth-clear'),
  },

  // Pet state sync
  pet: {
    stateUpdate: (state: { hunger: number; mood: number; energy: number; affection: number }) =>
      ipcRenderer.invoke('pet:state-update', state),
    // 随机漫步：请求主进程平移窗口（主进程校验互斥/开关/精力），状态经 onWanderState 回报
    wanderStart: (opts: { dx: number; durationMs: number }) =>
      ipcRenderer.invoke('pet:wander-start', opts),
    onWanderState: createListener('pet:wander-state'),
    // 固定窗模型下的视觉缩放：主进程只持久化并广播新 side，渲染端平滑 resize 不重建
    onZoomChanged: createListener('pet:zoom-changed'),
  },

  // Pet actions（动作系统：手动上传帧序列 / 删除）
  actions: {
    addFrames: (name: string, files: Array<{ filename: string; data: Uint8Array }>) =>
      ipcRenderer.invoke('actions:add-frames', name, files),
    remove: (id: string) => ipcRenderer.invoke('actions:remove', id),
    /** 播放动作：动作只能在宠物窗渲染，由主进程转交宠物窗 */
    play: (id: string) => ipcRenderer.invoke('actions:play', id) as Promise<{ success: boolean }>,
  },

  // 内置演示宠物（离线可用，随包分发；与平台宠物互斥）
  builtin: {
    list: () => ipcRenderer.invoke('builtin:list'),
    apply: (id: string) => ipcRenderer.invoke('builtin:apply', id),
    reset: () => ipcRenderer.invoke('builtin:reset'),
  },

  // 上游美术资源库（从 GitHub「pet」项目导入的静态素材）：设为形象 / 加为动作
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    read: (file: string) => ipcRenderer.invoke('library:read', file),
    apply: (file: string, name?: string) => ipcRenderer.invoke('library:apply', file, name),
    addAction: (file: string, name?: string) => ipcRenderer.invoke('library:add-action', file, name),
  },

  // 语音合成：Edge（免费在线）与云音色（OpenAI 兼容 / GPT-SoVITS，用户自配凭证）
  tts: {
    speak: (args: { text: string; voice?: string; tone?: string; rate?: number; pitch?: number; volume?: number }) =>
      ipcRenderer.invoke('tts:speak', args) as Promise<string | null>,
    /** 云音色合成（OpenAI 兼容 /audio/speech 或自建 GPT-SoVITS）：Key 留在主进程 */
    cloudSpeak: (args: { text: string; config: VoiceConfig; speed?: number }) =>
      ipcRenderer.invoke('tts:cloud-speak', args) as Promise<{
        success: boolean;
        dataUrl?: string;
        error?: string;
      }>,
    /** GPT-SoVITS 引擎连通性测试 */
    testGptsovits: (baseUrl: string) =>
      ipcRenderer.invoke('tts:test-gptsovits', baseUrl) as Promise<{ online: boolean; message: string }>,
  },

  // 导出文本文件（智能体配置 .json 等）：系统保存对话框 → 写盘
  files: {
    saveText: (args: { defaultFileName: string; content: string; title?: string }) =>
      ipcRenderer.invoke('dialog:save-text', args) as Promise<{
        saved: boolean;
        path?: string;
        error?: string;
      }>,
  },

  // 宠工坊：内嵌在资源中心窗口内容区（同一份桌面渲染包，不再单独开窗）
  workshop: {
    /** 资源中心页面测量内容区后上报：visible=false 摘掉视图；visible=true 按 rect 贴合并可指定落地工作区 */
    embed: (payload: {
      visible: boolean;
      rect?: { x: number; y: number; width: number; height: number };
      tab?: string;
    }) => ipcRenderer.invoke('workshop:embed', payload) as Promise<{ success: boolean }>,
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
    /** Ctrl+滚轮缩放宠物窗：direction 1=放大 -1=缩小，主进程钳制 200-600 并持久化 */
    zoomPet: (direction: number) =>
      ipcRenderer.invoke('window:zoom-pet', direction) as Promise<{ success: boolean; width?: number; height?: number }>,
    showContextMenu: () => ipcRenderer.send('pet:show-context-menu'),
  },

  // Event listeners
  onChatChunk: createListener('chat:chunk'),
  /** 思考过程增量（reasoning_content/reasoning；与正文分流，受 showThinking 控制显示） */
  onChatReasoning: createListener('chat:reasoning'),
  /** 宠工坊窗口切换工作区（主进程按入口指定，如资源中心导航「宠工坊」→ 上传/发布） */
  onStudioWorkspace: createListener('studio:workspace'),
  /** 配置广播：任一窗口通过 config:set 写入后同步刷新其他窗口（避免旧副本覆盖新配置） */
  onConfigChanged: createListener('config:changed'),
  onPetSettingsChanged: createListener('pet:settings-changed'),
  onPetFeaturesChanged: createListener('pet:features-changed'),
  onPetAssetChanged: createListener('pet:asset-changed'),
  onPetContextAction: createListener('pet:context-action'),
  onPetActionsChanged: createListener('pet:actions-changed'),
  onPlayAction: createListener('pet:play-action'),
  onToggleActions: createListener('pet:toggle-actions'),
  onAgentMessage: createListener('pet:agent-message'),
  // 智能体变更通知：宠物重新「看一眼」自己（导出画布并请求形象识别）
  onSelfieRequest: createListener('pet:selfie-request'),
});
