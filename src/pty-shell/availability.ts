import { bunNativePtyAvailable } from './bun-native-pty.js';

/** Keep the capability probe independent of PTY runtime initialization. */
export function ptyAvailable(): boolean {
  if (bunNativePtyAvailable()) return true;
  try { require.resolve('node-pty'); return true; } catch { return false; }
}
