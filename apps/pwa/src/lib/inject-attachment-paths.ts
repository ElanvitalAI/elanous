// Inject one or more daemon-host attachment paths into the active web
// terminal as if the user typed them — no newline, trailing space, so a
// command prefix (`cat`, `claude`, `open`, `vim`, `jq <`, …) can be
// appended before Enter. Mirrors the Raycast `ctr.sh` flow except the
// PTY lives on the same host as the saved file, so no SCP hop is needed:
//
//   ctr.sh:  Mac clipboard → SCP → remote /tmp → host clipboard → Cmd+V
//   PWA:     PWA picker    → POST /v1/attachments → daemon fs → terminal input sender (auto)
//
// (b) — also writes the same string to the PWA-side clipboard via
// navigator.clipboard.writeText so an SSH client / external editor can
// Cmd+V it later. Best-effort: insecure-context Safari (HTTP over LAN
// IP without Tailscale Serve TLS) rejects clipboard writes — that's a
// silent no-op since the inject already covered the primary path.
//
// Quoting: filenames may contain spaces / single-quotes. Wrap each path
// in single quotes and escape inner `'` as `'\''` (POSIX-safe). zsh,
// bash, and dash all accept this exact form.

import { sendToTerminal } from '@/components/terminal/terminal-input-registry';
import { debugLog } from './debug';

export interface InjectOpts {
  terminalId: string;
  paths: readonly string[];
  /** When true (default), also writes the same quoted string to the
   *  PWA-side clipboard. Set false to skip when the caller already
   *  drove its own clipboard write. */
  alsoCopyToClipboard?: boolean;
}

export function quotePathsForShell(paths: readonly string[]): string {
  return paths
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => `'${p.replace(/'/g, "'\\''")}'`)
    .join(' ');
}

export async function injectAttachmentPathsToTerminal(
  opts: InjectOpts,
): Promise<{ injected: boolean; copied: boolean }> {
  const { terminalId, paths } = opts;
  const alsoCopy = opts.alsoCopyToClipboard ?? true;
  const quoted = quotePathsForShell(paths);
  if (!quoted) return { injected: false, copied: false };

  // Trailing space so the user can type a command prefix immediately
  // (e.g. user types `cat ` first, then we inject — but more commonly
  // the inject lands on an empty prompt and the user types the prefix
  // afterward; either way the space keeps tokens separated).
  const data = `${quoted} `;

  let injected = false;
  try {
    injected = sendToTerminal(terminalId, data);
    if (injected) {
      debugLog('webterm.attach.inject.ok', {
        terminalId,
        pathCount: paths.length,
        bytes: data.length,
      });
    } else {
      debugLog('webterm.attach.inject.error', { terminalId, reason: 'no-sender' });
    }
  } catch (e) {
    debugLog('webterm.attach.inject.error', { terminalId, reason: String(e) });
  }

  let copied = false;
  if (alsoCopy && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(quoted);
      copied = true;
      debugLog('webterm.attach.clipboard.ok', { pathCount: paths.length });
    } catch (e) {
      // Insecure-context Safari, permission denied, etc. Clipboard is
      // best-effort regardless of whether a terminal sender was available.
      debugLog('webterm.attach.clipboard.skip', { reason: String(e) });
    }
  }

  return { injected, copied };
}
