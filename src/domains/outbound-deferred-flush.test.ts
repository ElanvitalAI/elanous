// flushDeferred 부분 실패 — 실패한 묶음만 큐에 남고, 성공 묶음은 다시 보내지 않는다(10-07 야간 재발송 사고).
// 발송은 전부 주입(sendBatch)이고 큐는 임시 디렉터리다 — 운영 ~/.elanous 를 읽거나 쓰지 않는다.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  DEFERRED_MAX_ATTEMPTS_ENV,
  deferOutbound,
  deferredMaxAttempts,
  deferredQuarantinePath,
  flushDeferred,
} from './outbound-alert.js';

const root = mkdtempSync(join(tmpdir(), 'outbound-deferred-flush-'));
const saved = {
  state: process.env.ELANOUS_STATE_DIR,
  config: process.env.ELANOUS_CONFIG_DIR,
  attempts: process.env[DEFERRED_MAX_ATTEMPTS_ENV],
  via: process.env.SEND_VIA_ELANOUS,
};
let seq = 0;

beforeAll(() => {
  // 주입 발송이 빠져도 운영 우주에 닿지 않도록 우주를 임시 디렉터리로 못 박는다.
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  process.env.ELANOUS_CONFIG_DIR = join(root, 'config');
  process.env.SEND_VIA_ELANOUS = '0';
  delete process.env[DEFERRED_MAX_ATTEMPTS_ENV];
});

afterEach(() => { delete process.env[DEFERRED_MAX_ATTEMPTS_ENV]; });

afterAll(() => {
  for (const [key, value] of [
    ['ELANOUS_STATE_DIR', saved.state], ['ELANOUS_CONFIG_DIR', saved.config],
    [DEFERRED_MAX_ATTEMPTS_ENV, saved.attempts], ['SEND_VIA_ELANOUS', saved.via],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

type Rec = { ts: string; kind: string; text: string; attempts?: number };

function queue(items: Rec[]): string {
  const dir = join(root, `q${seq++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'outbound_deferred.jsonl');
  writeFileSync(path, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  return path;
}

function lines(path: string): Rec[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

const ts = new Date().toISOString();
// 'alert' = 매매(report 묶음) · 'ops-alert' = 운영 kind 묶음 — 두 묶음.
const items: Rec[] = [
  { ts, kind: 'alert', text: 'trade-1' },
  { ts, kind: 'ops-alert', text: 'ops-1' },
  { ts, kind: 'alert', text: 'trade-2' },
];

/** report 묶음만 실패하는 발송기 — 보낸 묶음 kind 를 적는다. */
function reportFails(sent: string[]) {
  return (text: string, kind: string): boolean => { sent.push(`${kind}:${text.includes('trade') ? 'trade' : 'ops'}`); return kind !== 'report'; };
}

describe('flushDeferred — 실패한 묶음만 남는다', () => {
  test('두 묶음 중 하나가 실패하면 큐엔 실패 묶음 항목만 남고 다음 flush 는 그것만 다시 보낸다', () => {
    const path = queue(items);
    const sent: string[] = [];
    expect(flushDeferred(path, { sendBatch: reportFails(sent), maxAttempts: 5 })).toBe(1);
    expect(sent).toEqual(['report:trade', 'ops-alert:ops']);
    const kept = lines(path);
    expect(kept.map((i) => i.text)).toEqual(['trade-1', 'trade-2']);
    expect(kept.every((i) => i.attempts === 1)).toBe(true);

    const second: string[] = [];
    expect(flushDeferred(path, { sendBatch: reportFails(second), maxAttempts: 5 })).toBe(0);
    expect(second).toEqual(['report:trade']);
    expect(lines(path).map((i) => i.attempts)).toEqual([2, 2]);
  });

  test('전부 성공하면 큐 파일이 사라지고 claim 잔여도 없다', () => {
    const path = queue(items);
    expect(flushDeferred(path, { sendBatch: () => true, maxAttempts: 5 })).toBe(3);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, '..'))).toEqual([]);
  });

  test('flush 도중 적재된 항목은 살아남는다', () => {
    const path = queue(items);
    const late: Rec = { ts, kind: 'ops-report', text: 'appended-during-flush' };
    let appended = false;
    const sendBatch = (): boolean => {
      if (!appended) { appendFileSync(path, JSON.stringify(late) + '\n'); appended = true; }
      return true;
    };
    expect(flushDeferred(path, { sendBatch, maxAttempts: 5 })).toBe(3);
    expect(lines(path)).toEqual([late]);
  });

  test('죽은 flusher 가 남긴 claim 은 다음 flush 가 회수한다', () => {
    const path = queue([]);
    rmSync(path);
    writeFileSync(`${path}.flushing-999999999-1-0`, JSON.stringify(items[1]) + '\n');
    const sent: string[] = [];
    expect(flushDeferred(path, { sendBatch: (_t, kind) => { sent.push(kind); return true; }, maxAttempts: 5 })).toBe(1);
    expect(sent).toEqual(['ops-alert']);
    expect(readdirSync(join(path, '..'))).toEqual([]);
  });

  test('5번 실패한 항목은 격리 파일로 옮겨지고 더 보내지 않는다', () => {
    const path = queue([{ ts, kind: 'alert', text: 'poison' }]);
    const quarantined: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'outbound.send' && event === 'deferred-quarantined') quarantined.push(data);
    });
    let calls = 0;
    const max = deferredMaxAttempts({});
    try {
      for (let i = 0; i < 6; i++) flushDeferred(path, { sendBatch: () => { calls++; return false; }, maxAttempts: max });
    } finally { spy.mockRestore(); }
    expect(max).toBe(5);
    expect(calls).toBe(5);
    expect(existsSync(path)).toBe(false);
    expect(lines(deferredQuarantinePath(path))).toEqual([{ ts, kind: 'alert', text: 'poison', attempts: 5 }]);
    expect(quarantined).toEqual([{ kind: 'alert', attempts: 5 }]);
  });

  test('attempts 없는 옛 줄도 읽고, 손상 줄은 버리지 않고 격리한다', () => {
    const path = queue([{ ts, kind: 'ops-alert', text: 'legacy' }]);
    appendFileSync(path, '{not json\n');
    const sent: string[] = [];
    expect(flushDeferred(path, { sendBatch: (t) => { sent.push(t); return true; }, maxAttempts: 5 })).toBe(1);
    expect(sent[0]).toContain('legacy');
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(deferredQuarantinePath(path), 'utf-8')).toBe('{not json\n');
  });

  test('관측 줄에 sent · kept · quarantined 수가 실린다', () => {
    const path = queue(items);
    const rows: Array<Record<string, unknown>> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'outbound.send' && event === 'flush') rows.push(data as Record<string, unknown>);
    });
    try { flushDeferred(path, { sendBatch: reportFails([]), maxAttempts: 5 }); } finally { spy.mockRestore(); }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 3, sent: 1, kept: 2, quarantined: 0 });
  });
});

describe('deferredMaxAttempts — config > env > 5', () => {
  test('config 가 env 를, env 가 기본값을 이긴다', () => {
    process.env[DEFERRED_MAX_ATTEMPTS_ENV] = '3';
    expect(deferredMaxAttempts({ outbound: { deferredMaxAttempts: 7 } })).toBe(7);
    expect(deferredMaxAttempts({})).toBe(3);
    process.env[DEFERRED_MAX_ATTEMPTS_ENV] = 'junk';
    expect(deferredMaxAttempts({})).toBe(5);
  });
});

describe('flushDeferred — 정산 실패에도 중복·유실이 없다', () => {
  // root 는 0o000 파일도 읽는다 — 그 우주에선 «못 읽음»을 만들 수 없다.
  test.skipIf(process.getuid?.() === 0)('읽지 못한 claim 은 지우지 않는다', () => {
    const path = queue([{ ts, kind: 'ops-alert', text: 'unreadable' }]);
    chmodSync(path, 0o000);
    try {
      expect(flushDeferred(path, { sendBatch: () => true, maxAttempts: 5 })).toBe(0);
      const left = readdirSync(join(path, '..')).filter((n) => n.includes('.flushing-'));
      expect(left).toHaveLength(1);
      chmodSync(join(path, '..', left[0]!), 0o644);
      const sent: string[] = [];
      expect(flushDeferred(path, { sendBatch: (t) => { sent.push(t); return true; }, maxAttempts: 5 })).toBe(1);
      expect(sent[0]).toContain('unreadable');
    } finally {
      for (const n of readdirSync(join(path, '..'))) chmodSync(join(path, '..', n), 0o644);
    }
  });

  test('격리 기록이 실패하면 그 항목은 큐로 돌아가고 배달된 항목은 다시 보내지 않는다', () => {
    const path = queue([
      { ts, kind: 'alert', text: 'poison', attempts: 4 },
      { ts, kind: 'ops-alert', text: 'delivered' },
    ]);
    mkdirSync(deferredQuarantinePath(path)); // 디렉터리라 append 가 실패한다
    const flushRows: Array<Record<string, unknown>> = [];
    const quarantinedRows: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category !== 'outbound.send') return;
      if (event === 'flush') flushRows.push(data as Record<string, unknown>);
      if (event === 'deferred-quarantined') quarantinedRows.push(data);
    });
    try {
      expect(flushDeferred(path, { sendBatch: (_t, kind) => kind !== 'report', maxAttempts: 5 })).toBe(1);
    } finally { spy.mockRestore(); }
    // 관측은 실제 정산을 말한다 — 격리 실패면 quarantined 0 · kept 1 · deferred-quarantined 없음.
    expect(flushRows[0]).toMatchObject({ sent: 1, kept: 1, quarantined: 0 });
    expect(quarantinedRows).toEqual([]);
    expect(lines(path).map((i) => [i.text, i.attempts])).toEqual([['poison', 5]]);
    // 격리가 계속 실패해도 상한에 닿은 줄은 더 보내지 않고 큐에 보존된다.
    const later: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(flushDeferred(path, { sendBatch: (t) => { later.push(t); return true; }, maxAttempts: 5 })).toBe(0);
    }
    expect(later).toEqual([]);
    expect(lines(path).map((i) => [i.text, i.attempts])).toEqual([['poison', 5]]);
    // 격리 경로가 회복되면 보내지 않고 격리된다.
    rmSync(deferredQuarantinePath(path), { recursive: true });
    expect(flushDeferred(path, { sendBatch: (t) => { later.push(t); return true; }, maxAttempts: 5 })).toBe(0);
    expect(later).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(lines(deferredQuarantinePath(path)).map((i) => [i.text, i.attempts])).toEqual([['poison', 5]]);
  });

  test('오래된 claim 은 소유 pid 가 살아 있어도 회수한다', () => {
    const path = queue([]);
    rmSync(path);
    // 살아 있는 pid(1 = launchd/init) · 1시간 전 claim
    writeFileSync(`${path}.flushing-1-${Date.now() - 60 * 60_000}-0`, JSON.stringify(items[1]) + '\n');
    expect(flushDeferred(path, { sendBatch: () => true, maxAttempts: 5 })).toBe(1);
    expect(readdirSync(join(path, '..'))).toEqual([]);
  });

  test('적재자가 잠금을 쥐고 파일을 연 채 아직 쓰지 않았으면 claim 은 기다린다 — 그 줄을 잃지 않는다', () => {
    const path = queue([{ ts, kind: 'ops-alert', text: 'before' }]);
    const ready = `${path}.ready`;
    const late = JSON.stringify({ ts, kind: 'ops-report', text: 'opened-before-claim' });
    // deferOutbound 와 같은 규약: <queue>.lock 을 O_EXCL 로 쥐고 open → (지연) → write → close → 잠금 해제.
    const script = `const fs=require('node:fs');const [p,r,l]=process.argv.slice(1);`
      + `const lk=fs.openSync(p+'.lock','wx');const fd=fs.openSync(p,'a');fs.writeFileSync(r,'1');`
      + `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);`
      + `fs.writeSync(fd,l+'\\n');fs.closeSync(fd);fs.closeSync(lk);fs.unlinkSync(p+'.lock');`;
    const child = spawn(process.execPath, ['-e', script, path, ready, late], { stdio: 'ignore' });
    const until = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    expect(existsSync(ready)).toBe(true);
    rmSync(ready);
    const sent: string[] = [];
    expect(flushDeferred(path, { sendBatch: (t) => { sent.push(t); return true; }, maxAttempts: 5 })).toBe(2);
    expect(sent.join('\n')).toContain('opened-before-claim');
    expect(existsSync(path)).toBe(false);
    child.kill();
  });

  test('deferOutbound 는 같은 잠금을 기다린 뒤 적재한다', () => {
    const path = queue([]);
    rmSync(path);
    const ready = `${path}.ready`;
    const script = `const fs=require('node:fs');const [p,r]=process.argv.slice(1);`
      + `const lk=fs.openSync(p+'.lock','wx');const fd=fs.openSync(p,'a');fs.writeFileSync(r,'1');`
      + `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);`
      + `fs.writeSync(fd,'{"ts":"x","kind":"ops-alert","text":"holder"}\\n');fs.closeSync(fd);fs.closeSync(lk);fs.unlinkSync(p+'.lock');`;
    const child = spawn(process.execPath, ['-e', script, path, ready], { stdio: 'ignore' });
    const until = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    expect(existsSync(ready)).toBe(true);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try { expect(deferOutbound('waiter', 'ops-alert', null, path)).toBe(true); } finally { err.mockRestore(); }
    expect(lines(path).map((i) => i.text)).toEqual(['holder', 'waiter']);
    child.kill();
  });

  test.skipIf(process.getuid?.() === 0)('claim 삭제가 실패해도 다음 flush 가 배달분을 다시 보내지 않는다', () => {
    const path = queue(items);
    const dir = join(path, '..');
    const sent: string[] = [];
    try {
      // 발송 중(= claim rename 뒤) 디렉터리를 읽기 전용으로 — 정산의 claim 삭제만 실패한다.
      expect(flushDeferred(path, { sendBatch: (t) => { sent.push(t); chmodSync(dir, 0o555); return true; }, maxAttempts: 5 })).toBe(3);
    } finally { chmodSync(dir, 0o755); }
    expect(sent).toHaveLength(2);
    const again: string[] = [];
    expect(flushDeferred(path, { sendBatch: (t) => { again.push(t); return true; }, maxAttempts: 5 })).toBe(0);
    expect(again).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.includes('.flushing-'))).toEqual([]);
  });
});

