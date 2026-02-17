import { useState, useEffect } from 'react';
import { X, FolderOpen, Check, Loader2, Ghost, Zap, AlertCircle } from 'lucide-react';
import FileBrowser from './FileBrowser';

const API_BASE = `${window.location.pathname.replace(/\/+$/, '')}/api`;

export default function SettingsModal({ onClose }) {
  const [docsDir, setDocsDir] = useState('');
  const [resolvedDir, setResolvedDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);

  // AI settings
  const [aiSettings, setAiSettings] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  // Escape to close
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function loadSettings() {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const data = await res.json();
      setDocsDir(data.docsDir || '');
      setResolvedDir(data.resolvedDir || '');

      // Extract all ai_* keys
      const ai = {};
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('ai_')) ai[k] = v;
      }
      setAiSettings(ai);
    } catch {
      setError('Failed to load settings');
    }
  }

  function updateAi(key, value) {
    setAiSettings(prev => ({ ...prev, [key]: value }));
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/ai/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiSettings),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!docsDir.trim()) {
      setError('Directory path cannot be empty');
      return;
    }

    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const body = {
        docsDir: docsDir.trim(),
        ...aiSettings,
      };

      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setResolvedDir(data.resolvedDir);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[#141414] border border-[#262626] rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#262626] shrink-0">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#262626] text-neutral-500 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content — scrollable */}
        <div className="px-5 py-4 space-y-6 overflow-y-auto flex-1">
          {/* Documents Directory */}
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-2">
              <FolderOpen size={12} className="inline mr-1.5" />
              Documents Directory
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2.5 text-sm text-neutral-200 font-mono truncate min-h-[38px]">
                {resolvedDir || docsDir || './documents'}
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await fetch(`${API_BASE}/pick-folder`, { method: 'POST' });
                    const data = await res.json();
                    if (data.unsupported) {
                      setFileBrowserOpen(true);
                      return;
                    }
                    if (!data.cancelled && data.path) {
                      setDocsDir(data.path);
                      setResolvedDir(data.path);
                    }
                  } catch {
                    setError('Failed to open folder picker');
                  }
                }}
                className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium bg-[#1a1a1a] border border-[#333] hover:border-[#404040] text-neutral-300 rounded-lg transition-colors"
              >
                <FolderOpen size={13} />
                Browse
              </button>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-[#262626]" />

          {/* AI Assistant Section */}
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-3">
              <Ghost size={12} className="inline mr-1.5" />
              GhostWriter AI (Kiro)
            </label>

            {/* Kiro CLI Command */}
            <div className="mb-3">
              <label className="block text-[11px] text-neutral-500 mb-1">Kiro CLI Command</label>
              <input
                type="text"
                value={aiSettings.ai_kiro_command || ''}
                onChange={(e) => updateAi('ai_kiro_command', e.target.value)}
                placeholder="kiro-cli"
                className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500/50 transition-colors font-mono"
              />
            </div>

            {/* Custom instructions */}
            <div className="mb-3">
              <label className="block text-[11px] text-neutral-500 mb-1">Custom Instructions (optional)</label>
              <textarea
                value={aiSettings.ai_system_prompt || ''}
                onChange={(e) => updateAi('ai_system_prompt', e.target.value)}
                placeholder="You are a helpful writing assistant..."
                rows={3}
                className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500/50 transition-colors resize-none"
              />
            </div>

            {/* Max history */}
            <div className="mb-3">
              <label className="block text-[11px] text-neutral-500 mb-1">Max Conversation History</label>
              <input
                type="number"
                min="1"
                max="100"
                value={aiSettings.ai_max_history || '20'}
                onChange={(e) => updateAi('ai_max_history', e.target.value)}
                className="w-32 bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-blue-500/50 transition-colors"
              />
              <span className="ml-2 text-[11px] text-neutral-600">messages</span>
            </div>

            {/* Test Connection */}
            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={handleTest}
                disabled={testing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1a1a1a] border border-[#333] hover:border-[#404040] text-neutral-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {testing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Zap size={12} />
                )}
                Test Connection
              </button>
              {testResult && (
                <span className={`text-xs flex items-center gap-1 ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult.ok ? (
                    <>
                      <Check size={12} />
                      Connected{testResult.model ? ` (${testResult.model})` : ''}
                    </>
                  ) : (
                    <>
                      <AlertCircle size={12} />
                      {testResult.error}
                    </>
                  )}
                </span>
              )}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#262626] shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#262626] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : saved ? (
              <Check size={13} />
            ) : null}
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>

        {/* Web-based file browser fallback */}
        {fileBrowserOpen && (
          <FileBrowser
            initialPath={resolvedDir || docsDir || undefined}
            onClose={() => setFileBrowserOpen(false)}
            onSelect={(data) => {
              setFileBrowserOpen(false);
              if (data.path) {
                setDocsDir(data.path);
                setResolvedDir(data.path);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
