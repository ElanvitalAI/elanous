import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostReadiness } from './host-readiness.js';

describe('host readiness projection', () => {
  test('uses the latest verdict and preserves inaccessible hosts as unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-readiness-'));
    try {
      const path = join(dir, 'host-readiness.tsv');
      writeFileSync(path, [
        'host\titem\tstatus\trepaired\tat\tdetail',
        'aws1\tverdict\tBLOCKED\tno\t2026-11-09T10:00:00Z\tpods',
        'aws1\tverdict\tUNMEASURED\tno\t2026-11-09T10:10:00Z\treason=no-access-from-gcp2',
      ].join('\n') + '\n');
      expect(readHostReadiness(path)).toEqual([{ host: 'aws1', verdict: 'UNMEASURED',
        at: '2026-11-09T10:10:00Z', failed: [], reason: 'no-access-from-gcp2' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
