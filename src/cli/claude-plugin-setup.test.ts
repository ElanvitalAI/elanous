import { describe, expect, test } from 'bun:test';
import {
  applyClaudePluginSetup, planClaudePluginSetup, type ClaudePluginSetupDeps,
} from './claude-plugin-setup.js';

function fixture({ claude = true, marketplace = false, plugin = false, node = true, elanous = true } = {}) {
  const calls: string[][] = [];
  const state = { marketplace, plugin };
  let source = 'ElanvitalAI/elanous';
  const deps: ClaudePluginSetupDeps = {
    has: (binary) => ({ claude, node, elanous })[binary as 'claude' | 'node' | 'elanous'] ?? false,
    run: (binary, args) => {
      const command = [binary, ...args];
      calls.push(command);
      if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
        source = args[3]!;
        state.marketplace = true;
      }
      if (args.join(' ') === 'plugin install elanous@elanous') {
        if (!state.marketplace) return { exitCode: 1, stdout: '', stderr: 'marketplace missing' };
        state.plugin = true;
      }
      if (args.join(' ') === 'plugin marketplace list') {
        return { exitCode: 0, stdout: JSON.stringify(state.marketplace ? [{ name: 'elanous', source }] : []) };
      }
      if (args.join(' ') === 'plugin list') {
        return { exitCode: 0, stdout: JSON.stringify(state.plugin ? [{ id: 'elanous@elanous' }] : []) };
      }
      if (args.join(' ') === 'mcp list') {
        return { exitCode: 0, stdout: state.plugin ? 'elanous: connected' : '' };
      }
      return { exitCode: 0, stdout: '' };
    },
  };
  return { deps, calls, state };
}

describe('Claude Code plugin setup', () => {
  test('missing Claude Code is reported without invoking the Claude CLI and application refuses to install', async () => {
    const f = fixture({ claude: false });
    const plan = await planClaudePluginSetup({}, f.deps);
    expect(plan.claudeCode).toBe(false);
    expect(plan.ready).toBe(false);
    expect(plan.steps.map((step) => step.needed)).toEqual([true, true]);
    expect(f.calls).toEqual([]);
    await expect(applyClaudePluginSetup(plan, f.deps)).rejects.toThrow('Claude Code is not installed');
    expect(f.calls).toEqual([]);
  });

  test('planning is read-only for absent marketplace and plugin, then apply installs in order and verifies', async () => {
    const f = fixture();
    const plan = await planClaudePluginSetup({}, f.deps);
    expect(f.calls).toEqual([
      ['claude', 'plugin', 'marketplace', 'list'], ['claude', 'plugin', 'list'],
    ]);
    expect(plan.steps).toEqual([
      { needed: true, command: ['claude', 'plugin', 'marketplace', 'add', 'ElanvitalAI/elanous'] },
      { needed: true, command: ['claude', 'plugin', 'install', 'elanous@elanous'] },
    ]);
    expect(f.state).toEqual({ marketplace: false, plugin: false });
    const result = await applyClaudePluginSetup(plan, f.deps);
    expect(result.executed).toEqual(plan.steps.map((step) => step.command));
    expect(result.ok).toBe(true);
    expect(result.verification.ready).toBe(true);
    expect(result.mcpVerified).toBe(true);
    expect(f.calls.at(-1)).toEqual(['claude', 'mcp', 'list']);
    expect(f.calls.findIndex((cmd) => cmd.includes('add'))).toBeLessThan(f.calls.findIndex((cmd) => cmd.includes('install')));
  });

  test('present marketplace but absent plugin only installs the plugin', async () => {
    const f = fixture({ marketplace: true });
    const plan = await planClaudePluginSetup({}, f.deps);
    expect(plan.steps.map((step) => step.needed)).toEqual([false, true]);
    const result = await applyClaudePluginSetup(plan, f.deps);
    expect(result.executed).toEqual([['claude', 'plugin', 'install', 'elanous@elanous']]);
    expect(result.ok).toBe(true);
  });

  test('present marketplace and plugin need no writes, including repeated application', async () => {
    const f = fixture({ marketplace: true, plugin: true });
    const plan = await planClaudePluginSetup({}, f.deps);
    expect(plan.ready).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await applyClaudePluginSetup(plan, f.deps);
      expect(result.executed).toEqual([]);
      expect(result.ok).toBe(true);
    }
    expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
  });

  test('verification fails closed if MCP is not listed after successful plugin installation', async () => {
    const f = fixture({ marketplace: true, plugin: true });
    const plan = await planClaudePluginSetup({}, f.deps);
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'mcp list'
      ? { exitCode: 0, stdout: '' }
      : previous(binary, args);
    const result = await applyClaudePluginSetup(plan, f.deps);
    expect(result.verification.ready).toBe(true);
    expect(result.mcpVerified).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('listed but disconnected MCP fails verification, even with the plugin installed', async () => {
    const f = fixture({ marketplace: true, plugin: true });
    const plan = await planClaudePluginSetup({}, f.deps);
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'mcp list'
      ? { exitCode: 0, stdout: 'elanous: Failed to connect' }
      : previous(binary, args);
    const result = await applyClaudePluginSetup(plan, f.deps);
    expect(result.verification.ready).toBe(true);
    expect(result.mcpVerified).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.executed).toEqual([]);
  });

  test('an unparsed marketplace list that still names elanous is unreadable, not absent — no add is attempted', async () => {
    const calls: string[][] = [];
    const deps: ClaudePluginSetupDeps = {
      has: () => true,
      run: (binary, args) => {
        calls.push([binary, ...args]);
        if (args.join(' ') === 'plugin marketplace list') return { exitCode: 0, stdout: '• elanous — ElanvitalAI/elanous (v2 layout)' };
        return { exitCode: 0, stdout: '' };
      },
    };
    await expect(planClaudePluginSetup({}, deps)).rejects.toThrow('unrecognized format');
    expect(calls.some((c) => c.slice(1, 4).join(' ') === 'plugin marketplace add')).toBe(false);
  });

  test('an unparsed marketplace list that never names elanous is absent', async () => {
    const deps: ClaudePluginSetupDeps = {
      has: () => true,
      run: (_binary, args) => ({ exitCode: 0, stdout: args.join(' ') === 'plugin marketplace list' ? 'Configured marketplaces:\n  anthropic-agent-skills' : '' }),
    };
    expect((await planClaudePluginSetup({}, deps)).marketplaceInstalled).toBe(false);
  });

  test('named marketplace with a different source refuses the requested source before writes', async () => {
    const f = fixture({ marketplace: true, plugin: true });
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'plugin marketplace list'
      ? { exitCode: 0, stdout: JSON.stringify([{ name: 'elanous', source: 'someone-else/elanous' }]) }
      : previous(binary, args);
    await expect(planClaudePluginSetup({ source: 'ElanvitalAI/elanous' }, f.deps))
      .rejects.toThrow('source is unknown or differs');
    expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
  });

  test('a stale plan refuses a source change detected during apply before installing the plugin', async () => {
    const f = fixture({ marketplace: true });
    const plan = await planClaudePluginSetup({}, f.deps);
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'plugin marketplace list'
      ? { exitCode: 0, stdout: JSON.stringify([{ name: 'elanous', source: 'other/elanous' }]) }
      : previous(binary, args);
    await expect(applyClaudePluginSetup(plan, f.deps)).rejects.toThrow('source is unknown or differs');
    expect(f.state.plugin).toBe(false);
    expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
  });

  test('existing marketplace of unknown source is refused rather than silently reused', async () => {
    const f = fixture({ marketplace: true });
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'plugin marketplace list'
      ? { exitCode: 0, stdout: JSON.stringify([{ name: 'elanous' }]) }
      : previous(binary, args);
    await expect(planClaudePluginSetup({}, f.deps)).rejects.toThrow('source is unknown or differs');
    expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
  });

  test('stale plan rechecks installed state instead of reinstalling', async () => {
    const f = fixture();
    const plan = await planClaudePluginSetup({}, f.deps);
    f.state.marketplace = true;
    f.state.plugin = true;
    expect((await applyClaudePluginSetup(plan, f.deps)).executed).toEqual([]);
  });

  test('missing node or elanous blocks application before installation', async () => {
    for (const availability of [{ node: false }, { elanous: false }]) {
      const f = fixture(availability);
      const plan = await planClaudePluginSetup({}, f.deps);
      expect(plan.ready).toBe(false);
      await expect(applyClaudePluginSetup(plan, f.deps)).rejects.toThrow('Both `node` and `elanous`');
      expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
    }
  });

  test('apply refuses to install when node or elanous disappears after planning', async () => {
    for (const missing of ['node', 'elanous']) {
      const f = fixture();
      const plan = await planClaudePluginSetup({}, f.deps);
      expect(plan.node && plan.elanous).toBe(true);
      f.deps.has = (binary) => binary !== missing;
      await expect(applyClaudePluginSetup(plan, f.deps)).rejects.toThrow('Both `node` and `elanous`');
      expect(f.state).toEqual({ marketplace: false, plugin: false });
      expect(f.calls.every((cmd) => cmd.at(-1) === 'list')).toBe(true);
    }
  });

  test('apply accepts node or elanous installed after planning', async () => {
    for (const missing of ['node', 'elanous']) {
      const f = fixture({ [missing]: false });
      const plan = await planClaudePluginSetup({}, f.deps);
      expect(plan.ready).toBe(false);
      f.deps.has = () => true;
      const result = await applyClaudePluginSetup(plan, f.deps);
      expect(result.executed).toEqual(plan.steps.map((step) => step.command));
      expect(result.verification.ready).toBe(true);
      expect(result.ok).toBe(true);
    }
  });

  test('custom source is preserved as one argv argument without a shell', async () => {
    const f = fixture();
    const source = '/tmp/local plugin marketplace';
    const plan = await planClaudePluginSetup({ source }, f.deps);
    expect(plan.source).toBe(source);
    expect(plan.steps[0]?.command).toEqual(['claude', 'plugin', 'marketplace', 'add', source]);
  });

  test('human-readable marketplace source and MCP connection status are independently checked', async () => {
    const f = fixture({ marketplace: true, plugin: true });
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => {
      if (args.join(' ') === 'plugin marketplace list') {
        return { exitCode: 0, stdout: 'elanous\n  Source: GitHub (ElanvitalAI/elanous)' };
      }
      if (args.join(' ') === 'mcp list') {
        return { exitCode: 0, stdout: 'elanous: node /path/to/server - ✓ Connected' };
      }
      return previous(binary, args);
    };
    const plan = await planClaudePluginSetup({}, f.deps);
    expect(plan.marketplaceInstalled).toBe(true);
    expect((await applyClaudePluginSetup(plan, f.deps)).mcpVerified).toBe(true);
  });

  test('local source is verified from Directory listing after install and does not reinstall on second apply', async () => {
    const f = fixture();
    const source = '/tmp/local plugin marketplace';
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'plugin marketplace list'
      ? { exitCode: 0, stdout: f.state.marketplace ? 'elanous\n  Source: Directory (/tmp/local plugin marketplace)' : '' }
      : previous(binary, args);
    const plan = await planClaudePluginSetup({ source }, f.deps);
    expect(plan.steps.map((step) => step.needed)).toEqual([true, true]);
    const first = await applyClaudePluginSetup(plan, f.deps);
    expect(first.executed).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', source],
      ['claude', 'plugin', 'install', 'elanous@elanous'],
    ]);
    expect(first.verification.marketplaceInstalled).toBe(true);
    expect(first.ok).toBe(true);
    const second = await applyClaudePluginSetup(plan, f.deps);
    expect(second.executed).toEqual([]);
    expect(second.verification.ready).toBe(true);
    expect(second.ok).toBe(true);
    expect(f.calls.filter((cmd) => cmd.includes('add') || cmd.includes('install'))).toEqual(first.executed);
  });

  test('Directory listing for a different local path refuses to reuse the marketplace', async () => {
    const f = fixture({ marketplace: true });
    const previous = f.deps.run!;
    f.deps.run = (binary, args) => args.join(' ') === 'plugin marketplace list'
      ? { exitCode: 0, stdout: 'elanous\n  Source: Directory (/tmp/another marketplace)' }
      : previous(binary, args);
    await expect(planClaudePluginSetup({ source: '/tmp/local plugin marketplace' }, f.deps))
      .rejects.toThrow('source is unknown or differs');
    expect(f.calls.filter((cmd) => cmd.includes('add') || cmd.includes('install'))).toEqual([]);
  });

  test('list failure does not imply absence or authorize an installation', async () => {
    const f = fixture();
    f.deps.run = () => ({ exitCode: 1, stdout: '' });
    await expect(planClaudePluginSetup({}, f.deps)).rejects.toThrow('Could not list Claude Code plugin marketplaces');
  });

  test('a failed install does not proceed to verification or claim success', async () => {
    const f = fixture();
    const plan = await planClaudePluginSetup({}, f.deps);
    const previous = f.deps.run!;
    f.deps.run = async (binary, args) => args.join(' ') === 'plugin marketplace add ElanvitalAI/elanous'
      ? { exitCode: 1, stdout: '', stderr: 'failed' }
      : previous(binary, args);
    await expect(applyClaudePluginSetup(plan, f.deps)).rejects.toThrow('Claude plugin setup failed');
    expect(f.state).toEqual({ marketplace: false, plugin: false });
  });
});
