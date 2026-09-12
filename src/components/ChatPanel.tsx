import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';

const SettingsPanel = () => {
  const { config, saveConfig, toggleSettings } = useChatStore();
  const [form, setForm] = useState({
    apiKey: config?.llm.apiKey || '',
    baseUrl: config?.llm.baseUrl || 'https://api.openai.com/v1',
    model: config?.llm.model || 'gpt-4o-mini',
    systemPrompt: config?.llm.systemPrompt || '',
    userName: config?.userProfile.name || '',
  });

  const handleSave = async () => {
    await saveConfig({
      llm: {
        provider: 'openai',
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        model: form.model,
        systemPrompt: form.systemPrompt,
      },
      userProfile: { name: form.userName, preferences: {} },
    });
    toggleSettings();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #555',
    borderRadius: '4px',
    background: '#2a2a2a',
    color: '#eee',
    fontSize: '12px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '11px',
    color: '#aaa',
    marginBottom: '3px',
    marginTop: '8px',
  };

  return (
    <div style={{ padding: '12px', overflowY: 'auto', height: '100%' }}>
      <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', color: '#eee' }}>
        设置
      </div>

      <label style={labelStyle}>API Key</label>
      <input
        type="password"
        value={form.apiKey}
        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        placeholder="sk-..."
        style={inputStyle}
      />

      <label style={labelStyle}>API Base URL</label>
      <input
        type="text"
        value={form.baseUrl}
        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        placeholder="https://api.openai.com/v1"
        style={inputStyle}
      />

      <label style={labelStyle}>模型</label>
      <input
        type="text"
        value={form.model}
        onChange={(e) => setForm({ ...form, model: e.target.value })}
        placeholder="gpt-4o-mini"
        style={inputStyle}
      />

      <label style={labelStyle}>你的名字</label>
      <input
        type="text"
        value={form.userName}
        onChange={(e) => setForm({ ...form, userName: e.target.value })}
        placeholder="主人"
        style={inputStyle}
      />

      <label style={labelStyle}>自定义提示词（可选）</label>
      <textarea
        value={form.systemPrompt}
        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        placeholder="额外的性格设定..."
        rows={3}
        style={{ ...inputStyle, resize: 'none' }}
      />

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <button
          onClick={handleSave}
          style={{
            flex: 1,
            padding: '6px',
            border: 'none',
            borderRadius: '4px',
            background: '#4a9eff',
            color: 'white',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          保存
        </button>
        <button
          onClick={toggleSettings}
          style={{
            flex: 1,
            padding: '6px',
            border: '1px solid #555',
            borderRadius: '4px',
            background: '#333',
            color: '#ccc',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
};

const MessageBubble = ({ message }: { message: { role: string; content: string; streaming?: boolean } }) => {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '6px',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '6px 10px',
          borderRadius: '10px',
          fontSize: '13px',
          lineHeight: '1.4',
          wordBreak: 'break-word',
          background: isUser ? '#4a9eff' : '#3a3a3a',
          color: isUser ? 'white' : '#eee',
          borderBottomRightRadius: isUser ? '2px' : '10px',
          borderBottomLeftRadius: isUser ? '10px' : '2px',
        }}
      >
        {message.content || (message.streaming ? '...' : '')}
        {message.streaming && message.content && (
          <span style={{ opacity: 0.5 }}>▎</span>
        )}
      </div>
    </div>
  );
};

const ChatPanel = ({ onClose }: { onClose: () => void }) => {
  const { messages, isLoading, showSettings, sendMessage, clearMessages, toggleSettings, loadConfig, loadHistory, config } = useChatStore();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const text = input;
    setInput('');
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isConfigured = config?.llm?.apiKey;

  return (
    <div
      style={{
        width: 350,
        height: '100%',
        background: '#1e1e1e',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        overflow: 'hidden',
        borderRight: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: '#252525',
          borderBottom: '1px solid #333',
...({ WebkitAppRegion: 'drag' } as React.CSSProperties),
        }}
      >
        <span style={{ fontSize: '13px', color: '#ddd', fontWeight: 600 }}>
          {showSettings ? '设置' : '聊天'}
        </span>
        <div style={{ display: 'flex', gap: '4px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!showSettings && (
            <>
              <button
                onClick={clearMessages}
                title="清空对话"
                style={headerBtnStyle}
              >
                清空
              </button>
              <button
                onClick={toggleSettings}
                title="设置"
                style={headerBtnStyle}
              >
                设置
              </button>
            </>
          )}
          {showSettings && (
            <button onClick={toggleSettings} style={headerBtnStyle}>
              返回
            </button>
          )}
          <button onClick={onClose} title="关闭" style={headerBtnStyle}>
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      {showSettings ? (
        <SettingsPanel />
      ) : (
        <>
          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px',
            }}
          >
            {messages.length === 0 && (
              <div
                style={{
                  textAlign: 'center',
                  color: '#666',
                  fontSize: '12px',
                  marginTop: '40px',
                }}
              >
                {isConfigured
                  ? '和宠物说点什么吧～'
                  : '请点击「设置」配置 API Key 后开始聊天'}
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: '8px',
              background: '#252525',
              borderTop: '1px solid #333',
              display: 'flex',
              gap: '6px',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConfigured ? '输入消息...' : '请先配置 API Key'}
              disabled={isLoading || !isConfigured}
              style={{
                flex: 1,
                padding: '6px 10px',
                border: '1px solid #444',
                borderRadius: '6px',
                background: '#1e1e1e',
                color: '#eee',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim() || !isConfigured}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderRadius: '6px',
                background: isLoading || !input.trim() || !isConfigured ? '#333' : '#4a9eff',
                color: isLoading || !input.trim() || !isConfigured ? '#666' : 'white',
                fontSize: '12px',
                cursor: isLoading || !input.trim() || !isConfigured ? 'not-allowed' : 'pointer',
              }}
            >
              发送
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const headerBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '1px solid #444',
  borderRadius: '4px',
  background: '#333',
  color: '#ccc',
  fontSize: '11px',
  cursor: 'pointer',
};

export default ChatPanel;
