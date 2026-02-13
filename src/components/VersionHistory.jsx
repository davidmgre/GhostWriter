import { useState, useEffect } from 'react';
import { X, Clock, RotateCcw, Trash2 } from 'lucide-react';
import Preview from './Preview';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

export default function VersionHistory({ docId, onClose, onRestore }) {
  const [versions, setVersions] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [previewContent, setPreviewContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState(null);

  useEffect(() => {
    loadVersions();
    setSelectedVersion(null);
    setPreviewContent('');
    setCleanupResult(null);
  }, [docId]);

  async function loadVersions() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(docId)}/versions`);
      const data = await res.json();
      setVersions(data.versions || []);
    } catch (err) {
      console.error('Failed to load versions:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadVersionContent(timestamp) {
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(docId)}/versions/${timestamp}`);
      const data = await res.json();
      setPreviewContent(data.content);
      setSelectedVersion(timestamp);
    } catch (err) {
      console.error('Failed to load version content:', err);
    }
  }

  async function handleCleanup() {
    if (!window.confirm('Delete versions older than 30 days? (Newest 10 are always kept.)')) return;

    setCleaning(true);
    setCleanupResult(null);
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(docId)}/cleanup`, {
        method: 'POST',
      });
      const data = await res.json();
      setCleanupResult(data);
      loadVersions(); // Refresh list
    } catch (err) {
      console.error('Cleanup failed:', err);
    } finally {
      setCleaning(false);
    }
  }

  function formatTimestamp(timestamp) {
    const [date, time] = timestamp.split('T');
    const [year, month, day] = date.split('-');
    const [hour, minute] = time.split('-');
    
    const d = new Date(year, month - 1, day, hour, minute);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function handleRestore() {
    if (previewContent && window.confirm('Restore this version? Current content will be saved as a new version.')) {
      onRestore(previewContent);
    }
  }

  return (
    <div className="w-96 border-l border-[#262626] flex flex-col bg-[#0f0f0f]">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-[#262626] shrink-0">
        <div className="text-xs font-medium text-neutral-400">VERSION HISTORY</div>
        <div className="flex items-center gap-1">
          {versions.length > 10 && (
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="p-1.5 rounded hover:bg-[#1a1a1a] transition-colors text-neutral-500 hover:text-orange-400"
              title="Clean up old versions (keeps newest 10, deletes >30 days)"
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[#1a1a1a] transition-colors"
          >
            <X size={14} className="text-neutral-400" />
          </button>
        </div>
      </div>

      {/* Cleanup result banner */}
      {cleanupResult && (
        <div className="px-3 py-2 bg-orange-500/10 border-b border-orange-500/20 text-[11px] text-orange-300">
          {cleanupResult.deleted > 0
            ? `Cleaned up ${cleanupResult.deleted} old version${cleanupResult.deleted !== 1 ? 's' : ''}. ${cleanupResult.remaining} remaining.`
            : 'No old versions to clean up.'
          }
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Version List */}
        <div className="w-40 border-r border-[#262626] overflow-y-auto">
          {loading && (
            <div className="p-4 text-center text-neutral-600 text-xs">
              Loading...
            </div>
          )}
          {!loading && versions.length === 0 && (
            <div className="p-4 text-center text-neutral-600 text-xs">
              <Clock size={20} className="mx-auto mb-2 text-neutral-700" />
              <p>No versions yet</p>
            </div>
          )}
          {versions.map((version) => {
            const isActive = selectedVersion === version.timestamp;
            return (
              <button
                key={version.timestamp}
                onClick={() => loadVersionContent(version.timestamp)}
                className={`w-full text-left px-3 py-3 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors ${
                  isActive ? 'bg-[#1a1a1a]' : ''
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Clock size={10} className="text-neutral-600" />
                  <div className="text-[10px] text-neutral-600">
                    {formatTimestamp(version.timestamp)}
                  </div>
                </div>
                <div className="text-xs text-neutral-400 line-clamp-2">
                  {version.preview}
                </div>
              </button>
            );
          })}
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedVersion && (
            <div className="flex-1 flex items-center justify-center text-neutral-600 text-xs">
              Select a version to preview
            </div>
          )}
          {selectedVersion && (
            <>
              <div className="flex-1 overflow-auto p-4">
                <Preview content={previewContent} />
              </div>
              <div className="p-3 border-t border-[#262626]">
                <button
                  onClick={handleRestore}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs py-2 rounded transition-colors"
                >
                  <RotateCcw size={12} />
                  Restore This Version
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
