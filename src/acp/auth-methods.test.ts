import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ACP_LOGIN_ARG, ACP_LOGIN_METHOD_ID, acpAuthMethods, currentLaunch } from './auth-methods.js';

const launch = { command: '/usr/local/bin/bun', args: ['/opt/elanous/bin/elanous.mjs'] };

test('a terminal-capable client gets a terminal method that re-launches the agent with --login', () => {
  expect(acpAuthMethods({ auth: { terminal: true } }, launch)).toEqual([
    { type: 'terminal', id: ACP_LOGIN_METHOD_ID, name: 'Sign in to elanous', description: expect.any(String), args: [ACP_LOGIN_ARG] },
  ]);
});

test('an older client gets an agent method with the Zed terminal-auth meta pointing at elanous login', () => {
  for (const client of [undefined, null, {}, { auth: { terminal: false } }]) {
    const [method] = acpAuthMethods(client, launch);
    expect(method).toMatchObject({ id: ACP_LOGIN_METHOD_ID, _meta: { 'terminal-auth': { command: '/usr/local/bin/bun', args: ['/opt/elanous/bin/elanous.mjs', 'login', 'openai-codex'], label: 'elanous login' } } });
    expect('type' in method!).toBe(false);
    expect(method!.description).toContain('elanous login openai-codex');
  }
});

test('the launch is bun plus the script, or the binary alone', () => {
  expect(currentLaunch(['/b/bun', '/x/bin/elanous.mjs', '--acp-server'], '/b/bun')).toEqual({ command: '/b/bun', args: ['/x/bin/elanous.mjs'] });
  expect(currentLaunch(['/usr/local/bin/elanous', '--acp-server'], '/usr/local/bin/elanous')).toEqual({ command: '/usr/local/bin/elanous', args: [] });
});

test('the real ACP server answers initialize with the terminal method for a terminal client and the meta method otherwise', async () => {
  const root = join(import.meta.dir, '../..');
  const authOf = async (clientCapabilities: Record<string, unknown>) => {
    const proc = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', '--acp-server'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', ELANOUS_TOOL_CWD: '' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities } })}\n`);
    proc.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        new Response(proc.stdout).text(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { proc.kill(); reject(new Error('ACP stdio timeout')); }, 30_000); }),
      ]);
      const line = out.split('\n').find((l) => l.includes('"id":1'))!;
      return (JSON.parse(line) as { result: { authMethods: Array<Record<string, unknown>> } }).result.authMethods;
    } finally { if (timer) clearTimeout(timer); }
  };
  expect(await authOf({ auth: { terminal: true } })).toEqual([expect.objectContaining({ type: 'terminal', id: ACP_LOGIN_METHOD_ID, args: [ACP_LOGIN_ARG] })]);
  const [legacy] = await authOf({});
  expect(legacy).toMatchObject({ id: ACP_LOGIN_METHOD_ID, _meta: { 'terminal-auth': { label: 'elanous login' } } });
  expect((legacy!._meta as { 'terminal-auth': { args: string[] } })['terminal-auth'].args.slice(-2)).toEqual(['login', 'openai-codex']);
}, 80_000);
