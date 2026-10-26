import { readFileSync } from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';

// User-facing guides become pages of the site, so search and readers land on the project's own domain.
export const pages = [
  { doc: 'docs/setup.md', slug: 'setup', label: 'Setup guide', description: 'Install the libertty server on Linux or macOS, set up Herdr, Voxtype Mobile and Tailscale, and pair your phone.' },
  { doc: 'docs/usage.md', slug: 'usage', label: 'Usage guide', description: 'Use libertty from your phone: hosts and SSH, Herdr agents, dictation, touch controls, reading mode and file transfers.' },
  { doc: 'docs/herdr.md', slug: 'herdr', label: 'Herdr agents', description: 'Open Herdr sessions in libertty to watch and steer coding agents from your phone, with mobile sizing and notifications.' },
  { doc: 'docs/reference.md', slug: 'reference', label: 'Technical reference', description: 'libertty implementation notes: shell integration, command repair, deployment and testing.' },
];

const repository = 'https://github.com/nick1udwig/libertty';
const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
// GitHub's anchor rule, so links written for the repository keep working here.
const anchor = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');

/** Links to published guides stay on the site, and links to anything else in the repository go to GitHub. */
function rewrite(href: string, doc: string) {
  if (/^[a-z]+:|^#/i.test(href)) return href;
  const [file, hash = ''] = href.split('#'), target = path.posix.normalize(path.posix.join(path.posix.dirname(doc), file));
  if (target === 'README.md') return '../' + (hash && '#' + hash);
  const page = pages.find(item => item.doc === target);
  if (page) return `../${page.slug}/` + (hash && '#' + hash);
  return `${repository}/blob/master/${target}` + (hash && '#' + hash);
}

function markdown(doc: string) {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.core.ruler.push('libertty_site', state => {
    for (const [index, token] of state.tokens.entries()) {
      if (token.type === 'heading_open') token.attrSet('id', anchor(state.tokens[index + 1].content));
      for (const child of token.children || []) if (child.type === 'link_open') child.attrSet('href', rewrite(String(child.attrGet('href') ?? ''), doc));
    }
  });
  // Wide tables scroll inside their own box, so the page never scrolls sideways on a phone.
  md.renderer.rules.table_open = () => '<div class="table"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

/** Render one guide into the site's page template. */
export function renderPage(root: string, site: string, slug: string) {
  const page = pages.find(item => item.slug === slug)!;
  const source = readFileSync(path.join(root, page.doc), 'utf8'), title = source.match(/^# (.+)$/m)?.[1] || page.label;
  const nav = pages.map(item => `<a href="../${item.slug}/"${item === page ? ' aria-current="page"' : ''}>${item.label}</a>`).join('\n        ');
  const fields: Record<string, string> = {
    title: escape(title), documentTitle: escape(/\blibertty\b/i.test(title) ? title : `${title} · libertty`),
    description: escape(page.description), canonical: `${site}${slug}/`, image: `${site}social.png`,
    nav, body: markdown(page.doc).render(source), source: `${repository}/blob/master/${page.doc}`,
  };
  return readFileSync(path.join(root, 'site/page.html'), 'utf8').replace(/%(\w+)%/g, (match, key) => fields[key] ?? match);
}
