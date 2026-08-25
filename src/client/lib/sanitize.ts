// Shared HTML sanitizer for marked output — removes executable elements, event handlers,
// unsafe URLs, and srcdoc. Used by ChatPanel and HfSearchPanel.
export function sanitizeMarkdownHtml(html: string): string {
    if (typeof DOMParser === 'undefined') return '';
    const document = new DOMParser().parseFromString(html, 'text/html');
    for (const element of document.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form')) element.remove();
    for (const element of document.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(javascript|data:text\/html|vbscript):/.test(value))) element.removeAttribute(attribute.name);
        }
    }
    return document.body.innerHTML;
}
