import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

export default function Preview({ content }) {
  return (
    <div className="h-full flex flex-col">
      <div className="h-8 flex items-center px-4 text-xs text-neutral-600 border-b border-[#1a1a1a] shrink-0 -mx-6 -mt-6 mb-4 px-6">
        PREVIEW
      </div>
      <div className="markdown-preview max-w-3xl">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
