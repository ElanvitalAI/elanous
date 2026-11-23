// ELN-PROMPT-CACHE-PIN — the eln seat (repl / Next TUI) request keeps one byte-identical cached prefix for a session.
// Audit ELN-OP-CONTEXT-AUDIT-1123 W1: the first call of every turn reused 0 or ~8K cached tokens because
//   (a) «my els location» sat inside the instructions only on turns where it changed,
//   (b) the owner check / self-health line were appended to the instructions every turn,
//   (c) an AGENTS.local.md edit mid-session rewrote the anchor,
//   (d) the tool set followed the message wording (warm preload of deferred tools).
// Expectations below are independent literals (fixture text written here), not product constants.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as debugModule from '../debug/log.js';
import * as llmModule from '../llm.js';
import { messagesToResponsesInput, type LLMMessage } from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { runCoreTurn } from '../core-turn/run-core-turn.js';
import * as surfaceModule from '../session-runtime/index.js';
import type { ElsResult } from '../els/core.js';
import {
  refreshElsSelfContext,
  resetElsSelfContextForTesting,
  setElsSelfContextSyncFetchForTesting,
} from '../els/els-self-context.js';
import { toLLM, withTurnVolatileContext } from '../session/chat.js';
import type { SerializedMessage } from '../session/index.js';
import type { UserConfig } from '../user-config/types.js';
import { createReplSystemPromptPin } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'prompt-cache-pin-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
const repo = join(root, 'repo');
const seatCwd = join(repo, 'seats', 'OP');
mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
mkdirSync(join(repo, '.git'), { recursive: true });
writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
mkdirSync(seatCwd, { recursive: true });
writeFileSync(join(repo, 'AGENTS.md'), '# shared guide\nSHARED-GUIDE-LINE\n');
const localPath = join(seatCwd, 'AGENTS.local.md');
writeFileSync(localPath, '# OP local\nAGENTS-LOCAL-V1\n');

const cfg = { llm: {} } as UserConfig;
const seatBootDeps = { home, env: {} };
const ownerReaders = {
  checklistVersion: () => '0.3.34', readChecklist: (version: string) => ({ version, items: [] }),
  listChecklists: () => [], readPullRequest: () => null, readMail: () => null,
};

function lsAnswer(address: string, unread: number): ElsResult {
  return {
    exitCode: 0,
    message: JSON.stringify({
      workspaces: [{ id: 'w1', name: 'main' }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'ops' }],
      panes: [{ address, workspace: 'main', tab: 't1', pane: 'p-op', title: 'OP', kind: 'seat', state: 'working', seat: 'OP', unreadMail: { count: unread } }],
    }),
  };
}

type Env3 = { ws?: string; pane?: string; socket?: string };
let restoreEls: (() => void) | null = null;
function setElsEnv(values: Env3): () => void {
  const prev: Env3 = { ws: process.env.ELANOUS_ELS_WS, pane: process.env.ELANOUS_ELS_PANE, socket: process.env.ELANOUS_ELS_SOCKET };
  const resetElsEnv = (v: Env3): void => {
    for (const key of ['ws', 'pane', 'socket'] as const) {
      const name = `ELANOUS_ELS_${key.toUpperCase()}`;
      if (v[key] === undefined) delete process.env[name];
      else process.env[name] = v[key];
    }
  };
  resetElsEnv(values);
  return () => resetElsEnv(prev);
}

beforeEach(() => {
  resetElsSelfContextForTesting();
  restoreEls = setElsEnv({ ws: 'main', pane: 'p-op', socket: join(root, 'none.sock') });
});
afterEach(() => {
  restoreEls?.();
  restoreEls = null;
  setElsSelfContextSyncFetchForTesting(null);
  resetElsSelfContextForTesting();
  mock.restore();
});

/** One provider request as the Codex Responses serializer sends it (stablePrefix — the codex provider's mode). */
function request(stable: string | undefined, volatile: string[], history: SerializedMessage[], userText: string) {
  const user: SerializedMessage = { role: 'user', content: userText, ts: '2026-11-23T00:00:00.000Z' };
  const wire = withTurnVolatileContext(toLLM([...history, user], stable), volatile);
  return messagesToResponsesInput(wire, { stablePrefix: true });
}

test('3 turns with a moving els location and mail count keep the instructions byte-identical; an AGENTS.local.md edit waits for the next session', async () => {
  const logs: Array<{ category: string; event: string }> = [];
  const realLog = debugModule.debug.log.bind(debugModule.debug);
  spyOn(debugModule.debug, 'log').mockImplementation(((category: string, event: string, ...rest: unknown[]) => {
    logs.push({ category, event });
    return (realLog as (...args: unknown[]) => unknown)(category, event, ...rest);
  }) as typeof debugModule.debug.log);
  setElsSelfContextSyncFetchForTesting(() => lsAnswer('main/ops/OP-SLOT-1', 3));
  const pin = createReplSystemPromptPin();
  const base = { cfg, enabledToolNames: ['Read', 'MsgList'], cwd: seatCwd, seatBootDeps, ownerReaders };
  const history: SerializedMessage[] = [];
  const turns: Array<ReturnType<typeof request>> = [];

  // turn 1
  let parts = pin({ ...base, sessionId: 'session-a' });
  turns.push(request(parts.stable, parts.volatile, history, '[seat mail #501 from TC] unread 3'));
  history.push({ role: 'user', content: '[seat mail #501 from TC] unread 3', ts: '2026-11-23T00:00:00.000Z' });
  history.push({ role: 'assistant', content: 'ack 501', ts: '2026-11-23T00:00:01.000Z' });

  // turn 2 — els moved, a mail reference arrives
  await refreshElsSelfContext({ ws: 'main', pane: 'p-op', socket: join(root, 'none.sock') }, async () => lsAnswer('main/ops/OP-SLOT-2', 7), seatCwd);
  parts = pin({ ...base, sessionId: 'session-a', workReferences: [{ kind: 'mail', id: '502' }] });
  turns.push(request(parts.stable, parts.volatile, history, '[seat mail #502 from MK] unread 7'));
  history.push({ role: 'user', content: '[seat mail #502 from MK] unread 7', ts: '2026-11-23T00:00:00.000Z' });
  history.push({ role: 'assistant', content: 'ack 502', ts: '2026-11-23T00:00:01.000Z' });

  // mid-session edit of the seat's own instruction file
  writeFileSync(localPath, '# OP local\nAGENTS-LOCAL-V2\n');
  const later = new Date(Date.now() + 60_000);
  utimesSync(localPath, later, later);

  // turn 3 — els moved again
  await refreshElsSelfContext({ ws: 'main', pane: 'p-op', socket: join(root, 'none.sock') }, async () => lsAnswer('main/ops/OP-SLOT-3', 0), seatCwd);
  parts = pin({ ...base, sessionId: 'session-a', workReferences: [{ kind: 'mail', id: '503' }] });
  turns.push(request(parts.stable, [...parts.volatile, 'self-health: degraded 1/3'], history, '[seat mail #503 from UX] unread 0'));

  const [t1, t2, t3] = turns as [ReturnType<typeof request>, ReturnType<typeof request>, ReturnType<typeof request>];
  // ① the cached prefix (instructions) is byte-identical across the three turns
  expect(t2.instructions).toBe(t1.instructions);
  expect(t3.instructions).toBe(t1.instructions);
  expect(t1.instructions).toContain('AGENTS-LOCAL-V1');
  expect(t1.instructions).toContain('SHARED-GUIDE-LINE');
  expect(t1.instructions).toContain('Your edits load at the start of the next session');
  // ② volatile blocks are not in the instructions …
  expect(t1.instructions).not.toContain('## 내 els 위치');
  expect(t1.instructions).not.toContain('OP-SLOT-1');
  expect(t1.instructions).not.toContain('## 조사 전 주인 확인');
  expect(t3.instructions).not.toContain('self-health: degraded 1/3');
  // … they ride in this turn's input, current values only
  const input1 = JSON.stringify(t1.input);
  const input2 = JSON.stringify(t2.input);
  const input3 = JSON.stringify(t3.input);
  expect(input1).toContain('OP-SLOT-1');
  expect(input1).toContain('안 읽은 우편 3건');
  expect(input2).toContain('OP-SLOT-2');
  expect(input2).toContain('안 읽은 우편 7건');
  expect(input2).not.toContain('OP-SLOT-1');
  expect(input3).toContain('OP-SLOT-3');
  expect(input3).toContain('self-health: degraded 1/3');
  expect(input3).toContain('## 조사 전 주인 확인');
  // ③ the history part of each request is a byte prefix of the next request (only [volatile, user] is new)
  expect(JSON.stringify(t2.input.slice(0, t1.input.length - 2))).toBe(JSON.stringify(t1.input.slice(0, t1.input.length - 2)));
  expect(JSON.stringify(t3.input.slice(0, t2.input.length - 2))).toBe(JSON.stringify(t2.input.slice(0, t2.input.length - 2)));
  // ④ the edit is noticed and deferred, not applied
  expect(t3.instructions).not.toContain('AGENTS-LOCAL-V2');
  expect(logs.filter(l => l.category === 'repl.prompt-cache' && l.event === 'anchor-change-deferred').length).toBe(1);

  // ⑤ a new session picks the edit up
  const next = pin({ ...base, sessionId: 'session-b' });
  const t4 = request(next.stable, next.volatile, [], 'hello');
  expect(t4.instructions).toContain('AGENTS-LOCAL-V2');
  expect(t4.instructions).not.toContain('AGENTS-LOCAL-V1');
});

// ── tools half of the prefix: one tool set per session ─────────────────────────────────────────
const read: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
const gitCommit: LLMToolSpec = { name: 'GitCommit', description: 'Stage files and commit', parameters: { type: 'object', properties: {} } };

async function captureFirstRequest(userText: string, stableToolSet: boolean): Promise<{ tools: string; instructions: string }> {
  let captured: { tools: string; instructions: string } | null = null;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    const opts = options as { researchTurn?: boolean; tools?: LLMToolSpec[] } | undefined;
    if (captured === null && opts && 'researchTurn' in opts) {
      captured = {
        tools: JSON.stringify(opts.tools ?? []),
        instructions: messagesToResponsesInput(messages as LLMMessage[], { stablePrefix: true }).instructions,
      };
    }
    return 'ok';
  });
  await runCoreTurn({
    sessionId: 'prompt-cache-pin-tools',
    messages: [{ role: 'system', content: 'SEAT-SYSTEM-PROMPT' }, { role: 'user', content: userText }],
    tools: [read, gitCommit],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
    userText,
    ...(stableToolSet ? { stableToolSet: true } : {}),
  }, {});
  mock.restore();
  if (captured === null) throw new Error('streamLLMWithTools was not reached');
  return captured;
}

test('stableToolSet: the tools array and the deferred announce do not follow the message wording', async () => {
  const stub = () => spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  stub();
  const plain = await captureFirstRequest('hello there', true);
  stub();
  const coding = await captureFirstRequest('please run the tests', true);
  expect(coding.tools).toBe(plain.tools);
  expect(coding.instructions).toBe(plain.instructions);
  expect(plain.tools).not.toContain('"GitCommit"');
  expect(plain.instructions).toContain('GitCommit');
  // control — without the flag the same wording warm-preloads GitCommit (this is what moved the prefix)
  stub();
  const legacy = await captureFirstRequest('please run the tests', false);
  expect(legacy.tools).toContain('"GitCommit"');
});
