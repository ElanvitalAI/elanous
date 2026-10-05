import { describe, expect, test, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LogStore } from '../../mss/logging/log-store.js';
import { debug } from '../../debug/log.js';
import { collectPodArtifacts, importPodLogs, parsePodArtifactChunks } from './pod-artifact-return.js';

function transfer(path: string, bytes: Buffer): string[] {
  const token = Buffer.from(path).toString('base64url');
  const encoded = gzipSync(bytes).toString('base64');
  const parts = encoded.match(/.{1,8000}/g)!;
  return parts.map((chunk, i) => `ELANOUS_POD_ARTIFACT ${token} ${i + 1}/${parts.length} ${chunk}`);
}

describe('pod artifact return', () => {
  test('restores pod logs under the job and reports line count', () => {
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

  test('imports all three returned log rows exactly once across repeated collection and CLI event lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const db = join(dir, 'logs', 'logs.db');
    const store = new LogStore(db, { instance: 'test:pod' });
    const ts = new Date().toISOString();
    const lines = [
      JSON.stringify({ ts, category: 'self-implement.review', event: 'pre-pr-sync', surface: 'nexus', level: 'info', trace_id: 'trace-1', data: { runId: 'child-run', status: 'llm-resolved' } }),
      JSON.stringify({ ts, category: 'harness.decision', event: 'decision', data: { kind: 'KEEP', runId: 'child-run' } }),
      JSON.stringify({ ts, category: 'self-implement.pod', event: 'progress', data: { runId: 'child-run' } }),
    ];
    const text = `${lines.join('\n')}\n`;
    const logs = transfer('pod-logs/logs.jsonl', Buffer.from(text)).join('\n');
    const events: string[] = [];
    try {
      collectPodArtifacts(logs, { dir, job: 'si-job', logStore: store, log: (_c, e) => events.push(e) });
      collectPodArtifacts(logs, { dir, job: 'si-job', logStore: store, log: (_c, e) => events.push(e) });
      expect(readFileSync(join(dir, 'si-job/pod-logs/logs.jsonl'), 'utf8')).toBe(text);
      expect(store.count()).toBe(3);
      expect(store.query({ limit: 10 }).map((row) => [row.ts, row.category, row.event, row.trace_id, JSON.parse(row.data ?? '{}')])).toEqual([
        [ts, 'self-implement.pod', 'progress', null, { runId: 'child-run', origin: 'pod', podJob: 'si-job' }],
        [ts, 'harness.decision', 'decision', null, { kind: 'KEEP', runId: 'child-run', origin: 'pod', podJob: 'si-job' }],
        [ts, 'self-implement.review', 'pre-pr-sync', 'trace-1', { runId: 'child-run', status: 'llm-resolved', origin: 'pod', podJob: 'si-job' }],
      ]);
      expect(store.query({ events: ['pre-pr-sync'] })).toHaveLength(1);
      expect(events.filter((event) => event === 'pod-logs-imported')).toHaveLength(2);
      expect(events.filter((event) => event === 'pod-logs-missing')).toHaveLength(0);
      const reader = LogStore.openReadOnly(db);
      try { expect(reader.query({ events: ['pre-pr-sync'] })).toHaveLength(1); }
      finally { reader.close(); }
      const cli = spawnSync('bun', ['-e', `import { runLogsCli } from './src/cli/logs-cli.ts'; process.exitCode = await runLogsCli({event:'pre-pr-sync',json:true,jsonData:true}, {resolveTargets: () => ({targets: [{name:'test:pod',dbPath: process.argv[1]}]})});`, db], { cwd: process.cwd(), encoding: 'utf8' });
      expect(cli.status).toBe(0);
      expect(cli.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.event === 'pre-pr-sync')).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('skips malformed lines without discarding valid rows or consuming their receipts', () => {
    const store = new LogStore(':memory:');
    const ts = new Date().toISOString();
    const openedStores = '{"_meta":{"type":"log-query-opened-stores","stores":[{"name":"prod","path":"/home/ubuntu/.elanous/logs/logs.db"},{"name":"test:repo","path":"/home/ubuntu/repo/.elanous-test/logs/logs.db"}],"scope":{"registeredStores":1,"unopenedStores":0},"queryStatus":{"registeredStores":true}}}';
    const text = [JSON.stringify({ ts, category: 'harness.decision', event: 'decision', data: { runId: 'child-run' } }), 'not-json', openedStores, ''].join('\n');
    try {
      expect(importPodLogs(Buffer.from(text), 'si-job', store)).toEqual({ imported: 1, skipped: 2 });
      expect(importPodLogs(Buffer.from(text), 'si-job', store)).toEqual({ imported: 0, skipped: 2 });
      expect(store.count()).toBe(1);
      expect(importPodLogs(Buffer.from(`${text}\n${JSON.stringify({ ts: 'invalid', category: 'self-implement', event: 'bad-time' })}\n`), 'si-job-2', store)).toEqual({ imported: 1, skipped: 3 });
      expect(store.query({ events: ['bad-time'] })).toHaveLength(0);
    } finally { store.close(); }
  });

  test('preserves scalar and array payloads while recording Pod origin', () => {
    const store = new LogStore(':memory:');
    const ts = new Date().toISOString();
    const text = [
      JSON.stringify({ ts, category: 'self-implement', event: 'scalar', data: 'original message' }),
      JSON.stringify({ ts, category: 'self-implement', event: 'array', data: [1, 'two'] }),
    ].join('\n');
    try {
      expect(importPodLogs(Buffer.from(text), 'si-job', store)).toEqual({ imported: 2, skipped: 0 });
      expect(store.query({ events: ['scalar'] }).map(({ data }) => JSON.parse(data ?? '{}'))).toEqual([
        { originalData: 'original message', origin: 'pod', podJob: 'si-job' },
      ]);
      expect(store.query({ events: ['array'] }).map(({ data }) => JSON.parse(data ?? '{}'))).toEqual([
        { originalData: [1, 'two'], origin: 'pod', podJob: 'si-job' },
      ]);
    } finally { store.close(); }
  });

  test('imports distinct steward decision lines without rewriting an existing host decision', () => {
    const store = new LogStore(':memory:');
    const ts = new Date().toISOString();
    const text = [
      JSON.stringify({ ts, category: 'loop.steward', event: 'decision', data: { runId: 'same-run', decision: 'first' } }),
      JSON.stringify({ ts, category: 'loop.steward', event: 'decision', data: { runId: 'same-run', decision: 'second' } }),
    ].join('\n');
    try {
      store.insertBatch([{ rec: { ts, category: 'loop.steward', event: 'decision', data: { runId: 'same-run', decision: 'host' } }, surface: 'nexus' }]);
      expect(importPodLogs(Buffer.from(text), 'si-job', store)).toEqual({ imported: 2, skipped: 0 });
      expect(store.query({ exactCategories: ['loop.steward'] }).map(({ data }) => JSON.parse(data ?? '{}').decision).sort()).toEqual(['first', 'host', 'second']);
    } finally { store.close(); }
  });

  test('dedup receipts survive reopening logs.db and roll back if insertion fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-log-receipts-'));
    const db = join(dir, 'logs.db');
    const text = `${JSON.stringify({ ts: new Date().toISOString(), category: 'self-implement', event: 'pre-pr-sync', data: { runId: 'child-run' } })}\n`;
    try {
      const first = new LogStore(db);
      try { expect(importPodLogs(Buffer.from(text), 'si-job', first)).toEqual({ imported: 1, skipped: 0 }); }
      finally { first.close(); }
      const reopened = new LogStore(db);
      try {
        expect(importPodLogs(Buffer.from(text), 'si-job', reopened)).toEqual({ imported: 0, skipped: 0 });
        const fail = spyOn(reopened, 'insertBatch').mockImplementation(() => { throw new Error('insert failed'); });
        try { expect(() => importPodLogs(Buffer.from(text), 'si-job-2', reopened)).toThrow('insert failed'); }
        finally { fail.mockRestore(); }
        expect(importPodLogs(Buffer.from(text), 'si-job-2', reopened)).toEqual({ imported: 1, skipped: 0 });
        expect(reopened.count()).toBe(2);
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('unavailable host store reports import failure while retaining returned bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const errors: unknown[][] = [];
    const debugSpy = spyOn(debug, 'log').mockImplementation((...args) => { if (args[1] === 'pod-logs-import-failed') errors.push(args); });
    const events: string[] = [];
    const text = `${JSON.stringify({ ts: new Date().toISOString(), category: 'self-implement', event: 'pre-pr-sync', data: { runId: 'child-run' } })}\n`;
    try {
      collectPodArtifacts(transfer('pod-logs/logs.jsonl', Buffer.from(text)).join('\n'), { dir, job: 'si-job', logStore: null, log: (_c, event) => events.push(event) });
      expect(readFileSync(join(dir, 'si-job/pod-logs/logs.jsonl'), 'utf8')).toBe(text);
      expect(events).toContain('pod-logs-returned');
      expect(errors).toEqual([['self-implement.pod', 'pod-logs-import-failed', { job: 'si-job', reason: 'host log store unavailable' }]]);
    } finally { debugSpy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('failed import reports through debug while preserving collected bytes and result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-artifacts-'));
    const store = new LogStore(':memory:');
    const spy = spyOn(store, 'insertPodBatch').mockImplementation(() => { throw new Error('db unavailable'); });
    const errors: unknown[][] = [];
    const debugSpy = spyOn(debug, 'log').mockImplementation((...args) => { if (args[1] === 'pod-logs-import-failed') errors.push(args); });
    const events: string[] = [];
    const text = `${JSON.stringify({ ts: new Date().toISOString(), category: 'self-implement', event: 'pre-pr-sync', data: { runId: 'child-run' } })}\n`;
    try {
      collectPodArtifacts(transfer('pod-logs/logs.jsonl', Buffer.from(text)).join('\n'), { dir, job: 'si-job', logStore: store, log: (_c, event) => events.push(event) });
      expect(readFileSync(join(dir, 'si-job/pod-logs/logs.jsonl'), 'utf8')).toBe(text);
      expect(events).toContain('pod-logs-returned');
      expect(events).not.toContain('pod-logs-missing');
      expect(errors).toEqual([['self-implement.pod', 'pod-logs-import-failed', { job: 'si-job', reason: 'db unavailable' }]]);
    } finally { debugSpy.mockRestore(); spy.mockRestore(); store.close(); rmSync(dir, { recursive: true, force: true }); }
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
