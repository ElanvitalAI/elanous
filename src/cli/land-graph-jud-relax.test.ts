import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { defaultLandDeps, findBaselineDiff, landExtra, readJudHold, readReceipt, readTerraReview } from './land-graph-cli.js';

const H = 'c'.repeat(40);
const pr = { number: 40300, head: H, base: 'main', draft: false, state: 'OPEN' as const, title: 't', author: 'TC', files: ['src/x.ts'] };
const receipt = { dir: '/r/40300-cccccccccccc-minim5', head: H, host: 'minim5', focused: ['src/x.test.ts'], rawDir: '' };

describe('readTerraReview (review-results/pr-<PR>-<head12>.json)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-rr-'));
  const put = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v));
  test('terra pass with no security fields → clean', () => {
    put(`pr-1-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: true, respondedModel: 'gpt-6.1-terra', headCommit: H, mustFix: [] });
    expect(readTerraReview(dir, 1, H)).toEqual({ verdict: 'pass', securityFindings: [] });
  });
  test('structured securityFindings / securityClass / legacy security-4 findings count', () => {
    put(`pr-2-${H.slice(0, 12)}.json`, { verdict: 'warn', reviewed: true, headCommit: H, model: 'gpt-6.1-terra', securityClass: 'secret-leak', securityFindings: [{ kind: 'security-only', text: 'token in log' }],
      findings: [{ category: 'auth', title: 'no check' }, { category: 'style', title: 'x' }, { category: 'secret', title: 'fixed', disposition: 'fixed-in-this-head' }] });
    expect(readTerraReview(dir, 2, H)?.securityFindings).toEqual(['class:secret-leak', 'security-only:token in log', 'auth:no check']);
  });
  test('another answering model, a Terra request that fell back, another head, not completed, or no file → null', () => {
    put(`pr-3-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: true, headCommit: H, model: 'glm-5' });
    put(`pr-4-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: true, model: 'gpt-6.1-terra', headCommit: 'd'.repeat(40) });
    put(`pr-6-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: true, headCommit: H, requestedModel: 'gpt-6.1-terra', respondedModel: 'grok-5' });
    put(`pr-7-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: false, headCommit: H, respondedModel: 'gpt-6.1-terra' });
    put(`pr-8-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewed: true, respondedModel: 'gpt-6.1-terra' });
    expect([3, 4, 5, 6, 7, 8].map(n => readTerraReview(dir, n, H))).toEqual([null, null, null, null, null, null]);
  });
});

describe('readJudHold (JUD HOLD verdicts = veto)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-jh-'));
  const put = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v));
  test('hold-/judb- HOLD by a JUD reviewer → veto by JUD', () => {
    put(`hold-10-${H.slice(0, 12)}.json`, { verdict: 'HOLD', reviewer: 'JUD-C', headCommit: H, mustFix: ['keep the fact'] });
    expect(readJudHold(dir, 10, H)).toEqual({ by: 'JUD', reason: `HOLD verdict hold-10-${H.slice(0, 12)} · keep the fact` });
    put(`judb-security-11-${H.slice(0, 12)}.json`, { verdict: 'hold', securityClass: 'secret-leak' });
    expect(readJudHold(dir, 11, H)?.reason).toStartWith('security secret-leak verdict');
  });
  test('pass verdict, non-JUD reviewer, other head → no veto', () => {
    put(`judb-12-${H.slice(0, 12)}.json`, { verdict: 'pass', reviewer: 'JUD-C' });
    put(`hold-13-${H.slice(0, 12)}.json`, { verdict: 'hold', reviewer: 'TC' });
    put(`jud-14-${H.slice(0, 12)}.json`, { verdict: 'hold', reviewer: 'JUD', headCommit: 'd'.repeat(40) });
    expect([readJudHold(dir, 12, H), readJudHold(dir, 13, H), readJudHold(dir, 14, H)]).toEqual([null, null, null]);
  });
});

describe('findBaselineDiff (land-name-diff-check.py receipt)', () => {
  test('same head · introduced [] · head raw parses → diff with head counts', () => {
    const d = mkdtempSync(join(tmpdir(), 'lg-nd-'));
    writeFileSync(join(d, 'head.log'), '(fail) a > b\n 41 pass\n 1 fail\n');
    writeFileSync(join(d, 'namediff.json'), JSON.stringify({ head: H, command: 'bun test a.test.ts', headLog: join(d, 'head.log'), headFailureNames: ['a > b'], baseFailureNames: ['a > b'], introducedFailureNames: [] }));
    expect(findBaselineDiff([join(d, 'missing'), d], H)).toEqual({ receipt: join(d, 'namediff.json'), command: 'bun test a.test.ts', headPass: 41, headFail: 1 });
  });
  test('introduced failures or another head → null', () => {
    const d = mkdtempSync(join(tmpdir(), 'lg-nd-'));
    writeFileSync(join(d, 'head.log'), ' 41 pass\n 2 fail\n');
    writeFileSync(join(d, 'namediff.json'), JSON.stringify({ head: H, command: 'bun test a', headLog: join(d, 'head.log'), headFailureNames: ['x', 'y'], introducedFailureNames: ['y'] }));
    writeFileSync(join(d, 'receipt.json'), JSON.stringify({ head: 'd'.repeat(40), command: 'bun test a', headLog: join(d, 'head.log'), headFailureNames: ['x'], introducedFailureNames: [] }));
    expect(findBaselineDiff([d], H)).toBeNull();
  });
});

describe('landExtra (numbers only from a receipt · A138)', () => {
  test('focused counts → headTestRun pass/0', () => {
    expect(landExtra(pr, receipt, 'w', { pass: 9, fail: 0 })).toMatchObject({ headTestRun: { sha: H, pass: 9, fail: 0, exit: 0, command: 'bun test src/x.test.ts' } });
  });
  test('L0 doc-only and swept exit 0 carry no headTestRun', () => {
    expect(landExtra(pr, receipt, 'w', 'unreadable', { lane: 'L0-doc-only' })).not.toHaveProperty('headTestRun');
    expect(landExtra(pr, receipt, 'w', { swept: true, exit: 0 })).not.toHaveProperty('headTestRun');
  });
  test('baseline-name-diff → baselineNameDiff.receipt + the diff command and head counts', () => {
    const x = landExtra(pr, receipt, 'w', { pass: 41, fail: 1 }, { baselineDiff: { receipt: '/nd.json', command: 'bun test a', headPass: 41, headFail: 1 } });
    expect(x).toMatchObject({ baselineNameDiff: { receipt: '/nd.json' }, headTestRun: { command: 'bun test a', pass: 41, fail: 1 } });
  });
});

describe('readReceipt grade', () => {
  test('L0 receipt keeps grade and a null focused exit', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'lg-rc-')), '40244-18254ebc3be8-minim5'); mkdirSync(d);
    writeFileSync(join(d, 'receipt.json'), JSON.stringify({ head: H, host: 'minim5', grade: 'L0', focused: ['test/rules-contract.test.ts'], steps: [{ name: 'diff-check', exit: 0 }] }));
    expect(readReceipt(d)).toMatchObject({ grade: 'L0', focusedExit: null, focused: ['test/rules-contract.test.ts'] });
  });
});

describe('defaultLandDeps.land writes the extra.json the golden path receives (land command stubbed)', () => {
  test('swept exit 0 and L0 doc-only → no headTestRun · readable focused → counts from the raw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-land-'));
    const seat = join(root, 'seat-state'); const out = join(root, 'extras'); mkdirSync(out);
    const stub = join(root, 'land-stub.sh');
    // Stub of op-direct-land-v2.sh: copy the extra.json (4th arg) aside, never merge.
    writeFileSync(stub, `#!/bin/zsh\ncp "$4" '${out}'/extra-$1-$(ls '${out}' | wc -l | tr -d ' ').json\necho OK\n`); chmodSync(stub, 0o755);
    const cfgDir = join(root, 'cfg'); mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ land: { graph: { landCmd: stub, repo: root } } }));
    const saved = process.env.ELANOUS_SEAT_STATE;
    process.env.ELANOUS_SEAT_STATE = seat; setElanousConfigDir(cfgDir);
    try {
      const d = defaultLandDeps();
      const rdir = join(root, '40300-cccccccccccc-minim5'); mkdirSync(rdir);
      const swept = { ...receipt, dir: rdir, focusedExit: 0 };
      expect((await d.land(pr, swept, 'w', {})).rc).toBe(0);
      expect((await d.land({ ...pr, files: ['docs/a.md'] }, { ...swept, grade: 'L0', focusedExit: null }, 'w', { lane: 'L0-doc-only' })).rc).toBe(0);
      writeFileSync(join(rdir, 'focused.raw'), ' 12 pass\n 0 fail\n');
      expect((await d.land(pr, swept, 'w', {})).rc).toBe(0);
      const x = [0, 1, 2].map(i => JSON.parse(readFileSync(join(out, `extra-40300-${i}.json`), 'utf8')) as Record<string, unknown>);
      expect([x[0]!.headTestRun, x[1]!.headTestRun]).toEqual([undefined, undefined]);
      expect(x[2]!.headTestRun).toMatchObject({ sha: H, pass: 12, fail: 0, exit: 0 });
      expect(x[0]!.receipt).toBe(join(rdir, 'receipt.json'));
    } finally {
      resetElanousConfigDir();
      if (saved === undefined) delete process.env.ELANOUS_SEAT_STATE; else process.env.ELANOUS_SEAT_STATE = saved;
    }
  });
});
