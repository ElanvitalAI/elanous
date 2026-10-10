import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerCapabilitiesCommand } from './capabilities-cli.js';
import type { CapabilityRun } from './capability-readers.js';
import type { CapabilityIndexReaders } from '../smart-wizard/capability-index.js';
import type { SkillIndexEntry } from '../skills/index.js';

const runWith = (codex: string, claude: string) => {
  const calls: Array<[string, readonly string[]]> = [];
  let output = '';
  const run: CapabilityRun = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: command === 'codex' ? codex : claude };
  };
  const program = new Command().exitOverride();
  const parent = program.command('agent-mission');
  registerCapabilitiesCommand(parent, { run, write: text => { output += text; } });
  return { calls, output: () => output, program };
};

// `codex mcp list --json` shape (real output 2026-09-27, env removed).
const codex = JSON.stringify([
  { name: 'github', enabled: true, transport: { type: 'stdio', command: 'npx' }, auth_status: 'unsupported' },
  { name: 'linear', enabled: false, transport: { type: 'stdio', command: 'npx' }, auth_status: 'unsupported' },
]);
const claude = 'Checking MCP server health…\ngithub: https://mcp.github.com (HTTP) - ✓ Connected\nlinear: https://linear.example (HTTP) - ✓ Connected\n';

describe('agent-mission capabilities real CLI wiring', () => {
  it('exposes provenance, verified auth and unreadable sources via the opt-in index without changing the default JSON', async () => {
    const indexReaders: CapabilityIndexReaders = {
      skills: () => [{ name: 'local-skill', rootDir: '/skills' } as SkillIndexEntry], skillProblems: () => [],
      plugins: () => { throw new Error('ledger unreadable'); }, knowledge: () => { throw new Error('db unreadable'); },
      codex: async () => ({ status: 'unknown', plugins: [] }),
      claude: () => ({ status: 'installed-plugins-unreadable', packages: [] }),
      market: async () => ({ name: 'elanous', interface: { displayName: 'Official' }, sequence: 1,
        plugins: [{ name: 'tool', version: '1', source: { source: 'url' },
          artifact: { key: 'x', sha256: '0'.repeat(64), bytes: 0 },
          'ai.elanous': { capabilities: ['work'], connectors: [], pricing: { model: 'free' } } }] }),
      matrix: () => [],
    };
    let output = '';
    const program = new Command().exitOverride();
    registerCapabilitiesCommand(program.command('agent-mission'), { indexReaders, write: text => { output += text; } });
    await program.parseAsync(['agent-mission', 'capabilities', '--index', '--json'], { from: 'user' });
    const parsed = JSON.parse(output);
    expect(parsed.sources).toMatchObject({ plugins: 'unknown', knowledge: 'unknown', codex: 'unknown', claude: 'unknown', market: 'ok' });
    expect(parsed.entries.find((row: { id: string }) => row.id === 'tool')).toMatchObject({ source: 'market', provenance: 'elanous:url', state: 'unknown', auth: 'unknown' });
    expect(parsed.entries.find((row: { id: string }) => row.id === 'local-skill')).toMatchObject({ auth: 'unknown', provenance: '/skills' });
    output = '';
    await program.parseAsync(['agent-mission', 'capabilities', '--index'], { from: 'user' });
    expect(output).toContain('plugins\tunknown\n');
    expect(output).toContain('market\ttool\tplugin\tunknown\tunknown\telanous:url\n');
  });
  it('routes observed outputs through matrix and ready-only priority for --service --json', async () => {
    const fixture = runWith(codex, claude);
    await fixture.program.parseAsync(['agent-mission', 'capabilities', '--service', 'GITHUB', '--json'], { from: 'user' });
    const parsed = JSON.parse(fixture.output());
    expect(Object.keys(parsed)).toEqual(['entries', 'selected']);
    expect(parsed.selected).toBe('codex');
    expect(parsed.entries.map((entry: { state: string }) => entry.state)).toEqual(['ready', 'ready', 'unknown']);
    expect(fixture.calls).toEqual([['codex', ['mcp', 'list', '--json']], ['claude', ['mcp', 'list']]]);
  });

  it('selects a Claude connection marked ✓ after its health-check line when Codex is unavailable', async () => {
    const fixture = runWith('No MCP servers configured', claude);
    await fixture.program.parseAsync(['agent-mission', 'capabilities', '--service', 'github', '--json'], { from: 'user' });
    const parsed = JSON.parse(fixture.output());
    expect(parsed.selected).toBe('claude');
    expect(parsed.entries.find((entry: { backend: string }) => entry.backend === 'claude').state).toBe('ready');
    expect(fixture.calls).toEqual([['codex', ['mcp', 'list', '--json']], ['claude', ['mcp', 'list']]]);
  });

  it('never selects disabled or unknown even when they precede a ready reader', async () => {
    const fixture = runWith(codex, claude);
    await fixture.program.parseAsync(['agent-mission', 'capabilities', '--service', 'linear', '--json'], { from: 'user' });
    expect(JSON.parse(fixture.output()).selected).toBe('claude');
    const noReady = runWith('unexpected codex output', 'unrecognized claude output');
    await noReady.program.parseAsync(['agent-mission', 'capabilities', '--service', 'github', '--json'], { from: 'user' });
    expect(JSON.parse(noReady.output()).selected).toBeNull();
    expect(noReady.calls.map(([command, args]) => `${command} ${args.join(' ')}`)).toEqual(['codex mcp list --json', 'claude mcp list']);
    const missing = runWith('No MCP servers configured', 'No MCP servers configured');
    await missing.program.parseAsync(['agent-mission', 'capabilities', '--service', 'github', '--json'], { from: 'user' });
    expect(JSON.parse(missing.output()).selected).toBeNull();
  });

  it('prints a table and selected backend without mutating the observed output', async () => {
    const fixture = runWith(codex, claude);
    await fixture.program.parseAsync(['agent-mission', 'capabilities', '--service', 'linear'], { from: 'user' });
    expect(fixture.output()).toContain('codex\tlinear\tunavailable\tstdio · disabled');
    expect(fixture.output()).toContain('selected\tclaude');
    expect(JSON.parse(codex)[1].enabled).toBe(false);
  });
});
