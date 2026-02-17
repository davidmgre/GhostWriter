import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Send, Ghost, GripVertical, Eraser, Circle, Square, AlertCircle, Check, ChevronDown, Slash, Loader2, RefreshCw, FileText, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import ContextUsageBar from './ContextUsageBar';

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
  const [models, setModels] = useState([]);
  const [currentModel, setCurrentModel] = useState(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [toolCalls, setToolCalls] = useState([]); // active tool calls during streaming
  const [contextUsage, setContextUsage] = useState(null); // { percentage } from backend
  const [compacting, setCompacting] = useState(false);
  const [slashCommands, setSlashCommands] = useState([]); // available slash commands
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [attachments, setAttachments] = useState([]); // attached files: { data, mimeType, name, kind: 'image' | 'file' }
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const isResizing = useRef(false);
  const abortRef = useRef(null);
  const confirmTimerRef = useRef(null);
  const modelDropdownRef = useRef(null);
  const slashMenuRef = useRef(null);
  const retryTimerRef = useRef(null);
  const retryCountRef = useRef(0);

  // Reusable connection test — resolves to 'connected' or 'error'
  const testConnection = useCallback(() => {
    setBackendStatus('unknown');
    fetch(`${API_BASE}/ai/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(result => {
        if (result.ok) {
          retryCountRef.current = 0;
          setBackendStatus('connected');
        } else {
          setBackendStatus('error');
        }
      })
      .catch(() => setBackendStatus('error'));
  }, []);

  // Persist messages to sessionStorage
  useEffect(() => {
    saveSessionMessages(messages);
  }, [messages]);

  // Sync edit mode to server (also triggers ACP mode switch server-side)
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

  // Listen for SSE events — edit-reverted + server disconnect detection
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);
    es.addEventListener('edit-reverted', (e) => {
      try {
        const data = JSON.parse(e.data);
        const revertMsg = {
          id: nextId(),
          role: 'error',
          content: data.message || 'Edit reverted — Read-Only mode is active.',
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, revertMsg]);
      } catch {}
    });
    // When the server goes down, EventSource fires onerror (readyState will be
    // CONNECTING since EventSource auto-reconnects, not CLOSED)
    es.onerror = () => {
      setBackendStatus('error');
    };
    // When it reconnects (EventSource auto-reconnects), re-test the backend
    es.addEventListener('connected', () => {
      testConnection();
    });
    return () => es.close();
  }, [testConnection]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, waiting]);

  // Test connection on mount
  useEffect(() => {
    testConnection();
  }, [testConnection]);

  // Auto-retry on disconnect — backoff: 3s, 6s, 12s, then every 30s
  useEffect(() => {
    if (backendStatus !== 'error') return;
    const count = retryCountRef.current;
    const delay = count < 3 ? 3000 * Math.pow(2, count) : 30000;
    retryTimerRef.current = setTimeout(() => {
      retryCountRef.current = count + 1;
      testConnection();
    }, delay);
    return () => clearTimeout(retryTimerRef.current);
  }, [backendStatus, testConnection]);

  // Fetch available models after connection succeeds
  useEffect(() => {
    if (backendStatus !== 'connected') return;
    fetch(`${API_BASE}/ai/models`)
      .then(r => r.json())
      .then(data => {
        if (data.availableModels) setModels(data.availableModels);
        if (data.currentModelId) setCurrentModel(data.currentModelId);
      })
      .catch(() => {});
  }, [backendStatus]);

  // Fetch available slash commands after connection
  useEffect(() => {
    if (backendStatus !== 'connected') return;
    fetch(`${API_BASE}/ai/commands`)
      .then(r => r.json())
      .then(data => {
        if (data.commands) setSlashCommands(data.commands);
      })
      .catch(() => {});
  }, [backendStatus]);

  // Fetch context usage from backend — reusable helper
  const fetchContextUsage = useCallback(() => {
    fetch(`${API_BASE}/ai/context-usage`)
      .then(r => r.json())
      .then(data => {
        if (data.usage && data.usage.percentage != null) setContextUsage(data.usage);
        if (data.compacting !== undefined) setCompacting(data.compacting);
      })
      .catch(() => {});
  }, []);

  // Fetch context usage on connection — updates arrive inline via SSE
  // from kiro.dev/metadata during streaming, with a post-turn fetch as fallback.
  useEffect(() => {
    if (backendStatus !== 'connected') return;
    fetchContextUsage();
  }, [backendStatus, fetchContextUsage]);

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return;
    function handleClick(e) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target)) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelDropdownOpen]);

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
          context.documentContent = documentContent;
        }
      }

      // Split attachments into images and files, then clear
      const currentAttachments = attachments;
      if (currentAttachments.length > 0) setAttachments([]);
      const attachedImages = currentAttachments.filter(a => a.kind === 'image');
      const attachedFiles = currentAttachments.filter(a => a.kind === 'file');

      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history,
          context,
          ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
          ...(attachedFiles.length > 0 ? { files: attachedFiles } : {}),
        }),
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
            } else if (parsed.type === 'tool_call') {
              if (waiting) { setWaiting(false); setBackendStatus('connected'); }
              setToolCalls(prev => [...prev, { id: parsed.id, title: parsed.title, kind: parsed.kind, status: 'running' }]);
            } else if (parsed.type === 'tool_call_update') {
              setToolCalls(prev => prev.map(tc =>
                tc.id === parsed.id ? { ...tc, status: parsed.status || tc.status, locations: parsed.locations } : tc
              ));
            } else if (parsed.type === 'tool_result') {
              setToolCalls(prev => prev.map(tc =>
                tc.id === parsed.id ? { ...tc, status: 'done' } : tc
              ));
            } else if (parsed.type === 'context_usage') {
              setContextUsage(parsed);
            } else if (parsed.type === 'compaction') {
              setCompacting(parsed.status === 'in_progress');
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
        setBackendStatus('error');
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
      setToolCalls([]);
      abortRef.current = null;
      inputRef.current?.focus();
      // Refresh context usage after each chat turn
      fetchContextUsage();
    }
  }

  // Execute a slash command via the backend
  async function executeSlashCommand(command) {
    const userMsg = { id: nextId(), role: 'user', content: command, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setShowSlashMenu(false);

    try {
      const res = await fetch(`${API_BASE}/ai/commands/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages(prev => [...prev, { id: nextId(), role: 'error', content: data.error, timestamp: new Date().toISOString() }]);
      } else {
        setMessages(prev => [...prev, { id: nextId(), role: 'assistant', content: `Command executed: ${command}`, timestamp: new Date().toISOString() }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, { id: nextId(), role: 'error', content: err.message, timestamp: new Date().toISOString() }]);
    }
  }

  // Form submit handler
  function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    // Handle slash commands
    if (text.startsWith('/') && slashCommands.some(c => text === `/${c.name}` || text.startsWith(`/${c.name} `))) {
      executeSlashCommand(text);
      return;
    }
    doSend(text);
  }

  function handleStop() {
    // Tell Kiro to stop generating via ACP session/cancel
    fetch(`${API_BASE}/ai/cancel`, { method: 'POST' }).catch(() => {});
    // Also abort the HTTP fetch stream
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }

  function handleNewChat() {
    if (streaming) handleStop();
    setMessages([]);
    setConfirmClear(false);
    sessionStorage.removeItem(SESSION_KEY);
    // Reset Kiro session — creates a fresh context while keeping MCP loaded.
    // The model will be re-applied on the next chat message (when the new
    // session is lazily created), so we just store the preference.
    const selectedModel = currentModel;
    fetch(`${API_BASE}/ai/reset`, { method: 'POST' })
      .then(() => {
        // Re-apply model selection — this triggers _ensureSession which creates
        // the new session, then sets the model on it.
        if (selectedModel && selectedModel !== 'auto') {
          return fetch(`${API_BASE}/ai/model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId: selectedModel }),
          });
        }
      })
      .catch(() => {});
    inputRef.current?.focus();
  }

  function handleModelSelect(modelId) {
    setModelDropdownOpen(false);
    if (modelId === currentModel) return;
    setCurrentModel(modelId);
    fetch(`${API_BASE}/ai/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    })
      .then(r => r.json())
      .then(data => {
        if (!data.ok) setCurrentModel(currentModel); // revert on error
      })
      .catch(() => setCurrentModel(currentModel));
  }

  // Attachment handling helpers
  const TEXT_EXTENSIONS = ['.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.txt', '.log'];

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // result is "data:<mime>;base64,<data>" — extract the base64 part
        const base64 = reader.result.split(',')[1];
        resolve({ data: base64, mimeType: file.type, name: file.name, kind: 'image' });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ data: reader.result, mimeType: file.type || 'text/plain', name: file.name, kind: 'file' });
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  function isTextFile(file) {
    if (file.type.startsWith('text/')) return true;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    return TEXT_EXTENSIONS.includes(ext);
  }

  async function handleFiles(files) {
    const fileArray = Array.from(files);
    const results = [];
    for (const file of fileArray) {
      if (file.type.startsWith('image/')) {
        results.push(await fileToBase64(file));
      } else if (isTextFile(file)) {
        results.push(await fileToText(file));
      }
      // Unsupported types are silently ignored
    }
    if (results.length > 0) {
      setAttachments(prev => [...prev, ...results]);
    }
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const supportedItems = Array.from(items).filter(item =>
      item.type.startsWith('image/') || item.type.startsWith('text/')
    );
    // Only intercept paste for file items (not plain text typing)
    const fileItems = supportedItems.filter(item => item.kind === 'file');
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map(item => item.getAsFile()).filter(Boolean);
      handleFiles(files);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      handleFiles(e.dataTransfer.files);
    }
  }

  function removeAttachment(index) {
    setAttachments(prev => prev.filter((_, i) => i !== index));
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
      <div className="h-12 flex items-center justify-between px-4 border-b border-[#262626] shrink-0 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 shrink-1">
          <span className="text-xs font-medium text-neutral-400 shrink-0">👻</span>
          {backendName && (
            backendStatus === 'error' ? (
              <button
                type="button"
                onClick={() => { retryCountRef.current = 0; testConnection(); }}
                className="flex items-center gap-1 hover:opacity-80 transition-opacity shrink-0"
                title={`${backendName} disconnected — click to reconnect`}
              >
                <Circle size={6} className="text-red-500 fill-red-500" />
                <span className="text-[10px] text-red-400">{backendName}</span>
                <RefreshCw size={10} className="text-red-400" />
              </button>
            ) : (
              <span className="flex items-center gap-1 shrink-0" title={
                backendStatus === 'connected' ? `${backendName} is connected` :
                `Connecting to ${backendName}...`
              }>
                <Circle size={6} className={
                  backendStatus === 'connected' ? 'text-green-500 fill-green-500' :
                  'text-yellow-500 fill-yellow-500 animate-pulse'
                } />
              </span>
            )
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Model selector */}
          {models.length > 0 && (
            <div className="relative" ref={modelDropdownRef}>
              <button
                type="button"
                onClick={() => setModelDropdownOpen(prev => !prev)}
                className="flex items-center gap-1 px-1.5 py-1 rounded bg-[#1a1a1a] border border-[#262626] hover:border-[#404040] transition-colors"
              >
                <span className="text-[10px] text-neutral-400 max-w-[80px] truncate">
                  {currentModel || 'auto'}
                </span>
                <ChevronDown size={10} className={`text-neutral-500 transition-transform shrink-0 ${modelDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {modelDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-[#141414] border border-[#262626] rounded-lg shadow-xl py-1 min-w-[180px] max-h-[240px] overflow-y-auto">
                  {models.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleModelSelect(m.id)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#1a1a1a] transition-colors flex items-center justify-between gap-2 ${
                        m.id === currentModel ? 'text-blue-400' : 'text-neutral-400'
                      }`}
                      title={m.description || m.id}
                    >
                      <span className="truncate">{m.name || m.id}</span>
                      {m.id === currentModel && <Check size={10} className="text-blue-400 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* New Chat button */}
          <button
            type="button"
            onClick={() => {
              if (messages.length === 0) {
                handleNewChat();
              } else {
                setConfirmClear(true);
              }
            }}
            className="p-1.5 rounded bg-[#1a1a1a] border border-[#262626] hover:border-[#404040] text-neutral-400 hover:text-neutral-200 transition-colors"
            title="New chat"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      {/* Context usage bar */}
      <ContextUsageBar percentage={contextUsage?.percentage} />

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
        {/* Tool call activity indicators */}
        {toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 items-start">
            {toolCalls.map((tc) => (
              <div key={tc.id || tc.title} className="flex items-center gap-1.5 bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-1.5">
                {tc.status === 'done' || tc.status === 'completed' ? (
                  <Check size={12} className="text-green-400" />
                ) : (
                  <Loader2 size={12} className="text-amber-400 animate-spin" />
                )}
                {tc.kind && (
                  <span className="text-[10px] text-neutral-600 font-mono">{tc.kind}</span>
                )}
                <span className={`text-[11px] ${tc.status === 'done' || tc.status === 'completed' ? 'text-neutral-500' : 'text-amber-300'}`}>
                  {tc.title}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Compaction indicator */}
        {compacting && (
          <div className="flex items-center gap-1.5 bg-[#1a1a1a] border border-amber-500/20 rounded-lg px-3 py-1.5">
            <Loader2 size={12} className="text-amber-400 animate-spin" />
            <span className="text-[11px] text-amber-300">Compacting context...</span>
          </div>
        )}
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
        {/* New chat confirmation bar */}
        {confirmClear && (
          <div className="flex items-center justify-between bg-red-900/30 border border-red-500/30 rounded-lg px-3 py-2">
            <span className="text-xs text-red-300">Start a new chat? Current history will be cleared.</span>
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
                onClick={handleNewChat}
                className="text-[11px] bg-red-600 hover:bg-red-500 text-white px-2.5 py-1 rounded transition-colors"
              >
                New Chat
              </button>
            </div>
          </div>
        )}
        {/* Attached file/image previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap px-1">
            {attachments.map((att, i) => (
              <div key={i} className="relative group">
                {att.kind === 'image' ? (
                  <img
                    src={`data:${att.mimeType};base64,${att.data}`}
                    alt={att.name || 'attached'}
                    className="h-12 w-12 rounded border border-[#262626] object-cover"
                  />
                ) : (
                  <div className="flex items-center gap-1.5 h-8 px-2.5 rounded border border-[#262626] bg-[#141414]">
                    <FileText size={12} className="text-blue-400 shrink-0" />
                    <span className="text-[10px] text-neutral-400 max-w-[100px] truncate">{att.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Slash command autocomplete */}
        {showSlashMenu && (
          <div ref={slashMenuRef} className="bg-[#141414] border border-[#262626] rounded-lg shadow-xl py-1 max-h-[160px] overflow-y-auto">
            {slashCommands
              .filter(c => input.length <= 1 || `/${c.name}`.startsWith(input))
              .map(c => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    setInput(`/${c.name} `);
                    setShowSlashMenu(false);
                    inputRef.current?.focus();
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#1a1a1a] transition-colors flex items-center gap-2"
                >
                  <Slash size={12} className="text-blue-400 shrink-0" />
                  <span className="text-[11px] text-neutral-300 font-mono">/{c.name}</span>
                  {c.description && (
                    <span className="text-[10px] text-neutral-600 truncate">{c.description}</span>
                  )}
                </button>
              ))}
          </div>
        )}
        {/* Offline banner */}
        {backendStatus === 'error' && (
          <div className="flex items-center gap-2 bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-2">
            <Circle size={6} className="text-red-500 fill-red-500 shrink-0" />
            <span className="text-[11px] text-neutral-400">
              AI chat offline — editing still works
            </span>
            <button
              type="button"
              onClick={() => { retryCountRef.current = 0; testConnection(); }}
              className="ml-auto text-[11px] text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
            >
              <RefreshCw size={10} />
              Retry
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              // Show slash command menu when input starts with /
              setShowSlashMenu(val.startsWith('/') && !val.includes(' ') && slashCommands.length > 0);
              // Auto-grow: reset then expand to scrollHeight
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            placeholder={backendStatus === 'error' ? 'AI chat unavailable — editing still works' : attachments.some(a => a.kind === 'file') ? 'Describe what to do with the attached files...' : attachments.some(a => a.kind === 'image') ? 'Describe what to do with the image...' : 'Ask GhostWriter...'}
            rows={3}
            disabled={backendStatus === 'error'}
            className={`flex-1 bg-[#1a1a1a] border border-[#262626] rounded-lg px-3 py-2 text-sm placeholder-neutral-600 focus:outline-none focus:border-[#404040] transition-colors min-w-0 resize-y max-h-[200px] overflow-y-auto ${
              backendStatus === 'error' ? 'text-neutral-500 opacity-60 cursor-not-allowed' : 'text-neutral-200'
            }`}
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (messages.length === 0) handleNewChat();
                else setConfirmClear(true);
              }}
              className="p-2 rounded-lg bg-red-900/60 hover:bg-red-800/80 transition-colors"
              title="Clear chat"
            >
              <Eraser size={14} className="text-red-300" />
            </button>
            {streaming && (
              <button
                type="button"
                onClick={handleStop}
                className="p-2 rounded-lg bg-red-600 hover:bg-red-500 transition-colors"
                title="Stop generating"
              >
                <Square size={14} className="text-white" />
              </button>
            )}
            <button
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || backendStatus === 'error' || streaming}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={streaming ? 'Wait for response to finish' : backendStatus === 'error' ? 'AI chat offline' : 'Send message'}
            >
              <Send size={14} className="text-white" />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-[11px] transition-colors duration-200 ${editMode ? 'text-amber-400/70' : 'text-neutral-600'}`}>
            {editMode ? '👻✏️ Edit mode' : '👻🔍 Read mode'}
          </span>
          <button
            type="button"
            onClick={() => setEditMode(prev => !prev)}
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
