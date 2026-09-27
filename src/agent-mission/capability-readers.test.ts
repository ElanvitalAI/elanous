import { describe, expect, it } from 'bun:test';
import { createCapabilityReaders, listCodexCapabilities, listClaudeCapabilities, listGrokCapabilities, type CapabilityRun } from './capability-readers.js';
import { buildCapabilityMatrix, pickBackend } from './capability-matrix.js';

// Shapes from real output (2026-09-27 mbp · env values removed): `codex mcp list --json` and `claude mcp list`.
const codexOutput = JSON.stringify([
  { name: 'github', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'npx', args: ['-y'], env: { GITHUB_TOKEN: 'secret-sentinel' } }, auth_status: 'unsupported' },
  { name: 'linear', enabled: false, disabled_reason: null, transport: { type: 'stdio', command: 'npx', args: ['-y'], env: null }, auth_status: 'unsupported' },
  { name: 'asana', enabled: true, disabled_reason: null, transport: { type: 'streamable_http', url: 'https://mcp.asana.com/v2/mcp' }, auth_status: 'not_logged_in' },
  { name: 'notion', enabled: true, disabled_reason: null, transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' }, auth_status: 'o_auth' },
]);
const claudeOutput = 'Checking MCP server health…\ngithub: https://mcp.github.com (HTTP) - ✓ Connected\nlinear: https://linear.example (HTTP) - ✓ Connected\n';

describe('read-only capability readers', () => {
  it('parses actual-shaped lists and makes the ready claude observation win over disabled codex', () => {
    const calls: string[] = [];
    const run: CapabilityRun = (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return { status: 0, stdout: command === 'codex' ? codexOutput : claudeOutput };
    };
    const matrix = buildCapabilityMatrix(createCapabilityReaders(run));
    expect(listCodexCapabilities(run).map(({ service, state }) => `${service}:${state}`)).toEqual(['github:ready', 'linear:unavailable', 'asana:unavailable', 'notion:ready']);
    expect(listClaudeCapabilities(run).map(({ state }) => state)).toEqual(['ready', 'ready']);
    expect(pickBackend(matrix, 'linear')).toBe('claude');
    expect(pickBackend(matrix, 'github')).toBe('codex');
    expect(calls.slice(0, 2)).toEqual(['codex mcp list --json', 'claude mcp list']);
  });

  it('does not turn an absent CLI, unrecognized output, or managed connector into ready', () => {
    const missing: CapabilityRun = () => ({ error: new Error('ENOENT'), status: null });
    expect(listCodexCapabilities(missing)[0]?.state).toBe('unknown');
    expect(listClaudeCapabilities(() => ({ status: 0, stdout: 'not a list' }))[0]?.state).toBe('unknown');
    expect(listGrokCapabilities()[0]?.state).toBe('unknown');
    expect(pickBackend(buildCapabilityMatrix(createCapabilityReaders(missing)), 'github')).toBeNull();
  });

  it('says why a service is unavailable and never copies env values into detail', () => {
    const run: CapabilityRun = () => Object.freeze({ status: 0, stdout: codexOutput });
    const entries = listCodexCapabilities(run);
    expect(entries.map(({ detail }) => detail)).toEqual(['stdio · auth=unsupported', 'stdio · disabled', 'streamable_http · not logged in', 'streamable_http · auth=o_auth']);
    expect(JSON.stringify(entries)).not.toContain('secret-sentinel');
    expect(listCodexCapabilities(() => ({ status: 0, stdout: 'Name  Command\nx  y\n' }))[0]?.state).toBe('unknown');
  });

  it('accepts both header spellings claude prints', () => {
    const three = listClaudeCapabilities(() => ({ status: 0, stdout: claudeOutput.replace('…', '...') }));
    expect(three.map(({ state }) => state)).toEqual(['ready', 'ready']);
  });
});
