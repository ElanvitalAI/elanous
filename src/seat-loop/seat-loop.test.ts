import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gatherSeatInputs, pickNext, planAction, runSeatLoopOnce, seatLedgerPath, type SeatDeps } from './seat-loop.js';

const now = new Date('2026-10-02T23:20:00Z');
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-loop-'));
  const requests = join(root, 'seat-requests');
  mkdirSync(requests);
  const read = (path: string) => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  // Tests stand in for the release ledger DB with per-version JSON fixtures under the temp root.
  const checklistItems = (version: string) => {
    const raw = read(join(root, 'release', version, 'checklist.json'));
    return raw ? (JSON.parse(raw) as { items: Array<{ id: string; title: string; status: string; owner?: string }> }).items : [];
  };
  const deps: SeatDeps = { root, repo: root, now: () => now, read, versions: () => ['0.2.10', '0.2.9'], checklistItems };
  return { root, deps, close: () => rmSync(root, { recursive: true, force: true }) };
};
const checklist = (f: ReturnType<typeof fixture>, version: string, items: unknown[]) => {
  const dir = join(f.root, 'release', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ items }));
};
const entries = (f: ReturnType<typeof fixture>) => f.deps.read!(seatLedgerPath('TC', f.root, now)).trim().split('\n').map((v) => JSON.parse(v));

test('shadow: TC 칸 둘, 이른 판 먼저 · 실행 0 · 날짜 원장 한 줄', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.10', [{ id: 'K1', owner: 'TC', title: '나중 판', status: 'red' }]);
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '먼저 판', status: 'yellow' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, run: async () => { calls++; return ''; } });
    expect(result.status).toBe('shadow');
    expect(entries(f)).toHaveLength(1);
    expect(entries(f)[0].item).toMatchObject({ id: 'K2', version: '0.2.9' });
    expect(entries(f)[0].action).toBe('harness');
    expect(calls).toBe(0);
    expect(seatLedgerPath('TC', f.root, now)).toContain('2026-10-03.jsonl');
  } finally { f.close(); }
});

test('role excerpt is at most 4,000 characters', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'docs', 'roles'), { recursive: true });
    writeFileSync(join(f.root, 'docs', 'roles', 'TC.md'), 'T'.repeat(5000));
    const inputs = await gatherSeatInputs('TC', f.deps);
    expect(inputs.role).toBe('T'.repeat(4000));
    expect(inputs).not.toHaveProperty('seat');
  } finally { f.close(); }
});

test('requests precede checklist, oldest first; status updates and launched keys do not repeat', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), [
      { key: 'b', seat: 'TC', text: 'new', status: 'queued', queuedAt: '2026-10-02T01:00:00Z' },
      { key: 'a', seat: 'TC', text: 'old', status: 'pending', queuedAt: '2026-10-01T01:00:00Z' },
      { key: 'x', seat: 'UX', text: 'other', status: 'queued', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'moved', seat: 'TC', text: 'old assignment', status: 'pending', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'moved', seat: 'UX', text: 'new assignment', status: 'queued', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'closed', seat: 'TC', text: 'old request', status: 'pending', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'closed', seat: 'TC', text: 'old request', status: 'done', queuedAt: '2026-09-01T01:00:00Z' },
    ].map((v) => JSON.stringify(v)).join('\n'));
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: 'cell', status: 'yellow' }]);
    const input = await gatherSeatInputs('TC', f.deps);
    expect(input.requests.map((v) => v.id)).toEqual(['a', 'b']);
    expect(input.checklist.map((v) => v.id)).toEqual(['K2']);
    expect(pickNext(input, [])?.id).toBe('a');
    expect(pickNext(input, [{ seat: 'TC', at: '', status: 'launched', item: input.requests[0] }])?.id).toBe('b');
  } finally { f.close(); }
});

test('forbidden 게시 문면은 decision, on 에서 하니스 0 · 재상정 0', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '마켓에 게시', status: 'yellow' }]);
    mkdirSync(join(f.root, 'docs', 'roles'), { recursive: true });
    writeFileSync(join(f.root, 'docs', 'roles', 'TC.md'), 'TC 역할 지침');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); return args[1] === 'budget' ? '{"outcome":"proceed"}' : '{"id":"dec-test"}'; } };
    expect(planAction({ source: 'checklist', id: 'K2', title: '마켓에 게시', text: '마켓에 게시' }).kind).toBe('decision');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    await runSeatLoopOnce('TC', deps);
    expect(calls.filter((v) => v[0] === 'decisions')).toHaveLength(1);
    expect(calls.find((v) => v[0] === 'decisions')).toContain('raise');
    expect(calls.find((v) => v[0] === 'decisions')).toContain('--category');
    expect(calls.find((v) => v[0] === 'decisions')).toContain('--option');
    const raise = calls.find((v) => v[0] === 'decisions')!;
    expect(raise[raise.indexOf('--s') + 1]).toContain('역할: TC 역할 지침');
    expect(calls.filter((v) => v[0] === 'harness' && v[1] === 'say')).toHaveLength(0);
    expect(entries(f).filter((v) => v.status === 'hitl')).toHaveLength(1);
  } finally { f.close(); }
});

test('decision raise without a receipt is not recorded as hitl', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '마켓에 게시', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => args[1] === 'budget'
      ? '{"outcome":"proceed"}' : '{"error":"decision not saved"}' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('no decision id');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('budget cannot proceed: no launch, skipped-budget', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); return '{"outcome":"wait-reset"}'; } });
    expect(result.status).toBe('skipped-budget');
    expect(calls).toHaveLength(1);
  } finally { f.close(); }
});

test('failed budget observation never authorizes a launch', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => { calls++; throw Error('budget unavailable'); } });
    expect(result.status).toBe('skipped-budget');
    expect(calls).toBe(1);
  } finally { f.close(); }
});

test('on: harness say once, runId recorded, next loop does not reselect same cell', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'], podPool: 'test-pool' }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    await runSeatLoopOnce('TC', deps);
    expect(calls.filter((v) => v[1] === 'say')).toEqual([['harness', 'say', '[TC 자리 · 0.2.9 체크리스트 칸 K2 · 역할 docs/roles/TC.md] 구현', '--substrate', 'pod', '--pod-pool', 'test-pool', '--base', 'main', '--json']]);
    expect(entries(f).find((entry) => entry.status === 'launched')?.runId).toBe('run-12345678-1234-1234-1234-123456789abc');
  } finally { f.close(); }
});

for (const [title, command, receipt, expected] of [
  ['구현', 'say', '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]', 'launched'],
  ['마켓에 게시', 'raise', '{"id":"dec-test"}', 'hitl'],
] as const) {
  test(`concurrent same-seat loops serialize ${command} across ledger read and external call`, async () => {
    const f = fixture();
    try {
      checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title, status: 'yellow' }]);
      let started!: () => void;
      let release!: () => void;
      const inCommand = new Promise<void>((resolve) => { started = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[][] = [];
      const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
        calls.push(args);
        if (args[1] === 'budget') return '{"outcome":"proceed"}';
        started();
        await held;
        return receipt;
      } };
      const first = runSeatLoopOnce('TC', deps);
      await inCommand;
      const second = runSeatLoopOnce('TC', deps);
      release();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual([expected, 'skipped-empty']);
      expect(calls.filter((args) => args[1] === command)).toHaveLength(1);
      expect(entries(f).filter((entry) => entry.status === expected)).toHaveLength(1);
    } finally { f.close(); }
  });
}

test('different processes contend on the same seat lock before reading the ledger', async () => {
  const f = fixture();
  const child = promisify(execFile);
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let started!: () => void;
    let release!: () => void;
    const inCommand = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      started();
      await held;
      return '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } });
    await inCommand;
    const signal = join(f.root, 'lock-contended');
    const external = join(f.root, 'external-called');
    const script = `import { writeFileSync } from 'node:fs';
      import { runSeatLoopOnce } from './src/seat-loop/seat-loop.ts';
      const result = await runSeatLoopOnce('TC', {
        root: process.argv[1], now: () => new Date('2026-10-02T23:20:00Z'),
        repo: process.argv[1], versions: () => ['0.2.9'], checklistItems: () => [], config: { mode: 'on', seats: ['TC'] },
        lockContended: () => writeFileSync(process.argv[2], 'contended'),
        run: async () => { writeFileSync(process.argv[3], 'called'); throw Error('duplicate external call'); },
      });
      console.log(result.status);`;
    const second = child('bun', ['-e', script, f.root, signal, external], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
    try {
      const deadline = Date.now() + 8_000;
      while (!existsSync(signal) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(readFileSync(signal, 'utf8')).toBe('contended');
      expect(existsSync(external)).toBe(false);
      expect(f.deps.read!(seatLedgerPath('TC', f.root, now))).toContain('"status":"attempting"');
    } finally { release(); }
    const [parent, worker] = await Promise.all([first, second]);
    expect(parent.status).toBe('launched');
    expect(worker.stdout.trim()).toBe('skipped-empty');
    expect(existsSync(external)).toBe(false);
    expect(entries(f).filter((entry) => entry.status === 'launched')).toHaveLength(1);
  } finally { f.close(); }
});

test('a harness response without a runId cannot be recorded as launched', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => args[1] === 'budget'
      ? '{"outcome":"proceed"}' : '[{"status":"done"}]' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('no runId');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a harness response that cannot be parsed leaves an unknown outcome', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) =>
      args[1] === 'budget' ? '{"outcome":"proceed"}' : 'not-json' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow();
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a harness call that throws leaves a durable unknown outcome and cannot be retried', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let launches = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      launches++;
      throw Error('response lost after launch');
    } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('response lost after launch');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(launches).toBe(1);
  } finally { f.close(); }
});

test('a failed harness result carrying a runId is not recorded as launched', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => args[1] === 'budget'
      ? '{"outcome":"proceed"}' : '[{"status":"failed","runId":"run-12345678-1234-1234-1234-123456789abc"}]' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('did not complete successfully');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a launch on a previous KST date remains handled on the next day', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const yesterday = new Date('2026-10-02T10:00:00Z');
    const path = seatLedgerPath('TC', f.root, yesterday);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: yesterday.toISOString(), status: 'launched', item: { source: 'checklist', version: '0.2.9', id: 'K2', title: '구현', text: '구현' }, runId: 'run-12345678-1234-1234-1234-123456789abc' }) + '\n');
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => { throw Error('launched again'); } });
    expect(result.status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('off never reads inputs, launches or writes a ledger', async () => {
  const f = fixture();
  try {
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'off' }, run: async () => { throw Error('spawned'); }, read: () => { throw Error('read'); } });
    expect(result).toEqual({ seat: 'TC', status: 'skipped-off' });
  } finally { f.close(); }
});

test('V3 shadow day: each loop walks to the next item, planned door recorded, still no process', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }, { id: 'K3', owner: 'TC', title: '마켓에 게시', status: 'yellow' }]);
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, run: async () => { calls++; return ''; } };
    for (let i = 0; i < 3; i++) await runSeatLoopOnce('TC', deps);
    expect(entries(f).map((e) => [e.status, e.item?.id, e.action])).toEqual([['shadow', 'K2', 'harness'], ['shadow', 'K3', 'decision'], ['skipped-empty', undefined, 'skipped-empty']]);
    expect(calls).toBe(0);
  } finally { f.close(); }
});

test('a shadowed item is still launched once the seat is switched on', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] } });
    const on: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) =>
      args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]' };
    expect((await runSeatLoopOnce('TC', on)).status).toBe('launched');
  } finally { f.close(); }
});

test('same-named items in different seats or releases launch distinct sentences', () => {
  const item = (version: string) => ({ source: 'checklist' as const, id: 'K2', title: '구현', text: '구현', version });
  expect(planAction(item('0.2.9'), 'TC').text).not.toBe(planAction(item('0.2.10'), 'TC').text);
  expect(planAction(item('0.2.9'), 'TC').text).not.toBe(planAction(item('0.2.9'), 'UX').text);
  expect(planAction({ source: 'request', id: 'r1', title: '정리', text: '정리' }, 'MK').text).toBe('[MK 자리 · 자리 요청 r1 · 역할 docs/roles/MK.md] 정리');
});

test('V3 ledger row shape (MK 18:54 · METHOD-v3-shadow-compare): ts · item.id · item.kind · item.createdAt · action · reason', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'),
      JSON.stringify({ key: 'req-1', seat: 'MK', text: '보도자료 초안', status: 'pending', queuedAt: '2026-10-02T09:00:00.000Z' }) + '\n');
    checklist(f, '0.2.10', [{ id: 'M1', owner: 'MK', title: '마켓에 게시', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['MK'] } };
    for (let i = 0; i < 3; i++) await runSeatLoopOnce('MK', deps);
    const path = seatLedgerPath('MK', f.root, now);
    expect(path).toBe(join(f.root, 'seat-loop', 'MK', '2026-10-03.jsonl'));
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((v) => JSON.parse(v));
    expect(rows.map((r) => r.ts)).toEqual([now.toISOString(), now.toISOString(), now.toISOString()]);
    expect(rows[0]).toMatchObject({ action: 'harness', item: { id: 'req-1', kind: 'request', createdAt: '2026-10-02T09:00:00.000Z' } });
    expect(rows[0].reason).toBeUndefined();
    expect(rows[1]).toMatchObject({ action: 'decision', reason: '게시', item: { id: 'M1', kind: 'cell' } });
    expect(rows[1].item.createdAt).toBeUndefined();
    expect(rows[2]).toMatchObject({ action: 'skipped-empty' });
  } finally { f.close(); }
});

test('budget skip records action skipped-budget', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => '{"outcome":"stop"}' });
    expect(entries(f)[0]).toMatchObject({ status: 'skipped-budget', action: 'skipped-budget' });
  } finally { f.close(); }
});

test('checklist items come from the injected ledger reader, not checklist.json (REL5b: the DB is the source)', async () => {
  const f = fixture();
  try {
    // A stale legacy file says TC owns K9; the ledger reader says TC owns K10 — only the ledger counts.
    const dir = join(f.root, 'release', '0.2.10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ items: [{ id: 'K9', owner: 'TC', title: 'stale', status: 'yellow' }] }));
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.10'], checklistItems: () => [{ id: 'K10', owner: 'TC', title: 'ledger', status: 'yellow' }] });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['K10']);
  } finally { f.close(); }
});
