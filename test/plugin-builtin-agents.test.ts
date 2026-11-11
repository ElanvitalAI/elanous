// Tests that plugins/agent-team/ ships the 5 PFC builtins correctly (PFC PX-1 Phase 5).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginContributedAgents } from '../src/agent/plugin-agents.js';
import { RESERVED_AGENT_IDS } from '../src/agent/definition-registry.js';
import { composeSystemPrompt } from '../src/agent/loader.js';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;

describe('plugins/agent-team — shipped 5 PFC builtins', () => {
  const pluginsRoot = mkdtempSync(join(tmpdir(), 'pfc-agent-team-'));
  symlinkSync(join(PROJECT_ROOT, 'plugins/agent-team'), join(pluginsRoot, 'agent-team'), 'dir');
  afterAll(() => rmSync(pluginsRoot, { recursive: true, force: true }));
  const { defs, errors } = loadPluginContributedAgents(PROJECT_ROOT, pluginsRoot);

  test('loads without errors', () => {
    expect(errors).toHaveLength(0);
  });

  test('includes every RESERVED_AGENT_IDS entry', () => {
    const names = defs.map(d => d.name);
    expect(names).toEqual(expect.arrayContaining(RESERVED_AGENT_IDS));
  });

  test('fails the reserved-ID assertion when an entry is absent', () => {
    const namesMissingReservedId = [...RESERVED_AGENT_IDS].slice(1);
    expect(() => {
      expect(namesMissingReservedId).toEqual(expect.arrayContaining(RESERVED_AGENT_IDS));
    }).toThrow();
  });

  test('each definition has non-empty systemPrompt + expected metadata', () => {
    for (const d of defs) {
      expect(d.source).toBe('plugin-builtin');
      expect(d.systemPrompt.length).toBeGreaterThan(100);
      expect(d.description).toBeTruthy();
      expect(d.role).toBeTruthy();
      expect(d.goal).toBeTruthy();
    }
  });

  test('composeSystemPrompt emits role/goal/backstory header for each', () => {
    for (const d of defs) {
      const out = composeSystemPrompt(d);
      expect(out).toContain('[ROLE]');
      expect(out).toContain('[GOAL]');
      expect(out).toContain('---');
    }
  });

  test('explore + plan + critic are read-only or plan mode', () => {
    const byName = new Map(defs.map(d => [d.name, d]));
    expect(byName.get('explore')!.permissionMode).toBe('read-only');
    expect(byName.get('plan')!.permissionMode).toBe('plan');
    expect(byName.get('critic')!.permissionMode).toBe('read-only');
  });

  test('executor has auto permission + write-capable tools', () => {
    const byName = new Map(defs.map(d => [d.name, d]));
    const executor = byName.get('executor')!;
    expect(executor.permissionMode).toBe('auto');
    expect(executor.tools).toContain('Edit');
    expect(executor.tools).toContain('Write');
  });

  test('explore has omitInheritedContext=true (context-budget optimisation)', () => {
    const byName = new Map(defs.map(d => [d.name, d]));
    expect(byName.get('explore')!.omitInheritedContext).toBe(true);
  });
});
