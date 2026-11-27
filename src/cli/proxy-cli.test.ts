// `eln proxy grant|status|revoke` (CLAUDE-OP-PROXY-IDENTITY) ⊕ the proxy-capable CLI doors refusing a self-declared
// CLAUDE-OP (land unhold · seat assign). Independent literals; a fake process table stands in for proc_pidinfo.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerProxyCommands } from './proxy-cli.js';
import type { ProcInfo } from '../proxy/proxy-identity.js';
import { simCli } from '../ux-sim/in-process-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const UID = 501;
const procs = new Map<number, ProcInfo>([
  [5, { pid: 5, ppid: 1, uid: UID, start: '5:0', name: 'herdr' }],
  [30, { pid: 30, ppid: 5, uid: UID, start: '30:0', name: '-zsh' }], [302, { pid: 302, ppid: 30, uid: UID, start: '302:0', name: 'bun' }],
  [10, { pid: 10, ppid: 5, uid: UID, start: '10:0', name: '-zsh' }], [100, { pid: 100, ppid: 10, uid: UID, start: '100:0', name: 'claude' }],
  [101, { pid: 101, ppid: 100, uid: UID, start: '101:0', name: 'zsh' }], [102, { pid: 102, ppid: 101, uid: UID, start: '102:0', name: 'bun' }],
]);

function cli(opts: { tty: boolean; selfPid: number; typed?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'proxy-cli-'));
  dirs.push(root);
  const outs: string[] = []; const errs: string[] = []; const notices: string[] = []; const codes: number[] = []; const prompts: string[] = [];
  const program = new Command();
  registerProxyCommands(program, {
    stateRoot: () => root, lookup: () => (pid) => procs.get(pid), stdinIsTTY: () => opts.tty, selfPid: () => opts.selfPid,
    ask: async (p) => { prompts.push(p); const code = /Type ([0-9A-F]{6}) to grant/.exec(p)?.[1] ?? ''; return opts.typed ?? code; },
    out: (l) => outs.push(l), err: (l) => errs.push(l), setExitCode: (c) => codes.push(c), notifyOp: (l) => notices.push(l), now: () => Date.parse('2026-11-26T19:00:00Z'),
  });
  return { root, outs, errs, notices, codes, prompts, run: (...a: string[]) => program.parseAsync(['proxy', ...a], { from: 'user' }) };
}

describe('eln proxy grant', () => {
  test('a person at a terminal grants pid 100 after typing the code: grant file 0600 · audit row · OP notice', async () => {
    const c = cli({ tty: true, selfPid: 302 });
    await c.run('grant', 'CLAUDE-OP', '--runtime', '100');
    expect(c.codes).toEqual([]);
    expect(c.outs[0]).toStartWith('granted CLAUDE-OP → pid 100 until 2026-12-03T19:00:00.000Z');
    expect(c.notices).toEqual(['[Claude OP 대행] proxy grant issued · runtime pid 100 · until 2026-12-03T19:00:00.000Z']);
    const g = JSON.parse(readFileSync(join(c.root, 'proxy', 'grants.json'), 'utf8'))['CLAUDE-OP'];
    expect([g.role, g.runtime.pid, g.runtime.start]).toEqual(['proxy', 100, '100:0']);
    expect(readFileSync(join(c.root, 'proxy', 'audit.jsonl'), 'utf8')).toContain('"event":"grant"');
  });
  test('refused: not a TTY · from inside the claude session · a wrong code · another principal', async () => {
    const a = cli({ tty: false, selfPid: 302 });
    await a.run('grant', 'CLAUDE-OP', '--runtime', '100');
    expect([a.codes, a.errs[0]]).toEqual([[1], 'eln proxy grant: run this yourself in a terminal (stdin is not a TTY) — an agent cannot grant itself proxy authority']);
    const b = cli({ tty: true, selfPid: 102 });
    await b.run('grant', 'CLAUDE-OP', '--runtime', '100');
    expect(b.errs[0]).toBe('eln proxy grant: refused — this terminal runs inside claude (pid 100); open your own terminal');
    const w = cli({ tty: true, selfPid: 302, typed: 'nope' });
    await w.run('grant', 'CLAUDE-OP', '--runtime', '100');
    expect([w.codes, w.errs[0], existsSync(join(w.root, 'proxy', 'grants.json'))]).toEqual([[1], 'eln proxy grant: not granted (code mismatch)', false]);
    const o = cli({ tty: true, selfPid: 302 });
    await o.run('grant', 'TC', '--runtime', '100');
    expect(o.codes).toEqual([2]);
  });
  test('revoke clears it and notices OP; status reports no grant', async () => {
    const c = cli({ tty: true, selfPid: 302 });
    await c.run('grant', 'CLAUDE-OP', '--runtime', '100');
    await c.run('revoke');
    expect(c.outs.at(-1)).toBe('revoked CLAUDE-OP');
    expect(c.notices.at(-1)).toBe('[Claude OP 대행] proxy grant revoked');
    await c.run('status', '--json');
    expect(JSON.parse(c.outs.at(-1)!)).toMatchObject({ principal: 'CLAUDE-OP', granted: false });
  });
});

describe('proxy-capable CLI doors refuse a self-declared CLAUDE-OP (no grant in this universe)', () => {
  const PATHS = [['land', 'hold'], ['land', 'unhold'], ['seat', 'assign']];
  function universe() { const state = mkdtempSync(join(tmpdir(), 'proxy-door-')); dirs.push(state); return state; }
  test('land unhold: refused with the fix line and the hold stays; a JUD hold is never lifted by the proxy', async () => {
    const state = universe();
    const run = (track: string, ...args: string[]) => simCli(args, { stateRoot: state, env: { ELANOUS_TRACK: track }, allowPaths: PATHS });
    expect((await run('OP', 'land', 'hold', '7', '--reason', 'r', '--by', 'OP')).exitCode).toBe(0);
    const un = await run('CLAUDE-OP', 'land', 'unhold', '7');
    expect(un.exitCode).not.toBe(0);
    expect(un.stderr).toContain('proxy: no CLAUDE-OP grant');
    expect((await run('JUD', 'land', 'hold', '8', '--reason', 'veto', '--by', 'JUD')).exitCode).toBe(0);
    const unJud = await run('CLAUDE-OP', 'land', 'unhold', '8');
    expect(unJud.stderr).toContain('the proxy never lifts a JUD hold');
    const rows = readFileSync(join(state, 'proxy', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => `${x.event}:${x.op}:${x.reason}`)).toEqual(['refused:land-unhold:no-grant', 'refused:land-unhold:jud-hold']);
  }, 60_000);
  test('seat assign --from CLAUDE-OP: refused (exit 2) with the fix line', async () => {
    const state = universe();
    const r = await simCli(['seat', 'assign', 'TC', 'A1', '--from', 'CLAUDE-OP'], { stateRoot: state, allowPaths: PATHS });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('seat assign: proxy: no CLAUDE-OP grant');
  }, 60_000);
});
