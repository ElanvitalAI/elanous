// Test-universe scenario: only the model transport is simulated; the checklist and tools are real.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as llm from '../llm.js';
import type { LLMProvider } from '../llm.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { MsgStore } from '../msg/msg-store.js';
import { addItem, listChecklist, setItem } from '../release-loop/checklist.js';
import { getSessionCwd, setSessionCwd } from '../session/working-dir.js';
import { getUserConfig } from '../user-config.js';
import { runRepl } from './index.js';
import { registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import { _resetToolRuntimeRegistryForTest } from '../tool-runtime/registry.js';

const initialCwd = process.cwd();
afterEach(() => { process.chdir(initialCwd); });

test('existing merged PR evidence is answered without owner mail', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'persistent-investigation-'));
  const home = join(root, 'home'), seat = join(root, 'seats', 'OP');
  mkdirSync(home, { recursive: true }); mkdirSync(seat, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  writeFileSync(join(seat, 'AGENTS.local.md'), 'test seat\n');
  const scenario = join(root, 'turns.json');
  writeFileSync(scenario, JSON.stringify({ turns: [{ id: 't1', prompt: 'Has TEST-CACHE been implemented?' }] }));
  const names = ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'CODEX_HOME', 'ELANOUS_CONFIG_DIR', 'COORD_ID', 'ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET', 'ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE', 'ELANOUS_TOOL_PROFILE'] as const;
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const oldCwd = process.cwd(), oldSessionCwd = getSessionCwd();
  const homeSpy = spyOn(os, 'homedir').mockReturnValue(home);
  let calls = 0, answer = '';
  const provider: LLMProvider = { name: 'test', defaultModel: 'test', available: () => true, async *chat() {},
    async *streamChat(messages) {
      if (!messages.some(message => message.role === 'user' && message.content === 'Has TEST-CACHE been implemented?')) { yield { type: 'text', delta: 'ok' }; return; }
      calls++;
      if (calls === 1) {
        expect(JSON.stringify(messages)).toContain('read the full checklist item');
        yield { type: 'tool_call', id: 'check', name: 'Read', args: { file_path: join(root, 'checklist-snapshot.json') } };
      } else {
        const match = JSON.stringify(messages).match(/#39789/);
        answer = match ? `Implemented: ${match[0]} merged.` : 'Evidence missing';
        yield { type: 'text', delta: answer };
      }
    } };
  const sync = spyOn(llm, 'getProviderForConfig').mockReturnValue(provider);
  const asyncProvider = spyOn(llm, 'getProviderForConfigAsync').mockResolvedValue(provider);
  try {
    for (const name of names) delete process.env[name];
    process.env.ELANOUS_STATE_DIR = join(root, 'state'); process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    process.env.CODEX_HOME = join(root, 'codex'); process.env.ELANOUS_CONFIG_DIR = join(root, 'config');
    setElanousConfigDir(join(root, 'state'));
    registerAllDefaultToolRuntimes();
    addItem('0.3.34', { id: 'TEST-CACHE', title: 'Cache', owner: 'OWNER' });
    setItem('0.3.34', 'TEST-CACHE', { evidence: 'Merged PR #39789; cache implementation landed.' }, 'OP');
    writeFileSync(join(root, 'checklist-snapshot.json'), JSON.stringify(listChecklist('0.3.34')));
    process.chdir(seat); setSessionCwd(seat, 'tool');
    expect(await runRepl({ cfg: getUserConfig(), initialSessionId: undefined, forceNew: true, enableTools: true, nextTui: true,
      scenarioPath: scenario, scriptedFromStdin: false, jsonOutput: true, exitAfterScenario: true })).toBe(0);
    expect(calls).toBe(2);
    expect(answer).toContain('#39789');
    const store = new MsgStore(join(root, 'state', 'msg', 'messages.db'));
    try { expect(store.list('OWNER')).toHaveLength(0); } finally { store.close(); }
  } finally {
    asyncProvider.mockRestore(); sync.mockRestore(); homeSpy.mockRestore(); process.chdir(oldCwd); setSessionCwd(oldSessionCwd, 'tool');
    _resetToolRuntimeRegistryForTest(); resetElanousConfigDir();
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
