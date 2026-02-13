import { useState } from 'react';
import { FileText, Plus, Calendar, Hash, File, FolderOpen } from 'lucide-react';

export default function DocSidebar({ documents, currentDoc, onSelect, onCreate, onClose }) {
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSlug, setNewSlug] = useState('');

  function handleCreate(e) {
    e.preventDefault();
    if (!newSlug.trim()) return;

    const slug = newSlug.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    onCreate(slug);
    setNewSlug('');
    setShowNewForm(false);
  }

  const projectDocs = documents.filter(n => n.type === 'project');
  const fileDocs = documents.filter(n => n.type === 'file');

  return (
    <div className="w-56 lg:w-64 border-r border-[#262626] flex flex-col bg-[#0a0a0a] shrink-0">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-3 border-b border-[#262626] shrink-0">
        <div className="text-xs font-medium text-neutral-400 tracking-wide">DOCUMENTS</div>
        <div className="flex items-center gap-1">
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
            {projectDocs.map((doc) => {
              const isActive = currentDoc?.id === doc.id;
              return (
                <button
                  key={doc.id}
                  onClick={() => onSelect(doc.id)}
                  className={`w-full text-left px-3 py-3 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors ${
                    isActive ? 'bg-[#1a1a1a] border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <FolderOpen size={12} className="text-blue-400 shrink-0" />
                        <div className="text-sm text-neutral-200 font-medium truncate">
                          {doc.title}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-neutral-600 pl-[18px]">
                        <Calendar size={10} />
                        <span>{doc.date}</span>
                      </div>
                    </div>
                    {doc.versionCount > 0 && (
                      <div
                        className="flex items-center gap-1 text-[10px] text-neutral-500 bg-[#1a1a1a] px-1.5 py-0.5 rounded-full shrink-0"
                        title={`${doc.versionCount} version${doc.versionCount !== 1 ? 's' : ''}`}
                      >
                        <Hash size={9} />
                        <span>{doc.versionCount}</span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
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
            {fileDocs.map((doc) => {
              const isActive = currentDoc?.id === doc.id;
              return (
                <button
                  key={doc.id}
                  onClick={() => onSelect(doc.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors ${
                    isActive ? 'bg-[#1a1a1a] border-l-2 border-l-emerald-500' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <File size={12} className="text-emerald-400 shrink-0" />
                    <div className="text-sm text-neutral-200 truncate">
                      {doc.title}
                    </div>
                  </div>
                  <div className="text-[10px] text-neutral-600 mt-0.5 pl-[18px]">
                    {doc.filename}
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
