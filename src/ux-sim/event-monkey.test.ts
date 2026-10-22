import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRunLedger, runLedgerDir, runLedgerPath } from '../self-implement/run-ledger.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { LogStore } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import { podChildRunIds, podTerminalPr } from '../task-agent/card-evidence.js';
import { setOpsRootsForTesting } from '../instance/test-write-guard.js';
import {
  EVENT_MONKEY_CATALOG,
  EVENT_MONKEY_KINDS,
  EventMonkeyRefusedError,
  emitInjectedEvent,
  resolveEventMonkeyKind,
  type EventMonkeyDebugRow,
} from './event-monkey.js';

const REPO = resolve(import.meta.dir, '..', '..');
const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'event-monkey-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  setOpsRootsForTesting(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The isolated universe's logs.db, read through the real LogStore. */
function dbRows(root: string): EventMonkeyDebugRow[] {
  const path = join(root, 'logs', 'logs.db');
  if (!existsSync(path)) return [];
  const store = new LogStore(path, { readonly: true });
  try {
    return store.query({ limit: 1000 }).map((row) => ({ category: row.category, event: row.event,
      data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown> }));
  } finally { store.close(); }
}

describe('event monkey (SIM-EVENT-MONKEY · L0) — real ledger writer into an isolated universe', () => {
  test('catalog names the six first kinds and each carries consumers', () => {
    expect([...EVENT_MONKEY_KINDS]).toEqual([
      'child-error-long', 'same-cell-reuse-push', 'scope-escape-held', 'no-result-line', 'pr-terminal-null', 'land-slot-wait',
    ]);
    for (const kind of EVENT_MONKEY_KINDS) {
      const entry = EVENT_MONKEY_CATALOG[kind];
      expect(entry.consumers.length).toBeGreaterThan(0);
      expect(entry.ledgerEvents.length).toBeGreaterThan(0);
    }
  });

  for (const kind of ['child-error-long', 'same-cell-reuse-push', 'scope-escape-held', 'no-result-line', 'pr-terminal-null', 'land-slot-wait'] as const) {
    test(`${kind}: every ledger and debug row carries injected:true · injectionId · level L0, readable by the real reader`, () => {
      const root = tempRoot();
      const result = emitInjectedEvent({ kind, stateRoot: root });
      expect(result.level).toBe('L0');
      expect(result.runId).toMatch(/^run-[0-9a-f-]{36}$/);
      expect(result.ledgerPath).toBe(runLedgerPath(result.runId, runLedgerDir(root)));
      const rows = loadRunLedger(result.runId, runLedgerDir(root));
      expect(rows).not.toBeNull();
      expect(rows!.map((row) => row.event)).toEqual(result.ledgerRows.map((row) => row.event));
      expect(rows!.length).toBeGreaterThan(0);
      for (const row of rows!) expect(row.data).toMatchObject({ injected: true, injectionId: result.injectionId, level: 'L0' });
      const logged = dbRows(root);
      expect(logged.map((row) => `${row.category} ${row.event}`).sort()).toEqual(result.debugRows.map((row) => `${row.category} ${row.event}`).sort());
      expect(logged.length).toBeGreaterThan(0);
      for (const row of logged) expect(row.data).toMatchObject({ injected: true, injectionId: result.injectionId, level: 'L0' });
      expect(result.consumers).toEqual(EVENT_MONKEY_CATALOG[kind].consumers);
    });
  }

  test('child-error-long: ≈4KB error kept by the real child-evidence shaper, fenced by pod-child-run', () => {
    const result = emitInjectedEvent({ kind: 'child-error-long', stateRoot: tempRoot() });
    const run = result.ledgerRows.find((row) => row.event === 'pod-child-run')!;
    const evidence = result.ledgerRows.find((row) => row.event === 'pod-child-evidence')!;
    expect(evidence.data.job).toBe(run.data.job);
    expect(evidence.data.childRunId).toBe(run.data.childRunId);
    const child = evidence.data.childEvidence as { error: string; exitCode: number };
    expect(child.error.length).toBeGreaterThanOrEqual(3_900);
    expect(child.error.length).toBeLessThanOrEqual(4_000);
    expect(child.exitCode).toBe(1);
  });

  test('same-cell-reuse-push: allowed and refused variants match pr-manager push decisions', () => {
    const both = emitInjectedEvent({ kind: 'same-cell-reuse-push', stateRoot: tempRoot() });
    const decisions = both.debugRows.filter((row) => row.event === 'same-cell-push-decision').map((row) => row.data.outcome);
    expect(decisions).toEqual(['allowed', 'refused']);
    const refusedEvidence = both.ledgerRows.find((row) => row.event === 'pod-child-evidence')!.data.childEvidence as { prFailure?: { stage: string } };
    expect(refusedEvidence.prFailure?.stage).toBe('pr-open-failed');

    const onlyAllowed = emitInjectedEvent({ kind: 'same-cell-reuse-push', variant: 'allowed', stateRoot: tempRoot() });
    expect(onlyAllowed.debugRows.filter((row) => row.event === 'same-cell-push-decision').map((row) => row.data.outcome)).toEqual(['allowed']);
  });

  test('scope-escape-held: outOfScopeEdits names reach both the held event and child evidence', () => {
    const result = emitInjectedEvent({ kind: 'scope-escape-held', stateRoot: tempRoot() });
    const held = result.ledgerRows.find((row) => row.event === 'execution-scope-held')!;
    expect(Array.isArray(held.data.outOfScopeEdits)).toBe(true);
    expect((held.data.outOfScopeEdits as string[]).length).toBeGreaterThan(0);
    const child = result.ledgerRows.find((row) => row.event === 'pod-child-evidence')!.data.childEvidence as Record<string, unknown>;
    expect(child).toMatchObject({ scopeEscape: true, classification: 'scope-escape', outOfScopeEdits: held.data.outOfScopeEdits });
  });

  test('no-result-line: null child evidence and an unobserved PR terminal', () => {
    const result = emitInjectedEvent({ kind: 'no-result-line', stateRoot: tempRoot() });
    expect(result.ledgerRows.find((row) => row.event === 'pod-child-evidence')!.data.childEvidence).toBeNull();
    expect(result.ledgerRows.find((row) => row.event === 'pr-terminal')!.data).toMatchObject({ terminalClass: 'failed-pr-unobserved', prNumber: null });
    expect(result.debugRows.find((row) => row.event === 'job-finished')!.data).toMatchObject({ state: 'failed', childError: 'no-result-line' });
  });

  test('pr-terminal-null: failed after a draft — prNumber null on the same branch', () => {
    const result = emitInjectedEvent({ kind: 'pr-terminal-null', stateRoot: tempRoot() });
    const terminal = result.ledgerRows.find((row) => row.event === 'pr-terminal')!.data;
    expect(terminal).toMatchObject({ prNumber: null, terminalClass: 'failed-no-pr' });
    const run = result.ledgerRows.find((row) => row.event === 'pod-child-run')!.data;
    expect(terminal.childRunId).toBe(run.childRunId);
    expect(typeof terminal.branch).toBe('string');
    expect(result.ledgerRows.find((row) => row.event === 'pr-opened')!.data.branch).toBe(terminal.branch);
  });

  test('land-slot-wait: pr.land host-busy shape', () => {
    const slot = emitInjectedEvent({ kind: 'land-slot-wait', stateRoot: tempRoot() });
    expect(slot.debugRows.find((row) => row.category === 'pr.land' && row.event === 'host-busy')!.data).toMatchObject({ slotWaitSeconds: expect.any(Number) });
  });

  test('injection never reaches global debug sinks — only the isolated logs.db (review r3)', () => {
    const seen: string[] = [];
    const off = debug.registerSink({ emit: (rec: { category: string; event: string }) => { seen.push(`${rec.category} ${rec.event}`); } } as never);
    const root = tempRoot();
    try {
      const result = emitInjectedEvent({ kind: 'child-error-long', stateRoot: root });
      expect(seen.filter((line) => line.startsWith('self-implement.pod'))).toEqual([]);
      expect(dbRows(root).every((row) => row.data.injectionId === result.injectionId)).toBe(true);
    } finally { off(); }
  });

  test('catalog ledgerEvents/debugEvents match what each kind actually writes (default variant)', () => {
    for (const kind of EVENT_MONKEY_KINDS) {
      const result = emitInjectedEvent({ kind, stateRoot: tempRoot() });
      expect({ kind, ledger: [...new Set(result.ledgerRows.map((row) => row.event))].sort() })
        .toEqual({ kind, ledger: [...EVENT_MONKEY_CATALOG[kind].ledgerEvents].sort() });
      expect({ kind, debug: [...new Set(result.debugRows.map((row) => `${row.category} ${row.event}`))].sort() })
        .toEqual({ kind, debug: [...EVENT_MONKEY_CATALOG[kind].debugEvents].sort() });
    }
  });

  test('short aliases resolve to the canonical kinds', () => {
    expect(['child-error', 'same-cell', 'scope-escape', 'no-result', 'pr-null', 'slot-wait'].map((name) => resolveEventMonkeyKind(name)))
      .toEqual([...EVENT_MONKEY_KINDS]);
    expect(resolveEventMonkeyKind('child-error-long')).toBe('child-error-long');
    expect(resolveEventMonkeyKind('nope')).toBeUndefined();
  });

  test('--run reuses a given run id; an invalid one is rejected before any write', () => {
    const root = tempRoot();
    const runId = 'run-00000000-0000-4000-8000-000000000001';
    expect(emitInjectedEvent({ kind: 'land-slot-wait', runId, stateRoot: root }).runId).toBe(runId);
    expect(() => emitInjectedEvent({ kind: 'land-slot-wait', runId: '../escape', stateRoot: tempRoot() })).toThrow();
  });

  test('production root is refused with zero writes (real ~/.elanous)', () => {
    const runId = 'run-00000000-0000-4000-8000-0000000000ee';
    expect(() => emitInjectedEvent({ kind: 'child-error-long', runId, stateRoot: prodInstanceRoot() })).toThrow(EventMonkeyRefusedError);
    expect(existsSync(runLedgerPath(runId, runLedgerDir(prodInstanceRoot())))).toBe(false);
  });

  test('a root inside the guarded ops roots is refused with zero writes', () => {
    const fakeOps = tempRoot();
    setOpsRootsForTesting([fakeOps]);
    const inside = join(fakeOps, 'nested');
    expect(() => emitInjectedEvent({ kind: 'no-result-line', stateRoot: inside })).toThrow(EventMonkeyRefusedError);
    expect(readdirSync(fakeOps)).toEqual([]);
  });

  for (const sub of ['run-ledger', 'logs'] as const) {
    test(`an isolated-looking root whose ${sub} is a symlink into a guarded root is refused with zero writes`, () => {
      const fakeOps = tempRoot();
      setOpsRootsForTesting([fakeOps]);
      const isolated = tempRoot();
      symlinkSync(fakeOps, join(isolated, sub));
      expect(() => emitInjectedEvent({ kind: 'child-error-long', stateRoot: isolated })).toThrow(EventMonkeyRefusedError);
      expect(readdirSync(fakeOps)).toEqual([]);
    });
  }

  test('a ledger FILE that is a symlink into a guarded root is refused with zero writes', () => {
    const fakeOps = tempRoot();
    setOpsRootsForTesting([fakeOps]);
    const target = join(fakeOps, 'victim.jsonl');
    writeFileSync(target, '');
    const isolated = tempRoot();
    const runId = 'run-00000000-0000-4000-8000-0000000000aa';
    mkdirSync(runLedgerDir(isolated), { recursive: true });
    symlinkSync(target, runLedgerPath(runId, runLedgerDir(isolated)));
    expect(() => emitInjectedEvent({ kind: 'child-error-long', runId, stateRoot: isolated })).toThrow(EventMonkeyRefusedError);
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  test('real consumer: card-evidence binds the injected Pod child, and pr-terminal-null yields no PR binding', () => {
    const root = tempRoot();
    const result = emitInjectedEvent({ kind: 'pr-terminal-null', stateRoot: root });
    const host = loadRunLedger(result.runId, runLedgerDir(root));
    const children = podChildRunIds(host, result.runId);
    expect(children).toEqual([result.ledgerRows.find((row) => row.event === 'pod-child-run')!.data.childRunId as string]);
    expect(podTerminalPr(host, children)).toBeUndefined();
  });
});

describe('scripts/ux-sim.ts emit — real CLI', () => {
  const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const [key, value] of Object.entries(extra)) if (value === undefined) delete next[key];
    return next;
  };

  test('--json shape and the ledger line land in the isolated state dir', () => {
    const root = tempRoot();
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'child-error-long', '--json'], {
      // NODE_ENV=test (inherited from bun test) disables the default logs.db store; run the CLI as a real process would.
      cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root, NODE_ENV: undefined }), timeout: 110_000,
    });
    // stderr may carry host-specific notices (log sink, runtime warnings); the contract is rc 0 and one JSON line on stdout.
    expect({ status: out.status, stderr: out.status === 0 ? '' : out.stderr }).toEqual({ status: 0, stderr: '' });
    const json = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, level: 'L0', kind: 'child-error-long', stateRoot: resolve(root) });
    expect(Object.keys(json).sort()).toEqual(['consumers', 'debugEvents', 'injectionId', 'kind', 'ledgerEvents', 'ledgerPath', 'level', 'ok', 'runId', 'stateRoot']);
    expect(json.ledgerEvents).toEqual(['pod-child-run', 'pod-child-evidence']);
    const rows = loadRunLedger(json.runId as string, runLedgerDir(root));
    expect(rows!.every((row) => row.data.injectionId === json.injectionId && row.data.injected === true)).toBe(true);
    // The debug.log rows reach the isolated universe's logs.db through the real StoreSink.
    const store = new LogStore(join(root, 'logs', 'logs.db'), { readonly: true });
    try {
      const logged = store.query({ categories: ['self-implement.pod'], grep: json.injectionId as string });
      expect(logged.map((row) => row.event).sort()).toEqual(['child-error', 'job-finished']);
    } finally { store.close(); }
  }, 120_000);

  test('an explicit production state dir makes the CLI refuse (rc 3) and the production home gets zero writes', () => {
    // A real production home already holds the machine identity (read-only once it exists). Seed it so the
    // snapshot below proves «zero writes»: no new file, no changed byte under <HOME>/.elanous.
    const home = tempRoot();
    const prod = join(home, '.elanous');
    mkdirSync(prod, { recursive: true });
    writeFileSync(join(prod, 'identity.json'), JSON.stringify({ elanous_id: '01JSIMEVENTMONKEY000000000', created_at: '2026-10-21T00:00:00.000Z', schema_version: 1 }));
    const snapshot = (): string[] => readdirSync(prod, { recursive: true }).map(String).sort()
      .map((name) => `${name}:${readFileSync(join(prod, name), 'utf8')}`);
    const before = snapshot();
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'child-error-long', '--json'], {
      cwd: REPO, encoding: 'utf8', env: env({ HOME: home, ELANOUS_STATE_DIR: prod, ELANOUS_CONFIG_DIR: undefined }), timeout: 110_000,
    });
    expect(out.status).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: 'refused-production-root', stateRoot: prod });
    expect(snapshot()).toEqual(before);
  }, 120_000);

  test('a logs.db FILE symlinked into a guarded root makes the CLI refuse (rc 3) before the sink opens it', () => {
    const guarded = tempRoot();
    const victim = join(guarded, 'logs.db');
    writeFileSync(victim, '');
    const root = tempRoot();
    mkdirSync(join(root, 'logs'));
    symlinkSync(victim, join(root, 'logs', 'logs.db'));
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'child-error-long', '--json'], {
      cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root, NODE_ENV: undefined, ELANOUS_TEST_GUARD_EXTRA_OPS_ROOTS: guarded }), timeout: 110_000,
    });
    expect(out.status).toBe(3);
    expect(readFileSync(victim, 'utf8')).toBe('');
    expect(existsSync(runLedgerDir(root))).toBe(false);
  }, 120_000);

  test('a stray positional argument is rejected (rc 2) before any write', () => {
    const root = tempRoot();
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'child-error-long', 'garbage'], { cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root }), timeout: 110_000 });
    expect(out.status).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  }, 120_000);

  test('--state-dir under a separate HOME writes the ledger and logs.db only into that dir; default output is one human line', () => {
    const home = tempRoot();
    const dir = join(tempRoot(), 'universe');
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'slot-wait', '--state-dir', dir], {
      cwd: REPO, encoding: 'utf8', env: env({ HOME: home, ELANOUS_STATE_DIR: undefined, NODE_ENV: undefined }), timeout: 110_000,
    });
    expect({ status: out.status, stderr: out.status === 0 ? '' : out.stderr }).toEqual({ status: 0, stderr: '' });
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^주입 inj-[0-9a-f-]+ · land-slot-wait · 원장 .+\.jsonl · 소비자: /);
    expect(readdirSync(join(dir, 'run-ledger')).length).toBe(1);
    expect(dbRows(dir).map((row) => `${row.category} ${row.event}`)).toEqual(['pr.land host-busy']);
    expect(existsSync(join(home, '.elanous', 'run-ledger'))).toBe(false);
    expect(existsSync(join(home, '.elanous', 'logs'))).toBe(false);
  }, 120_000);

  test('eln sim emit (lazy sim subcommand) uses the same function; sim kinds lists aliases', () => {
    const root = tempRoot();
    const emit = spawnSync('bun', ['bin/elanous.mjs', 'sim', 'emit', 'pr-null', '--json'], {
      cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root, NODE_ENV: undefined }), timeout: 110_000,
    });
    expect({ status: emit.status, stderr: emit.status === 0 ? '' : emit.stderr }).toEqual({ status: 0, stderr: '' });
    const json = JSON.parse(emit.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, kind: 'pr-terminal-null', level: 'L0' });
    expect(loadRunLedger(json.runId as string, runLedgerDir(root))!.map((row) => row.event)).toEqual(['pod-child-run', 'pr-opened', 'pod-child-evidence', 'pr-terminal']);
    const kinds = spawnSync('bun', ['bin/elanous.mjs', 'sim', 'kinds'], { cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root }), timeout: 110_000 });
    expect(kinds.status).toBe(0);
    for (const alias of ['child-error', 'same-cell', 'scope-escape', 'no-result', 'pr-null', 'slot-wait']) expect(kinds.stdout).toContain(`(${alias})`);
  }, 120_000);

  test('eln sim emit rejects a stray positional argument (rc ≠ 0) before any write', () => {
    const root = tempRoot();
    const out = spawnSync('bun', ['bin/elanous.mjs', 'sim', 'emit', 'child-error', 'garbage'], {
      cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: root, NODE_ENV: undefined }), timeout: 110_000,
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('too many arguments');
    expect(existsSync(runLedgerDir(root))).toBe(false);
  }, 120_000);

  test('unknown kind is named and rejected (rc 2)', () => {
    const out = spawnSync('bun', ['scripts/ux-sim.ts', 'emit', 'nope'], { cwd: REPO, encoding: 'utf8', env: env({ ELANOUS_STATE_DIR: tempRoot() }), timeout: 110_000 });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('child-error-long');
  }, 120_000);
});
