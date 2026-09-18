import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';

// 从 config.installedAgentConfig 中解析当前生效的智能体信息
function resolveAgent(config: { installedAgentConfig?: unknown } | null) {
  const cfg = config?.installedAgentConfig;
  if (!cfg || typeof cfg !== 'object') return null;
  const fields = cfg as { name?: unknown; systemPrompt?: unknown };
  return {
    name: typeof fields.name === 'string' && fields.name ? fields.name : '自定义智能体',
    systemPrompt: typeof fields.systemPrompt === 'string' ? fields.systemPrompt : '',
    isCustom: fields.name === '自定义智能体',
  };
}

const SettingsPanel = () => {
  const { config, saveConfig, toggleSettings } = useChatStore();
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3000);
  };
  const [form, setForm] = useState({
    apiKey: config?.llm.apiKey || '',
    baseUrl: config?.llm.baseUrl || 'https://api.openai.com/v1',
    model: config?.llm.model || 'gpt-4o-mini',
    systemPrompt: config?.llm.systemPrompt || '',
    userName: config?.userProfile.name || '',
    proactiveEnabled: config?.agentProactive?.enabled ?? true,
    proactiveInterval: config?.agentProactive?.intervalMinutes ?? 30,
  });

  // 将自定义提示词（连同模型/接口地址）一键生成自定义智能体，立即生效
  const generateAgent = async () => {
    const prompt = form.systemPrompt.trim();
    if (!prompt) {
      showNotice('请先在下方填写自定义提示词，再生成自定义智能体');
      return;
    }
    await saveConfig({
      installedAgentConfig: {
        name: '自定义智能体',
        systemPrompt: prompt,
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      },
    });
    showNotice('自定义智能体已生成并立即生效');
  };

  // 移除自定义智能体：其提示词回填到自定义提示词输入框，避免内容丢失
  const removeAgent = async () => {
    const agent = resolveAgent(config);
    await saveConfig({ installedAgentConfig: undefined });
    if (agent?.systemPrompt) {
      setForm((prev) => ({ ...prev, systemPrompt: agent.systemPrompt }));
    }
    showNotice('已移除自定义智能体，恢复默认人格');
  };

  const handleSave = async () => {
    const agent = resolveAgent(config);
    await saveConfig({
      llm: {
        provider: 'openai',
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        model: form.model,
        systemPrompt: form.systemPrompt,
      },
      userProfile: { name: form.userName, preferences: config?.userProfile.preferences || {} },
      // 自定义智能体生效时，保存即自动同步其提示词与模型/接口配置，无需再点"生成"
      ...(agent?.isCustom
        ? {
            installedAgentConfig: {
              name: '自定义智能体',
              systemPrompt: form.systemPrompt.trim(),
              ...(form.model.trim() ? { model: form.model.trim() } : {}),
              ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
            },
          }
        : {}),
      agentProactive: {
        enabled: form.proactiveEnabled,
        intervalMinutes: Math.max(10, Number(form.proactiveInterval) || 30),
      },
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
      {notice && (
        <div style={{ padding: '6px 10px', marginBottom: '10px', borderRadius: '4px', background: '#2b3a4a', color: '#9fd0ff', fontSize: '12px' }}>
          {notice}
        </div>
      )}
      <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', color: '#eee' }}>
        设置
      </div>

      {/* 当前生效的智能体状态 + 自定义智能体生成/移除操作 */}
      {(() => {
        const agent = resolveAgent(config);
        const btnStyle: React.CSSProperties = {
          width: '100%', padding: '6px', borderRadius: '4px', fontSize: '12px',
          cursor: 'pointer', marginTop: '8px',
          border: agent ? '1px solid #666' : 'none',
          background: agent ? '#333' : '#4a9eff',
          color: agent ? '#ccc' : 'white',
        };
        return (
          <div style={{ padding: '8px 10px', marginBottom: '10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
            <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>当前智能体</div>
            <div style={{ fontSize: '12px', color: agent ? '#7ec8ff' : '#888' }}>
              {agent ? `${agent.name}（已生效）` : '默认宠物人格（未启用智能体）'}
            </div>
            {agent && !agent.isCustom && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                该智能体来自资源库安装，可在个人中心-已下载资源中卸载；其提示词与参数会覆盖下方手动配置。
              </div>
            )}
            {agent && agent.isCustom && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                由自定义提示词生成，模型/接口地址取自下方表单；移除后提示词会自动回填。
              </div>
            )}
            {!agent && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                填写下方自定义提示词后，可一键生成为自定义智能体（立即生效，无需上传审核）。
              </div>
            )}
            {!agent || agent.isCustom ? (
              <button
                type="button"
                onClick={agent?.isCustom ? removeAgent : generateAgent}
                style={btnStyle}
              >
                {agent?.isCustom ? '移除自定义智能体（恢复默认人格）' : '将自定义提示词生成为自定义智能体'}
              </button>
            ) : null}
          </div>
        );
      })()}

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

      {/* 智能体主动发起对话：定时气泡（状态低值提醒），仅唤醒时段 8-22 点 */}
      <div style={{ marginTop: '12px', padding: '8px 10px', border: '1px solid #444', borderRadius: '4px', background: '#252525' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: '#ddd', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.proactiveEnabled}
            onChange={(e) => setForm({ ...form, proactiveEnabled: e.target.checked })}
          />
          允许宠物主动发起对话（气泡消息）
        </label>
        {form.proactiveEnabled && (
          <>
            <label style={labelStyle}>主动发起间隔（分钟，最小 10）</label>
            <input
              type="number"
              min={10}
              value={form.proactiveInterval}
              onChange={(e) => setForm({ ...form, proactiveInterval: Number(e.target.value) })}
              style={inputStyle}
            />
          </>
        )}
      </div>

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
  const agent = resolveAgent(config);

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
          {showSettings ? '设置' : agent ? `聊天 · ${agent.name}` : '聊天'}
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
