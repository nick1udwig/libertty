export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const input = (id: string) => $<HTMLInputElement>(id);
export const select = (id: string) => $<HTMLSelectElement>(id);
export const dialog = (id: string) => $<HTMLDialogElement>(id);
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
export function button(text: string, action: () => void, className = '') {
  const control = node('button', className, text);
  control.type = 'button';
  control.onclick = action;
  return control;
}
