import { setDefaultTimeout, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const version = '0.2.7';
const base = '# 0.2.7\n\n## Behavior changes\n\n- A useful change.\n';
const fallback = 'Known issues have been reported for this release.';
const response = (rows: Array<[string, string]>) => JSON.stringify(rows.map(([id, bullet]) => ({ id, bullet })));
const normalReply = response([['K13', 'An export may take longer; retry if it times out.'], ['R1', 'Some settings do not persist; save them again.']]);

function fixture(releaseVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'release-known-issues-'));
  const remote = join(root, 'remote.git');
  const tree = join(root, 'tree');
  const bin = join(root, 'bin');
  const notes = join(tree, 'release/public/docs/releases', `${releaseVersion}.md`);
  const calls = join(root, 'ask-calls');
  const git = (args: string[], cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  mkdirSync(bin);
  git(['init', '--bare', remote]);
  git(['clone', remote, tree]);
  git(['config', 'user.name', 'Fixture'], tree);
  git(['config', 'user.email', 'fixture@example.com'], tree);
  mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
  writeFileSync(notes, base);
  git(['add', '.'], tree);
  git(['commit', '-m', 'initial'], tree);
  git(['checkout', '-b', `release-docs/${releaseVersion}`], tree);
  git(['push', '-u', 'origin', `release-docs/${releaseVersion}`], tree);
  const fake = join(bin, 'elanous');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.KNOWN_ASK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.KNOWN_ASK_FAIL === '1') process.exit(3);
console.log(JSON.stringify({reply:process.env.KNOWN_ASK_REPLY}));
`);
  chmodSync(fake, 0o755);
  const invoke = (checklist: Array<{ id: string; title: string; evidence: string; knownIssue?: string }> = [], acceptedRegressions: Array<{ id: string; note: string }> = [], opts: { reply?: string; fail?: boolean; worktree?: string; outputs?: Record<string, Record<string, unknown>>; recordedWaiver?: { note: string } } = {}) => {
    const context = { input: { version: releaseVersion, previousVersion: '0.2.6', acceptedRegressions }, outputs: { 'checklist-gate': { knownIssues: checklist }, docs: { branch: `release-docs/${releaseVersion}`, worktree: opts.worktree ?? tree }, ...(opts.recordedWaiver ? { tui: { verdict: 'waived', reason: opts.recordedWaiver.note } } : {}), ...opts.outputs } };
    let contextValue = JSON.stringify(context);
    if (opts.recordedWaiver) {
      const statePath = join(root, 'graph-runs/release-loop/run-test.json');
      contextValue = `${statePath}.contexts/2.json`;
      mkdirSync(`${statePath}.contexts`, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ graphId: 'release-loop', runId: 'run-test', input: context.input,
        path: ['tui', 'known-issues'], nodes: [{ nodeId: 'tui', ok: true, executed: false, waiver: { reason: opts.recordedWaiver.note } }] }));
      writeFileSync(contextValue, JSON.stringify({ ...context, graphId: 'release-loop', runId: 'run-test', nodeId: 'known-issues' }));
    }
    const run = spawnSync('bun', [join(import.meta.dir, 'known-issues-node.ts')], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_CONTEXT: contextValue, ...(opts.recordedWaiver ? { ELANOUS_STATE_DIR: root } : {}), KNOWN_ASK_CALLS: calls,
        KNOWN_ASK_REPLY: opts.reply ?? normalReply, KNOWN_ASK_FAIL: opts.fail ? '1' : '0' },
    });
    return { code: run.status, result: JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { outcome: string; summary: string; count: number; bullets: string[]; sources: { checklist: number; accepted: number }; fallbackUsed: boolean } };
  };
  return { root, tree, remote, notes, calls, invoke, git };
}

const checklist = [{ id: 'K13', title: 'Export delay', evidence: 'timeout', knownIssue: 'Exports may time out.' }];
const accepted = [{ id: 'R1', note: 'Settings not persisted' }];

test('two sources become public English bullets in one ask and push only to the temporary bare remote', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke(checklist, accepted);
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 2, sources: { checklist: 1, accepted: 1 }, fallbackUsed: false });
    expect(result.bullets).toHaveLength(2);
    const text = readFileSync(f.notes, 'utf8');
    expect(text).toContain('## Known issues\n\nThe following issues are known in this release.\n\n- An export may take longer; retry if it times out.');
    expect(text).not.toContain('None of them affect installing or using Elanous.');
    expect(text).toContain('- Some settings do not persist; save them again.');
    const args = JSON.parse(readFileSync(f.calls, 'utf8').trim()) as string[];
    expect(args.slice(0, 3)).toEqual(['--test', 'ask', '--json']);
    expect(args[3]).toContain('K13');
    expect(args[3]).toContain('Settings not persisted');
    expect(args[3]).toContain('using each input ID exactly once');
    expect(f.git(['show', `release-docs/${version}:release/public/docs/releases/${version}.md`], f.remote)).toBe(text.trimEnd());
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('checklist public copy comes from knownIssue and missing knownIssue is omitted', () => {
  const f = fixture();
  try {
    const checklist = [
      { id: 'K13', title: 'INTERNAL TASK TITLE', evidence: 'private evidence', knownIssue: 'Exports may time out.' },
      { id: 'K14', title: 'ANOTHER INTERNAL TITLE', evidence: 'private evidence' },
    ];
    const reply = response([['K13', 'Exports may time out; retry the export.']]);
    const { code, result } = f.invoke(checklist, [], { reply });
    expect(code).toBe(0);
    expect(result).toMatchObject({ count: 1, sources: { checklist: 1, accepted: 0 } });
    expect(readFileSync(f.notes, 'utf8')).toContain('- Exports may time out; retry the export.');
    const prompt = JSON.parse(readFileSync(f.calls, 'utf8').trim()) as string[];
    expect(prompt[3]).toContain('Exports may time out.');
    expect(prompt[3]).not.toContain('INTERNAL TASK TITLE');
    expect(prompt[3]).not.toContain('ANOTHER INTERNAL TITLE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('generated notes filter internal PR references before writing the release notes', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.notes, 'utf8');
    const { code, result } = f.invoke([{ id: 'K13', title: 'Internal label', evidence: '', knownIssue: 'Exports may time out.' }], [], {
      reply: response([['K13', 'Exports may time out; see PR 12345 for details.']]),
    });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('PR 12345');
    expect(readFileSync(f.notes, 'utf8')).not.toBe(before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('47 accepted IDs sharing two notes need two distinct bullets and both note groups', () => {
  const f = fixture();
  try {
    const groups = [
      { count: 3, note: 'Dashboard updates do not appear', bullet: 'Dashboard updates do not appear until a refresh.' },
      { count: 44, note: 'Exports do not finish', bullet: 'Exports do not finish for some users.' },
    ];
    const regressions = groups.flatMap(({ count, note }, group) => Array.from({ length: count }, (_, index) => ({ id: `R${group}-${index}`, note })));
    const good = response(regressions.map(({ id, note }) => [id, groups.find((group) => group.note === note)!.bullet]));
    const pass = f.invoke([], regressions, { reply: good });
    expect(pass.code).toBe(0);
    expect(pass.result).toMatchObject({ outcome: 'ok', count: 2, sources: { accepted: 47 }, fallbackUsed: false });
    expect(pass.result.bullets).toEqual(groups.map((group) => group.bullet));
    expect(readFileSync(f.notes, 'utf8').match(/^- /gm)).toHaveLength(3); // existing behavior-change bullet plus two known issues
    const missing = response(regressions.map(({ id }) => [id, groups[0]!.bullet]));
    const fail = f.invoke([], regressions, { reply: missing });
    expect(fail.code).toBe(1);
    expect(fail.result.summary).toContain('coverage not verified');
    const split = response(regressions.map(({ id, note }, index) => [id,
      index === 0 ? 'Dashboard updates fail to appear until a refresh.' : groups.find((group) => group.note === note)!.bullet]));
    const splitFail = f.invoke([], regressions, { reply: split });
    expect(splitFail.code).toBe(1);
    expect(splitFail.result.summary).toContain('repeats or splits an issue');
    const mixedFallback = response(regressions.map(({ id, note }, index) => [id,
      index === 0 ? 'Fixed in #123.' : groups.find((group) => group.note === note)!.bullet]));
    const mixedFail = f.invoke([], regressions, { reply: mixedFallback });
    expect(mixedFail.code).toBe(1);
    expect(mixedFail.result.summary).toContain('repeats or splits an issue');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real Korean accepted-note groups with only a shared English label retain two safe public bullets', () => {
  const f = fixture();
  try {
    const groups = [
      { count: 3, note: 'KI-0233-REGRESSIONS · 0.2.33: 사용자 영향은 bot routine dry-run 루틴 사용 금지. 격리 시험은 검증되지 않았으며 0.2.34에서 복원·재검증한다.', bullet: 'The bot routine dry-run must not be used in this release.' },
      { count: 44, note: 'KI-0233-REGRESSIONS · 0.2.33: 이 경로의 검증 공백이다. 기능이 검증됐다고 간주하지 말고 0.2.34에서 수리·시험 복원 뒤 재검증한다.', bullet: 'Some paths have a verification gap; their behavior remains unverified.' },
    ];
    const regressions = groups.flatMap(({ count, note }, group) => Array.from({ length: count }, (_, index) => ({ id: `real-${group}-${index}`, note })));
    const good = response(regressions.map(({ id, note }) => [id, groups.find((group) => group.note === note)!.bullet]));
    const pass = f.invoke([], regressions, { reply: good });
    expect(pass.code).toBe(0);
    expect(pass.result).toMatchObject({ outcome: 'ok', count: 2, sources: { accepted: 47 }, fallbackUsed: false });
    expect(pass.result.bullets).toEqual(groups.map((group) => group.bullet));
    const collapsed = response(regressions.map(({ id }) => [id, groups[0]!.bullet]));
    expect(f.invoke([], regressions, { reply: collapsed }).result.summary).toContain('repeats or splits an issue');
    const unsafe = response(regressions.map(({ id, note }) => [id,
      note === groups[1]!.note ? 'See src/agent-mission/foo.test.ts.' : groups[0]!.bullet]));
    expect(f.invoke([], regressions, { reply: unsafe }).result).toMatchObject({ outcome: 'ok', count: 2, fallbackUsed: true });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('synthetic 48 IDs cannot borrow the approved note-group fallback', () => {
  const f = fixture();
  try {
    // The three source notes are copied from the 0.2.33 accepted-regressions ledger (3 + 44 + 1).
    const groups = [
      { count: 3, note: 'KI-0233-REGRESSIONS · 0.2.33: 사용자 영향은 bot routine dry-run 루틴 사용 금지. 격리 시험은 검증되지 않았으며 0.2.34에서 복원·재검증한다.',
        bullet: 'Bot routine dry runs must not be used until their isolated tests are verified.' },
      { count: 44, note: 'KI-0233-REGRESSIONS · 0.2.33: 이 경로의 검증 공백이다. 기능이 검증됐다고 간주하지 말고 0.2.34에서 수리·시험 복원 뒤 재검증한다.',
        bullet: 'These paths have a validation gap and remain unverified until their tests are restored.' },
      { count: 1, note: 'KI-0233-REGRESSIONS · 0.2.33: 옛 판 오프너 경보가 지연되거나 누락될 수 있다. 0.2.34에서 독립 fixture와 Linux Pod 실물 검증 후 복원한다.',
        bullet: 'Old version opener alerts may be delayed or missed until the fixture is verified.' },
    ];
    const accepted48 = groups.flatMap(({ count, note }, group) => Array.from({ length: count }, (_, index) => ({ id: `accepted-${group}-${index}`, note })));
    const answer = (choices: string[]) => response(accepted48.map(({ id, note }) => [id, choices[groups.findIndex((group) => group.note === note)]!]));
    const good = f.invoke([], accepted48, { reply: answer(groups.map((group) => group.bullet)) });
    expect(good.code).toBe(0);
    expect(good.result).toMatchObject({ outcome: 'ok', count: 3, sources: { accepted: 48 }, fallbackUsed: false });
    expect(good.result.bullets).toEqual(groups.map((group) => group.bullet));
    const noDistinctive = f.invoke([], accepted48, { reply: answer([
      groups[0]!.bullet, groups[1]!.bullet, 'Old version opener alerts may be delayed or missed.']) });
    expect(noDistinctive.code).toBe(1);
    expect(noDistinctive.result.summary).toContain('deterministic public bullet unavailable');
    const duplicate = f.invoke([], accepted48, { reply: answer([
      groups[0]!.bullet, groups[2]!.bullet, groups[2]!.bullet]) });
    expect(duplicate.code).toBe(1);
    expect(duplicate.result.summary).toContain('repeats or splits an issue');
    const resolved = f.invoke([], accepted48, { reply: answer([
      groups[0]!.bullet, groups[1]!.bullet, 'Old version opener alerts are resolved after the fixture is verified.']) });
    expect(resolved.code).toBe(1);
    expect(resolved.result.summary).toContain('deterministic public bullet unavailable');
    const oneBadId = response(accepted48.map(({ id, note }, index) => [id,
      index === 0 ? 'Bot routine dry runs were fixed in this release.' : groups.find((group) => group.note === note)!.bullet]));
    const wholeGroup = f.invoke([], accepted48, { reply: oneBadId });
    expect(wholeGroup.code).toBe(1);
    expect(wholeGroup.result.summary).toContain('deterministic public bullet unavailable');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('actual 0.2.33 accepted 48 replay preserves three note groups under two deliberate model failures', () => {
  const f = fixture('0.2.33');
  try {
    const accepted48 = JSON.parse(readFileSync(join(import.meta.dir, 'known-issues-0.2.33-approved.json'), 'utf8')) as Array<{ id: string; note: string }>;
    expect(accepted48).toHaveLength(48);
    expect(new Set(accepted48.map((issue) => issue.note)).size).toBe(3);
    const reply = response(accepted48.map(({ id, note }) => [id,
      note.includes('bot routine dry-run') ? 'Bot routine dry runs were fixed in this release.' :
      note.includes('옛 판 오프너 경보') ? 'Old version opener alerts may be delayed or missed.' :
      'Some paths remain unverified in this release.']));
    const { code, result } = f.invoke([], accepted48, { reply });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 3, sources: { accepted: 48 }, fallbackUsed: true });
    expect(result.bullets).toEqual([
      'Bot routine dry runs must not be used in this release.',
      'Some paths remain unverified in this release.',
      'Old version opener alerts may be delayed or missed in this release.',
    ]);
    expect(readFileSync(f.notes, 'utf8')).not.toContain('were fixed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('approved wording on a foreign ID or release cannot trigger the 0.2.33 fallback', () => {
  const accepted48 = JSON.parse(readFileSync(join(import.meta.dir, 'known-issues-0.2.33-approved.json'), 'utf8')) as Array<{ id: string; note: string }>;
  for (const [releaseVersion, regressions] of [
    ['0.2.33', accepted48.map((issue, index) => index === 0 ? { ...issue, id: 'foreign-bot-id' } : issue)],
    ['0.2.34', accepted48],
  ] as const) {
    const f = fixture(releaseVersion);
    try {
      const reply = response(regressions.map(({ id, note }) => [id,
        note.includes('bot routine dry-run') ? 'Bot routine dry runs were fixed in this release.' :
        note.includes('옛 판 오프너 경보') ? 'Old version opener alerts may be delayed or missed.' :
        'Some paths remain unverified in this release.']));
      const { code, result } = f.invoke([], regressions, { reply });
      expect(code).toBe(1);
      expect(result.summary).toContain('deterministic public bullet unavailable');
      expect(readFileSync(f.notes, 'utf8')).toBe(base);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('unknown Korean accepted note cannot be published under an unrelated generic fallback', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke([], [{ id: 'unknown', note: '결제 오류로 주문이 완료되지 않는다.' }], {
      reply: response([['unknown', 'The issue is resolved.']]),
    });
    expect(code).toBe(1);
    expect(result.summary).toContain('deterministic public bullet unavailable');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an unapproved note containing an approved keyword still fails closed', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke([], [{ id: 'other-gap', note: '새 결제 경로에 검증 공백이 있어 주문이 누락된다.' }], {
      reply: response([['other-gap', 'All payment issues are resolved.']]),
    });
    expect(code).toBe(1);
    expect(result.summary).toContain('deterministic public bullet unavailable');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the same unsafe raw bullet cannot stand for two distinct accepted notes', () => {
  const f = fixture();
  try {
    const acceptedNotes = [
      { id: 'bot', note: 'bot routine dry-run 루틴 사용 금지' },
      { id: 'opener', note: '옛 판 오프너 경보가 지연될 수 있다' },
    ];
    const { code, result } = f.invoke([], acceptedNotes, { reply: response([
      ['bot', 'See src/private.test.ts.'], ['opener', 'See src/private.test.ts.'],
    ]) });
    expect(code).toBe(1);
    expect(result.summary).toContain('repeats or splits an issue');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a recorded waiver represents ordinary accepted IDs with the same note once', () => {
  const f = fixture();
  try {
    const note = 'Help does not close when requested';
    const { code, result } = f.invoke([], [{ id: 'R1', note }, { id: 'waive:tui', note }], {
      recordedWaiver: { note }, reply: response([['R1', 'Help remains open after a close request.']]),
    });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [`${note}.`], sources: { accepted: 2 } });
    expect(readFileSync(f.notes, 'utf8').split(`- ${note}.`)).toHaveLength(2);
    expect(() => readFileSync(f.calls)).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a model bullet cannot hide a distinct recorded waiver group with identical public wording', () => {
  const f = fixture();
  try {
    const note = 'Help does not close when requested';
    const acceptedRegressions = [{ id: 'R1', note: 'Help does not close on request' }, { id: 'waive:tui', note }];
    const { code, result } = f.invoke([], acceptedRegressions, {
      recordedWaiver: { note }, reply: response([['R1', `${note}.`]]),
    });
    expect(code).toBe(1);
    expect(result.summary).toContain('waiver bullet repeats another issue');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('generic fallback cannot hide a recorded waiver with the same public wording', () => {
  const f = fixture();
  try {
    const acceptedRegressions = [{ id: 'R1', note: 'Settings not persisted' }, { id: 'waive:tui', note: fallback }];
    const { code, result } = f.invoke([], acceptedRegressions, { recordedWaiver: { note: fallback }, fail: true });
    expect(code).toBe(1);
    expect(result.summary).toContain('waiver bullet repeats another issue');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('checklist note does not make a checklist issue part of an accepted note group', () => {
  const f = fixture();
  try {
    const note = 'Exports do not finish';
    const withNote = [{ id: 'K1', title: note, evidence: 'timeout', note }];
    const { code, result } = f.invoke(withNote, [{ id: 'R1', note }], {
      reply: response([['K1', 'Exports do not finish for some users.'], ['R1', 'Exports do not finish for some users.']]),
    });
    expect(code).toBe(1);
    expect(result.summary).toContain('coverage not verified');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a forged waive: accepted ID is validated by the model, not copied into public notes as a real waiver', () => {
  const f = fixture();
  try {
    const fake = [{ id: 'waive:fake', note: 'Help does not close; see /Users/me/private.test.ts' }];
    const { code, result } = f.invoke([], fake, { reply: response([['waive:fake', 'Help does not close when private diagnostics are requested.']]) });
    expect(code).toBe(0);
    expect(result).toMatchObject({ count: 1, bullets: ['Help does not close when private diagnostics are requested.'], sources: { accepted: 1 } });
    expect(readFileSync(f.calls, 'utf8')).toContain('waive:fake');
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/Users/me/private.test.ts');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a claimed waived output without a recorded waiver still requires a validated model bullet', () => {
  const f = fixture();
  try {
    const acceptedWaiver = [{ id: 'waive:tui', note: 'Help does not close when requested' }];
    const { code, result } = f.invoke([], acceptedWaiver, { outputs: { tui: { outcome: 'ok', verdict: 'waived', reason: acceptedWaiver[0]!.note } },
      reply: response([['waive:tui', 'Help does not close when requested.']]) });
    expect(code).toBe(0);
    expect(result).toMatchObject({ count: 1, bullets: ['Help does not close when requested.'], sources: { accepted: 1 } });
    expect(readFileSync(f.notes, 'utf8')).toContain('- Help does not close when requested.');
    expect(readFileSync(f.calls, 'utf8')).toContain('waive:tui');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('empty sources leave the file, commit and ask untouched', () => {
  const f = fixture();
  try {
    const head = f.git(['rev-parse', 'HEAD'], f.tree);
    expect(f.invoke().result).toMatchObject({ outcome: 'ok', summary: '알려진 문제 없음', count: 0, bullets: [], fallbackUsed: false });
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
    expect(f.git(['rev-parse', 'HEAD'], f.tree)).toBe(head);
    expect(f.git(['status', '--porcelain'], f.tree)).toBe('');
    expect(() => readFileSync(f.calls)).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('PR numbers, Korean, internal paths and track markers become one safe fallback bullet', () => {
  const f = fixture();
  try {
    const { result } = f.invoke(checklist, accepted, { reply: response([['K13', 'Fixed in #22252.'], ['R1', '내부 /Users/me/thing.test.ts [TC]']]) });
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).toContain(`- ${fallback}\n`);
    expect(readFileSync(f.notes, 'utf8')).not.toContain('#22252');
    expect(result.bullets.join('')).not.toMatch(/[가-힣]|#\d+|\/Users\/|\.test\.ts/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an unsafe issue is replaced without dropping a safe issue from the other source', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke(checklist, accepted, {
      reply: response([['K13', 'Export delays can require retrying.'], ['R1', 'Settings fail in #22252.']]),
    });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', bullets: ['Export delays can require retrying.', fallback], count: 2, fallbackUsed: true });
    const text = readFileSync(f.notes, 'utf8');
    expect(text).toContain('- Export delays can require retrying.');
    expect(text).toContain(`- ${fallback}`);
    expect(text).not.toContain('#22252');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('internal absolute paths outside /Users are replaced before publishing', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke(checklist, [], { reply: response([['K13', 'Export delays: look in {/home/ubuntu/private.txt} for details.']]) });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [fallback], fallbackUsed: true });
    const text = readFileSync(f.notes, 'utf8');
    expect(text).toContain(`- ${fallback}\n`);
    expect(text).not.toContain('/home/ubuntu/private.txt');
    expect(f.git(['show', `release-docs/${version}:release/public/docs/releases/${version}.md`], f.remote)).not.toContain('/home/ubuntu/private.txt');
    const literal = f.invoke(checklist, [], { reply: response([['K13', 'Look in {/home/ubuntu/private.txt} for details.']]) });
    expect(literal.result).toMatchObject({ outcome: 'ok', bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/home/ubuntu/private.txt');
    const bracket = f.invoke(checklist, [], { reply: response([['K13', 'Look in [/home/ubuntu/private.txt] for details.']]) });
    expect(bracket.result).toMatchObject({ bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/home/ubuntu/private.txt');
    const curl = f.invoke(checklist, [], { reply: response([['K13', 'Look in curl(/home/ubuntu/private.txt) for details.']]) });
    expect(curl.result).toMatchObject({ bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/home/ubuntu/private.txt');
    const second = f.invoke(checklist, [], { reply: response([['K13', 'A report is stored at /etc/private.txt.']]) });
    expect(second.result).toMatchObject({ bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/etc/private.txt');
    const fileUri = f.invoke(checklist, [], { reply: response([['K13', 'A report is stored at file:///home/ubuntu/private.txt.']]) });
    expect(fileUri.result).toMatchObject({ bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('file:///home/ubuntu/private.txt');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('two bullets for one ID cannot mask an omitted input', () => {
  const f = fixture();
  try {
    const head = f.git(['rev-parse', 'HEAD'], f.tree);
    const { code, result } = f.invoke(checklist, accepted, { reply: response([['K13', 'Exports are slower.'], ['K13', 'Exports may time out.']]) });
    expect(code).toBe(1);
    expect(result).toMatchObject({ outcome: 'fail', count: 0 });
    expect(result.summary).toContain('coverage not verified');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
    expect(f.git(['rev-parse', 'HEAD'], f.tree)).toBe(head);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('distinct IDs with two bullets for the same issue do not count as coverage', () => {
  const f = fixture();
  try {
    const head = f.git(['rev-parse', 'HEAD'], f.tree);
    const { code, result } = f.invoke(checklist, accepted, { reply: response([['K13', 'An export may take longer.'], ['R1', 'An export may time out.']]) });
    expect(code).toBe(1);
    expect(result.summary).toContain('bullet does not identify input R1');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
    expect(f.git(['rev-parse', 'HEAD'], f.tree)).toBe(head);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an existing Known issues section preserves every existing line and adds only missing bullets', () => {
  const f = fixture();
  try {
    const old = `${base}\n## Known issues\n\nHand-written explanation stays.\n\n- An export may take longer; retry if it times out.\n\n## Next steps\n\nKeep this section.\n`;
    writeFileSync(f.notes, old);
    const first = f.invoke(checklist, accepted);
    expect(first.result.outcome).toBe('ok');
    const now = readFileSync(f.notes, 'utf8');
    expect(now).toContain('## Known issues\n\nHand-written explanation stays.\n\n- An export may take longer; retry if it times out.\n');
    expect(now).toContain('## Next steps\n\nKeep this section.');
    expect(now.slice(0, now.indexOf('- Some settings'))).toBe(old.slice(0, old.indexOf('## Next steps')));
    expect(now.split('- An export may take longer; retry if it times out.')).toHaveLength(2);
    expect(now.split('- Some settings do not persist; save them again.')).toHaveLength(2);
    const head = f.git(['rev-parse', 'HEAD'], f.tree);
    f.invoke(checklist, accepted);
    expect(readFileSync(f.notes, 'utf8')).toBe(now);
    expect(f.git(['rev-parse', 'HEAD'], f.tree)).toBe(head);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ask nonzero exit still writes the fallback and succeeds', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke(checklist, [], { fail: true });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).toContain(`- ${fallback}\n`);
    expect(readFileSync(f.notes, 'utf8')).not.toContain('they do not change how Elanous behaves');
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('same-topic accepted regression cannot be substituted with the checklist delay', () => {
  const f = fixture();
  try {
    const regression = [{ id: 'R1', note: 'Export settings not persisted' }];
    const { code, result } = f.invoke(checklist, regression, { reply: response([['K13', 'An export may take longer.'], ['R1', 'Exports may take longer.']]) });
    expect(code).toBe(1);
    expect(result.summary).toContain('coverage not verified');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('public paths remain allowed while brace-wrapped private paths are rejected', () => {
  const f = fixture();
  try {
    const publicUrl = response([['K13', 'Export delays affect https://example.com/releases; retry later.']]);
    const { code, result } = f.invoke(checklist, [], { reply: publicUrl });
    expect(code).toBe(0);
    expect(result.fallbackUsed).toBe(false);
    expect(readFileSync(f.notes, 'utf8')).toContain('https://example.com/releases');
    const privatePath = f.invoke(checklist, [], { reply: response([['K13', 'Export delays: see {/home/ubuntu/private.txt}.']]) });
    expect(privatePath.result).toMatchObject({ bullets: [fallback], fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).not.toContain('/home/ubuntu/private.txt');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a reversed claim about a regression is not accepted as coverage', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke([], accepted, { reply: response([['R1', 'Settings are persisted after restarting.']]) });
    expect(code).toBe(1);
    expect(result.summary).toContain('coverage not verified');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ask failure with an accepted behavior regression makes no claim about unaffected behavior', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke([], accepted, { fail: true });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [fallback], sources: { checklist: 0, accepted: 1 }, fallbackUsed: true });
    expect(readFileSync(f.notes, 'utf8')).toContain(`- ${fallback}\n`);
    expect(readFileSync(f.notes, 'utf8')).not.toContain('do not change how Elanous behaves');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ask failure across both sources publishes only a neutral aggregate without a behavior claim', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke(checklist, accepted, { fail: true });
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'ok', count: 1, bullets: [fallback], sources: { checklist: 1, accepted: 1 }, fallbackUsed: true });
    const text = readFileSync(f.notes, 'utf8');
    expect(text.split(`- ${fallback}`)).toHaveLength(2);
    expect(text).not.toContain('do not change how Elanous behaves');
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('missing docs worktree fails even when there are no known issues', () => {
  const f = fixture();
  try {
    const { code, result } = f.invoke([], [], { worktree: '' });
    expect(code).toBe(1);
    expect(result).toMatchObject({ outcome: 'fail' });
    expect(result.summary).toContain('docs 워크트리 없음');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a bullet that claims the issue is fixed fails and leaves the notes and remote untouched', () => {
  const f = fixture();
  try {
    const head = f.git(['rev-parse', 'HEAD'], f.tree);
    const { code, result } = f.invoke(checklist, [], { reply: response([['K13', 'Export delay has been fixed.']]) });
    expect(code).toBe(1);
    expect(result.summary).toContain('claims the issue is resolved');
    expect(readFileSync(f.notes, 'utf8')).toBe(base);
    expect(f.git(['rev-parse', 'HEAD'], f.tree)).toBe(head);
    expect(f.git(['rev-parse', `release-docs/${version}`], f.remote)).toBe(head);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a Korean checklist title with an accurate English bullet is published', () => {
  const f = fixture();
  try {
    const korean = [{ id: 'K20', title: '내부 작업 라벨', evidence: '시간 초과', knownIssue: 'Exports may take longer than usual.' }];
    const { code, result } = f.invoke(korean, [], { reply: response([['K20', 'An export may take longer than usual.']]) });
    expect(code).toBe(0);
    expect(result.count).toBe(1);
    expect(readFileSync(f.notes, 'utf8')).toContain('- An export may take longer than usual.');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a rerun after a failed push pushes the commit that is already in the file', () => {
  const f = fixture();
  try {
    const one = { reply: response([['K13', 'An export may take longer; retry if it times out.']]) };
    const first = f.invoke(checklist, [], one);
    expect(first.code).toBe(0);
    // Simulate a push that never reached the remote: move the remote branch back one commit.
    const local = f.git(['rev-parse', 'HEAD'], f.tree);
    f.git(['update-ref', `refs/heads/release-docs/${version}`, `${local}~1`], f.remote);
    const second = f.invoke(checklist, [], one);
    expect(second.code).toBe(0);
    expect(f.git(['rev-parse', `release-docs/${version}`], f.remote)).toBe(local);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
