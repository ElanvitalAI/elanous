import type { AskUserQuestionRequest } from '../ask-user-question/types.js';
import { createPendingQuestion, readPendingQuestionAnswer, writePendingQuestion, writePendingQuestionAnswer } from '../ask-user-question/pending-questions.js';
import { debug } from '../debug/log.js';
import { setDefaultTimeout, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createVersionResolver } from '../directives/version-at.js';
import { DecisionLedger, importDecisionMarkdown, type RaiseInput } from './decision-ledger.js';
import { formatDecisionDetail } from '../cli/decisions-cli.js';
import { renderCardText } from './decision-cards.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = () => mkdtempSync(join(tmpdir(), 'decisions-test-'));
const base: RaiseInput = { title: 'Publish?', category: 'publish', scqa: { s: 'Draft ready.', c: 'Publishing is irreversible.' },
  options: [{ key: 'a', label: 'Publish', consequence: 'Public' }, { key: 'b', label: 'Hold', consequence: 'Delayed' }],
  recommendation: { option: 'b', why: 'Review first' }, raisedBy: { agent: 'codex', track: 'S' } };
const versions = (at: string) => at < '2026-10-01' ? { released: '0.2.4', dev: '0.2.5-dev.0', codename: '지니의 소원' } : { released: '0.2.5', dev: '0.2.6-dev.0', codename: '내 일에 맞게' };
const ledger = (stateDir = root()) => new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions });

test('cross-check fields round-trip while an old raised line stays unchanged and renders', () => {
  const store = ledger();
  const checked = store.raise({ ...base, crossCheck: [{ seat: 'TC', at: '2026-10-01T00:00:00Z', note: '키 경로 영향 없음' }], alternative: 'a', dissent: 'UX: 화면 문구 미정' });
  expect(store.show(checked.id)).toMatchObject({ crossCheck: [{ seat: 'TC', at: '2026-10-01T00:00:00.000Z', note: '키 경로 영향 없음' }], alternative: 'a', dissent: 'UX: 화면 문구 미정' });
  const old = store.raise(base);
  const line = readFileSync(store.path, 'utf8').trim().split('\n').at(-1)!;
  const oldEvent = JSON.parse(line);
  for (const key of ['crossCheck', 'crossCheckSkipped', 'alternative', 'dissent']) expect(oldEvent.entry).not.toHaveProperty(key);
  expect(store.show(old.id)).toEqual(oldEvent.entry);
  expect(renderCardText(store.show(old.id))).toContain('교차 확인 없음(미기재)');
  store.decide(old.id, 'a', { kind: 'human' });
  expect(readFileSync(store.path, 'utf8').split('\n')[1]).toBe(line);
  expect(() => store.raise({ ...base, alternative: 'b' })).toThrow('alternative must differ');
  expect(() => store.raise({ ...base, alternative: 'z' })).toThrow('alternative option not found');
  expect(() => store.raise({ ...base, crossCheck: [{ seat: 'XX', at: '2026-10-01T00:00:00Z', note: '확인' }] })).toThrow('invalid cross-check seat');
});

test('raised-crosscheck observation records seats and skipped reason without the memo', () => {
  const store = ledger();
  const logs: unknown[][] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
  try {
    const checked = store.raise({ ...base, crossCheck: [{ seat: 'TC', at: '2026-10-01T00:00:00Z', note: 'private review' }] });
    const skipped = store.raise({ ...base, crossCheckSkipped: '자리 루프' });
    expect(logs.filter(row => row[0] === 'decisions' && row[1] === 'raised-crosscheck')).toEqual([
      ['decisions', 'raised-crosscheck', { id: checked.id, seats: 1, skipped: null }],
      ['decisions', 'raised-crosscheck', { id: skipped.id, seats: 0, skipped: '자리 루프' }],
    ]);
    expect(JSON.stringify(logs)).not.toContain('private review');
  } finally { spy.mockRestore(); }
});

test('raiseOnce atomically reuses the same growth source even after a human decision', () => {
  const store = ledger();
  const ref = 'graph-growth:same-proposal';
  const first = store.raiseOnce({ ...base, refs: [ref] }, ref);
  expect(store.raiseOnce({ ...base, refs: [ref] }, ref).id).toBe(first.id);
  store.decide(first.id, 'a', { kind: 'human' });
  expect(store.raiseOnce({ ...base, refs: [ref] }, ref).id).toBe(first.id);
  expect(store.list({ status: 'all' })).toHaveLength(1);
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(() => store.raiseOnce(base, ref)).toThrow('decision source reference required');
});

test('raise, open listing, human decision, chronological versions and append-only events', () => {
  const store = ledger();
  const raised = store.raise({ ...base, raisedAt: '2026-09-30T02:00:00Z' });
  expect(raised.id).toBe('D-20260930-01');
  expect(store.list()).toHaveLength(1);
  const decided = store.decide(raised.id, 'a', { kind: 'human' });
  expect(store.list()).toHaveLength(0);
  expect(decided.decidedAt).toBe('2026-10-01T01:00:00.000Z');
  expect(decided.decidedBy).toEqual({ kind: 'human' });
  expect(decided.versionAtDecision?.dev).toBe('0.2.6-dev.0');
  expect(store.list({ status: 'decided', version: '지니의 소원', decidedBy: 'human' })).toHaveLength(1);
  expect(store.list({ status: 'all', version: '0.2.6' })).toHaveLength(1);
  expect(store.list({ status: 'all', category: 'money' })).toHaveLength(0);
  expect(store.list({ status: 'all', since: '2026-10-01' })).toHaveLength(0);
  expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string }).map(e => e.type)).toEqual(['raised', 'decided']);
  expect(() => store.withdraw(raised.id, 'late')).toThrow('already closed');
});

test('resume target persists, rejects path-like question IDs, and leaves legacy entries readable', () => {
  const store = ledger();
  const legacy = store.raise(base);
  const legacyLine = readFileSync(store.path, 'utf8').trim();
  expect(JSON.parse(legacyLine).entry).not.toHaveProperty('resume');
  const raised = store.raise({ ...base, resume: { questionId: 'auq:mk8f00:abc12', runId: 'run-1' } });
  expect(raised.resume).toEqual({ questionId: 'auq:mk8f00:abc12', runId: 'run-1' });
  expect(store.raise({ ...base, resume: { questionId: 'execution:run-1:00000000-0000-4000-8000-000000000001', runId: 'run-1' } }).resume?.runId).toBe('run-1');
  expect(store.show(raised.id).resume).toEqual(raised.resume);
  expect(store.show(legacy.id).resume).toBeUndefined();
  const reopened = ledger(join(store.path, '..', '..'));
  expect(reopened.show(legacy.id).resume).toBeUndefined();
  expect(reopened.show(raised.id).resume).toEqual(raised.resume);
  const withoutRun = store.raise({ ...base, resume: { questionId: 'auq:abc:xyz09' } });
  expect(reopened.show(withoutRun.id).resume).toEqual({ questionId: 'auq:abc:xyz09' });
  for (const questionId of ['../escape', 'auq:../escape:abc12', 'auq:abc/def:abc12', 'auq:abc\\def:abc12', 'auq:abc:def12/..', 'auq:abc:xyz0!', 'auq:abc:xyz09\n', '']) {
    expect(() => store.raise({ ...base, resume: { questionId } })).toThrow('invalid resume questionId');
  }
  expect(store.list({ status: 'all' })).toHaveLength(4);
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(4);
});

test('AUTO requires delegation; invalid SCQA, one option and skipped recommendation require rejection', () => {
  const store = ledger();
  const entry = store.raise(base);
  expect(() => store.decide(entry.id, 'a', { kind: 'auto', agent: 'codex', delegation: '' })).toThrow('delegation');
  expect(() => store.decide(entry.id, 'x', { kind: 'human' })).toThrow('option not found');
  const auto = store.decide(entry.id, 'b', { kind: 'auto', agent: 'codex', delegation: '대표 S 위임' });
  expect(auto.decidedBy).toEqual({ kind: 'auto', agent: 'codex', delegation: '대표 S 위임' });
  expect(() => store.raise({ ...base, scqa: { ...base.scqa, s: 'x'.repeat(241) } })).toThrow('SCQA s');
  expect(() => store.raise({ ...base, scqa: { ...base.scqa, q: base.scqa.c } })).toThrow('repeats C');
  expect(() => store.raise({ ...base, options: base.options.slice(0, 1) })).toThrow('two options');
  expect(() => store.raise({ ...base, options: [] })).toThrow('two options');
  expect(() => store.raise({ ...base, recommendation: { skipped: true, reason: ' ' } })).toThrow('skip reason');
  expect(store.list({ status: 'all' })).toHaveLength(1);
});

test('a decision without an explicit actor cannot be recorded or shown as human', () => {
  const store = ledger();
  const entry = store.raise(base);
  const callWithoutActor = store.decide.bind(store) as (id: string, choice: string) => unknown;
  expect(() => callWithoutActor(entry.id, 'a')).toThrow('decidedBy is required');
  expect(store.show(entry.id).status).toBe('open');
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(formatDecisionDetail({ ...entry, status: 'decided', decidedBy: undefined })).toContain('주체 미상');
  expect(store.decide(entry.id, 'a', { kind: 'human' }).decidedBy).toEqual({ kind: 'human' });
});

test('invalid UTC calendar dates never reach the ledger or version resolver', () => {
  const calls: string[] = [];
  const stateDir = root();
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: at => {
    calls.push(at);
    return versions(at);
  } });
  for (const invalid of ['2026-02-29T02:00:00Z', '2026-04-31T02:00:00Z', '2026-13-01T02:00:00Z', '2026-09-30T24:00:00Z']) {
    expect(() => store.raise({ ...base, raisedAt: invalid })).toThrow('UTC timestamp required');
  }
  expect(calls).toEqual([]);
  const entry = store.raise({ ...base, raisedAt: '2024-02-29T02:00:00.123Z' });
  expect(entry.raisedAt).toBe('2024-02-29T02:00:00.123Z');
  for (const invalid of ['2026-02-29T02:00:00Z', '2026-04-31T02:00:00Z', '2026-09-30T24:00:00Z']) {
    expect(() => store.decide(entry.id, 'a', { kind: 'human' }, undefined, invalid)).toThrow('UTC timestamp required');
  }
  expect(calls).toEqual(['2024-02-29T02:00:00.123Z']);
  expect(store.show(entry.id).status).toBe('open');
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('secrets redacted before storage and withdrawal retains history', () => {
  const store = ledger();
  const item = store.raise({ ...base, title: 'Token sk-test-1234567890123456789012345678' });
  expect(readFileSync(store.path, 'utf8')).not.toContain('sk-test-1234567890123456789012345678');
  const closed = store.withdraw(item.id, 'No longer needed');
  expect(closed.history.map(h => h.type)).toEqual(['raised', 'withdrawn']);
  expect(store.list({ status: 'all' })[0]?.status).toBe('withdrawn');
});

test('version filter uses actual release ledger and origin/main git snapshot via directive resolver', () => {
  const stateDir = root();
  const repoRoot = join(stateDir, 'repo'); mkdirSync(repoRoot);
  const releaseRoot = join(stateDir, 'release'); mkdirSync(join(releaseRoot, '0.2.4'), { recursive: true });
  writeFileSync(join(releaseRoot, '0.2.4', 'release.json'), JSON.stringify({ version: '0.2.4', publishedAt: '2026-09-29T00:00:00Z' }));
  const git = (args: string[], date?: string) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '0.2.5-dev.0' }));
  git(['add', 'package.json']); git(['commit', '-qm', 'first'], '2026-09-28T00:00:00Z');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], '2026-09-30T00:00:00Z');
  const store = new DecisionLedger({ stateDir, releaseRoot, repoRoot, codenames: { '0.2.5': '지니의 소원' }, now: () => new Date('2026-09-30T01:00:00Z') });
  const expected = createVersionResolver({ releaseRoot, repoRoot, codenames: { '0.2.5': '지니의 소원' } })('2026-09-30T01:00:00.000Z');
  expect(store.raise(base).version).toEqual(expected);
  expect(store.list({ version: '지니의 소원' })).toHaveLength(1);
  expect(store.list({ version: '0.2.4' })).toHaveLength(1);
  expect(store.list({ version: '0.2.6' })).toHaveLength(0);
});

test('two separate processes raise concurrently without ID collision', () => {
  const stateDir = root();
  const modulePath = join(process.cwd(), 'src/decisions/decision-ledger.ts');
  const code = `import { DecisionLedger } from ${JSON.stringify(modulePath)}; new DecisionLedger({stateDir: ${JSON.stringify(stateDir)}, releaseRoot: '/nonexistent', repoRoot: '/nonexistent'}).raise(${JSON.stringify(base)});`;
  const children = [Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' }), Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' })];
  return Promise.all(children.map(c => c.exited)).then(codes => {
    expect(codes).toEqual([0, 0]);
    const ids = new DecisionLedger({ stateDir, releaseRoot: '/nonexistent', repoRoot: '/nonexistent' }).list().map(e => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

test('historical Markdown imports recorded D/E decisions with unknown alternatives; C4 retains unknown decision time', () => {
  const store = ledger();
  const result = importDecisionMarkdown(store, 'docs/DECISIONS-for-ceo-pending-2026-09-30.md');
  expect(result.imported).toEqual(['A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'D3', 'D4', 'D5', 'E1', 'E2', 'E3', 'E4']);
  expect(result.unread).toEqual([]);
  expect(result.incomplete).toHaveLength(19);
  const entries = store.list({ status: 'all' });
  expect(entries).toHaveLength(23);
  expect(entries.filter(e => e.status === 'open')).toHaveLength(13);
  expect(entries.filter(e => e.status === 'decided')).toHaveLength(10);
  expect(entries.filter(e => e.options.length === 0)).toHaveLength(19);
  expect(entries.every(e => e.raisedAt === undefined && e.version === undefined && e.importedAt === '2026-10-01T01:00:00.000Z')).toBe(true);
  expect(entries.every(e => e.raisedBy.agent === 'unknown')).toBe(true);
  expect(entries.filter(e => e.decidedBy?.kind === 'auto').every(e => e.decidedBy?.kind === 'auto' && e.decidedBy.agent === 'unknown')).toBe(true);
  expect(formatDecisionDetail(entries[0]!)).toContain('올림: 시각 미상');
  expect(formatDecisionDetail(entries[0]!)).toContain('가져옴:');
  for (const code of ['A1', 'A2', 'B2', 'B3', 'B4', 'B5', 'C3', 'C5', 'C6', 'C7']) {
    const item = entries.find(e => e.refs?.some(r => r.endsWith(`#${code}`)))!;
    expect(item.status).toBe('open');
    expect(item.options).toEqual([]);
  }
  expect(entries.filter(e => e.decidedBy?.kind === 'auto')).toHaveLength(5);
  expect(entries.filter(e => e.decidedBy?.kind === 'human')).toHaveLength(5);
  for (const code of ['D1', 'D2', 'D3', 'D4', 'D5', 'E1', 'E2', 'E3', 'E4']) {
    const item = entries.find(e => e.refs?.some(r => r.endsWith(`#${code}`)))!;
    expect(item.options).toEqual([]);
    expect(item.choice).toBeUndefined();
    expect(formatDecisionDetail(item)).toContain('선택 키 미상');
    expect(formatDecisionDetail(item)).toContain('원문에 선택지 없음');
    expect(item.decidedAt).toBeUndefined();
    expect(item.versionAtDecision).toBeUndefined();
  }
  const c4 = entries.find(e => e.refs?.some(r => r.endsWith('#C4')))!;
  expect(c4.choice).toBe('b');
  expect(entries.find(e => e.refs?.some(r => r.endsWith('#A1')))?.recommendation).toMatchObject({ skipped: true });
  expect(entries.find(e => e.refs?.some(r => r.endsWith('#D3')))?.decidedBy).toMatchObject({ kind: 'auto', delegation: '대표 09-30 01:4x 결정사항 S 에게' });
  expect(c4.decidedBy).toEqual({ kind: 'human' });
  expect(c4.decidedAt).toBeUndefined();
  expect(c4.versionAtDecision).toBeUndefined();
  expect(c4.history[1]?.at).toBeUndefined();
  expect(formatDecisionDetail(c4)).toContain('결정: 시각 미상');
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(33);
  const c4Events = readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; id?: string; at?: string; by?: unknown; choice?: string; note?: string });
  expect(c4Events.filter(event => event.id === c4.id)).toEqual([{ type: 'decided', id: c4.id, by: { kind: 'human' }, choice: 'b', note: c4.note }]);
  const rerun = importDecisionMarkdown(store, 'docs/DECISIONS-for-ceo-pending-2026-09-30.md');
  expect(rerun.existing).toEqual(result.imported);
  expect(rerun.unread).toEqual(result.unread);
  expect(rerun.incomplete).toHaveLength(19);
});

test('two importers race on the same historical source and only one records it', async () => {
  const stateDir = root();
  const modulePath = join(process.cwd(), 'src/decisions/decision-ledger.ts');
  const code = `import { DecisionLedger, importDecisionMarkdown } from ${JSON.stringify(modulePath)}; const store = new DecisionLedger({stateDir: ${JSON.stringify(stateDir)}, releaseRoot: '/nonexistent', repoRoot: '/nonexistent'}); console.log(JSON.stringify(importDecisionMarkdown(store, 'docs/DECISIONS-for-ceo-pending-2026-09-30.md')));`;
  const children = [Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' }), Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' })];
  const results = await Promise.all(children.map(async child => ({ status: await child.exited, text: await new Response(child.stdout).text() })));
  expect(results.map(r => r.status)).toEqual([0, 0]);
  expect(new DecisionLedger({ stateDir }).list({ status: 'all' })).toHaveLength(23);
  expect(results.flatMap(r => JSON.parse(r.text.trim()).unread)).toEqual([]);
  expect(results.reduce((sum, r) => sum + JSON.parse(r.text.trim()).imported.length, 0)).toBe(23);
});

test('historical pending with unknown options cannot be decided through ordinary CLI/API choice', () => {
  const store = ledger();
  const pending = store.importPending({ ...base, options: [], recommendation: { skipped: true, reason: '원문에 권고 없음' }, refs: ['historical#pending'] });
  expect(pending.options).toEqual([]);
  expect(() => store.decide(pending.id, 'a', { kind: 'human' })).toThrow('option not found');
  expect(store.show(pending.id).status).toBe('open');
  store.addOptions(pending.id, base.options, 'codex');
  expect(store.decide(pending.id, 'b', { kind: 'human' }).choice).toBe('b');
  expect(store.show(pending.id).history.map(h => h.type)).toEqual(['raised', 'options-added', 'decided']);
  expect(() => store.addOptions(pending.id, base.options, 'codex')).toThrow('decision closed');
});

test('recorded import validates the choice before append; retry succeeds as one raised/decided pair', () => {
  const store = ledger();
  const input = { ...base, refs: ['historical#X1'] };
  expect(() => store.importRecorded(input, 'missing', { kind: 'human' }, 'source')).toThrow('option not found');
  expect(store.list({ status: 'all' })).toHaveLength(0);
  const entry = store.importRecorded(input, 'b', { kind: 'human' }, 'source');
  expect(entry.status).toBe('decided');
  expect(entry.decidedAt).toBeUndefined();
  expect(store.list({ status: 'all' })).toHaveLength(1);
  expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'decided']);
});

test('the same source imported by relative and absolute path is one set of decisions (must-fix #22166 r3)', () => {
  const store = ledger();
  const rel = 'docs/DECISIONS-for-ceo-pending-2026-09-30.md';
  const first = importDecisionMarkdown(store, rel);
  const count = store.list({ status: 'all' }).length;
  const second = importDecisionMarkdown(store, resolve(rel));
  expect(first.imported.length).toBeGreaterThan(0);
  expect(second.imported).toEqual([]);
  expect(store.list({ status: 'all' })).toHaveLength(count);
});

test('imported SCQA comes from the source text, never from the import itself (must-fix #22166 r3)', () => {
  const store = ledger();
  importDecisionMarkdown(store, 'docs/DECISIONS-for-ceo-pending-2026-09-30.md');
  const all = store.list({ status: 'all' });
  expect(all.length).toBeGreaterThan(0);
  for (const e of all) {
    expect(e.scqa.c).not.toContain('원문에서 가져옴');
    expect(e.scqa.a ?? '').not.toBe('원문에 결정 기록 있음');
  }
});

test('incomplete historical item is reported when its options differ from source, never silently skipped', () => {
  const store = ledger();
  store.raise({ ...base, refs: [`${realpathSync(resolve('docs/DECISIONS-for-ceo-pending-2026-09-30.md'))}#C4`] });
  const result = importDecisionMarkdown(store, 'docs/DECISIONS-for-ceo-pending-2026-09-30.md');
  expect(result.existing).not.toContain('C4');
  expect(result.unread).toContain('C4: previously imported options differ from source');
});

test('incomplete historical item with source options is resumed without inventing a decision time', () => {
  const store = ledger();
  const source = 'docs/DECISIONS-for-ceo-pending-2026-09-30.md';
  const probe = ledger();
  importDecisionMarkdown(probe, source);
  const sourceRef = `${realpathSync(resolve(source))}#C4`;
  const original = probe.list({ status: 'all' }).find(e => e.refs?.includes(sourceRef))!;
  const pending = store.raise({ ...base, options: original.options, refs: [sourceRef] });
  const result = importDecisionMarkdown(store, source);
  expect(result.existing).toContain('C4');
  expect(result.unread.some(row => row.startsWith('C4:'))).toBe(false);
  expect(store.show(pending.id).choice).toBe('b');
  expect(store.show(pending.id).decidedAt).toBeUndefined();
  expect(importDecisionMarkdown(store, source).existing).toContain('C4');
});

test('resume target writes the selected key and label for the waiting question once, with safe observation', () => {
  const stateDir = root();
  const calls: Parameters<typeof writePendingQuestionAnswer>[0][] = [];
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
    writeAnswer: (answer, deps) => { calls.push(answer); expect(deps?.root?.()).toBe(stateDir); } });
  const logs: unknown[][] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
  try {
    writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.', options: [
      { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
    ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
    const raised = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde', runId: 'run-x' } });
    expect(store.show(raised.id).resume).toEqual({ questionId: 'auq:q1:abcde', runId: 'run-x' });
    const decided = store.decide(raised.id, 'a', { kind: 'human' }, 'Private memo');
    expect(decided.status).toBe('decided');
    expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { scope_choice: 'a) Publish' }, otherText: { scope_choice: 'Private memo' } } }]);
    expect(logs.filter(line => line[0] === 'hitl.card-bridge')).toEqual([['hitl.card-bridge', 'answered',
      { decisionId: raised.id, questionId: 'auq:q1:abcde', runId: 'run-x', via: 'human' }]]);
    expect(JSON.stringify(logs)).not.toContain('Private memo');
    expect(JSON.stringify(logs)).not.toContain('Publish');
  } finally { spy.mockRestore(); }
});

test('execution answer uses the option label required by the waiting harness run', () => {
  const stateDir = root();
  const id = 'execution:run-x:00000000-0000-4000-8000-000000000001';
  writePendingQuestion(createPendingQuestion(id, { runId: 'run-x', questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.',
    options: [{ label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' }] }] }, undefined, {},
  { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const store = ledger(stateDir);
  const entry = store.raise({ ...base, resume: { questionId: id, runId: 'run-x' } });
  expect(store.decideWithDelivery(entry.id, 'b', { kind: 'human' }).delivery).toEqual({ ok: true, questionId: id });
  expect(readPendingQuestionAnswer(id, { root: () => stateDir })).toEqual({ ok: true, answer: {
    id, result: { answers: { scope_choice: 'Hold' } },
  } });
});

test('a decision cannot deliver to another run or after the pending deadline', () => {
  const stateDir = root();
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions });
  const id = 'auq:abc:12345';
  const request: AskUserQuestionRequest = { runId: 'other-run', questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.',
    options: [{ label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' }] }] };
  writePendingQuestion(createPendingQuestion(id, request, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2026-10-01T01:01:00.000Z' }), { root: () => stateDir });
  const entry = store.raise({ ...base, resume: { questionId: id, runId: 'my-run' } });
  expect(store.decideWithDelivery(entry.id, 'b', { kind: 'human' }).delivery).toMatchObject({ ok: false, reason: 'pending question run differs from decision' });
  expect(readPendingQuestionAnswer(id, { root: () => stateDir })).toEqual({ ok: true, answer: null });
  writePendingQuestion(createPendingQuestion(id, { ...request, runId: 'my-run' }, undefined, {},
    { surface: 'file', delivery: 'file', expiresAt: '2026-10-01T00:59:00.000Z' }), { root: () => stateDir });
  expect(() => store.retryAnswer(entry.id)).toThrow('answer delivery failed');
  expect(readPendingQuestionAnswer(id, { root: () => stateDir })).toEqual({ ok: true, answer: null });
});

test('default answer writer stores a resolver-readable answer under the pending question id', () => {
  const stateDir = root();
  const request: AskUserQuestionRequest = { questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.',
    options: [{ label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' }] }] };
  writePendingQuestion(createPendingQuestion('auq:abc:12345', request, undefined, {},
    { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const store = ledger(stateDir);
  const raised = store.raise({ ...base, resume: { questionId: 'auq:abc:12345' } });
  store.decide(raised.id, 'b', { kind: 'auto', agent: 'codex', delegation: 'owner' });
  expect(readPendingQuestionAnswer('auq:abc:12345', { root: () => stateDir })).toEqual({ ok: true, answer: {
    id: 'auq:abc:12345', result: { answers: { scope_choice: 'b) Hold' } },
  } });
});

test('missing pending target records a failure, never writes a fabricated answer key', () => {
  const stateDir = root();
  const calls: unknown[] = [];
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
    writeAnswer: answer => { calls.push(answer); } });
  const logs: unknown[][] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
  try {
    const entry = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde' } });
    expect(store.decide(entry.id, 'a', { kind: 'human' }).status).toBe('decided');
    expect(store.show(entry.id).status).toBe('decided');
    expect(calls).toEqual([]);
    expect(logs.filter(line => line[0] === 'hitl.card-bridge')).toEqual([['hitl.card-bridge', 'answer-write-failed',
      { decisionId: entry.id, questionId: 'auq:q1:abcde', reason: 'Error' }]]);
    expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'decided']);
    writePendingQuestion(createPendingQuestion('other-q', { questions: [{ id: 'actual_key', header: 'Scope', question: 'Choose.', options: [
      { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
    ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
    const second = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde' } });
    expect(store.decide(second.id, 'b', { kind: 'human' }).status).toBe('decided');
    expect(calls).toEqual([]);
    writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'actual_key', header: 'Scope', question: 'Choose.', options: [
      { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
    ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
    expect(store.retryAnswer(second.id).choice).toBe('b');
    expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { actual_key: 'b) Hold' } } }]);
    expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'decided', 'raised', 'decided']);
    expect(logs.filter(line => line[0] === 'hitl.card-bridge').map(line => line[1])).toEqual(['answer-write-failed', 'answer-write-failed', 'answered']);
  } finally { spy.mockRestore(); }
});

test('answer delivery rejects reordered, re-keyed and changed-label pending options before writing', () => {
  for (const { options, cardOptions } of [
    { options: [{ label: 'Hold', description: 'Later' }, { label: 'Publish', description: 'Now' }], cardOptions: base.options },
    { options: [{ label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' }], cardOptions: [base.options[1]!, base.options[0]!] },
    { options: [{ label: 'Hold', description: 'Now' }, { label: 'Hold', description: 'Later' }], cardOptions: base.options },
    { options: [{ label: 'Publish', description: 'Now' }, { label: 'Wait', description: 'Later' }], cardOptions: base.options },
  ]) {
    const stateDir = root();
    const calls: unknown[] = [];
    const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
      writeAnswer: answer => { calls.push(answer); } });
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
    try {
      writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'choice', header: 'Scope', question: 'Choose.', options }] },
        undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
      const entry = store.raise({ ...base, options: cardOptions, resume: { questionId: 'auq:q1:abcde' } });
      expect(store.decide(entry.id, 'a', { kind: 'human' }).status).toBe('decided');
      expect(store.show(entry.id).status).toBe('decided');
      expect(calls).toEqual([]);
      expect(readPendingQuestionAnswer('auq:q1:abcde', { root: () => stateDir })).toEqual({ ok: true, answer: null });
      expect(logs.filter(line => line[0] === 'hitl.card-bridge')).toEqual([['hitl.card-bridge', 'answer-write-failed',
        { decisionId: entry.id, questionId: 'auq:q1:abcde', reason: 'Error' }]]);
      writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'choice', header: 'Scope', question: 'Choose.',
        options: cardOptions.map(option => ({ label: option.label, description: option.consequence })),
      }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
      if (cardOptions[0]!.key !== 'a') {
        expect(() => store.retryAnswer(entry.id)).toThrow('answer delivery failed');
        expect(calls).toEqual([]);
      } else {
        store.retryAnswer(entry.id);
        expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { choice: `a) ${cardOptions[0]!.label}` } } }]);
      }
    } finally { spy.mockRestore(); }
  }
});

test('no resume writes nothing; answer writer failure does not roll back decided event', () => {
  const stateDir = root();
  const calls: string[] = [];
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
    writeAnswer: answer => { calls.push(answer.id); throw new Error('disk unavailable'); } });
  const logs: unknown[][] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
  try {
    store.decide(store.raise(base).id, 'a', { kind: 'human' });
    expect(calls).toEqual([]);
    writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'choice', header: 'Scope', question: 'Choose.', options: [
      { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
    ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
    const entry = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde' } });
    expect(store.decide(entry.id, 'b', { kind: 'auto', agent: 'codex', delegation: 'owner' }).status).toBe('decided');
    expect(calls).toEqual(['auq:q1:abcde']);
    expect(() => store.retryAnswer(entry.id)).toThrow('answer delivery failed');
    expect(calls).toEqual(['auq:q1:abcde', 'auq:q1:abcde']);
    expect(store.show(entry.id).status).toBe('decided');
    expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'decided', 'raised', 'decided']);
    expect(logs.filter(line => line[0] === 'hitl.card-bridge')).toEqual(Array(2).fill(null).map(() => ['hitl.card-bridge', 'answer-write-failed',
      { decisionId: entry.id, questionId: 'auq:q1:abcde', reason: 'Error' }]));
  } finally { spy.mockRestore(); }
});

test('transient writer failure is visible, retry uses the durable original choice, actor and memo without another event', () => {
  const stateDir = root();
  let available = false;
  const calls: unknown[] = [];
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
    writeAnswer: (answer, deps) => { if (!available) throw new Error('disk unavailable'); calls.push(answer); writePendingQuestionAnswer(answer, deps); } });
  writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'choice', header: 'Scope', question: 'Choose.', options: [
    { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
  ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const entry = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde' } });
  expect(store.decide(entry.id, 'b', { kind: 'auto', agent: 'codex', delegation: 'owner' }, 'Use later').status).toBe('decided');
  expect(store.show(entry.id)).toMatchObject({ status: 'decided', choice: 'b', note: 'Use later', decidedBy: { kind: 'auto' } });
  available = true;
  expect(store.retryAnswer(entry.id).status).toBe('decided');
  expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { choice: 'b) Hold' }, otherText: { choice: 'Use later' } } }]);
  expect(store.retryAnswer(entry.id).status).toBe('decided');
  expect(calls).toHaveLength(1);
  expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'decided']);
  expect(() => store.retryAnswer('missing')).toThrow('decision not found');
  expect(() => store.retryAnswer(store.raise(base).id)).toThrow('no recorded resume answer');
});

test('writer error cannot put the option label or memo text into failure observation', () => {
  const stateDir = root();
  const store = new DecisionLedger({ stateDir, now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions,
    writeAnswer: () => { throw new Error('could not write Publish / Private memo'); } });
  const logs: unknown[][] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
  try {
    writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'choice', header: 'Scope', question: 'Choose.', options: [
      { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
    ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
    const entry = store.raise({ ...base, resume: { questionId: 'auq:q1:abcde' } });
    expect(store.decide(entry.id, 'a', { kind: 'human' }, 'Private memo').status).toBe('decided');
    expect(store.show(entry.id).status).toBe('decided');
    expect(logs.filter(line => line[0] === 'hitl.card-bridge')).toEqual([['hitl.card-bridge', 'answer-write-failed',
      { decisionId: entry.id, questionId: 'auq:q1:abcde', reason: 'Error' }]]);
    expect(JSON.stringify(logs)).not.toContain('Private memo');
    expect(JSON.stringify(logs)).not.toContain('Publish');
  } finally { spy.mockRestore(); }
});

test('legacy raised events without resume still list and decide; unsafe question ids are rejected', () => {
  const store = ledger();
  const raised = store.raise(base);
  expect(JSON.parse(readFileSync(store.path, 'utf8').split('\n')[0]!).entry).not.toHaveProperty('resume');
  const reopened = new DecisionLedger({ stateDir: join(store.path, '..', '..'), now: () => new Date('2026-10-01T01:00:00Z'), resolveVersion: versions });
  expect(reopened.list()).toHaveLength(1);
  expect(reopened.decide(raised.id, 'a', { kind: 'human' }).status).toBe('decided');
  for (const questionId of ['../x', 'x/y', 'x\\y', '..', '', 'a%2Fb']) {
    expect(() => store.raise({ ...base, resume: { questionId } })).toThrow('invalid resume questionId');
  }
  expect(store.list({ status: 'all' })).toHaveLength(1);
});

test('delegated seat decisions are durable posthoc ledger rows, never owner decision cards', () => {
  const stateDir = root();
  const store = ledger(stateDir);
  const card = store.raise(base);
  const first = store.recordSeatDecision({ seat: 'OP', title: '예산 막힘', decision: '크레딧으로 풀기', delegation: '운영 예산 위임',
    decidedAt: '2026-09-30T23:00:00Z', refs: ['coord#123'] });
  const second = store.recordSeatDecision({ seat: 'TC', title: '발사 경로', decision: '임시 발사 경로 변경', delegation: '기술 운영 위임' });
  expect(first).toMatchObject({ id: 'SD-20261001-01', seat: 'OP', decision: '크레딧으로 풀기', reporting: 'posthoc',
    recordedAt: '2026-10-01T01:00:00.000Z', decidedAt: '2026-09-30T23:00:00.000Z', versionAtDecision: versions('2026-09-30'), refs: ['coord#123'] });
  expect(second.id).toBe('SD-20261001-02');
  expect(second.recordedAt).toBe('2026-10-01T01:00:00.000Z');
  expect(second.decidedAt).toBeUndefined();
  expect(second.versionAtDecision).toBeUndefined();
  expect(new DecisionLedger({ stateDir }).seatReport()).toEqual([first, second]);
  expect(store.seatReport({ since: '2026-10-01T00:00:00Z' })).toEqual([first, second]);
  expect(store.seatReport({ seat: 'OP' })).toEqual([first]);
  expect(store.seatReport({ since: '2026-10-01T02:00:00Z' })).toEqual([]);
  const persisted = readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(persisted[1].entry).toEqual(first);
  expect(persisted[2].entry).toEqual(second);
  expect(persisted[2].entry).not.toHaveProperty('decidedAt');
  expect(persisted[2].entry).not.toHaveProperty('versionAtDecision');
  expect(store.list()).toEqual([card]);
  expect(store.list({ status: 'all' })).toEqual([card]);
  expect(() => store.show(first.id)).toThrow('decision not found');
  expect(() => store.decide(first.id, 'a', { kind: 'human' })).toThrow('decision not found');
  expect(readFileSync(store.path, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['raised', 'seat-recorded', 'seat-recorded']);
  expect(store.raise(base).id).toBe('D-20261001-02');
});

test('seat reporting rejects ungrounded identity and empty delegation without appending; source is idempotency guard', () => {
  const store = ledger();
  const input = { seat: 'MK' as const, title: '루프 담당표', decision: '담당표 적용', delegation: '자리 위임', refs: ['coord#456'] };
  const first = store.recordSeatDecision(input);
  for (const invalid of [
    { ...input, seat: 'S' as never }, { ...input, delegation: ' ' }, { ...input, decision: '\n' },
    { ...input, decidedAt: '2026-02-29T00:00:00Z' },
  ]) expect(() => store.recordSeatDecision(invalid)).toThrow();
  expect(() => store.recordSeatDecision(input)).toThrow('source already recorded');
  expect(() => store.seatReport({ seat: 'S' as never })).toThrow('invalid seat');
  expect(store.seatReport()).toEqual([first]);
  expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(store.recordSeatDecision({ ...input, refs: ['coord#457'] }).id).toBe('SD-20261001-02');
  expect(store.recordSeatDecision({ ...input, title: '발사 경로', decision: '임시 경로 전환' }).id).toBe('SD-20261001-03');
});

test('raise and auto-decide accept seat names (OP·MK·TC·UX) as track while old letters keep working', () => {
  const store = ledger();
  const bySeat = store.raise({ ...base, raisedBy: { agent: 'claude', track: 'OP' } });
  expect(bySeat.raisedBy.track).toBe('OP');
  const decided = store.decide(bySeat.id, 'b', { kind: 'auto', agent: 'claude', track: 'TC', delegation: 'seat delegation' });
  expect(decided.decidedBy).toEqual({ kind: 'auto', agent: 'claude', track: 'TC', delegation: 'seat delegation' });
  expect(store.raise({ ...base, raisedBy: { agent: 'codex', track: 'S' } }).raisedBy.track).toBe('S');
  expect(() => store.raise({ ...base, raisedBy: { agent: 'codex', track: 'XX' as never } })).toThrow('invalid track');
});
