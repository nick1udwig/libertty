export const browserGroups = {
  'browser.mjs': ['terminal-layout-browser.mjs', 'terminal-repair-browser.mjs', 'terminal-input-browser.mjs'],
  'dictation-browser.mjs': ['dictation-availability-browser.mjs', 'dictation-capture-browser.mjs', 'dictation-program-browser.mjs'],
  'reconnect-browser.mjs': ['reconnect-native-browser.mjs', 'reconnect-herdr-browser.mjs'],
  'workspace-browser.mjs': ['workspace-core-browser.mjs', 'workspace-vault-browser.mjs', 'workspace-ssh-browser.mjs'],
  'herdr-browser.mjs': ['herdr-interaction-browser.mjs', 'herdr-navigation-browser.mjs', 'herdr-transport-browser.mjs'],
};

export function expandBrowserNames(files) {
  return files?.flatMap(file => browserGroups[file] || [file]);
}

export function expandBrowserCases(cases) {
  return cases.flatMap(([file, overrides]) => (browserGroups[file] || [file]).map(file => [file, overrides]));
}
