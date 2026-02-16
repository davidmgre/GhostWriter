import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from './components/Editor';
import Preview from './components/Preview';
import ChatPanel from './components/ChatPanel';
import Header from './components/Header';
import DocSidebar from './components/DocSidebar';
import VersionHistory from './components/VersionHistory';
import SettingsModal from './components/SettingsModal';
import FileBrowser from './components/FileBrowser';
import { MessageSquare, FileText, Eye, List } from 'lucide-react';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

// --- Markdown to Slack mrkdwn converter ---
function markdownToSlack(md) {
  let lines = md.split('\n');
  let result = [];
  let inCodeBlock = false;

  for (let line of lines) {
    // Code blocks
    if (line.match(/^```/)) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Headers → bold
    line = line.replace(/^#{1,6}\s+(.+)$/, '*$1*');

    // Bold: **text** → *text*
    line = line.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Italic: _text_ stays as _text_, *text* → _text_ (single asterisk italic)
    // But we already converted ** to *, so handle single * that aren't bold:
    // Actually in markdown, *text* is italic. After our bold conversion, remaining single *
    // are either our converted bold or original italic. Let's handle __text__ → _text_ for italic.
    line = line.replace(/(?<!\*)_(.+?)_(?!\*)/g, '_$1_'); // underscores stay

    // Links: [text](url) → <url|text>
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    // Unordered lists: - item → • item
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');

    // Horizontal rules
    line = line.replace(/^---+$/, '———');
    line = line.replace(/^\*\*\*+$/, '———');

    // Strikethrough: ~~text~~ → ~text~
    line = line.replace(/~~(.+?)~~/g, '~$1~');

    result.push(line);
  }

  return result.join('\n');
}

// --- Generate Rich Text HTML (light theme, inline styles for email clients) ---
function generateRichTextHTML(previewEl) {
  if (!previewEl) return '';

  // Clone the preview element so we don't modify the DOM
  const clone = previewEl.cloneNode(true);

  // Apply inline styles for email compatibility
  const styles = {
    'h1': 'font-size:1.8em;font-weight:700;margin:0.8em 0 0.4em;color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:0.3em;',
    'h2': 'font-size:1.4em;font-weight:600;margin:0.8em 0 0.4em;color:#1a1a1a;',
    'h3': 'font-size:1.15em;font-weight:600;margin:0.6em 0 0.3em;color:#333;',
    'p': 'margin:0.5em 0;color:#333;line-height:1.6;',
    'a': 'color:#2563eb;text-decoration:none;',
    'strong': 'color:#1a1a1a;font-weight:600;',
    'em': 'color:#555;',
    'code': 'background:#f3f4f6;color:#d63384;padding:0.15em 0.4em;border-radius:3px;font-size:0.9em;font-family:Menlo,Monaco,Consolas,monospace;',
    'pre': 'background:#f3f4f6;padding:1em;border-radius:6px;overflow-x:auto;margin:1em 0;',
    'pre code': 'background:none;color:#333;padding:0;',
    'blockquote': 'border-left:3px solid #d1d5db;margin:0.5em 0;padding:0.3em 1em;color:#6b7280;background:#f9fafb;',
    'hr': 'border:none;border-top:1px solid #e5e5e5;margin:1.5em 0;',
    'ul': 'padding-left:1.5em;margin:0.5em 0;',
    'ol': 'padding-left:1.5em;margin:0.5em 0;',
    'li': 'margin:0.25em 0;color:#333;line-height:1.6;',
    'table': 'border-collapse:collapse;width:100%;margin:1em 0;',
    'th': 'border:1px solid #e5e5e5;padding:0.5em 0.75em;text-align:left;background:#f9fafb;font-weight:600;',
    'td': 'border:1px solid #e5e5e5;padding:0.5em 0.75em;text-align:left;',
  };

  // Apply styles to all matching elements
  for (const [selector, style] of Object.entries(styles)) {
    if (selector.includes(' ')) {
      // Handle nested selectors like "pre code"
      const parts = selector.split(' ');
      const parents = clone.querySelectorAll(parts[0]);
      parents.forEach(parent => {
        const children = parent.querySelectorAll(parts[1]);
        children.forEach(el => { el.style.cssText = style; });
      });
    } else {
      clone.querySelectorAll(selector).forEach(el => {
        el.style.cssText = style;
      });
    }
  }

  return clone.innerHTML;
}

function App() {
  const [content, setContent] = useState('');
  const [viewMode, setViewMode] = useState('split');
  const [chatOpen, setChatOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [lastSaved, setLastSaved] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const autoSaveTimer = useRef(null);
  const versionSnapshotTimer = useRef(null);
  const lastVersionContent = useRef('');
  const lastSavedContent = useRef('');
  const currentDocRef = useRef(null);

  // Keep ref in sync for SSE handler
  useEffect(() => {
    currentDocRef.current = currentDoc;
  }, [currentDoc]);

  // --- SSE: Live reload on external file changes ---
  useEffect(() => {
    let eventSource;
    let reconnectTimer;

    function connect() {
      eventSource = new EventSource(`${API_BASE}/events`);

      eventSource.addEventListener('file-changed', (e) => {
        const data = JSON.parse(e.data);
        const current = currentDocRef.current;
        if (current && data.docId === current.id && (data.file === 'draft.md' || current.type === 'file')) {
          // Reload content for the currently-open document
          fetch(`${API_BASE}/documents/${encodeURIComponent(current.id)}`)
            .then(res => res.json())
            .then(d => {
              // Only update if content actually differs (avoid cursor jump during our own saves)
              if (d.content !== lastSavedContent.current) {
                setContent(d.content);
                lastSavedContent.current = d.content;
                lastVersionContent.current = d.content;
                setSaveStatus('saved');
              }
            })
            .catch(() => {});
        }
      });

      eventSource.addEventListener('list-changed', () => {
        loadDocuments();
      });

      eventSource.onerror = () => {
        eventSource.close();
        // Reconnect after 3 seconds
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // Load documents on mount
  useEffect(() => {
    loadDocuments();
  }, []);

  // Auto-save with debounce
  const saveContent = useCallback(async (text, createVersion = false) => {
    if (!currentDoc) return;

    try {
      setSaveStatus('saving');
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(currentDoc.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (data.success) {
        setSaveStatus('saved');
        setLastSaved(new Date(data.timestamp));
        lastSavedContent.current = text;
        if (createVersion) {
          lastVersionContent.current = text;
          loadDocuments();
        }
      }
    } catch (err) {
      console.error('Failed to save:', err);
      setSaveStatus('error');
    }
  }, [currentDoc]);

  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    setSaveStatus('unsaved');

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      saveContent(newContent, false);
    }, 1500);
  }, [saveContent]);

  // Auto-version snapshot every 5 minutes
  useEffect(() => {
    versionSnapshotTimer.current = setInterval(() => {
      if (content && content !== lastVersionContent.current) {
        saveContent(content, true);
      }
    }, 5 * 60 * 1000);

    return () => {
      if (versionSnapshotTimer.current) clearInterval(versionSnapshotTimer.current);
    };
  }, [content, saveContent]);

  // Manual save (Cmd+S)
  const handleSave = useCallback(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    saveContent(content, true);
  }, [content, saveContent]);

  // Load documents
  async function loadDocuments() {
    try {
      const res = await fetch(`${API_BASE}/documents`);
      const data = await res.json();
      const list = data.documents || [];
      setDocuments(list);

      if (currentDoc) {
        const updated = list.find(n => n.id === currentDoc.id);
        if (updated) setCurrentDoc(updated);
      }

      return list;
    } catch (err) {
      console.error('Failed to load documents:', err);
      return [];
    }
  }

  // Select document
  async function selectDoc(id) {
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(id)}`);
      const data = await res.json();
      setContent(data.content);
      lastVersionContent.current = data.content;
      lastSavedContent.current = data.content;

      const doc = documents.find(n => n.id === id);
      setCurrentDoc(doc || { id, title: 'Loading...', date: '', versionCount: 0, type: data.type || 'project' });
      setSaveStatus('saved');
      setVersionHistoryOpen(false);

      const updated = await loadDocuments();
      const found = updated.find(n => n.id === id);
      if (found) setCurrentDoc(found);
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  }

  // Auto-select first document
  useEffect(() => {
    if (documents.length > 0 && !currentDoc) {
      selectDoc(documents[0].id);
    }
  }, [documents]);

  // Open folder or file via native macOS picker, with web fallback
  async function openFolder() {
    try {
      const res = await fetch(`${API_BASE}/pick-folder`, { method: 'POST' });
      const data = await res.json();

      if (data.unsupported) {
        setFileBrowserOpen(true);
        return;
      }

      if (data.cancelled || !data.path) return;
      await applyFolderSelection(data);
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }

  // Shared handler for both native picker and web file browser results
  async function applyFolderSelection(data) {
    try {
      // Save the new docsDir (parent dir if a file was picked)
      await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docsDir: data.path }),
      });

      // Reset current doc and reload
      setCurrentDoc(null);
      setContent('');
      const docs = await loadDocuments();

      // If a file was picked, auto-select it
      if (data.isFile && data.filename) {
        const fileId = `file:${data.filename}`;
        const found = docs.find(d => d.id === fileId);
        if (found) selectDoc(found.id);
      }
    } catch (err) {
      console.error('Failed to apply folder selection:', err);
    }
  }

  // Rename document
  async function renameDoc(id, newName) {
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(id)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      const data = await res.json();
      if (data.error) {
        console.error('Rename failed:', data.error);
        return;
      }
      // Reload documents and re-select if the renamed doc was current
      const docs = await loadDocuments();
      if (currentDoc?.id === id && data.newId) {
        selectDoc(data.newId);
      }
    } catch (err) {
      console.error('Failed to rename document:', err);
    }
  }

  // Create new document
  async function createDoc(slug) {
    try {
      const res = await fetch(`${API_BASE}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      await loadDocuments();
      selectDoc(data.id);
    } catch (err) {
      console.error('Failed to create document:', err);
    }
  }

  // --- Copy helpers ---
  function showCopyFeedback() {
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  }

  // Copy as Rich Text (HTML for Outlook/Word)
  const handleCopyRichText = useCallback(async () => {
    const previewEl = document.querySelector('.markdown-preview');
    if (!previewEl) return;

    const html = generateRichTextHTML(previewEl);
    const wrappedHTML = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;color:#1a1a1a;line-height:1.6;">${html}</div>`;

    try {
      const blob = new Blob([wrappedHTML], { type: 'text/html' });
      const textBlob = new Blob([previewEl.innerText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blob,
          'text/plain': textBlob,
        })
      ]);
      showCopyFeedback();
    } catch (err) {
      // Fallback for older browsers
      console.error('Rich text copy failed:', err);
      try {
        await navigator.clipboard.writeText(previewEl.innerText);
        showCopyFeedback();
      } catch {}
    }
  }, []);

  // Copy as Slack mrkdwn
  const handleCopySlack = useCallback(async () => {
    const slack = markdownToSlack(content);
    try {
      await navigator.clipboard.writeText(slack);
      showCopyFeedback();
    } catch (err) {
      console.error('Slack copy failed:', err);
    }
  }, [content]);

  // Copy raw HTML source
  const handleCopyHTML = useCallback(async () => {
    const previewEl = document.querySelector('.markdown-preview');
    if (!previewEl) return;

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${currentDoc?.title || 'Document'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { color: #333; margin-top: 1.5em; }
  h3 { color: #555; }
  a { color: #2563eb; }
  code { background: #f3f4f6; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f3f4f6; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d1d5db; margin: 0.5em 0; padding: 0.3em 1em; color: #6b7280; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 1.5em 0; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e5e5e5; padding: 0.5em; text-align: left; }
  th { background: #f9fafb; }
</style>
</head>
<body>
${previewEl.innerHTML}
</body>
</html>`;

    try {
      await navigator.clipboard.writeText(htmlContent);
      showCopyFeedback();
    } catch (err) {
      console.error('HTML copy failed:', err);
    }
  }, [currentDoc]);

  // Download HTML file
  const handleDownloadHTML = useCallback(async () => {
    if (!currentDoc) return;

    const previewEl = document.querySelector('.markdown-preview');
    if (!previewEl) return;

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${currentDoc.title || 'Document'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { color: #333; margin-top: 1.5em; }
  h3 { color: #555; }
  a { color: #2563eb; }
  code { background: #f3f4f6; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f3f4f6; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d1d5db; margin: 0.5em 0; padding: 0.3em 1em; color: #6b7280; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 1.5em 0; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e5e5e5; padding: 0.5em; text-align: left; }
  th { background: #f9fafb; }
</style>
</head>
<body>
${previewEl.innerHTML}
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentDoc.id}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentDoc]);

  // Keyboard shortcuts (⌘S save, ⌘\ toggle sidebar)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Mobile detection
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mobileTab, setMobileTab] = useState('chat');

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a]">
      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            loadDocuments(); // Refresh after settings change
          }}
        />
      )}

      {/* Web-based file browser (remote fallback) */}
      {fileBrowserOpen && (
        <FileBrowser
          onClose={() => setFileBrowserOpen(false)}
          onSelect={(data) => {
            setFileBrowserOpen(false);
            if (data.path) applyFolderSelection(data);
          }}
        />
      )}

      {/* Header — hide on mobile */}
      {!isMobile && (
        <Header
          viewMode={viewMode}
          setViewMode={setViewMode}
          chatOpen={chatOpen}
          setChatOpen={setChatOpen}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          versionHistoryOpen={versionHistoryOpen}
          setVersionHistoryOpen={setVersionHistoryOpen}
          saveStatus={saveStatus}
          lastSaved={lastSaved}
          onSave={handleSave}
          onCopyRichText={handleCopyRichText}
          onCopySlack={handleCopySlack}
          onCopyHTML={handleCopyHTML}
          onDownloadHTML={handleDownloadHTML}
          onOpenSettings={() => setSettingsOpen(true)}
          currentDoc={currentDoc}
          copyFeedback={copyFeedback}
        />
      )}

      {/* Mobile Layout */}
      {isMobile ? (
        <>
          <div className="h-11 flex items-center justify-between px-3 border-b border-[#262626] shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm">👻</span>
              <span className="text-xs font-medium text-neutral-300 truncate max-w-[200px]">
                {currentDoc?.title || 'GhostWriter'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {saveStatus === 'saving' && <span className="text-[10px] text-yellow-500">Saving...</span>}
              {saveStatus === 'saved' && <span className="text-[10px] text-green-600">✓</span>}
              {saveStatus === 'unsaved' && <span className="text-[10px] text-neutral-600">●</span>}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {mobileTab === 'list' && (
              <div className="h-full overflow-y-auto">
                <DocSidebar
                  documents={documents}
                  currentDoc={currentDoc}
                  onSelect={(id) => { selectDoc(id); setMobileTab('preview'); }}
                  onCreate={createDoc}
                  onOpenFolder={openFolder}
                  onRename={renameDoc}
                />
              </div>
            )}
            {mobileTab === 'editor' && (
              <div className="h-full overflow-hidden">
                <Editor content={content} onChange={handleContentChange} />
              </div>
            )}
            {mobileTab === 'preview' && (
              <div className="h-full overflow-auto p-4">
                <Preview content={content} />
              </div>
            )}
            {mobileTab === 'chat' && (
              <div className="h-full">
                <ChatPanel fullWidth currentDoc={currentDoc} documentContent={content} />
              </div>
            )}
          </div>

          <div className="h-12 flex items-stretch border-t border-[#262626] bg-[#0a0a0a] shrink-0">
            {[
              { id: 'list', icon: List, label: 'Issues' },
              { id: 'editor', icon: FileText, label: 'Edit' },
              { id: 'preview', icon: Eye, label: 'Preview' },
              { id: 'chat', icon: MessageSquare, label: 'Chat' },
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setMobileTab(id)}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  mobileTab === id
                    ? 'text-blue-400 bg-blue-500/10'
                    : 'text-neutral-600 hover:text-neutral-400'
                }`}
              >
                <Icon size={18} />
                <span className="text-[10px]">{label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        /* Desktop Layout */
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar wrapper with slide animation */}
          <div className={`shrink-0 overflow-hidden transition-all duration-200 ${
            sidebarOpen ? 'w-56 lg:w-64' : 'w-0'
          }`}>
            <DocSidebar
              documents={documents}
              currentDoc={currentDoc}
              onSelect={selectDoc}
              onCreate={createDoc}
              onOpenFolder={openFolder}
              onRename={renameDoc}
            />
          </div>

          <div className="flex-1 flex overflow-hidden min-w-0">
            {(viewMode === 'split' || viewMode === 'edit') && (
              <div className={`${viewMode === 'split' ? 'w-1/2' : 'w-full'} overflow-hidden border-r border-[#262626]`}>
                <Editor content={content} onChange={handleContentChange} />
              </div>
            )}
            {(viewMode === 'split' || viewMode === 'preview') && (
              <div className={`${viewMode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto p-4 md:p-6`}>
                <Preview content={content} />
              </div>
            )}
          </div>

          {versionHistoryOpen && currentDoc && currentDoc.type !== 'file' && (
            <VersionHistory
              docId={currentDoc.id}
              onClose={() => setVersionHistoryOpen(false)}
              onRestore={(versionContent) => {
                setContent(versionContent);
                setVersionHistoryOpen(false);
                saveContent(versionContent, true);
              }}
            />
          )}

          {chatOpen && <ChatPanel currentDoc={currentDoc} documentContent={content} />}
        </div>
      )}
    </div>
  );
}

export default App;
