import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, type Receipt } from '../land-graph/land-graph.js';
import { patchIdOf, reuseByPatchId } from './land-graph-cli.js';

/** A real repo: main + a PR branch; the PR head later merges main (same PR-own change) or the author changes code. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lg-pid-'));
  const g = (...a: string[]) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n'); writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'pr');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n'); g('commit', '-qam', 'pr change');
  const h1 = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n'); g('commit', '-qam', 'main moves');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  g('checkout', '-q', 'pr'); g('merge', '-q', '--no-edit', 'main');
  const h2 = g('rev-parse', 'HEAD'); // merge-main-only head
  writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n'); g('commit', '-qam', 'author edit');
  const h3 = g('rev-parse', 'HEAD'); // real author change
  return { dir, h1, h2, h3 };
}

describe('PATCHID-1127 receipt reuse', () => {
  const { dir, h1, h2, h3 } = repo();
  const r1: Receipt = { dir: `/r/9-${h1.slice(0, 12)}-node-b`, head: h1, host: 'node-b', focused: ['a.test.ts'], rawDir: '', focusedExit: 0 };
  test('a head that only merged main keeps the patch-id · an author edit changes it', () => {
    expect(patchIdOf(dir, h1)).toMatch(/^[0-9a-f]{40}$/);
    expect(patchIdOf(dir, h2)).toBe(patchIdOf(dir, h1));
    expect(patchIdOf(dir, h3)).not.toBe(patchIdOf(dir, h1));
  });
  test('reuse: merge-main-only head → older GREEN receipt with reusedFrom · author edit → none', () => {
    expect(reuseByPatchId([r1], h2, s => patchIdOf(dir, s))).toMatchObject({ head: h2, reusedFrom: h1, dir: r1.dir });
    expect(reuseByPatchId([r1], h3, s => patchIdOf(dir, s))).toBeNull();
    // a receipt that stored its patchId is trusted without re-reading the old head
    expect(reuseByPatchId([{ ...r1, head: 'f'.repeat(40), patchId: patchIdOf(dir, h1)! }], h2, s => patchIdOf(dir, s))?.reusedFrom).toBe('f'.repeat(40));
  });
  test('decide lands on a reused receipt and records it', () => {
    const pr = { number: 9, head: h2, base: 'main', draft: false, state: 'OPEN' as const, title: 't', author: 'TC', files: ['a.ts'] };
    const d = decide({ pr, receipt: { ...r1, head: h2, reusedFrom: h1 }, olderReceiptHead: null, focused: { pass: 3, fail: 0 }, hold: null, security: [], landedBefore: false });
    expect(d.action).toBe('land');
    expect(d.why).toContain(`receipt reused via patch-id from ${h1.slice(0, 12)}`);
  });
});
