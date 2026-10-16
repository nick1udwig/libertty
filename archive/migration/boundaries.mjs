// HTTP bodies not declared in the frontend protocol modules.
export function boundaries(definitions) {
  const string = { type: 'string' }, bool = { type: 'boolean' };
  const ref = name => ({ $ref: '#/$defs/' + name });
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
  const array = (items, limits = {}) => ({ type: 'array', items, ...limits });
  const action = (name, properties = {}, required = Object.keys(properties)) => object({ action: { const: name }, ...properties }, ['action', ...required]);
  const union = variants => ({ anyOf: variants });
  const name = { type: 'string', minLength: 1, maxLength: 100, 'x-utf16MaxLength': 100 };
  const passphrase = { type: 'string', minLength: 1 };
  const privateKey = { type: 'string', maxLength: 20000, 'x-utf16MaxLength': 20000 };
  const path = { type: 'string', maxLength: 4096, 'x-utf16MaxLength': 4096, pattern: '^[^\\u0000]*$' };
  definitions.Json = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };
  definitions.PathReply = object({ path });
  definitions.ImageUploadReply = object({ path: { ...path, pattern: '^/tmp/libertty-image-[a-f0-9]+\\.(png|jpg|jpeg|webp|gif)$' } });
  definitions.HerdrSuggestReply = object({ candidates: { type: 'array', items: ref('Candidate'), maxItems: 4 } });
  definitions.DictationStatus = object({ installed: bool, available: bool, reason: string }, ['installed', 'available']);
  definitions.EmptyRequest = object({}, []);
  definitions.HealthReply = object({ ok: { const: true }, version: string, commit: { anyOf: [string, { type: 'null' }] }, platform: string, node: string }, ['ok', 'version']);
  definitions.SessionsReply = array(object({ id: string, name: string, kind: { enum: ['http', 'ssh'] }, state: ref('ShellState') }));
  definitions.SSHProbeReply = object({ milliseconds: { type: 'number', minimum: 0 } });
  definitions.KeychainReply = object({ keys: array(ref('KeyInfo')), knownHosts: array(ref('KnownHost')) });
  definitions.KeychainRequest = union([
    action('delete', { id: string }), action('rename', { id: string, name }), action('forget', { host: string, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['host']),
    action('inspect', { privateKey, passphrase }), action('export', { id: string, passphrase }),
    action('create', { name, passphrase, privateKey }, ['name', 'passphrase']),
    action('backup', { name, passphrase, privateKey, replaceId: string }, ['name', 'passphrase']),
  ]);
  definitions.KeyInspectionReply = object({ publicKey: string, fingerprint: string });
  definitions.ExportedKeyReply = object({ id: string, name: string, publicKey: string, fingerprint: string, createdAt: string, privateKey });
  definitions.KeychainMutationReply = union([ref('KeychainReply'), ref('KeyInfo'), ref('KeyInspectionReply'), ref('ExportedKeyReply')]);
  definitions.VaultData = object({ keys: array(union([
    object({ id: string, name, publicKey: string, fingerprint: string, createdAt: string, reference: ref('KeyReference') }),
    object({ id: string, name, publicKey: string, fingerprint: string, createdAt: string,
      salt: { type: 'string', 'x-decodedBytes': 16 }, iv: { type: 'string', 'x-decodedBytes': 12 }, tag: { type: 'string', 'x-decodedBytes': 16 }, ciphertext: string }),
  ]), { maxItems: 64 }), knownHosts: array(ref('KnownHost'), { maxItems: 1000 }) });
  const paths = array(path, { minItems: 1, maxItems: 100 });
  definitions.FileActionRequest = union([
    action('read', { path }), action('write', { path, text: { type: 'string', 'x-utf8MaxBytes': 32768, pattern: '^[^\\u0000]*$' }, version: string }),
    action('rename', { path, name: { type: 'string', minLength: 1, 'x-utf8MaxBytes': 255, pattern: '^[^/\\\\\\u0000-\\u001f\\u007f]+$' } }),
    action('copy', { paths, destination: path }), action('delete', { paths }),
  ]);
  definitions.FileTextReply = object({ text: string, version: string, mode: { type: 'integer', minimum: 0 } });
  definitions.FileActionReply = union([ref('Ok'), ref('FileTextReply')]);
  definitions.FileMkdirRequest = object({ path, name: string });
  definitions.FileDownloadRequest = object({ path });
  definitions.FileDownloadReply = object({ ticket: string, name: string, size: { type: 'integer', minimum: 0 } });
  definitions.TransferRequestBody = union([action('ack', { id: string }), action('download', { id: string })]);
  definitions.PluginReadReply = object({ path, text: string, truncated: bool });
  definitions.DictationInstallRequest = object({ prompt: { type: 'integer', minimum: 0 }, revision: { type: 'integer', minimum: 0 } });
  definitions.CapturedRequest = object({ id: string, action: string, passphrase, trust: string }, ['id']);
  definitions.CapturedReply = union([ref('Ok'), object({ native: bool, message: string }, ['native']), ref('SessionReply'),
    object({ id: string, name: string, host: string, port: { type: 'integer' }, username: string, key: ref('KeyInfo') }, ['id', 'name', 'host', 'port', 'username']),
    object({ herdrSession: string, herdrSource: string, name: string, remote: bool })]);
  definitions.HerdrConnectRequest = object({ source: string, session: { anyOf: [string, { type: 'null' }] } }, ['source']);
  definitions.HerdrConnectReply = object({ herdrSession: string, herdrSource: string });
  definitions.HerdrOptionsReply = object({ kinds: array(string), actions: array(string) }, ['kinds']);
  definitions.HerdrActionRequest = union([
    action('split', { workspaceId: string, terminalId: string, direction: { enum: ['right', 'down'] } }),
    action('list-worktrees', { workspaceId: string }),
    action('new-worktree', { workspaceId: string, branch: name }),
    action('open-worktree', { workspaceId: string, path }),
    action('create-space', { workspaceId: string, terminalId: string }, []),
    action('move-space', { workspaceId: string, beforeWorkspaceId: string }, ['workspaceId']),
    action('create', { workspaceId: string, name, kind: string, cwd: path }, ['workspaceId', 'name', 'kind']),
    action('rename-space', { workspaceId: string, name }), action('close-space', { workspaceId: string }),
    action('rename', { terminalId: string, name }), action('close', { terminalId: string }),
  ]);
  definitions.PushSubscription = object({ endpoint: { type: 'string', format: 'uri', maxLength: 4096 }, keys: object({
    p256dh: { type: 'string', pattern: '^[A-Za-z0-9_-]+={0,2}$', 'x-decodedBytes': 65 },
    auth: { type: 'string', pattern: '^[A-Za-z0-9_-]+={0,2}$', 'x-decodedBytes': 16 },
  }) });
  definitions.PushSubscribeRequest = object({ subscription: ref('PushSubscription') });
  definitions.PushDeviceRequest = object({ device: string });
  definitions.PushViewRequest = object({ device: string, tabId: string });
  definitions.PushKeyReply = object({ publicKey: string });
  definitions.PushDeviceReply = object({ device: string });
  definitions.PushKeysData = object({ publicKey: string, privateKey: string });
  definitions.PushData = object({ version: { const: 1 }, devices: array(object({ id: string, owner: string, subscription: ref('PushSubscription'),
    views: array(object({ id: string, session: string, source: string, socketPath: string, remote: bool }, ['id', 'session', 'source', 'remote']), { maxItems: 16 }) }), { maxItems: 256 }), checkpoints: { type: 'object', additionalProperties: ref('Json') } }, ['version', 'devices']);
  const routes = [];
  const route = (method, path, request, response, options = {}) => routes.push({ method, path, authentication: 'paired-client', origin: method === 'GET' ? 'optional' : 'required',
    request: request ? ref(request) : null, response: response ? ref(response) : null, requestEncoding: request ? 'application/json' : 'none', responseEncoding: 'application/json',
    bodyLimitUTF16: request ? 16384 : 0, error: ref('Error'), statuses: [200, 400, 401, 403, 404], ...options });
  route('GET', '/healthz', null, 'HealthReply', { authentication: 'none' });
  route('POST', '/api/connect', 'ConnectRequest', 'ConnectReply', { authentication: 'pairing-token-or-paired-client', statuses: [200, 400, 401, 403, 404, 429] });
  route('GET', '/api/ping', null, 'Ok');
  route('GET', '/api/context', null, 'Catalog');
  route('POST', '/api/suggest', 'SuggestRequest', 'SuggestReply', { engine: 'server', statuses: [200, 400, 401, 403, 404, 409], timeoutMs: 5000 });
  route('POST', '/api/facts', null, 'FactsReply', { request: union([ref('ContextRequest'), ref('FactsRequest')]), response: union([ref('ContextReply'), ref('FactsReply')]), requestEncoding: 'application/json', bodyLimitUTF16: 16384, timeoutMs: 5000 });
  route('GET', '/api/sessions', null, 'SessionsReply'); route('POST', '/api/sessions', 'SessionsRequest', 'SessionReply');
  for (const name of ['new', 'sessions/close', 'ticket']) route('POST', '/api/' + name, 'EmptyRequest', name === 'new' ? null : name === 'ticket' ? 'TicketReply' : 'Ok', name === 'new' ? { response: object({ state: ref('ShellState') }) } : {});
  route('GET', '/api/keychain', null, 'KeychainReply'); route('POST', '/api/keychain', 'KeychainRequest', 'KeychainMutationReply');
  route('POST', '/api/ssh/probe', 'SSHConnection', 'SSHProbeReply', { statuses: [200, 400, 401, 403, 404, 429] });
  route('POST', '/api/ssh/captured', 'CapturedRequest', 'CapturedReply');
  route('GET', '/api/dictation', null, 'DictationStatus'); route('POST', '/api/dictation/install', 'DictationInstallRequest', 'Ok');
  route('GET', '/api/plugins/read', null, 'PluginReadReply', { query: object({ path: string }) });
  route('GET', '/api/files/list', null, 'FileListing', { query: object({ path: string }, []) });
  route('POST', '/api/files/mkdir', 'FileMkdirRequest', 'PathReply');
  route('POST', '/api/files/action', 'FileActionRequest', 'FileActionReply', { bodyLimitUTF16: 256 * 1024, statuses: [200, 400, 401, 403, 404, 409, 504] });
  route('POST', '/api/files/upload', null, 'Json', { requestEncoding: 'application/octet-stream', query: object({ path: string, name: string }, ['name']), streaming: true, bodyLimitUTF16: null, bodyLimitBytes: 1024 ** 3 });
  for (const imageRoute of ['/api/images/upload', '/api/herdr/images/upload']) route('POST', imageRoute, null, 'ImageUploadReply', { requestEncoding: 'application/octet-stream', query: object({ name: string }), bodyLimitUTF16: null, bodyLimitBytes: 20 * 1024 ** 2, statuses: [200, 400, 401, 403, 404, 413] });
  route('POST', '/api/files/download', 'FileDownloadRequest', 'FileDownloadReply');
  route('POST', '/api/files/transfer', 'TransferRequestBody', 'Json');
  route('GET', '/api/files/download', null, null, { authentication: 'single-use-download-ticket', query: object({ ticket: string }), responseEncoding: 'application/octet-stream', streaming: true });
  for (const name of ['file', 'capture']) route('GET', '/api/reading/' + name, null, null, { query: object({ [name === 'file' ? 'path' : 'id']: string }), responseEncoding: 'binary-mime', responseLimitBytes: 20 * 1024 * 1024 });
  route('DELETE', '/api/reading/capture', null, 'Ok', { query: object({ id: string }) });
  route('POST', '/api/herdr/connect', 'HerdrConnectRequest', 'HerdrConnectReply');
  route('POST', '/api/herdr/captured', 'CapturedRequest', 'CapturedReply');
  route('GET', '/api/herdr/snapshot', null, 'HerdrSnapshot'); route('GET', '/api/herdr/options', null, 'HerdrOptionsReply');
  route('POST', '/api/herdr/suggest', 'SuggestRequest', 'HerdrSuggestReply', { timeoutMs: 5000 });
  route('POST', '/api/herdr/action', 'HerdrActionRequest', 'Json', { bodyLimitUTF16: 64 * 1024, responseContract: 'Forward the selected Herdr RPC result unchanged.' });
  route('POST', '/api/herdr/ticket', 'EmptyRequest', 'TicketReply'); route('POST', '/api/herdr/notifications', 'PushViewRequest', 'Ok');
  route('GET', '/api/notifications/key', null, 'PushKeyReply'); route('POST', '/api/notifications/subscribe', 'PushSubscribeRequest', 'PushDeviceReply');
  route('POST', '/api/notifications/unsubscribe', 'PushDeviceRequest', 'Ok'); route('POST', '/api/notifications/unwatch', 'PushViewRequest', 'Ok');
  return { version: 1, basePath: 'All paths are relative to LIBERTTY_BASE_PATH.', schemas: './schemas.json',
    unknownFields: 'ignore', errors: ref('Error'), securityHeaders: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' },
    routes, sockets: [{ path: '/ws', client: ref('ClientMessage'), server: ref('ServerMessage'), maxPayloadBytes: 128 * 1024, lifecycle: './ws-lifecycle.json#/terminal' },
      { path: '/herdr/ws', client: ref('HerdrClientMessage'), server: union([ref('HerdrMessage'), ref('ServerMessage')]), maxPayloadBytes: 128 * 1024, lifecycle: './ws-lifecycle.json#/herdr' }] };
}
export const lifecycle = {
  version: 1,
  reference: '455386bc9443e778f381e1eeaf37cec5a35c2f75',
  terminal: {
    states: ['detached', 'attached', 'paused', 'disposed'],
    shellStates: ['starting', 'ready', 'busy', 'exited'],
    authentication: { host: 'allowlist', origin: 'same-origin-or-allowlist', owner: 'paired-client', session: 'owned-live-non-file-session',
      ticket: { bytes: 32, encoding: 'hex', ttlMs: 15000, maxPending: 256, singleUse: true, scope: ['owner', 'session'] } },
    encodings: { text: 'UTF-8 JSON', binary: 'framed Opus dictation audio' },
    unknownTag: 'ignore', malformedJSON: { action: 'close', code: 1008, reason: 'Invalid message' },
    transitions: [
      { from: ['detached', 'attached', 'paused'], event: 'upgrade', to: 'attached',
        actions: ['cancel-dictation', 'cancel-expiry', 'replace-current-socket', 'reset-ack-window', 'send-hello', 'send-state', 'replay-output', 'replay-captures-and-transfers', 'push-context'] },
      { from: ['attached', 'paused'], event: 'replacement-attachment', oldSocket: { code: 4001, reason: 'This shell was opened in another tab.' }, inputAuthority: 'newest-socket-only' },
      { from: ['attached'], event: 'output-window-full', to: 'paused', actions: ['pause-PTY'] },
      { from: ['paused'], event: 'acknowledged-window-drained', to: 'attached', actions: ['flush-output', 'resume-PTY'] },
      { from: ['attached', 'paused'], event: 'current-socket-close', to: 'detached', actions: ['cancel-dictation', 'stop-context-push', 'clear-ack-window', 'resume-PTY', 'start-expiry'] },
      { from: ['detached', 'attached', 'paused'], event: 'PTY-exit', preserveState: true, shellState: 'exited', actions: ['send-state'] },
      { from: ['detached', 'attached', 'paused'], event: 'expiry-or-shutdown', to: 'disposed', actions: ['dispose-PTY', 'cancel-jobs', 'remove-temporary-captures'] },
    ],
    stream: { sequence: 'monotonic-per-stream', after: 'nonnegative-safe-integer',
      gap: ['requested-stream-differs', 'after-exceeds-last-sequence', 'positive-after-precedes-first-sequence-minus-one'],
      helloBeforeReplay: true, reset: ['after-is-zero', 'gap'], replayMaxBytes: 2 * 1024 * 1024, replayMaxChunks: 16384, retainAtLeastOneChunk: true,
      windowBytes: 128 * 1024, sendWhile: 'outstanding-bytes-less-than-window', allowOneChunkOvershoot: true,
      acknowledgement: 'safe-integer-not-greater-than-last-sent-sequence' },
    command: { require: ['ready', 'not-exited', 'no-capture', 'matching-prompt'], maxUTF16: 4000, forbidControls: true, deduplication: 'command-ID', maxCachedResults: 1000, editsThenSubmits: true },
    replace: { require: ['ready', 'not-exited', 'no-capture', 'matching-prompt', 'matching-input-revision'], maxUTF16: 4000, forbidControls: true, submits: false },
    repair: { require: ['ready', 'not-exited', 'no-capture', 'matching-prompt', 'matching-input-revision', 'matching-attachment', 'not-cancelled'], maxUTF16: 2000, timeoutMs: 10000, submits: false, result: 'repair-result', cancellation: 'repair-cancel', readingIntent: 'explicit' },
    input: { maxUTF16: 65536, require: ['not-exited', 'no-capture'], incrementsInputRevision: true },
    inputLine: { timeoutMs: 2000, require: ['ready', 'not-exited', 'no-capture', 'no-pending-input-line', 'matching-prompt', 'matching-input-revision'], cursorEncoding: 'UTF-16-prefix-length' },
    resize: { type: 'integer', clamp: { cols: [2, 300], rows: [2, 120] } },
    expiryMs: 60 * 60 * 1000,
  },
  herdr: { authentication: { host: 'allowlist', origin: 'same-origin-or-allowlist', owner: 'paired-client', session: 'owned-source-and-terminal', ticketTTLms: 15000, ticketSingleUse: true },
    maxConnections: 64, encodings: { text: 'UTF-8 JSON', frameBytes: 'base64' },
    resize: { type: 'integer', cols: [1, 1000], rows: [1, 1000], authority: 'latest-mobile-controller' },
    repaint: 'request-full-frame-after-incremental-frame-gap', dispose: ['close-streams', 'cancel-dictation', 'remove-notification-presence', 'unsubscribe-source'] },
};
