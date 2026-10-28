import './reading-view.css';

export function readingText(value: string) {
  const text = document.createElement('pre'); text.className = 'reading-text'; text.textContent = value;
  return text;
}
