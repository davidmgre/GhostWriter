import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Send, Ghost, User, GripVertical, Eraser, Circle, Square, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

const SESSION_KEY = 'ai-chat-messages';

function loadSessionMessages() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessionMessages(msgs) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(msgs));
  } catch {
    // sessionStorage full or unavailable
  }
}

let _msgId = Date.now();
function nextId() {
  return String(++_msgId);
}

// Markdown message component — memoized to avoid re-rendering every message on each token
const ChatMessage = memo(function ChatMessage({ msg, isStreaming }) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div className="flex items-center gap-1.5">
        {!isUser && (
          isError
            ? <AlertCircle size={12} className="text-red-400" />
            : <Ghost size={12} className="text-blue-400" />
        )}
        <span className={`text-[10px] font-medium ${isUser ? 'text-blue-400' : isError ? 'text-red-400' : 'text-neutral-500'}`}>
          {isUser ? 'You' : isError ? 'Error' : 'AI'}
        </span>
        <span className="text-[10px] text-neutral-700">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div
        className={`text-sm px-3 py-2 rounded-lg max-w-[85%] break-words ${
          isUser
            ? 'bg-[#1e3a5f] text-blue-100 border border-blue-500/20'
            : isError
              ? 'bg-red-500/10 text-red-300 border border-red-500/20'
              : 'bg-[#1a1a1a] text-neutral-300 border border-[#262626]'
        }`}
      >
        {isUser || isError ? (
          <span className="whitespace-pre-wrap">{msg.content}</span>
        ) : (
          <div className="chat-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {msg.content || ''}
            </ReactMarkdown>
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse rounded-sm align-text-bottom" />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default function ChatPanel({ fullWidth = false }) {
  const [messages, setMessages] = useState(loadSessionMessages);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [waiting, setWaiting] = useState(false); // true between send and first token
  const [backendName] = useState('Kiro');
  const [backendStatus, setBackendStatus] = useState('unknown'); // 'connected' | 'error' | 'unknown'
  const [panelWidth, setPanelWidth] = useState(320);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const isResizing = useRef(false);
  const abortRef = useRef(null);

  // Persist messages to sessionStorage
  useEffect(() => {
    saveSessionMessages(messages);
  }, [messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, waiting]);

  // Test connection on mount
  useEffect(() => {
    setBackendStatus('unknown');
    fetch(`${API_BASE}/ai/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(result => setBackendStatus(result.ok ? 'connected' : 'error'))
      .catch(() => setBackendStatus('error'));
  }, []);

  // Resize handler
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    function handleMouseMove(e) {
      if (!isResizing.current) return;
      const delta = startX - e.clientX;
      const newWidth = Math.max(240, Math.min(600, startWidth + delta));
      setPanelWidth(newWidth);
    }

    function handleMouseUp() {
      isResizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth]);

  // Send message with streaming
  async function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg = { id: nextId(), role: 'user', content: text, timestamp: new Date().toISOString() };
    const assistantMsg = { id: nextId(), role: 'assistant', content: '', timestamp: new Date().toISOString() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setStreaming(true);
    setWaiting(true);

    // Build history from previous messages (exclude the new ones)
    const history = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let gotError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'token' && parsed.text) {
              if (waiting) setWaiting(false);
              accumulated += parsed.text;
              const content = accumulated;
              setMessages(prev =>
                prev.map(m => m.id === assistantMsg.id ? { ...m, content } : m)
              );
            } else if (parsed.type === 'error') {
              gotError = true;
              setMessages(prev =>
                prev.map(m => m.id === assistantMsg.id
                  ? { ...m, role: 'error', content: parsed.text }
                  : m
                )
              );
              break;
            }
            // 'done' — just stop reading
            if (parsed.type === 'done') break;
          } catch {
            // Ignore malformed chunks
          }
        }
      }

      // If no content was generated and no error was shown, show a fallback message
      if (!accumulated && !gotError) {
        setMessages(prev =>
          prev.map(m => m.id === assistantMsg.id
            ? { ...m, role: 'error', content: 'No response from AI backend. Check your settings.' }
            : m
          )
        );
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled — mark with partial indicator
        setMessages(prev =>
          prev.map(m => m.id === assistantMsg.id
            ? { ...m, content: m.content + '\n\n*(cancelled)*' }
            : m
          )
        );
      } else {
        setMessages(prev =>
          prev.map(m => m.id === assistantMsg.id
            ? { ...m, role: 'error', content: err.message }
            : m
          )
        );
      }
    } finally {
      setStreaming(false);
      setWaiting(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function handleStop() {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }

  function handleNewChat() {
    if (streaming) handleStop();
    setMessages([]);
    sessionStorage.removeItem(SESSION_KEY);
    // Reset Kiro session — creates a fresh context while keeping MCP loaded
    fetch(`${API_BASE}/ai/reset`, { method: 'POST' }).catch(() => {});
    inputRef.current?.focus();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  }

  // Group messages by date
  let lastDate = '';

  function formatDate(timestamp) {
    const d = new Date(timestamp);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <div
      className={`border-l border-[#262626] flex flex-col bg-[#0a0a0a] relative ${fullWidth ? 'w-full' : 'shrink-0'}`}
      style={fullWidth ? undefined : { width: panelWidth }}
    >
      {/* Resize handle */}
      {!fullWidth && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/30 transition-colors z-10 group"
        >
          <div className="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical size={12} className="text-neutral-600" />
          </div>
        </div>
      )}

      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-[#262626] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-neutral-400">👻 GhostWriter</span>
          {backendName && (
            <span className="flex items-center gap-1" title={
              backendStatus === 'connected' ? 'Connected' :
              backendStatus === 'error' ? 'Connection failed — check Settings' :
              'Checking connection...'
            }>
              <Circle size={6} className={
                backendStatus === 'connected' ? 'text-green-500 fill-green-500' :
                backendStatus === 'error' ? 'text-red-500 fill-red-500' :
                'text-yellow-500 fill-yellow-500 animate-pulse'
              } />
              <span className="text-[10px] text-neutral-600">{backendName}</span>
            </span>
          )}
        </div>
        <button
          onClick={handleNewChat}
          className="p-1.5 rounded hover:bg-[#1a1a1a] text-neutral-600 hover:text-neutral-400 transition-colors"
          title="New Chat"
        >
          <Eraser size={14} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-neutral-600 text-xs mt-8">
            <Ghost size={24} className="mx-auto mb-2 text-neutral-700" />
            <p>No messages yet.</p>
            <p className="mt-1 text-neutral-700">
              Ask GhostWriter about your document.
            </p>
          </div>
        )}
        {messages.map((msg) => {
          const msgDate = formatDate(msg.timestamp);
          let showDateSep = false;
          if (msgDate !== lastDate) {
            lastDate = msgDate;
            showDateSep = true;
          }

          const isStreamingThis = streaming && msg.role === 'assistant' && msg.id === messages[messages.length - 1]?.id;

          return (
            <div key={msg.id}>
              {showDateSep && (
                <div className="flex items-center gap-3 my-3">
                  <div className="flex-1 h-px bg-[#1a1a1a]" />
                  <span className="text-[10px] text-neutral-700 shrink-0">{msgDate}</span>
                  <div className="flex-1 h-px bg-[#1a1a1a]" />
                </div>
              )}
              <ChatMessage msg={msg} isStreaming={isStreamingThis} />
            </div>
          );
        })}
        {waiting && (
          <div className="flex flex-col gap-1 items-start">
            <div className="flex items-center gap-1.5">
              <Ghost size={12} className="text-blue-400" />
              <span className="text-[10px] font-medium text-neutral-500">AI</span>
            </div>
            <div className="bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-2 flex items-center gap-1.5">
              <span className="text-sm text-neutral-500">Thinking</span>
              <span className="flex gap-0.5 ml-0.5">
                <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
                <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }} />
                <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }} />
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={sendMessage} className="p-3 border-t border-[#1a1a1a]">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask GhostWriter..."
            rows={1}
            className="flex-1 bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-[#404040] transition-colors min-w-0 resize-none max-h-28 overflow-y-auto"
          />
          {streaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="p-2 rounded-lg bg-red-600 hover:bg-red-500 transition-colors shrink-0"
              title="Stop generating"
            >
              <Square size={14} className="text-white" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              <Send size={14} className="text-white" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
