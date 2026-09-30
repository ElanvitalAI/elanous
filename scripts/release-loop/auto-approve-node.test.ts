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
  const context: GraphContext = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: {
    gate: { outcome: 'ok', introduced: [] }, prepare: { outcome: 'ok', out, candidate: join(out, 'dist', 'elanous.tgz'), commit: 'a'.repeat(40) },
    upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', notes: '/tmp/0.2.4.md', flipped: [] }, 'notes-check': { outcome: 'ok' },
  } };
  return { root, repo, out, context, run: () => runAutoApprove(context, { instanceRoot: root, repo }) };
};

test('eight measured metrics approve and write a rollback report', () => {
  const f = fixture();
  try {
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'ok', decidedBy: 'release-loop metrics' });
    expect(result.metrics).toHaveLength(8);
    expect(result.metrics.map((m) => m.verdict)).toEqual(Array(8).fill('pass'));
    const report = readFileSync(join(f.root, 'release', '0.2.4', 'auto-approval.md'), 'utf8');
    expect(report.split('\n').filter((line) => /^\| [1-8] \|/.test(line))).toHaveLength(8);
    expect(report).toContain('gh release edit v0.2.4 --draft');
    expect(report).toContain('git push origin :refs/tags/v0.2.4');
    expect(report).toContain('해당 docs PR revert');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('four installation files fail metric eight', () => {
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
