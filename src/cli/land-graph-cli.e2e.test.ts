// Test universe: the real CLI (`bun bin/elanous.mjs --config-dir <scratch> land graph …`) against a scratch git remote,
// a fake `gh` shim (PR records in a JSON file) and a land command that really merges into the scratch remote with
// --match-head-commit semantics and the isolation check (homedir hardcode → exit 9, as op-direct-land-v2.sh).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';

const REPO = resolve(import.meta.dir, '../..');
let T = '';
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function cli(...args: string[]) {
  const r = await simCli(['land', ...args], { mode: 'spawn', allowPaths: [['land']], stateRoot: join(T, 'cfg'), cwd: REPO, timeoutMs: 60_000,
    env: { LAND_GRAPH_GH: join(T, 'gh'), ELANOUS_SEAT_STATE: join(T, 'seat-state'), LAND_WORLD: T } });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}
const ledger = () => readFileSync(join(T, 'cfg', 'land-graph', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
const prs = () => JSON.parse(readFileSync(join(T, 'prs.json'), 'utf8')) as Record<string, { state: string }>;

function branch(n: number, file: string, body: string) {
  const w = join(T, 'work');
  git(w, 'checkout', '-q', '-B', `pr${n}`, 'origin/main'); writeFileSync(join(w, file), body); git(w, 'add', '.'); git(w, 'commit', '-qm', `pr ${n}`);
  git(w, 'push', '-q', '-f', 'origin', `pr${n}`);
  const head = git(w, 'rev-parse', 'HEAD');
  const rd = join(T, 'seat-state', 'RES', 'evidence', 'PREGATE-GREEN', `${n}-${head.slice(0, 12)}-minim5`); const raw = join(T, 'raw', String(n));
  mkdirSync(rd, { recursive: true }); mkdirSync(raw, { recursive: true });
  writeFileSync(join(raw, 'focused.raw'), ' 7 pass\n 0 fail\n');
  writeFileSync(join(rd, 'receipt.json'), JSON.stringify({ head, host: 'minim5', focused: [`${file}.test.ts`], rawDir: raw }));
  return { number: n, headRefOid: head, baseRefName: 'main', isDraft: false, state: 'OPEN', title: `pr ${n}`, author: { login: 'tc-bot' }, files: [{ path: file }] };
}

beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), 'land-universe-'));
  git(T, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(T, 'clone', '-q', join(T, 'remote.git'), 'work');
  const w = join(T, 'work'); writeFileSync(join(w, 'README.md'), 'x\n'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'init'); git(w, 'push', '-q', 'origin', 'HEAD:main');
  git(w, 'fetch', '-q');
  const list = [branch(1, 'a.ts', 'export const a = 1;\n'), branch(2, 'b.ts', "import { homedir } from 'node:os';\nexport const p = homedir() + '/.elanous';\n"),
    branch(3, 'c.ts', 'export const c = 1;\n'), branch(4, 'shared.ts', 'export const s = 4;\n'), branch(5, 'shared.ts', 'export const s = 5;\n')];
  writeFileSync(join(T, 'prs.json'), JSON.stringify(Object.fromEntries(list.map(p => [p.number, p]))));
  writeFileSync(join(T, 'gh'), `#!/usr/bin/env bun
const fs = require('node:fs'); const db = JSON.parse(fs.readFileSync(process.env.LAND_WORLD + '/prs.json', 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') console.log(JSON.stringify(Object.values(db).filter(p => p.state === 'OPEN')));
else if (a[0] === 'pr' && a[1] === 'view') console.log(JSON.stringify(db[a[2]]));
else process.exit(2);
`); chmodSync(join(T, 'gh'), 0o755);
  // Land command: real merge into the scratch remote (match-head), isolation check on the merge result.
  writeFileSync(join(T, 'land.zsh'), `PR=$1 H=$2; W=$LAND_WORLD/work; cd $W || exit 3
git fetch -q origin || exit 3
[ "$(git rev-parse origin/pr$PR)" = "$H" ] || { echo "STOP merge rc=1 (head moved)"; exit 7; }
git checkout -q -B land origin/main && git merge -q --no-edit $H >/dev/null 2>&1 || { git merge --abort 2>/dev/null; echo "STOP merge rc=1 (conflict)"; exit 7; }
grep -rq 'homedir()' --include='*.ts' . && { echo "STOP isolation-gate rc=1"; exit 9; }
git push -q origin land:main || exit 7
bun -e "const f=process.env.LAND_WORLD+'/prs.json';const fs=require('fs');const d=JSON.parse(fs.readFileSync(f));d['$PR'].state='MERGED';fs.writeFileSync(f,JSON.stringify(d))"
echo merged
`);
  mkdirSync(join(T, 'cfg'), { recursive: true });
  writeFileSync(join(T, 'federation.yaml'), 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
  writeFileSync(join(T, 'cfg', 'config.json'), JSON.stringify({ land: { graph: { mode: 'live', slots: 2, repo: join(T, 'work'), orgPath: join(T, 'federation.yaml'), landCmd: join(T, 'land.zsh'), authors: { 'tc-bot': 'TC' } } } }));
  mkdirSync(join(T, 'seat-state', 'OP'), { recursive: true });
});
afterAll(() => { if (T && !process.env.KEEP) rmSync(T, { recursive: true, force: true }); });

describe('land graph · test universe (real CLI · scratch remote · fake gh)', () => {
  test('hold → land 1 · refuse-isolation 2 · race 4/5 · hold 3 stays', async () => {
    const h0 = await cli('hold', '3', '--reason', 'JUD NO-GO', '--by', 'JUD'); expect(h0.stderr + h0.status).toBe('0');
    const plan = await cli('graph', 'plan', '--json');
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout).decisions.map((d: { pr: number; action: string }) => `${d.pr}:${d.action}`)).toEqual(['1:land', '2:land', '3:hold', '4:wait', '5:wait']);

    const t1 = await cli('graph', 'tick', '--json'); expect(t1.status).toBe(0);
    expect(JSON.parse(t1.stdout).landed).toEqual([1]);
    expect(prs()['1']!.state).toBe('MERGED');
    expect(ledger().filter(r => r.pr === 2 && r.event === 'refused').map(r => r.cls)).toEqual(['isolation-gate']);
    expect(ledger().filter(r => r.pr === 2 && r.event === 'card').map(r => r.to)).toEqual([['TC']]);

    const t2 = await cli('graph', 'tick', '--json'); expect(t2.status).toBe(0);
    const d2 = JSON.parse(t2.stdout) as { landed: number[]; decisions: Array<{ pr: number; action: string; cls?: string }> };
    expect(d2.landed).toEqual([4]);
    expect(d2.decisions.find(d => d.pr === 5)).toMatchObject({ action: 'wait', cls: 'main-moved-overlap' });
    expect(d2.decisions.find(d => d.pr === 2)).toMatchObject({ action: 'refuse', cls: 'isolation-gate' });

    const t3 = await cli('graph', 'tick', '--json'); expect(t3.status).toBe(0);
    expect(ledger().filter(r => r.pr === 5 && r.event === 'refused').map(r => r.cls)).toEqual(['stale-base-revert']) // pr 5 would erase pr 4's shared.ts line — the guard refuses before the merge;
    expect(prs()['3']!.state).toBe('OPEN');
    expect(git(join(T, 'work'), 'log', 'origin/main', '--format=%s').split('\n').filter(s => s.startsWith('pr ')).sort()).toEqual(['pr 1', 'pr 4']);

    const st = await cli('graph', 'status'); expect(st.stdout).toContain('HOLD #3 · JUD NO-GO (JUD)');
    expect(readFileSync(join(T, 'seat-state', 'OP', readdirOne(join(T, 'seat-state', 'OP'))), 'utf8')).toContain('#1 «pr 1»');
  }, 120_000);
});

function readdirOne(dir: string): string {
  return (require('node:fs') as typeof import('node:fs')).readdirSync(dir).find(n => n.startsWith('COACH-ACTIONS-'))!;
}
