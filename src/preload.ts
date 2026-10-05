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

  // Config
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial: Record<string, unknown>) => ipcRenderer.invoke('config:set', partial),
  },

  // Platform resource store
  platform: {
    search: (type: 'agent' | 'voice', query: string, page?: number) =>
      ipcRenderer.invoke('platform:search', type, query, page),
    getDetail: (type: 'agent' | 'voice', id: string) =>
      ipcRenderer.invoke('platform:getDetail', type, id),
    download: (type: 'agent' | 'voice', id: string) =>
      ipcRenderer.invoke('platform:download', type, id),
    install: (type: 'agent' | 'voice', id: string) =>
      ipcRenderer.invoke('platform:install', type, id),
    uninstall: (type: 'agent' | 'voice', id: string) =>
      ipcRenderer.invoke('platform:uninstall', type, id),
    getInstalledAgent: () => ipcRenderer.invoke('platform:getInstalledAgent'),
    login: (identifier: string, password: string) =>
      ipcRenderer.invoke('platform:login', identifier, password),
    logout: () => ipcRenderer.invoke('platform:logout'),
    openStore: () => ipcRenderer.invoke('platform:open-store'),
    /** 发布资源（创作中心「上传/发布」）：文件字节随 IPC 传入，主进程发 multipart 到平台 */
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

  // 创作中心：内嵌在资源中心窗口内容区（同一份桌面渲染包，不再单独开窗）
  workshop: {
    /** 资源中心页面测量内容区后上报：visible=false 摘掉视图；visible=true 按 rect 贴合并可指定落地工作区 */
    embed: (payload: {
      visible: boolean;
      rect?: { x: number; y: number; width: number; height: number };
      tab?: string;
    }) => ipcRenderer.invoke('workshop:embed', payload) as Promise<{ success: boolean }>,
  },

  // 宠物窗口 / 宠物库（桌宠功能模块）：窗口与库操作走 IPC，状态与消息走主进程广播
  pet: {
    getState: () => ipcRenderer.invoke('pet:get-state'),
    open: () => ipcRenderer.invoke('pet:open') as Promise<{ success: boolean }>,
    close: () => ipcRenderer.invoke('pet:close') as Promise<{ success: boolean }>,
    /** 互动动作：feed / play / rest */
    action: (kind: 'feed' | 'play' | 'rest') =>
      ipcRenderer.invoke('pet:action', kind) as Promise<{ success: boolean; vitals?: unknown }>,
    install: (id: string) => ipcRenderer.invoke('pet:install', id) as Promise<{ success: boolean; pet?: unknown }>,
    uninstall: (id: string) => ipcRenderer.invoke('pet:uninstall', id) as Promise<{ success: boolean }>,
    /** 主进程广播宠物状态变化（四维 / 就绪态 / 当前宠物） */
    onState: createListener('pet:state'),
    /** 主进程投递宠物消息（主动搭话等） */
    onMessage: createListener('pet:message'),
  },

  // Event listeners
  onChatChunk: createListener('chat:chunk'),
  /** 思考过程增量（reasoning_content/reasoning；与正文分流，受 showThinking 控制显示） */
  onChatReasoning: createListener('chat:reasoning'),
  /** 智能体主动对话消息（主进程定时投递，对话窗口据此追加显示） */
  onAgentMessage: createListener('chat:agent-message'),
  /** 创作中心窗口切换工作区（主进程按入口指定，如资源中心导航 → 智能体/音色） */
  onStudioWorkspace: createListener('studio:workspace'),
  /** 配置广播：任一窗口通过 config:set 写入后同步刷新其他窗口（避免旧副本覆盖新配置） */
  onConfigChanged: createListener('config:changed'),
});
