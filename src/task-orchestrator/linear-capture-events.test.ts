import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLinearCaptureArtifacts } from './linear-capture-events.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';

test('TOX capture collector keeps only exact-run, saved, explicitly shared browser screenshots in the execution window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-capture-events-'));
  const dbPath = join(dir, 'logs.db');
  writeFileSync(dbPath, 'fake log db');
  const good = { path: '/artifacts/capture/approved.png', mimeType: 'image/png', runId: 'run-9',
    linearIssueId: 'parent-9', externalShare: true, sensitivity: 'public', createdAt: 1_500 };
  const row = (data: Record<string, unknown>, ts_ms = 1_500): LogStoreRow => ({ id: 1, ts: '', ts_ms, level: 'debug',
    instance: 'test', surface: 'skill', category: 'harness.browser-action', event: 'executed', session_id: null,
    trace_id: null, data: JSON.stringify(data) });
  const rows = [
    row({ runId: 'run-9', action: 'read', mode: 'screenshot', ok: true, captureOutcome: 'saved', capture: good }),
    row({ runId: 'run-9', action: 'read', mode: 'screenshot', ok: true, captureOutcome: 'saved', capture: { ...good, externalShare: false } }),
    row({ runId: 'run-9', action: 'read', mode: 'screenshot', ok: true, captureOutcome: 'inline-base64', capture: good }),
    row({ runId: 'run-8', action: 'read', mode: 'screenshot', ok: true, captureOutcome: 'saved', capture: { ...good, runId: 'run-8' } }),
    row({ runId: 'run-9', action: 'read', mode: 'screenshot', ok: true, captureOutcome: 'saved', capture: good }, 2_100),
  ];
  let closed = false;
  try {
    expect(collectLinearCaptureArtifacts({ runId: 'run-9', startedAt: 1_000, endedAt: 2_000 }, {
      dbPath,
      openStore: () => ({ queryByDataKeys: query => {
        expect(query).toEqual({ exactCategories: ['harness.browser-action'], runIds: ['run-9'] });
        return rows;
      }, close: () => { closed = true; } }),
    })).toEqual([good]);
    expect(closed).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
