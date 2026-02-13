import { useState, useEffect, useCallback } from 'react';
import { X, Folder, FileText, ChevronUp, Loader2 } from 'lucide-react';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

export default function FileBrowser({ onSelect, onClose, initialPath }) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const browse = useCallback(async (dirPath) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/browse-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath || undefined }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setCurrentPath(data.current);
      setParentPath(data.parent);
      setEntries(data.entries);
    } catch {
      setError('Failed to browse directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(initialPath);
  }, [initialPath, browse]);

  function handleEntryClick(entry) {
    if (entry.type === 'dir') {
      browse(`${currentPath}/${entry.name}`);
    } else {
      // File selected — return parent dir + file info
      onSelect({ path: currentPath, isFile: true, filename: entry.name });
    }
  }

  function handleSelectFolder() {
    onSelect({ path: currentPath, isFile: false });
  }

  // Keyboard: Escape to close
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-[#141414] border border-[#262626] rounded-xl shadow-2xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#262626] shrink-0">
          <h2 className="text-sm font-semibold text-white">Browse Files</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#262626] text-neutral-500 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Current path */}
        <div className="px-4 py-2 border-b border-[#1e1e1e] shrink-0">
          <div className="text-[11px] text-neutral-500 font-mono truncate" title={currentPath}>
            {currentPath || '...'}
          </div>
        </div>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-500">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-center text-xs text-red-400">{error}</div>
          ) : (
            <div className="py-1">
              {/* Parent directory */}
              {parentPath && (
                <button
                  onClick={() => browse(parentPath)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-[#1a1a1a] transition-colors group"
                >
                  <ChevronUp size={14} className="text-neutral-500 group-hover:text-neutral-300" />
                  <span className="text-xs text-neutral-400 group-hover:text-neutral-200">..</span>
                </button>
              )}

              {entries.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-neutral-600">
                  No folders or markdown files
                </div>
              )}

              {entries.map(entry => (
                <button
                  key={entry.name}
                  onClick={() => handleEntryClick(entry)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-[#1a1a1a] transition-colors group"
                >
                  {entry.type === 'dir' ? (
                    <Folder size={14} className="text-blue-400/70 group-hover:text-blue-400 shrink-0" />
                  ) : (
                    <FileText size={14} className="text-neutral-500 group-hover:text-neutral-300 shrink-0" />
                  )}
                  <span className={`text-xs truncate ${
                    entry.type === 'dir'
                      ? 'text-neutral-200 group-hover:text-white'
                      : 'text-neutral-400 group-hover:text-neutral-200'
                  }`}>
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#262626] shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#262626] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSelectFolder}
            disabled={loading || !!error}
            className="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}
