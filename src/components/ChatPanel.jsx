import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Send, Ghost, User, GripVertical, Eraser, Circle, Square, AlertCircle, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

// Detect system 12h/24h preference: toLocaleTimeString() without options respects OS settings,
// so we format a 3 PM test time and check for AM/PM markers to detect the system preference.
const _systemUses12h = /[AP]M|[ap]m|오[전후]/.test(new Date(2000, 0, 1, 15, 0, 0).toLocaleTimeString());

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
    <div className={`flex flex-col gap-1 min-w-0 max-w-full ${isUser ? 'items-end' : 'items-start'}`}>
      <div className="flex items-center gap-1.5">
        {!isUser && (
          isError
            ? <AlertCircle size={12} className="text-red-400" />
            : <Ghost size={12} className="text-blue-400" />
        )}
        <span className={`text-[10px] font-medium ${isUser ? 'text-blue-400' : isError ? 'text-red-400' : 'text-neutral-500'}`}>
          {isUser ? 'You' : isError ? 'Error' : 'GhostWriter'}
        </span>
        <span className="text-[10px] text-neutral-700">
          {new Date(msg.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: _systemUses12h })}
        </span>
      </div>
      <div
        className={`text-sm px-3 py-2 rounded-lg break-words ${
          isUser
            ? 'max-w-[85%] bg-[#1e3a5f] text-blue-100 border border-blue-500/20'
            : isError
              ? 'max-w-[85%] bg-red-500/10 text-red-300 border border-red-500/20'
              : 'max-w-full overflow-hidden bg-[#1a1a1a] text-neutral-300 border border-[#262626]'
        }`}
      >
        {isUser || isError ? (
          <span className="whitespace-pre-wrap">{msg.content}</span>
        ) : (
          <div className="chat-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {msg.content || ''}
            </ReactMarkdown>
            {isStreaming && msg.content && (
              <span className="inline-block w-[2px] h-[1em] bg-blue-400/70 ml-0.5 animate-pulse align-text-bottom" />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default function ChatPanel({ fullWidth = false, currentDoc = null, documentContent = '' }) {
  const [messages, setMessages] = useState(loadSessionMessages);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [waiting, setWaiting] = useState(false); // true between send and first token
  const [backendName] = useState('Kiro');
  const [backendStatus, setBackendStatus] = useState('unknown'); // 'connected' | 'error' | 'unknown'
  const [editMode, setEditMode] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [panelWidth, setPanelWidth] = useState(320);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const isResizing = useRef(false);
  const abortRef = useRef(null);
  const confirmTimerRef = useRef(null);

  // Persist messages to sessionStorage
  useEffect(() => {
    saveSessionMessages(messages);
  }, [messages]);

  // Sync edit mode to server
  useEffect(() => {
    fetch(`${API_BASE}/edit-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: editMode }),
    }).catch(() => {});
  }, [editMode]);

  // Auto-dismiss clear confirmation after 3 seconds
  useEffect(() => {
    if (confirmClear) {
      confirmTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
      return () => clearTimeout(confirmTimerRef.current);
    }
  }, [confirmClear]);

  // Listen for edit-reverted SSE events
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);
    es.addEventListener('edit-reverted', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Add a system notification to the chat
        const revertMsg = {
          id: nextId(),
          role: 'error',
          content: data.message || 'Edit reverted — Read-Only mode is active.',
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, revertMsg]);
      } catch {}
    });
    return () => es.close();
  }, []);

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

  // Core send logic — accepts text directly so it can be called programmatically
  async function doSend(text, overrideEditMode) {
    if (!text || streaming) return;

    const userMsg = { id: nextId(), role: 'user', content: text, timestamp: new Date().toISOString() };
    const assistantMsg = { id: nextId(), role: 'assistant', content: '', timestamp: new Date().toISOString() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setStreaming(true);
    setWaiting(true);

    // Use override if provided (for toggle auto-send before state updates)
    const effectiveEditMode = overrideEditMode !== undefined ? overrideEditMode : editMode;

    // Build history from previous messages (exclude the new ones)
    const history = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Build context from current document
      const context = { editMode: effectiveEditMode };
      if (currentDoc) {
        context.documentTitle = currentDoc.title || currentDoc.id;
        context.documentId = currentDoc.id;
        if (documentContent) {
          // Send first ~2000 chars as excerpt to keep token usage reasonable
          context.documentExcerpt = documentContent.length > 2000
            ? documentContent.slice(0, 2000) + '\n...(truncated)'
            : documentContent;
        }
      }

      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, context }),
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
              if (waiting) { setWaiting(false); setBackendStatus('connected'); }
              accumulated += parsed.text;
              const content = accumulated;
              setMessages(prev =>
                prev.map(m => m.id === assistantMsg.id ? { ...m, content } : m)
              );
            } else if (parsed.type === 'error') {
              gotError = true;
              setBackendStatus('error');
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

  // Form submit handler
  function sendMessage(e) {
    e.preventDefault();
    doSend(input.trim());
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
      className={`border-l border-[#262626] flex flex-col bg-[#0a0a0a] relative overflow-hidden ${fullWidth ? 'w-full' : 'shrink-0'}`}
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
              backendStatus === 'connected' ? `${backendName} is connected` :
              backendStatus === 'error' ? `${backendName} disconnected — check Settings` :
              `Connecting to ${backendName}...`
            }>
              <Circle size={6} className={
                backendStatus === 'connected' ? 'text-green-500 fill-green-500' :
                backendStatus === 'error' ? 'text-red-500 fill-red-500' :
                'text-yellow-500 fill-yellow-500 animate-pulse'
              } />
              <span className={`text-[10px] ${backendStatus === 'error' ? 'text-red-400' : 'text-neutral-600'}`}>
                {backendStatus === 'connected' ? `${backendName} connected` :
                 backendStatus === 'error' ? `${backendName} disconnected` :
                 'Connecting...'}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 min-w-0">
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

          // Hide empty assistant bubble while waiting for first token
          if (isStreamingThis && !msg.content && waiting) return null;

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
              <span className="text-[10px] font-medium text-neutral-500">GhostWriter</span>
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
      <form onSubmit={sendMessage} className="p-3 border-t border-[#1a1a1a] space-y-2">
        {/* Clear confirmation bar */}
        {confirmClear && (
          <div className="flex items-center justify-between bg-red-900/30 border border-red-500/30 rounded-lg px-3 py-2">
            <span className="text-xs text-red-300">Clear chat history?</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="text-[11px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleNewChat();
                  setConfirmClear(false);
                }}
                className="text-[11px] bg-red-600 hover:bg-red-500 text-white px-2.5 py-1 rounded transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-grow: reset then expand to scrollHeight
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask GhostWriter..."
            rows={3}
            className="flex-1 bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-[#404040] transition-colors min-w-0 resize-y max-h-[200px] overflow-y-auto"
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="p-2 rounded-lg bg-red-900/60 hover:bg-red-800/80 transition-colors"
              title="Clear chat"
            >
              <Eraser size={14} className="text-red-300" />
            </button>
            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="p-2 rounded-lg bg-red-600 hover:bg-red-500 transition-colors"
                title="Stop generating"
              >
                <Square size={14} className="text-white" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={14} className="text-white" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-[11px] transition-colors duration-200 ${editMode ? 'text-amber-400/70' : 'text-neutral-600'}`}>
            {editMode ? '👻✏️ Edit mode' : '👻🔍 Read mode'}
          </span>
          <button
            type="button"
            onClick={() => {
              setEditMode(prev => {
                const newMode = !prev;
                // Auto-send only when enabling edit mode with an existing conversation
                // Delay to let the Kiro backend settle between requests
                if (newMode && messages.length > 0 && !streaming) {
                  setTimeout(() => doSend('AI Edit mode enabled. Please proceed with the changes.', true), 2000);
                }
                return newMode;
              });
            }}
            className={`relative flex items-center h-6 rounded-full text-[10px] font-medium transition-colors cursor-pointer ${
              editMode
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-[#1a1a1a] text-neutral-500'
            }`}
            style={{ width: 108 }}
          >
            <span className={`absolute left-0 top-0 h-6 rounded-full transition-all duration-200 ${
              editMode
                ? 'translate-x-[52px] w-[56px] bg-amber-500/30'
                : 'translate-x-0 w-[56px] bg-[#333]'
            }`} />
            <span className={`relative z-10 w-[56px] text-center transition-colors ${!editMode ? 'text-neutral-300' : 'text-neutral-600'}`}>
              Read
            </span>
            <span className={`relative z-10 w-[56px] text-center transition-colors ${editMode ? 'text-amber-200' : 'text-neutral-600'}`}>
              AI Edit
            </span>
          </button>
        </div>
      </form>
    </div>
  );
}
