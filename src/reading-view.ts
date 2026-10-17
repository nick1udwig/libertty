import MarkdownIt from 'markdown-it';
import './reading-view.css';

export interface ReadingView { element: HTMLElement; dispose(): void }
export interface ReadingResources { load(path: string): Promise<Blob>; open(path: string): void }

const markdown = new MarkdownIt({ html: true, linkify: true, typographer: true });
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  token.attrSet('rel', 'noopener noreferrer');
  token.attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  token.attrSet('data-reading-src', token.attrGet('src') || '');
  token.attrSet('src', 'data:,');
  token.attrSet('alt', token.content);
  return self.renderToken(tokens, index, options);
};

// Raw HTML keeps only inert presentational markup, so README layouts and images render without running anything.
const blocks = new Set(['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'kbd', 'samp',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'abbr', 'br', 'hr', 'a', 'img', 'picture', 'figure', 'figcaption',
  'details', 'summary', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
const removed = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'template', 'noscript', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas', 'title', 'head']);
const attributes: Record<string, string[]> = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height', 'data-reading-src'],
  ol: ['start'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'], details: ['open'], abbr: ['title'] };
function sanitize(html: string): DocumentFragment {
  const template = document.createElement('template'); template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll('*')]) {
    const tag = element.localName;
    if (!blocks.has(tag)) { if (removed.has(tag)) element.remove(); else element.replaceWith(...element.childNodes); continue; }
    const allowed = attributes[tag] || [];
    for (const { name } of [...element.attributes]) if (!allowed.includes(name) && name !== 'align') element.removeAttribute(name);
    if (tag === 'a') {
      if (/^\s*(?:javascript|vbscript|data):/i.test(element.getAttribute('href') || '')) element.removeAttribute('href');
      element.setAttribute('rel', 'noopener noreferrer'); element.setAttribute('target', '_blank');
    }
    // Images load only through the reader's resources, never straight from the page.
    if (tag === 'img') { if (!element.hasAttribute('data-reading-src')) element.setAttribute('data-reading-src', element.getAttribute('src') || ''); element.setAttribute('src', 'data:,'); }
  }
  return template.content;
}

function localLink(file: string, href: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  try {
    const absolute = file.startsWith('/');
    const url = new URL(href, 'https://reader.invalid/' + file.replace(/^\/+/, ''));
    return (absolute ? '/' : '') + decodeURIComponent(url.pathname.slice(1));
  } catch { return undefined; }
}

export function readingView(file: string, blob: Blob, resources?: ReadingResources): ReadingView {
  const element = document.createElement('section'); element.className = 'reading-view';
  element.setAttribute('aria-label', 'Reading ' + file);
  const stage = document.createElement('div'); stage.className = 'reading-stage'; element.append(stage);
  const type = blob.type.split(';')[0];
  const urls: string[] = [];
  let disposed = false;
  const objectURL = (data: Blob) => { const url = URL.createObjectURL(data); urls.push(url); return url; };
  if (type === 'text/markdown' || /\.(?:md|markdown)$/i.test(file) && type.startsWith('text/')) {
    const paper = document.createElement('article'); paper.className = 'reading-paper reading-markdown';
    paper.textContent = 'Loading Markdown…'; stage.append(paper);
    void blob.text().then(value => {
      if (disposed) return;
      paper.replaceChildren(sanitize(markdown.render(value)));
      for (const image of paper.querySelectorAll<HTMLImageElement>('img[data-reading-src]')) {
        const src = image.dataset.readingSrc || '';
        const path = localLink(file, src);
        if (!path || !resources) { image.replaceWith(document.createTextNode(image.alt)); continue; }
        void resources.load(path).then(data => {
          if (!disposed) image.src = objectURL(data);
        }).catch(() => { if (!disposed) image.replaceWith(document.createTextNode(image.alt)); });
      }
    });
    paper.addEventListener('click', event => {
      const link = (event.target as Element).closest('a[href]');
      if (!link || !paper.contains(link)) return;
      const href = link.getAttribute('href') || '';
      const path = localLink(file, href);
      if (!path || !resources) return;
      event.preventDefault(); resources.open(path);
    });
  } else if (type.startsWith('text/') || ['application/json', 'application/xml'].includes(type)) {
    const paper = document.createElement('article'); paper.className = 'reading-paper';
    const text = document.createElement('pre'); text.className = 'reading-text';
    text.textContent = 'Loading text…'; paper.append(text); stage.append(paper);
    void blob.text().then(value => { if (!disposed) text.textContent = value; });
  } else if (type.startsWith('image/')) {
    const image = document.createElement('img'); image.src = objectURL(blob); image.alt = file.split('/').at(-1) || 'Image'; image.className = 'reading-image';
    stage.append(image);
  } else if (type === 'application/pdf') {
    const frame = document.createElement('iframe'); frame.src = objectURL(blob); frame.title = 'PDF: ' + file; frame.className = 'reading-pdf'; stage.append(frame);
  } else if (type.startsWith('audio/') || type.startsWith('video/')) {
    const media = document.createElement(type.startsWith('audio/') ? 'audio' : 'video');
    media.src = objectURL(blob); media.controls = true; media.className = 'reading-media'; stage.append(media);
  } else {
    const message = document.createElement('p'); message.className = 'reading-unsupported';
    message.textContent = 'This file type has no browser preview yet.'; stage.append(message);
  }
  return { element, dispose: () => { disposed = true; for (const url of urls) URL.revokeObjectURL(url); element.remove(); } };
}

export function readingMessage(file: string, message: string, hint?: string): HTMLElement {
  const element = document.createElement('section'); element.className = 'reading-view reading-empty';
  const title = document.createElement('h1'); title.textContent = file.split('/').at(-1) || file;
  const detail = document.createElement('p'); detail.textContent = message;
  element.append(title, detail);
  if (hint) { const help = document.createElement('p'); help.className = 'reading-hint'; help.textContent = hint; element.append(help); }
  return element;
}
