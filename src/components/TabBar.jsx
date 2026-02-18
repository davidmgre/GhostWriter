import { X } from 'lucide-react';

export default function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, dirtyTabIds = new Set() }) {
  if (tabs.length === 0) return null;

  // Detect duplicate filenames for disambiguation
  const nameCount = {};
  for (const tab of tabs) {
    nameCount[tab.title] = (nameCount[tab.title] || 0) + 1;
  }

  return (
    <div className="h-7 flex items-stretch bg-[#0f0f0f] border-b border-[#262626] overflow-x-auto overflow-y-hidden shrink-0 scrollbar-none">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isDirty = dirtyTabIds.has(tab.id);
        const showDir = nameCount[tab.title] > 1 && tab.dirName;

        return (
          <div
            key={tab.id}
            className={`group relative flex items-center gap-1.5 px-3 min-w-0 max-w-[180px] cursor-pointer select-none border-r border-[#1a1a1a] transition-colors ${
              isActive
                ? 'bg-[#1a1a1a] text-neutral-200'
                : 'text-neutral-500 hover:text-neutral-300 hover:bg-[#141414]'
            }`}
            onClick={() => onSelectTab(tab.id)}
            title={tab.absPath || tab.title}
          >
            {/* Active tab bottom accent */}
            {isActive && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-500" />
            )}

            {/* Dirty dot */}
            {isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            )}

            {/* Filename */}
            <span className="text-[11px] truncate">
              {tab.title}
            </span>

            {/* Parent dir for disambiguation */}
            {showDir && (
              <span className="text-[9px] text-neutral-600 truncate shrink-0">
                {tab.dirName}
              </span>
            )}

            {/* Close button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[#333] transition-all shrink-0"
              title="Close tab"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
