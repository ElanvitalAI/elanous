import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutoApprove } from './auto-approve-node.js';
import type { GraphContext } from './node-verdict.js';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'release-auto-approve-'));
  const repo = join(root, 'repo');
  const out = join(root, 'release', '0.2.4', 'prepared');
  mkdirSync(join(out, 'dist'), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
  for (let n = 0; n < 5; n++) writeFileSync(join(out, 'dist', `file-${n}`), 'fixture');
  const context: GraphContext = { runId: 'run-tui-subcheck', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: {
    gate: { outcome: 'ok', introduced: [] }, prepare: { outcome: 'ok', out, candidate: join(out, 'dist', 'elanous.tgz'), commit: 'a'.repeat(40) },
    upgrade: { outcome: 'ok' }, tui: { outcome: 'ok', regress: { pass: 7, fail: 0,
      results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: true, reason: 'passed' })) } },
    docs: { outcome: 'ok', notes: '/tmp/0.2.4.md', flipped: [] }, 'notes-check': { outcome: 'ok' },
  } };
  return { root, repo, out, context, run: () => runAutoApprove(context, { instanceRoot: root, repo }) };
};

test('eight measured metrics approve and write a rollback report', () => {
  const f = fixture();
  try {
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'ok', decidedBy: 'release-loop metrics' });
    expect(result.metrics).toHaveLength(10);
    expect(result.metrics.map((m) => m.verdict)).toEqual(Array(10).fill('pass'));
    expect(result.metrics[8]).toMatchObject({ name: 'tui-regress', value: 'ok', reason: 'tui-regress: ok — 7 pass · 0 fail' });
    expect(result.tuiSubcheck).toEqual({ runId: 'run-tui-subcheck', level: 'ok', fail: 0, failedCheckIds: [], approvalRequired: false });
    const report = readFileSync(join(f.root, 'release', '0.2.4', 'auto-approval.md'), 'utf8');
    expect(report.split('\n').filter((line) => /^\| (?:[1-9]|10) \|/.test(line))).toHaveLength(10);
    expect(report).toContain('gh release edit v0.2.4 --draft');
    expect(report).toContain('git push origin :refs/tags/v0.2.4');
    expect(report).toContain('해당 docs PR revert');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('four installation files fail the installation metric', () => {
  const f = fixture();
  try {
    rmSync(join(f.out, 'dist', readdirSync(join(f.out, 'dist'))[0]!));
    const short = f.run();
    expect(short.outcome).toBe('fail');
    expect(short.metrics[7]?.verdict).toBe('fail');
    expect(short).not.toHaveProperty('decidedBy');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('absent gate is unmeasured, never approved', () => {
  const f = fixture();
  try {
    delete f.context.outputs.gate;
    const absent = f.run();
    expect(absent.outcome).toBe('fail');
    expect(absent.metrics[0]?.verdict).toBe('unmeasured');
    expect(readFileSync(absent.report, 'utf8')).toContain('unmeasured');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('TUI subcheck failure and unmeasured output require HITL, with failed IDs in the approval report', () => {
  const f = fixture();
  try {
    const results = Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: `check ${i + 1}`, ok: true, reason: 'passed' }));
    for (const [regress, value, fragment] of [
      [{ pass: 7, fail: 0, results }, 'ok', '7 pass · 0 fail'],
      [{ pass: 6, fail: 1, results: results.map((r) => ({ ...r, ok: r.id !== 'R3' })) }, 'warn', 'R3'],
      [{ unmeasured: '3분 시간 초과' }, 'unmeasured', '3분 시간 초과'],
    ] as const) {
      f.context.outputs.tui!.regress = regress;
      const approved = f.run();
      expect(approved).toMatchObject({ outcome: value === 'ok' ? 'ok' : 'fail', verdict: value === 'ok' ? 'pass' : 'fail' });
      expect(approved.metrics[3]).toMatchObject({ name: 'tui', value: 'ok', verdict: 'pass' });
      expect(approved.metrics[8]).toMatchObject({ name: 'tui-regress', value, verdict: value === 'ok' ? 'pass' : value === 'warn' ? 'fail' : 'unmeasured' });
      expect(approved.metrics[8]?.reason).toContain(fragment);
      expect(readFileSync(approved.report, 'utf8')).toContain(`| tui-regress | ${value} — tui-regress: ${value} —`);
      expect(approved.tuiSubcheck.approvalRequired).toBe(value !== 'ok');
      if (value === 'warn') {
        expect(approved.tuiSubcheck).toMatchObject({ fail: 1, failedCheckIds: ['R3'] });
        expect(approved.summary).toContain('R3');
        expect(readFileSync(approved.report, 'utf8')).toContain('TUI subcheck: warn · failed 1 [R3] · HITL');
      }
    }
    f.context.outputs.tui!.outcome = 'fail';
    expect(f.run()).toMatchObject({ outcome: 'fail', verdict: 'fail' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('incomplete or inconsistent TUI regress data cannot be auto-approved', () => {
  const f = fixture();
  try {
    const results = Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: `check ${i + 1}`, ok: true, reason: 'passed' }));
    for (const regress of [
      { results: [] },
      { pass: 7, fail: 0, results: results.slice(1) },
      { pass: 6, fail: 1, results },
      { pass: 7, fail: 0, results: results.map((r) => ({ ...r, id: 'R1' })) },
      { pass: 7, fail: 0, results: results.map((r) => ({ ...r, ok: r.id !== 'R3' })) },
    ]) {
      f.context.outputs.tui!.regress = regress;
      const approved = f.run();
      expect(approved).toMatchObject({ outcome: 'fail', verdict: 'fail',
        tuiSubcheck: { level: 'unmeasured', fail: null, failedCheckIds: null, approvalRequired: true } });
      expect(approved.metrics[3]).toMatchObject({ name: 'tui', value: 'ok', verdict: 'pass' });
      expect(approved.metrics[8]).toMatchObject({ name: 'tui-regress', value: 'unmeasured', verdict: 'unmeasured', reason: 'tui-regress: unmeasured — tui.regress 결과 없음' });
      expect(readFileSync(approved.report, 'utf8')).toContain('| tui-regress | unmeasured — tui-regress: unmeasured — tui.regress 결과 없음 | unmeasured |');
      expect(readFileSync(approved.report, 'utf8')).not.toContain('undefined pass');
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('gate error, changed bun, missing docs notes and missing dist fail closed', () => {
  const f = fixture();
  try {
    f.context.outputs.gate!.error = 'sweep incomplete';
    expect(f.run().metrics[0]?.verdict).toBe('fail');
    delete f.context.outputs.gate!.error;
    writeFileSync(join(f.repo, '.bun-version'), '0.0.0\n');
    expect(f.run().metrics[1]?.verdict).toBe('fail');
    writeFileSync(join(f.repo, '.bun-version'), Bun.version);
    delete f.context.outputs.docs!.notes;
    expect(f.run().metrics[6]?.verdict).toBe('unmeasured');
    rmSync(join(f.out, 'dist'), { recursive: true });
    expect(f.run().metrics[7]?.verdict).toBe('unmeasured');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('mac-smoke ok, fail and error stay warning-only as the last row while the 8 blocking metrics decide (MAC1)', () => {
  const f = fixture();
  try {
    for (const [node, value] of [
      [{ outcome: 'ok', summary: 'macOS ok · 새 실패 0' }, 'ok'],
      [{ outcome: 'fail', summary: 'macOS fail · 새 실패 2' }, 'warn'],
      [{ outcome: 'error', summary: 'macOS 측정 불가' }, 'unmeasured'],
      [undefined, 'unmeasured'],
    ] as const) {
      if (node) f.context.outputs['mac-smoke'] = node; else delete f.context.outputs['mac-smoke'];
      const approved = f.run();
      expect(approved).toMatchObject({ outcome: 'ok', verdict: 'pass', summary: 'auto approval ok: 8/8' });
      expect(approved.metrics[8]?.name).toBe('tui-regress');
      expect(approved.metrics[9]).toMatchObject({ name: 'mac-smoke', value, verdict: 'pass' });
      expect(readFileSync(approved.report, 'utf8')).toContain(`| 10 | mac-smoke | ${value}`);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
