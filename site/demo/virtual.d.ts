declare module 'virtual:libertty-repo' {
  export const files: { name: string; mode: number; size: number }[];
  export const log: { hash: string; author: string; date: string; subject: string; body: string }[];
  export const modified: number;
  export const branch: string;
}
declare module 'virtual:libertty-engine' {
  const url: string;
  export default url;
}
