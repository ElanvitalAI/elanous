import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudePluginPrompt, convertMcpEntry, isClaudePluginDir, mcpEnableHint, planClaudePlugin, readClaudePlugin } from './connect-claude-plugin.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function plugin(opts: { manifest?: Record<string, unknown>; skills?: string[]; mcp?: unknown; extraSkillDir?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'en8-'));
  dirs.push(root);
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.0', ...opts.manifest }));
  for (const name of opts.skills ?? []) {
    const base = opts.extraSkillDir ? join(root, opts.extraSkillDir) : join(root, 'skills');
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }
  if (opts.mcp !== undefined) writeFileSync(join(root, '.mcp.json'), JSON.stringify(opts.mcp));
  return root;
}

describe('EN8 connect — a Claude Code plugin is used in place', () => {
  test('recognises the manifest; skills/ folder and .mcp.json are read', () => {
    const root = plugin({ skills: ['b', 'a'], mcp: { mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'] } } } });
    expect(isClaudePluginDir(root)).toBe(true);
    const read = readClaudePlugin(root);
    expect(read.name).toBe('demo');
    expect(read.skillRoots).toEqual([join(root, 'skills')]);
    expect(read.skills).toEqual(['a', 'b']);
    expect(read.mcp).toEqual([{ id: 'demo-local', command: ['node', `${root}/s.js`], enabled: false }]);
  });

  test('every registered MCP server is switched off; env/headers/sse are not registered and say why', () => {
    expect(convertMcpEntry('p', 'r', { type: 'http', url: 'https://x/mcp' }, '/r')).toEqual({ id: 'p-r', transport: 'http', url: 'https://x/mcp', enabled: false });
    expect(convertMcpEntry('p', 'k', { command: 'npx', env: { API_KEY: 'v' } }, '/r')).toEqual({ skipped: expect.stringContaining('API_KEY') });
    expect(convertMcpEntry('p', 'h', { url: 'https://x', headers: { Authorization: 'x' } }, '/r')).toEqual({ skipped: expect.stringContaining('헤더') });
    expect(convertMcpEntry('p', 's', { type: 'sse', url: 'https://x' }, '/r')).toEqual({ skipped: expect.stringContaining('sse') });
    expect(convertMcpEntry('p', 'n', {}, '/r')).toEqual({ skipped: expect.any(String) });
  });

  test('manifest mcpServers (inline) and a declared skills path are honoured; paths outside the plugin are ignored', () => {
    const root = plugin({ skills: ['x'], extraSkillDir: 'my-skills', manifest: { skills: ['./my-skills', '../escape'], mcpServers: { inline: { command: 'run' } } } });
    const read = readClaudePlugin(root);
    expect(read.skillRoots).toEqual([join(root, 'my-skills')]);
    expect(read.mcp.map((s) => s.id)).toEqual(['demo-inline']);
  });

  test('plan: new → already; the prompt names both halves and the skipped server', () => {
    const root = plugin({ skills: ['a'], mcp: { one: { command: 'x' }, two: { command: 'y', env: { T: '1' } } } });
    const read = readClaudePlugin(root);
    const first = planClaudePlugin(read, [], []);
    expect(first.state).toBe('new');
    const prompt = claudePluginPrompt(first);
    expect(prompt).toContain('스킬 1개(그 자리를 그대로 씁니다)');
    expect(prompt).toContain('MCP 서버 1개(꺼진 채로 등록');
    expect(prompt).toContain('MCP two: 환경변수가 필요합니다(T)');
    expect(planClaudePlugin(read, read.skillRoots, ['demo-one']).state).toBe('already');
    expect(planClaudePlugin(readClaudePlugin(plugin()), [], []).state).toBe('empty');
  });

  test('enable hint points at the row index in mcp.servers', () => {
    const lines = mcpEnableHint([{ id: 'demo-one', command: ['x'], enabled: false }], [{ id: 'other' }, { id: 'demo-one' }]);
    expect(lines[0]).toContain('elanous config set mcp.servers.1.enabled true');
  });
});
