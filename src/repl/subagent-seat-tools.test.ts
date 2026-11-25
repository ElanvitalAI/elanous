// ELN-SUBAGENT-INHERIT-SEAT-TOOLS — a general-purpose child spawned from a Next TUI seat sees the seat's tools
// (MsgPost, RunShell, ElsControl), and its seat-only calls go back through the parent seat's dispatch.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalAgentRegistry } from '../agent/registry.js';
import type { LLMProvider } from '../llm.js';
import { MsgStore } from '../msg/msg-store.js';
import { buildReplTools } from './index.js';

const originalSocket = process.env.ELANOUS_ELS_SOCKET;
const originalState = process.env.ELANOUS_STATE_DIR;

afterEach(() => {
  if (originalSocket === undefined) delete process.env.ELANOUS_ELS_SOCKET;
  else process.env.ELANOUS_ELS_SOCKET = originalSocket;
  if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalState;
});

test('seat sub-agent (general-purpose) sees MsgPost, RunShell, ElsControl and posts mail through the parent seat', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'repl-subagent-seat-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
  process.env.ELANOUS_ELS_SOCKET = '/tmp/els-control-unreachable.sock';
  let childToolNames: string[] = [];
  let turns = 0;
  // Turn 1: the child model itself calls MsgPost inside the real child loop. Turn 2: it finishes.
  const provider: LLMProvider = {
    name: 'capture',
    defaultModel: 'capture',
    available: () => true,
    async *streamChat(_messages, opts) {
      turns += 1;
      if (turns === 1) {
        childToolNames = (opts?.tools ?? []).map(tool => tool.name);
        yield { type: 'tool_call', id: 'c1', name: 'MsgPost', args: { from: 'OP', to: 'TC', body: 'from the seat child' } };
        return;
      }
      yield { type: 'text', delta: 'done' };
    },
    async *chat() {},
  };
  const realSpawn = globalAgentRegistry.spawn.bind(globalAgentRegistry);
  const spawn = spyOn(globalAgentRegistry, 'spawn').mockImplementation(spawnOpts => realSpawn({ ...spawnOpts, provider }));
  try {
    const tools = buildReplTools({ nextTui: true });
    await tools.dispatch('Agent', {
      description: 'seat child', prompt: 'post one note', reason: 'seat tool catalog probe', subagent_type: 'general-purpose',
      run_in_background: false, isolation: 'cwd',
    });
    expect(childToolNames).toContain('MsgPost');
    expect(childToolNames).toContain('MsgList');
    expect(childToolNames).toContain('MsgAck');
    expect(childToolNames).toContain('RunShell');
    expect(childToolNames).toContain('ElsControl');
    expect(childToolNames).toContain('Bash');
    expect(childToolNames).toContain('Read');
    expect(new Set(childToolNames).size).toBe(childToolNames.length);

    expect(turns).toBe(2);
    const store = new MsgStore(join(stateDir, 'msg', 'messages.db'));
    try {
      const rows = store.list('TC');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.from).toBe('OP');
      expect(rows[0]?.body).toBe('from the seat child');
    } finally { store.close(); }
  } finally {
    spawn.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
