import { setDefaultTimeout, afterEach, expect, spyOn, test } from 'bun:test';
import { runControlServe } from './control-cli.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONTROL_PORT, ensureControlTokens } from '../control-plane/server.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');
const cwd = resolve(import.meta.dir, '../..');

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-control-cli-'));
  roots.push(dir);
  return dir;
}
function launch(dir: string, ...args: string[]) {
  const child = Bun.spawn(['bun', entry, `--test=${dir}`, ...args], {
    cwd, env: { ...process.env, ELANOUS_CONTROL_PORT: '', ELANOUS_SUPPRESS_XDG_WARNING: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  return child;
}
async function command(dir: string, ...args: string[]) {
  const child = launch(dir, ...args);
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
async function serve(dir: string) {
  const child = launch(dir, 'control', 'serve', '--port', '0');
  const reader = child.stdout.getReader();
  const line = await Promise.race([
    (async () => {
      let text = '';
      while (!text.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`control serve exited before startup line: ${text}`);
        text += new TextDecoder().decode(chunk.value);
      }
      return text.slice(0, text.indexOf('\n'));
    })(),
    Bun.sleep(15_000).then(() => { throw new Error('control serve startup timeout'); }),
  ]);
  reader.releaseLock();
  const port = /관제부 127\.0\.0\.1:(\d+) · 토큰 /.exec(line)?.[1];
  expect(port).toBeDefined();
  expect(line).toContain(join(dir, 'control', 'tokens.json'));
  for (const token of Object.values(ensureControlTokens(dir))) expect(line).not.toContain(token);
  return { child, port: port! };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('real control status --json returns seven rows and the table distinguishes measurement states', async () => {
  const dir = root();
  const result = await command(dir, 'control', 'status', '--json');
  expect(result.code).toBe(0);
  const { rows } = JSON.parse(result.stdout) as { rows: Array<{ row: string; state: string; reason?: string }> };
  expect(rows).toHaveLength(7);
  expect(rows.map(r => r.row)).toEqual(['집', '판', '자원', '자격', '동결·몫', '루프', 'config']);
  for (const row of rows.slice(1, 4)) expect(row).toMatchObject({ state: 'unmeasured', reason: expect.any(String) });
  const table = await command(dir, 'control', 'status');
  expect(table.code).toBe(0);
  expect(table.stdout.trim().split('\n')).toHaveLength(7);
  expect(table.stdout).toContain('판 · 못 쟀다');
}, 120_000);

test('control status keeps a multiline freeze reason inside one table row', async () => {
  const dir = root();
  writeFileSync(join(dir, 'landing-freeze.json'), JSON.stringify({
    reason: '첫 줄\n둘째 줄\r셋째 줄\u001b[2J', startedAt: new Date().toISOString(), until: null, by: 'OP',
  }));
  const json = await command(dir, 'control', 'status', '--json');
  expect(json.code).toBe(0);
  const { rows } = JSON.parse(json.stdout) as { rows: Array<{ row: string; text: string }> };
  expect(rows).toHaveLength(7);
  expect(rows[4]).toMatchObject({ row: '동결·몫', text: expect.stringContaining('첫 줄\n둘째 줄\r셋째 줄\u001b[2J') });
  const table = await command(dir, 'control', 'status');
  expect(table.code).toBe(0);
  expect(table.stdout.trim().split(/\r?\n/)).toHaveLength(7);
  expect(table.stdout).toContain('동결·몫 · 주의 · 동결 켬 · 첫 줄\\n둘째 줄\\r셋째 줄\\u001b[2J');
  expect(table.stdout).not.toContain('\u001b');
}, 120_000);

test('control member without a machine join gives the join instruction and rc=2', async () => {
  const result = await command(root(), 'control', 'member', '--once');
  expect(result).toEqual({ code: 2, stdout: '', stderr: '먼저 `elanous control join` 을 치세요\n' });
});

test('control member --once registers a failed probe and resources where reports its loopback bind', async () => {
  const dir = root();
  const { port } = await serve(dir);
  const tokenFile = join(dir, 'member-credential');
  const issued = await command(dir, 'control', 'token', 'issue', 'node-b');
  expect(issued.code).toBe(0);
  writeFileSync(tokenFile, issued.stdout.trim());
  const joined = await command(dir, 'control', 'join', '--url', `http://127.0.0.1:${port}`, '--machine', 'node-b', '--token-file', tokenFile);
  expect(joined.code).toBe(0);
  const result = await command(dir, 'control', 'member', '--once', '--resource', 'image:registry=http://127.0.0.1:1',
    '--resource', 'image:mirror=http://127.0.0.1:2', '--resource', 'image:tail6=http://[fd7a:115c:a1e0::42]:1', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ machine: 'node-b', resources: [
    { kind: 'image', name: 'registry', reachable: false, bind: 'loopback' },
    { kind: 'image', name: 'mirror', reachable: false, bind: 'loopback' },
    { kind: 'image', name: 'tail6', reachable: false, bind: 'tailnet' },
  ] });
  const onceTable = await command(dir, 'control', 'member', '--once', '--resource', 'image:registry=http://127.0.0.1:1');
  expect(onceTable.code).toBe(0);
  expect(onceTable.stdout).toContain('image · registry · http://127.0.0.1:1/ · loopback · false');
  const found = await command(dir, 'resources', 'where', 'registry', '--json');
  expect(found.code).toBe(0);
  expect(JSON.parse(found.stdout).resources).toMatchObject([{ machine: 'node-b', kind: 'image', name: 'registry', attrs: { reachable: false, bind: 'loopback' } }]);
  const table = await command(dir, 'resources', 'where', 'registry');
  expect(table.stdout).toContain('image · registry · node-b · http://127.0.0.1:1/');
  expect(table.stdout).toContain(' · loopback');
  const tail6 = await command(dir, 'resources', 'where', 'tail6', '--json');
  expect(tail6.code).toBe(0);
  expect(JSON.parse(tail6.stdout).resources).toMatchObject([{ machine: 'node-b', kind: 'image', name: 'tail6', attrs: { reachable: false, bind: 'tailnet' } }]);
  expect(result.stdout + result.stderr + onceTable.stdout + onceTable.stderr + found.stdout + found.stderr + table.stdout + table.stderr).not.toContain(issued.stdout.trim());
}, 20_000);

test('control member stays foreground and heartbeats until SIGTERM', async () => {
  const dir = root();
  const { port } = await serve(dir);
  const issued = await command(dir, 'control', 'token', 'issue', 'node-b');
  const tokenFile = join(dir, 'credential');
  writeFileSync(tokenFile, issued.stdout.trim());
  expect((await command(dir, 'control', 'join', '--url', `http://127.0.0.1:${port}`, '--machine', 'node-b', '--token-file', tokenFile)).code).toBe(0);
  const child = launch(dir, 'control', 'member', '--interval', '0.05', '--resource', 'image:registry=http://127.0.0.1:1');
  try {
    let found = false;
    for (let n = 0; n < 100; n++) {
      const rows = await fetch(`http://127.0.0.1:${port}/v1/resources`, { headers: { authorization: `Bearer ${issued.stdout.trim()}` } });
      const data = await rows.json() as { resources: Array<{ kind: string; name: string }> };
      if (data.resources.some(row => row.kind === 'image' && row.name === 'registry')) { found = true; break; }
      await Bun.sleep(50);
    }
    expect(found).toBe(true);
    const resourceUrl = `http://127.0.0.1:${port}/v1/resources?machine=node-b&name=registry`;
    const headers = { authorization: `Bearer ${issued.stdout.trim()}` };
    const initial = await (await fetch(resourceUrl, { headers })).json() as { resources: Array<{ observedAt: number }> };
    const firstObservedAt = initial.resources[0]!.observedAt;
    let heartbeat = false;
    for (let n = 0; n < 100; n++) {
      await Bun.sleep(50);
      const next = await (await fetch(resourceUrl, { headers })).json() as { resources: Array<{ observedAt: number }> };
      if (next.resources[0]!.observedAt > firstObservedAt) { heartbeat = true; break; }
    }
    expect(heartbeat).toBe(true);
    expect(child.exitCode).toBeNull();
  } finally { child.kill('SIGTERM'); expect(await child.exited).toBe(0); }
}, 20_000);

test('empty control port environment falls back to the default (not ephemeral)', async () => {
  const result = await command(root(), 'resources', 'list', '--json');
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(`관제부에 닿지 못함(http://127.0.0.1:${DEFAULT_CONTROL_PORT}/v1/resources · `);
  expect(result.stdout).toBe('');
});

test('real CLI help reaches both registered command groups', async () => {
  const dir = root();
  const control = await command(dir, 'control', '--help');
  const resources = await command(dir, 'resources', '--help');
  expect(control.code).toBe(0);
  expect(control.stdout).toContain('serve');
  expect(control.stdout).toContain('join');
  expect(control.stdout).toContain('token');
  const serveHelp = await command(dir, 'control', 'serve', '--help');
  expect(serveHelp.stdout).toContain('--host <addr>');
  expect(serveHelp.stdout).toContain('--follow-lease');
  expect(serveHelp.stdout).toContain('--bucket <bucket>');
  const joinHelp = await command(dir, 'control', 'join', '--help');
  expect(joinHelp.stdout).toContain('--machine <name>');
  expect(joinHelp.stdout).toContain('--token-file <path>');
  expect(joinHelp.stdout).toContain('--token-stdin');
  expect(joinHelp.stdout).not.toMatch(/--(?:admin|member|query)-token/);
  expect(resources.code).toBe(0);
  expect(resources.stdout).toContain('where');
  expect(resources.stdout).toContain('list');
});

test('control serve --host forwards a permitted host and rejects a public bind before startup', async () => {
  const dir = root();
  const invalid = await command(dir, 'control', 'serve', '--host', '0.0.0.0', '--port', '0');
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain('invalid control hostname');
  expect(invalid.stdout).toBe('');
  const child = launch(dir, 'control', 'serve', '--host', '127.0.0.1', '--port', '0');
  const reader = child.stdout.getReader();
  try {
    const line = await Promise.race([reader.read(), Bun.sleep(15_000).then(() => { throw new Error('startup timeout'); })]);
    expect(new TextDecoder().decode(line.value)).toContain('관제부 127.0.0.1:');
  } finally { reader.releaseLock(); child.kill('SIGTERM'); await child.exited; }
});

test('control token issue outputs the secret once; replacement, list and revoke never reveal it', async () => {
  const dir = root();
  const issued = await command(dir, 'control', 'token', 'issue', 'node-b');
  expect(issued.code).toBe(0);
  expect(issued.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  const first = issued.stdout.trim();
  const listed = await command(dir, 'control', 'token', 'list');
  expect(listed.code).toBe(0);
  expect(listed.stdout).toMatch(/^node-b · \d{4}-\d\d-\d\dT.*Z\n$/);
  const replaced = await command(dir, 'control', 'token', 'issue', 'node-b');
  expect(replaced.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  expect(replaced.stdout).not.toBe(issued.stdout);
  const revoked = await command(dir, 'control', 'token', 'revoke', 'node-b');
  expect(revoked.code).toBe(0);
  expect(revoked.stdout).toBe('');
  const empty = await command(dir, 'control', 'token', 'list');
  expect(empty.stdout).toBe('');
  const output = listed.stdout + listed.stderr + replaced.stderr + revoked.stdout + revoked.stderr + empty.stdout + empty.stderr;
  expect(output).not.toContain(first);
  expect(output).not.toContain(replaced.stdout.trim());
  const invalid = await command(dir, 'control', 'token', 'issue', '../escape');
  expect(invalid.code).toBe(2);
  expect(invalid.stdout).toBe('');
}, 20_000);

test('real CLI serves in foreground, stops on SIGTERM, and query token is required', async () => {
  const dir = root();
  const { child, port } = await serve(dir);
  const url = `http://127.0.0.1:${port}/v1/resources`;
  expect((await fetch(url)).status).toBe(401);
  const query = ensureControlTokens(dir).query;
  expect((await fetch(url, { headers: { Authorization: `Bearer ${query}` } })).status).toBe(200);
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  await expect(fetch(url)).rejects.toThrow();
});

test('real CLI --follow-lease reports its bucket and keeps serving when GCS cannot be read', async () => {
  const dir = root();
  const child = Bun.spawn([process.execPath, entry, `--test=${dir}`, 'control', 'serve', '--port', '0', '--follow-lease', '--bucket', 'gs://example-bucket'], {
    cwd, env: { ...process.env, PATH: '/usr/bin:/bin', HOME: dir, ELANOUS_CONTROL_PORT: '', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  const reader = child.stdout.getReader();
  try {
    const line = await Promise.race([
      reader.read().then(result => new TextDecoder().decode(result.value)),
      Bun.sleep(15_000).then(() => { throw new Error('follow-lease startup timeout'); }),
    ]);
    expect(line).toContain('임대 따름 · gs://example-bucket · 나=');
    const port = /관제부 127\.0\.0\.1:(\d+)/.exec(line)![1]!;
    const primary = await fetch(`http://127.0.0.1:${port}/v1/primary`, { signal: AbortSignal.timeout(30_000) });
    expect(primary.status).toBe(200);
    expect(await primary.json()).toEqual({ holder: null, generation: null, known: false });
    const denied = await fetch(`http://127.0.0.1:${port}/v1/resources/register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ensureControlTokens(dir).member}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'unmeasured', kind: 'instance', machine: 'mbp', name: 'unmeasured', attrs: {}, ttlMs: 30_000 }),
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: 'not-primary', holder: null, generation: null });
    expect(child.exitCode).toBeNull();
  } finally { reader.releaseLock(); child.kill('SIGTERM'); await child.exited; }
}, 45_000);

test('control serve follows the lease only when opted in', async () => {
  const dir = root();
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const logs: string[] = [];
  const log = spyOn(console, 'log').mockImplementation(line => { logs.push(String(line)); });
  let readCount = 0;
  let holder = 'node-b';
  const read = async () => { readCount++; return { kind: 'present' as const, doc: { holder, generation: holder === 'mbp' ? 8 : 7, state: 'held' as const, renewedAt: 123 } }; };
  const register = (port: string) => fetch(`http://127.0.0.1:${port}/v1/resources/register`, {
    method: 'POST', headers: { Authorization: `Bearer ${ensureControlTokens(dir).member}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'i1', kind: 'instance', machine: 'mbp', name: 'demo', attrs: {}, ttlMs: 30000 }),
  });
  // ⛔ process.emit('SIGTERM') 를 쓰지 않는다 — 같은 러너의 로그 저장소 처리기가 진짜 SIGTERM 을 자기에게 다시 보내 러너가 죽는다.
  const launchInProcess = async (followLease: boolean) => {
    const controller = new AbortController();
    const active = runControlServe({ port: '0', followLease, bucket: followLease ? 'gs://example-bucket' : 'ignored-without-follow-lease', read, machine: 'mbp', signal: controller.signal });
    const stop = async () => { controller.abort(); await active; };
    try {
      for (let n = 0; n < 100 && logs.length === 0; n++) await Bun.sleep(10);
      const line = logs.shift()!;
      expect(line).toContain('관제부 127.0.0.1:');
      return { active, stop, port: /관제부 127\.0\.0\.1:(\d+)/.exec(line)![1]!, line };
    } catch (error) { await stop(); throw error; }
  };
  try {
    const followed = await launchInProcess(true);
    try {
      expect(followed.line).toContain('임대 따름 · gs://example-bucket · 나=mbp');
      const primary = await fetch(`http://127.0.0.1:${followed.port}/v1/primary`);
      expect(await primary.json()).toEqual({ holder: 'node-b', generation: 7, known: true });
      expect(primary.headers.get('x-primary-generation')).toBe('7');
      const denied = await register(followed.port);
      expect(denied.status).toBe(409);
      expect(denied.headers.get('x-primary-generation')).toBe('7');
      expect(await denied.json()).toEqual({ error: 'not-primary', holder: 'node-b', generation: 7 });
      expect(readCount).toBeGreaterThan(0);
      holder = 'mbp';
      await Bun.sleep(10_050);
      const accepted = await register(followed.port);
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get('x-primary-generation')).toBe('8');
      expect((await accepted.json() as { name: string }).name).toBe('demo');
    } finally { await followed.stop(); }
    const legacy = await launchInProcess(false);
    try {
      expect(legacy.line).not.toContain('임대 따름');
      const allowed = await register(legacy.port);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('x-primary-generation')).toBeNull();
      expect((await allowed.json() as { name: string }).name).toBe('demo');
      expect(readCount).toBe(2);
    } finally { await legacy.stop(); }
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
}, 15_000);

test('real CLI also stops on SIGINT', async () => {
  const { child, port } = await serve(root());
  child.kill('SIGINT');
  expect(await child.exited).toBe(0);
  await expect(fetch(`http://127.0.0.1:${port}/v1/resources`)).rejects.toThrow();
});

test('member registration is visible through where and list; JSON final line includes ageMs', async () => {
  const dir = root();
  const { port } = await serve(dir);
  const tokens = ensureControlTokens(dir);
  const response = await fetch(`http://127.0.0.1:${port}/v1/resources/register`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.member}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'i1', kind: 'instance', machine: 'local', name: 'demo', endpoint: 'http://local', attrs: {}, ttlMs: 30000 }),
  });
  expect(response.status).toBe(200);
  const found = await command(dir, 'resources', 'where', 'demo', '--port', port, '--json');
  expect(found.code).toBe(0);
  expect(found.stdout.trim().split('\n').at(-1)).toBeTruthy();
  const record = JSON.parse(found.stdout.trim().split('\n').at(-1)!) as { resources: Array<{ name: string; ageMs: number }> };
  expect(record.resources).toHaveLength(1);
  expect(record.resources[0]!.name).toBe('demo');
  expect(record.resources[0]!.ageMs).toBeGreaterThanOrEqual(0);
  const byKind = await command(dir, 'resources', 'where', 'instance', '--port', port, '--json');
  expect(JSON.parse(byKind.stdout).resources).toHaveLength(1);
  const list = await command(dir, 'resources', 'list', '--kind', 'instance', '--port', port);
  expect(list.code).toBe(0);
  expect(list.stdout).toMatch(/instance · demo · local · http:\/\/local · \d+ms · false/);
  const unfiltered = await command(dir, 'resources', 'list', '--port', port, '--json');
  expect(unfiltered.code).toBe(0);
  expect(JSON.parse(unfiltered.stdout).resources).toHaveLength(1);
  const absent = await command(dir, 'resources', 'list', '--kind', 'machine', '--port', port, '--json');
  expect(JSON.parse(absent.stdout)).toEqual({ resources: [] });
  for (const token of Object.values(tokens)) {
    expect(found.stdout + found.stderr + list.stdout + list.stderr).not.toContain(token);
  }
}, 20_000);

test('joined Primary CLI queries use its member token without creating local credentials', async () => {
  const dir = root();
  const credential = 'c'.repeat(64);
  const tokenFile = join(dir, 'credential');
  writeFileSync(tokenFile, `${credential}\n`);
  const peer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${credential}`) return new Response(null, { status: 401 });
      return Response.json({ resources: [{ kind: 'instance', name: 'remote-demo', machine: 'peer', ageMs: 4, expired: false }] });
    },
  });
  try {
    for (const flag of ['--admin-token', '--member-token', '--query-token']) {
      const rejected = await command(dir, 'control', 'join', '--url', peer.url.href, '--machine', 'node-b', flag, credential);
      expect(rejected).toEqual({ code: 2, stdout: '', stderr: '토큰은 인자로 받지 않습니다 — `--token-file` 또는 `--token-stdin`\n' });
      expect(rejected.stderr).not.toContain(credential);
      expect(existsSync(join(dir, 'control', 'join.json'))).toBe(false);
    }
    const joined = await command(dir, 'control', 'join', '--url', peer.url.href, '--machine', 'node-b', '--token-file', tokenFile);
    expect(joined.code).toBe(0);
    expect(joined.stdout).toBe(`Joined ${peer.url.origin} as node-b\n`);
    expect(joined.stdout + joined.stderr).not.toContain(credential);
    expect(JSON.parse(readFileSync(join(dir, 'control', 'join.json'), 'utf8'))).toEqual({ url: peer.url.href, machine: 'node-b', token: credential });
    expect(statSync(join(dir, 'control', 'join.json')).mode & 0o777).toBe(0o600);
    const found = await command(dir, 'resources', 'where', 'remote-demo', '--json');
    expect(found.code).toBe(0);
    expect(JSON.parse(found.stdout).resources).toMatchObject([{ name: 'remote-demo', machine: 'peer' }]);
    const list = await command(dir, 'resources', 'list', '--json');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).resources).toHaveLength(1);
    expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
    expect(found.stdout + found.stderr + list.stdout + list.stderr).not.toContain(credential);
  } finally { peer.stop(true); }
}, 20_000);

test('explicit Primary URL does not send a joined token to another address', async () => {
  const dir = root();
  const joinedPeer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ resources: [] }) });
  const requests: Array<string | null> = [];
  const targetPeer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      requests.push(req.headers.get('authorization'));
      return Response.json({ resources: [] });
    },
  });
  try {
    const credential = join(dir, 'credential');
    writeFileSync(credential, 'c'.repeat(64));
    expect((await command(dir, 'control', 'join', '--url', joinedPeer.url.href, '--machine', 'node-b', '--token-file', credential)).code).toBe(0);
    const denied = await command(dir, 'resources', 'list', '--primary-url', targetPeer.url.href, '--json');
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('관제부 query 토큰 없음');
    expect(denied.stdout).toBe('');
    expect(requests).toEqual([]);
    expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
    const allowed = await command(dir, 'resources', 'list', '--primary-url', targetPeer.url.href, '--query-token', 'd'.repeat(64), '--json');
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ resources: [] });
    expect(requests).toEqual([`Bearer ${'d'.repeat(64)}`]);
    expect(allowed.stdout + allowed.stderr).not.toContain('d'.repeat(64));
  } finally { joinedPeer.stop(true); targetPeer.stop(true); }
});

test('real join accepts a member token on stdin', async () => {
  const dir = root();
  const credential = 'f'.repeat(64);
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    expect(req.url).toBe(`${peer.url.href}v1/resources?machine=node-b`);
    expect(req.headers.get('authorization')).toBe(`Bearer ${credential}`);
    return Response.json({ resources: [] });
  } });
  try {
    const child = Bun.spawn(['bun', entry, `--test=${dir}`, 'control', 'join', '--url', peer.url.href, '--machine', 'node-b', '--token-stdin'], {
      cwd, env: { ...process.env, ELANOUS_CONTROL_PORT: '', ELANOUS_SUPPRESS_XDG_WARNING: '1' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    children.push(child);
    child.stdin.write(`${credential}\n`);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout).toBe(`Joined ${peer.url.origin} as node-b\n`);
    expect(stdout + stderr).not.toContain(credential);
    expect(JSON.parse(readFileSync(join(dir, 'control', 'join.json'), 'utf8'))).toEqual({ url: peer.url.href, machine: 'node-b', token: credential });
  } finally { peer.stop(true); }
});

test('real join refuses argv tokens and failed validation writes no file or stack trace', async () => {
  const dir = root();
  const credential = 'e'.repeat(64);
  const tokenFile = join(dir, 'credential');
  writeFileSync(tokenFile, credential);
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(credential, { status: 401, statusText: credential }) });
  try {
    const failed = await command(dir, 'control', 'join', '--url', peer.url.href, '--machine', 'node-b', '--token-file', tokenFile);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toMatch(/^합류 실패: [^\n]+\n$/);
    expect(failed.stderr).not.toMatch(/at |Bun v/);
    expect(failed.stderr).not.toContain(credential);
    expect(existsSync(join(dir, 'control', 'join.json'))).toBe(false);
  } finally { peer.stop(true); }
});

test('a peer cannot reflect the query token through resource output', async () => {
  const dir = root();
  const query = ensureControlTokens(dir).query;
  const resource = { id: 'i1', kind: 'instance', machine: 'local', name: query, endpoint: query, ageMs: 0, expired: false };
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ resources: [resource] }) });
  try {
    for (const args of [['resources', 'list', '--json'], ['resources', 'list']]) {
      const result = await command(dir, ...args, '--port', String(peer.port));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[redacted]');
      expect(result.stdout + result.stderr).not.toContain(query);
    }
  } finally { peer.stop(true); }
}, 15_000);

test('an HTTP failure cannot echo a query token supplied in the peer status text', async () => {
  const dir = root();
  const query = ensureControlTokens(dir).query;
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503, statusText: query }) });
  try {
    const result = await command(dir, 'resources', 'list', '--port', String(peer.port), '--json');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('HTTP 503');
    expect(result.stdout + result.stderr).not.toContain(query);
    expect(result.stdout).toBe('');
  } finally { peer.stop(true); }
});

test('unreachable listener emits address and reason, not empty resources; explicit port overrides environment', async () => {
  const dir = root();
  const unused = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = String(unused.port);
  unused.stop(true);
  const failed = await command(dir, 'resources', 'list', '--port', port, '--json');
  expect(failed.code).toBe(2);
  expect(failed.stderr).toContain(`관제부에 닿지 못함(http://127.0.0.1:${port}/v1/resources · `);
  expect(failed.stderr).toMatch(/관제부에 닿지 못함\(http:\/\/127\.0\.0\.1:\d+\/v1\/resources · .+\)/);
  expect(failed.stdout).toBe('');
  expect(failed.stderr).not.toContain('resources":[]');
  const { port: livePort } = await serve(dir);
  const envCommand = Bun.spawn(['bun', entry, `--test=${dir}`, 'resources', 'list', '--json'], {
    cwd, env: { ...process.env, ELANOUS_CONTROL_PORT: livePort }, stdout: 'pipe', stderr: 'pipe',
  });
  children.push(envCommand);
  const [envCode, envOut] = await Promise.all([envCommand.exited, new Response(envCommand.stdout).text()]);
  expect(envCode).toBe(0);
  expect(JSON.parse(envOut)).toEqual({ resources: [] });
  const explicitCommand = Bun.spawn(['bun', entry, `--test=${dir}`, 'resources', 'list', '--port', livePort, '--json'], {
    cwd, env: { ...process.env, ELANOUS_CONTROL_PORT: port }, stdout: 'pipe', stderr: 'pipe',
  });
  children.push(explicitCommand);
  const [explicitCode, explicitOut] = await Promise.all([explicitCommand.exited, new Response(explicitCommand.stdout).text()]);
  expect(explicitCode).toBe(0);
  expect(JSON.parse(explicitOut)).toEqual({ resources: [] });
});
