import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { withFileLockSync } from '../../storage/file-lock.js';

const EXECUTION_LEDGER_LIMIT = 4_194_304;
const EXECUTION_ROW_LIMIT = 4096;

/** The lock covers the capacity check and append; unmatched starts reserve one whole terminal row. */
export function appendExecution(path: string, entry: { runId: string; phase: string; [key: string]: unknown }): void {
  withFileLockSync(`${path}.lock`, () => {
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      // Check the exact row being appended, not a mutable object or its toJSON view.
      const line = Buffer.from(JSON.stringify(entry) + '\n');
      if (line.length > EXECUTION_ROW_LIMIT) throw new Error('recipe execution row too large');
      const serialized: unknown = JSON.parse(line.toString('utf8'));
      if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)
        || typeof (serialized as { runId?: unknown }).runId !== 'string'
        || !(serialized as { runId: string }).runId.length)
        throw new Error('invalid recipe execution run id');
      const next = serialized as { runId: string; phase?: unknown };
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
        || stat.size > EXECUTION_LEDGER_LIMIT) throw new Error('unsafe recipe execution ledger');
      const old = Buffer.alloc(stat.size);
      if (readSync(fd, old, 0, old.length, 0) !== old.length || fstatSync(fd).size !== stat.size)
        throw new Error('recipe execution ledger changed while reading');
      const pending = new Set<string>();
      const seen = new Set<string>();
      if (old.length > 0) {
        const body = old.toString('utf8');
        if (!body.endsWith('\n')) throw new Error('partial recipe execution ledger');
        for (const row of body.split('\n').slice(0, -1)) {
          if (Buffer.byteLength(row) + 1 > EXECUTION_ROW_LIMIT)
            throw new Error('oversized recipe execution ledger row');
          const parsed: unknown = JSON.parse(row);
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as { runId?: unknown }).runId !== 'string')
            throw new Error('invalid recipe execution ledger');
          const item = parsed as { runId: string; phase?: unknown };
          if (item.phase === 'start') {
            if (seen.has(item.runId)) throw new Error('duplicate recipe execution start');
            seen.add(item.runId); pending.add(item.runId);
          } else if (item.phase === 'finish') {
            if (!pending.delete(item.runId)) throw new Error('orphan recipe execution finish');
          }
          else throw new Error('invalid recipe execution ledger phase');
        }
      }
      if (next.phase === 'start') {
        if (seen.has(next.runId)) throw new Error('duplicate recipe execution start');
        pending.add(next.runId);
      } else if (next.phase === 'finish') {
        if (!pending.delete(next.runId)) throw new Error('recipe execution finish without start');
      } else throw new Error('invalid recipe execution phase');
      if (stat.size + line.length + pending.size * EXECUTION_ROW_LIMIT > EXECUTION_LEDGER_LIMIT)
        throw new Error('recipe execution ledger has no terminal reserve');
      if (writeSync(fd, line) !== line.length) throw new Error('recipe execution ledger write failed');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  // A paused live writer must never lose this lock on age: that would allow
  // two independent capacity/uniqueness checks to append concurrently. A
  // stranded lock fails closed and requires operator recovery.
  }, { staleMs: Infinity, breakDeadHolder: false, maxTries: 400 });
}
