import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { Database } from 'bun:sqlite';

export type MsgHookEvent = 'user-prompt-submit' | 'stop' | 'session-start';
export type MsgHookFormat = 'claude' | 'codex';

export interface MsgHookMessage {
  id: number;
  from: string;
  to: string;
  body: string;
  kind?: string;
}

export interface MsgHookInput {
  event: MsgHookEvent;
  format: MsgHookFormat;
  cwd: string;
  sessionId?: string;
  seat?: string;
  messages: MsgHookMessage[];
  stateDir?: string;
}

export function seatFromCwd(cwd: string): string | null {
  const match = cwd.replaceAll('\\', '/').match(/(?:^|\/)elanous-hq\/seats\/([A-Za-z][A-Za-z0-9_-]*)(?:\/|$)/);
  return match?.[1]?.toUpperCase() ?? null;
}

function idsFor(messages: MsgHookMessage[]): number[] {
  return [...new Set(messages.map(message => message.id))].filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
}

function statePath(input: MsgHookInput, seat: string): string | null {
  if (!input.sessionId?.trim()) return null;
  const identity = `${input.format}:${seat}:${input.sessionId}`;
  const name = createHash('sha256').update(identity).digest('hex');
  return join(input.stateDir ?? join(elanousStateRoot(), 'msg-hook-state'), `${name}.json`);
}

function claimBundle(path: string | null, ids: number[]): boolean {
  if (!path) return true;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sessionKey = basename(path, '.json');
  const db = new Database(join(dirname(path), 'hook-deliveries.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS msg_hook_deliveries (
        session_key TEXT NOT NULL,
        bundle TEXT NOT NULL,
        PRIMARY KEY(session_key, bundle)
      );`);
    let legacyState: unknown;
    try {
      legacyState = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not read prior hook delivery state: ${String(error)}`);
    }
    return db.transaction(() => {
      if (legacyState !== undefined) {
        if (!legacyState || typeof legacyState !== 'object' || Array.isArray(legacyState)) throw new Error('invalid prior hook delivery state');
        const state = legacyState as { bundles?: unknown; ids?: unknown };
        const keys = Object.keys(state);
        if (keys.some(key => key !== 'bundles' && key !== 'ids') || (!Array.isArray(state.bundles) && !Array.isArray(state.ids))) throw new Error('unrecognized prior hook delivery state');
        if (Array.isArray(state.bundles)) {
          for (const bundle of state.bundles) {
            if (typeof bundle !== 'string') throw new Error('invalid prior hook bundle state');
            db.query('INSERT OR IGNORE INTO msg_hook_deliveries(session_key,bundle) VALUES (?,?)').run(sessionKey, bundle);
          }
        }
        if (Array.isArray(state.ids)) {
          const oldIds = state.ids.filter((value): value is number => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
          if (oldIds.length !== state.ids.length) throw new Error('invalid prior hook ID state');
          if (oldIds.length) db.query('INSERT OR IGNORE INTO msg_hook_deliveries(session_key,bundle) VALUES (?,?)').run(sessionKey, JSON.stringify(oldIds));
        }
      }
      return db.query('INSERT OR IGNORE INTO msg_hook_deliveries(session_key,bundle) VALUES (?,?)').run(sessionKey, JSON.stringify(ids)).changes === 1;
    }).immediate();
  } finally { db.close(); }
}

function summary(seat: string, messages: MsgHookMessage[]): string {
  const rows = messages.slice(0, 10).map(message => {
    const firstLine = (message.body ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 160);
    return `- #${message.id} ${message.from}→${message.to} [${message.kind ?? ''}] ${firstLine}`;
  });
  return `📬 전달 완료: 미읽음 우편 ${messages.length}통 — 정본 eln msg list --to ${seat} · 처리한 글 ID 하나씩 eln msg ack --to ${seat} --id <id>\n${rows.join('\n')}`;
}

/** Build hook output and suppress a repeated unread-ID bundle in the same session. */
export function buildMsgHookOutput(input: MsgHookInput): string | null {
  if (!['user-prompt-submit', 'stop', 'session-start'].includes(input.event)) throw new Error(`unknown msg hook event: ${input.event}`);
  if (!['claude', 'codex'].includes(input.format)) throw new Error(`unknown msg hook format: ${input.format}`);
  const seat = input.seat?.toUpperCase() ?? seatFromCwd(input.cwd);
  if (!seat || !input.messages.length) return null;
  // Stop has no safe cross-call deduplication key without the hook's session ID.
  // Returning no block avoids an endless continuation loop in malformed/older payloads.
  if (input.event === 'stop' && !input.sessionId?.trim()) return null;
  const ids = idsFor(input.messages);
  if (!ids.length) return null;
  if (!claimBundle(statePath(input, seat), ids)) return null;
  if (input.event === 'stop') {
    const listing = ids.slice(0, 10).map(id => `#${id}`).join(', ');
    return JSON.stringify({ decision: 'block', reason: `새 우편 ${ids.length}통(${listing}) — 처리 후 ack` });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: input.event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: summary(seat, input.messages),
    },
  });
}
