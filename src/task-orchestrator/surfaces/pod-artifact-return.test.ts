import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LogStore } from '../../mss/logging/log-store.js';
import { collectPodArtifacts, importPodDecisionLogs, parsePodArtifactChunks } from './pod-artifact-return.js';

function transfer(path: string, bytes: Buffer): string[] {
  const token = Buffer.from(path).toString('base64url');
  const encoded = gzipSync(bytes).toString('base64');
  const parts = encoded.match(/.{1,8000}/g)!;
  return parts.map((chunk, i) => `ELANOUS_POD_ARTIFACT ${token} ${i + 1}/${parts.length} ${chunk}`);
}

describe('pod artifact return', () => {
  test('restores pod logs under the job and reports lines without merging their observations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const text = '{"event":"first"}\n{"event":"second"}\n';
    try {
      collectPodArtifacts(transfer('pod-logs/logs.jsonl', Buffer.from(text)).join('\n'), { dir, job: 'si-job', log: (category, event, data) => events.push({ category, event, data }) });
      const destination = join(dir, 'si-job', 'pod-logs', 'logs.jsonl');
      expect(readFileSync(destination, 'utf8')).toBe(text);
      expect(events).toContainEqual({ category: 'self-implement.pod', event: 'pod-logs-returned', data: { job: 'si-job', path: destination, lines: 2 } });
      expect(events.some(({ event }) => event === 'pod-logs-missing')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('imports only harness.decision rows into the launching host log store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const store = new LogStore(':memory:');
    const text = [
      JSON.stringify({ ts: '2026-09-01T00:00:01.000Z', category: 'harness.decision', event: 'decision', surface: 'nexus', level: 'info', data: { kind: 'KEEP', runId: 'child-run', reason: 'ok' } }),
      JSON.stringify({ ts: '2026-09-01T00:00:02.000Z', category: 'self-implement.pod', event: 'noise', data: { runId: 'child-run' } }),
      JSON.stringify({ ts: '2026-09-01T00:00:03.000Z', category: 'harness.decision', event: 'decision', data: { kind: 'DROP' } }),
      'not-json',
      JSON.stringify({ ts: '2026-09-01T00:00:04.000Z', category: 'harness.decision', event: 'decision', data: { kind: 'ESCALATE', runId: 'child-run-2' } }),
      '',
    ].join('\n');
    try {
      const result = importPodDecisionLogs(Buffer.from(text), 'si-job', store);
      expect(result).toEqual({ imported: 2, skipped: 3 });
      const rows = store.query({ exactCategories: ['harness.decision'], limit: 10 });
      expect(rows.map((row) => ({ ts: row.ts, event: row.event, surface: row.surface, data: JSON.parse(row.data ?? '{}') }))).toEqual([
        { ts: '2026-09-01T00:00:04.000Z', event: 'decision', surface: 'pod', data: { kind: 'ESCALATE', runId: 'child-run-2', podJob: 'si-job', importedFrom: 'pod' } },
        { ts: '2026-09-01T00:00:01.000Z', event: 'decision', surface: 'nexus', data: { kind: 'KEEP', runId: 'child-run', reason: 'ok', podJob: 'si-job', importedFrom: 'pod' } },
      ]);
      collectPodArtifacts(transfer('pod-logs/logs.jsonl', Buffer.from(text)).join('\n'), { dir, job: 'si-job', logStore: store });
      expect(store.query({ exactCategories: ['harness.decision'], limit: 10 })).toHaveLength(4);
      expect(store.query({ exactCategories: ['self-implement.pod'], limit: 10 })).toHaveLength(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('reports absent, export failure, size-skipped and host-skipped pod logs with a reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const path = 'pod-logs/logs.jsonl';
    try {
      for (const [logs, reason] of [
        ['', 'absent'],
        ['ELANOUS_POD_LOGS_UNAVAILABLE export-exit-4', 'export-exit-4'],
        [`ELANOUS_POD_ARTIFACT_SKIPPED ${path} 5242881`, 'artifact skipped (size limit or encoding failure)'],
      ]) {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        collectPodArtifacts(logs, { dir, job: 'si-job', log: (_c, event, data) => events.push({ event, data }) });
        expect(events).toContainEqual({ event: 'pod-logs-missing', data: { job: 'si-job', reason } });
      }
      mkdirSync(join(dir, 'si-job', 'pod-logs'), { recursive: true });
      writeFileSync(join(dir, 'si-job', path), 'host original');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      collectPodArtifacts(transfer(path, Buffer.from('pod')).join('\n'), { dir, job: 'si-job', log: (_c, event, data) => events.push({ event, data }) });
      expect(readFileSync(join(dir, 'si-job', path), 'utf8')).toBe('host original');
      expect(events).toContainEqual({ event: 'artifact-collect-skipped', data: { job: 'si-job', path, reason: 'exists' } });
      expect(events).toContainEqual({ event: 'pod-logs-missing', data: { job: 'si-job', reason: 'exists' } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('recovers two independent files including nested binary bytes, out of order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    try {
      const binary = Buffer.from([0, 255, 10, 42]);
      const logs = [...transfer('note.md', Buffer.from('hello')), ...transfer('nested/blob.bin', binary)].reverse().join('\n');
      collectPodArtifacts(logs, { dir, job: 'si-job' });
      expect(readFileSync(join(dir, 'si-job/note.md'), 'utf8')).toBe('hello');
      expect(readFileSync(join(dir, 'si-job/nested/blob.bin'))).toEqual(binary);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('unsafe relative paths are incomplete and do not escape; good neighbor survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    try {
      const paths = ['../escape.txt', '/tmp/escape.txt', 'x/../escape.txt', 'nul\0path', 'C:/escape.txt'];
      const logs = [...paths.flatMap((p) => transfer(p, Buffer.from('bad'))), ...transfer('good.txt', Buffer.from('ok'))].join('\n');
      const parsed = parsePodArtifactChunks(logs);
      expect(Array.isArray(parsed)).toBe(false);
      if (Array.isArray(parsed)) throw new Error('expected incomplete');
      expect(parsed.error.map((e) => e.path)).toEqual(paths);
      collectPodArtifacts(logs, { dir, job: 'si-job' });
      expect(readFileSync(join(dir, 'si-job/good.txt'), 'utf8')).toBe('ok');
      expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('missing, duplicate, oversized chunk, bad base64 and gunzip are incomplete per file', () => {
    const long = transfer('missing', Buffer.from(Array.from({ length: 20000 }, (_, i) => `${i.toString(36)}-${i * 347}\n`).join('')));
    expect(long.length).toBeGreaterThan(1);
    const dup = transfer('dup', Buffer.from('a'))[0]!;
    const bad = transfer('bad', Buffer.from('a'))[0]!.replace(/.$/, '?');
    const raw = `ELANOUS_POD_ARTIFACT ${Buffer.from('raw').toString('base64url')} 1/1 ${Buffer.from('raw').toString('base64')}`;
    const noncanonical = `ELANOUS_POD_ARTIFACT ${Buffer.from('noncanonical').toString('base64url')} 1/1 AAB=`;
    const conflict = transfer('conflict', Buffer.from('a'))[0]!;
    const logs = [long[0], dup, dup, bad, raw, noncanonical, conflict, conflict.replace(' 1/1 ', ' 1/2 '), `ELANOUS_POD_ARTIFACT ${Buffer.from('huge').toString('base64url')} 1/1 ${'A'.repeat(8001)}`, ...transfer('ok', Buffer.from('ok'))].join('\n');
    const parsed = parsePodArtifactChunks(logs);
    if (Array.isArray(parsed)) throw new Error('expected incomplete');
    expect(parsed.error.map((e) => e.path)).toEqual(['missing', 'dup', 'bad', 'raw', 'noncanonical', 'conflict', 'huge']);
    expect(parsed.artifacts.map((a) => a.path)).toEqual(['ok']);
  });

  test('host limits decompressed files to 5 MB each and all files to 20 MB', () => {
    const over = transfer('over', Buffer.alloc(5 * 1024 * 1024 + 1));
    const whole = Array.from({ length: 5 }, (_, i) => transfer(`part-${i}`, Buffer.alloc(5 * 1024 * 1024)));
    const parsed = parsePodArtifactChunks([...over, ...whole.flat()].join('\n'));
    if (Array.isArray(parsed)) throw new Error('limits were not applied');
    expect(parsed.error.map((e) => e.path)).toEqual(['over', 'part-4']);
    expect(parsed.artifacts).toHaveLength(4);
    expect(parsed.artifacts.reduce((sum, item) => sum + item.bytes.length, 0)).toBe(20 * 1024 * 1024);
  });

  test('the path safety rule rejects traversal independently of chunk validity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    try {
      const unsafe = transfer('../escape.txt', Buffer.from('bad')).join('\n');
      const parsed = parsePodArtifactChunks(unsafe);
      if (Array.isArray(parsed)) throw new Error('unsafe path was accepted');
      expect(parsed.error).toContainEqual({ path: '../escape.txt', reason: 'unsafe relative path' });
      collectPodArtifacts(unsafe, { dir, job: 'si-job' });
      expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('rejects invalid base64url path tokens and keeps a valid neighbor', () => {
    const valid = transfer('ok', Buffer.from('safe'));
    const malformed = `ELANOUS_POD_ARTIFACT ${Buffer.from('bad').toString('base64url')}= 1/1 ${gzipSync('bad').toString('base64')}`;
    const parsed = parsePodArtifactChunks([malformed, ...valid].join('\n'));
    if (Array.isArray(parsed)) throw new Error('invalid path token accepted');
    expect(parsed.error).toContainEqual({ path: `${Buffer.from('bad').toString('base64url')}=`, reason: 'invalid base64url path' });
    expect(parsed.artifacts.map((artifact) => artifact.path)).toEqual(['ok']);
  });

  test('wx keeps existing host bytes and names skipped event; symlink parents cannot redirect writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const outside = mkdtempSync(join(tmpdir(), 'pod-outside-'));
    try {
      mkdirSync(join(dir, 'si-job'));
      writeFileSync(join(dir, 'si-job/keep'), 'host');
      symlinkSync(outside, join(dir, 'si-job/link'));
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      collectPodArtifacts([...transfer('keep', Buffer.from('pod')), ...transfer('link/escaped', Buffer.from('pod'))].join('\n'), { dir, job: 'si-job', log: (_c, event, data) => events.push({ event, data }) });
      expect(readFileSync(join(dir, 'si-job/keep'), 'utf8')).toBe('host');
      expect(existsSync(join(outside, 'escaped'))).toBe(false);
      expect(events).toContainEqual({ event: 'artifact-collect-skipped', data: { job: 'si-job', path: 'keep', reason: 'exists' } });
      expect(events.some((e) => e.event === 'artifact-collect-incomplete' && e.data.path === 'link/escaped')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
