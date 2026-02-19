import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Configure turndown for clean GFM output
const td = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
});
td.use(gfm); // adds table, strikethrough, task list support

// Drop blob: and data: images (won't persist), keep real https:// URLs
td.addRule('filter-images', {
  filter: 'img',
  replacement: (content, node) => {
    const src = node.getAttribute('src') || '';
    if (src.startsWith('blob:') || src.startsWith('data:')) return '';
    const alt = node.getAttribute('alt') || '';
    return src ? `![${alt}](${src})` : '';
  },
});

// Smart paste extension — intercepts paste events and converts HTML → Markdown
const smartPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data) return false;

    const html = data.getData('text/html');
    if (!html) return false; // no HTML in clipboard — fall through to default

    event.preventDefault();

    let converted = td.turndown(html);

    // Clean up excessive blank lines (turndown can produce 3+ in a row)
    converted = converted.replace(/\n{3,}/g, '\n\n').trim();

    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: converted },
      selection: { anchor: from + converted.length },
    });

    return true;
  },
});

const customTheme = EditorView.theme({
  '&': {
    backgroundColor: '#0a0a0a',
  },
  '.cm-content': {
    caretColor: '#60a5fa',
  },
  '.cm-cursor': {
    borderLeftColor: '#60a5fa',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(96, 165, 250, 0.2) !important',
  },
});

export default function Editor({ content, onChange }) {
  return (
    <div className="h-full flex flex-col">
      <div className="h-8 flex items-center px-4 text-xs text-neutral-600 border-b border-[#1a1a1a] shrink-0">
        MARKDOWN
      </div>
      <div className="flex-1 overflow-auto">
        <CodeMirror
          value={content}
          onChange={onChange}
          extensions={[markdown(), customTheme, EditorView.lineWrapping, smartPaste]}
          theme={oneDark}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
          }}
          height="100%"
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
}
