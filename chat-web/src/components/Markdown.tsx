// An answer as markdown. react-markdown builds React elements, so nothing the model writes
// reaches the page as HTML. Line breaks stay line breaks, because a model's verse and
// ASCII tables are written that way. Images are links and never load by themselves: an
// answer should not be able to make the reader's browser call an address it chose.

import { memo, useDeferredValue } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';

const PLUGINS = [remarkGfm, remarkBreaks];

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return textOf((node.props as { readonly children?: ReactNode }).children);
  }
  return '';
}

function languageOf(node: ReactNode): string {
  const child = Array.isArray(node) ? node[0] : node;
  if (typeof child !== 'object' || child === null || !('props' in child)) return '';
  const name = (child.props as { readonly className?: unknown }).className;
  return typeof name === 'string' ? (/language-([\w+#.-]+)/.exec(name)?.[1] ?? '') : '';
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  return (
    <figure className="code">
      <figcaption>
        <span>{languageOf(children) || 'text'}</span>
        <CopyButton text={textOf(children).replace(/\n$/, '')} />
      </figcaption>
      <pre>{children}</pre>
    </figure>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener">
      {alt === undefined || alt === '' ? 'image' : alt}
    </a>
  ),
  table: ({ children }) => (
    <div className="table">
      <table>{children}</table>
    </div>
  ),
};

// Parsing is the one cost that grows with the answer, so while text is arriving React may
// skip a render rather than fall behind the stream.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const settled = useDeferredValue(text);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {settled}
      </ReactMarkdown>
    </div>
  );
});
