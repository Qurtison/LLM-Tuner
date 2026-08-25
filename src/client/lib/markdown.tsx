import { marked } from 'marked';
import { useState } from 'react';
import { sanitizeMarkdownHtml } from './sanitize';

export { sanitizeMarkdownHtml } from './sanitize';

export function MarkdownMessage({ markdown }: { markdown: string }) {
    const html = sanitizeMarkdownHtml(marked.parse(markdown) as string);
    return <div className="markdown-body prose prose-invert max-w-none break-words text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ReasoningDisclosure({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return <div className="rounded border border-neutral-700 bg-neutral-900"><button type="button" className="w-full px-3 py-2 text-left text-xs text-neutral-300" aria-expanded={open} onClick={() => setOpen(!open)}>Reasoning {open ? '▲' : '▼'}</button>{open && <div className="p-3 text-sm text-neutral-300">{children}</div>}</div>;
}
