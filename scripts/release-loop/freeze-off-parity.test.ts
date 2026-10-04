import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as gateNode from './gate-node';
import * as publishNode from './publish-node.js';
import * as unattendedNode from './unattended-release.js';

// FREEZE1 off-state parity (OP 10-04 19:39 condition ①): with no landing-freeze file, gate · publish · unattended
// produce the same result, calls and graph input as before the switch existed.
// An independent checkout of the pre-FREEZE1 base (parent of the first commit that brought the freeze in — or HEAD
// before the change is committed: its own scripts and src, only node_modules shared) and this checkout run the same
// isolated scenario; both must match the GOLDEN captured from main before FREEZE1.
// This is a deliberate pin: a later change that alters these nodes' off-state output must update this test.
// GOLDEN (the same capture taken from main before FREEZE1) is used only without git history (not a work tree,
// or a shallow clone).
// GOLDEN provenance: captured 2026-10-04 from origin/main d958ff5b (pre-FREEZE1) by running this file's `capture` against
// that checkout's three nodes; with git history, the test re-derives the same value from the pre-freeze base each run.
const GOLDEN = {"gate": {"outcome": "regression", "commit": "cccccccccccccccccccccccccccccccccccccccc", "introduced": ["src/b.test.ts > B"], "preexisting": 1, "fixed": 1, "knownEnv": 0, "knownEnvCleared": [], "stalledEnv": [], "baselineSource": "instance"}, "gateCalls": ["add cccccccccccccccccccccccccccccccccccccccc @<tmp>/cut", "bun install @<tmp>/cut", "bun install @<tmp>/cut/apps/pwa", "sweep @<tmp>/cut", "bun run test:deterministic ./src/b.test.ts @<tmp>/cut", "snapshot bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb @<tmp>/baseline", "bun install @<tmp>/baseline", "bun install @<tmp>/baseline/apps/pwa", "bun run test:deterministic ./src/b.test.ts @<tmp>/baseline", "bun run test:deterministic ./src/c.test.ts @<tmp>/cut", "removeSnapshot @<tmp>/baseline", "remove @<tmp>/cut"], "publish": {"outcome": "ok", "verdict": "pass", "summary": "published v0.2.4 · 0 assets downloadable", "tag": "v0.2.4"}, "publishCalls": [["git", "show", "release-docs/0.2.4:release/public/docs/releases/0.2.4.md"], ["git", "show", "release-docs/0.2.4:website/pages.json"], ["bun", "bin/elanous.mjs", "release", "publish", "--dir", "dist", "--notes-file", "<notes>", "--yes", "--json"]], "unattended": {"input": {"gatePodPool": "pool", "version": "0.2.4", "previousVersion": "0.2.3"}, "dryRun": false, "state": {"status": "done"}}, "graphInput": {"gatePodPool": "pool", "version": "0.2.4", "previousVersion": "0.2.3"}};
const NODES = ['scripts/release-loop/gate-node.ts', 'scripts/release-loop/publish-node.ts', 'scripts/release-loop/unattended-release.ts'];
const REPO = resolve(import.meta.dir, '../..');
type Mods = { judgeGate: typeof gateNode.judgeGate; runPublish: typeof publishNode.runPublish; runUnattendedRelease: typeof unattendedNode.runUnattendedRelease };

async function capture(mods: Mods): Promise<string> {
  const env = { state: process.env.ELANOUS_STATE_DIR, graph: process.env.ELANOUS_GRAPH_CONTEXT };
  const roots: string[] = [];
  try {
  const norm = (v: unknown) => { let s = JSON.stringify(v); for (const r of roots) s = s.split(r).join('<root>'); return JSON.parse(s.split(realpathSync(tmpdir())).join('<T>').split(tmpdir()).join('<T>').replace(/<T>\/[^\/"@ ]+/g, '<tmp>')); };
  const A = 'src/a.test.ts > A', B = 'src/b.test.ts > B', C = 'src/c.test.ts > C', D = 'src/d.test.ts > D';
  const BASE = 'b'.repeat(40), CUT = 'c'.repeat(40);
  const out = (ids: string[]) => ids.map((id) => { const i = id.indexOf(' > '); return `${id.slice(0, i)}:\n(fail) ${id.slice(i + 3)} [1.00ms]\n`; }).join('') + `\n${ids.length} fail\nRan ${Math.max(1, ids.length)} tests across ${Math.max(1, ids.length)} files.\n`;
  // gate
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cap-gate-'))); roots.push(root);
  const inst = join(root, 'instance'); mkdirSync(join(inst, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(inst, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: BASE }));
  writeFileSync(join(inst, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: [A, D] }));
  const calls: string[] = [];
  const runner = {
    async localCommand(cmd: string, args: string[], cwd: string) { calls.push(`${cmd} ${args.join(' ')} @${cwd}`); return { rc: 0, output: '' }; },
    async command(cmd: string, args: string[], cwd: string) {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      if (cmd === 'sh') return { rc: 0, output: '/home/remote\n' };
      if (cmd === 'bun' && args[0] === 'run') { const f = args[2]!.replace(/^\.\//, ''); const ids = cwd.endsWith('/cut') ? (f === 'src/c.test.ts' ? [] : f === 'src/b.test.ts' ? [B] : [A]) : f === 'src/b.test.ts' ? [] : [A]; return { rc: ids.length ? 1 : 0, output: out(ids) }; }
      return { rc: 0, output: '' };
    },
    async sweep(t: string) { calls.push(`sweep @${t}`); const ids = t.endsWith('/cut') ? [A, B, C] : [A, D]; return { rc: 1, output: out(ids) }; },
    async add(t: string, sha: string) { calls.push(`add ${sha} @${t}`); }, async remove(t: string) { calls.push(`remove @${t}`); },
    async snapshot(t: string, sha: string) { calls.push(`snapshot ${sha} @${t}`); }, async removeSnapshot(t: string) { calls.push(`removeSnapshot @${t}`); },
  };
  const gate = await mods.judgeGate({ commit: CUT, version: '1.0.1', baselineVersion: '1.0.0', instanceRoot: inst, ledgerRoot: join(root, 'machine-ledger') }, runner);
  delete (gate as { durationMs?: number }).durationMs;
  // publish
  const proot = realpathSync(mkdtempSync(join(tmpdir(), 'cap-pub-'))); roots.push(proot);
  process.env.ELANOUS_STATE_DIR = proot;
  const outputs: Record<string, unknown> = Object.fromEntries(['gate', 'pwa', 'upgrade', 'tui', 'prepare', 'docs'].map((n) => [n, { outcome: 'ok' }]));
  Object.assign(outputs, { 'approve-publish': { outcome: 'approved' }, prepare: { outcome: 'ok', commit: 'a', out: 'dist' }, 'version-release': { commit: 'a' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' } });
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
  const pcalls: string[][] = [];
  const pub = mods.runPublish((cmd: string, args: string[]) => { pcalls.push([cmd, ...args.map((a) => a.replace(/\/[^ ]*notes\.md$/, '<notes>'))]); return { status: 0, stdout: args.some((a) => a.endsWith('website/pages.json')) ? JSON.stringify({ pages: [] }) : args.includes('publish') ? JSON.stringify({ ok: true, published: true, tag: 'v0.2.4' }) : '# 0.2.4\nHello', stderr: '' }; });
  // unattended
  const uroot = realpathSync(mkdtempSync(join(tmpdir(), 'cap-un-'))); roots.push(uroot);
  mkdirSync(join(uroot, 'release/0.2.3'), { recursive: true });
  writeFileSync(join(uroot, 'release/0.2.3/release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
  let graphInput: unknown = null;
  const un = await mods.runUnattendedRelease({ version: '0.2.4' }, { freezeRoot: uroot, ledgerRoot: uroot, config: { gatePodPool: 'pool' }, checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }), graph: async (_p: string, o: { input: unknown }) => { graphInput = o.input; return { status: 'done' } as never; } } as never);
    return JSON.stringify(norm({ gate, gateCalls: calls, publish: pub, publishCalls: pcalls, unattended: un, graphInput }));
  } finally {
    if (env.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = env.state;
    if (env.graph === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = env.graph;
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
}

/** History is «unavailable» only outside a git work tree or in a shallow clone; any other git error fails the test. */
function historyAvailable(): boolean {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO, encoding: 'utf8' });
  if (inside.status !== 0) {
    if (/not a git repository/i.test(inside.stderr)) return false;
    throw new Error(`git rev-parse failed: ${inside.stderr.trim()}`);
  }
  if (inside.stdout.trim() !== 'true') return false;
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO, encoding: 'utf8' });
  if (shallow.status !== 0) throw new Error(`git rev-parse --is-shallow-repository failed: ${shallow.stderr.trim()}`);
  return shallow.stdout.trim() !== 'true';
}

/** First commit that brought the freeze into the release nodes or src (null while that change is uncommitted). */
function freezeCommit(): string | null {
  const intro = spawnSync('git', ['log', '--reverse', '--format=%H', '-S', 'landing-freeze', '--', 'scripts', 'src'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (intro.status !== 0) throw new Error(`git log failed: ${intro.stderr.trim()}`);
  const commit = intro.stdout.split('\n')[0]!.trim();
  if (commit && !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected git log output: ${commit}`);
  return commit || null;
}

/** An independent checkout of `rev` (its own scripts and src — every dependency of the nodes as of that commit);
 *  only node_modules is shared. */
function treeAt(rev: string, expectFreeze: boolean): { dir: string; base: string } {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  const base = git('rev-parse', rev);
  if (base.status !== 0) throw new Error(`cannot resolve ${rev}: ${base.stderr.trim()}`);
  const gate = git('show', `${rev}:${NODES[0]}`);
  if (gate.status !== 0) throw new Error(`cannot read ${NODES[0]} at ${rev}: ${gate.stderr.trim()}`);
  if (gate.stdout.includes('landing-freeze') !== expectFreeze) throw new Error(`${NODES[0]} at ${rev}: freeze check ${expectFreeze ? 'missing' : 'already present'}`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'freeze-parity-')));
  const archive = spawnSync('sh', ['-c', `git archive ${base.stdout.trim()} scripts src package.json tsconfig.json | tar -x -C '${dir}'`], { cwd: REPO, encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`git archive ${rev} failed: ${archive.stderr.trim()}`);
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  return { dir, base: base.stdout.trim() };
}

test('freeze switch off: gate, publish and unattended release are byte-identical to pre-freeze behavior', async () => {
  if (!historyAvailable()) {
    const current = await capture({ judgeGate: gateNode.judgeGate, runPublish: publishNode.runPublish, runUnattendedRelease: unattendedNode.runUnattendedRelease });
    console.warn('freeze-off-parity: no git history (not a work tree or shallow clone) — compared with the recorded pre-FREEZE1 GOLDEN only');
    expect(current).toBe(JSON.stringify(GOLDEN));
    return;
  }
  const current = await capture({ judgeGate: gateNode.judgeGate, runPublish: publishNode.runPublish, runUnattendedRelease: unattendedNode.runUnattendedRelease });
  // Pre-freeze base: the parent of the first commit that brought the freeze in — or HEAD while it is uncommitted.
  const commit = freezeCommit();
  const before = treeAt(commit ? `${commit}^` : 'HEAD', false);
  try {
    const old = await capture({
      judgeGate: (await import(join(before.dir, NODES[0]!))).judgeGate,
      runPublish: (await import(join(before.dir, NODES[1]!))).runPublish,
      runUnattendedRelease: (await import(join(before.dir, NODES[2]!))).runUnattendedRelease,
    });
    expect(old).not.toContain('forceFreeze');
    expect(current).toBe(old);
    expect(current).toBe(JSON.stringify(GOLDEN));
  } finally { rmSync(before.dir, { recursive: true, force: true }); }
});
