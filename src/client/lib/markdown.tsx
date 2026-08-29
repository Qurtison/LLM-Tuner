import { marked } from 'marked';
import { sanitizeMarkdownHtml } from './sanitize';

export function MarkdownMessage({ markdown }: { markdown: string }) {
    const html = sanitizeMarkdownHtml(marked.parse(markdown) as string);
    return <div className="markdown-body prose prose-invert max-w-none break-words text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
}
