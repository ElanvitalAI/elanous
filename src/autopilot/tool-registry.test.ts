// src/autopilot/tool-registry.test.ts
//
// ROADMAP-elanous-builtin-autopilot-cascade §MB-2 — getAutopilotToolRegistry
// unit tests. Verifies the curated tool surface + dispatcher routing.

import { describe, test, expect, beforeAll } from 'bun:test';
import { getAutopilotToolRegistry, AUTOPILOT_TOOL_IDS } from './tool-registry.js';
import { registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';

beforeAll(() => {
  // dispatchToolByName needs the global runtime registry populated.
  registerAllDefaultToolRuntimes();
});

describe('getAutopilotToolRegistry', () => {
  test('exposes the curated 23 tools (MB-14 · file IO + plan + HITL + web + git + terminal + #4475 자기관측 4종)', () => {
    const { tools } = getAutopilotToolRegistry();
    const names = tools.map((t) => t.name);
    // File IO
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Edit');
    expect(names).toContain('Write');
    // Plan / HITL
    expect(names).toContain('update_plan');
    expect(names).toContain('AskUserQuestion');
    // Web research
    expect(names).toContain('WebFetch');
    expect(names).toContain('WebSearch');
    // MB-13: git workflow + research helpers
    expect(names).toContain('GitCommit');
    expect(names).toContain('FindRepo');
    expect(names).toContain('SyncRepo');
    expect(names).toContain('RefConsult');
    expect(names).toContain('ToolSearch');
    // MB-14: web terminal tools
    expect(names).toContain('WebTerminalSnapshot');
    expect(names).toContain('WebTerminalInput');
    expect(names).toContain('WebTerminalScreenshot');
    // native structured search — mission surface parity with chat surfaces
    // (previously Bash-grep only, which weakened decompose + grounding).
    expect(names).toContain('Grep');
    expect(names).toContain('Glob');
    expect(names).toContain('ListDir');
    // #4475: 미션 Active 자기관측 4종(제1원칙 self-cognition)
    expect(names).toContain('self_recall');
    expect(names).toContain('ops_status');
    expect(names).toContain('memory_recall');
    expect(names).toContain('logs_query');
    // CTX2 #23185: context_now 가 자기관측 원장에 더해졌다(맥락 한 문).
    expect(names).toContain('context_now');
    expect(tools).toHaveLength(24);
  });

  test('WebFetch dispatch routes to dispatchWebFetch (invalid URL → throw)', async () => {
    const { dispatchTool } = getAutopilotToolRegistry();
    let threw = false;
    try {
      await dispatchTool('WebFetch', { url: 'not-a-url' });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/WebFetch.*url/i);
    }
    expect(threw).toBe(true);
  });

  test('AUTOPILOT_TOOL_IDS matches the surfaced tool names', () => {
    const { tools } = getAutopilotToolRegistry();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...AUTOPILOT_TOOL_IDS].sort());
  });

  test('every tool spec carries a non-empty description', () => {
    const { tools } = getAutopilotToolRegistry();
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect((t.description ?? '').length).toBeGreaterThan(0);
    }
  });

  test('dispatchTool resolves through the global registry (Read on this file)', async () => {
    const { dispatchTool } = getAutopilotToolRegistry();
    const result = (await dispatchTool('Read', {
      file_path: __filename,
    })) as { output?: string };
    expect(typeof result?.output).toBe('string');
    expect(result.output?.length ?? 0).toBeGreaterThan(0);
    // The file mentions its own ROADMAP marker; sanity-check the read
    // surfaced actual contents (not an empty placeholder).
    expect(result.output).toContain('getAutopilotToolRegistry');
  });

  test('dispatchTool propagates session/feedback options into runtimeCtx', async () => {
    // We can not directly observe runtimeCtx from outside; instead
    // assert that an invalid call still routes through the registry
    // and surfaces a deterministic error shape.
    const { dispatchTool } = getAutopilotToolRegistry({
      surface: 'tui',
      sessionId: 'sid-x',
    });
    let threw = false;
    try {
      await dispatchTool('NoSuchTool', {});
    } catch (err) {
      threw = true;
      expect(String(err)).toContain('No ToolRuntime registered');
    }
    expect(threw).toBe(true);
  });
});
