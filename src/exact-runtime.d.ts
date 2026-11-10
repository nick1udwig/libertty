declare module '*.gen/main.js';
declare module '*.gen/bridge.js' {
  export function publish(source: string, value: unknown): void;
}
