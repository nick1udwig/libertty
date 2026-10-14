const svg = (body: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const uploadIcon = svg('<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>');
export const downloadIcon = svg('<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>');
export const folderIcon = svg('<path d="M3 7V5h6l3 3h9v12H3Z"/>');
export const moreIcon = svg('<circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/>');
export const searchIcon = svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>');
export const chevronIcon = svg('<path d="m9 5 7 7-7 7"/>');
export const fileOptionIcons = {
  edit: svg('<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>'),
  delete: svg('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'),
  folder: svg('<path d="M3 7V5h6l3 3h9v12H3Zm12 7h6m-3-3v6"/>'),
  name: svg('<path d="m3 17 4-10 4 10M5 13h4m5-6h7l-7 10h7"/>'),
  date: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M7 3v4m10-4v4M7 14h2m6 0h2m-10 3h2m6 0h2"/>'),
  size: svg('<path d="M4 6h16M4 12h11M4 18h6"/>'),
  kind: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17" cy="6.5" r="3.5"/><path d="m6.5 14 4.5 7H2Z"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'),
  hidden: svg('<path d="m3 3 18 18M9 5.5A12 12 0 0 1 22 12a16 16 0 0 1-4 4M6 6a18 18 0 0 0-4 6s3 7 10 7a13 13 0 0 0 4-1M10 10a3 3 0 0 0 4 4"/>'),
  refresh: svg('<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>'),
};
export const hostIcon = svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>');
export const keyIcon = svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-6-1 2 2"/>');
export const backendIcon = svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>');
export const shieldIcon = svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>');
export const terminalIcon = svg('<path d="m5 7 5 5-5 5m8 0h6"/>');
export const vaultIcon = svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>');
export const settingsIcon = svg('<path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>');
export const closeIcon = svg('<path d="m6 6 12 12M18 6 6 18"/>');
export const plusIcon = svg('<path d="M12 5v14M5 12h14"/>');
export const sortIcon = svg('<path d="M7 4v16m0 0-3-3m3 3 3-3m4-11h7m-7 6h5m-5 6h3"/>');
export const herdrIcon = svg('<circle cx="12" cy="6" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M10.7 8.2 7.3 14.8m6-6.6 3.4 6.6M8.5 17h7"/>');
export const ellipsisIcon = svg('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>');
export const chevronDownIcon = svg('<path d="m6 9 6 6 6-6"/>');
