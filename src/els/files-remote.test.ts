import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFailure, createRemoteFiles, listScript, parseListing, previewScript, shQuote, sshConfigHosts, type RemoteRun, type RemoteRunner } from './files-remote.js';
import { filesKey, filesProps, hydrateFiles, openCommand, renderFiles, type FilesProps } from './elements/files-view.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
let root = '';
let home = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-files-remote-'));
  home = join(root, 'home');
  mkdirSync(join(home, '프로젝트'), { recursive: true });
  mkdirSync(join(home, 'locked'));
  writeFileSync(join(home, "it's a file.txt"), 'quoted name\n');
  writeFileSync(join(home, '프로젝트', '계획.md'), '# 계획\n\n- 하나\n');
  writeFileSync(join(home, '.secret-token'), 'nope\n');
  writeFileSync(join(home, 'bin.dat'), Buffer.from([0, 159, 146, 150]));
  chmodSync(join(home, 'locked'), 0o000);
});
afterAll(() => { chmodSync(join(home, 'locked'), 0o755); rmSync(root, { recursive: true, force: true }); });

/** A fake host: the script really runs in `sh -s` with HOME = the fake home (BSD or GNU ls, whatever this machine has). */
const localSh: RemoteRunner = (_host, script) => new Promise((resolve) => {
  const child = spawn('sh', ['-s'], { cwd: home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' } });
  const out: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err, timedOut: false }));
  child.stdin.end(script);
});

test('shQuote survives a quote, a space, $ and ; — the path stays one word for sh', () => {
  expect(shQuote("it's $HOME; rm -rf /")).toBe(`'it'\\''s $HOME; rm -rf /'`);
});

test('the list and preview scripts run in a real sh: home, Korean names, a quote in a name, denied, missing', async () => {
  const listed = parseListing((await localSh('h', listScript(''), 1000)).stdout.toString(), false);
  expect(listed).toMatchObject({ state: 'ok', entries: [{ name: 'locked', dir: true }, { name: '프로젝트', dir: true }, { name: 'bin.dat', dir: false }, { name: "it's a file.txt", dir: false }] });
  expect(parseListing((await localSh('h', listScript(join(home, 'locked')), 1000)).stdout.toString(), false)).toEqual(
    process.getuid?.() === 0 ? expect.anything() : { state: 'error', text: 'permission denied' });
  expect(parseListing((await localSh('h', listScript(join(home, 'gone')), 1000)).stdout.toString(), false)).toEqual({ state: 'error', text: 'not found' });
  const korean = parseListing((await localSh('h', listScript(join(home, '프로젝트')), 1000)).stdout.toString(), false);
  expect(korean).toMatchObject({ state: 'ok', dir: join(home, '프로젝트'), entries: [{ name: '계획.md', dir: false }] });
  const quoted = (await localSh('h', previewScript(join(home, "it's a file.txt")), 1000)).stdout.toString();
  expect(quoted).toBe('S 12\nquoted name\n');
});

test('classifyFailure: needs login, unknown host, unreachable, slow — never the raw stderr', () => {
  const run = (stderr: string, extra: Partial<RemoteRun> = {}): RemoteRun => ({ code: 255, stdout: Buffer.alloc(0), stderr, timedOut: false, ...extra });
  expect(classifyFailure(run('user@h: Permission denied (publickey,password).'))).toBe('needs login — open a terminal and ssh once');
  expect(classifyFailure(run('Host key verification failed.'))).toBe('needs login — open a terminal and ssh once');
  expect(classifyFailure(run('ssh: Could not resolve hostname x: nodename nor servname provided'))).toBe('unknown host');
  expect(classifyFailure(run('ssh: connect to host gcp1 port 22: Operation timed out'))).toBe('unreachable');
  expect(classifyFailure(run('', { timedOut: true, code: null }))).toBe('slow or unreachable (no answer in 12 s)');
});

test('ssh config hosts: aliases only, wildcards and negations left out', () => {
  expect(sshConfigHosts('Host *\n  User x\nHost node-b minim5 !bad\nHost gcp-*\nhost mbp\n  HostName 1.2.3.4\n')).toEqual(['node-b', 'minim5', 'mbp']);
});

test('the hub: loading first, one call per miss, onReady re-hydrates; credential names never fetched; unknown host refused', async () => {
  const calls: string[] = [];
  let ready = 0;
  const hub = createRemoteFiles({ run: (host, script, ms) => { calls.push(script.split('\n')[0]!); return localSh(host, script, ms); }, onReady: () => { ready++; }, sshConfig: () => 'Host fake\n' });
  expect(hub.hosts()).toEqual(['fake']);
  expect(hub.listing('evil;rm', '', false)).toEqual({ state: 'error', text: 'unknown host evil;rm' });
  const nav = filesProps({ host: 'fake', dir: '' })!;
  let props = hydrateFiles(nav, hub);
  expect(props.loading).toBe(true);
  expect(hub.listing('fake', '', false)).toEqual({ state: 'loading' });          // in flight: no second call
  while (ready < 1) await new Promise((done) => setTimeout(done, 5));
  expect(calls).toEqual([`d=''`]);
  props = hydrateFiles(nav, hub);
  expect(props.dir).toBe(home);
  expect(props.hosts).toEqual(['', 'fake']);
  expect(props.entries!.map((e) => e.name)).toEqual(['locked', '프로젝트', 'bin.dat', "it's a file.txt"]);
  // hidden on: the token-looking file is listed but its preview is never fetched
  const shown = hydrateFiles({ ...props, hidden: true }, hub);
  while (hub.listing('fake', home, true).state === 'loading') await new Promise((done) => setTimeout(done, 5));
  const withHidden = hydrateFiles({ ...props, hidden: true }, hub);
  const at = withHidden.entries!.findIndex((e) => e.name === '.secret-token');
  const secret = hydrateFiles({ ...withHidden, cursor: at }, hub);
  expect(secret.preview).toEqual({ name: '.secret-token', kind: 'secret' });
  expect(calls.some((line) => line.includes('secret-token'))).toBe(false);
  expect(shown.loading).toBe(true);
  hub.dispose();
});

test('host switcher keys, remote open argv (ssh -t, quoted path), attach and sidechat carry host:path', () => {
  const props: FilesProps = { host: '', dir: '/x', cursor: 0, hidden: false, filter: '', filtering: false, scroll: 0, hosts: ['', 'node-b', 'minim5'], entries: [{ name: "a b'c.txt", dir: false }] };
  expect(filesKey(props, ']')).toMatchObject({ host: 'node-b', dir: '', cursor: 0 });
  expect(filesKey({ ...props, host: 'node-b' }, ']')).toMatchObject({ host: 'minim5' });
  expect(filesKey({ ...props, host: '' }, '[')).toMatchObject({ host: 'minim5' });
  const remote = { ...props, host: 'node-b' };
  const open = filesKey(remote, '\r') as { open: { host: string; path: string } };
  expect(open.open).toMatchObject({ how: 'tab', host: 'node-b', path: "/x/a b'c.txt" });
  expect(openCommand(open.open as never, {})).toEqual(['ssh', '-t', '--', 'node-b', `less -R '/x/a b'\\''c.txt'`]);
  expect(filesKey(remote, 's')).toMatchObject({ open: { how: 'sidechat', context: "[file node-b:/x/a b'c.txt] " } });
  expect(filesKey(remote, 'R')).toMatchObject({ refresh: true });
  expect(filesProps({ host: 'bad host' })).toBeUndefined();
  const rows = renderFiles({ ...remote, loading: true, entries: [] }, { w: 90, h: 10 }, true).map(plain);
  expect(rows[0]).toContain('📁 node-b:/x · ⏳');
  expect(rows[1]).toContain(' local │ node-b │ minim5 ');
  expect(rows[2]).toContain('⏳ reading node-b…');
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(90);
  // a narrow box with many hosts keeps the current host in view
  const many = { ...remote, hosts: ['', 'aws1-replacement-121799', 'node-b.tailnet-example.ts.net', 'minim5.tailnet-example.ts.net', 'mbp-hq', 'node-b'], host: 'node-b' };
  const narrow = renderFiles(many, { w: 50, h: 8 }, true).map(plain);
  expect(narrow[1]).toContain('‹ ');
  expect(narrow[1]).toContain(' node-b ');
});
