import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendArchiveEntry } from '../src/compact/archive.js';
import { createRequestSizeGuard } from '../src/session/request-size-guard.js';

describe('host-owned recovery guard', () => {
  test('binds session, archive directory, policy and repeated IDs', async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'host-recovery-'));
    const text = 'hello A';
    const hash = createHash('sha256').update(text, 'utf16le').digest('hex');
    for (const [sessionId, content] of [['A', text], ['A', 'other'], ['B', 'secret B']] as const) {
      expect(appendArchiveEntry({ ts: 1, layer: 'tool-output-budget', sessionId, origin: { kind: 'tool_result', tool_use_id: 'reused' }, content, replacement: 'stub' }, archiveDir)).toBe(true);
    }
    let sessionId = 'A'; let archiveEnabled = true;
    const guard = createRequestSizeGuard({ maxChars: 1000, compactOptions: () => ({ sessionId, archiveDir, archiveEnabled }) }); // 출처: #40760 fixture budget, not a production limit
    const recover = guard.recoverToolOutput!;
    const args = {tool_use_id:'reused', sha256:hash, offset:0, limit:5, sessionId:'B'}; // 출처: #40760 fixture pages the first five characters of hello A
    expect(await recover(args)).toMatchObject({ok:true, content:'hello'});
    sessionId = 'B'; expect(await recover(args)).toMatchObject({ok:false});
    sessionId = 'A'; archiveEnabled = false; expect(await recover(args)).toMatchObject({ok:false, error:'archive_disabled'});
    archiveEnabled = true; expect(await recover({...args, sha256:'invalid'})).toMatchObject({ok:false, error:'invalid_selector'});
  });
});
