import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../..');
const session = '11111111-2222-3333-4444-555555555555';
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-context-hook-'));
  tempDirs.push(dir);
  const fake = join(dir, 'elanous');
  writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$HOOK_ARGV_FILE"\n');
  chmodSync(fake, 0o755);
  const argvFile = join(dir, 'argv');
  return { dir, argvFile, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, HOOK_ARGV_FILE: argvFile } };
}

function invoke(hook: string, payload: unknown, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [join(root, 'scripts/context-hooks', hook)], {
    input: JSON.stringify(payload), encoding: 'utf8', env, cwd: root,
  });
}

for (const [hook, tool, summary] of [
  ['claude-stop.sh', undefined, 'Claude Code session stopped'],
  ['post-tool-use.sh', 'Read', 'Claude Code tool Read completed'],
] as const) {
  test(`${hook} passes only bounded metadata to context emit`, () => {
    const { argvFile, env } = fixture();
    const secret = 'sk-ant-api03-SUPERSECRET123456789012345678901';
    const payload = { session_id: session, tool_name: tool, summary: `private ${secret}`,
      prompt: 'PRIVATE_TRANSCRIPT', transcript: 'PRIVATE_TRANSCRIPT', tool_input: { file_path: '/secret/file', content: 'PRIVATE_FILE' },
      tool_response: { content: 'PRIVATE_RESPONSE' } };
    const result = invoke(hook, payload, env);
    expect(result.status).toBe(0);
    const args = readFileSync(argvFile, 'utf8').trimEnd().split('\n');
    expect(args).toEqual(['context', 'emit', '--kind', 'done', '--summary', summary,
      '--source', `elanous://context/claude-code/${session}`]);
    expect(args.join(' ')).not.toMatch(/SUPERSECRET|PRIVATE_|\/secret\/file/);
    expect(args[5]!.length).toBeLessThanOrEqual(200);
    for (const untrustedSummary of ['PRIVATE_FILE', 'checked build status', secret]) {
      expect(invoke(hook, { ...payload, summary: untrustedSummary }, env).status).toBe(0);
    }
    const emitted = readFileSync(argvFile, 'utf8');
    expect(emitted).not.toMatch(/PRIVATE_FILE|checked build status|SUPERSECRET/);
    expect(emitted.trimEnd().split('\n')).toEqual(Array(4).fill([
      'context', 'emit', '--kind', 'done', '--summary', summary,
      '--source', `elanous://context/claude-code/${session}`,
    ]).flat());
  });
}

test('untrusted session and tool values never become source or summary', () => {
  const { argvFile, env } = fixture();
  expect(invoke('post-tool-use.sh', { session_id: session, tool_name: 'Read;sk-ant-api03-SECRET' }, env).status).toBe(0);
  expect(invoke('claude-stop.sh', { session_id: 'sk-ant-api03-SECRET' }, env).status).toBe(0);
  expect(existsSync(argvFile)).toBe(false);
  expect(invoke('post-tool-use.sh', { session_id: session, tool_name: 'PRIVATE_FILE', summary: 'PRIVATE_TRANSCRIPT' }, env).status).toBe(0);
  const args = readFileSync(argvFile, 'utf8').trimEnd().split('\n');
  expect(args).toEqual(['context', 'emit', '--kind', 'done', '--summary', 'Claude Code tool other completed',
    '--source', `elanous://context/claude-code/${session}`]);
});

test('context hooks install --print returns settings without writing the user settings', () => {
  const { dir } = fixture();
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const existingSettings = join(home, '.claude/settings.json');
  writeFileSync(existingSettings, '{"hooks":{"Existing":[]}}');
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'context', 'hooks', 'install', '--print'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home }, timeout: 30000,
  });
  expect(result.status).toBe(0);
  const settings = JSON.parse(result.stdout) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(`bash '${join(root, 'scripts/context-hooks/claude-stop.sh')}'`);
  expect(settings.hooks.PostToolUse[0]?.hooks[0]?.command).toBe(`bash '${join(root, 'scripts/context-hooks/post-tool-use.sh')}'`);
  expect(readFileSync(existingSettings, 'utf8')).toBe('{"hooks":{"Existing":[]}}');
  expect(existsSync(join(home, '.claude/settings.local.json'))).toBe(false);
}, 60000);
