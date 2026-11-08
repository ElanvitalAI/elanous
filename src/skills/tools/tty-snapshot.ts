import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H5 Phase 2 · LLM tools for TTY snapshot inspection.
//
// Three tools exposed:
//   - SnapshotPtyState  — record a point-in-time capture
//   - ListPtySnapshots  — query recent captures for a session
//   - ComparePtySnapshots — line-diff two snapshots
//
// The tools operate over the process-wide `defaultTtySnapshotStore`
// and lookup sessions via the default adapter registry. Captures
// that come with channel info (from an attached TransportObserver)
// include those buffers in the returned metadata.


import {
  defaultTtySnapshotStore,
  diffSnapshots,
  type TtySnapshot,
  type TtySnapshotStore,
} from '../../agent/tty-snapshot.js';

// ─── Session lookup · injection for tests ────────────────────────

/** Minimal read-only session view the tool needs. Keeps the tool
 *  decoupled from how a session was launched (codex-pty, future
 *  RPC-only, etc). */
export interface SessionLookup {
  findSession(id: string): { snapshot(): Promise<string>; id: string } | undefined;
  findSessionByPaneId?(paneId: string): { snapshot(): Promise<string>; id: string } | undefined;
}

let _sessionLookup: SessionLookup | null = null;
let _store: TtySnapshotStore = defaultTtySnapshotStore;

export function initTtySnapshotTools(
  sessionLookup: SessionLookup,
  store: TtySnapshotStore = defaultTtySnapshotStore,
): void {
  _sessionLookup = sessionLookup;
  _store = store;
}

export function _resetTtySnapshotToolsForTesting(): void {
  _sessionLookup = null;
  _store = defaultTtySnapshotStore;
  defaultTtySnapshotStore.clear();
}

// ─── Tool specs ──────────────────────────────────────────────────

export function buildSnapshotPtyStateTool(): LLMToolSpec {
  return {
    name: 'SnapshotPtyState',
    description:
      'Capture the current PTY state of an embodied agent session into an in-memory ring buffer. Returns a snapshot id the caller can hand to ListPtySnapshots or ComparePtySnapshots later.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'EmbodiedAgentSession id · mutually exclusive with pane_id.',
        },
        pane_id: {
          type: 'string',
          description: 'VW pane id mapped to a session · alternative to session_id.',
        },
        label: {
          type: 'string',
          description: 'Free-form tag stored with the snapshot (e.g. "before refactor").',
        },
      },
      additionalProperties: false,
    },
  };
}

export function buildListPtySnapshotsTool(): LLMToolSpec {
  return {
    name: 'ListPtySnapshots',
    description:
      'List recent PTY snapshots for an embodied agent session, newest first.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        limit: { type: 'number', description: 'Max entries to return · default 20.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  };
}

export function buildComparePtySnapshotsTool(): LLMToolSpec {
  return {
    name: 'ComparePtySnapshots',
    description:
      'Line-diff two PTY snapshots. Returns {added, removed, sameLines}. Use for "what changed between capture A and B" queries.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'First snapshot id.' },
        b: { type: 'string', description: 'Second snapshot id.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  };
}

// ─── Dispatchers ─────────────────────────────────────────────────

export async function dispatchSnapshotPtyState(
  args: Record<string, unknown>,
): Promise<{ output: string; snapshot: Pick<TtySnapshot, 'id' | 'at' | 'bytes' | 'label'> }> {
  const lookup = requireLookup();
  const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
  const paneId = typeof args.pane_id === 'string' ? args.pane_id : undefined;
  const label = typeof args.label === 'string' ? args.label : undefined;
  if (!sessionId && !paneId) {
    throw new Error('SnapshotPtyState: one of session_id / pane_id is required');
  }
  const session = sessionId
    ? lookup.findSession(sessionId)
    : lookup.findSessionByPaneId?.(paneId!);
  if (!session) {
    throw new Error(
      `SnapshotPtyState: session not found (${sessionId ? `session=${sessionId}` : `pane=${paneId}`})`,
    );
  }
  const screen = await session.snapshot();
  const snap = _store.record({
    sessionId: session.id,
    at: Date.now(),
    screen,
    label,
  });
  return {
    output: `snapshot ${snap.id} · ${snap.bytes}B${label ? ` · "${label}"` : ''}`,
    snapshot: {
      id: snap.id,
      at: snap.at,
      bytes: snap.bytes,
      ...(label !== undefined ? { label } : {}),
    },
  };
}

export async function dispatchListPtySnapshots(
  args: Record<string, unknown>,
): Promise<{
  output: string;
  snapshots: Array<{ id: string; at: number; bytes: number; label?: string }>;
}> {
  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (!sessionId) {
    throw new Error('ListPtySnapshots: session_id is required');
  }
  const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
  const entries = _store.listNewestFirst(sessionId, limit);
  return {
    output: `session ${sessionId} · ${entries.length} snapshots`,
    snapshots: entries.map((s) => ({
      id: s.id,
      at: s.at,
      bytes: s.bytes,
      ...(s.label !== undefined ? { label: s.label } : {}),
    })),
  };
}

export async function dispatchComparePtySnapshots(
  args: Record<string, unknown>,
): Promise<{
  output: string;
  added: readonly string[];
  removed: readonly string[];
  sameLines: number;
}> {
  const a = typeof args.a === 'string' ? _store.get(args.a) : undefined;
  const b = typeof args.b === 'string' ? _store.get(args.b) : undefined;
  if (!a) throw new Error(`ComparePtySnapshots: snapshot ${args.a} not found`);
  if (!b) throw new Error(`ComparePtySnapshots: snapshot ${args.b} not found`);
  const diff = diffSnapshots(a, b);
  return {
    output: `diff ${a.id} → ${b.id} · +${diff.added.length} / -${diff.removed.length} / =${diff.sameLines}`,
    added: diff.added,
    removed: diff.removed,
    sameLines: diff.sameLines,
  };
}

function requireLookup(): SessionLookup {
  if (!_sessionLookup) {
    throw new Error(
      'TTY snapshot tools not wired · call initTtySnapshotTools(lookup) first.',
    );
  }
  return _sessionLookup;
}
