import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { collectPodLedgers, createPodLedgerFollower, parsePodLedgerChunks } from './pod-ledger-collect.js';
import { writeFileSync } from 'node:fs';

const runId = 'run-12345678-1234-1234-1234-123456789abc';
const otherId = 'run-87654321-1234-1234-1234-123456789abc';
const origin = { podName: 'job-x-abcde', nodeName: 'node-1', podNamespace: 'test' };

// Mirrors the manifest's gzip → base64 → <=8000-character indexed lines.
function transfer(id: string, jsonl: string): string[] {
  const encoded = gzipSync(Buffer.from(jsonl)).toString('base64');
  const parts = encoded.match(/.{1,8000}/g)!;
  return parts.map((chunk, index) => `ELANOUS_RUN_LEDGER ${id} ${index + 1}/${parts.length} ${chunk}`);
}

function fixture(): { source: string; destination: string; original: Buffer; lines: string[] } {
  const source = mkdtempSync(join(tmpdir(), 'pod-ledger-source-'));
  const destination = mkdtempSync(join(tmpdir(), 'pod-ledger-host-'));
  const dir = runLedgerDir(source);
  for (let index = 0; index < 3; index++) {
    appendRunLedgerEntry({ runId, event: index === 0 ? 'start' : 'progress', data: { origin, payload: Array.from({ length: 2000 }, (_, i) => `${i}-${index}`).join(':') } }, dir);
  }
  const original = readFileSync(runLedgerPath(runId, dir));
  const chunks = transfer(runId, original.toString('utf8'));
  return { source, destination, original, lines: chunks.flatMap((chunk) => ['unrelated pod output', chunk]) };
}

describe('pod run-ledger collection', () => {
  test('restores a real writer ledger byte-for-byte with origin from interspersed, out-of-order chunks', () => {
    const f = fixture();
    try {
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const logs = ['before', ...f.lines.reverse(), 'ELANOUS_RUN_LEDGER_NONE', '{"ok":true}'].join('\n');
      collectPodLedgers(logs, { dir: runLedgerDir(f.destination), log: (_c, event, data) => events.push({ event, data }) });
      expect(parsePodLedgerChunks(logs)).toEqual([{ runId, jsonl: f.original.toString('utf8') }]);
      const restored = readFileSync(runLedgerPath(runId, runLedgerDir(f.destination)));
      expect(restored.equals(f.original)).toBe(true);
      expect(restored.toString('utf8')).toContain('job-x-abcde');
      expect(events).toContainEqual({ event: 'ledger-collected', data: { runId, lines: 3, bytes: f.original.length } });
    } finally { rmSync(f.source, { recursive: true, force: true }); rmSync(f.destination, { recursive: true, force: true }); }
  });

  test('a missing middle chunk stays incomplete while an independent run is collected', () => {
    const f = fixture();
    try {
      const chunks = transfer(runId, f.original.toString('utf8'));
      expect(chunks.length).toBeGreaterThan(2);
      const logs = [...chunks.slice(0, 1), ...chunks.slice(2), ...transfer(otherId, '{"ok":true}\n')].join('\n');
      const parsed = parsePodLedgerChunks(logs);
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toMatchObject({ error: [{ runId, reason: 'missing chunk' }], ledgers: [{ runId: otherId, jsonl: '{"ok":true}\n' }] });
      const events: string[] = [];
      collectPodLedgers(logs, { dir: runLedgerDir(f.destination), log: (_c, event) => events.push(event) });
      expect(() => readFileSync(runLedgerPath(runId, runLedgerDir(f.destination)))).toThrow();
      expect(events).toEqual(['ledger-collect-incomplete', 'ledger-collected']);
    } finally { rmSync(f.source, { recursive: true, force: true }); rmSync(f.destination, { recursive: true, force: true }); }
  });

  test('an existing host ledger is not overwritten', () => {
    const f = fixture();
    try {
      const dir = runLedgerDir(f.destination);
      appendRunLedgerEntry({ runId, event: 'host', data: {} }, dir);
      const before = readFileSync(runLedgerPath(runId, dir));
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      collectPodLedgers(f.lines.join('\n'), { dir, log: (_c, event, data) => events.push({ event, data }) });
      expect(readFileSync(runLedgerPath(runId, dir)).equals(before)).toBe(true);
      expect(events).toContainEqual({ event: 'ledger-collect-skipped', data: { runId, reason: 'exists' } });
    } finally { rmSync(f.source, { recursive: true, force: true }); rmSync(f.destination, { recursive: true, force: true }); }
  });

  test('collecting an identical complete snapshot again is distinct from a conflicting host ledger', () => {
    const f = fixture();
    try {
      const dir = runLedgerDir(f.destination);
      const events: string[] = [];
      const collect = () => collectPodLedgers(f.lines.join('\n'), { dir, log: (_c, event) => events.push(event) });
      collect();
      collect();
      expect(readFileSync(runLedgerPath(runId, dir)).equals(f.original)).toBe(true);
      expect(events).toEqual(['ledger-collected', 'ledger-collect-already-complete']);
    } finally { rmSync(f.source, { recursive: true, force: true }); rmSync(f.destination, { recursive: true, force: true }); }
  });

  test('duplicate or malformed parts and unsafe run ids never write files', () => {
    const dest = mkdtempSync(join(tmpdir(), 'pod-ledger-unsafe-'));
    try {
      const chunk = transfer(runId, 'one\n')[0]!;
      const unsafe = transfer('..', 'one\n')[0]!;
      const malformed = transfer(otherId, 'one\n')[0]!.replace(/.$/, '?');
      const events: string[] = [];
      collectPodLedgers([chunk, chunk, unsafe, malformed].join('\n'), { dir: runLedgerDir(dest), log: (_c, event) => events.push(event) });
      expect(events).toEqual(['ledger-collect-incomplete', 'ledger-collect-incomplete', 'ledger-collect-incomplete']);
      expect(() => readFileSync(runLedgerPath(runId, runLedgerDir(dest)))).toThrow();
    } finally { rmSync(dest, { recursive: true, force: true }); }
  });

  test('a conflicting total for one run invalidates that run', () => {
    const single = transfer(runId, 'one\n')[0]!;
    const conflicting = single.replace(' 1/1 ', ' 1/2 ');
    expect(parsePodLedgerChunks([single, conflicting].join('\n'))).toMatchObject({
      error: [{ runId, reason: 'invalid or duplicate chunk' }], ledgers: [],
    });
  });
});

// 🅣 요청(2026-09-26): 런 «도중» 원장 증분 회수 — 호스트 슈퍼바이저가 Pod 걸음을 실시간으로 본다.
describe('pod ledger live follower', () => {
  const noLog = () => {};
  test('appends only complete lines, remembers the byte offset, and asks only for new bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-'));
    const podFile = ['{"a":1}\n{"b":', '2}\n{"c":3}\n'];
    let served = 0;
    const scripts: string[] = [];
    const f = createPodLedgerFollower({ runId, dir, log: noLog, exec: (script) => { scripts.push(script); return { status: 0, stdout: podFile[served++] ?? '', stderr: '' }; } });
    f.poll();
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"a":1}\n');   // 반쪽 줄은 잡아 둔다
    f.poll();
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(scripts[0]).toContain('tail -c +1 ');
    expect(scripts[1]).toContain(`tail -c +${Buffer.byteLength(podFile[0]!) + 1} `);
    expect(f.owned).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('never touches a host ledger someone else made', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-'));
    writeFileSync(runLedgerPath(runId, dir), 'HOST\n');
    let calls = 0;
    const events: string[] = [];
    const f = createPodLedgerFollower({ runId, dir, log: (_c, e) => events.push(e), exec: () => { calls++; return { status: 0, stdout: 'x\n', stderr: '' }; } });
    f.poll(); f.poll();
    expect(calls).toBe(0);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('HOST\n');
    expect(events).toEqual(['ledger-live-skipped']);
    expect(f.owned).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the final collection replaces the partial live copy (and only that one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-'));
    const full = '{"a":1}\n{"b":2}\n{"done":true}\n';
    const f = createPodLedgerFollower({ runId, dir, log: noLog, exec: () => ({ status: 0, stdout: '{"a":1}\n', stderr: '' }) });
    f.poll();
    collectPodLedgers(transfer(runId, full).join('\n'), { dir, log: noLog, replace: new Set(f.owned ? [runId] : []) });
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(full);
    // 대조군: 교체 허용이 없으면 종전처럼 덮지 않는다
    writeFileSync(runLedgerPath(otherId, dir), 'HOST\n');
    collectPodLedgers(transfer(otherId, full).join('\n'), { dir, log: noLog });
    expect(readFileSync(runLedgerPath(otherId, dir), 'utf8')).toBe('HOST\n');
    rmSync(dir, { recursive: true, force: true });
  });
});
