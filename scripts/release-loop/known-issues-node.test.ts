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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-known-issues-'));
  const remote = join(root, 'remote.git');
  const tree = join(root, 'tree');
  const bin = join(root, 'bin');
  const notes = join(tree, 'release/public/docs/releases', `${version}.md`);
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
  git(['checkout', '-b', `release-docs/${version}`], tree);
  git(['push', '-u', 'origin', `release-docs/${version}`], tree);
  const fake = join(bin, 'elanous');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.KNOWN_ASK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.KNOWN_ASK_FAIL === '1') process.exit(3);
console.log(JSON.stringify({reply:process.env.KNOWN_ASK_REPLY}));
`);
  chmodSync(fake, 0o755);
  const invoke = (checklist: Array<{ id: string; title: string; evidence: string }> = [], acceptedRegressions: Array<{ id: string; note: string }> = [], opts: { reply?: string; fail?: boolean; worktree?: string; outputs?: Record<string, Record<string, unknown>> } = {}) => {
    const context = { input: { version, previousVersion: '0.2.6', acceptedRegressions }, outputs: { 'checklist-gate': { knownIssues: checklist }, docs: { branch: `release-docs/${version}`, worktree: opts.worktree ?? tree }, ...opts.outputs } };
    const run = spawnSync('bun', [join(import.meta.dir, 'known-issues-node.ts')], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context), KNOWN_ASK_CALLS: calls,
        KNOWN_ASK_REPLY: opts.reply ?? normalReply, KNOWN_ASK_FAIL: opts.fail ? '1' : '0' },
    });
    return { code: run.status, result: JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { outcome: string; summary: string; count: number; bullets: string[]; sources: { checklist: number; accepted: number }; fallbackUsed: boolean } };
  };
  return { root, tree, remote, notes, calls, invoke, git };
}

const checklist = [{ id: 'K13', title: 'Export delay', evidence: 'timeout' }];
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
    const korean = [{ id: 'K20', title: '내보내기가 가끔 느리다', evidence: '시간 초과' }];
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
