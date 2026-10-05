import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { captureAgentEnv } from '../agent-env/profile.js';
import { registerAgentEnvCommands } from './agent-env-cli.js';

const secret = 'test-secret-EXACTLY-NEVER-EXPORT';
const clock = new Date('2026-10-05T01:16:00.000Z');

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-env-capture-'));
  mkdirSync(join(home, '.claude', 'skills', 'writer'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'reader'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.grok'), { recursive: true });
  mkdirSync(join(home, '.teamclaude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'acceptEdits', allow: [secret] },
    statusLine: { type: 'command', command: `echo ${secret}` },
    hooks: { PreToolUse: [{ matcher: secret, hooks: [{ command: secret }, { command: 'bun' }] }], Stop: [{ hooks: [] }] },
    enabledPlugins: { 'writer@local': true, 'reader@local': false },
    mcpServers: { source: { command: 'npx', args: [secret], env: { TOKEN: secret }, headers: { Authorization: secret } },
      remote: { command: `echo ${secret}`, headers: { XToken: secret } } },
    apiKey: secret,
  }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { userLevel: { command: 'bun', env: { USER_TOKEN: secret } } },
    projects: {
      '/work/a': { mcpServers: { projectA: { command: 'uvx', headers: { Authorization: secret } } } },
      '/work/b': { mcpServers: { projectB: { command: `echo ${secret}` } }, notes: secret },
    },
    apiKey: secret,
  }));
  writeFileSync(join(home, '.claude', 'auth.json'), secret);
  writeFileSync(join(home, '.teamclaude', 'package.json'), JSON.stringify({ version: '1.2.3', token: secret }));
  writeFileSync(join(home, '.codex', 'config.toml'), `model = "gpt-5"\nprofile = "dev"\napi_key = "${secret}"\n[mcp_servers.source]\ncommand = "npx"\nargs = ["${secret}"]\n[mcp_servers.remote]\nenv = { TOKEN = "${secret}" }\n`);
  writeFileSync(join(home, '.codex', 'auth.json'), secret);
  writeFileSync(join(home, '.grok', 'config.json'), JSON.stringify({ model: secret, apiKey: secret, nested: { token: secret } }));
  writeFileSync(join(home, '.grok', 'credentials.json'), secret);
  return home;
}

test('capture includes only allowlisted, secret-free fields from all three local agents', () => {
  const home = fixture();
  try {
    const profile = captureAgentEnv({ home, now: clock });
    expect(profile.version).toBe(1);
    expect(profile.capturedAt).toBe(clock.toISOString());
    expect(profile.agents.claude).toMatchObject({ settings: 'present', userConfig: 'present', permissionMode: 'acceptEdits',
      hooks: {
        PreToolUse: [{ matcher: '<redacted>', hooks: [{ command: '<redacted>' }, { command: 'bun' }] }],
        Stop: [{ matcher: null, hooks: [] }],
      },
      enabledPlugins: { 'reader@local': false, 'writer@local': true },
      mcpServers: {
        source: { source: 'settings', command: 'npx', env: { TOKEN: '<redacted>' }, headers: { Authorization: '<redacted>' } },
        remote: { source: 'settings', command: '<redacted>', headers: { XToken: '<redacted>' } },
        userLevel: { source: 'user', command: 'bun', env: { USER_TOKEN: '<redacted>' } },
        projectA: { source: 'project', command: 'uvx', headers: { Authorization: '<redacted>' } },
        projectB: { source: 'project', command: '<redacted>' },
      },
      skills: ['reader', 'writer'], teamclaude: { installed: 'present', version: '1.2.3' }, auth: 'present' });
    expect(profile.agents.codex).toMatchObject({ config: 'present', model: 'gpt-5', profile: 'dev', mcpServers: ['remote', 'source'], auth: 'present' });
    expect(profile.agents.grok).toMatchObject({ config: 'present', keys: ['apiKey', 'model', 'nested'], credentials: 'present' });
    expect(JSON.stringify(profile)).not.toContain(secret);
    expect(readdirSync(home).sort()).toEqual(['.claude', '.claude.json', '.codex', '.grok', '.teamclaude']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('absent inputs are identified, not invented, and --agent selects only one', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-env-absent-'));
  try {
    const profile = captureAgentEnv({ home, agent: 'claude', now: clock });
    expect(Object.keys(profile.agents)).toEqual(['claude']);
    expect(profile.agents.claude).toMatchObject({ settings: '«없음»', userConfig: '«없음»', statusLine: '«없음»', hooks: '«없음»',
      enabledPlugins: '«없음»', mcpServers: '«없음»', skills: '«없음»', teamclaude: { installed: '«없음»', version: null }, auth: '«없음»' });
    const all = captureAgentEnv({ home, now: clock });
    expect(all.agents.codex).toMatchObject({ config: '«없음»', mcpServers: '«없음»', auth: '«없음»' });
    expect(all.agents.grok).toMatchObject({ config: '«없음»', keys: '«없음»', credentials: '«없음»' });
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Grok TOML keys and suspicious scalar values never export credentials', () => {
  const home = fixture();
  try {
    rmSync(join(home, '.grok', 'config.json'));
    writeFileSync(join(home, '.grok', 'config.toml'), `model = "${secret}"\napi_key = "${secret}"\n`);
    writeFileSync(join(home, '.codex', 'config.toml'), `model = "${secret}"\nprofile = "dev"\n[mcp_servers.remote]\ncommand = "${secret}"\n`);
    const profile = captureAgentEnv({ home, now: clock });
    expect(profile.agents.grok?.keys).toEqual(['api_key', 'model']);
    expect(profile.agents.codex?.model).toBe('<redacted>');
    expect(JSON.stringify(profile)).not.toContain(secret);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('registered command writes only --out, --json prints the same profile and invalid agent writes nothing', async () => {
  const home = fixture();
  const out = join(home, 'profile.json');
  const previous = process.env.HOME;
  const original = process.stdout.write;
  let printed = '';
  process.env.HOME = home;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try {
    const program = new Command();
    registerAgentEnvCommands(program);
    await program.parseAsync(['node', 'eln', 'agent-env', 'capture', '--agent', 'claude', '--json', '--out', out]);
    expect(printed).toBe(readFileSync(out, 'utf8'));
    expect(Object.keys(JSON.parse(printed).agents)).toEqual(['claude']);
    expect(printed).not.toContain(secret);
    expect(readdirSync(home).sort()).toEqual(['.claude', '.claude.json', '.codex', '.grok', '.teamclaude', 'profile.json']);
    await expect(program.parseAsync(['node', 'eln', 'agent-env', 'capture', '--agent', 'unknown', '--out', join(home, 'invalid.json')])).rejects.toThrow('--agent');
    expect(existsSync(join(home, 'invalid.json'))).toBe(false);
  } finally {
    process.stdout.write = original;
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('real CLI entry exposes agent-env capture', () => {
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'agent-env', 'capture', '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--agent <agent>');
  expect(result.stdout).toContain('--out <file>');
  expect(result.stdout).toContain('--json');
});

test('user-level ~/.claude.json alone supplies MCP servers and keeps project sources', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-env-user-mcp-'));
  try {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { onlyUser: { command: 'node', env: { TOKEN: secret } } },
      projects: { '/repo': { mcpServers: { onlyProject: { command: 'uvx', headers: { Authorization: secret } } } } },
    }));
    const profile = captureAgentEnv({ home, agent: 'claude', now: clock });
    expect(profile.agents.claude).toMatchObject({
      settings: '«없음»', userConfig: 'present', hooks: '«없음»',
      mcpServers: {
        onlyUser: { source: 'user', command: 'node', env: { TOKEN: '<redacted>' } },
        onlyProject: { source: 'project', command: 'uvx', headers: { Authorization: '<redacted>' } },
      },
    });
    expect(JSON.stringify(profile)).not.toContain(secret);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('key-shaped values are redacted even when they pass the identifier character check', async () => {
  const { safeIdentifier } = await import('../agent-env/profile.js');
  for (const key of ['sk-proj-abcDEF1234567890xyz', 'ghp_ABCDEFabcdef1234567890', 'xai-Abc123Def456Ghi789Jkl', 'AKIAABCDEFGHIJKLMNOP', 'a1b2c3d4e5f6g7h8i9j0k1'])
    expect(safeIdentifier(key)).toBe('<redacted>');
  for (const plain of ['gpt-6-sol', 'claude-opus-5-5', 'grok-4.7', 'default', 'acceptEdits', 'command'])
    expect(safeIdentifier(plain)).toBe(plain);
});
