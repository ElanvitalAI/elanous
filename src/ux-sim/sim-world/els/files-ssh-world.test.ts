// ELS-FILES-SSH sim — remote browsing through the file browser element, seeds 1..5. The overlay registry gets a real remote
// hub whose runner is a fake ssh: host «fast» really runs the list/preview scripts in a local `sh -s` over a fake home
// (Korean names, a 3000-entry folder, a permission-denied folder); «slow» answers after a delay as timed out; «down» is a dead
// host; «login» needs interactive auth. Frames go through the real frame writer into @xterm/headless and are checked cell by
// cell against the reference composite; the pane under the popup keeps streaming.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElsRequest } from '../../../els/server.js';
import type { ElsResult } from '../../../els/core.js';
import { createRemoteFiles, type RemoteFiles, type RemoteRunner } from '../../../els/files-remote.js';
import { createZaxisWorld, prng, referenceOf, writeNotesVault, type EmuScreen, type Viewer, type ViewerOpts, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
// 출처: ELS-FILES-SSH sim device — past the element's 2000-entry cap
const HUGE = 3_000;
let root = '';
let home = '';
let vault = '';
const disposers: (() => void)[] = [];
const matrix = new Map<string, Map<number, string>>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-files-ssh-'));
  vault = writeNotesVault(join(root, 'SimVault'));
  home = join(root, 'fakehome');
  mkdirSync(join(home, '한글 폴더'), { recursive: true });
  mkdirSync(join(home, 'huge'));
  mkdirSync(join(home, 'denied'));
  for (let at = 0; at < HUGE; at++) writeFileSync(join(home, 'huge', `r${String(at).padStart(4, '0')}`), '');
  writeFileSync(join(home, '한글 폴더', '보고서 😀.md'), '# 보고서\n\n원격 본문\n');
  writeFileSync(join(home, 'notes.txt'), 'remote notes line\n');
  chmodSync(join(home, 'denied'), 0o000);
});
afterAll(() => {
  for (const one of disposers) one();
  chmodSync(join(home, 'denied'), 0o755);
  rmSync(root, { recursive: true, force: true });
  const lines = [`| case | ${SEEDS.map((s) => `seed ${s}`).join(' | ')} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((s) => row.get(s) ?? '-').join(' | ')} |`);
  console.log(`\nELS-FILES-SSH MATRIX\n${lines.join('\n')}`);
});
const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};

/** The fake ssh: per-host behaviour, every call recorded (host + first script line). */
function fakeSsh(calls: string[], slowMs: number): RemoteRunner {
  return (host, script) => {
    calls.push(`${host} ${script.split('\n')[0]}`);
    if (host === 'down') return Promise.resolve({ code: 255, stdout: Buffer.alloc(0), stderr: 'ssh: connect to host down port 22: Operation timed out\r\n', timedOut: false });
    if (host === 'login') return Promise.resolve({ code: 255, stdout: Buffer.alloc(0), stderr: 'user@login: Permission denied (publickey,password).\r\n', timedOut: false });
    if (host === 'slow') return new Promise((done) => setTimeout(() => done({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true }), slowMs));
    return new Promise((done) => {
      const child = spawn('sh', ['-s'], { cwd: home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' } });
      const out: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.on('close', (code) => done({ code, stdout: Buffer.concat(out), stderr: '', timedOut: false }));
      child.stdin.end(script);
    });
  };
}

interface SshWorld { w: ZaxisWorld; hub: RemoteFiles; calls: string[]; requests: ElsRequest[]; viewer: (opts?: ViewerOpts) => Promise<Viewer>; settle: () => Promise<void> }
function sshWorld(seed: number): SshWorld {
  const calls: string[] = [];
  const requests: ElsRequest[] = [];
  let w: ZaxisWorld | undefined;
  const hub = createRemoteFiles({
    run: fakeSsh(calls, 20 + prng(seed).int(0, 40)), sshConfig: () => 'Host fast slow down login\nHost *\n',
    onReady: () => { const layer = w?.registry.stack().layers.find((one) => one.kind === 'files'); if (w && layer) w.registry.apply({ action: 'update', id: layer.id, props: layer.props }); },
  });
  w = createZaxisWorld(seed, vault, () => ({ files: hub }));
  disposers.push(() => { hub.dispose(); w!.dispose(); });
  w.listing.panes = w.listing.panes.map((row) => ({ ...row, cwd: root }));
  const request = (one: ElsRequest): ElsResult | undefined => {
    requests.push(one);
    if (one.op === 'overlay') { const { op: _op, ...rest } = one; return w!.registry.apply(rest); }
    return undefined;
  };
  /** Wait until no remote read is in flight for the open layer (bounded). */
  const settle = async (): Promise<void> => {
    for (let at = 0; at < 400; at++) {
      const props = w!.registry.stack().layers.find((one) => one.kind === 'files')?.props as { loading?: boolean } | undefined;
      if (!props?.loading) { await new Promise((done) => setTimeout(done, 2)); return; }
      await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error('remote read never landed');
  };
  return { w, hub, calls, requests, viewer: (opts = {}) => w!.viewer({ ...opts, request }), settle };
}

const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function exact(v: Viewer): Promise<EmuScreen> {
  // The reference is taken in the same tick as the emulated read (a remote read may land while the emulator awaits).
  const composed = v.writes.at(-1)!;
  const size = { ...v.size };
  const seen = await v.emulated();
  expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(composed, size)));
  for (const row of seen.rows) expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(v.size.cols);
  return seen;
}
const props = (w: ZaxisWorld) => w.registry.stack().layers.find((one) => one.kind === 'files')?.props as { host: string; dir: string; cursor: number; entries: { name: string; dir: boolean }[]; total: number; error?: string; loading?: boolean; hosts?: string[] } | undefined;
const to = async (s: SshWorld, v: Viewer, host: string): Promise<void> => {
  for (let at = 0; at < 6 && props(s.w)!.host !== host; at++) { v.press(']'); await s.settle(); }
  expect(props(s.w)!.host).toBe(host);
};
const pick = (s: SshWorld, name: string): void => {
  const p = props(s.w)!;
  s.w.registry.apply({ action: 'update', id: s.w.registry.stack().layers.find((one) => one.kind === 'files')!.id, props: { host: p.host, dir: p.dir, cursor: p.entries.findIndex((e) => e.name === name) } });
};

describe('S1 · host switcher: ] walks local → fast → slow → down → login, each shows ⏳ then its answer', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('S1 switcher: ⏳ then answer · frame exact', seed, async () => {
    const s = sshWorld(seed);
    const v = await s.viewer();
    v.press('\u0002f');
    expect(props(s.w)!.hosts).toEqual(['', 'fast', 'slow', 'down', 'login']);
    expect(v.last().join('\n')).toContain(' local │ fast │ slow │ down │ login ');
    const expected: Record<string, string> = { fast: '한글 폴더/', slow: 'slow: slow or unreachable (no answer in 12 s)', down: 'down: unreachable', login: 'login: needs login — open a terminal and ssh once' };
    for (const host of ['fast', 'slow', 'down', 'login']) {
      v.press(']');
      expect(props(s.w)!.host).toBe(host);
      expect(v.last().join('\n')).toContain(`📁 ${host}:~`);
      await exact(v);
      await s.settle();
      expect(v.last().join('\n').replace(/\s*│\s*/g, ' ')).toContain(expected[host]!.slice(0, 24));
      await exact(v);
    }
    v.press(']');                                                         // back to local
    expect(props(s.w)!.host).toBe('');
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
    expect(s.calls.filter((one) => one.startsWith('down ')).length).toBe(1);   // a dead host is asked once, then cached
  }));
});

describe('S2 · a fast pane streams under the popup while a slow host answers', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('S2 slow host ⊕ fast pane: border intact · no key leak', seed, async () => {
    const s = sshWorld(seed);
    const v = await s.viewer();
    v.press('\u0002f');
    await to(s, v, 'fast');
    v.press(']');                                                         // slow: in flight
    const rand = prng(seed * 11);
    for (let at = 0; at < 120; at++) {
      v.paneFrame(`[screen 91x28 cursor=(row 0, col 0, visible true)]\n${Array.from({ length: 28 }, (_, row) => `${at}:${row} 원격 대기 😀 ${rand.int(0, 999)}`).join('\n')}`);
      if (at % 20 === 0) v.press(rand.int(0, 1) ? 'j' : 'k');
      const seen = await v.emulated();
      expect(seen.rows[2]!.chars[8]).toBe('┌');                          // 120x30: box rows 2..25 from col 8
      expect(seen.rows[25]!.chars[8]).toBe('└');
    }
    await s.settle();
    expect(props(s.w)!.error).toBe('slow: slow or unreachable (no answer in 12 s)');
    await exact(v);
    expect(v.attachments[0]!.typed).toEqual([]);
  }));
});

describe('S3 · remote folders: Korean names, 3000 entries capped, permission denied', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('S3 remote: Korean · huge cap · denied', seed, async () => {
    const s = sshWorld(seed);
    const v = await s.viewer({ cols: 180, rows: 56 });
    v.press('\u0002f');
    await to(s, v, 'fast');
    expect(props(s.w)!.dir).toBe(home);
    pick(s, '한글 폴더'); await s.settle(); v.press('\r'); await s.settle();
    expect(props(s.w)!.entries.map((e) => e.name)).toEqual(['보고서 😀.md']);
    expect(v.last().join('\n')).toContain('원격 본문');                     // the preview came over the fake ssh
    await exact(v);
    v.press('\u007f'); await s.settle();
    pick(s, 'huge'); await s.settle(); v.press('\r'); await s.settle();
    expect(props(s.w)!.entries).toHaveLength(2_000);
    expect(props(s.w)!.total).toBe(HUGE);
    expect(v.last().join('\n')).toContain('(first 2000)');
    const steps = prng(seed).int(1, 30);
    for (let at = 0; at < steps; at++) v.press('j');
    await s.settle();
    expect(props(s.w)!.cursor).toBe(steps);
    await exact(v);
    v.press('\u007f'); await s.settle();
    pick(s, 'denied'); await s.settle(); v.press('\r'); await s.settle();
    if (process.getuid?.() !== 0) expect(props(s.w)!.error).toBe('permission denied');
    await exact(v);
  }));
});

describe('S4 · two viewers and a resize while a remote read is in flight', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('S4 two viewers ⊕ resize mid-read', seed, async () => {
    const s = sshWorld(seed);
    const a = await s.viewer();
    const b = await s.viewer({ cols: 80, rows: 24 });
    a.press('\u0002f');
    a.press(']');                                                         // fast: in flight
    b.size.cols = 100; b.size.rows = 28; b.app.resized();
    await exact(a); await exact(b);
    await s.settle();
    for (const v of [a, b]) { expect(v.last().join('\n')).toContain('notes.txt'); await exact(v); }
    b.press(']'); await s.settle();                                       // B moves to slow: A sees it too
    expect(a.last().join('\n')).toContain('slow: slow or unreachable');
    await exact(a);
  }));
});

describe('S5 · remote open: Enter = ssh -t host less (quoted path), a = host:path reference typed, never sent', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('S5 remote open: ssh -t argv · host:path attach', seed, async () => {
    const s = sshWorld(seed);
    const v = await s.viewer();
    v.press('\u0002f');
    await to(s, v, 'fast');
    pick(s, '한글 폴더'); await s.settle(); v.press('\r'); await s.settle();
    v.press('\r');
    for (let at = 0; at < 5; at++) await new Promise((done) => setImmediate(done));
    expect(s.requests.find((one) => one.op === 'new')).toMatchObject({ op: 'new', command: ['ssh', '-t', '--', 'fast', `less -R '${join(home, '한글 폴더', '보고서 😀.md')}'`] });
    v.press('\u0002f'); await s.settle();
    await to(s, v, 'fast');
    pick(s, '한글 폴더'); await s.settle(); v.press('\r'); await s.settle();
    pick(s, '보고서 😀.md'); await s.settle();
    v.press('a');
    await new Promise((done) => setImmediate(done));
    const typed = v.attachments.at(-1)!.typed.join('');
    expect(typed).toBe(`\u001b[200~"fast:${join(home, '한글 폴더', '보고서 😀.md')}" \u001b[201~`);
    expect(typed).not.toContain('\r');
  }));
});
