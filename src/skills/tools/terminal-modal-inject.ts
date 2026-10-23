// terminal_modal_inject native tool.
//
// Mutating counterpart to the read-only observe/list tools. Writes
// bytes or a named key into a session's PTY stdin. Because this is
// agent-driven mutation of a live PTY (potentially a user's
// claude-code session), it wraps the write in an approval hook.
//
// Approval protocol:
//   • deps.approver(req) returns Promise<boolean>
//   • When approver is absent → rejection w/ explicit "no approver
//     wired" error so no agent can sneak-inject in a headless
//     test / detached process path.
//   • Dashboard wires approver = showInjectApprovalModal (P14 UI).
//
// Rate limit:
//   • 256 bytes per chunk, 10ms between chunks — mirrors cmux's
//     surface.send_text throttle so the PTY line buffer isn't
//     overflowed.

import type { LLMToolSpec } from '../../llm.js';
import type { TerminalSessionRegistry } from '../../terminal/session-registry.js';

const CHUNK_BYTES = 256;
const CHUNK_DELAY_MS = 10;

/** Named-key → bytes mapping. Subset of keyEventToTerminalBytes but
 *  keyed by common single-word names so the LLM can say key:'Enter'
 *  or key:'C-c' instead of reasoning about raw escape sequences. */
const KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Left: '\x1b[D',
  Right: '\x1b[C',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-z': '\x1a',
  'C-l': '\x0c',
  'C-u': '\x15',
  'C-r': '\x12',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
};

export interface InjectApprovalRequest {
  sessionId: string;
  sessionTitle: string;
  previewBytes: string;
  isKey: boolean;
  keyName?: string;
  totalBytes: number;
}

export function buildTerminalModalInjectTool(): LLMToolSpec {
  return {
    name: 'TerminalModalInject',
    description:
      'Write bytes or a named key into a terminal modal session\'s stdin. MUTATING — requires user approval. ' +
      'Use for answering y/n prompts, steering a claude-code/codex session, or feeding REPL commands. ' +
      'Provide either `input` (raw text, newlines NOT auto-appended — add your own \\r if needed) OR `key` (one of: ' +
      Object.keys(KEY_BYTES).join(', ') + ').',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id from TerminalModalList.' },
        input: { type: 'string', description: 'Raw bytes to write. Use "\\r" for Enter.' },
        key: { type: 'string', description: 'Named key (Enter, Tab, Escape, C-c, Up, Down, PageUp, …). Mutually exclusive with input.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export interface DispatchInjectDeps {
  registry?: TerminalSessionRegistry;
  approver?: (req: InjectApprovalRequest) => Promise<boolean>;
  /** Delay between chunk writes. Defaults to 10ms. Tests override to 0. */
  chunkDelayMs?: number;
  /** Sleep implementation for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export async function dispatchTerminalModalInject(
  rawArgs: Record<string, unknown>,
  deps: DispatchInjectDeps = {},
): Promise<{ output: string }> {
  const registry = deps.registry ?? (await import('../../dashboard/terminal/session.js')).getDashboardTerminalSessions();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const session = registry.get(id);
  if (!session) throw new Error(`unknown session id ${id}`);
  if (session.state === 'exited') throw new Error(`session ${id} already exited`);

  const hasInput = typeof rawArgs.input === 'string';
  const hasKey = typeof rawArgs.key === 'string' && rawArgs.key.length > 0;
  if (!hasInput && !hasKey) {
    throw new Error(`provide either 'input' or 'key'`);
  }
  if (hasInput && hasKey) {
    throw new Error(`'input' and 'key' are mutually exclusive`);
  }

  let bytes: string;
  let keyName: string | undefined;
  if (hasKey) {
    keyName = String(rawArgs.key);
    const mapped = KEY_BYTES[keyName];
    if (!mapped) throw new Error(`unknown key "${keyName}" — allowed: ${Object.keys(KEY_BYTES).join(', ')}`);
    bytes = mapped;
  } else {
    bytes = String(rawArgs.input ?? '');
  }

  // Approval gate — fail closed.
  if (!deps.approver) {
    throw new Error(
      'terminal_modal_inject refused — no approver is wired. ' +
      'This tool requires explicit user approval; the dashboard provides the approver at runtime.',
    );
  }
  const previewBytes = bytes.length > 60 ? bytes.slice(0, 60) + '…' : bytes;
  const approved = await deps.approver({
    sessionId: session.id,
    sessionTitle: session.title,
    previewBytes,
    isKey: hasKey,
    keyName,
    totalBytes: bytes.length,
  });
  if (!approved) {
    throw new Error('terminal_modal_inject rejected by user');
  }

  // Chunked write so we don't flood the PTY line buffer in a single
  // syscall. 256 bytes/chunk + 10ms sleep matches cmux's send_text
  // throttle.
  const delay = deps.chunkDelayMs ?? CHUNK_DELAY_MS;
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  let sent = 0;
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    const chunk = bytes.slice(i, i + CHUNK_BYTES);
    session.preview.write(chunk);
    sent += chunk.length;
    if (i + CHUNK_BYTES < bytes.length && delay > 0) await sleep(delay);
  }
  return {
    output: `TerminalModalInject id=${session.id} bytes_sent=${sent}${keyName ? ` key=${keyName}` : ''}`,
  };
}

/** Default approver factory — resolves true after a brief delay.
 *  Intended for tests + non-interactive environments. Real dashboard
 *  supplies a modal-backed approver. */
export function autoApprover(): (req: InjectApprovalRequest) => Promise<boolean> {
  return async () => true;
}

export { KEY_BYTES };
