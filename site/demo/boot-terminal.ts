import type { DemoServer } from './server.ts';
import { install } from './shim.ts';

// Terminal and Herdr pane frames reach the backend that the workspace document hosts.
install(window, (parent as unknown as { liberttyDemo: DemoServer }).liberttyDemo);
