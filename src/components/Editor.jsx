import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';

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
          extensions={[markdown(), customTheme, EditorView.lineWrapping]}
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
