import { useState, useRef, useEffect } from 'react';
import {
  Save,
  Download,
  MessageSquare,
  Columns2,
  PenLine,
  Eye,
  Check,
  Loader2,
  AlertCircle,
  PanelLeft,
  History,
  Copy,
  ChevronDown,
  Settings,
  FileText,
  Hash,
} from 'lucide-react';

export default function Header({
  viewMode,
  setViewMode,
  chatOpen,
  setChatOpen,
  sidebarOpen,
  setSidebarOpen,
  versionHistoryOpen,
  setVersionHistoryOpen,
  saveStatus,
  lastSaved,
  onSave,
  onCopyRichText,
  onCopySlack,
  onCopyHTML,
  onDownloadHTML,
  onOpenSettings,
  currentDoc,
  copyFeedback,
}) {
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setCopyMenuOpen(false);
      }
    }
    if (copyMenuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [copyMenuOpen]);

  const viewButtons = [
    { mode: 'edit', icon: PenLine, label: 'Edit' },
    { mode: 'split', icon: Columns2, label: 'Split' },
    { mode: 'preview', icon: Eye, label: 'Preview' },
  ];

  const statusIcon = {
    saved: <Check size={14} className="text-green-500" />,
    saving: <Loader2 size={14} className="text-yellow-500 animate-spin" />,
    unsaved: <div className="w-2 h-2 rounded-full bg-yellow-500" />,
    error: <AlertCircle size={14} className="text-red-500" />,
  };

  const statusText = {
    saved: lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : 'Saved',
    saving: 'Saving...',
    unsaved: 'Unsaved changes',
    error: 'Save failed',
  };

  return (
    <header className="h-12 flex items-center justify-between px-4 border-b border-[#262626] bg-[#0f0f0f] shrink-0">
      {/* Left: App name + status */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-[#1a1a1a] transition-colors ${
            sidebarOpen ? 'text-white' : 'text-neutral-500'
          }`}
          title="Toggle document list (⌘\)"
        >
          <PanelLeft size={13} />
          Docs
        </button>
        <h1 className="text-sm font-semibold text-white tracking-tight">
          👻 GhostWriter
        </h1>
        {currentDoc && (
          <div className="text-xs text-neutral-500 border-l border-[#262626] pl-3">
            {currentDoc.title}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          {statusIcon[saveStatus]}
          <span>{statusText[saveStatus]}</span>
        </div>
      </div>

      {/* Center: View mode toggle */}
      <div className="flex items-center bg-[#1a1a1a] rounded-lg p-0.5 gap-0.5">
        {viewButtons.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-[#262626] text-white'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
          title="Save (⌘S)"
        >
          <Save size={13} />
          Save
        </button>

        {/* Copy dropdown */}
        <div className="relative" ref={menuRef}>
          <div className="flex items-center">
            <button
              onClick={() => { onCopyRichText(); setCopyMenuOpen(false); }}
              disabled={!currentDoc}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-l-lg text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#1a1a1a] transition-colors disabled:opacity-30"
              title="Copy as Rich Text (for Outlook/Word)"
            >
              {copyFeedback ? (
                <>
                  <Check size={13} className="text-green-400" />
                  <span className="text-green-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy size={13} />
                  Copy
                </>
              )}
            </button>
            <button
              onClick={() => setCopyMenuOpen(!copyMenuOpen)}
              disabled={!currentDoc}
              className="flex items-center px-1 py-1.5 rounded-r-lg text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#1a1a1a] transition-colors disabled:opacity-30 border-l border-[#262626]"
            >
              <ChevronDown size={12} />
            </button>
          </div>

          {copyMenuOpen && (
            <div className="absolute right-0 top-full mt-1 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl py-1 z-50 min-w-[200px]">
              <button
                onClick={() => { onCopyRichText(); setCopyMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-[#262626] hover:text-white transition-colors"
              >
                <Copy size={13} />
                Copy Rich Text
                <span className="ml-auto text-neutral-600">Outlook / Word</span>
              </button>
              <button
                onClick={() => { onCopySlack(); setCopyMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-[#262626] hover:text-white transition-colors"
              >
                <Hash size={13} />
                Copy for Slack
                <span className="ml-auto text-neutral-600">mrkdwn</span>
              </button>
              <button
                onClick={() => { onCopyHTML(); setCopyMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-[#262626] hover:text-white transition-colors"
              >
                <FileText size={13} />
                Copy HTML Source
                <span className="ml-auto text-neutral-600">raw</span>
              </button>
              <div className="border-t border-[#333] my-1" />
              <button
                onClick={() => { onDownloadHTML(); setCopyMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-[#262626] hover:text-white transition-colors"
              >
                <Download size={13} />
                Download HTML File
              </button>
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-[#262626]" />
        <button
          onClick={() => setVersionHistoryOpen(!versionHistoryOpen)}
          disabled={!currentDoc}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-30 ${
            versionHistoryOpen
              ? 'bg-[#1a1a1a] text-white'
              : 'text-neutral-500 hover:text-neutral-300'
          }`}
          title="Version history"
        >
          <History size={13} />
          {currentDoc?.versionCount > 0 && (
            <span className="text-xs bg-neutral-700 text-neutral-300 px-1.5 py-0.5 rounded">
              {currentDoc.versionCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            chatOpen
              ? 'bg-[#1a1a1a] text-white'
              : 'text-neutral-500 hover:text-neutral-300'
          }`}
          title="Toggle chat"
        >
          <MessageSquare size={13} />
          Chat
        </button>
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-300 hover:bg-[#1a1a1a] transition-colors"
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}
