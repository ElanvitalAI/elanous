import { expect, test } from 'bun:test';
import { createFullTranscriptCapture } from './full-transcript.js';
import { sidetabRowsFromManifest } from '../../sidetab-core/model.js';
import type { PtyManifestRow } from '../../pty-shell/pty-manifest.js';

test('full transcript redacts secrets and strips terminal controls before sidechat', () => {
  const capture = createFullTranscriptCapture();
  capture.append('begin\r\n\x1b[31mBearer abcdefghijklmnop\x1b[0m\n');
  expect(capture.transcript()).toBe('begin\nBearer ***\n');
  expect(capture.bytes()).toBeGreaterThan(capture.transcript()!.length);
});

test('overflow fails closed and never presents a truncated transcript as full', () => {
  const capture = createFullTranscriptCapture(10);
  capture.append('12345');
  capture.append('678901');
  capture.append('later');
  expect(capture.bytes()).toBe(16);
  expect(capture.transcript()).toBeUndefined();
});

test('a workspace PTY row carries the manifest output marker for freshness checks', () => {
  const manifest = {
    id: 'pty:agent', kind: 'codex', instance: 'project', purpose: 'next-tui-sidetab:agent-session',
    ownerPid: 42, ptyPid: 43, startedAt: 100, alive: true, outputBytesTotal: 22,
  } as PtyManifestRow;
  const rows = sidetabRowsFromManifest([manifest], 'project', () => ({ turn: 'idle', stale: false }));
  expect(rows[0]?.lastActivityAt).toBe(22);
  expect(rows[0]?.sessionId).toBe('agent-session');
});
