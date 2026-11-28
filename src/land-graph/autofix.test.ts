// LAND10-AUTOFIX-LANE — the land finisher fixes mechanical pregate REDs (whitespace · NUMGUARD · private-host key) and
// sends merge-main REDs to the smart-merge refresh. Four synthetic refused PR shapes on real temp git repos, plus the
// semantic / author-active / head-moved refusals. Expected values are literals written from the scenario.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorld } from '../git-smart/fixture.js';
import { smartRefreshSync } from '../git-smart/smart-refresh.js';
import { applyPrivateRedactions } from '../../scripts/public-export.js';
import { addedLines, autofixPr, editsFor, failBlocks, fixNumguard, fixQuoteKey, fixWhitespace, planAutofix, readTar, redRaw } from './autofix.js';
import { autofixesPerHour, finishKindFor, runFinisher, type FinishBook, type FinishDeps } from './finisher.js';
import { tickLand, type LandDeps, type PrInfo, type Receipt } from './land-graph.js';

setDefaultTimeout(120_000); // 출처: #40498 — real git repos on a loaded pregate host take seconds per scenario (smart-merge.test.ts)

const worlds: GitWorld[] = [];
const world = (files?: Record<string, string>) => { const w = new GitWorld(files); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.dispose(); });

/** The NUMGUARD provenance form test/rules-contract.test.ts accepts (copied as a literal, not imported). */
const SOURCE_COMMENT = /(?:\/\/|\/\*)\s*(?:출처|근거|source)\s*[:：]\s*(?:#\d{4,}|R-[A-Z]+\d+[a-z]?|(?:docs|\.rules)\/|DECISION-|RFC-)/i;
const LATER = Date.now() + 2 * 3_600_000; // the author has been quiet for two hours

// Raw shapes copied from 11-28 PREGATE-RED receipts (#40593 NUMGUARD · #40588 public-export · #40530 R-LIVE10).
const NUMGUARD_RAW = [
  '(pass) 게이트 자기검증 — 검사기가 실제로 «문다» > NUMGUARD — full-file 예외 목록에서 누락·경과 날짜·닫힌 PR을 잡는다 [0.64ms]',
  '1572 |     expect(checks.numericGuardViolations(changedNumericGuardLines())).toEqual([]);',
  'error: expect(received).toEqual(expected)',
  '',
  '- []',
  '+ [',
  '+   "numeric-bound: const maxRetries = 4;",',
  '+ ]',
  '',
  '(fail) 게이트 자기검증 — 검사기가 실제로 «문다» > NUMGUARD — diff 상한과 src/apps/scripts/test 전체 예외 원장을 검사한다 [2314.44ms]',
  '(pass) 게이트 자기검증 — 검사기가 실제로 «문다» > deadLinks — 죽은 링크를 «잡고», 살아 있으면 «안» 잡는다 [0.11ms]',
].join('\n');
const LIVE10_RAW = [
  'error: expect(received).toEqual(expected)',
  '(fail) R-LIVE10 — 시험 CLI 호출은 simCli 단일 창구 > 새 직접 spawn은 거부하고 예외 목록은 정해진 기준에서 줄어들기만 한다 [1048.23ms]',
].join('\n');
const CEO_MARK_RAW = [
  '- []',
  '+ [',
  '+   "graphs/triggers/steward-mail.yaml:9 ceo-mark",',
  '+ ]',
  '(fail) 게이트 자기검증 — 검사기가 실제로 «문다» > PUBLIC-EXPORT — 이 변경이 건드린 파일에는 공개본 유출 표지(사적 호스트 이름·왕관 표식)가 없다 [17552.55ms]',
].join('\n');

describe('planAutofix — which reds are mechanical', () => {
  test('NUMGUARD numeric-bound items → numguard; bun fail blocks keep only their own error text', () => {
    expect(failBlocks(NUMGUARD_RAW).map(f => f.name)).toEqual(['게이트 자기검증 — 검사기가 실제로 «문다» > NUMGUARD — diff 상한과 src/apps/scripts/test 전체 예외 원장을 검사한다']);
    expect(planAutofix([{ step: 'rules-and-ratchets', text: NUMGUARD_RAW }])).toEqual({ items: [{ kind: 'numguard', text: 'const maxRetries = 4;' }], semantic: [] });
  });
  test('diff-check trailing whitespace and EOF blank line → whitespace items; space-before-tab → semantic', () => {
    const raw = 'src/a.ts:3: trailing whitespace.\n+const a = 1;  \ndocs/b.md:9: new blank line at EOF.\n';
    expect(planAutofix([{ step: 'diff-check', text: raw }])).toEqual({ items: [{ kind: 'whitespace', file: 'src/a.ts', line: 3 }, { kind: 'whitespace', file: 'docs/b.md', line: 9, eof: true }], semantic: [] });
    expect(planAutofix([{ step: 'diff-check', text: 'src/a.ts:3: space before tab in indent.\n' }]).semantic).toEqual(['diff-check: src/a.ts:3: space before tab in indent.']);
  });
  test('public-export redaction message → quote-key items', () => {
    const raw = '⛔ private redaction would change code identifiers: src/hosts.ts:4 zhost9, src/hosts.ts:9 zhost9 (+1 more)';
    expect(planAutofix([{ step: 'public-leak-check', text: raw }]).items).toEqual([
      { kind: 'quote-key', file: 'src/hosts.ts', line: 4, name: 'zhost9' }, { kind: 'quote-key', file: 'src/hosts.ts', line: 9, name: 'zhost9' }]);
  });
  test('semantic reds fail the whole plan: another failing test · crown mark · tsc · unreadable raw', () => {
    expect(planAutofix([{ step: 'rules-and-ratchets', text: `${NUMGUARD_RAW}\n${LIVE10_RAW}` }]).semantic).toEqual(['rules-and-ratchets: R-LIVE10 — 시험 CLI 호출은 simCli 단일 창구 > 새 직접 spawn은 거부하고 예외 목록은 정해진 기준에서 줄어들기만 한다']);
    expect(planAutofix([{ step: 'rules-and-ratchets', text: CEO_MARK_RAW }]).semantic).toHaveLength(1);
    expect(planAutofix([{ step: 'changed-tsc', text: 'x' }]).semantic).toEqual(['changed-tsc: not a mechanical step']);
    expect(planAutofix([{ step: 'diff-check', text: null }]).semantic).toEqual(['diff-check: raw log unreadable']);
  });
  test('finishKindFor: merge-main-only RED → refresh · ratchet steps → autofix (when wired) · mixed / cross-repo → none', () => {
    expect(finishKindFor('pregate-red', { redSteps: ['merge-main'] })).toBe('refresh');
    expect(finishKindFor('pregate-red', { redSteps: ['diff-check', 'rules-and-ratchets'], autofix: true })).toBe('autofix');
    expect(finishKindFor('pregate-red', { redSteps: ['rules-and-ratchets'] })).toBeNull();
    expect(finishKindFor('pregate-red', { redSteps: ['rules-and-ratchets', 'changed-tsc'], autofix: true })).toBeNull();
    expect(finishKindFor('pregate-red', { redSteps: ['merge-main'], crossRepo: true })).toBeNull();
  });
});

describe('fixers keep the program', () => {
  test('whitespace inside a template literal is the program → refused', () => {
    expect(fixWhitespace('src/t.ts', 'const s = `a  \nb`;\n', new Set([1]), false)).toBeNull();
    expect(fixWhitespace('src/t.ts', 'const a = 1;  \n', new Set([1]), false)).toEqual({ text: 'const a = 1;\n', fixed: [1] });
  });
  test('numguard comment goes above the line with its indent; inside JSX text it would render → refused', () => {
    expect(fixNumguard('src/x.ts', 'function f() {\n  const maxRetries = 4;\n}\n', new Set([2]), 40999)!.text)
      .toBe('function f() {\n  // 출처: #40999 — 이 PR 이 정한 값 그대로(착지 자동 수리 · NUMGUARD)\n  const maxRetries = 4;\n}\n');
    expect(fixNumguard('src/x.tsx', 'const v = (\n  <p>\n    maxItems: 3\n  </p>\n);\n', new Set([3]), 40999)).toBeNull();
  });
  test('quote-key: object / interface keys quoted · shorthand or dotted use → refused', () => {
    expect(fixQuoteKey('src/h.ts', "interface H {\n  zhost9: number;\n}\nconst h = {\n  zhost9: 1,\n};\n", new Set([2, 5]), 'zhost9')!.text)
      .toBe("interface H {\n  'zhost9': number;\n}\nconst h = {\n  'zhost9': 1,\n};\n");
    expect(fixQuoteKey('src/h.ts', 'const zhost9 = 1;\nconst h = { zhost9 };\n', new Set([2]), 'zhost9')).toBeNull();
    expect(fixQuoteKey('src/h.ts', 'const v = cfg.zhost9;\n', new Set([1]), 'zhost9')).toBeNull();
  });
  test('addedLines reads the head line numbers of a -U0 diff', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,0 +3,2 @@\n+x\n+y\n@@ -9 +11 @@\n-z\n+w\n';
    expect([...addedLines(diff).get('src/a.ts')!]).toEqual([3, 4, 11]);
  });
  test('editsFor refuses when the NUMGUARD text is not on a PR-added line', () => {
    const r = editsFor({ items: [{ kind: 'numguard', text: 'const maxRetries = 4;' }], semantic: [] }, 40999, new Map([['src/a.ts', new Set([1])]]), () => 'const other = 1;\n');
    expect(r).toEqual({ semantic: 'numguard: no PR-added line reads «const maxRetries = 4;»' });
  });
});

describe('red.tar reader', () => {
  test('reads <step>.raw out of a real tar', () => {
    const d = mkdtempSync(join(tmpdir(), 'autofix-tar-'));
    writeFileSync(join(d, 'diff-check.raw'), 'src/a.ts:1: trailing whitespace.\n');
    writeFileSync(join(d, 'receipt.json'), '{}');
    const t = spawnSync('tar', ['cf', 'red.tar', 'receipt.json', 'diff-check.raw'], { cwd: d, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(t.status).toBe(0);
    const out = mkdtempSync(join(tmpdir(), 'autofix-tar-out-'));
    spawnSync('cp', [join(d, 'red.tar'), join(out, 'red.tar')]);
    expect(redRaw(out, 'diff-check')).toBe('src/a.ts:1: trailing whitespace.\n');
    expect(readTar(new Uint8Array(0)).size).toBe(0);
  });
});

// ── Four synthetic refused PRs on real git ───────────────────────────────────────────────────────────────────────

/** Author opens a PR branch with `files`, returns the head. */
function openPr(w: GitWorld, branch: string, files: Record<string, string>): string {
  w.onBranch(branch, files, `feat: ${branch}`, 'main');
  return w.remoteHead(branch);
}
const run = (w: GitWorld, pr: number, branch: string, head: string, red: Array<{ step: string; text: string }>, nowMs = LATER) =>
  autofixPr({ repo: w.land, pr, head, branch, red, lockDir: w.lockDir, nowMs });

describe('LAND10-AUTOFIX-LANE · four synthetic refused PRs', () => {
  test('① diff-check whitespace → fix commit pushed (plain fast-forward) → diff --check clean', () => {
    const w = world({ 'src/a.ts': 'export const a = 1;\n' });
    const head = openPr(w, 'ws', { 'src/a.ts': 'export const a = 1;\nexport const b = 2;   \n' });
    const r = run(w, 41001, 'ws', head, [{ step: 'diff-check', text: 'src/a.ts:2: trailing whitespace.\n+export const b = 2;   \n' }]);
    expect(r.result).toBe('fixed');
    const now = w.remoteHead('ws');
    expect(now).not.toBe(head);
    w.l(['fetch', '-q', 'origin']);
    expect(w.l(['merge-base', '--is-ancestor', head, now])).toBe(''); // fast-forward: never force
    expect(w.show(now, 'src/a.ts')).toBe('export const a = 1;\nexport const b = 2;');
    expect(spawnSync('git', ['-C', w.land, 'diff', '--check', 'origin/main', now]).status).toBe(0);
  });

  test('② NUMGUARD numeric bound without source → provenance comment above it → the ratchet form matches', () => {
    const w = world({ 'src/r.ts': 'export function go() {\n  return 0;\n}\n' });
    const head = openPr(w, 'ng', { 'src/r.ts': 'export function go() {\n  const maxRetries = 4;\n  return maxRetries;\n}\n' });
    const r = run(w, 41002, 'ng', head, [{ step: 'rules-and-ratchets', text: NUMGUARD_RAW }]);
    expect(r.result).toBe('fixed');
    const lines = w.show(w.remoteHead('ng'), 'src/r.ts').split('\n');
    expect(lines[1]).toBe('  // 출처: #41002 — 이 PR 이 정한 값 그대로(착지 자동 수리 · NUMGUARD)');
    expect(lines[2]).toBe('  const maxRetries = 4;');
    expect(SOURCE_COMMENT.test(lines[1]!)).toBe(true);
  });

  test('③ private host as an unquoted object key → quoted → the export redaction no longer touches an identifier', () => {
    const w = world({ 'src/hosts.ts': 'export const HOSTS = {};\n' });
    const head = openPr(w, 'qk', { 'src/hosts.ts': 'export const HOSTS = {\n  zhost9: { cpu: 8 },\n};\n' });
    const before = new Map([['src/hosts.ts', w.show(head, 'src/hosts.ts')]]);
    expect(() => applyPrivateRedactions(before, [{ from: 'zhost9', to: 'host-a' }])).toThrow('private redaction would change code identifiers');
    const r = run(w, 41003, 'qk', head, [{ step: 'public-leak-check', text: '⛔ private redaction would change code identifiers: src/hosts.ts:2 zhost9' }]);
    expect(r.result).toBe('fixed');
    const after = w.show(w.remoteHead('qk'), 'src/hosts.ts');
    expect(after).toBe("export const HOSTS = {\n  'zhost9': { cpu: 8 },\n};");
    expect(applyPrivateRedactions(new Map([['src/hosts.ts', after]]), [{ from: 'zhost9', to: 'host-a' }]).places).toBe(1);
  });

  test('④ merge-main RED → finisher refresh → smart-merge resolves the list-append conflict and pushes', () => {
    const w = world({ 'src/reg.ts': "export const R = [\n  'a',\n];\n" });
    const head = openPr(w, 'mm', { 'src/reg.ts': "export const R = [\n  'a',\n  'pr',\n];\n" });
    w.onMain({ 'src/reg.ts': "export const R = [\n  'a',\n  'main',\n];\n" });
    expect(finishKindFor('pregate-red', { redSteps: ['merge-main'] })).toBe('refresh');
    const pr: PrInfo = { number: 41004, head, base: 'main', draft: false, state: 'OPEN', title: 'mm', author: 'TC', files: ['src/reg.ts'], headRef: 'mm' };
    const book: FinishBook = { jobs: {} };
    const d: FinishDeps = {
      now: () => new Date(), launchPregate: () => ({ ok: true }), alive: () => false, hasReceipt: () => null,
      refresh: p => { const s = smartRefreshSync({ repo: w.land, pr: p.number, head: p.head, branch: p.headRef!, lockDir: w.lockDir }); return s.result === 'merged' ? { result: 'merged', newHead: s.newHead } : { result: 'error', why: s.result }; },
    };
    const out = runFinisher(book, [{ pr, kind: 'refresh' }], d, true);
    expect(out.map(o => o.state)).toEqual(['refreshed']);
    expect(w.show(w.remoteHead('mm'), 'src/reg.ts')).toBe("export const R = [\n  'a',\n  'main',\n  'pr',\n];");
  });
});

describe('LAND10-AUTOFIX-LANE · refusals push nothing', () => {
  test('semantic red (R-LIVE10 next to NUMGUARD) → semantic · branch untouched', () => {
    const w = world({ 'src/r.ts': 'export const x = 0;\n' });
    const head = openPr(w, 'sem', { 'src/r.ts': 'export const maxRetries = 4;\n' });
    const r = run(w, 41005, 'sem', head, [{ step: 'rules-and-ratchets', text: `${NUMGUARD_RAW}\n${LIVE10_RAW}` }]);
    expect(r.result).toBe('semantic');
    expect(w.remoteHead('sem')).toBe(head);
  });
  test('author pushed minutes ago → author-active · branch untouched', () => {
    const w = world({ 'src/a.ts': 'export const a = 1;\n' });
    const head = openPr(w, 'act', { 'src/a.ts': 'export const a = 1;  \n' });
    const r = run(w, 41006, 'act', head, [{ step: 'diff-check', text: 'src/a.ts:1: trailing whitespace.\n' }], Date.now());
    expect(r.result).toBe('author-active');
    expect(w.remoteHead('act')).toBe(head);
  });
  test('the branch moved after the RED → head-moved · nothing pushed', () => {
    const w = world({ 'src/a.ts': 'export const a = 1;\n' });
    const head = openPr(w, 'mv', { 'src/a.ts': 'export const a = 1;  \n' });
    const moved = w.onBranch('mv', { 'src/a.ts': 'export const a = 2;\n' }, 'author fixes it');
    const r = run(w, 41007, 'mv', head, [{ step: 'diff-check', text: 'src/a.ts:1: trailing whitespace.\n' }]);
    expect(r.result).toBe('head-moved');
    expect(w.remoteHead('mv')).toBe(moved);
  });
});

describe('finisher autofix lane · KPI and cards', () => {
  const pr: PrInfo = { number: 41010, head: 'f'.repeat(40), base: 'main', draft: false, state: 'OPEN', title: 'af', author: 'TC', files: ['src/a.ts'], headRef: 'af' };
  const red = { dir: '/r/41010', failed: [{ name: 'diff-check', exit: 2 }] };
  const base = { now: () => new Date('2026-11-28T06:00:00Z'), launchPregate: () => ({ ok: true }), alive: () => false, hasReceipt: () => null, refresh: () => ({ result: 'error' as const }) };
  test('fixed → book row «fixed» (one job per head) · KPI autofix/h counts it', () => {
    const book: FinishBook = { jobs: {} };
    let calls = 0;
    const d: FinishDeps = { ...base, autofix: () => { calls++; return { result: 'fixed', newHead: 'e'.repeat(40) }; } };
    expect(runFinisher(book, [{ pr, kind: 'autofix', red }], d, true).map(o => o.state)).toEqual(['fixed']);
    expect(runFinisher(book, [{ pr, kind: 'autofix', red }], d, true).map(o => o.state)).toEqual(['fixed']);
    expect(calls).toBe(1);
    expect(autofixesPerHour(Object.values(book.jobs), Date.parse('2026-11-28T06:30:00Z'))).toBe(1);
    expect(autofixesPerHour(Object.values(book.jobs), Date.parse('2026-11-28T07:30:00Z'))).toBe(0);
  });
  test('author-active is not booked (retried next tick) · plan mode only reports', () => {
    const book: FinishBook = { jobs: {} };
    const d: FinishDeps = { ...base, autofix: () => ({ result: 'author-active', why: 'head pushed 3 min ago' }) };
    expect(runFinisher(book, [{ pr, kind: 'autofix', red }], d, true).map(o => o.state)).toEqual(['author-active']);
    expect(Object.keys(book.jobs)).toEqual([]);
    expect(runFinisher(book, [{ pr, kind: 'autofix', red }], d, false).map(o => o.state)).toEqual(['would-run']);
  });
  test('tick: a semantic RED gets the author\'s pregate-red card; a mechanical one is fixed without a card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autofix-tick-'));
    const org = join(root, 'federation.yaml'); writeFileSync(org, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
    const sem: PrInfo = { ...pr, number: 41011, head: 'a'.repeat(40), headRef: 'sem', author: 'UX' };
    const mech: PrInfo = { ...pr, number: 41012, head: 'b'.repeat(40), headRef: 'mech', author: 'UX' };
    const rcpt = (p: PrInfo): Receipt => ({ dir: `/r/${p.number}`, head: p.head, host: 'h1', focused: [], rawDir: '', focusedExit: null, red: { failed: [{ name: 'rules-and-ratchets', exit: 1 }] } });
    const posts: string[] = []; const fixedPrs: number[] = [];
    const d: LandDeps = {
      now: () => new Date('2026-11-28T06:40:00Z'), stateRoot: root, mode: 'live', slots: 2, org: { path: org },
      listPrs: async () => [sem, mech], prNow: async n => [sem, mech].find(p => p.number === n) ?? null,
      receipt: (n, h) => [sem, mech].filter(p => p.number === n && p.head === h).map(rcpt)[0] ?? null,
      olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
      land: async () => ({ rc: 99, text: 'never' }), post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
      finisher: { ...base, autofix: p => { if (p.number === sem.number) return { result: 'semantic', why: 'rules-and-ratchets: R-LIVE10' }; fixedPrs.push(p.number); return { result: 'fixed', newHead: 'c'.repeat(40) }; } },
    };
    const res = await tickLand(d);
    expect(fixedPrs).toEqual([41012]);
    expect(res.autofixPerHour).toBe(1);
    expect(posts.filter(x => x.includes('[land-graph · pregate-red] #41011')).length).toBe(2); // author UX + landing owner TC
    expect(posts.some(x => x.includes('#41012'))).toBe(false);
  });
});
