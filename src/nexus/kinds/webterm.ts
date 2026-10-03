// NEXUS · webterm kind (Phase N-1 PR β placeholder · cleanup PR d session render)
//
// `webterm` is a PTY pane kind. The supervisor (N-2) treats it as
// "spawn=undefined" because the PTY lifecycle is owned by the View
// itself (NexusWebtermSession), not the cross-process supervisor.
// Health check kind = 'never' (a PTY's exit is detected by the View).
//
// PR β shipped the placeholder TextView. N-1 cleanup PR d wires the
// real PTY surface (sibling pattern · imports NexusWebtermSession
// without wrapping `Dashboard` or the dashboard preview-terminal
// renderer) and replaces the placeholder when a session is provided.
// PR e adds the production PtyBackend factory so `elanous nexus` boots
// each webterm tab into a real shell PTY automatically.

import { TextView } from '../../ui/view.js';
import type { View } from '../../ui/view.js';
import type {
  NexusWebtermSession,
  WebtermSessionStatus,
} from '../webterm/session.js';
import type { TabKind, TabSpec } from './types.js';

export interface WebtermTabOpts {
  id?: string;          // default: 'webterm:1'
  label?: string;
  cwd?: string;
  sessionId?: string;
}

export const WEBTERM_KIND: TabKind = 'webterm';

export function createWebtermTabSpec(opts: WebtermTabOpts = {}): TabSpec {
  const id = opts.id ?? 'webterm:1';
  return {
    id,
    kind: WEBTERM_KIND,
    label: opts.label ?? id,
    ...(opts.cwd || opts.sessionId ? { meta: { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) } } : {}),
  };
}

/** Build the View placed inside the detail panel for this tab.
 *
 *  Two render paths:
 *
 *    - **No session** (caller didn't pass one) — placeholder noting
 *      that PR e will wire the production PTY backend; `elanous legacy`
 *      remains the live shell fallback.
 *
 *    - **Session present** — header (tab id + status + pid) → output
 *      tail (line-oriented) → exit-code / error footer when applicable.
 *      The renderer keeps ANSI verbatim for now (cleanup PR.+ adds an
 *      ANSI processor); this matches the chat tab's "raw lines first,
 *      pretty render later" approach.
 */
export function createWebtermTabView(
  spec: TabSpec,
  session?: NexusWebtermSession,
): View {
  if (!session) return new TextView(buildPlaceholderLines(spec));
  return new TextView(buildSessionLines(spec, session));
}

function buildPlaceholderLines(spec: TabSpec): string[] {
  return [
    '',
    `  webterm tab · ${spec.id}`,
    '  ──────────────────────────────────────────────────',
    '',
    '  N-1 cleanup PR d — webterm session class wired.',
    '  PR e will inject the production PtyBackend factory',
    '  so this tab boots into a real shell PTY automatically.',
    '',
    '  Until PR e: `elanous legacy` is the live shell fallback.',
    '',
  ];
}

function buildSessionLines(spec: TabSpec, session: NexusWebtermSession): string[] {
  const status = session.getStatus();
  const pid = session.getPid();
  const out: string[] = [
    '',
    `  webterm tab · ${spec.id}  · ${formatStatus(status)}${pid !== undefined ? `  · pid ${pid}` : ''}`,
    '  ──────────────────────────────────────────────────',
    '',
  ];
  const lines = session.getOutput();
  if (lines.length === 0) {
    out.push(
      status === 'inert'
        ? '  (no PTY backend attached — set spawn factory at boot)'
        : status === 'running'
          ? '  (waiting for first chunk — type to interact)'
          : '  (no output captured)',
      '',
    );
  } else {
    for (const line of lines) out.push(`  ${line}`);
    out.push('');
  }
  // Exit / error footer — rendered after output so the most recent
  // event is closest to the prompt area.
  const exit = session.getLastExitCode();
  if (status === 'exited' && exit !== null) {
    out.push(`  exited · code ${exit}`);
  }
  const err = session.getLastError();
  if (err) {
    out.push(`  last error · ${err.message}`);
  }
  if (status === 'running') {
    out.push('', '  ──────────────────────────────────────────────────');
    out.push('  (keys forward to PTY · Ctrl-C exits the TUI loop)');
  }
  out.push('');
  return out;
}

function formatStatus(status: WebtermSessionStatus): string {
  switch (status) {
    case 'inert':   return 'inert (no PTY backend)';
    case 'running': return 'running';
    case 'exited':  return 'exited';
    case 'error':   return 'error';
  }
}
