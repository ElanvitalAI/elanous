import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedger, costTable, judge, lastLedgerLine, ledgerPath, nightlyAuditLedgerPath, pickRange, propose, td1Dispositions, writeCardDraft } from './lib.js';
import { record } from './node.js';
import { CardStore } from '../../src/task-cards/card-store.js';
import { GATE_NIGHTLY_AUDITS } from '../release-loop/gate-node.js';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../../src/graph-runner/runner.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'];
const costs = new Map([['a.test.ts', 30], ['b.test.ts', 30], ['c.test.ts', 100], ['d.test.ts', 5]]);

describe('pickRange — a cost-weighted slice from the cursor', () => {
  test('stops before the budget is exceeded and reports the next cursor', () => {
    expect(pickRange(files, 0, costs, 60)).toMatchObject({ start: 0, end: 1, next: 2, files: ['a.test.ts', 'b.test.ts'], estimatedSecs: 60 });
  });
  test('always takes at least one file, even one above the budget', () => {
    expect(pickRange(files, 2, costs, 10).files).toEqual(['c.test.ts']);
  });
  test('wraps at the end of the suite; unknown files cost the default', () => {
    expect(pickRange(files, 3, costs, 40)).toMatchObject({ start: 3, files: ['d.test.ts', 'a.test.ts'], next: 1 });
    expect(pickRange(['x.test.ts'], 0, new Map(), 5).estimatedSecs).toBe(10);
  });
});

describe('judge — mechanical, never an action', () => {
  const base = { file: 'x.test.ts', secs: 5, rssMb: 100, rc: 0, pass: 3, fail: 0 };
  test('slow or heavy with nothing caught in 90 days is «review»; with a catch it is «keep»', () => {
    expect(judge({ ...base, secs: 90 }, 0)).toMatchObject({ verdict: 'review', flags: ['slow'] });
    expect(judge({ ...base, rssMb: 4096 }, 0)).toMatchObject({ verdict: 'review', flags: ['heavy'] });
    expect(judge({ ...base, secs: 90 }, 2).verdict).toBe('keep');
  });
  test('a non-zero exit is «failing» and keeps its reason', () => {
    expect(judge({ ...base, rc: 1, reason: 'Unable to locate a Java Runtime.' }, 0)).toMatchObject({ verdict: 'failing', reason: 'Unable to locate a Java Runtime.' });
  });
});

describe('TD1 proposals and shadow cards', () => {
  const base = { file: 'x.test.ts', secs: 5, rssMb: 100, rc: 0, pass: 1, fail: 0 };
  test('header-based TD1 disposition overrides mechanical verdict and supplies its alternative', () => {
    const td1 = td1Dispositions('alternative\tdisposition\tfile\twhy_slow\tguards\nuse fixture\tshrink\tx.test.ts\tfull spawn\tsafety\n');
    expect(td1.get(base.file)).toEqual({ disposition: 'shrink', alternative: 'use fixture', why_slow: 'full spawn', guards: 'safety' });
    expect(propose(judge(base, 0), td1)).toMatchObject({ proposal: 'shrink', basis: 'use fixture · full spawn · guards: safety' });
    expect(propose(judge({ ...base, rc: 1 }, 0), new Map()).proposal).toBe('investigate');
    expect(propose(judge({ ...base, secs: 61 }, 0), new Map())).toMatchObject({ proposal: 'shrink', basis: 'slow · caught90=0' });
    expect(propose(judge(base, 0), td1Dispositions('file\tdisposition\nx.test.ts\tkeep\n'))).toMatchObject({ proposal: null });
  });

  test('identical record is idempotent; same-commit remeasurement appends updated card section; card failure preserves ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-proposals-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const ctx = { input: {}, outputs: { pick: { start: 0, end: 0, next: 1, total: 1, budgetSecs: 60 },
      measure: { commit: 'abc', measurements: [{ file: 'src/self-implement/seams.test.ts', secs: 61, rssMb: 100, rc: 0, pass: 1, fail: 0 }] } } };
    try {
      const td1 = td1Dispositions('file\tdisposition\talternative\twhy_slow\tguards\nsrc/self-implement/seams.test.ts\tshrink\tuse fixture\tfull spawn\tsafety\n');
      expect(record(ctx, { td1 })).toBe(0);
      expect(record(ctx, { td1 })).toBe(0);
      const store = new CardStore(root);
      try {
        const cards = store.listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ goalId: 'test-diet:src/self-implement/seams.test.ts:shrink',
          sections: [{ owner: 'test-diet' }] });
        expect(cards[0]!.sections).toHaveLength(1);
        expect(cards[0]!.sections[0]!.key).toStartWith('test-diet:abc:');
        expect(JSON.parse(cards[0]!.sections[0]!.content)).toMatchObject({ proposal: 'shrink', basis: 'use fixture · full spawn · guards: safety', guards: 'safety', range: '#0~#0', secs: 61 });
        const remeasured = { input: {}, outputs: { pick: { ...ctx.outputs.pick, start: 1, end: 1, next: 2, total: 2 },
          measure: { commit: 'abc', measurements: [{ ...ctx.outputs.measure.measurements[0]!, secs: 92, rssMb: 2100 }] } } };
        expect(record(remeasured, { td1 })).toBe(0);
        const updated = store.listCards();
        expect(updated).toHaveLength(1);
        expect(updated[0]!.sections).toHaveLength(2);
        expect(updated[0]!.sections[1]!.key).toStartWith('test-diet:abc:');
        expect(JSON.parse(updated[0]!.sections[1]!.content)).toMatchObject({ range: '#1~#1', secs: 92, rssMb: 2100, guards: 'safety' });
      } finally { store.close(); }
      const failingStore = () => { throw new Error('card offline'); };
      expect(record(ctx, { td1, createStore: failingStore })).toBe(0);
      expect(readFileSync(ledgerPath(root), 'utf8').trim().split('\n')).toHaveLength(4);
      const separate = mkdtempSync(join(tmpdir(), 'td-card-error-'));
      try {
        process.env.ELANOUS_STATE_DIR = separate;
        expect(record(ctx, { td1, createStore: failingStore })).toBe(0);
        expect(readFileSync(ledgerPath(separate), 'utf8').trim().split('\n')).toHaveLength(1);
      } finally { rmSync(separate, { recursive: true, force: true }); }
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keep disposition and keep measurement produce no task card', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-keep-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const td1 = td1Dispositions('file\tdisposition\talternative\twhy_slow\tguards\nx.test.ts\tkeep\t\t\tsafety\n');
      const ctx = { input: {}, outputs: { pick: { start: 0, end: 0, next: 1, total: 1, budgetSecs: 60 },
        measure: { commit: 'abc', measurements: [{ ...base }] } } };
      expect(record(ctx, { td1 })).toBe(0);
      const store = new CardStore(root);
      try { expect(store.listCards()).toHaveLength(0); } finally { store.close(); }
      expect(JSON.parse(readFileSync(ledgerPath(root), 'utf8').trim()).results[0].proposal).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('status prints KST daily latest, streak, missing day and supports old lines and no ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-status-'));
    const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'status', ...args], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root },
    });
    try {
      expect(run().status).toBe(1);
      expect(run().stdout).toContain('원장 없음 — 한 번도 안 돌았다');
      const result = judge(base, 0);
      const line = { at: '2026-10-01T15:10:00.000Z', range: '#0~#0', start: 0, end: 0, next: 1, total: 4, commit: 'abc', budgetSecs: 60, results: [result] };
      appendLedger(root, line);
      appendLedger(root, { ...line, at: '2026-10-02T15:10:00.000Z', range: '#1~#1' });
      appendLedger(root, { ...line, at: '2026-10-02T16:10:00.000Z', range: '#2~#2', results: [{ ...result, proposal: 'shrink', basis: 'slow' }] });
      appendLedger(root, { ...line, at: '2026-10-03T15:10:00.000Z', range: '#3~#3' });
      expect(run().stdout).toContain('연속 산출: 3일 (기준 3)');
      expect(run().stdout).toContain('2026-10-04 · #3~#3 · 1/4');
      expect(run().stdout).toContain('2026-10-04 · #3~#3 · 1/4 · keep 1/review 0/failing 0 · 제안 0');
      expect(run().stdout).toContain('2026-10-03 · #2~#2 · 1/4 · keep 1/review 0/failing 0 · 제안 1');
      expect(run('--json', '--days', '2').stdout).toContain('"consecutive":3,"days":2');
      writeFileSync(ledgerPath(root), readFileSync(ledgerPath(root), 'utf8').split('\n').filter((row) => !row.includes('2026-10-02T')).join('\n') + '\n');
      expect(run().stdout).toContain('연속 산출: 1일 (기준 3)');
      expect(lastLedgerLine(root)?.next).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ledger and card draft', () => {
  test('one line per run carries the range «#a~#b»; the draft lists only non-keep files with their reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-'));
    try {
      const results = [judge({ file: 'ok.test.ts', secs: 1, rssMb: 30, rc: 0, pass: 1, fail: 0 }, 0), judge({ file: 'java.test.ts', secs: 0, rssMb: 29, rc: 1, pass: 0, fail: 1, reason: 'Unable to locate a Java Runtime.' }, 0)];
      const line = { at: '2026-10-02T00:40:00.000Z', range: '#0~#1', start: 0, end: 1, next: 2, total: 2, commit: 'abc', budgetSecs: 60, results };
      appendLedger(root, line);
      expect(lastLedgerLine(root)?.range).toBe('#0~#1');
      const card = writeCardDraft(root, line)!;
      const text = readFileSync(card, 'utf8');
      expect(text).toContain('`java.test.ts` | failing');
      expect(text).toContain('Unable to locate a Java Runtime.');
      expect(text).not.toContain('`ok.test.ts`');
      expect(text).toContain('아무것도 지우거나 옮기지 않았다');
      expect(writeCardDraft(root, { ...line, results: [results[0]!] })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('nightly audit graph connects audit to record with the shared command recipes', () => {
    const graph = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/test-diet/nightly-audit.yaml'), 'utf8')) as {
      entry_node: string; nodes: Array<{ node_id: string; recipe?: string }>;
      edges: Array<{ from: string; map: Record<string, string> }>;
    };
    const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/test-diet/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
    expect(graph.entry_node).toBe('audit');
    expect(graph.nodes.find((node) => node.node_id === 'audit')?.recipe).toBe('cmd:audit');
    expect(graph.nodes.find((node) => node.node_id === 'record')?.recipe).toBe('cmd:record');
    expect(graph.edges.find((edge) => edge.from === 'audit')?.map).toEqual({ ok: 'record', fail: 'record', error: 'record' });
    expect(recipes.audit?.command).toBe('bun scripts/test-diet/node.ts audit');
    expect(recipes.record?.command).toBe('bun scripts/test-diet/node.ts record');
  });
  test('nightly graph reaches record after an audit failure and ends failed after writing its card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-graph-'));
    try {
      const measurements = GATE_NIGHTLY_AUDITS.map((file, i) => ({ file, secs: 10, rssMb: 100, rc: i === 0 ? 1 : 0, pass: i === 0 ? 0 : 1, fail: i === 0 ? 1 : 0 }));
      const repo = join(import.meta.dir, '../..');
      const state = await runGraph(join(repo, 'graphs/test-diet/nightly-audit.yaml'), {
        deps: { root, runBash: async (command, opts) => {
          if (command.includes('node.ts audit')) return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', measurements, commit: 'abc' }) + '\n', stderr: '' };
          const run = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
            cwd: repo, encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root },
          });
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        } },
      });
      expect(state.status).toBe('failed');
      expect(state.path).toEqual(['audit', 'record', 'failed']);
      expect(readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, 'test-diet/cards'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('nightly record consumes injected audit measurements and writes one line and one failure card', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-audit-'));
    try {
      const measurements = GATE_NIGHTLY_AUDITS.map((file, i) => ({ file, secs: 10, rssMb: 100, rc: i === 0 ? 1 : 0, pass: i === 0 ? 0 : 1, fail: i === 0 ? 1 : 0 }));
      const context = JSON.stringify({ input: {}, outputs: { audit: { commit: 'abc', measurements } } });
      const run = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: context },
      });
      expect(run.status).toBe(1);
      const result = JSON.parse(run.stdout.trim()) as { failing: number; card: string; ledger: string };
      expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', failing: 1 });
      expect(result.ledger).toBe(nightlyAuditLedgerPath(root));
      const lines = readFileSync(result.ledger, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).results).toHaveLength(5);
      expect(existsSync(result.card)).toBe(true);
      expect(readFileSync(result.card, 'utf8')).toContain(`\`${GATE_NIGHTLY_AUDITS[0]}\` | failing`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('audit executes each remote timed file and records the five actual results', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-measure-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const captured = join(root, 'ssh-input');
      const executions = join(root, 'executions');
      const timed = join(root, 'timed');
      const fixture = join(root, 'fixture-time');
      // /usr/bin/time -l is macOS-specific. The SSH shim runs the transmitted script,
      // replacing only that binary with a compatible timed-command fixture on Linux.
      writeFileSync(join(bin, 'ssh'), `#!/bin/sh\ncat > "$TEST_CAPTURED"\nsed -e "s|/usr/bin/time -l|$TEST_TIME|g" -e 's|$HOME/.bun/bin:||g' "$TEST_CAPTURED" | bash\n`);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in\n  clone) for target do :; done; mkdir -p "$target/apps/pwa" ;;\n  rev-parse) echo abc ;;\n  *) exit 2 ;;\nesac\n`);
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\ncase "$1" in\n  install) exit 0 ;;\n  run) printf '%s\\n' "$3" >> "$TEST_EXECUTIONS"; if [ "$3" = "./test/f12-sweep.test.ts" ]; then echo '1 fail' >&2; exit 1; fi; echo '1 pass' >&2 ;;\n  *) exit 2 ;;\nesac\n`);
      writeFileSync(fixture, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_TIMED"\nif [ "$1" = "timeout" ]; then shift 3; fi\n"$@"\nrc=$?\necho '104857600 maximum resident set size' >&2\nexit "$rc"\n`);
      for (const path of [join(bin, 'ssh'), join(bin, 'git'), join(bin, 'bun'), fixture]) chmodSync(path, 0o700);
      const repo = join(import.meta.dir, '../..');
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: {}, outputs: {} }),
        ELANOUS_STATE_DIR: root, TEST_CAPTURED: captured, TEST_TIME: fixture, TEST_EXECUTIONS: executions, TEST_TIMED: timed };
      const audit = spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'audit'], { cwd: repo, encoding: 'utf8', env });
      expect({ status: audit.status, stdout: audit.stdout, stderr: audit.stderr }).toMatchObject({ status: 0 });
      const result = JSON.parse(audit.stdout.trim()) as { outcome: string; measurements: Array<{ file: string; rc: number; rssMb: number; pass: number | null; fail: number | null }> };
      expect(result.outcome).toBe('ok');
      const selected = GATE_NIGHTLY_AUDITS.map((file) => `./${file}`);
      expect(readFileSync(executions, 'utf8').trim().split('\n')).toEqual(selected);
      expect(readFileSync(timed, 'utf8').trim().split('\n').map((line) => line.split(' ').at(-1))).toEqual(selected);
      expect(result.measurements.map((m) => m.file)).toEqual([...GATE_NIGHTLY_AUDITS]);
      expect(result.measurements.map((m) => m.rc)).toEqual([1, 0, 0, 0, 0]);
      expect(result.measurements.every((m) => m.rssMb === 100)).toBe(true);
      const record = spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: repo, encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'nightly-audit', input: {}, outputs: { audit: result } }) },
      });
      expect(record.status).toBe(1);
      const lines = readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const ledger = JSON.parse(lines[0]!) as { results: Array<{ file: string; rc: number; verdict: string }> };
      expect(ledger.results.map((r) => r.file)).toEqual([...GATE_NIGHTLY_AUDITS]);
      expect(ledger.results.map((r) => r.rc)).toEqual([1, 0, 0, 0, 0]);
      const card = (JSON.parse(record.stdout.trim()) as { card: string }).card;
      expect(readFileSync(card, 'utf8')).toContain(`\`${GATE_NIGHTLY_AUDITS[0]}\` | failing`);
      expect(readdirSync(join(root, 'test-diet/cards'))).toHaveLength(1);
      const script = readFileSync(captured, 'utf8');
      expect(script).toContain('/usr/bin/time -l');
      expect(script).toContain('300 bun run scripts/test-deterministic.ts "./$f"');
      expect(script).toContain(`done <<'TEST_DIET_FILES'\n${GATE_NIGHTLY_AUDITS.join('\n')}\nTEST_DIET_FILES`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('nightly record keeps partial measurements, identifies unmeasured files and drafts one failure card', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-audit-'));
    try {
      const context = JSON.stringify({ graphId: 'nightly-audit', input: {}, outputs: { audit: {
        outcome: 'error', summary: 'measured 1/5 on node-b', commit: 'abc',
        measurements: [{ file: GATE_NIGHTLY_AUDITS[0], secs: 1, rssMb: 1, rc: 0, pass: 1, fail: 0 }],
      } } });
      const run = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: context },
      });
      expect(run.status).toBe(1);
      const result = JSON.parse(run.stdout.trim()) as { outcome: string; failing: number; card: string };
      expect(result).toMatchObject({ outcome: 'fail', failing: 4 });
      const lines = readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const recorded = JSON.parse(lines[0]!) as { results: Array<{ file: string; rc: number | null; reason?: string; verdict: string }> };
      expect(recorded.results.map((r) => r.file)).toEqual([...GATE_NIGHTLY_AUDITS]);
      expect(recorded.results[0]).toMatchObject({ rc: 0, verdict: 'keep' });
      expect(recorded.results.slice(1).every((r) => r.rc === null && r.verdict === 'failing' && r.reason?.includes('measured 1/5'))).toBe(true);
      expect(readFileSync(result.card, 'utf8')).toContain(`\`${GATE_NIGHTLY_AUDITS[1]}\` | failing`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('remote audit transport error with no measurements still records all five as failing', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-remote-error-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "ssh: connection refused" >&2\nexit 255\n');
      chmodSync(join(bin, 'ssh'), 0o700);
      const repo = join(import.meta.dir, '../..');
      const audit = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'audit'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: {}, outputs: {} }) },
      });
      expect(audit.status).toBe(2);
      const output = JSON.parse(audit.stdout.trim()) as { outcome: string; summary: string; measurements: unknown[] };
      expect(output).toMatchObject({ outcome: 'error', measurements: [] });
      expect(output.summary).toContain('connection refused');
      const recorded = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'nightly-audit', input: {}, outputs: { audit: output } }) },
      });
      expect(recorded.status).toBe(1);
      const result = JSON.parse(recorded.stdout.trim()) as { failing: number; card: string };
      expect(result.failing).toBe(5);
      const lines = readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as { results: Array<{ reason: string; rc: number | null }> }).results.every((r) => r.rc === null && r.reason.includes('connection refused'))).toBe(true);
      expect(readFileSync(result.card, 'utf8')).toContain('connection refused');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('remote abort after the first timed file preserves that result and reports the other four as unmeasured', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-remote-partial-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bun\nconsole.log('COMMIT abc');\nconsole.log('M\\t${GATE_NIGHTLY_AUDITS[0]}\\t1\\t100\\t0\\t1\\t0\\t');\nconsole.error('remote interrupted');\nprocess.exit(255);\n`);
      chmodSync(join(bin, 'ssh'), 0o700);
      const repo = join(import.meta.dir, '../..');
      const audit = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'audit'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: {}, outputs: {} }) },
      });
      expect(audit.status).toBe(2);
      const output = JSON.parse(audit.stdout.trim()) as { outcome: string; measurements: Array<{ file: string }>; remoteError: string };
      expect(output.outcome).toBe('error');
      expect(output.measurements.map((m) => m.file)).toEqual([GATE_NIGHTLY_AUDITS[0]]);
      const record = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'nightly-audit', input: {}, outputs: { audit: output } }) },
      });
      expect(record.status).toBe(1);
      const line = JSON.parse(readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim()) as { results: Array<{ file: string; rc: number | null; reason?: string; verdict: string }> };
      expect(line.results[0]).toMatchObject({ file: GATE_NIGHTLY_AUDITS[0], rc: 0, verdict: 'keep' });
      expect(line.results.slice(1).every((r) => r.rc === null && r.verdict === 'failing' && r.reason?.includes('remote interrupted'))).toBe(true);
      const card = (JSON.parse(record.stdout.trim()) as { card: string }).card;
      expect(readFileSync(card, 'utf8')).toContain(`\`${GATE_NIGHTLY_AUDITS[1]}\` | failing`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('nightly graph records an audit execution error without JSON output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-graph-error-'));
    try {
      const repo = join(import.meta.dir, '../..');
      const state = await runGraph(join(repo, 'graphs/test-diet/nightly-audit.yaml'), {
        deps: { root, runBash: async (command, opts) => {
          if (command.includes('node.ts audit')) return { exitCode: 2, stdout: '', stderr: 'audit command crashed' };
          const run = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
            cwd: repo, encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root },
          });
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        } },
      });
      expect(state.path).toEqual(['audit', 'record', 'failed']);
      expect(readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(join(root, 'test-diet/cards', `${new Date().toISOString().slice(0, 10)}-nightly-audit.md`), 'utf8')).toContain('`test/f12-sweep.test.ts` | failing');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('remote exit after complete measurements is not misreported as a clean audit', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-remote-exit-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bun\nconsole.log('COMMIT abc');\n${GATE_NIGHTLY_AUDITS.map((file) => `console.log('M\\t${file}\\t1\\t100\\t0\\t1\\t0\\t');`).join('\n')}\nconsole.error('transport disconnected');\nprocess.exit(255);\n`);
      chmodSync(join(bin, 'ssh'), 0o700);
      const repo = join(import.meta.dir, '../..');
      const audit = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'audit'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: {}, outputs: {} }) },
      });
      expect(audit.status).toBe(2);
      const output = JSON.parse(audit.stdout.trim()) as { outcome: string; remoteError: string; measurements: unknown[] };
      expect(output.outcome).toBe('error');
      expect(output.measurements).toHaveLength(5);
      expect(output.remoteError).toContain('transport disconnected');
      const record = spawnSync('bun', [join(import.meta.dir, 'node.ts'), 'record'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'nightly-audit', input: {}, outputs: { audit: output } }) },
      });
      expect(record.status).toBe(1);
      const result = JSON.parse(record.stdout.trim()) as { failing: number; card: string };
      expect(result.failing).toBeGreaterThan(0);
      expect(readFileSync(nightlyAuditLedgerPath(root), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(result.card, 'utf8')).toContain('transport disconnected');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('the cost table reads the TD1 whole-gate TSV', () => {
    expect(costTable('file\tsecs\trss\nx.test.ts\t12\t30\nbad\tNaN\t1\n')).toEqual(new Map([['x.test.ts', 12]]));
  });
});
