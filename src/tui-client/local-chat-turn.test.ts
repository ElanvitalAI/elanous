import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXT_SIDETAB_NOT_REQUESTED_ERROR } from '../tui/sidetab/nl-tool.js';
import { closeLocalChatSession, warmLocalChatSession, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus, requestLocalChatShellActivitySnapshot, runLocalChatTurn, setNextSidetabHandler, setNextSidetabIpcEnabled, setNextTuiPublishApprovalHandler, setNextTuiShellApprovalCancelHandler, setNextTuiShellApprovalHandler } from './local-chat-turn.js';
import { debug } from '../debug/log.js';
import { BackgroundJobStatus } from '../tui/chat/background-job-status.js';
import { appendMessage, createSession, loadSession, setActiveSessionId } from '../session/index.js';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import type { CompactProvider } from '../compact/provider.js';
import { compactNextTuiSession, isCompactCommand, type NextTuiCompactOutcome } from '../tui/slash/compact.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { LONG_SHELL_ESC_CONFIRMATION_MS, monotonicNowMs } from '../esc-abort-gate.js';
import { clearSessionTierOverride, setSessionTierOverride } from '../model-tier/session-override.js';
import { listMemories } from '../memory.js';
import { setUserConfigOverlay } from '../user-config.js';
import { clearSessionProvider, setSessionProvider } from './session-provider.js';

test('NEXT-TUI-DIFF-RENDER: a warmed child serves the first turn; a provider change replaces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-prewarm-'));
  const cli = join(dir, 'pid-cli.ts');
  const spawns = join(dir, 'spawns.log');
  writeFileSync(cli, `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    appendFileSync(${JSON.stringify(spawns)}, process.pid + '\\n');
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: String(process.pid) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'env' }));
    }
  `);
  const pids: string[] = [];
  // 출처: HARNESS-CHILD-PROVIDER-PASSTHROUGH test above — a glm turn preflights a synthetic Z.ai key.
  const savedZaiKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'synthetic-zai-prewarm';
  try {
    setSessionProvider('prewarm', { provider: 'glm', model: 'glm-5' });
    expect(warmLocalChatSession('', cli)).toBe(false);
    expect(warmLocalChatSession('prewarm', cli)).toBe(true);
    expect(warmLocalChatSession('prewarm', cli)).toBe(false); // Already warm: no second child.
    const spawned = () => existsSync(spawns) ? readFileSync(spawns, 'utf8').split('\n').filter(Boolean) : [];
    for (let attempt = 0; attempt < 200 && spawned().length === 0; attempt++) await Bun.sleep(10);
    expect(spawned()).toHaveLength(1); // The child started before any turn.
    await runLocalChatTurn('prewarm', 'first', new AbortController().signal, cli, undefined, (delta) => pids.push(delta));
    await runLocalChatTurn('prewarm', 'second', new AbortController().signal, cli, undefined, (delta) => pids.push(delta));
    expect(pids[0]).toBe(spawned()[0]); // The first turn ran on the warmed child…
    expect(pids[1]).toBe(pids[0]); // …which stays sticky.
    expect(spawned()).toHaveLength(1);
    setSessionProvider('prewarm', { provider: 'grok', model: 'grok-4.7' });
    await runLocalChatTurn('prewarm', 'switched', new AbortController().signal, cli, undefined, (delta) => pids.push(delta));
    expect(pids[2]).not.toBe(pids[0]); // A provider change still replaces a warmed child.
    expect(spawned()).toHaveLength(2);
  } finally {
    if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = savedZaiKey;
    clearSessionProvider('prewarm');
    await closeLocalChatSession('prewarm');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone Codex login passes Next TUI preflight for two turns without an owner mirror', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-standalone-codex-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `import { createInterface } from 'node:readline';
    for await (const _line of createInterface({ input: process.stdin }))
      console.log(JSON.stringify({ reply: 'ok', provider: 'openai-codex', model: 'gpt-6.1-terra' }));`);
  const priorCodexHome = process.env.CODEX_HOME;
  const priorAccessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  // #38331 mshq preflight: with no store in the temp config dir, codexAccountReadStorePath (src/oauth/codex-owner-mirror.ts)
  // fell back to the real ~/.elanous/auth.json, found the host's named Codex accounts and rotated away from CODEX_HOME.
  // Bun caches HOME at startup, so the fake home is the os.homedir spy (same idiom as src/cli/fleet-screen-cli.test.ts).
  const fakeHome = join(dir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const homeSpy = spyOn(os, 'homedir').mockReturnValue(fakeHome);
  try {
    expect(os.homedir()).toBe(fakeHome);
    setElanousConfigDir(join(dir, 'config'));
    process.env.CODEX_HOME = join(dir, 'codex-home');
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'openai-codex', codexTokenOwnerHost: undefined } }));
    const expiresAt = Math.floor(Date.now() / 1000 + 3600);
    const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.sig`;
    writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, refresh_token: 'local-refresh', account_id: 'local-account' } }));
    await expect(runLocalChatTurn('standalone-codex', 'first', new AbortController().signal, cli)).resolves.toEqual({ goalComplete: false });
    await expect(runLocalChatTurn('standalone-codex', 'second', new AbortController().signal, cli)).resolves.toEqual({ goalComplete: false });
  } finally {
    await closeLocalChatSession('standalone-codex');
    homeSpy.mockRestore();
    setUserConfigOverlay(null);
    resetElanousConfigDir();
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodexHome;
    if (priorAccessOnly === undefined) delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    else process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = priorAccessOnly;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancellation before lazy turn loading never starts a child', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(runLocalChatTurn('unused', 'unused', abort.signal)).rejects.toThrow('응답을 취소했습니다');
});

test('a prompt reaches JSONL stdin and never appears in child argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-turn-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    if (process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC !== '0') process.exit(9);
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      if (input.prompt !== 'private prompt text') process.exit(4);
      if (input.modelTier !== 'budget') process.exit(7);
      if (process.argv.includes(input.prompt)) process.exit(2);
    const configFlag = process.argv.indexOf('--config-dir');
    if (configFlag < 0 || process.argv[configFlag + 1] !== process.env.EXPECTED_CONFIG_DIR) process.exit(3);
    if (process.argv[configFlag + 2] !== 'repl') process.exit(6);
      if (process.argv.includes('--no-tools')) process.exit(5);
      console.log(JSON.stringify({ reply: 'ok', provider: 'grok', model: 'grok-4.7', goalComplete: true, goalStopReason: 'max_turns' }));
      console.log(JSON.stringify({ reply: 'duplicate', provider: 'grok', model: 'grok-4.7' }));
    }
  `);
  const routeLog = spyOn(debug, 'log');
  const configDir = join(dir, 'isolated-config');
  mkdirSync(configDir, { recursive: true });
  setElanousConfigDir(configDir);
  process.env.EXPECTED_CONFIG_DIR = getElanousConfigDir();
  const priorSidetabIpc = process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC;
  try {
    setSessionTierOverride('test-session', { llm: 'budget', rationale: 'next TUI /model fast' });
    process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC = '1';
    setNextSidetabHandler(null);
    setNextSidetabIpcEnabled(false);
    await expect(runLocalChatTurn('test-session', 'private prompt text', new AbortController().signal, cli)).resolves.toEqual({
      goalComplete: true, goalStopReason: 'max_turns',
    });
    expect(routeLog).toHaveBeenCalledWith('llm.route-decision', 'local-chat-executed', {
      surface: 'tui-local', sessionId: 'test-session', provider: 'grok', model: 'grok-4.7',
    });
    expect(routeLog.mock.calls.filter((call) => call[0] === 'tui.local-chat' && call[1] === 'result-frame-accepted')).toHaveLength(1);
  } finally {
    clearSessionTierOverride('test-session');
    await closeLocalChatSession('test-session');
    setNextSidetabIpcEnabled(false);
    if (priorSidetabIpc === undefined) delete process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC;
    else process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC = priorSidetabIpc;
    routeLog.mockRestore();
    delete process.env.EXPECTED_CONFIG_DIR;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sticky REPL follows a changed test universe for the same session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-memory-universe-'));
  const firstRoot = join(dir, 'first');
  const secondRoot = join(dir, 'second');
  const cli = join(dir, 'root-cli.ts');
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: process.env.ELANOUS_STATE_DIR }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'ok', provider: 'test', model: 'scope' }));
    }
  `);
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const seen: string[] = [];
  try {
    process.env.ELANOUS_STATE_DIR = firstRoot;
    setElanousConfigDir(firstRoot);
    await runLocalChatTurn('shared-session-id', 'remember first', new AbortController().signal, cli,
      undefined, (text) => seen.push(text));
    process.env.ELANOUS_STATE_DIR = secondRoot;
    setElanousConfigDir(secondRoot);
    await runLocalChatTurn('shared-session-id', 'recall second', new AbortController().signal, cli,
      undefined, (text) => seen.push(text));
    expect(seen).toEqual([firstRoot, secondRoot]);
  } finally {
    await closeLocalChatSession('shared-session-id');
    resetElanousConfigDir();
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a universe switch cannot recall the previous universe pinned memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-memory-isolation-'));
  const firstRoot = join(dir, 'first');
  const secondRoot = join(dir, 'second');
  const cli = join(dir, 'memory-cli.ts');
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  const memoryModule = join(import.meta.dir, '..', 'memory.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    import { saveMemory, buildMemoryInjection } from ${JSON.stringify(memoryModule)};
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const answer = request.prompt === 'remember'
        ? (saveMemory({ id: 'universe-fact', type: 'user', name: 'isolation', description: 'test', body: 'only-first-universe', pinned: true }), 'saved')
        : buildMemoryInjection('isolation').block.includes('only-first-universe') ? 'leaked' : 'missing';
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: answer }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: answer, provider: 'test', model: 'memory' }));
    }
  `);
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const seen: string[] = [];
  try {
    process.env.ELANOUS_STATE_DIR = firstRoot;
    setElanousConfigDir(firstRoot);
    await runLocalChatTurn('same-memory-session', 'remember', new AbortController().signal, cli,
      undefined, (text) => seen.push(text));
    process.env.ELANOUS_STATE_DIR = secondRoot;
    setElanousConfigDir(secondRoot);
    await runLocalChatTurn('same-memory-session', 'recall', new AbortController().signal, cli,
      undefined, (text) => seen.push(text));
    expect(seen).toEqual(['saved', 'missing']);
    const firstMemories = listMemories({}, join(firstRoot, 'elanous', 'memory'));
    const secondMemories = listMemories({}, join(secondRoot, 'elanous', 'memory'));
    expect(firstMemories).toHaveLength(1);
    expect(firstMemories[0]?.pinned).toBe(true);
    expect(secondMemories).toHaveLength(0);
  } finally {
    await closeLocalChatSession('same-memory-session');
    resetElanousConfigDir();
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sticky REPL resolves sidetab IPC against the current TUI handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-sidetab-ipc-'));
  const cli = join(dir, 'sidetab-ipc-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    if (process.env.ELANOUS_NEXT_TUI_SIDETAB_IPC !== '1') process.exit(8);
    let call = 0;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const response = new Promise((resolve) => process.once('message', resolve));
      process.send({ type: 'elanous.sidetab.call', callId: String(++call), request: { action: 'list' } });
      const result = await response;
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(result.result) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  const replies: string[] = [];
  try {
    setNextSidetabIpcEnabled(true);
    setNextSidetabHandler(null);
    await runLocalChatTurn('sidetab-ipc', '사이드탭 목록 보여줘', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    setNextSidetabHandler(async () => [{ id: 'live-handler' }]);
    await runLocalChatTurn('sidetab-ipc', 'show the side tab list', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    // TUI-NO-UNREQUESTED-SIDETAB: an ordinary turn cannot reach the live handler.
    await runLocalChatTurn('sidetab-ipc', '결과를 셸 명령 eln msg post 로 보고해', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    expect(JSON.parse(replies[0] ?? 'null')).toEqual({ error: 'Next TUI sidetab handler is not ready' });
    expect(JSON.parse(replies[1] ?? 'null')).toEqual([{ id: 'live-handler' }]);
    expect(JSON.parse(replies[2] ?? 'null')).toEqual({ error: NEXT_SIDETAB_NOT_REQUESTED_ERROR });
  } finally {
    setNextSidetabHandler(null);
    setNextSidetabIpcEnabled(false);
    await closeLocalChatSession('sidetab-ipc');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sticky REPL routes risky Bash approval IPC to the current human prompt handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-shell-approval-ipc-'));
  const cli = join(dir, 'shell-approval-ipc-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    if (process.env.ELANOUS_NEXT_TUI_SHELL_APPROVAL_IPC !== '1') process.exit(12);
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const response = new Promise((resolve) => process.once('message', resolve));
      process.send({ type: 'elanous.shell-approval.call', callId: 'approval-1', command: 'rm -rf /tmp/demo' });
      const result = await response;
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(result) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  const commands: string[] = [];
  const replies: string[] = [];
  try {
    setNextTuiShellApprovalHandler(async (command) => { commands.push(command); return true; });
    await runLocalChatTurn('shell-approval-ipc', 'test approval', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    expect(commands).toEqual(['rm -rf /tmp/demo']);
    expect(JSON.parse(replies[0] ?? 'null')).toEqual({
      type: 'elanous.shell-approval.result', callId: 'approval-1', approved: true,
    });
  } finally {
    setNextTuiShellApprovalHandler(null);
    await closeLocalChatSession('shell-approval-ipc');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sticky REPL created before the human handler is installed still denies Bash approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-shell-approval-deny-'));
  const cli = join(dir, 'shell-approval-deny-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    if (process.env.ELANOUS_NEXT_TUI_SHELL_APPROVAL_IPC !== '1') process.exit(12);
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const response = new Promise((resolve) => process.once('message', resolve));
      process.send({ type: 'elanous.shell-approval.call', callId: 'approval-early', command: 'rm -rf /tmp/demo' });
      const result = await response;
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(result) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  const replies: string[] = [];
  try {
    setNextTuiShellApprovalHandler(null);
    await runLocalChatTurn('shell-approval-deny', 'test approval', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    // #38167: a missing host handler answers why nobody decided (`unavailable`), so the child holds instead of recording a refusal.
    expect(JSON.parse(replies[0] ?? 'null')).toEqual({
      type: 'elanous.shell-approval.result', callId: 'approval-early', approved: false, reason: 'unavailable',
    });
  } finally {
    setNextTuiShellApprovalHandler(null);
    await closeLocalChatSession('shell-approval-deny');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('child timeout cancels one request id and the next Bash approval remains available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-shell-approval-cancel-'));
  const cli = join(dir, 'shell-approval-cancel-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let turn = 0;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      turn += 1;
      const callId = 'approval-' + turn;
      const response = new Promise((resolve) => process.once('message', resolve));
      process.send({ type: 'elanous.shell-approval.call', callId, command: 'rm -rf /tmp/demo-' + turn });
      if (turn === 1) setTimeout(() => process.send({ type: 'elanous.shell-approval.cancel', callId, reason: 'timeout' }), 20);
      const result = await response;
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(result) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  const cancellations: string[] = [];
  const replies: string[] = [];
  let resolveFirst: ((approved: boolean) => void) | null = null;
  try {
    setNextTuiShellApprovalHandler((_command, callId) => callId === 'approval-1'
      ? new Promise<boolean>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(callId === 'approval-2'));
    setNextTuiShellApprovalCancelHandler((callId, reason) => {
      cancellations.push(`${callId}:${reason}`);
      if (callId === 'approval-1') resolveFirst?.(false);
    });
    await runLocalChatTurn('shell-approval-cancel', 'first', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    await runLocalChatTurn('shell-approval-cancel', 'second', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    expect(cancellations).toEqual(['approval-1:timeout']);
    expect(JSON.parse(replies[0] ?? 'null')).toMatchObject({ callId: 'approval-1', approved: false });
    expect(JSON.parse(replies[1] ?? 'null')).toMatchObject({ callId: 'approval-2', approved: true });
  } finally {
    setNextTuiShellApprovalHandler(null);
    setNextTuiShellApprovalCancelHandler(null);
    await closeLocalChatSession('shell-approval-cancel');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn abort cancels the matching pending Bash prompt before closing the child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-shell-approval-abort-'));
  const cli = join(dir, 'shell-approval-abort-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const callId = 'approval-abort';
      process.send({ type: 'elanous.shell-approval.call', callId, command: 'rm -rf /tmp/abort' });
      await new Promise((resolve) => process.once('message', resolve));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  const abort = new AbortController();
  const cancellation: string[] = [];
  let releasePrompt: ((approved: boolean) => void) | null = null;
  let signalPromptStarted: (() => void) | null = null;
  const promptStarted = new Promise<void>((resolve) => { signalPromptStarted = resolve; });
  try {
    setNextTuiShellApprovalHandler(() => new Promise<boolean>((resolve) => {
      releasePrompt = resolve;
      signalPromptStarted?.();
    }));
    setNextTuiShellApprovalCancelHandler((callId, reason) => {
      cancellation.push(`${callId}:${reason}`);
      releasePrompt?.(false);
    });
    const turn = runLocalChatTurn('shell-approval-abort', 'abort this turn', abort.signal, cli);
    await promptStarted;
    abort.abort();
    await expect(turn).rejects.toThrow('응답을 취소했습니다');
    expect(cancellation).toEqual(['approval-abort:turn-cancelled']);
  } finally {
    setNextTuiShellApprovalHandler(null);
    setNextTuiShellApprovalCancelHandler(null);
    await closeLocalChatSession('shell-approval-abort');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two turns keep one child and deliver a completion frame between turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-sticky-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let turns = 0;
    for await (const line of createInterface({ input: process.stdin })) {
      turns++;
      const input = JSON.parse(line);
      if (turns === 1) console.error('ELANOUS_TUI_BG_STATUS\\t' + JSON.stringify({ sessionId: 'sticky', promised: true, running: 1, pending: 0 }));
      console.log(JSON.stringify({ reply: input.prompt, provider: 'grok', model: String(process.pid) }));
      if (turns === 1) setTimeout(() => console.error('ELANOUS_TUI_BG_STATUS\\t' + JSON.stringify({ sessionId: 'sticky', promised: false, running: 0, pending: 1 })), 50);
    }
  `);
  const routeLog = spyOn(debug, 'log');
  const frames: string[] = [];
  const stop = onLocalChatBackgroundStatus('sticky', (frame) => { if (frame !== null) frames.push(frame); });
  try {
    await runLocalChatTurn('sticky', 'first', new AbortController().signal, cli);
    for (let i = 0; i < 100 && frames.length < 2; i++) await Bun.sleep(10);
    expect(frames.map((frame) => JSON.parse(frame).running)).toEqual([1, 0]);
    await runLocalChatTurn('sticky', 'second', new AbortController().signal, cli);
    const routes = routeLog.mock.calls.filter((call) => call[0] === 'llm.route-decision' && call[1] === 'local-chat-executed');
    expect(routes.length).toBe(2);
    expect((routes[0]![2] as { model: string }).model).toBe((routes[1]![2] as { model: string }).model);
  } finally {
    stop();
    await closeLocalChatSession('sticky');
    routeLog.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delta frames reach only their turn before the final JSONL response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-delta-'));
  const cli = join(dir, 'delta-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let previous = '';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      if (previous) console.log(JSON.stringify({ event: 'delta', turnId: previous, text: 'stale' }));
      console.log(JSON.stringify({ event: 'status', turnId: 'stale-turn', text: 'stale status' }));
      console.log(JSON.stringify({ event: 'status', turnId: input.id, text: '스트림 무응답 · 재시도 1/1' }));
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: '첫', source: 'assistant-text' }));
      console.log(JSON.stringify({ event: 'heartbeat', turnId: input.id }));
      console.log(JSON.stringify({ event: '', turnId: input.id }));
      console.log(JSON.stringify({ event: null, turnId: input.id }));
      console.log(JSON.stringify({ event: 'result', turnId: '', reply: 'wrong turn' }));
      await Bun.sleep(30);
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: ' 토큰', source: 'tool-result' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: '첫 토큰' }));
      previous = input.id;
    }
  `);
  const first: string[] = [];
  const second: string[] = [];
  const statuses: string[] = [];
  const order: string[] = [];
  const sources: Array<string | undefined> = [];
  try {
    await runLocalChatTurn('delta-session', 'one', new AbortController().signal, cli, undefined, (delta, _replace, source) => {
      sources.push(source);
      first.push(delta);
      order.push('delta');
    }, undefined, [], (line) => { statuses.push(line); order.push('status'); });
    order.push('final');
    await runLocalChatTurn('delta-session', 'two', new AbortController().signal, cli, undefined, (delta) => second.push(delta));
    expect(first).toEqual(['첫', ' 토큰']);
    expect(sources).toEqual(['assistant-text', undefined]);
    expect(second).toEqual(['첫', ' 토큰']);
    expect(statuses).toEqual(['스트림 무응답 · 재시도 1/1']);
    expect(order).toEqual(['status', 'delta', 'delta', 'final']);
  } finally {
    await closeLocalChatSession('delta-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell activity frames forward only valid current-turn Bash and RunShell boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-shell-activity-'));
  const cli = join(dir, 'shell-activity-cli.ts');
  // Source: model the start event arriving after the configured confirmation boundary.
  const delayedStartMonotonicMs = monotonicNowMs() - LONG_SHELL_ESC_CONFIRMATION_MS - (LONG_SHELL_ESC_CONFIRMATION_MS / LONG_SHELL_ESC_CONFIRMATION_MS);
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let requestSnapshot;
    const snapshotRequested = new Promise(resolve => { requestSnapshot = resolve; });
    process.on('message', message => { if (message.type === 'elanous.next-tui.shell-snapshot') requestSnapshot(); });
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'shell-activity', turnId: 'stale-turn', phase: 'start', id: 'stale', name: 'Bash' }));
      console.log(JSON.stringify({ event: 'shell-activity', turnId: input.id, phase: 'start', id: 'shell-1', name: 'Bash', startedAtMonotonicMs: ${delayedStartMonotonicMs} }));
      await snapshotRequested;
      console.log(JSON.stringify({ event: 'shell-activity', turnId: input.id, phase: 'snapshot', calls: [{ id: 'shell-2', name: 'RunShell', startedAtMonotonicMs: ${delayedStartMonotonicMs} }] }));
      console.log(JSON.stringify({ event: 'shell-activity', turnId: input.id, phase: 'finish', id: 'shell-1', name: 'Bash' }));
      console.log(JSON.stringify({ event: 'shell-activity', turnId: input.id, phase: 'start', id: 'invalid', name: 'Read' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'done' }));
    }
  `);
  const activity: Array<
    | { phase: 'start'; id: string; name: string; startedAtMonotonicMs: number }
    | { phase: 'finish'; id: string; name: string }
    | { phase: 'snapshot'; calls: Array<{ id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }> }
  > = [];
  try {
    const turn = runLocalChatTurn('shell-activity-session', 'one', new AbortController().signal, cli,
      undefined, undefined, {}, [], undefined, undefined, (event) => activity.push(event));
    for (let tries = 0; tries < 100 && !activity.some((event) => event.phase === 'start'); tries++) await Bun.sleep(10);
    expect(requestLocalChatShellActivitySnapshot('shell-activity-session')).toBe(true);
    await turn;
    expect(activity).toEqual([
      { phase: 'start', id: 'shell-1', name: 'Bash', startedAtMonotonicMs: delayedStartMonotonicMs },
      { phase: 'snapshot', calls: [{ id: 'shell-2', name: 'RunShell', startedAtMonotonicMs: delayedStartMonotonicMs }] },
      { phase: 'finish', id: 'shell-1', name: 'Bash' },
    ]);
  } finally {
    await closeLocalChatSession('shell-activity-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool activity forwards a current-turn non-shell tool and a fresh execution snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-tool-activity-'));
  const cli = join(dir, 'tool-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let turnId;
    process.on('message', message => {
      if (message.type !== 'elanous.next-tui.shell-snapshot' || message.turnId !== turnId) return;
      console.log(JSON.stringify({ event: 'tool-activity', turnId, phase: 'snapshot', calls: [{ id: 'read-1', name: 'Read' }, { id: 'agent-1', name: 'Agent' }] }));
      console.log(JSON.stringify({ event: 'tool-activity', turnId, phase: 'finish', id: 'read-1', name: 'Read' }));
      console.log(JSON.stringify({ event: 'result', turnId, reply: 'done' }));
    });
    for await (const line of createInterface({ input: process.stdin })) {
      turnId = JSON.parse(line).id;
      console.log(JSON.stringify({ event: 'tool-activity', turnId: 'stale-turn', phase: 'start', id: 'stale', name: 'Bash' }));
      console.log(JSON.stringify({ event: 'tool-activity', turnId, phase: 'start', id: 'read-1', name: 'Read' }));
    }
  `);
  const activity: Array<{ phase: string; id?: string; name?: string; calls?: Array<{ id: string; name: string }> }> = [];
  try {
    const turn = runLocalChatTurn('tool-activity-session', 'one', new AbortController().signal, cli,
      undefined, undefined, {}, [], undefined, undefined, undefined, (event) => activity.push(event));
    for (let tries = 0; tries < 100 && activity.length === 0; tries++) await Bun.sleep(10);
    expect(requestLocalChatShellActivitySnapshot('tool-activity-session')).toBe(true);
    await turn;
    expect(activity).toEqual([
      { phase: 'start', id: 'read-1', name: 'Read' },
      { phase: 'snapshot', calls: [{ id: 'read-1', name: 'Read' }, { id: 'agent-1', name: 'Agent' }] },
      { phase: 'finish', id: 'read-1', name: 'Read' },
    ]);
  } finally {
    await closeLocalChatSession('tool-activity-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transient status frames reach the status callback without becoming reply text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-status-frame-'));
  const cli = join(dir, 'status-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'status', turnId: input.id, text: 'ctx 410,000 chars / 400,000' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: '요약 완료' }));
    }
  `);
  const statuses: string[] = [];
  const replies: Array<{ text: string; replace?: boolean }> = [];
  try {
    await runLocalChatTurn('status-session', 'summarize context', new AbortController().signal, cli,
      undefined, (text, replace) => replies.push({ text, replace }), {}, [], (line) => statuses.push(line));
    expect(statuses).toEqual(['ctx 410,000 chars / 400,000']);
    expect(replies).toEqual([]);
  } finally {
    await closeLocalChatSession('status-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self health frames require the active turn and session and clear on child exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-health-frame-'));
  const cli = join(dir, 'health-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      const snapshot = { sessionId: 'health-session', capturedAt: 1, line: '[health]', source: 'checkout', runningSha: 'abcdef0', installedSha: null, errorCount: 0, representativeError: null, creditSource: null, creditKnown: true };
      console.log(JSON.stringify({ event: 'self-health', turnId: input.id, sessionId: 'wrong-session', selfHealth: snapshot }));
      console.log(JSON.stringify({ event: 'self-health', turnId: 'stale-turn', sessionId: 'health-session', selfHealth: snapshot }));
      console.log(JSON.stringify({ event: 'self-health', turnId: input.id, sessionId: 'health-session', selfHealth: snapshot }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'ok' }));
      setTimeout(() => process.exit(0), 20);
    }
  `);
  const observed: Array<string | null> = [];
  const stop = onLocalChatSelfHealthStatus('health-session', (snapshot) => observed.push(snapshot?.line ?? null));
  try {
    await runLocalChatTurn('health-session', 'first', new AbortController().signal, cli);
    for (let i = 0; i < 100 && observed.at(-1) !== null; i++) await Bun.sleep(10);
    expect(observed).toEqual(['[health]', null]);
  } finally {
    stop();
    await closeLocalChatSession('health-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent progress frames reach only the active turn and carry no child output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-agent-'));
  const cli = join(dir, 'agent-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'agent', turnId: 'stale', phase: 'start', id: 'x', description: 'ignore' }));
      console.log(JSON.stringify({ event: 'agent', turnId: input.id, phase: 'start', id: 'a', description: '코드 조사' }));
      console.log(JSON.stringify({ event: 'agent', turnId: input.id, phase: 'finish', id: 'a', status: 'done' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'ok' }));
    }
  `);
  const events: Array<{ phase: string; id: string; description?: string; status?: string }> = [];
  try {
    await runLocalChatTurn('agent-session', 'question', new AbortController().signal, cli,
      undefined, undefined, {}, [], undefined, (event) => events.push(event));
    expect(events).toEqual([
      { phase: 'start', id: 'a', description: '코드 조사' },
      { phase: 'finish', id: 'a', status: 'done' },
    ]);
  } finally {
    await closeLocalChatSession('agent-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replace frames atomically replace the provisional answer for the active turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-replace-'));
  const cli = join(dir, 'replace-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: 'provisional' }));
      console.log(JSON.stringify({ event: 'replace', turnId: input.id, text: 'grounded answer' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'grounded answer' }));
    }
  `);
  const frames: Array<{ text: string; replace?: boolean }> = [];
  try {
    await runLocalChatTurn('replace-session', 'question', new AbortController().signal, cli, undefined,
      (text, replace) => frames.push({ text, replace }));
    expect(frames).toEqual([
      { text: 'provisional', replace: undefined },
      { text: 'grounded answer', replace: true },
    ]);
  } finally {
    await closeLocalChatSession('replace-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling on the first delta reaps the child without showing later deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-delta-cancel-'));
  const cli = join(dir, 'delta-cli.ts');
  const pidFile = join(dir, 'pid');
  writeFileSync(cli, `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: 'first' }));
      await Bun.sleep(50);
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: 'late' }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'done' }));
    }
  `);
  const abort = new AbortController();
  const deltas: string[] = [];
  try {
    await expect(runLocalChatTurn('delta-cancel', 'one', abort.signal, cli, undefined, (delta) => {
      deltas.push(delta);
      abort.abort();
    })).rejects.toThrow('응답을 취소했습니다');
    expect(deltas).toEqual(['first']);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        alive = false;
      }
      if (alive) await Bun.sleep(10);
    }
    expect(alive).toBe(false);
  } finally {
    await closeLocalChatSession('delta-cancel');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('child exit clears a previously visible background task before the next input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-task-exit-'));
  const cli = join(dir, 'exiting-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const _line of createInterface({ input: process.stdin })) {
      console.error('ELANOUS_TUI_BG_STATUS\\t' + JSON.stringify({ sessionId: 'task-exit', promised: true, running: 1, pending: 0 }));
      console.log(JSON.stringify({ reply: 'ok' }));
      setTimeout(() => process.exit(0), 50);
    }
  `);
  const status = new BackgroundJobStatus('task-exit');
  const observed: string[] = [];
  const stop = onLocalChatBackgroundStatus('task-exit', (frame) => {
    if (frame === null) status.clear();
    else status.accept(frame);
    observed.push(status.line());
  });
  try {
    await runLocalChatTurn('task-exit', 'first', new AbortController().signal, cli);
    for (let i = 0; i < 100 && observed.at(-1) !== ''; i++) await Bun.sleep(10);
    expect(observed).toContain('⧗ Background 1');
    expect(observed.at(-1)).toBe('');
    expect(status.snapshot()).toBeNull();
  } finally {
    stop();
    await closeLocalChatSession('task-exit');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a REPL turn error keeps the child alive for the next prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-retry-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    let count = 0;
    for await (const _line of createInterface({ input: process.stdin })) {
      count++;
      console.log(JSON.stringify(count === 1 ? { error: 'temporary turn failure' } : { reply: 'ok', provider: 'grok', model: String(process.pid) }));
    }
  `);
  try {
    await expect(runLocalChatTurn('retry', 'first', new AbortController().signal, cli)).rejects.toThrow('temporary turn failure');
    await expect(runLocalChatTurn('retry', 'second', new AbortController().signal, cli)).resolves.toEqual({ goalComplete: false });
  } finally {
    await closeLocalChatSession('retry');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an onboarding refusal reaches the Next TUI as its actionable stderr message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-onboarding-refusal-'));
  const cli = join(dir, 'onboarding-refusal.ts');
  const guidance = 'No config yet — run `elanous` once interactively (onboarding) before using repl --json / --stdin-jsonl.';
  writeFileSync(cli, `process.stderr.write(${JSON.stringify(guidance + '\n')}); process.exit(2);`);
  try {
    await expect(runLocalChatTurn('onboarding-refusal', 'first prompt', new AbortController().signal, cli))
      .rejects.toThrow(guidance);
  } finally {
    await closeLocalChatSession('onboarding-refusal');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('onboarding refusal does not wait for a descendant holding the stderr pipe open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-inherited-stderr-'));
  const cli = join(dir, 'inherited-stderr.ts');
  const pidFile = join(dir, 'descendant-pid');
  const guidance = 'No config yet — run elanous onboarding';
  writeFileSync(cli, `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
    process.stderr.write(${JSON.stringify(guidance + '\n')});
    process.exit(2);
  `);
  try {
    const outcome = await Promise.race([
      runLocalChatTurn('inherited-stderr', 'first prompt', new AbortController().signal, cli)
        .then(() => 'unexpected success', (error: Error) => error.message),
      Bun.sleep(1500).then(() => 'timed out'), // Source: #36702 — reject before inherited pipe closes.
    ]);
    expect(outcome).toBe(guidance);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already exited */ }
    }
    await closeLocalChatSession('inherited-stderr');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real REPL onboarding gate reaches the Next TUI without a JSONL frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-real-onboarding-'));
  const cli = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  setElanousConfigDir(dir);
  try {
    await expect(runLocalChatTurn('real-onboarding-refusal', 'first prompt', new AbortController().signal, cli))
      .rejects.toThrow('No config yet — run `elanous` once interactively before using the Next TUI REPL.');
  } finally {
    await closeLocalChatSession('real-onboarding-refusal');
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stdin write failure kills and reaps a running child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-reap-'));
  const cli = join(dir, 'waiting-cli.ts');
  const pidFile = join(dir, 'pid');
  writeFileSync(cli, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  try {
    const failAfterStart = async (): Promise<void> => {
      for (let i = 0; i < 500 && !existsSync(pidFile); i++) await Bun.sleep(10);
      if (!existsSync(pidFile)) throw new Error('fake child did not start');
      throw new Error('stdin write failed');
    };
    await expect(runLocalChatTurn('test-session', 'prompt', new AbortController().signal, cli, failAfterStart))
      .rejects.toThrow('stdin write failed');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdout EOF rejects the turn and reaps a child that remains alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-eof-'));
  const cli = join(dir, 'closed-cli.ts');
  const pidFile = join(dir, 'pid');
  writeFileSync(cli, `
    import { closeSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    closeSync(1);
    setInterval(() => {}, 1000);
  `);
  try {
    await expect(runLocalChatTurn('eof-session', 'prompt', new AbortController().signal, cli))
      .rejects.toThrow('REPL stdout closed');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await closeLocalChatSession('eof-session');
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TUI-NEXT-COMPACT — pre-turn auto compaction ⊕ `/compact` (shared src/compact/* via session bridge) ──
// The store is the real session store at a temp root; the child is a fake REPL that reads that store
// when the prompt arrives, so «compacted before the send» is what the child saw, not an assumption.
const SESSION_INDEX = join(import.meta.dir, '..', 'session', 'index.ts');

function fakeSummaryProvider(): CompactProvider & { calls: number } {
  const provider = {
    calls: 0,
    async summarize(args: { messages: readonly unknown[] }) {
      provider.calls++;
      return { summary: '요약된 앞 대화', modelUsed: 'fake-summarizer', sourceMessageCount: args.messages.length };
    },
    getContextWindow: () => 32_000,
    getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
  };
  return provider;
}

function seedSession(count: number, chars: number): string {
  const id = createSession({ source: 'tui' }).id;
  for (let i = 0; i < count; i++) {
    appendMessage(id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}:${'x'.repeat(chars)}`, ts: new Date().toISOString() });
  }
  return id;
}

function storeCountingCli(dir: string): string {
  const cli = join(dir, 'store-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    import { loadSession } from ${JSON.stringify(SESSION_INDEX)};
    const id = process.argv[process.argv.indexOf('--session') + 1];
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: 'seen=' + (loadSession(id)?.messages.length ?? -1) }));
      console.log(JSON.stringify({ event: 'result', turnId: input.id, reply: 'ok', provider: 'test-fake-llm', model: 'test-fake-llm' }));
    }
  `);
  return cli;
}

async function withStore<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-compact-'));
  const saved = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
  try {
    return await run(dir);
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMPACT_DEPS = { config: { ...CHAT_DEFAULTS.autoCompact }, modelId: 'test-fake-llm' } as const;

// A real JSONL pipe is required here: the claim is dispatch ordering and stream timing,
// not model speed. The child and summary provider remain fake and network-free.
test('empty first turns skip compaction preparation and measure only delivered text', async () => {
  await withStore(async (dir) => {
    const id = createSession({ source: 'tui' }).id;
    const provider = fakeSummaryProvider();
    const cli = join(dir, 'latency-cli.ts');
    writeFileSync(cli, `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const { id } = JSON.parse(line);
        console.log(JSON.stringify({ event: 'delta', turnId: 'stale', text: 'stale', source: 'assistant-text' }));
        console.log(JSON.stringify({ event: 'delta', turnId: id, text: '', source: 'assistant-text' }));
        console.log(JSON.stringify({ event: 'delta', turnId: id, text: 'answer', source: 'assistant-text' }));
        console.log(JSON.stringify({ event: 'result', turnId: id }));
      }
    `);
    const log = spyOn(debug, 'log');
    const seen: string[] = [];
    try {
      for (let turn = 0; turn < 2; turn++) {
        await runLocalChatTurn(id, 'private question', new AbortController().signal, cli, undefined,
          (delta) => seen.push(delta), { deps: { ...COMPACT_DEPS, provider } });
      }
      const receipts = log.mock.calls.filter((c) => c[0] === 'tui.next' && c[1] === 'turn-latency')
        .map((c) => c[2] as {
          compactReason: string; compactImportMs: number; compactMs: number;
          firstAssistantTextMs: number; dispatchMs: number; totalMs: number;
          outcome: string; reusedChild: boolean;
        });
      expect(receipts).toHaveLength(2);
      expect(provider.calls).toBe(0);
      expect(seen).toEqual(['', 'answer', '', 'answer']);
      for (const receipt of receipts) {
        expect(receipt.compactReason).toBe('empty-session');
        expect(receipt.compactImportMs).toBe(0);
        expect(receipt.compactMs).toBe(0);
        expect(receipt.firstAssistantTextMs).toBeGreaterThanOrEqual(receipt.dispatchMs);
        expect(receipt.totalMs).toBeGreaterThanOrEqual(receipt.firstAssistantTextMs);
        expect(receipt.outcome).toBe('completed');
        expect(JSON.stringify(receipt)).not.toContain('private question');
      }
      expect(receipts.map((r) => r.reusedChild)).toEqual([false, true]);
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

test('latency observation failures cannot turn a completed JSONL response into an error', async () => {
  await withStore(async (dir) => {
    const id = createSession({ source: 'tui' }).id;
    const log = spyOn(debug, 'log').mockImplementation((...args) => {
      if (args[0] === 'tui.next' && args[1] === 'turn-latency') throw new Error('observer unavailable');
    });
    try {
      await expect(runLocalChatTurn(id, 'question', new AbortController().signal, storeCountingCli(dir),
        undefined, undefined, { deps: COMPACT_DEPS })).resolves.toEqual({ goalComplete: false });
      expect(log.mock.calls.some((c) => c[1] === 'turn-latency')).toBe(true);
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

test('cancellation after the route-decision import rejects and matches the terminal receipt', async () => {
  await withStore(async (dir) => {
    const id = createSession({ source: 'tui' }).id;
    const abort = new AbortController();
    // Inject cancellation at the resumed side of the actual dynamic-import boundary.
    // This deterministically exercises the gap after the earlier result abort check,
    // without sleeps or replacing module imports shared by other tests.
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'llm.route-decision' && event === 'local-chat-executed') abort.abort();
    });
    try {
      await expect(runLocalChatTurn(id, 'private question', abort.signal, storeCountingCli(dir),
        undefined, undefined, { deps: COMPACT_DEPS })).rejects.toThrow('응답을 취소했습니다');
      expect(abort.signal.aborted).toBe(true);
      expect(log.mock.calls.filter((c) => c[0] === 'llm.route-decision'
        && c[1] === 'local-chat-executed')).toHaveLength(1);
      const receipts = log.mock.calls.filter((c) => c[0] === 'tui.next' && c[1] === 'turn-latency');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]![2]).toMatchObject({ sessionId: id, outcome: 'cancelled' });
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

for (const failure of ['compact-prepare', 'compact-cancel', 'child-create'] as const) {
  test(`latency has one terminal receipt for ${failure} before JSONL dispatch`, async () => {
    await withStore(async (dir) => {
      const id = createSession({ source: 'tui' }).id;
      const abort = new AbortController();
      const log = spyOn(debug, 'log');
      // A native spawn boundary is required to prove a constructor failure without starting
      // a child. Preparation failures/cancellation must never reach that boundary at all.
      const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('fake child creation failed'); });
      const deps = {
        get config() {
          if (failure === 'compact-prepare') throw new Error('fake compact preparation failed');
          if (failure === 'compact-cancel') abort.abort();
          return COMPACT_DEPS.config;
        },
      };
      try {
        const turn = runLocalChatTurn(id, 'private question', abort.signal, join(dir, 'unused-cli.ts'),
          undefined, undefined, { deps });
        await expect(turn).rejects.toThrow(failure === 'compact-prepare' ? 'fake compact preparation failed'
          : failure === 'compact-cancel' ? '응답을 취소했습니다' : 'fake child creation failed');
        expect(spawn).toHaveBeenCalledTimes(failure === 'child-create' ? 1 : 0);
        const receipts = log.mock.calls.filter((c) => c[0] === 'tui.next' && c[1] === 'turn-latency');
        expect(receipts).toHaveLength(1);
        expect(receipts[0]![2]).toMatchObject({
          sessionId: id, outcome: failure === 'compact-cancel' ? 'cancelled' : 'error',
          dispatchMs: null, firstDeltaMs: null, firstAssistantTextMs: null,
        });
        expect(JSON.stringify(receipts[0]![2])).not.toContain('private question');
      } finally {
        spawn.mockRestore();
        log.mockRestore();
        await closeLocalChatSession(id);
      }
    });
  });
}

test('over the shared threshold: one compaction runs before the prompt reaches the child', async () => {
  await withStore(async (dir) => {
    // 12 × ~3k tokens ≈ 36k > 0.85 × 32k (test-fake-llm window) — over the default trigger.
    const id = seedSession(12, 12_000);
    const provider = fakeSummaryProvider();
    const seen: string[] = [];
    const outcomes: NextTuiCompactOutcome[] = [];
    const log = spyOn(debug, 'log');
    try {
      await runLocalChatTurn(id, '다음 질문', new AbortController().signal, storeCountingCli(dir), undefined, (d) => seen.push(d), {
        deps: { ...COMPACT_DEPS, provider },
        onCompact: (outcome) => outcomes.push(outcome),
      });
      expect(provider.calls).toBe(1);
      expect(outcomes.length).toBe(1);
      const outcome = outcomes[0]!;
      expect(outcome.before).toBe(12);
      expect(outcome.after).toBeLessThan(12);
      expect(outcome.status).toBe(`Compacted 12→${outcome.after} messages`);
      // The child read the store after compaction: it saw the compacted count, not 12.
      expect(seen).toEqual([`seen=${outcome.after}`]);
      const calls = log.mock.calls.filter((c) => c[0] === 'tui.next' && c[1] === 'compact');
      expect(calls.length).toBe(1);
      expect(calls[0]![2]).toEqual({ auto: true, before: 12, after: outcome.after, ms: expect.any(Number) });
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

test('under the shared threshold: zero compactions and the store is untouched', async () => {
  await withStore(async (dir) => {
    const id = seedSession(8, 100);
    const provider = fakeSummaryProvider();
    const seen: string[] = [];
    const outcomes: NextTuiCompactOutcome[] = [];
    const log = spyOn(debug, 'log');
    try {
      await runLocalChatTurn(id, '짧은 질문', new AbortController().signal, storeCountingCli(dir), undefined, (d) => seen.push(d), {
        deps: { ...COMPACT_DEPS, provider },
        onCompact: (outcome) => outcomes.push(outcome),
      });
      expect(provider.calls).toBe(0);
      expect(outcomes).toEqual([]);
      expect(seen).toEqual(['seen=8']);
      expect(log.mock.calls.some((c) => c[0] === 'tui.next' && c[1] === 'compact')).toBe(false);
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

test('a failing compaction is observed and the turn is sent uncompacted', async () => {
  await withStore(async (dir) => {
    const id = seedSession(12, 12_000);
    const provider = fakeSummaryProvider();
    provider.summarize = async () => { provider.calls++; throw new Error('summarizer down'); };
    const seen: string[] = [];
    const log = spyOn(debug, 'log');
    try {
      await runLocalChatTurn(id, '다음 질문', new AbortController().signal, storeCountingCli(dir), undefined, (d) => seen.push(d), {
        deps: { ...COMPACT_DEPS, provider },
      });
      expect(provider.calls).toBe(1);
      expect(seen).toEqual(['seen=12']);
      expect(log).toHaveBeenCalledWith('tui.next', 'compact-failed', { auto: true, ms: expect.any(Number), error: 'summarizer down' }, { level: 'warn' });
    } finally {
      log.mockRestore();
      await closeLocalChatSession(id);
    }
  });
});

test('/compact compacts once regardless of the threshold', async () => {
  await withStore(async () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand(' /compact ')).toBe(true);
    for (const text of ['/compactx', '/compact now', 'compact', '/new']) expect(isCompactCommand(text)).toBe(false);
    const id = seedSession(8, 100); // under threshold
    const provider = fakeSummaryProvider();
    const log = spyOn(debug, 'log');
    try {
      const outcome = await compactNextTuiSession(id, { force: true }, { ...COMPACT_DEPS, provider });
      expect(provider.calls).toBe(1);
      expect(outcome.fired).toBe(true);
      expect(outcome.before).toBe(8);
      expect(outcome.after).toBeLessThan(8);
      expect(loadSession(id)?.messages.length).toBe(outcome.after);
      expect(outcome.status).toBe(`Compacted 8→${outcome.after} messages`);
      expect(log).toHaveBeenCalledWith('tui.next', 'compact', { auto: false, before: 8, after: outcome.after, ms: expect.any(Number) });
    } finally {
      log.mockRestore();
    }
  });
});

// L3: the real `--tui next` CLI in a real PTY (node-pty) with the network-free fake LLM
// (src/ux-sim/fake-llm.ts). The long conversation is injected through the real session store
// (appendMessage) before boot; the summarizer is the shipped default provider, which resolves to
// the same fake LLM — the summary text in the store proves no real provider was called.
// Set ELANOUS_NEXT_COMPACT_LIVE_OUT=<dir> to keep the universe and write the screens there.
const PROVIDER_KEYS = [
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
] as const;
function credentialFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(_API_KEY|_TOKEN|_AUTH|_BASE_URL)$/i.test(key) || /^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

test('next TUI in a real PTY (L3): a long session compacts before the turn, then /compact runs once more', async () => {
  if (!ptyAvailable()) return;
  const live = process.env.ELANOUS_NEXT_COMPACT_LIVE_OUT?.trim();
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-compact-l3-'));
  const iso = live ? join(live, 'iso') : dir;
  mkdirSync(iso, { recursive: true });
  // First-run onboarding would otherwise ask for a provider before the TUI opens.
  writeFileSync(join(iso, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const sessionsRoot = join(iso, 'sessions');
  const saved = { state: process.env.ELANOUS_STATE_DIR, root: process.env.ELANOUS_SESSION_ROOT };
  process.env.ELANOUS_STATE_DIR = iso;
  process.env.ELANOUS_SESSION_ROOT = sessionsRoot;
  // 12 × ~3k tokens ≈ 36k > 0.85 × 32k — the fake LLM's model (test-fake-llm) gets the 32k default window.
  const id = seedSession(12, 12_000);
  setActiveSessionId(id);
  const repo = join(import.meta.dir, '..', '..');
  const reply = '[fake-llm] 답했습니다';
  const pty = startPty({
    cmd: process.execPath,
    // Bare Next is deliberately a fresh session; this test seeds an existing session.
    args: [join(repo, 'bin', 'elanous.mjs'), '--config-dir', iso, '--test-state-dir', iso, '--resume', id, '--tui', 'next'],
    cols: 80,
    rows: 24,
    workdir: iso,
    // The PTY env is rebuilt from the login-shell capture; dropping a key from `env` is not enough.
    unsetEnv: PROVIDER_KEYS,
    env: {
      ...credentialFreeEnv(),
      HOME: iso,
      // Without this the CLI re-imports provider keys from the login shell (shell-env-bootstrap.ts).
      ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_STATE_DIR: iso,
      ELANOUS_SESSION_ROOT: sessionsRoot,
      ELANOUS_TEST_FAKE_LLM: '1',
      ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
    },
  });
  const screens: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (label: string, done: (screen: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 60_000;
    let screen = '';
    while (Date.now() < deadline) {
      screen = await pty.renderScreen();
      if (done(screen)) {
        screens.push(`===== ${label} =====\n${screen}`);
        return screen;
      }
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}\n${screen}`);
  };
  const send = async (text: string) => {
    pty.write(text);
    await sleep(150);
    pty.write('\r');
  };
  try {
    await waitFor('before (12 seeded messages)', (s) => /^elanous$/m.test(s) && s.includes('Ctrl+Q quit') && s.includes('xxxx'));
    await send('긴 대화 뒤 질문');
    const after = await waitFor('after turn (auto compact)', (s) => s.includes('Turn done') && s.includes(reply));
    const auto = /Compacted (\d+)→(\d+) messages/.exec(after);
    expect(auto).not.toBeNull();
    const [autoBefore, autoAfter] = [Number(auto![1]), Number(auto![2])];
    expect(autoBefore).toBe(12);
    expect(autoAfter).toBeLessThan(autoBefore);
    const stored = loadSession(id)?.messages ?? [];
    // compacted history + this turn's user/assistant pair
    expect(stored.length).toBe(autoAfter + 2);
    const summary = stored.find((m) => m.role === 'system' && m.content.includes('<context_summary>'));
    expect(summary?.content).toContain(reply);
    expect(stored.slice(-2).map((m) => m.content)).toEqual(['긴 대화 뒤 질문', reply]);
    await send('/compact');
    const manualPattern = new RegExp(`Compacted (${autoAfter + 2})→(\\d+) messages`);
    const manual = await waitFor('after /compact', (s) => manualPattern.test(s));
    const forced = manualPattern.exec(manual)!;
    expect(Number(forced[1])).toBe(autoAfter + 2);
    expect(Number(forced[2])).toBeLessThan(Number(forced[1]));
    expect(loadSession(id)?.messages.length).toBe(Number(forced[2]));
    screens.push(`===== store =====\nsession ${id} messages=${loadSession(id)?.messages.length} summary=${JSON.stringify(summary?.content.slice(0, 80))}`);
  } finally {
    pty.write('\x11');
    await sleep(1500);
    try { pty.kill(); } catch { /* already exited */ }
    if (live) writeFileSync(join(live, 'screens.txt'), `${screens.join('\n\n')}\n`);
    if (saved.state === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = saved.state;
    if (saved.root === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = saved.root;
    rmSync(dir, { recursive: true, force: true });
  }
}, 150_000);

test('tool activity carries only the safe target through a live child before the final reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tool-target-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, [
    "import { createInterface } from 'node:readline';",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "const input = JSON.parse(line);",
    "console.log(JSON.stringify({event:'tool-activity',turnId:input.id,phase:'start',id:'write',name:'Write',target:'/private/demo/ticketing.html'}));",
    "console.log(JSON.stringify({event:'tool-activity',turnId:'stale',phase:'start',id:'stale',name:'Write',target:'PRIVATE-stale'}));",
    "console.log(JSON.stringify({event:'tool-activity',turnId:input.id,phase:'finish',id:'write',name:'Write'}));",
    "console.log(JSON.stringify({turnId:input.id,reply:'done'}));",
    "}",
  ].join('\n'));
  const events: import('./local-chat-turn.js').LocalChatToolActivity[] = [];
  try {
    await runLocalChatTurn('tool-target-session', 'write', new AbortController().signal, cli,
      undefined, undefined, undefined, [], undefined, undefined, undefined, event => events.push(event));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: 'start', name: 'Write', target: 'ticketing.html' });
    expect(events[1]).toMatchObject({ phase: 'finish', name: 'Write' });
    expect(JSON.stringify(events)).not.toContain('/private/demo');
    expect(JSON.stringify(events)).not.toContain('PRIVATE-stale');
  } finally {
    await closeLocalChatSession('tool-target-session');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HARNESS-CHILD-PROVIDER-PASSTHROUGH: the session provider reaches the REPL child env and a switch respawns it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-provider-passthrough-'));
  const cli = join(dir, 'provider-env-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const seen = { pid: process.pid, provider: process.env.ELANOUS_LLM_PROVIDER ?? null, model: process.env.ELANOUS_LLM_MODEL ?? null };
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(seen) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'env' }));
    }
  `);
  const replies: string[] = [];
  const logs = spyOn(debug, 'log');
  // TUI-GLM-PROVIDER-USES-ZAI-CODING-PLAN: a glm turn now preflights the Z.ai key — give it a synthetic one.
  const savedZaiKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'synthetic-zai-passthrough';
  try {
    setSessionProvider('provider-passthrough', { provider: 'glm', model: 'glm-5' });
    await runLocalChatTurn('provider-passthrough', 'hi', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    await runLocalChatTurn('provider-passthrough', 'again', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    setSessionProvider('provider-passthrough', { provider: 'grok', model: 'grok-4.7' });
    await runLocalChatTurn('provider-passthrough', 'switched', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    const [first, second, third] = replies.map((reply) => JSON.parse(reply) as { pid: number; provider: string; model: string });
    expect(first).toMatchObject({ provider: 'glm', model: 'glm-5' });
    expect(second!.pid).toBe(first!.pid);
    expect(third).toMatchObject({ provider: 'grok', model: 'grok-4.7' });
    expect(third!.pid).not.toBe(first!.pid);
    const resolves = logs.mock.calls.filter((call) => call[0] === 'child.provider' && call[1] === 'resolve').map((call) => call[2]);
    expect(resolves).toContainEqual(expect.objectContaining({
      mode: 'passthrough', kind: 'repl-child', parentProvider: 'glm', parentModel: 'glm-5', childProvider: 'glm', childModel: 'glm-5', source: 'session',
    }));
  } finally {
    if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = savedZaiKey;
    logs.mockRestore();
    clearSessionProvider('provider-passthrough');
    await closeLocalChatSession('provider-passthrough');
    rmSync(dir, { recursive: true, force: true });
  }
});

// Owner publish approval over the real child-process IPC: the URL arrives as a structured field and reaches the publish screen's
// handler — never the plain text prompt. Without that handler (or with a URL that is not a public https URL) the request falls
// back to the text confirmation, so the owner is never left without a way to answer.
const publishCli = (dir: string, name: string, publish: string): string => {
  const cli = join(dir, name);
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    if (process.env.ELANOUS_NEXT_TUI_SHELL_APPROVAL_IPC !== '1') process.exit(12);
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const response = new Promise((resolve) => process.once('message', resolve));
      process.send({ type: 'elanous.shell-approval.call', callId: 'p1', kind: 'graph', command: 'PLAIN-FALLBACK-TEXT', publish: ${publish} });
      const result = await response;
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: JSON.stringify(result) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done', provider: 'test', model: 'ipc' }));
    }
  `);
  return cli;
};

test('a publish approval call reaches the publish screen handler with the URL, not the text prompt handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-publish-approval-ipc-'));
  const cli = publishCli(dir, 'publish-cli.ts', "{ url: 'https://approve.example.com/a/1?t=tok', expiresAt: '2030-01-01T00:00:00Z' }");
  const replies: string[] = [];
  const textPrompts: string[] = [];
  const calls: Array<{ url: string; expiresAt: string; callId: string }> = [];
  try {
    setNextTuiShellApprovalHandler(async (command) => { textPrompts.push(command); return false; });
    setNextTuiPublishApprovalHandler(async (call, callId) => { calls.push({ ...call, callId }); return true; });
    await runLocalChatTurn('publish-approval-ipc', 'test approval', new AbortController().signal, cli, undefined, (delta) => replies.push(delta));
    expect(calls).toEqual([{ url: 'https://approve.example.com/a/1?t=tok', expiresAt: '2030-01-01T00:00:00Z', callId: 'p1' }]);
    expect(textPrompts).toEqual([]);
    expect(JSON.parse(replies[0] ?? 'null')).toEqual({ type: 'elanous.shell-approval.result', callId: 'p1', approved: true });
  } finally {
    setNextTuiPublishApprovalHandler(null);
    setNextTuiShellApprovalHandler(null);
    await closeLocalChatSession('publish-approval-ipc');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a publish screen, or with a URL that is not public https, the request falls back to the text confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-publish-approval-fallback-'));
  const noScreen = publishCli(dir, 'no-screen-cli.ts', "{ url: 'https://approve.example.com/a/1', expiresAt: '2030-01-01T00:00:00Z' }");
  const badUrl = publishCli(dir, 'bad-url-cli.ts', "{ url: 'http://approve.example.com/a/1', expiresAt: '2030-01-01T00:00:00Z' }");
  const textPrompts: string[] = [];
  const replies: string[] = [];
  try {
    setNextTuiShellApprovalHandler(async (command) => { textPrompts.push(command); return true; });
    setNextTuiPublishApprovalHandler(null);
    await runLocalChatTurn('publish-approval-no-screen', 'test approval', new AbortController().signal, noScreen, undefined, (delta) => replies.push(delta));
    setNextTuiPublishApprovalHandler(async () => { throw new Error('the publish screen must not get a non-https URL'); });
    await runLocalChatTurn('publish-approval-bad-url', 'test approval', new AbortController().signal, badUrl, undefined, (delta) => replies.push(delta));
    expect(textPrompts).toEqual(['PLAIN-FALLBACK-TEXT', 'PLAIN-FALLBACK-TEXT']);
    for (const reply of replies) expect(JSON.parse(reply)).toMatchObject({ approved: true });
  } finally {
    setNextTuiPublishApprovalHandler(null);
    setNextTuiShellApprovalHandler(null);
    await closeLocalChatSession('publish-approval-no-screen');
    await closeLocalChatSession('publish-approval-bad-url');
    rmSync(dir, { recursive: true, force: true });
  }
});
