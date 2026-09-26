import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONTROL_PORT, ensureControlTokens } from '../control-plane/server.js';

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
    cwd, env: { ...process.env, ELANOUS_CONTROL_PORT: '' }, stdout: 'pipe', stderr: 'pipe',
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
  expect(control.stdout).toContain('token');
  const serveHelp = await command(dir, 'control', 'serve', '--help');
  expect(serveHelp.stdout).toContain('--host <addr>');
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
