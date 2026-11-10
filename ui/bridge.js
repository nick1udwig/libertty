import { data, commit, R, Resources } from './rt.js';
import { sourceTypes } from './names.js';

const values = new Map();
const encode = (value, type) => {
  if (!type || typeof type === 'string') return value;
  if (Array.isArray(type)) return value.map(item => encode(item, type[1]));
  return Object.keys(type).map(key => encode(value[key], type[key]));
};

data.answer = source => {
  if (!(source in sourceTypes)) throw new Error(`Unknown UI source: ${source}`);
  return { v: encode(values.get(source) ?? [], sourceTypes[source][1]) };
};
data.ready = ready => ready();

export function publish(source, value) {
  if (!(source in sourceTypes)) throw new Error(`Unknown UI source: ${source}`);
  values.set(source, value);
  const accepted = commit(() => {
    for (const resource of Resources) if (resource.source === source) R(resource);
  }, `publish ${source}`);
  if (accepted === false) throw new Error(`Exact refused the ${source} update.`);
}
