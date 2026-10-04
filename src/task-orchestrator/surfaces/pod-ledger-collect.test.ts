import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { collectPodLedgers, createPodLedgerFollower, parsePodLedgerChunks } from './pod-ledger-collect.js';

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

  test('final-only collection re-emits complete records but never an existing host ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-ledger-final-emit-'));
    try {
      const jsonl = '{"event":"pre-pr-sync","data":{"status":"llm-resolved"}}\n'
        + '{"event":"progress-delivery-outcome","data":{}}\n';
      const emitted: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const collect = () => collectPodLedgers(transfer(runId, jsonl).join('\n'), { dir, log: () => {},
        emit: (category, event, data) => { emitted.push({ category, event, data }); },
      });
      collect();
      collect();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(jsonl);
      expect(emitted).toEqual([{ category: 'self-implement', event: 'pre-pr-sync',
        data: { status: 'llm-resolved', runId, origin: 'pod', podLedgerOffset: 0 } }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

  test('emits each valid remote ledger event while appending all complete bytes unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-events-'));
    try {
      const lines = [
        '{"event":"gate-finished","data":{"stage":"gate","outcome":"pass"}}',
        '{"event":"review-round","data":{"round":2,"mustFix":3,"files":["private.ts"],"reason":"token=sk-superSecret123456789"}}',
        'broken json',
        '{"event":"repair-finished","data":{"reason":"fixed"}}',
      ];
      const bytes = `${lines.join('\n')}\n`;
      const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const follower = createPodLedgerFollower({ runId, dir,
        log: (category, event, data) => events.push({ category, event, data }),
        exec: () => ({ status: 0, stdout: `${bytes}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      follower.poll();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(bytes);
      expect(events[0]).toEqual({ category: 'self-implement.pod', event: 'ledger-live-appended', data: {
        runId, lines: 4, bytes: Buffer.byteLength(bytes), offset: Buffer.byteLength(bytes),
      } });
      expect(events.filter(({ category }) => category === 'self-implement.pod.ledger')).toEqual([
        { category: 'self-implement.pod.ledger', event: 'gate-finished', data: { runId, stage: 'gate', outcome: 'pass' } },
        { category: 'self-implement.pod.ledger', event: 'review-round', data: { runId, round: 2, mustFix: 3, filesCount: 1 } },
        { category: 'self-implement.pod.ledger', event: 'repair-finished', data: { runId } },
      ]);
      expect(events).toHaveLength(4);
      expect(JSON.stringify(events)).not.toContain('sk-superSecret123456789');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('secret reused in an event name never leaks through later stall reporting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-unsafe-event-'));
    try {
      let minute = 0;
      const bytes = '{"event":"review-opaque123","data":{"nested":{"token":"opaque123"}},"round":2}\n';
      const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({ runId, dir, now: () => minute * 60_000, stallMinutes: 5,
        log: (category, event, data) => events.push({ category, event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: minute === 0 ? `${bytes}\nELANOUS_ACTIVITY 0\n` : '\nELANOUS_ACTIVITY 0\n', stderr: '' }),
      });
      f.poll();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(bytes);
      expect(events).toEqual([{ category: 'self-implement.pod', event: 'ledger-live-appended', data: {
        runId, lines: 1, bytes: Buffer.byteLength(bytes), offset: Buffer.byteLength(bytes),
      } }]);
      minute = 5;
      f.poll();
      expect(events.at(-1)).toEqual({ category: 'self-implement.pod', event: 'stalled', data: {
        runId, lastProgressEvent: '[redacted]', idleMinutes: 5,
      } });
      expect(messages).toEqual(['[pod] 진행 없음 5분 — 원장·작업 트리 모두 조용함 · 마지막 진행 [redacted]']);
      expect(JSON.stringify(events)).not.toContain('opaque123');
      expect(f.owned).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('failure to mirror a ledger event does not change append or progress accounting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-log-error-'));
    try {
      let minute = 0;
      const messages: string[] = [];
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const f = createPodLedgerFollower({ runId, dir, now: () => minute * 60_000, stallMinutes: 5,
        log: (category, event, data) => {
          if (category === 'self-implement.pod.ledger') throw new Error('host log unavailable');
          events.push({ event, data });
        },
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: minute === 0 ? '{"event":"reviewed","data":{"round":1}}\n\nELANOUS_ACTIVITY 0\n' : '\nELANOUS_ACTIVITY 0\n', stderr: '' }),
      });
      f.poll();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"event":"reviewed","data":{"round":1}}\n');
      minute = 5;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([{ event: 'stalled', data: { runId, lastProgressEvent: 'reviewed', idleMinutes: 5 } }]);
      expect(messages).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('appends only complete lines, remembers the byte offset, and asks only for new bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-'));
    const podFile = ['{"a":1}\n{"b":', '2}\n{"c":3}\n'];
    let served = 0;
    const scripts: string[] = [];
    const f = createPodLedgerFollower({ runId, dir, log: noLog, exec: (script) => { scripts.push(script); return { status: 0, stdout: `${podFile[served++] ?? ''}\nELANOUS_ACTIVITY 0\n`, stderr: '' }; } });
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

  test('heartbeat lines do not reset the 30-minute stall; progress clears it and starts the next window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-stall-'));
    try {
      let minute = 0;
      const chunks: string[] = [];
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000,
        log: (_c, event, data) => events.push({ event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: `${chunks.shift() ?? ''}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      chunks.push('{"event":"pipeline-node-entry"}\n');
      f.poll();
      for (minute = 1; minute <= 40; minute++) {
        chunks.push('{"event":"progress-delivery-outcome"}\n');
        f.poll();
      }
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([{
        event: 'stalled', data: { runId, lastProgressEvent: 'pipeline-node-entry', idleMinutes: 30 },
      }]);
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 pipeline-node-entry']);
      expect(events.filter(({ event }) => event === 'ledger-live-appended')).toHaveLength(41);
      expect(events[0]).toEqual({ event: 'ledger-live-appended', data: {
        runId, lines: 1, bytes: Buffer.byteLength('{"event":"pipeline-node-entry"}\n'),
        offset: Buffer.byteLength('{"event":"pipeline-node-entry"}\n'),
      } });
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(
        '{"event":"pipeline-node-entry"}\n' + '{"event":"progress-delivery-outcome"}\n'.repeat(40),
      );

      minute = 45;
      chunks.push('{"event":"gated"}\n');
      f.poll();
      expect(events.filter(({ event }) => event === 'stall-cleared')).toEqual([{
        event: 'stall-cleared', data: { runId, idleMinutes: 45 },
      }]);
      minute = 74;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toHaveLength(1);
      minute = 75;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([
        { event: 'stalled', data: { runId, lastProgressEvent: 'pipeline-node-entry', idleMinutes: 30 } },
        { event: 'stalled', data: { runId, lastProgressEvent: 'gated', idleMinutes: 30 } },
      ]);
      expect(messages).toEqual([
        '[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 pipeline-node-entry',
        '[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 gated',
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('malformed lines never count as progress, and reminders fire once at each threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-stall-malformed-'));
    try {
      let minute = 0;
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000, stallMinutes: 30,
        log: (_c, event, data) => events.push({ event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: 'not json\n\nELANOUS_ACTIVITY 0\n', stderr: '' }),
      });
      f.poll();
      minute = 35;
      f.poll(); f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([{
        event: 'stalled', data: { runId, lastProgressEvent: null, idleMinutes: 35 },
      }]);
      minute = 60;
      f.poll(); f.poll();
      minute = 90;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled').map(({ data }) => data.idleMinutes)).toEqual([35, 60, 90]);
      expect(messages).toEqual([
        '[pod] 진행 없음 35분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음',
        '[pod] 진행 없음 60분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음',
        '[pod] 진행 없음 90분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음',
      ]);
      expect(events.some(({ event }) => event === 'stall-cleared')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('one poll after a 180-minute jump emits one reminder, then waits for the next threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-stall-jump-'));
    try {
      let minute = 0;
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000,
        log: (_c, event, data) => events.push({ event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: '\nELANOUS_ACTIVITY 0\n', stderr: '' }),
      });
      f.poll();
      minute = 180;
      f.poll(); f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([
        { event: 'stalled', data: { runId, lastProgressEvent: null, idleMinutes: 180 } },
      ]);
      expect(messages).toEqual(['[pod] 진행 없음 180분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음']);
      minute = 209;
      f.poll();
      expect(messages).toHaveLength(1);
      minute = 210;
      f.poll(); f.poll();
      expect(events.filter(({ event }) => event === 'stalled').map(({ data }) => data.idleMinutes)).toEqual([180, 210]);
      expect(messages).toEqual([
        '[pod] 진행 없음 180분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음',
        '[pod] 진행 없음 210분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음',
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('regular polls emit one reminder at each of 30, 60 and 90 minutes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-stall-regular-'));
    try {
      let minute = 0;
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000,
        log: (_c, event, data) => events.push({ event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: '\nELANOUS_ACTIVITY 0\n', stderr: '' }),
      });
      f.poll();
      for (minute of [30, 60, 90]) { f.poll(); f.poll(); }
      expect(events.filter(({ event }) => event === 'stalled').map(({ data }) => data.idleMinutes)).toEqual([30, 60, 90]);
      expect(messages).toEqual([30, 60, 90].map((n) => `[pod] 진행 없음 ${n}분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a custom stall threshold ignores incomplete lines until a complete progress event arrives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-stall-split-'));
    try {
      let minute = 0;
      const chunks = ['{"event":"gated"', '', '}\n'];
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000, stallMinutes: 5,
        log: (_c, event, data) => events.push({ event, data }), onStall: () => {},
        exec: () => ({ status: 0, stdout: `${chunks.shift() ?? ''}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      f.poll();
      minute = 5;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([{
        event: 'stalled', data: { runId, lastProgressEvent: null, idleMinutes: 5 },
      }]);
      expect(f.owned).toBe(false);
      f.poll();
      expect(events.filter(({ event }) => event === 'stall-cleared')).toEqual([{
        event: 'stall-cleared', data: { runId, idleMinutes: 5 },
      }]);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"event":"gated"}\n');
      minute = 9;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toHaveLength(1);
      minute = 10;
      f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('worktree changes keep a ledger-silent child alive and activity logs are throttled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-'));
    try {
      let minute = 0;
      let files = 1;
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({
        runId, dir, now: () => minute * 60_000,
        log: (_c, event, data) => events.push({ event, data }),
        onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: `\nELANOUS_ACTIVITY ${files}\n`, stderr: '' }),
      });
      for (minute = 0; minute <= 35; minute++) f.poll();
      expect(events.filter(({ event }) => event === 'stalled')).toEqual([]);
      expect(messages).toEqual([]);
      expect(events.filter(({ event }) => event === 'worktree-activity')).toHaveLength(8);
      expect(events.filter(({ event }) => event === 'worktree-activity')[0]).toEqual({ event: 'worktree-activity', data: { runId, files: 1 } });
      expect(f.owned).toBe(false);
      minute = 36;
      files = 0;
      f.poll();
      expect(messages).toEqual([]);
      minute = 65;
      f.poll();
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 worktree-activity']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('ledger and activity stay byte-separated, including a split ledger line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-bytes-'));
    try {
      const bytes = ['{"event":"start"}\n{"event":"fin', 'ish"}\n'];
      const scripts: string[] = [];
      let index = 0;
      const f = createPodLedgerFollower({ runId, dir, log: noLog, exec: (script) => {
        scripts.push(script);
        return { status: 0, stdout: `${bytes[index++] ?? ''}\nELANOUS_ACTIVITY 2\n`, stderr: '' };
      } });
      f.poll(); f.poll();
      expect(readFileSync(runLedgerPath(runId, dir)).equals(Buffer.from(bytes.join('')))).toBe(true);
      expect(scripts[1]).toContain(`tail -c +${Buffer.byteLength(bytes[0]!) + 1} `);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a ledger event containing the activity marker text remains intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-text-'));
    try {
      const bytes = '{"event":"ELANOUS_ACTIVITY recorded"}\n';
      const f = createPodLedgerFollower({ runId, dir, log: noLog,
        exec: () => ({ status: 0, stdout: `${bytes}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      f.poll();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('measurement failure falls back to ledger progress and marks the warning as unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-failure-'));
    try {
      let minute = 0;
      const events: string[] = [];
      const messages: string[] = [];
      const chunks = ['{"event":"start"}\n\nELANOUS_ACTIVITY 0\n', '\nELANOUS_ACTIVITY_ERROR\n', '\nELANOUS_ACTIVITY nonsense\n'];
      const f = createPodLedgerFollower({ runId, dir, now: () => minute * 60_000,
        log: (_c, event) => events.push(event), onStall: (message) => messages.push(message),
        exec: () => ({ status: 0, stdout: chunks.shift() ?? '\nELANOUS_ACTIVITY_ERROR\n', stderr: '' }),
      });
      f.poll();
      minute = 15;
      f.poll();
      minute = 30;
      f.poll();
      expect(events.filter((event) => event === 'stalled')).toHaveLength(1);
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장 조용함 · 마지막 진행 start (작업 트리 못 잼)']);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"event":"start"}\n');
      minute = 31;
      chunks.push('{"event":"resumed"}\n');
      f.poll();
      expect(events.filter((event) => event === 'stall-cleared')).toHaveLength(1);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('{"event":"start"}\n{"event":"resumed"}\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('exec command errors cannot claim the worktree was quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-exec-failure-'));
    try {
      let minute = 0;
      const messages: string[] = [];
      const events: string[] = [];
      const f = createPodLedgerFollower({ runId, dir, now: () => minute * 60_000,
        onStall: (message) => messages.push(message), log: (_c, event) => events.push(event),
        exec: () => ({ status: 1, stdout: '', stderr: 'exec failed' }),
      });
      minute = 30;
      f.poll();
      expect(events).toEqual(['ledger-live-unavailable', 'stalled']);
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장 못 잼 · 마지막 진행 없음 (작업 트리 못 잼)']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  function ownedTree(root: string, name: string, id = runId): string {
    const path = join(root, 'worktrees', 'repo-hash', 'repo.worktrees', name);
    mkdirSync(path, { recursive: true });
    expect(spawnSync('git', ['init', '-q', path]).status).toBe(0);
    expect(spawnSync('git', ['-C', path, 'config', 'extensions.worktreeConfig', 'true']).status).toBe(0);
    expect(spawnSync('git', ['-C', path, 'config', '--worktree', 'elanous.harness.owner', `dev:${id}`]).status).toBe(0);
    return path;
  }

  test('another run changing files cannot suppress this run\'s stall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-concurrent-'));
    try {
      const own = ownedTree(dir, 'own');
      const other = ownedTree(dir, 'other', otherId);
      const base = 1_800_000_000_000;
      let time = base;
      const messages: string[] = [];
      const counts: number[] = [];
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time,
        log: noLog, onStall: (message) => messages.push(message),
        exec: (command) => {
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          expect(r.status).toBe(0);
          const match = /^\nELANOUS_ACTIVITY (\d+)\n$/.exec(r.stdout);
          expect(match).not.toBeNull();
          counts.push(Number(match![1]));
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      for (let minute = 1; minute <= 30; minute++) {
        const file = join(other, 'busy.txt');
        writeFileSync(file, 'changed');
        utimesSync(file, (base + minute * 60_000) / 1_000, (base + minute * 60_000) / 1_000);
        time = base + minute * 60_000;
        f.poll();
      }
      expect(counts).toEqual(Array(30).fill(0));
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음']);
      const file = join(own, 'active.txt');
      writeFileSync(file, 'own change');
      utimesSync(file, (base + 31 * 60_000) / 1_000, (base + 31 * 60_000) / 1_000);
      time = base + 31 * 60_000;
      f.poll();
      expect(counts.at(-1)).toBe(1);
      expect(messages).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('two worktrees claiming one run are unmeasured rather than credited as progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-ambiguous-'));
    try {
      ownedTree(dir, 'first');
      const second = ownedTree(dir, 'second');
      const file = join(second, 'busy.txt');
      writeFileSync(file, 'ambiguous');
      const base = 1_800_000_000_000;
      utimesSync(file, (base + 1_000) / 1_000, (base + 1_000) / 1_000);
      let time = base;
      const messages: string[] = [];
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time, log: noLog,
        onStall: (message) => messages.push(message),
        exec: (command) => {
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          expect(r.status).toBe(0);
          expect(r.stdout).toBe('\nELANOUS_ACTIVITY_ERROR\n');
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      time = base + 30 * 60_000;
      f.poll();
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장 조용함 · 마지막 진행 없음 (작업 트리 못 잼)']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('unattributed worktrees are unmeasured, not quiet or progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-unknown-'));
    try {
      const other = ownedTree(dir, 'other', otherId);
      const base = 1_800_000_000_000;
      const file = join(other, 'busy.txt');
      writeFileSync(file, 'other run');
      utimesSync(file, (base + 1_000) / 1_000, (base + 1_000) / 1_000);
      let time = base;
      const messages: string[] = [];
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time,
        log: noLog, onStall: (message) => messages.push(message),
        exec: (command) => {
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          expect(r.status).toBe(0);
          expect(r.stdout).toBe('\nELANOUS_ACTIVITY_ERROR\n');
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      time = base + 30 * 60_000;
      f.poll();
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장 조용함 · 마지막 진행 없음 (작업 트리 못 잼)']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('real sh command counts a changed regular file but never returns its name or contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-shell-'));
    try {
      const tree = ownedTree(dir, 'shell-run');
      mkdirSync(runLedgerDir(dir));
      const podBytes = '{"event":"pod-start"}\n';
      writeFileSync(runLedgerPath(runId, runLedgerDir(dir)), podBytes);
      const base = Date.now();
      let time = base;
      writeFileSync(join(tree, 'secret.txt'), 'private content');
      utimesSync(join(tree, 'secret.txt'), (base + 1_000) / 1_000, (base + 1_000) / 1_000);
      let script = '';
      let firstOutput = '';
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time, log: noLog,
        exec: (command) => {
          script = command;
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          firstOutput = r.stdout;
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      time = base + 2_000;
      f.poll();
      expect(firstOutput).toBe(`${podBytes}\nELANOUS_ACTIVITY 1\n`);
      const r = spawnSync('sh', ['-c', script], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${podBytes}\nELANOUS_ACTIVITY 1\n`);
      expect(readFileSync(runLedgerPath(runId, join(dir, 'host')), 'utf8')).toBe(podBytes);
      expect(r.stdout).not.toContain('secret.txt');
      expect(r.stdout).not.toContain('private content');
      mkdirSync(join(tree, 'node_modules'));
      writeFileSync(join(tree, 'node_modules', 'package.js'), 'private dependency');
      expect(spawnSync('sh', ['-c', script], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' }).stdout).toBe(`${podBytes}\nELANOUS_ACTIVITY 1\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('real shell follower counts only modifications since the previous poll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-window-'));
    try {
      const tree = ownedTree(dir, 'window-run');
      const file = join(tree, 'changed.txt');
      const base = 1_800_000_000_000;
      let time = base;
      const counts: number[] = [];
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time,
        log: (_c, event, data) => events.push({ event, data }),
        exec: (command) => {
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          expect(r.status).toBe(0);
          const match = /^\nELANOUS_ACTIVITY (\d+)\n$/.exec(r.stdout);
          expect(match).not.toBeNull();
          counts.push(Number(match![1]));
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      writeFileSync(file, 'first');
      utimesSync(file, (base + 1_000) / 1_000, (base + 1_000) / 1_000);
      time = base + 2_000;
      f.poll();
      time = base + 10_000;
      f.poll();
      writeFileSync(file, 'second');
      utimesSync(file, (base + 11_000) / 1_000, (base + 11_000) / 1_000);
      time = base + 20_000;
      f.poll();
      time = base + 30_000;
      f.poll();
      expect(counts).toEqual([1, 0, 1, 0]);
      expect(events.filter(({ event }) => event === 'worktree-activity')).toEqual([
        { event: 'worktree-activity', data: { runId, files: 1 } },
      ]);
      expect(events.some(({ event }) => event === 'stalled')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a future-dated file cannot masquerade as progress on repeated real shell polls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-activity-future-'));
    try {
      const tree = ownedTree(dir, 'future-run');
      const file = join(tree, 'future.txt');
      const base = 1_800_000_000_000;
      const future = base + 60 * 60_000;
      let time = base;
      const counts: number[] = [];
      const messages: string[] = [];
      const f = createPodLedgerFollower({ runId, dir: join(dir, 'host'), now: () => time,
        log: noLog, onStall: (message) => messages.push(message),
        exec: (command) => {
          const r = spawnSync('sh', ['-c', command], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
          expect(r.status).toBe(0);
          const match = /^\nELANOUS_ACTIVITY (\d+)\n$/.exec(r.stdout);
          expect(match).not.toBeNull();
          counts.push(Number(match![1]));
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      });
      writeFileSync(file, 'unchanged');
      utimesSync(file, future / 1_000, future / 1_000);
      time = base + 1_000;
      f.poll();
      time = base + 2_000;
      f.poll();
      time = base + 30 * 60_000;
      f.poll();
      expect(counts).toEqual([0, 0, 0]);
      expect(messages).toEqual(['[pod] 진행 없음 30분 — 원장·작업 트리 모두 조용함 · 마지막 진행 없음']);
      time = future + 1_000;
      f.poll();
      time = future + 2_000;
      f.poll();
      expect(counts).toEqual([0, 0, 0, 1, 0]);
      expect(messages).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('re-emits each new Pod ledger line once across two polls and final replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-reemit-'));
    try {
      const first = '{"event":"start","data":{"phase":"시작"}}\n{"category":"self-implement.review","event":"pre-pr';
      const second = '-sync","data":{"status":"llm-resolved"}}\n{"event":"progress-delivery-outcome","data":{"count":1}}\n';
      const final = '{"event":"finished","data":{"outcome":"pass"}}\n';
      const full = first + second + final;
      const emitted: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const mirrored: string[] = [];
      const chunks = [first, second];
      const f = createPodLedgerFollower({ runId, dir, log: (_category, event) => { mirrored.push(event); },
        emit: (category, event, data) => { emitted.push({ category, event, data }); },
        exec: () => ({ status: 0, stdout: `${chunks.shift() ?? ''}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      f.poll(); f.poll();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(first + second);
      expect(emitted.filter(({ event }) => event === 'pre-pr-sync')).toEqual([{
        category: 'self-implement.review', event: 'pre-pr-sync',
        data: { status: 'llm-resolved', runId, origin: 'pod', podLedgerOffset: Buffer.byteLength(first.slice(0, first.indexOf('\n') + 1)) },
      }]);
      expect(emitted.filter(({ event }) => event.startsWith('progress-delivery'))).toHaveLength(0);
      expect(mirrored.filter((event) => event.startsWith('progress-delivery'))).toHaveLength(0);
      collectPodLedgers(transfer(runId, full).join('\n'), { dir, log: noLog, emit: (category, event, data) => { emitted.push({ category, event, data }); }, replace: new Set([runId]) });
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(full);
      expect(emitted.map(({ event }) => event)).toEqual(['start', 'pre-pr-sync', 'finished']);
      expect(emitted[0]).toEqual({ category: 'self-implement', event: 'start', data: { phase: '시작', runId, origin: 'pod', podLedgerOffset: 0 } });
      expect(emitted[2]).toEqual({ category: 'self-implement', event: 'finished', data: { outcome: 'pass', runId, origin: 'pod', podLedgerOffset: Buffer.byteLength(first + second) } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a throwing emitter cannot prevent live append or final collection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-reemit-throw-'));
    try {
      const first = '{"event":"pre-pr-sync","data":{"status":"llm-resolved"}}\n';
      const full = first + '{"event":"finished","data":{}}\n';
      const emit = () => { throw new Error('host log unavailable'); };
      const f = createPodLedgerFollower({ runId, dir, log: noLog, emit,
        exec: () => ({ status: 0, stdout: `${first}\nELANOUS_ACTIVITY 0\n`, stderr: '' }),
      });
      expect(() => f.poll()).not.toThrow();
      expect(f.owned).toBe(true);
      expect(() => collectPodLedgers(transfer(runId, full).join('\n'), { dir, log: noLog, emit, replace: new Set([runId]) })).not.toThrow();
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(full);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the final collection replaces the partial live copy (and only that one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-live-'));
    const full = '{"a":1}\n{"b":2}\n{"done":true}\n';
    const f = createPodLedgerFollower({ runId, dir, log: noLog, exec: () => ({ status: 0, stdout: '{"a":1}\n\nELANOUS_ACTIVITY 0\n', stderr: '' }) });
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
