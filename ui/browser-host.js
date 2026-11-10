import { ds as dataset } from './rt.js';
export * from './rt.js';

const classes = new WeakMap();
const attributes = ['for', 'required', 'rows', 'spellcheck', 'type'];

export function ds(node, json) {
  dataset(node, json);
  const values = new Map(Object.entries(JSON.parse(json ?? "{}")));
  if (values.has('css')) {
    node.classList.remove(...(classes.get(node) ?? []));
    const next = values.get('css').split(' ').filter(Boolean);
    node.classList.add(...next);
    classes.set(node, next);
  }
  for (const name of attributes) {
    if (values.has(name)) node.setAttribute(name, values.get(name));
  }
  if (values.has('hidden')) node.hidden = values.get('hidden') === 'true';
  if (values.has('icon') && values.get('icon')) node.innerHTML = values.get('icon');
}
