// ELN-PROMPT-CACHE-PIN-E2E-TEST: exercise runRepl → runTurn → real request assembly;
// the model transport alone is faked. All files and state belong to this test universe.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as llm from '../llm.js';
import { messagesToResponsesInput, type LLMProvider } from '../llm.js';
import { getUserConfig } from '../user-config.js';
import { getSessionCwd, setSessionCwd } from '../session/working-dir.js';
import { runRepl } from './index.js';

// Same loaded-host bound as src/repl/tui-core-turn.test.ts.
const TEST_TIMEOUT_MS = 120_000;
const originalCwd = process.cwd();
const originalSessionCwd = getSessionCwd();
afterEach(() => { setSessionCwd(originalSessionCwd, 'tool'); process.chdir(originalCwd); });

test('five real REPL turns pin instructions and keep per-turn owner context after history', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'els-pin-entry-'));
  const home = join(root, 'home'), seat = join(root, 'seats', 'TC-H-CX-7');
  mkdirSync(home, { recursive: true }); mkdirSync(seat, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'TC-H-CX-7'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, 'AGENTS.md'), 'SHARED-CACHE-ANCHOR\n');
  const anchor = join(seat, 'AGENTS.local.md');
  writeFileSync(anchor, 'LOCAL-CACHE-V1\n');
  const scenario = join(root, 'turns.json');
  writeFileSync(scenario, JSON.stringify({ turns: ['one', 'two', 'three', 'four', 'five'].map((word, index) => ({ id: `t${index + 1}`, prompt: `hello ${word}` })) }));
  const names = ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'CODEX_HOME', 'ELANOUS_CONFIG_DIR', 'COORD_ID', 'ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET', 'ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE', 'ELANOUS_TOOL_PROFILE'] as const;
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const oldCwd = process.cwd(), homeSpy = spyOn(os, 'homedir').mockReturnValue(home);
  const calls: { instructions: string; input: ReturnType<typeof messagesToResponsesInput>['input']; tools: string }[] = [];
  const provider = { name: 'test', defaultModel: 'test', available: () => true, async *chat() { yield 'ok'; }, async *streamChat() { yield { type: 'text', delta: 'ok' } as const; } } as unknown as LLMProvider;
  const model = spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts) => {
    const wire = messagesToResponsesInput(messages, { stablePrefix: true });
    if (messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('hello '))) {
      calls.push({ instructions: wire.instructions, input: wire.input, tools: JSON.stringify(opts?.tools ?? []) });
      if (calls.length === 1) { writeFileSync(anchor, 'LOCAL-CACHE-V2\n'); const later = new Date(Date.now() + 60_000); utimesSync(anchor, later, later); }
    }
    opts?.onFinishReason?.('stop'); handlers.onText('ok', 'ok'); handlers.onTurnComplete?.([{ role: 'assistant', content: 'ok' }]); return 'ok';
  });
  const providerSync = spyOn(llm, 'getProviderForConfig').mockReturnValue(provider);
  const providerAsync = spyOn(llm, 'getProviderForConfigAsync').mockResolvedValue(provider);
  try {
    for (const name of names) delete process.env[name];
    process.env.ELANOUS_STATE_DIR = join(root, 'state'); process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    process.env.CODEX_HOME = join(root, 'codex'); process.env.ELANOUS_CONFIG_DIR = join(root, 'config');
    process.chdir(seat);
    setSessionCwd(seat, 'tool');
    const result = await runRepl({ cfg: getUserConfig(), initialSessionId: undefined, forceNew: true, enableTools: true, nextTui: true,
      scenarioPath: scenario, scriptedFromStdin: false, jsonOutput: true, exitAfterScenario: true });
    expect(result).toBe(0);
    expect(calls).toHaveLength(5);
    expect(calls[0]!.tools).not.toBe('[]');
    for (const call of calls) {
      expect(call.instructions).toBe(calls[0]!.instructions);
      expect(call.instructions).toContain('LOCAL-CACHE-V1');
      expect(call.instructions).not.toContain('LOCAL-CACHE-V2');
      expect(call.instructions).not.toContain('## 조사 전 주인 확인');
      expect(JSON.stringify(call.input)).toContain('## 조사 전 주인 확인');
      expect(call.tools).toBe(calls[0]!.tools);
    }
    const last = JSON.stringify(calls[4]!.input);
    expect(last).toContain('hello one'); expect(last).toContain('hello five');
    expect(last.lastIndexOf('## 조사 전 주인 확인')).toBeGreaterThan(last.lastIndexOf('hello four'));
    expect(last.lastIndexOf('## 조사 전 주인 확인')).toBeLessThan(last.lastIndexOf('hello five'));
  } finally {
    providerAsync.mockRestore(); providerSync.mockRestore(); model.mockRestore(); homeSpy.mockRestore(); process.chdir(oldCwd);
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
