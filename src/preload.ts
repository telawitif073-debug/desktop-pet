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
  // Window drag (fallback)
  moveWindow: (data: { screenX: number; screenY: number; offsetX: number; offsetY: number }) =>
    ipcRenderer.send('move-window', data),

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

  // Pet state sync
  pet: {
    stateUpdate: (state: { hunger: number; mood: number; energy: number; affection: number }) =>
      ipcRenderer.invoke('pet:state-update', state),
  },

  // Window control
  window: {
    toggleChat: (open: boolean) => ipcRenderer.invoke('window:toggle-chat', open),
    isChatOpen: () => ipcRenderer.invoke('window:is-chat-open'),
  },

  // Event listeners
  onChatChunk: createListener('chat:chunk'),
  onGreetingTrigger: createListener('chat:greeting-trigger'),
});
