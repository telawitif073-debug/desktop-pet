import ChatPanel from './components/ChatPanel';

/**
 * 对话窗口入口：承载聊天 UI 与设置面板。
 * 原宠物窗口的聊天面板在此独立成普通窗口（宠物渲染已整体移除）。
 */
const App = () => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      background: '#1e1e1e',
      overflow: 'hidden',
    }}
  >
    <ChatPanel onClose={() => window.close()} />
  </div>
);

export default App;
