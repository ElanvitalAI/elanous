import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendArchiveEntry, recoverToolOutputChunk } from '../src/compact/archive.js';

describe('archive tool output recovery', () => {
  test('selects repeated IDs by content hash and rejects ambiguity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-repeat-'));
    for (const content of ['first', 'second']) {
      expect(appendArchiveEntry({ ts: 1, layer: 'tool-output-budget', sessionId: 'session', origin: { kind: 'tool_result', tool_use_id: 'same' }, content, replacement: 'stub' }, dir)).toBe(true);
    }
    expect(recoverToolOutputChunk('session', 'same', 0, 100, dir)).toEqual({ ok: false, error: 'ambiguous_result' });
    const hash = createHash('sha256').update('second', 'utf16le').digest('hex');
    expect(recoverToolOutputChunk('session', 'same', 0, 100, dir, hash)).toEqual({ ok: true, content: 'second', nextOffset: 6, done: true, totalChars: 6 });
    expect(recoverToolOutputChunk('session', 'same', 0, 100, dir, '0'.repeat(64))).toEqual({ ok: false, error: 'not_found' });
  });

  test('pages the exact original and isolates colliding session filenames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-'));
    const original = '가'.repeat(12_345) + '끝';
    for (const [sessionId, content] of [['a/b', original], ['a?b', 'secret']] as const) {
      expect(appendArchiveEntry({ ts: 1, layer: 'tool-output-budget', sessionId, origin: { kind: 'tool_result', tool_use_id: 'call-1' }, content, replacement: 'stub' }, dir)).toBe(true);
    }
    let offset = 0;
    let result = '';
    do {
      const page = recoverToolOutputChunk('a/b', 'call-1', offset, 4000, dir);
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error(page.error);
      result += page.content;
      offset = page.nextOffset;
      if (page.done) break;
    } while (true);
    expect(result).toBe(original);
    expect(recoverToolOutputChunk('a/b', 'missing', 0, 100, dir)).toEqual({ ok: false, error: 'not_found' });
    expect(recoverToolOutputChunk('a/b', 'call-1', -1, 100, dir)).toEqual({ ok: false, error: 'invalid_range' });
    expect(recoverToolOutputChunk('other', 'call-1', 0, 100, dir)).toEqual({ ok: false, error: 'archive_missing' });
  });
});
