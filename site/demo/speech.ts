/** Stands in for Voxtype: the browser's speech recognition transcribes, and scripted phrases cover browsers without it. */
const scripted = ['look at readme dot md', 'cd docs', 'git log dash dash one line', 'ls dash l a', 'grep dash r herdr docs'];
let turn = 0;
interface Recognition extends EventTarget { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; abort(): void }
type Constructor = new () => Recognition;

export interface Listening { finish(): Promise<string>; cancel(): void }
export function listen(): Listening {
  const Recognizer = ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) as Constructor | undefined;
  const fallback = () => scripted[turn++ % scripted.length];
  if (!Recognizer) return { finish: async () => fallback(), cancel() {} };
  const recognition = new Recognizer(), heard: string[] = [];
  let ended = false, wake: () => void = () => {};
  recognition.continuous = true; recognition.interimResults = false; recognition.lang = navigator.language || 'en-US';
  recognition.addEventListener('result', (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) heard.push(event.results[i][0].transcript.trim());
  });
  recognition.addEventListener('end', () => { ended = true; wake(); });
  try { recognition.start(); } catch { ended = true; }
  return {
    async finish() {
      // A recognition service that never answers counts as unavailable.
      try { if (!ended) { const done = new Promise<void>(resolve => { wake = resolve; }); recognition.stop(); await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))]); if (!ended) recognition.abort(); } }
      catch { /* A recognizer that cannot stop has already ended. */ }
      // Recognition often hears nothing inside a framed page on phones, so the demo still shows a dictated command.
      return heard.join(' ').trim() || fallback();
    },
    cancel() { ended = true; recognition.abort(); },
  };
}
