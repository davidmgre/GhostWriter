import { useState, useRef, useEffect } from 'react';
import { FileText, Plus, Calendar, Hash, File, FolderOpen, MoreVertical, Pencil } from 'lucide-react';

export default function DocSidebar({ documents, currentDoc, onSelect, onCreate, onClose, onOpenFolder, onRename }) {
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const menuRef = useRef(null);
  const renameInputRef = useRef(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpenId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpenId]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  function handleCreate(e) {
    e.preventDefault();
    if (!newSlug.trim()) return;

    const slug = newSlug.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    onCreate(slug);
    setNewSlug('');
    setShowNewForm(false);
  }

  function startRename(doc) {
    setMenuOpenId(null);
    setRenamingId(doc.id);
    // Pre-fill with the slug (for projects) or filename without .md (for files)
    setRenameValue(doc.slug || doc.title);
  }

  function handleRenameSubmit(e) {
    e.preventDefault();
    if (!renameValue.trim() || !onRename) return;
    onRename(renamingId, renameValue.trim());
    setRenamingId(null);
    setRenameValue('');
  }

  function handleRenameKeyDown(e) {
    if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  }

  const projectDocs = documents.filter(n => n.type === 'project');
  const fileDocs = documents.filter(n => n.type === 'file');

  function renderDocItem(doc, isProject) {
    const isActive = currentDoc?.id === doc.id;
    const isRenaming = renamingId === doc.id;
    const isMenuOpen = menuOpenId === doc.id;

    return (
      <div
        key={doc.id}
        className={`group relative w-full text-left ${isProject ? 'px-3 py-3' : 'px-3 py-2.5'} border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors cursor-pointer ${
          isActive
            ? `bg-[#1a1a1a] border-l-2 ${isProject ? 'border-l-blue-500' : 'border-l-emerald-500'}`
            : 'border-l-2 border-l-transparent'
        }`}
        onClick={() => !isRenaming && onSelect(doc.id)}
      >
        <div className="flex items-start justify-between gap-1">
          <div className="flex-1 min-w-0">
            {isRenaming ? (
              <form onSubmit={handleRenameSubmit} className="flex items-center gap-1">
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={() => { setRenamingId(null); setRenameValue(''); }}
                  className="w-full bg-[#1a1a1a] border border-blue-500/50 rounded px-1.5 py-0.5 text-sm text-neutral-200 focus:outline-none"
                  onClick={(e) => e.stopPropagation()}
                />
              </form>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  {isProject
                    ? <FolderOpen size={12} className="text-blue-400 shrink-0" />
                    : <File size={12} className="text-emerald-400 shrink-0" />
                  }
                  <div className={`text-sm text-neutral-200 truncate ${isProject ? 'font-medium' : ''}`}>
                    {doc.title}
                  </div>
                </div>
                {isProject && (
                  <div className="flex items-center gap-2 mt-1 text-xs text-neutral-600 pl-[18px]">
                    <Calendar size={10} />
                    <span>{doc.date}</span>
                  </div>
                )}
                {!isProject && doc.filename && (
                  <div className="text-[10px] text-neutral-600 mt-0.5 pl-[18px]">
                    {doc.filename}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Version count badge (projects only) */}
          {isProject && !isRenaming && doc.versionCount > 0 && (
            <div
              className="flex items-center gap-1 text-[10px] text-neutral-500 bg-[#1a1a1a] px-1.5 py-0.5 rounded-full shrink-0"
              title={`${doc.versionCount} version${doc.versionCount !== 1 ? 's' : ''}`}
            >
              <Hash size={9} />
              <span>{doc.versionCount}</span>
            </div>
          )}

          {/* Three-dot menu button */}
          {!isRenaming && onRename && (
            <div className="relative shrink-0" ref={isMenuOpen ? menuRef : undefined}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenId(isMenuOpen ? null : doc.id);
                }}
                className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[#262626] transition-all"
                title="More options"
              >
                <MoreVertical size={12} className="text-neutral-500" />
              </button>

              {/* Dropdown menu */}
              {isMenuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[#1a1a1a] border border-[#333] rounded-md shadow-lg z-20 min-w-[120px]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(doc);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-[#262626] transition-colors rounded-md"
                  >
                    <Pencil size={11} />
                    Rename
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-56 lg:w-64 min-w-[14rem] lg:min-w-[16rem] border-r border-[#262626] flex flex-col bg-[#0a0a0a] shrink-0">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-3 border-b border-[#262626] shrink-0">
        <div className="text-xs font-medium text-neutral-400 tracking-wide">DOCUMENTS</div>
        <div className="flex items-center gap-1">
          {onOpenFolder && (
            <button
              onClick={onOpenFolder}
              className="p-1.5 rounded hover:bg-[#1a1a1a] transition-colors"
              title="Open Folder"
            >
              <FolderOpen size={14} className="text-neutral-400" />
            </button>
          )}
          <button
            onClick={() => setShowNewForm(!showNewForm)}
            className="p-1.5 rounded hover:bg-[#1a1a1a] transition-colors"
            title="New Document"
          >
            <Plus size={14} className="text-neutral-400" />
          </button>
        </div>
      </div>

      {/* New Document Form */}
      {showNewForm && (
        <div className="p-3 border-b border-[#262626] bg-[#0f0f0f]">
          <form onSubmit={handleCreate} className="space-y-2">
            <input
              type="text"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="document-name"
              className="w-full bg-[#1a1a1a] border border-[#262626] rounded px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-[#404040]"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs py-1.5 rounded transition-colors"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowNewForm(false)}
                className="flex-1 bg-[#1a1a1a] hover:bg-[#262626] text-neutral-400 text-xs py-1.5 rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Document List */}
      <div className="flex-1 overflow-y-auto">
        {documents.length === 0 && (
          <div className="p-4 text-center text-neutral-600 text-xs">
            <FileText size={24} className="mx-auto mb-2 text-neutral-700" />
            <p>No documents found.</p>
            <p className="mt-1">Click + to create a document, or add .md files to the folder.</p>
          </div>
        )}

        {/* Projects section */}
        {projectDocs.length > 0 && (
          <>
            {fileDocs.length > 0 && (
              <div className="px-3 pt-3 pb-1 text-[10px] font-medium text-neutral-600 tracking-wider uppercase">
                Projects
              </div>
            )}
            {projectDocs.map((doc) => renderDocItem(doc, true))}
          </>
        )}

        {/* Files section */}
        {fileDocs.length > 0 && (
          <>
            {projectDocs.length > 0 && (
              <div className="px-3 pt-3 pb-1 text-[10px] font-medium text-neutral-600 tracking-wider uppercase">
                Files
              </div>
            )}
            {fileDocs.map((doc) => renderDocItem(doc, false))}
          </>
        )}
      </div>
    </div>
  );
}
