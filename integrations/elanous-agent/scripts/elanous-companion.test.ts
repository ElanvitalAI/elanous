import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const plugin = resolve(import.meta.dir, '..');
const cli = join(import.meta.dir, 'elanous-companion.mjs');
// macOS: tmpdir() is /var/… but processes see /private/var/… — compare real paths.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-companion-')));
const project = join(tmp, 'project');
const data = join(tmp, 'data');
const configDir = join(tmp, 'config');
const root = join(tmp, 'root');
const calls = join(tmp, 'calls.jsonl');
const fake = join(tmp, 'elanous');
mkdirSync(project);
mkdirSync(configDir);
mkdirSync(join(root, 'nexus'), { recursive: true });
writeFileSync(join(configDir, 'acp-token'), 'secret-token\n');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'where') { console.log(JSON.stringify({ configDir: process.env.FAKE_CONFIG, root: process.env.FAKE_ROOT })); process.exit(0); }
if (args[0] === '--tool-cwd' && args.at(-1) === 'legacy') { console.error("error: unknown option '--tool-cwd'"); process.exit(1); }
if (args.includes('agent')) {
  const text = args.at(-1);
  if (text === 'legacy' && args[0] === 'agent') fs.writeFileSync(process.env.FAKE_AGENT_CWD, process.cwd());
  const respond = () => console.log(JSON.stringify({sessionId:'s1',reply:'ok ' + text}));
  if (text === 'broken') { console.error('fake failure'); process.exit(2); }
  if (text === 'no-retry') { console.error('another error'); process.exit(2); }
  if (text === 'cancel-me') fs.writeFileSync(process.env.FAKE_CHILD_PID, String(process.pid));
  if (text === 'slow' || text === 'cancel-me' || text === 'keep-me') setTimeout(respond, text === 'slow' ? 550 : 4000);
  else respond();
}
`, { mode: 0o755 });
// The runner may itself be inside a Claude session — never inherit its session id.
const { CLAUDE_CODE_SESSION_ID: _outerSession, ELANOUS_COMPANION_SESSION_ID: _outerCompanion, CLAUDE_ENV_FILE: _outerEnvFile, ...outerEnv } = process.env;
const env = {
  ...outerEnv,
  ELANOUS_BIN: fake,
  CLAUDE_PLUGIN_DATA: data,
  CLAUDE_PROJECT_DIR: project,
  FAKE_CALLS: calls,
  FAKE_CONFIG: configDir,
  FAKE_ROOT: root,
  FAKE_CHILD_PID: join(tmp, 'agent-child.pid'),
  FAKE_AGENT_CWD: join(tmp, 'agent-cwd'),
};
const run = (...args: string[]) => spawnSync('node', [cli, ...args], { env, cwd: tmp, encoding: 'utf8', timeout: 5000 });
const checked = (...args: string[]) => {
  const out = run(...args);
  expect(out.status).toBe(0);
  return out.stdout.trim();
};
const recorded = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const poll = async (id: string, desired: string) => {
  for (let i = 0; i < 60; i++) {
    const value = JSON.parse(checked('status', id, '--json'));
    if (value.status === desired) return value;
    await pause(50);
  }
  throw new Error(`Job ${id} did not reach ${desired}`);
};
let server: ReturnType<typeof Bun.serve>;
const approvals: { url: string; method: string; authorization: string | null }[] = [];
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch(req) {
    approvals.push({ url: new URL(req.url).pathname, method: req.method, authorization: req.headers.get('authorization') });
    return new Response('approved');
  } });
  writeFileSync(join(root, 'nexus', 'runtime.json'), JSON.stringify({ httpPort: server.port }));
});
afterAll(() => { server?.stop(true); rmSync(tmp, { recursive: true, force: true }); });

describe('elanous companion CLI', () => {
  test('task injects project tool cwd and returns reply or JSON', () => {
    expect(checked('task', 'hello')).toBe('ok hello');
    expect(recorded().at(-1)).toEqual(['--tool-cwd', project, 'agent', '--json', 'hello']);
    expect(JSON.parse(checked('task', '--json', 'json-text'))).toMatchObject({ sessionId: 's1', reply: 'ok json-text' });
    expect(checked('task', '--', '--verbatim')).toBe('ok --verbatim');
    expect(recorded().at(-1)?.at(-1)).toBe('--verbatim');
    const original = 'keep  two spaces; $(do not execute)';
    expect(checked('task', '--', original)).toBe(`ok ${original}`);
    expect(recorded().at(-1)?.at(-1)).toBe(original);
  });
  test('legacy agent parser retries from project cwd only on unknown tool-cwd', () => {
    expect(checked('task', 'legacy')).toBe('ok legacy');
    expect(recorded().slice(-2)).toEqual([
      ['--tool-cwd', project, 'agent', '--json', 'legacy'],
      ['agent', '--json', 'legacy'],
    ]);
    expect(readFileSync(env.FAKE_AGENT_CWD, 'utf8')).toBe(project);
    const before = recorded().length;
    expect(run('task', 'no-retry').status).not.toBe(0);
    expect(recorded().length).toBe(before + 1);
  });
  test('task uses process cwd when CLAUDE_PROJECT_DIR is missing', () => {
    const fallback = spawnSync('node', [cli, 'task', 'fallback'], {
      env: { ...env, CLAUDE_PROJECT_DIR: '' }, cwd: tmp, encoding: 'utf8', timeout: 5000,
    });
    expect(fallback.status).toBe(0);
    expect(fallback.stdout.trim()).toBe('ok fallback');
    expect(recorded().at(-1)).toEqual(['--tool-cwd', tmp, 'agent', '--json', 'fallback']);
  });
  test('resume-last reuses workspace session and fresh creates a new one', () => {
    expect(checked('task', 'session-seed')).toBe('ok session-seed');
    expect(checked('task', '--resume-last', 'again')).toBe('ok again');
    expect(recorded().at(-1)).toEqual(['--tool-cwd', project, 'agent', '--json', '--session', 's1', 'again']);
    expect(checked('task', '--fresh', 'new')).toBe('ok new');
    expect(recorded().at(-1)).toEqual(['--tool-cwd', project, 'agent', '--json', '--new', 'new']);
  });
  test('background status running to done; result uses last id', async () => {
    const id = checked('task', '--background', 'slow');
    expect(id).toMatch(/^job-[0-9]+-[a-f0-9]+$/);
    expect(JSON.parse(checked('status', id, '--json')).status).toBe('running');
    const done = await poll(id, 'done');
    expect(done.result.reply).toBe('ok slow');
    expect(done.pid).toBeGreaterThan(0);
    expect(done.startedAt).toBeTruthy();
    expect(done.finishedAt).toBeTruthy();
    expect(existsSync(join(data, 'state'))).toBe(true);
    expect(checked('result')).toBe('ok slow');
    expect(JSON.parse(checked('result', id, '--json')).reply).toBe('ok slow');
    expect(recorded().some(a => a.includes('slow') && a[0] === '--tool-cwd' && a[1] === project)).toBe(true);
  });
  test('background failure exposes failed state and error', async () => {
    const id = checked('task', '--background', 'broken');
    const failed = await poll(id, 'failed');
    expect(failed.error).toBe('fake failure');
    expect(failed.finishedAt).toBeTruthy();
    expect(run('result', id).status).not.toBe(0);
  });
  test('cancel terminates background process group and preserves cancelled status', async () => {
    const id = checked('task', '--background', 'cancel-me');
    const status = JSON.parse(checked('status', id, '--json'));
    expect(status.status).toBe('running');
    for (let attempt = 0; !existsSync(env.FAKE_CHILD_PID) && attempt < 40; attempt++) await pause(25);
    expect(existsSync(env.FAKE_CHILD_PID)).toBe(true);
    const agentPid = Number(readFileSync(env.FAKE_CHILD_PID, 'utf8'));
    expect(checked('cancel', id)).toBe(`${id}: cancelled`);
    expect(JSON.parse(checked('status', id, '--json')).status).toBe('cancelled');
    await pause(100);
    for (const pid of [status.pid, agentPid]) {
      const live = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      expect(live.stdout.trim() === '' || live.stdout.trim().startsWith('Z')).toBe(true);
    }
  });
  test('approve uses where location and sends exactly one bearer POST', async () => {
    const bad = run('approve', 'task:abc; touch pwned');
    expect(bad.status).not.toBe(0);
    expect(approvals).toEqual([]);
    const child = Bun.spawn(['node', cli, 'approve', 'task:0123456789ab'], { env, cwd: tmp, stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(stdout.trim()).toBe('approved');
    expect(recorded().at(-1)).toEqual(['where', '--json']);
    expect(approvals).toEqual([{ url: '/v1/tasks/task%3A0123456789ab/approve', method: 'POST', authorization: 'Bearer secret-token' }]);
  });
  test('SessionStart hands the session id to later Bash calls; SessionEnd only cleans finished jobs of that session', async () => {
    const envFile = join(tmp, 'claude-env');
    writeFileSync(envFile, '');
    const start = spawnSync('node', [cli, 'hook', 'session-start'], { env: { ...env, CLAUDE_ENV_FILE: envFile }, input: '{"session_id":"hook-owner"}', encoding: 'utf8' });
    expect(start.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain('export ELANOUS_COMPANION_SESSION_ID=hook-owner');
    const bad = spawnSync('node', [cli, 'hook', 'session-start'], { env: { ...env, CLAUDE_ENV_FILE: envFile }, input: '{"session_id":"x; rm -rf /"}', encoding: 'utf8' });
    expect(bad.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).not.toContain('rm -rf');
    const as = (session: string | null, text: string) => {
      const r = spawnSync('node', [cli, 'task', '--background', text], {
        env: session ? { ...env, ELANOUS_COMPANION_SESSION_ID: session } : env, cwd: tmp, encoding: 'utf8', timeout: 5000,
      });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    const doneId = as('hook-owner', 'slow');
    const runningId = as('hook-owner', 'keep-me');
    const otherId = as('other-owner', 'slow');
    const unownedId = as(null, 'slow');
    await poll(doneId, 'done');
    await poll(otherId, 'done');
    expect((await poll(unownedId, 'done')).session ?? null).toBe(null);
    const end = spawnSync('node', [cli, 'hook', 'session-end'], { env, input: '{"session_id":"hook-owner"}', encoding: 'utf8' });
    expect(end.status).toBe(0);
    expect(run('status', doneId).status).not.toBe(0);
    expect(JSON.parse(checked('status', otherId, '--json')).status).toBe('done');
    expect(JSON.parse(checked('status', unownedId, '--json')).status).toBe('done');
    const stillRunning = JSON.parse(checked('status', runningId, '--json'));
    expect(stillRunning.status).toBe('running');
    expect(spawnSync('ps', ['-o', 'stat=', '-p', String(stillRunning.pid)], { encoding: 'utf8' }).stdout.trim()).not.toBe('');
    checked('cancel', runningId);
  });
  test('status and result with no job yet exit 0 with a plain message', () => {
    const fresh = { ...env, CLAUDE_PROJECT_DIR: join(tmp, 'empty-project') };
    mkdirSync(fresh.CLAUDE_PROJECT_DIR, { recursive: true });
    for (const cmd of ['status', 'result']) {
      const r = spawnSync('node', [cli, cmd], { env: fresh, cwd: tmp, encoding: 'utf8', timeout: 5000 });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('No elanous background jobs in this workspace yet.');
    }
    expect(JSON.parse(spawnSync('node', [cli, 'status', '--json'], { env: fresh, cwd: tmp, encoding: 'utf8' }).stdout)).toEqual({ status: 'none' });
  });
  test('task --stdin takes the request as data, never as shell words', () => {
    const r = spawnSync('node', [cli, 'task', '--stdin'], { env, cwd: tmp, input: "it's $(echo pwned) ; `id`\n", encoding: 'utf8', timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok it's $(echo pwned) ; `id`");
    expect(recorded().at(-1)?.at(-1)).toBe("it's $(echo pwned) ; `id`");
    expect(spawnSync('node', [cli, 'task', '--stdin', 'extra'], { env, cwd: tmp, input: 'x', encoding: 'utf8' }).status).not.toBe(0);
  });
  test('interleaved sessions preserve the caller-owned job when the other session ends', async () => {
    const hookFor = (kind: string, session: string) => spawnSync('node', [cli, 'hook', kind], {
      env: { ...env, CLAUDE_CODE_SESSION_ID: session },
      input: JSON.stringify({ session_id: session }), encoding: 'utf8', timeout: 5000,
    });
    const taskFor = (session: string) => spawnSync('node', [cli, 'task', '--background', 'slow'], {
      env: { ...env, CLAUDE_CODE_SESSION_ID: session }, cwd: tmp, encoding: 'utf8', timeout: 5000,
    });
    expect(hookFor('session-start', 'session-A').status).toBe(0);
    expect(hookFor('session-start', 'session-B').status).toBe(0);
    const a = taskFor('session-A');
    expect(a.status).toBe(0);
    const aId = a.stdout.trim();
    const b = taskFor('session-B');
    expect(b.status).toBe(0);
    const bId = b.stdout.trim();
    expect((await poll(aId, 'done')).session).toBe('session-A');
    expect((await poll(bId, 'done')).session).toBe('session-B');
    expect(hookFor('session-end', 'session-B').status).toBe(0);
    expect(run('status', bId).status).not.toBe(0);
    expect(checked('result', aId)).toBe('ok slow');
    expect(hookFor('session-end', 'session-A').status).toBe(0);
    expect(run('status', aId).status).not.toBe(0);
  });
  test('Claude command and hook contracts', () => {
    for (const name of ['ask', 'status', 'result', 'cancel', 'approve']) {
      const content = readFileSync(join(plugin, 'commands', `${name}.md`), 'utf8');
      expect(content).toMatch(/^---\ndescription: .+/);
      expect(content).toContain('argument-hint:');
      expect(content).toContain('allowed-tools:');
      if (name !== 'ask') {
        expect(content).toContain('disable-model-invocation: true');
        // No pre-run shell command carries the user's arguments; ids are checked before any Bash call.
        expect(content).not.toContain('!`');
        expect(content).toContain(name === 'approve' ? '^task:[0-9a-f]{12}$' : '^job-[0-9]+-[a-f0-9]+$');
      }
    }
    const ask = readFileSync(join(plugin, 'commands', 'ask.md'), 'utf8');
    expect(ask).toContain('elanous:elanous-delegate');
    expect(ask).toContain('allowed-tools: Task');
    expect(ask).toContain('--background');
    expect(ask).toContain('--wait');
    expect(ask).toContain('$ARGUMENTS');
    const delegate = readFileSync(join(plugin, 'agents', 'elanous-delegate.md'), 'utf8');
    expect(delegate).toContain('tools: Bash');
    expect(delegate).toContain('exactly once');
    expect(delegate).toContain("--stdin <<'ELANOUS_REQUEST_END'");
    for (const name of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json']) {
      expect(JSON.parse(readFileSync(join(plugin, name), 'utf8'))).toBeTruthy();
    }
    const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    for (const [event, kind] of [['SessionStart', 'session-start'], ['SessionEnd', 'session-end']]) {
      expect(hooks.hooks[event][0].hooks[0]).toMatchObject({ type: 'command', timeout: 5 });
      expect(hooks.hooks[event][0].hooks[0].command).toContain(`hook ${kind}`);
    }
    expect(readdirSync(join(plugin, 'agents'))).toContain('elanous-delegate.md');
    // V2 — codex/grok/agy skill: finds the companion relative to itself and never passes the request as shell words.
    const skill = readFileSync(join(plugin, 'skills', 'elanous', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: elanous\ndescription: "MUST USE when/);
    expect(skill).toContain('Triggers:');
    expect(skill).toContain('../../scripts/elanous-companion.mjs');
    expect(skill).toContain("--stdin <<'ELANOUS_REQUEST_END'");
    expect(existsSync(join(plugin, 'skills', 'elanous', '..', '..', 'scripts', 'elanous-companion.mjs'))).toBe(true);
    expect(skill).toContain('^job-[0-9]+-[a-f0-9]+$');
  });
});
