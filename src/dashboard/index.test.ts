import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createProject } from '../project/project-store.js';
import { setElanousConfigDir, getElanousConfigDirOverride, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createSession, listSessions } from '../session/index.js';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { Terminal as XtermHeadless } from '@xterm/headless';

import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import type { ToolRunResult, ToolRuntime } from '../tool-runtime/types.js';
import { DisplayCoordinator } from '../display/index.js';
import {
  createDashboardAdRunSetupBindings,
  dashboardOptionalProductionInputs,
  createDashboardAdRunSetupFactory,
  createDashboardAdSlashRuntime,
  dashboardAdAssetPresetPath,
  dashboardAdCommandRunner,
  dispatchLogZoneClick,
  flattenForkableSessionHistory,
  observeDashboardToolDispatchSignal,
  openSyncSetupWindow,
  activeEscHarnessSpace,
  createEscAbortToolState,
  trackEscAbortToolCall,
  settleEscAbortToolCall,
  registerDashboardFinderAndHistoryKeys,
  activeDashboardTypeaheadSessionId,
  applyDashboardStreamingTypeaheadKey,
  subscribeDashboardAgentResults,
  beginSynchronizedFrameOutput,
  drawDashboardFrameSynchronized,
  runSynchronizedFrameDraw,
  SYNCHRONIZED_OUTPUT_BEGIN,
  SYNCHRONIZED_OUTPUT_END,
  type LogZoneClickWidgetHost,
} from './index.js';
import { buildAdRunSetup } from '../ad-pipeline/ad-run-setup.js';
import type { CommandRunner } from '../ad-pipeline/higgsfield-backend.js';
import { dispatchDashboardSessionRuntimeTool } from './session-runtime-dispatch.js';
import { HYDRATED_TOOLS_KEY } from '../skills/tools/tool-search-spec.js';
import { toolSearchRuntime } from '../tool-runtime/tool-search-runtime.js';
import { tuiSourceText } from '../../test/helpers/dashboard-source.js';
import { createTurnTypeaheadState } from '../chat/turn-typeahead.js';
import { handoffTurnTypeaheadAtTurnEnd, steerLastTurnTypeaheadSubmission } from './input/turn-steer-bridge.js';
import { clearPendingUserInput, drainPendingUserInput, pendingUserInputCount } from '../session/pending-input.js';
import { streamLLMWithTools, type LLMProvider } from '../llm.js';
import { ptyAvailable, startPty, unregisterPty } from '../pty-shell/registry.js';
import { AgentRegistry } from '../agent/registry.js';
import { TaskNotificationQueue, renderTaskNotificationsXml } from '../agent/task-notification.js';
import { wireTaskNotifications } from '../agent/task-notification.js';
import {
  isSynchronizedOutputRegionOpen,
  openSynchronizedOutputRegion,
} from '../display/synchronized-output-region.js';

// 시험이 process.chdir 로 옮긴 cwd 를 시간 초과에도 되돌린다(비동기 본문의 finally 는 afterEach 보다 늦을 수 있다 · test-interference 래칫).
const FILE_START_CWD = process.cwd();
afterEach(() => {
  if (process.cwd() !== FILE_START_CWD) process.chdir(FILE_START_CWD);
});

const repoRoot = resolve(import.meta.dir, '../..');
const dashboard = tuiSourceText();

test('agent completion enters dashboard history with a 500-char preview and openable full result after drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-agent-result-'));
  const registry = new AgentRegistry();
  const queue = new TaskNotificationQueue(root);
  const lines: string[] = [];
  const offRegistry = wireTaskNotifications(queue, registry);
  const offHistory = subscribeDashboardAgentResults(queue, () => {}, line => { lines.push(line); });
  const result = 'r'.repeat(49_990) + 'TAIL-12345';
  try {
    const provider: LLMProvider = {
      name: 'result-test', defaultModel: 'test', available: () => true,
      async *chat() { yield result; },
      async *streamChat() { yield { type: 'text' as const, delta: result }; },
    };
    const handle = registry.spawn({
      definition: { name: 'result-child', systemPrompt: 'Test child' },
      prompt: 'complete', provider, background: true,
    });
    for await (const _event of handle.events) { /* wait for actual runner completion */ }
    expect(lines).toHaveLength(0);
    const notifications = queue.drain();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.state).toBe('done');
    expect(notifications[0]!.output.length).toBeLessThanOrEqual(500);
    expect(lines).toHaveLength(1);
    const renderedHistory = lines.join('\n');
    const path = renderedHistory.split(' · full result: ')[1]?.split(' · summary: ')[0];
    expect(path ?? '').toBe(notifications[0]!.resultPath ?? '');
    expect(renderTaskNotificationsXml(notifications)).toContain(path!);
    const opened = readFileSync(path as string, 'utf8');
    expect(opened).toBe(result);
    expect(opened.slice(-10)).toBe('TAIL-12345');
    console.log(`DASHBOARD_RESULT history-length=${renderedHistory.length} summary-length=${notifications[0]!.output.length} opened-path=${path} opened-length=${opened.length} tail=${opened.slice(-10)}`);
  } finally {
    offHistory(); offRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated dashboard renders the 50,000-character child result only after queue drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-result-screen-'));
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, llm: { provider: 'local', model: 'test-model' }, mcp: { enabled: false },
  }));
  const readyPath = join(root, 'ready');
  const drainPath = join(root, 'drain');
  const childScript = `
    import { showDashboard } from './src/dashboard/index.ts';
    import { globalAgentRegistry } from './src/agent/registry.ts';
    import { globalTaskNotificationQueue } from './src/agent/task-notification.ts';
    import { existsSync, writeFileSync } from 'node:fs';
    const evidencePath = __EVIDENCE_PATH__;
    const readyPath = __READY_PATH__;
    const drainPath = __DRAIN_PATH__;
    process.on('uncaughtException', error => { writeFileSync(evidencePath, 'ERROR ' + String(error)); process.exit(1); });
    process.on('unhandledRejection', error => { writeFileSync(evidencePath, 'ERROR ' + String(error)); process.exit(1); });
    const result = 'r'.repeat(49_990) + 'TAIL-12345';
    let firstFrame = () => {};
    const rendered = new Promise(resolve => { firstFrame = resolve; });
    void (async () => {
      try {
        await rendered;
        await Bun.sleep(1000);
        const handle = globalAgentRegistry.spawn({
          definition: { name: 'screen-child', systemPrompt: 'Test child' },
          prompt: 'complete', background: true,
          provider: { name: 'screen-fake', defaultModel: 'test', available: () => true,
            async *chat() { yield result; },
            async *streamChat() { yield { type: 'text', delta: result }; } },
        });
        for await (const _ of handle.events) {}
        if (globalTaskNotificationQueue.size !== 1) throw new Error('completion did not enqueue');
        writeFileSync(readyPath, 'enqueued');
        while (!existsSync(drainPath)) await Bun.sleep(50);
        const notices = globalTaskNotificationQueue.drain();
        writeFileSync(evidencePath, JSON.stringify({ count: notices.length, state: notices[0]?.state,
          resultPath: notices[0]?.resultPath, summaryLength: notices[0]?.output.length }));
      } catch (error) { writeFileSync(evidencePath, 'ERROR ' + String(error)); process.exit(1); }
    })();
    await showDashboard({ onFirstFrameRendered: () => firstFrame() });
  `;
  const scriptPath = join(repoRoot, '.elanous-test', 'scratch', `dashboard-result-${process.pid}.ts`);
  mkdirSync(join(repoRoot, '.elanous-test', 'scratch'), { recursive: true });
  const evidencePath = join(root, 'screen-result.txt');
  writeFileSync(scriptPath, childScript.replaceAll("'./src/", "'../../src/")
    .replace('__EVIDENCE_PATH__', JSON.stringify(evidencePath))
    .replace('__READY_PATH__', JSON.stringify(readyPath))
    .replace('__DRAIN_PATH__', JSON.stringify(drainPath)));
  // 격리 무대: HOME·state·data 를 뿌리 안으로(전문 파일이 저장소 data/ 나 ~/.elanous 로 새지 않게),
  // 로그인 셸 env 수입 끔, 공급자 자격 모양 env 는 지운다.
  const dataDir = join(root, 'data');
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development',
    HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_DATA_DIR: dataDir,
    ELANOUS_SKIP_LOGIN_ENV: '1', TERM: 'xterm-256color', COLUMNS: '400', LINES: '40' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const credentialEnv = /(_API_KEY|_TOKEN|_AUTH|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;
  for (const key of Object.keys(env)) if (credentialEnv.test(key)) delete env[key];
  const pty = ptyAvailable() && process.env.ELANOUS_TEST_SCREEN_PIPE !== '1' ? startPty({ cmd: 'bun', args: [scriptPath], workdir: repoRoot,
    cols: 400, rows: 40, env, unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] }) : null;
  const terminal = pty ? null : new XtermHeadless({ cols: 400, rows: 40, allowProposedApi: true });
  const child = pty ? null : spawn('script', ['-q', '-c', `stty cols 400 rows 40; bun ${JSON.stringify(scriptPath)}`, '/dev/null'],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child?.stdout?.on('data', (chunk: Buffer) => { terminal?.write(chunk.toString('utf8')); });
  let stderr = '';
  child?.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const handle = pty ?? { renderScreen: async (): Promise<string> => {
    await new Promise<void>(resolveWrite => terminal!.write('', resolveWrite));
    const buffer = terminal!.buffer.active;
    return Array.from({ length: 40 }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').join('\n');
  } };
  const chatLog = (screen: string): string[] => {
    const rows = screen.split('\n');
    const title = rows.findIndex(row => row.includes('ChatLog'));
    if (title < 0) return [];
    const end = rows.findIndex((row, index) => index > title && (row.includes('❯') || row.includes('Debug Log')));
    return rows.slice(title + 1, end > title ? end : undefined);
  };
  try {
    // ⏱️ 예산 정합: 자식은 HOME 이 매번 새 tmpdir 이라 bun transpile 캐시($HOME/.bun)가 차가워
    //    showDashboard 부팅이 느린 호스트에서 수십 초 걸린다 — 내부 마감은 반드시 시험 타임아웃보다
    //    작아야 한다(이전: 마감 45s > 타임아웃 35s 라서 느린 자식은 단언 실패 대신 러너 타임아웃으로 죽었다).
    const deadline = Date.now() + 100_000;
    while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(100);
    expect(existsSync(readyPath)).toBe(true);
    const beforeRows = chatLog(await handle.renderScreen());
    expect(beforeRows.length).toBeGreaterThan(0);
    expect(beforeRows.some(line => line.includes('Agent result · full result:'))).toBe(false);
    writeFileSync(drainPath, 'drain');
    while (!existsSync(evidencePath) && Date.now() < deadline) await Bun.sleep(100);
    const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : `missing; stderr=${stderr}`;
    expect(evidence).not.toStartWith('ERROR');
    const notice = JSON.parse(evidence) as { count: number; state: string; resultPath: string; summaryLength: number };
    expect(notice.count).toBe(1);
    expect(notice.state).toBe('done');
    expect(notice.summaryLength).toBeLessThanOrEqual(500);
    let historyLine: string | undefined;
    const historyDeadline = Date.now() + 5_000;
    while (!historyLine && Date.now() < historyDeadline) {
      historyLine = chatLog(await handle.renderScreen()).find(line => line.includes('Agent result · full result:'));
      if (!historyLine) await Bun.sleep(100);
    }
    expect(historyLine).toBeDefined();
    const path = historyLine!.split('full result: ')[1]?.split(' · summary: ')[0];
    expect(path).toBe(notice.resultPath);
    expect(path!.startsWith(join(dataDir, 'agent-results') + '/')).toBe(true);
    expect(historyLine).toContain(' · summary: ' + 'r'.repeat(30));
    expect(historyLine!.length).toBeLessThanOrEqual(400);
    const opened = readFileSync(path!, 'utf8');
    expect(opened).toBe('r'.repeat(49_990) + 'TAIL-12345');
    expect(opened.slice(-10)).toBe('TAIL-12345');
    console.log(`SCREEN_RESULT before-chatlog-line=false history-length=${historyLine!.length} opened-path=${path} opened-length=${opened.length} tail=${opened.slice(-10)}`);
  } finally {
    pty?.kill();
    if (pty) unregisterPty(pty.id);
    child?.kill();
    terminal?.dispose();
    rmSync(scriptPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('dashboard history reports preservation failures without a success path', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-agent-failure-'));
  const queue = new TaskNotificationQueue(root, 500);
  const lines: string[] = [];
  const off = subscribeDashboardAgentResults(queue, () => {}, line => { lines.push(line); });
  try {
    queue.enqueue({ taskId: 'limit-failure', agentName: 'child', state: 'done', output: 'x'.repeat(700), truncated: false, durationMs: 1, finishedAt: 1 });
    expect(lines).toHaveLength(0);
    const [notice] = queue.drain();
    expect(notice?.state).toBe('error');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('result length 700 exceeds limit 500');
    expect(lines[0]).not.toContain('full result:');
  } finally {
    off();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!ptyAvailable())('production showDashboard opens one idle child-complete turn and refuses a second while busy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-agent-wake-live-'));
  const state = join(root, 'state');
  const data = join(root, 'data');
  const isolatedHome = join(root, 'home');
  const seatCwd = join(root, 'repo', 'seats', 'OPC');
  mkdirSync(state);
  mkdirSync(seatCwd, { recursive: true });
  mkdirSync(join(isolatedHome, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
  const firstRequest = join(root, 'first-request');
  const busyQueued = join(root, 'busy-queued');
  const releaseFirst = join(root, 'release-first');
  const secondRequest = join(root, 'second-request');
  const driver = join(root, 'driver.ts');
  const requests: Array<{ messages?: Array<{ content?: unknown }> }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'wake-test' }] });
      if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      requests.push(await request.json() as { messages?: Array<{ content?: unknown }> });
      const index = requests.length;
      writeFileSync(index === 1 ? firstRequest : secondRequest, String(index));
      if (index === 1) {
        const deadline = Date.now() + 30_000;
        while (!existsSync(releaseFirst) && Date.now() < deadline) await Bun.sleep(20);
        if (!existsSync(releaseFirst)) return new Response('held request timed out', { status: 504 });
      }
      const body = `data: ${JSON.stringify({ choices: [{ delta: { content: `wake-response-${index}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'local', model: 'wake-test', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false }, mcp: { enabled: false },
  }));
  writeFileSync(driver, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `const firstRequest = ${JSON.stringify(firstRequest)};`,
    `const busyQueued = ${JSON.stringify(busyQueued)};`,
    `const firstFrame = ${JSON.stringify(join(root, 'first-frame'))};`,
    `const bootError = ${JSON.stringify(join(root, 'boot-error'))};`,
    `const { setElanousConfigDir } = await import(${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))});`,
    `setElanousConfigDir(${JSON.stringify(state)});`,
    `const { showDashboard } = await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});`,
    `const { globalTaskNotificationQueue } = await import(${JSON.stringify(join(import.meta.dir, '../agent/task-notification.ts'))});`,
    "const enqueue = (taskId: string) => globalTaskNotificationQueue.enqueue({ taskId, agentName: 'wake-fixture', state: 'done', output: `result-${taskId}`, truncated: false, durationMs: 1, finishedAt: Date.now() });",
    "process.on('uncaughtException', error => { writeFileSync(bootError, String(error)); process.exit(1); });",
    "process.on('unhandledRejection', error => { writeFileSync(bootError, String(error)); process.exit(1); });",
    "setTimeout(() => { writeFileSync(bootError, 'first-frame timeout'); process.exit(1); }, 105_000).unref();",
    'void showDashboard({ onFirstFrameRendered: () => { writeFileSync(firstFrame, "ready"); } }).catch(error => { writeFileSync(bootError, String(error)); process.exit(1); });',
    'while (!existsSync(firstFrame) && !existsSync(bootError)) await Bun.sleep(20);',
    'await Bun.sleep(500); enqueue("idle-completion");',
    'while (!existsSync(firstRequest)) await Bun.sleep(20);',
    'enqueue("busy-completion"); writeFileSync(busyQueued, "queued");',
    'await new Promise(() => {});',
  ].join('\n'));
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development',
    ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_DATA_DIR: data,
    ELANOUS_SKIP_LOGIN_ENV: '1', HOME: isolatedHome, TERM: 'xterm-256color', COLUMNS: '120', LINES: '30' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const credentialEnv = /(_API_KEY|_TOKEN|_AUTH|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;
  for (const key of Object.keys(env)) if (credentialEnv.test(key)) delete env[key];
  const handle = startPty({ cmd: 'bun', args: [driver], workdir: seatCwd, cols: 120, rows: 30, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  const deadline = Date.now() + 100_000;
  const waitFor = async (path: string, label: string) => {
    while (!existsSync(path) && !existsSync(join(root, 'boot-error')) && Date.now() < deadline) await Bun.sleep(50);
    if (existsSync(join(root, 'boot-error'))) throw new Error(`agent-wake live boot failed: ${readFileSync(join(root, 'boot-error'), 'utf8')}`);
    if (!existsSync(path)) throw new Error(`agent-wake live timeout waiting for ${label}; requests=${requests.length}; screen=${(await handle.renderScreen()).slice(-900)}`);
  };
  try {
    await waitFor(join(root, 'first-frame'), 'first frame');
    expect(readFileSync(join(root, 'first-frame'), 'utf8')).toBe('ready');
    const before = (await handle.renderScreen()).split('\n').filter(line => line.includes('ChatLog') || line.trim() === '❯').join('\n');
    await waitFor(firstRequest, 'idle completion turn');
    await waitFor(busyQueued, 'busy completion');
    await Bun.sleep(300);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages ?? [])).toContain('Question: [자동 재개] 위임 끝: wake-fixture');
    const duringBusy = (await handle.renderScreen()).split('\n').filter(line => line.includes('위임 끝') || line.includes('자동 재개')).join('\n');
    expect(duringBusy.match(/자동 재개/g)).toHaveLength(1);
    writeFileSync(releaseFirst, 'release');
    await waitFor(secondRequest, 'deferred completion turn');
    await Bun.sleep(300);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages ?? [])).toContain('Question: [자동 재개] 위임 끝: wake-fixture');
    console.log(`AGENT_WAKE_LIVE before=${JSON.stringify(before)} busy=${JSON.stringify(duringBusy)} requests=${requests.length} idle=1 busy-refused=1 deferred=1`);
  } finally {
    handle.kill(); unregisterPty(handle.id); server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!ptyAvailable())('legacy production log-search modal: same PTY direct-write rows and caret before/after', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-legacy-modal-'));
  mkdirSync(join(root, 'state'));
  // Pin a local provider so the idle prompt is the bare `❯` on every host. Without it the
  // screen depends on the runner's HOME credentials: an empty HOME (self gate child env)
  // renders `❯ /quit /clear (run `elanous setup` — no LLM provider available)` instead.
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      return new Response('not found', { status: 404 });
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    mcp: { enabled: false }, skillRouter: { llmFallback: false },
  }));
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: 'development', ELANOUS_STATE_DIR: join(root, 'state'), TERM: 'xterm-256color',
  };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const handle = startPty({ cmd: 'bun', args: ['bin/elanous.mjs', `--test=${root}`, '--legacy'],
    workdir: repoRoot, cols: 120, rows: 30, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  const trigger = '/log search\r';
  try {
    const deadline = Date.now() + 80_000;
    const wait = async (predicate: () => Promise<boolean>) => {
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(100);
      }
      throw new Error(`legacy modal timeout: ${JSON.stringify((await handle.renderScreen()).slice(-1200))}`);
    };
    await wait(async () => (await handle.renderScreen()).split('\n').some(line => line.trim() === '❯'));
    const before = await handle.renderScreen();
    const rawBefore = handle.snapshot();
    handle.drainDelta();
    handle.write(trigger);
    await wait(async () => (await handle.renderScreen()).includes('Log search'));
    const after = await handle.renderScreen();
    const rawAfter = handle.drainDelta();
    const beforeRows = before.split('\n');
    const afterRows = after.split('\n');
    const modalWrite = rawAfter.slice(rawAfter.lastIndexOf('\x1b[3;30H'));
    console.log(`LEGACY_MODAL trigger=${JSON.stringify(trigger)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} rawBeforeTail=${JSON.stringify(rawBefore.slice(-120))} rawAfterModalRows=${JSON.stringify(modalWrite.slice(0, 430))} rawAfterNewlines=${JSON.stringify(rawAfter.match(/\n/g) ?? [])}`);
    expect(beforeRows[0]).toMatch(/^\[screen 120x30 cursor=\(row \d+, col \d+, visible (true|false)\)\]$/);
    expect(afterRows[0]).toMatch(/^\[screen 120x30 cursor=\(row \d+, col \d+, visible (true|false)\)\]$/);
    expect(afterRows[0]).not.toBe(beforeRows[0]);
    expect(afterRows[3]).toContain('Log search');
    expect(afterRows[4]).toContain('/');
    expect(beforeRows.slice(1, 3)).toEqual(afterRows.slice(1, 3));
    expect(rawAfter).toContain('\x1b[3;30H');
    expect(rawAfter).toContain('\x1b[4;30H');
    // 계약 = «모달 열기»가 행 3·4 를 직접 쓰기 한 벌로 그린다 — 첫 \x1b[3;30H 부터 첫 '\n'(전면 다시그리기) 전까지의
    //    한 자루(stroke) 안에 \x1b[4;30H 가 이어져야 한다. 두 마커는 자식의 동기 write 한 번에 나가므로 이 단언은
    //    기계 속도와 무관하게 결정론적이다. 모달이 뜬 «뒤»의 다음 그리기(rows.join('\n') 전면 다시그리기 — 느린
    //    게이트 기계에서 drain 창 안으로 미끄러짐)는 stroke 바깥에 있어 이 계약과 무관하다.
    const strokeEnd = modalWrite.indexOf('\n');
    const modalStroke = strokeEnd === -1 ? modalWrite : modalWrite.slice(0, strokeEnd);
    expect(modalStroke).toContain('\x1b[4;30H');
  } finally {
    handle.kill();
    unregisterPty(handle.id);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);

test.skipIf(!ptyAvailable())('classic /mission dispatch records one private-safe usage event under default trail logging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-legacy-mission-usage-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  const slashSecret = 'SENSITIVE_SLASH_ARGUMENT_527';
  const proseSecret = 'SENSITIVE_PROMPT_BODY_527';
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'natural reply complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false },
    mcp: { enabled: false },
  }));
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development', ELANOUS_STATE_DIR: join(root, 'state'), TERM: 'xterm-256color' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const handle = startPty({ cmd: 'bun', args: ['bin/elanous.mjs', `--test=${root}`, '--legacy'], workdir: repoRoot,
    cols: 120, rows: 30, env, unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  const deadline = Date.now() + 85_000;
  const wait = async (predicate: () => Promise<boolean> | boolean) => {
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(100);
    }
    throw new Error(`legacy mission usage timeout: ${(await handle.renderScreen()).slice(-1000)}`);
  };
  try {
    await wait(async () => (await handle.renderScreen()).split('\n').some(line => line.trim() === '❯'));
    handle.write(`/mission list ${slashSecret}\r`);
    await wait(async () => (await handle.renderScreen()).includes(`/mission list ${slashSecret}  (`));
    handle.write('/zz-usage-probe\r');
    await wait(async () => (await handle.renderScreen()).includes('Unknown command: /zz-usage-probe'));
    handle.write(`Please mention /mission in prose ${proseSecret}\r`);
    await wait(async () => (await handle.renderScreen()).includes('natural reply complete'));

    const dbPath = join(root, 'logs', 'logs.db');
    await wait(() => existsSync(dbPath));
    let events: Array<{ event: string; data: string | null; session_id: string | null }> = [];
    await wait(() => {
      const db = new Database(dbPath, { readonly: true });
      try {
        events = db.query("select event, data, session_id from logs where category = 'tui.legacy-slash-use' order by id")
          .all() as typeof events;
      } finally { db.close(); }
      return events.length >= 1;
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('mission');
    const payload = JSON.parse(events[0]!.data ?? 'null') as Record<string, unknown>;
    expect(payload.surface).toBe('classic');
    expect(payload.tuiSession).toBeNull();
    expect(typeof payload.tuiPid).toBe('number');
    expect(Object.keys(payload).sort()).toEqual(['surface', 'tuiPid', 'tuiSession']);
    expect(events[0]!.session_id).toBeNull();
    expect(JSON.stringify(events)).not.toContain(slashSecret);
    expect(JSON.stringify(events)).not.toContain(proseSecret);
    handle.write('/quit\r');
  } finally {
    handle.kill();
    unregisterPty(handle.id);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 95_000);

test.skipIf(!ptyAvailable())('real dashboard streaming Enter injects a unique word once into local model requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-dedup-live-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const readTarget = join(root, 'read-target.txt');
  writeFileSync(readTarget, 'safe read target\n');
  const word = 'unique-dashboard-live-dedup';
  const requests: Array<{ messages?: Array<{ content?: unknown }> }> = [];
  const sseHeaders = { 'content-type': 'text/event-stream' } as const;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      const body = await request.json() as { messages?: Array<{ content?: unknown }> };
      requests.push(body);
      if (requests.length !== 1) {
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'second done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: sseHeaders });
      }
      // 첫 응답은 스트림을 바로 열고 청크 사이에 지연을 둔다 — 무응답 게이트로 붙잡아 두면
      // 부하 시 클라이언트의 응답 대기 한도가 먼저 터져 루프가 drain 전에 끝난다(제출 경로로 새는 플레이크).
      // 바이트가 흐르는 동안에는 그 한도가 작동하지 않아 drain 펌프가 결정론적 창을 갖는다.
      const encoder = new TextEncoder();
      const toolCall = { tool_calls: [{ index: 0, id: 'call-dedup-read', type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: readTarget }) } }] };
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (chunk: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 300));
          send({ choices: [{ delta: toolCall, finish_reason: null }] });
          for (let beat = 0; beat < 12; beat += 1) {
            await new Promise(resolve => setTimeout(resolve, 150));
            send({ choices: [{ delta: {}, finish_reason: null }] });
          }
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: sseHeaders });
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false }, mcp: { enabled: false },
  }));
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development', ELANOUS_STATE_DIR: state, TERM: 'xterm-256color' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const handle = startPty({ cmd: 'bun', args: ['bin/elanous.mjs', `--test=${root}`, '--chat-only'], workdir: repoRoot,
    cols: 120, rows: 30, env, unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  try {
    // ⏱️ 예산 정합: 콜드 부팅이 느린 호스트에서 CLI 가 프롬프트까지 50s 를 넘긴다 — 마감 < 타임아웃, 부팅 실측 여유 포함.
    const deadline = Date.now() + 120_000;
    const wait = async (predicate: () => Promise<boolean> | boolean) => {
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(100);
      }
      throw new Error(`dashboard dedup live timeout: requests=${requests.length}; screen=${(await handle.renderScreen()).slice(-1000)}`);
    };
    await wait(async () => (await handle.renderScreen()).split('\n').some(line => line.trim() === '❯'));
    handle.write('first prompt\r');
    await wait(() => requests.length === 1);
    handle.write(`${word}\r`);
    await wait(async () => {
      const screen = await handle.renderScreen();
      return screen.split('\n').some(line => line.includes(word) && line.includes('다음 도구 경계에 넣음'));
    });
    await wait(() => requests.length >= 2);
    await Bun.sleep(400);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]!.messages ?? [])).not.toContain(word);
    expect(JSON.stringify(requests[1]!.messages ?? []).split(word)).toHaveLength(2);
    const count = requests.reduce((n, body) => n + JSON.stringify(body.messages ?? []).split(word).length - 1, 0);
    expect(count).toBe(1);
    const db = new Database(join(root, 'logs', 'logs.db'), { readonly: true });
    try {
      const entries = db.query("select category, event, data from logs where category in ('llm.interjection', 'dashboard.turn-typeahead') order by id")
        .all() as Array<{ category: string; event: string; data: string }>;
      const logged = entries.map(({ category, event, data }) => ({ category, event, data: JSON.parse(data) as { id?: string; ids?: string[]; length?: number } }));
      const queued = logged.filter(row => row.category === 'dashboard.turn-typeahead' && row.event === 'queued' && row.data.length === word.length);
      expect(queued).toHaveLength(1);
      const id = queued[0]!.data.id;
      expect(id).toMatch(/^pending-/);
      const drained = logged.filter(row => row.category === 'llm.interjection' && row.event === 'drained' && row.data.ids?.includes(id!)).length;
      const submitted = logged.filter(row => row.category === 'dashboard.turn-typeahead' && row.event === 'submitted-as-prompt' && row.data.id === id).length;
      expect(drained).toBe(1);
      expect(submitted).toBe(0);
      console.log(`DEDUP live-dashboard: id=${id} drained-mid-turn=${drained} submitted-as-prompt=${submitted} model-request-occurrences=${count}`);
    } finally { db.close(); }
  } finally {
    handle.kill();
    unregisterPty(handle.id);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

test('dashboard streaming Enter reaches the real LLM mid-turn boundary exactly once', async () => {
  const sid = 'dashboard-real-llm-dedup';
  const word = 'unique-dashboard-real-llm-dedup';
  const ref = { state: createTurnTypeaheadState() };
  for (const char of word) ref.state = applyDashboardStreamingTypeaheadKey(ref.state, { name: char }, undefined).state;
  ref.state = applyDashboardStreamingTypeaheadKey(ref.state, { name: 'enter' }, undefined).state;
  const id = steerLastTurnTypeaheadSubmission(ref, activeDashboardTypeaheadSessionId(sid, false), () => {});
  expect(id).not.toBeNull();
  const requests: string[] = [];
  const provider: LLMProvider = {
    name: 'dashboard-dedup-test', defaultModel: 'dedup-test', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages) {
      requests.push(JSON.stringify(messages));
      if (requests.length === 1) yield { type: 'tool_call', id: 'one', name: 'Read', args: {} };
      else yield { type: 'text', delta: 'done' };
    },
  };
  try {
    await streamLLMWithTools(
      [{ role: 'user', content: 'original prompt' }],
      { onText() {}, dispatchTool: async () => 'read result' },
      { provider, tools: [{ name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } }], drainPendingUserInput: () => drainPendingUserInput(sid) },
    );
    let enters = 0;
    handoffTurnTypeaheadAtTurnEnd(ref, undefined, { interrupted: false }, () => { enters++; });
    expect(enters).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain(word);
    expect(requests[1]!.split(word)).toHaveLength(2);
    expect(drainPendingUserInput(sid)).toEqual([]);
    console.log(`DEDUP real-llm: id=${id} model-request-occurrences=1 turn-end-enters=${enters}`);
  } finally {
    clearPendingUserInput(sid);
  }
});

describe('dashboard streaming Enter → ACP registry → turn-end handoff', () => {
  for (const { label, remote, drainBeforeEnd } of [
    { label: 'local loop drains before turn end', remote: false, drainBeforeEnd: true },
    { label: 'local loop ends before drain', remote: false, drainBeforeEnd: false },
    { label: 'remote loop submits at turn end', remote: true, drainBeforeEnd: false },
  ]) {
    test(label, () => {
      const sid = `dashboard-dedup-${label}`;
      const word = `unique-${label.replaceAll(' ', '-')}`;
      const ref = { state: createTurnTypeaheadState() };
      for (const char of word) ref.state = applyDashboardStreamingTypeaheadKey(ref.state, { name: char }, undefined).state;
      const entered = applyDashboardStreamingTypeaheadKey(ref.state, { name: 'enter' }, undefined);
      expect(entered.submissionDisposition).toBe('fifo');
      ref.state = entered.state;
      const log = spyOn(debug, 'log');
      try {
        const id = steerLastTurnTypeaheadSubmission(ref, activeDashboardTypeaheadSessionId(sid, remote), () => {});
        expect(id === null).toBe(remote);
        expect(pendingUserInputCount(sid)).toBe(remote ? 0 : 1);
        const injected: string[] = [];
        if (drainBeforeEnd) injected.push(...drainPendingUserInput(sid));
        let enters = 0;
        const handoff = handoffTurnTypeaheadAtTurnEnd(ref, undefined, { interrupted: false }, () => { enters++; });
        if (handoff.injectEnter) injected.push(handoff.nextInitial!);
        injected.push(...drainPendingUserInput(sid));
        expect(injected).toEqual([word]);
        expect(enters).toBe(drainBeforeEnd ? 0 : 1);
        if (id) {
          const drained = log.mock.calls.filter(([category, event, data]) =>
            category === 'llm.interjection' && event === 'drained' && (data as { ids: string[] }).ids.includes(id)).length;
          const submitted = log.mock.calls.filter(([category, event, data]) =>
            category === 'dashboard.turn-typeahead' && event === 'submitted-as-prompt' && (data as { id: string }).id === id).length;
          expect(drained + submitted).toBe(1);
          console.log(`DEDUP ${label}: id=${id} drained-mid-turn=${drained} submitted-as-prompt=${submitted} actual-injections=${injected.length}`);
        } else {
          console.log(`DEDUP ${label}: remote FIFO actual-injections=${injected.length}`);
        }
      } finally {
        log.mockRestore();
        clearPendingUserInput(sid);
      }
    });
  }
});

describe('dashboard /loop wiring (index.ts production path)', () => {
  test('the loop scheduler ref lives once in showDashboard scope and is passed by name into every per-command slashCtx', () => {
    // ref 영속성: dashboardLoopSchedulerRef 는 showDashboard 본문에 한 번 선언되고,
    // 명령마다 재구성되는 slashCtx 블록은 그 이름을 건넬 뿐 ref 를 새로 만들지 않는다.
    // 그래야 /loop start 로 만든 스케줄러가 /loop stop · 세션 종료에서 같은 ref 를 통해 멈춘다.
    const nameHits = dashboard.split('dashboardLoopSchedulerRef').length - 1;
    expect(nameHits).toBe(2);

    const showStart = dashboard.indexOf('export async function showDashboard(');
    const refDecl = dashboard.indexOf('const dashboardLoopSchedulerRef');
    const slashCtxStart = dashboard.indexOf('const slashCtx: DashboardSlashContext = {');
    const dispatchCall = dashboard.indexOf('dashboardSlashRegistry.dispatch(cmdLower, args, slashCtx)');
    expect(showStart).toBeGreaterThan(-1);
    expect(refDecl).toBeGreaterThan(showStart);
    expect(slashCtxStart).toBeGreaterThan(refDecl);
    expect(dispatchCall).toBeGreaterThan(slashCtxStart);

    const ctxBlock = dashboard.slice(slashCtxStart, dispatchCall);
    expect(ctxBlock).toContain('schedulerRef: dashboardLoopSchedulerRef');
    expect(ctxBlock).not.toContain('current: null');

    const registryDecl = dashboard.indexOf('const dashboardSlashRegistry = buildDashboardSlashRegistry();');
    expect(registryDecl).toBeGreaterThan(-1);
    expect(registryDecl).toBeLessThan(showStart);
  });
});

function makeProbeRuntime(onRun: (ctxSignal: AbortSignal | undefined) => void): ToolRuntime<Record<string, unknown>, ToolRunResult> {
  return {
    id: 'dashboard_signal_probe',
    spec: {
      name: 'DashboardSignalProbe',
      description: 'Probe dashboard session-runtime signal forwarding.',
      parameters: { type: 'object', additionalProperties: true },
    },
    async run(_req, ctx) {
      onRun(ctx.signal);
      return { output: 'probe-ok' };
    },
  };
}

test('showDashboard first screen suggests the cwd project without assigning projectId to the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-project-boot-'));
  const folder = join(root, 'folder');
  const configRoot = join(root, 'config');
  const sessionDir = join(root, 'sessions');
  const previousConfig = getElanousConfigDirOverride();
  const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  const previousCwd = process.cwd();
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(folder);
    setElanousConfigDir(configRoot);
    process.env.ELANOUS_SESSION_ROOT = sessionDir;
    process.chdir(folder);
    const project = createProject({ name: 'Boot match', primaryFolder: folder });
    const session = createSession();
    expect(session.projectId).toBeUndefined();
    const expected = `Project suggestion: ${project.name} (${project.id})`;
    const child = spawn(process.execPath, [resolve(import.meta.dir, 'dashboard-boot-fixture.ts')], {
      cwd: folder,
      env: { ...process.env, ELANOUS_STATE_DIR: configRoot, ELANOUS_SESSION_ROOT: sessionDir, DASHBOARD_BOOT_SUGGESTION: expected },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.on('error', reject);
      child.on('close', resolveExit);
    });
    expect(code).toBe(0);
    expect(output).toContain(`FIRST_SCREEN_SUGGESTION=${expected}`);
    const persisted = listSessions({}, sessionDir);
    expect(persisted.find((entry) => entry.id === session.id)?.projectId).toBeUndefined();
    expect(persisted.every((entry) => entry.projectId === undefined)).toBe(true);
  } finally {
    process.chdir(previousCwd);
    if (previousConfig !== undefined) setElanousConfigDir(previousConfig);
    else resetElanousConfigDir();
    if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

describe('dashboard /ad production assembly', () => {
  test('showDashboard wires the CDP grounding collector into its actual ad runtime construction', () => {
    const assembly = dashboard.slice(
      dashboard.indexOf('const adSlashRuntime = createDashboardAdSlashRuntime({'),
      dashboard.indexOf('const companionFeedbackRuntime = createDashboardCompanionFeedbackRuntime({'),
    );
    expect(assembly).toContain('collectGroundingFacts: collectGroundingFactsViaCdp');
    expect(assembly).toContain('adRunSetupBindings');
    expect(assembly).toContain('adRunSetupError');
    expect(assembly).toContain('approve:');
    expect(assembly).toContain('report: pushChatLine');
    expect(assembly).toContain('muted: C.muted');
    expect(assembly).toContain('warning: C.warning');
  });
});

describe('dashboard ad command runner', () => {
  test('preserves rawvideo bytes while retaining decoded stdout, stderr, and exit code', async () => {
    const result = await dashboardAdCommandRunner.run([
      process.execPath,
      '-e',
      "process.stdout.write(Buffer.from([200, 30, 40])); process.stderr.write('runner stderr'); process.exitCode = 7;",
    ]);

    expect(result.raw).toEqual(new Uint8Array([200, 30, 40]));
    expect(result.raw).toHaveLength(3);
    expect(result.stdout).toBe('\uFFFD\u001e(');
    expect(result.stderr).toBe('runner stderr');
    expect(result.exitCode).toBe(7);
  });
});

test('ESC selects only one identified active SelfImplement call, never a stale or ambiguous space', () => {
  const calls = createEscAbortToolState();
  const spaces = new Map([['call-1', 'space-1'], ['call-2', 'space-2']]);
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
  trackEscAbortToolCall(calls, { id: 'call-1', name: 'SelfImplement' });
  expect(activeEscHarnessSpace(calls, spaces)).toBe('space-1');
  trackEscAbortToolCall(calls, { id: 'call-2', name: 'SelfImplement' });
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
  settleEscAbortToolCall(calls, { id: 'call-1' });
  expect(activeEscHarnessSpace(calls, spaces)).toBe('space-2');
  spaces.delete('call-2');
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
});

describe('dashboard tool dispatch signal observation', () => {
  test('records signal provenance on a separate category before the existing runtime dispatch call', () => {
    const helper = dashboard.slice(
      dashboard.indexOf('export function observeDashboardToolDispatchSignal'),
      dashboard.indexOf('export function resumeInProcessDashboardSession'),
    );
    expect(helper).toContain("debug.log('dashboard.tool-dispatch-signal', 'selected', observation)");
    expect(helper).toContain('catch');
    expect(helper).toContain('Observability must not prevent dashboard tool dispatch.');

    const dispatchPrelude = dashboard.slice(
      dashboard.indexOf('const hasParentTurnAbortSignal = acpTurnRef.abortCtrl?.signal !== undefined;'),
      dashboard.indexOf('const result = await dispatchDashboardSessionRuntimeTool(name, args, {'),
    );
    expect(dispatchPrelude).toContain('observeDashboardToolDispatchSignal({');
    expect(dispatchPrelude).toContain('toolName: name');
    expect(dispatchPrelude).toContain('turnIndex: ctx?.turnIndex ?? null');
    expect(dispatchPrelude).toContain("signalSource: hasParentTurnAbortSignal ? 'parent-turn' : 'fallback'");
    expect(dispatchPrelude).toContain('hasParentTurnAbortSignal');
    expect(dashboard).toContain('toolCallId: ctx?.callId,');
    expect(dispatchPrelude).toContain('signalAlreadyAborted: (acpTurnRef.abortCtrl?.signal ?? new AbortController().signal).aborted');
  });

  test('preserves the signal value passed to dispatchDashboardSessionRuntimeTool', () => {
    const callSite = dashboard.slice(
      dashboard.indexOf('await dispatchDashboardSessionRuntimeTool(name, args, {'),
    ).slice(0, 900);
    expect(callSite).toContain('signal: acpTurnRef.abortCtrl?.signal ?? new AbortController().signal');
  });

  test('forwards the current turn signal into the nested tool runtime context', () => {
    const dispatchClosure = dashboard.slice(
      dashboard.indexOf('dispatchToolRuntime: (toolName, input, toolCallId) =>'),
    ).slice(0, 1100);
    expect(dispatchClosure).toContain('runtime.dispatchToolByName(toolName, input, {');
    expect(dispatchClosure).toContain("surface: 'tui'");
    expect(dispatchClosure).toContain('toolCallId,');
    expect(dispatchClosure).toContain('signal: acpTurnRef.abortCtrl?.signal');
    expect(dispatchClosure).toContain('agentHostTools: acpTurnToolSpecs');
    expect(dispatchClosure).toContain('agentDispatchTool: (childName, childArgs) =>');
  });

  test('keeps the nested tool runtime signal optional through the production dispatch path', async () => {
    let observedSignal: AbortSignal | undefined = new AbortController().signal;
    const runtime = makeProbeRuntime((ctxSignal) => {
      observedSignal = ctxSignal;
    });

    const result = await dispatchDashboardSessionRuntimeTool('DashboardSignalProbe', {}, {
      turnRefUserText: null,
      muted: (line) => line,
      pushChatLine: () => {},
      draw: () => {},
      getToolRuntime: (toolName) => toolName === 'DashboardSignalProbe' ? runtime : undefined,
      dispatchToolRuntime: async (toolName, input) => {
        const selectedRuntime = toolName === 'DashboardSignalProbe' ? runtime : undefined;
        if (!selectedRuntime) throw new Error(`unexpected tool ${toolName}`);
        return selectedRuntime.run(input, { surface: 'tui' });
      },
      dispatchPluginTool: async () => ({ ok: false, error: 'plugin fallback must not run' }),
      ptyDashboardOn: true,
    });

    expect(result).toEqual({ output: 'probe-ok' });
    expect(observedSignal).toBeUndefined();
  });

  test('session runtime forwards the originating tool call id through its actual dispatcher', async () => {
    const runtime = makeProbeRuntime(() => {});
    const forwarded: Array<string | undefined> = [];
    const result = await dispatchDashboardSessionRuntimeTool('DashboardSignalProbe', {}, {
      turnRefUserText: null,
      toolCallId: 'call-foreground',
      muted: (line) => line,
      pushChatLine: () => {},
      draw: () => {},
      getToolRuntime: (name) => name === 'DashboardSignalProbe' ? runtime : undefined,
      dispatchToolRuntime: async (name, input, toolCallId) => {
        forwarded.push(toolCallId);
        return runtime.run(input, { surface: 'tui', toolCallId });
      },
      dispatchPluginTool: async () => ({ ok: false, error: 'plugin fallback must not run' }),
      ptyDashboardOn: true,
    });
    expect(result).toEqual({ output: 'probe-ok' });
    expect(forwarded).toEqual(['call-foreground']);
  });

  test('keeps esc.abort observations separate from the new dispatch signal category', () => {
    expect(dashboard).toContain("debug.log('dashboard.tool-dispatch-signal', 'selected', observation)");
    expect(dashboard).toContain('createEscAbortGate({');
    expect(dashboard).not.toContain("debug.log('esc.abort', 'selected'");
  });

  test('fixed harness turn blocks ToolSearch Edit and Write hydration through session dispatch', async () => {
    const tools = ['Edit', 'Write', 'Read'].map((name) => ({
      name, description: `${name} tool`, parameters: { type: 'object' },
    }));
    const result = {
      output: `<functions>\n${tools.map((tool) => `<function>${JSON.stringify(tool)}</function>`).join('\n')}\n</functions>`,
      matched: tools.map((tool) => tool.name),
      unknown: [],
      [HYDRATED_TOOLS_KEY]: tools,
    };
    let runtimeCalls = 0;
    const dispatch = (userText: string, useTurnRef = false) => dispatchDashboardSessionRuntimeTool('ToolSearch', { query: 'select:Edit,Write,Read' }, {
      ...(useTurnRef ? {} : { contextUserText: userText }),
      turnRefUserText: useTurnRef ? userText : null,
      muted: (line) => line,
      pushChatLine: () => {},
      draw: () => {},
      getToolRuntime: (name) => name === 'ToolSearch' ? toolSearchRuntime as unknown as ToolRuntime : undefined,
      dispatchToolRuntime: async () => { runtimeCalls += 1; return result; },
      dispatchPluginTool: async () => ({ ok: false, error: 'plugin fallback must not run' }),
      ptyDashboardOn: true,
    });
    const fixed = await dispatch('하니스로 구현해줘 src/example.ts 오류', true);
    expect(runtimeCalls).toBe(1);
    expect(fixed).toMatchObject({ matched: ['Read'] });
    expect((fixed as typeof result)[HYDRATED_TOOLS_KEY].map((tool) => tool.name)).toEqual(['Read']);
    expect((fixed as typeof result).output).not.toContain('"name":"Edit"');
    expect((fixed as typeof result).output).not.toContain('"name":"Write"');
    const ordinary = await dispatch('src/example.ts를 읽어줘');
    expect(ordinary).toEqual(result);
  });

  test('emits queryable debug events that distinguish parent-turn from fallback signal sources', () => {
    const before = debug.events(10_000).filter((event) => event.category === 'dashboard.tool-dispatch-signal').length;
    observeDashboardToolDispatchSignal({
      toolName: 'Bash',
      turnIndex: 7,
      signalSource: 'parent-turn',
      hasParentTurnAbortSignal: true,
      signalAlreadyAborted: false,
    });
    observeDashboardToolDispatchSignal({
      toolName: 'Read',
      turnIndex: 8,
      signalSource: 'fallback',
      hasParentTurnAbortSignal: false,
      signalAlreadyAborted: false,
    });
    debug.flush();
    const events = debug.events(10_000)
      .filter((event) => event.category === 'dashboard.tool-dispatch-signal')
      .slice(before);
    expect(events.map((event) => event.event)).toEqual(['selected', 'selected']);
    expect(events[0]?.data).toMatchObject({ toolName: 'Bash', turnIndex: 7, signalSource: 'parent-turn' });
    expect(events[1]?.data).toMatchObject({ toolName: 'Read', turnIndex: 8, signalSource: 'fallback' });

    const store = new LogStore();
    store.insertBatch(events.map((event) => ({
      surface: 'tui',
      rec: {
        ts: event.ts,
        category: event.category,
        event: event.event,
        data: event.data,
      },
    })));
    store.close();
  });
});

describe('log fold default is not changed by kind-unit', () => {
  test('showDashboard still seeds foldMode as task-unit', () => {
    expect(dashboard).toMatch(/let logFoldMode:\s*FoldMode\s*=\s*getUserConfig\(\)\.dashboard\.foldMode/);
    expect(dashboard).toMatch(/let logFoldMode:\s*FoldMode\s*=[\s\S]*?'task-unit'/);
    expect(dashboard).not.toMatch(/let logFoldMode:\s*FoldMode\s*=\s*'line'/);
    expect(dashboard).not.toMatch(/let logFoldMode:\s*FoldMode\s*=\s*'kind-unit'/);
  });
});

describe('buildLogClickDeps wires foldStack at invocation time', () => {
  test('createDashboardLogClickDeps bag includes foldStack', () => {
    const start = dashboard.indexOf('const buildLogClickDeps = (): LogClickDispatchDeps => createDashboardLogClickDeps({');
    expect(start).toBeGreaterThan(-1);
    const end = dashboard.indexOf('// Dispatcher for attachment-popup actions', start);
    const bag = dashboard.slice(start, end);
    expect(bag).toContain('foldStack,');
    expect(bag).toContain('pillRowGetter: () => pillRowGetterForClick?.() ?? null');
    expect(bag).toContain('onPillClick: () => onPillClickForClick?.()');
  });
});

describe('dispatchLogZoneClick log.mouse reach records', () => {
  const start = dashboard.indexOf('export function dispatchLogZoneClick(');
  const end = dashboard.indexOf('const runLogZoneClickDispatch = dispatchLogZoneClick;', start);
  const body = start >= 0 && end > start ? dashboard.slice(start, end) : '';
  const nestedStart = dashboard.indexOf('const dispatchLogZoneClick = (');
  const nestedEnd = dashboard.indexOf('// ── mx-mouse handler', nestedStart);
  const nestedBody = nestedStart >= 0 && nestedEnd > nestedStart
    ? dashboard.slice(nestedStart, nestedEnd)
    : '';

  test('keeps the existing nested dispatcher and its three live callers', () => {
    expect(nestedStart).toBeGreaterThan(-1);
    expect(nestedEnd).toBeGreaterThan(nestedStart);
    expect(nestedBody).toContain('runLogZoneClickDispatch(m, { logZoneStart, logZoneHeight, widgetHost })');
    expect(dashboard).toContain('const logOutcome = dispatchLogZoneClick(m);');
    expect(dashboard).toContain('dispatchLogZoneClick(m),\n            {\n              allowFocusSteal,');
    expect(dashboard).toContain('dispatchLogZoneClick(m),\n            {\n              allowFocusSteal: false,');
  });

  test('uses one log.mouse category and distinct events for every silent branch', () => {
    expect(body).toContain("debug.log('log.mouse', 'zone-unresolved'");
    expect(body).toContain("debug.log('log.mouse', 'out-of-zone'");
    expect(body).toContain("debug.log('log.mouse', 'missing-widget-definition'");
    expect(body).toContain("debug.log('log.mouse', 'missing-widget-instance'");
    expect(body).toContain("debug.log('log.mouse', 'context-build-failed'");
    expect(body).toContain("debug.log('log.mouse', 'handler-invoked'");
    expect(body).toContain("debug.log('log.mouse', 'handler-threw'");
    const events = [...body.matchAll(/debug\.log\('log\.mouse', '([^']+)'/g)].map((m) => m[1]);
    expect(events).not.toContain('missing-widget');
  });

  test('attaches the required diagnostic payload on each branch', () => {
    const unresolved = body.slice(
      body.indexOf("debug.log('log.mouse', 'zone-unresolved'"),
      body.indexOf("return 'out-of-zone';"),
    );
    expect(unresolved).toContain('logZoneStart');
    expect(unresolved).toContain('logZoneHeight');

    const outOfZone = body.slice(
      body.indexOf("debug.log('log.mouse', 'out-of-zone'"),
      body.indexOf('const localRow'),
    );
    expect(outOfZone).toContain('row: m.row');
    expect(outOfZone).toContain('logZoneStart');
    expect(outOfZone).toContain('logZoneHeight');
    expect(outOfZone).toContain('rangeEnd: logZoneStart + logZoneHeight');

    const contextFailed = body.slice(
      body.indexOf("debug.log('log.mouse', 'context-build-failed'"),
      body.indexOf("return 'passthrough';", body.indexOf("debug.log('log.mouse', 'context-build-failed'")),
    );
    expect(contextFailed).toContain('error:');
    expect(contextFailed).toContain('localRow');
    expect(contextFailed).toContain('localCol');
    expect(contextFailed).toContain('row: m.row');

    const invoked = body.slice(
      body.indexOf("debug.log('log.mouse', 'handler-invoked'"),
      body.indexOf('def.onMouse('),
    );
    expect(invoked).toContain('localRow');
    expect(invoked).toContain('localCol');
    expect(invoked).toContain('row: m.row');
    expect(body.indexOf("widgetHost.buildContext('wd-log')"))
      .toBeLessThan(body.indexOf("debug.log('log.mouse', 'handler-invoked'"));
    expect(body.indexOf("debug.log('log.mouse', 'handler-invoked'"))
      .toBeLessThan(body.indexOf('def.onMouse('));

    const threw = body.slice(
      body.indexOf("debug.log('log.mouse', 'handler-threw'"),
      body.indexOf("return 'passthrough';", body.indexOf("debug.log('log.mouse', 'handler-threw'")),
    );
    expect(threw).toContain('error:');
    expect(threw).toContain('localRow');
    expect(threw).toContain('localCol');
    expect(threw).toContain('row: m.row');
  });

  test('records definition and instance absence as distinct events, both when both are missing', () => {
    const missingStart = body.indexOf('if (!def?.onMouse || !inst)');
    const missingEnd = body.indexOf("return 'passthrough';", missingStart);
    const missing = body.slice(missingStart, missingEnd);
    expect(missing).toContain('if (!def?.onMouse)');
    expect(missing).toContain("debug.log('log.mouse', 'missing-widget-definition'");
    expect(missing).toContain('if (!inst)');
    expect(missing).toContain("debug.log('log.mouse', 'missing-widget-instance'");
    expect(missing.indexOf("debug.log('log.mouse', 'missing-widget-definition'"))
      .toBeLessThan(missing.indexOf("debug.log('log.mouse', 'missing-widget-instance'"));
    expect(missing).toContain('hasDefinition:');
    expect(missing).toContain('hasOnMouse:');
    expect(missing).toContain('hasInstance:');
    expect(missing).not.toMatch(/missing:\s*!def\?\.onMouse\s*\?\s*'definition'\s*:\s*'instance'/);
  });

  test('does not hide arrival records behind debug.enabled', () => {
    expect(body).not.toMatch(/if\s*\(\s*debug\.enabled\s*\)/);
    const logCalls = [...body.matchAll(/debug\.log\('log\.mouse', '([^']+)'/g)].map((m) => m[1]);
    expect(logCalls).toEqual([
      'zone-unresolved',
      'out-of-zone',
      'missing-widget-definition',
      'missing-widget-instance',
      'context-build-failed',
      'handler-invoked',
      'handler-threw',
    ]);
  });

  test('ungated debug.log still lands in LogStore when debug.enabled is false', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    const missingDefinitionHost: LogZoneClickWidgetHost = {
      defFor: () => null,
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    const invokingHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => ({ type: 'none' }),
      }),
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(debug.isFileEnabled()).toBe(true);
      expect(dispatchLogZoneClick(
        { row: 12, col: 4, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: missingDefinitionHost },
      )).toBe('passthrough');
      expect(dispatchLogZoneClick(
        { row: 12, col: 4, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: invokingHost },
      )).toBe('consumed');
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event).sort()).toEqual([
        'handler-invoked',
        'missing-widget-definition',
      ]);
      const definition = rows.find((row) => row.event === 'missing-widget-definition');
      expect(definition?.data).toContain('hasDefinition');
      expect(definition?.data).toContain('hasOnMouse');
      expect(definition?.data).toContain('hasInstance');
      const invoked = rows.find((row) => row.event === 'handler-invoked');
      expect(JSON.parse(invoked?.data ?? '{}')).toMatchObject({
        localRow: 2,
        localCol: 4,
        row: 12,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('buildContext throw records context-build-failed without handler-invoked or handler-threw', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    let handlerCalls = 0;
    const contextFailHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => {
          handlerCalls++;
          return { type: 'none' };
        },
      }),
      get: () => ({ state: {} }),
      buildContext: () => {
        throw new Error('context-boom');
      },
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(dispatchLogZoneClick(
        { row: 15, col: 7, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: contextFailHost },
      )).toBe('passthrough');
      expect(handlerCalls).toBe(0);
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event)).toEqual(['context-build-failed']);
      expect(JSON.parse(rows[0]?.data ?? '{}')).toMatchObject({
        error: 'context-boom',
        localRow: 5,
        localCol: 7,
        row: 15,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('handler-threw records the error plus the click coordinates that reached the handler', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    const throwingHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => {
          throw new Error('widget-handler-boom');
        },
      }),
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(dispatchLogZoneClick(
        { row: 15, col: 7, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: throwingHost },
      )).toBe('passthrough');
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event).sort()).toEqual([
        'handler-invoked',
        'handler-threw',
      ]);
      const threw = rows.find((row) => row.event === 'handler-threw');
      expect(JSON.parse(threw?.data ?? '{}')).toMatchObject({
        error: 'widget-handler-boom',
        localRow: 5,
        localCol: 7,
        row: 15,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('preserves dispatcher return values and does not touch fold/pill/layout', () => {
    expect(body).toContain("return 'out-of-zone'");
    expect(body).toContain("return 'passthrough'");
    expect(body).toContain("return 'consumed'");
    expect(body).not.toContain('tryFoldToggle');
    expect(body).not.toContain('tryPillHit');
    expect(body).not.toContain('widgetHost.mount');
  });
});

function extractBraceBody(source: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  return '';
}

function extractRouteLogZoneClickBodies(source: string): string[] {
  const needle = 'routeLogZoneClick:';
  const bodies: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    if (open < 0) break;
    const body = extractBraceBody(source, open);
    bodies.push(body);
    from = open + body.length;
  }
  return bodies;
}

function extractDebugLogCall(source: string, fromIndex = 0): string {
  const start = source.indexOf('debug.log(', fromIndex);
  if (start < 0) return '';
  let i = start + 'debug.log('.length;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return source.slice(start, i);
}

function firstLogMouseEvent(source: string): string | undefined {
  return source.match(/debug\.log\('log\.mouse', '([^']+)'/)?.[1];
}

function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function isIifeCallee(node: ts.Expression): boolean {
  const callee = unwrapParens(node);
  return ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
}

function reachRecordCallContainsIife(call: string): boolean {
  const sourceFile = ts.createSourceFile(
    'reach-record.ts',
    call,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isIifeCallee(node.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('routeLogZoneClick log.mouse reach records', () => {
  const bodies = extractRouteLogZoneClickBodies(dashboard);
  const streamingBody = bodies.find((candidate) => candidate.includes("if (m.type === 'scroll-up')")) ?? '';
  const mxMouseBody = bodies.find((candidate) =>
    candidate.includes("if (m.type !== 'click' && m.type !== 'double-click')"),
  ) ?? '';
  const textInputBody = bodies.find((candidate) => candidate.includes('textInput-specific gate')) ?? '';
  const streamingReach = extractDebugLogCall(streamingBody);
  const mxMouseReach = extractDebugLogCall(mxMouseBody);
  const textInputReach = extractDebugLogCall(textInputBody);
  const gateStart = textInputBody.indexOf('attachmentRowMap.size() === 0');
  const gateReach = extractDebugLogCall(textInputBody, gateStart);
  const streamingEvent = firstLogMouseEvent(streamingReach);
  const mxMouseEvent = firstLogMouseEvent(mxMouseReach);
  const textInputEvent = firstLogMouseEvent(textInputReach);
  const gateEvent = firstLogMouseEvent(gateReach);

  test('records four distinct log.mouse names for the three routes and the textInput gate', () => {
    expect(bodies).toHaveLength(3);
    expect(streamingBody.length).toBeGreaterThan(0);
    expect(mxMouseBody.length).toBeGreaterThan(0);
    expect(textInputBody.length).toBeGreaterThan(0);
    const names = [streamingEvent, mxMouseEvent, textInputEvent, gateEvent];
    expect(names.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(4);
  });

  test('places each route reach record before any return in that body', () => {
    for (const [body, reach] of [
      [streamingBody, streamingReach],
      [mxMouseBody, mxMouseReach],
      [textInputBody, textInputReach],
    ] as const) {
      const reachAt = body.indexOf(reach);
      const returnAt = body.search(/\breturn\b/);
      expect(reachAt).toBeGreaterThan(-1);
      expect(returnAt).toBeGreaterThan(-1);
      expect(reachAt).toBeLessThan(returnAt);
    }
  });

  test('records the textInput attachment-gate block before that branch returns', () => {
    const returnAt = textInputBody.indexOf("return 'passthrough';", gateStart);
    const reachAt = textInputBody.indexOf(gateReach, gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    expect(reachAt).toBeGreaterThan(gateStart);
    expect(returnAt).toBeGreaterThan(reachAt);
    expect(gateReach).toContain('logOutcome');
  });

  test('keeps each reach-record call free of an IIFE', () => {
    for (const call of [streamingReach, mxMouseReach, textInputReach, gateReach]) {
      expect(call).toContain("debug.log('log.mouse'");
      expect(reachRecordCallContainsIife(call)).toBe(false);
    }
  });

  test('detects arrow, function-expression, and async-arrow IIFEs inside a reach-record call', () => {
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (() => {})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (function(){})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (async () => {})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', ( function ( ) { } ) ( ))")).toBe(true);
  });
});

describe('textInput no-attachment log-zone click', () => {
  // 이것은 미완이 아니라 이 착지의 결정이다 — 중첩 클로저라 진입점이 없고
  // 진입점을 만드는 리팩터는 이 판의 경계 밖이다.
  //
  // 세 `routeLogZoneClick` 몸통은 `showDashboard` 안의 중첩 클로저다.
  // showDashboard 를 부팅하지 않고는 부를 수 없고, 테스트용 공개 export 나
  // vm 소스 추출 실행은 이 착지가 열지 않는 경계다. 본래 목적은 첨부가
  // 없어도 그 관문이 `dispatchLogZoneClick(m)` 을 부르게 하는 것 하나뿐이라
  // 그 배선을 소스 수준으로 고정한다.
  // ⛔⭐ **이 시험이 소스 수준 단언인 것은 «의도된 결정»이다 — 미완이 아니다** (🅣 128차 · 2026-08-25)
  //   무인 리뷰가 세 라운드에 걸쳐 *"실제 진입점을 호출하는 행동 시험으로 교체하라"* 를 요구했다.
  //   ⛔ 그 요구는 ***이 코드 모양에서 원리적으로 불가능하다*** — 세 `routeLogZoneClick` 몸통은
  //   `showDashboard` «안»의 중첩 클로저라, 대시보드를 통째로 부팅하지 않고는 부를 수 없다.
  //   그 사이 시도된 두 우회는 «더 나빴다»:
  //     ⓐ 테스트용 새 공개 export  → 불필요한 API 표면(리뷰가 별도 must-fix 로 잡았다)
  //     ⓑ 소스를 추출해 vm 실행     → 여전히 Goodhart 이고 클로저 배선을 «못» 검증한다
  //   ⇒ 진입점을 만드는 리팩터는 «이 착지의 경계 밖»이다. 그것이 서면 이 시험을 행동 시험으로 바꾼다.
  //   📏 그리고 이 판의 «진짜» 검증은 시험이 아니라 ***라이브 클릭***이다 — 원장 `OBS-T319` 가 그
  //      방법(격리 TUI ⊕ SGR 클릭 ⊕ log.mouse 대조)을 갖고 있고, 이 착지도 그것으로 확인한다.
  test('no-attachment click gate calls dispatchLogZoneClick and passthroughs unless consumed', () => {
    const textInputBody = extractRouteLogZoneClickBodies(dashboard)
      .find((candidate) => candidate.includes('textInput-specific gate')) ?? '';
    const gateStart = textInputBody.indexOf('attachmentRowMap.size() === 0');
    const gateBody = extractBraceBody(
      textInputBody,
      textInputBody.indexOf('{', gateStart),
    );
    expect(gateBody).toContain('const logOutcome = dispatchLogZoneClick(m)');
    expect(gateBody).toContain("if (logOutcome === 'consumed') return 'consumed'");
    expect(gateBody).toContain("return 'passthrough'");
    expect(gateBody).toContain('logOutcome');
    expect(textInputBody.slice(0, gateStart)).toContain("if (m.type !== 'click') return 'passthrough'");
    expect(textInputBody.slice(textInputBody.indexOf(gateBody) + gateBody.length))
      .toContain('dispatchLogZoneClick(m)');
  });
});

function registerFinderAndHistoryOnCoordinator(opts: {
  history: ReadonlyArray<{ role: string; content: unknown }>;
  openFinderPicker?: () => void;
}) {
  const coordinator = new DisplayCoordinator({
    frameMs: 16,
    schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    now: () => 0,
  });
  const chatLog: string[] = [];
  let finderOpened = 0;
  let drew = 0;
  registerDashboardFinderAndHistoryKeys({
    register: (binding) => { coordinator.registerKeyBinding(binding); },
    openFinderPicker: opts.openFinderPicker ?? (() => { finderOpened++; }),
    getSessionHistory: () => opts.history,
    pushChatLine: (line) => { chatLog.push(line); },
    draw: () => { drew++; },
  });
  return { coordinator, chatLog, finderOpened: () => finderOpened, drew: () => drew };
}

function invokeRoutedHandler(coordinator: DisplayCoordinator, name: string): void {
  const routed = coordinator.routeKey({ name, ctrl: true, shift: false, alt: false });
  expect(routed.type).toBe('handler');
  if (routed.type === 'handler') routed.invoke();
}

describe('C-t dumps unfolded session history into the chat log', () => {
  test('removes the zsh-muscle finder alias so C-p is the only finder opener', () => {
    expect(dashboard).not.toContain('dashboard:open-finder-picker-zsh-muscle');
    expect(dashboard).toContain('registerDashboardFinderAndHistoryKeys({');
    const { coordinator } = registerFinderAndHistoryOnCoordinator({ history: [] });
    const bindings = coordinator.snapshot().keyBindings;
    expect(bindings.filter((b) => b.id === 'dashboard:open-finder-picker-zsh-muscle')).toEqual([]);
    expect(bindings.filter((b) => b.key === 'C-p').map((b) => b.id)).toEqual(['dashboard:open-finder-picker']);
    expect(bindings.filter((b) => b.key === 'C-t').map((b) => b.id)).toEqual(['dashboard:show-full-history']);
  });

  test('C-t handler dumps flattened session history through pushChatLine without finder, overlay, or FoldStack', () => {
    const history = [
      { role: 'user', content: 'hello\nworld' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'system', content: '' },
      { role: 'tool', content: 'skip-me' },
    ];
    const { coordinator, chatLog, finderOpened, drew } = registerFinderAndHistoryOnCoordinator({ history });
    invokeRoutedHandler(coordinator, 't');
    expect(finderOpened()).toBe(0);
    expect(drew()).toBe(1);
    expect(chatLog).toEqual([
      '── full history (2) ──',
      'user:',
      'hello',
      'world',
      'assistant:',
      'ok',
    ]);
    expect(chatLog.join('\n')).not.toContain('skip-me');
    const helper = dashboard.slice(
      dashboard.indexOf('export function registerDashboardFinderAndHistoryKeys'),
      dashboard.indexOf('// ── Last selection persistence ──'),
    );
    const ctBinding = helper.slice(helper.indexOf("id: 'dashboard:show-full-history'"));
    expect(ctBinding).toContain('flattenForkableSessionHistory(deps.getSessionHistory())');
    expect(ctBinding).not.toContain('renderUnfoldedSessionHistoryLines');
    expect(ctBinding).not.toContain('renderModalOverlay');
    expect(ctBinding).not.toContain('FoldStack');
    expect(ctBinding).not.toContain('openFinderPicker');
  });

  test('C-p still opens the finder on the same registered keymap', () => {
    let finderOpened = 0;
    const { coordinator, chatLog } = registerFinderAndHistoryOnCoordinator({
      history: [{ role: 'user', content: 'keep-me' }],
      openFinderPicker: () => { finderOpened++; },
    });
    invokeRoutedHandler(coordinator, 'p');
    expect(finderOpened).toBe(1);
    expect(chatLog).toEqual([]);
  });

  test('flattenForkableSessionHistory is the shared fork flatten, including tool_result blocks', () => {
    expect(flattenForkableSessionHistory([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: [{ type: 'tool_result', content: 'tool-out' }] },
      { role: 'system', content: '   ' },
    ])).toEqual([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'tool-out' },
    ]);
    expect(dashboard).toContain('const forkableSessionHistory = (source: ChatMessage[] = chat.history): ForkableSessionTurn[] =>\n    flattenForkableSessionHistory(source);');
  });
});

function extractDisplayKeyBindingBlocks(source: string): string[] {
  const needle = 'display.registerKeyBinding({';
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    blocks.push(source.slice(start, end));
    from = end;
  }
  return blocks;
}

function bindingField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}:\\s*([^,\\n]+)`));
  return match?.[1]?.trim();
}

describe('provider rotation A-grade Ctrl+n alias', () => {
  const bindingBlocks = extractDisplayKeyBindingBlocks(dashboard);

  test('registers both M-m and C-n onto rotateProviderHotkey with the existing when', () => {
    const rotateBlocks = bindingBlocks.filter((block) =>
      block.includes('handler: rotateProviderHotkey'),
    );
    expect(rotateBlocks.map((block) => bindingField(block, 'id'))).toEqual([
      "'dashboard:provider-rotate-next'",
      "'dashboard:provider-rotate-next-ctrl-n'",
    ]);
    expect(rotateBlocks.map((block) => bindingField(block, 'key'))).toEqual([
      "'M-m'",
      "'C-n'",
    ]);
    expect(rotateBlocks.map((block) => bindingField(block, 'when'))).toEqual([
      '() => agentSearchModal === null',
      '() => agentSearchModal === null',
    ]);
    expect(dashboard).toContain(
      'Ctrl+n conventionally moves the cursor to the next line, but this TUI does not implement that family of input-line editing keys — confirmed 2026-08-24 in an isolated TUI where Ctrl+k did not cut the line.',
    );
  });

  test('keeps other global binding identifiers and when conditions, adding only the C-n alias', () => {
    const conditionBearing = bindingBlocks
      .map((block) => ({
        id: bindingField(block, 'id'),
        key: bindingField(block, 'key'),
        when: bindingField(block, 'when'),
      }))
      .filter((binding) => binding.when !== undefined);

    expect(conditionBearing.filter((binding) =>
      binding.id === "'dashboard:open-ssh-picker'"
      || binding.id === "'dashboard:open-directory-picker'"
      || binding.id === "'dashboard:provider-rotate-next'"
      || binding.id === "'dashboard:plan-mode-toggle'",
    )).toEqual([
      { id: "'dashboard:open-ssh-picker'", key: "'C-k'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:open-directory-picker'", key: "'M-c'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:provider-rotate-next'", key: "'M-m'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:plan-mode-toggle'", key: "'S-tab'", when: '() => agentSearchModal === null' },
    ]);

    expect(conditionBearing.filter((binding) =>
      binding.id === "'dashboard:provider-rotate-next-ctrl-n'",
    )).toEqual([
      { id: "'dashboard:provider-rotate-next-ctrl-n'", key: "'C-n'", when: '() => agentSearchModal === null' },
    ]);

    const staticConditionIds = conditionBearing
      .map((binding) => binding.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith("'dashboard:"));
    expect(staticConditionIds).toEqual([
      "'dashboard:open-ssh-picker'",
      "'dashboard:open-directory-picker'",
      "'dashboard:provider-rotate-next'",
      "'dashboard:provider-rotate-next-ctrl-n'",
      "'dashboard:plan-mode-toggle'",
    ]);
  });
});

describe('dashboard ad run setup factory', () => {
  const contractsJson = readFileSync(new URL('../../docs/ad-presets/higgsfield-measured-contracts.json', import.meta.url), 'utf8');
  const runner: CommandRunner = {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const createFactory = (assetPresetPath?: string) => createDashboardAdRunSetupFactory({
    home: '/tmp/dashboard-ad-factory',
    date: '2026-09-12',
    contractsJson,
    runner,
    assetPresetPath,
  });

  test('its optional-input list stays identical to the one buildAdRunSetup reports', () => {
    // ⛔ 이 목록은 ad-run-setup.ts 의 `optionalProductionInputs` 사본이다(그쪽은 export 가 아니다).
    //    optional 을 «하나도» 안 주면 buildAdRunSetup 이 내는 목록이 곧 그 전체 목록이다 — 그것이 권위다.
    const authoritative = buildAdRunSetup({
      home: '/tmp/dashboard-ad-factory', slug: 'x', date: '2026-09-12', version: 1, aspect: '9x16',
      contractsJson, runner,
    });
    if ('error' in authoritative) throw new Error(authoritative.error);
    expect([...dashboardOptionalProductionInputs]).toEqual([...authoritative.missingProductionInputs]);
  });

  test('wires its runner to both sound axes, supplies measured shoot polling defaults, defaults reference assets to an empty map, and derives missing inputs from final production', () => {
    const factory = createDashboardAdRunSetupFactory({
      home: '/tmp/dashboard-ad-factory',
      date: '2026-09-12',
      contractsJson,
      runner,
    });
    const setup = factory(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect(setup.production.soundtrack).toBe(runner);
    expect(setup.production.voiceover).toEqual({ runner, lines: [] });
    expect(setup.production.referenceAssets).toEqual({});
    expect(setup.production.assemblyMaterials).toEqual({ options: { workDir: setup.workDir, outputName: setup.outputName } });
    const { shootRunOptions } = setup.production;
    if (!shootRunOptions) throw new Error('expected dashboard shoot run options');
    const pollIntervalMs = shootRunOptions.pollIntervalMs ?? 0;
    const maxPollsPerJob = shootRunOptions.maxPollsPerJob ?? 0;
    const submitStaggerMs = shootRunOptions.submitStaggerMs ?? 0;
    expect(pollIntervalMs).toBeGreaterThanOrEqual(3_000);
    expect(pollIntervalMs * maxPollsPerJob).toBeGreaterThanOrEqual(400_000);
    expect(pollIntervalMs * maxPollsPerJob - submitStaggerMs * 6).toBeGreaterThanOrEqual(400_000);
    expect(setup.missingProductionInputs).toEqual([
      'assembly',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'ground',
      'invariants',
    ]);
    const optionalProductionInputs = [
      'assembly',
      'assemblyMaterials',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'voiceover',
      'soundtrack',
      'referenceAssets',
      'shootRunOptions',
      'ground',
      'invariants',
    ] as const;
    for (const key of optionalProductionInputs) {
      expect(setup.missingProductionInputs.includes(key)).toBe(setup.production[key] === undefined);
    }
  });

  test('retains every optional input as missing when the runner is not injected', () => {
    const setup = buildAdRunSetup({
      home: '/tmp/dashboard-ad-factory',
      slug: 'dashboard-ad-no-runner',
      date: '2026-09-12',
      version: 1,
      aspect: '9x16',
      contractsJson,
    });
    if ('error' in setup) throw new Error('expected dashboard setup without a runner');

    expect(setup.production).toBeUndefined();
    expect(setup.missingProductionInputs).toEqual([
      'assembly',
      'assemblyMaterials',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'voiceover',
      'soundtrack',
      'referenceAssets',
      'shootRunOptions',
      'ground',
      'invariants',
    ]);
  });

  test('creates time-sortable directories for separate runs while retaining a run directory for spend', () => {
    const factory = createFactory();
    const firstDryRun = factory(false);
    const firstSpendRun = factory(true);
    const secondDryRun = factory(false);
    if ('error' in firstDryRun || 'error' in firstSpendRun || 'error' in secondDryRun) {
      throw new Error('expected dashboard run setups');
    }

    expect(firstDryRun.workDir).toMatch(/^\/tmp\/dashboard-ad-factory\/Movies\/elanous-ad\/2026-09-12-dashboard-ad-\d{6}-\d+$/);
    expect(firstSpendRun.workDir).toBe(firstDryRun.workDir);
    expect(secondDryRun.workDir).not.toBe(firstDryRun.workDir);
  });

  test('resolves the optional operator preset under the supplied instance state directory', () => {
    expect(dashboardAdAssetPresetPath('/operator-instance')).toBe(join('/operator-instance', 'ad-assets.json'));
  });

  test('keeps the missing-input baseline when the optional operator preset is absent', () => {
    const setup = createFactory(join(tmpdir(), `dashboard-ad-assets-absent-${crypto.randomUUID()}.json`))(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect(setup.production.captionFontPath).toBeUndefined();
    expect(setup.production.musicBedPath).toBeUndefined();
    expect(setup.missingProductionInputs).toContain('captionFontPath');
    expect(setup.missingProductionInputs).toContain('musicBedPath');
  });

  test('passes supplied optional operator asset paths into production setup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({
        captionFontPath: 'operator-caption',
        musicBedPath: 'operator-music',
        referenceAssets: { product: ['operator-reference-a', 'operator-reference-b'] },
      }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.captionFontPath).toBe('operator-caption');
      expect(setup.production.musicBedPath).toBe('operator-music');
      expect(setup.production.referenceAssets).toEqual({ product: ['operator-reference-a', 'operator-reference-b'] });
      expect(setup.missingProductionInputs).not.toContain('captionFontPath');
      expect(setup.missingProductionInputs).not.toContain('musicBedPath');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('forwards operator-supplied QC thresholds through the dashboard factory unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      const qcThresholds = {
        dialogueLufsTolerance: 0.08,
        colorDistance: 14.5,
        frameDiffVariance: 0.25,
        durationRanges: {
          cut: { minimumSeconds: 4, maximumSeconds: 8 },
          master: { minimumSeconds: 14.5, maximumSeconds: 15.5 },
        },
      };
      writeFileSync(path, JSON.stringify({ qcThresholds }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.qcThresholds).toEqual(qcThresholds);
      expect(setup.missingProductionInputs).not.toContain('qcThresholds');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('preserves missing QC thresholds without creating defaults', () => {
    const setup = createFactory(join(tmpdir(), `dashboard-ad-assets-absent-${crypto.randomUUID()}.json`))(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect('qcThresholds' in setup.production).toBeFalse();
    expect(setup.missingProductionInputs).toContain('qcThresholds');
  });

  test('rejects malformed numeric QC threshold operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ qcThresholds: { dialogueLufsTolerance: 'strict' } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.dialogueLufsTolerance must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects incomplete QC duration ranges in operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ qcThresholds: { durationRanges: { cut: { minimumSeconds: 4 } } } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.cut.maximumSeconds must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects reversed QC duration ranges in operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({
        qcThresholds: { durationRanges: { master: { minimumSeconds: 16, maximumSeconds: 15 } } },
      }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.master.minimumSeconds must be less than or equal to maximumSeconds`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('forwards operator shoot polling options exactly over the dashboard defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      const shootRunOptions = {
        pollIntervalMs: 7_000,
        maxPollsPerJob: 13,
        maxPollElapsedMs: 91_000,
        submitStaggerMs: 25_000,
        submitRetries: 2,
      };
      writeFileSync(path, JSON.stringify({ shootRunOptions }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.shootRunOptions).toEqual(shootRunOptions);
      expect(setup.missingProductionInputs).not.toContain('shootRunOptions');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed shootRunOptions operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ shootRunOptions: { pollIntervalMs: 'fast' } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: shootRunOptions.pollIntervalMs must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed referenceAssets operator presets instead of treating them as empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ referenceAssets: { product: ['valid', 42] } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: referenceAssets must be a record of string arrays`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('routes malformed operator preset errors through the dashboard /ad runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, '{');
      const bindings = createDashboardAdRunSetupBindings(createFactory(path));
      const lines: string[] = [];
      const runtime = createDashboardAdSlashRuntime({
        adRunSetupBindings: bindings,
        approve: () => true,
        report: (line) => { lines.push(line); },
        muted: (line) => line,
        warning: (line) => line,
      });

      await runtime.run(['operator campaign']);

      expect(lines.join('\n')).toContain(`dashboard ad asset preset malformed at ${path}`);
      expect(lines.join('\n')).toContain('JSON Parse error');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not treat an unreadable operator preset as absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    try {
      expect(() => createFactory(directory)(false)).toThrow(`dashboard ad asset preset unreadable at ${directory}`);
      expect(() => createFactory(directory)(false)).toThrow(/EISDIR/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ── TUI-BOOT-TIMING-HOLES · 0.2.36 — show-dashboard 동기 셋업 구간 ───────────
// 종전에는 `onFirstFrameRendered` 하나에 묶여 첫 프레임 前 동기 셋업(2.3s)이
// 통째로 가려졌다. 생산 `showDashboard()` 가 셋업 종료 지점에서
// `onSyncSetupComplete` 를 부르는지, 그 신호가 첫 프레임 신호보다 «먼저»
// 도착하는지를 실물 부팅으로 잰다.
describe('TUI-BOOT-TIMING-HOLES — show-dashboard 동기 셋업 계측', () => {
  test('openSyncSetupWindow 는 한 번만 보고하고 보고가 던져도 부팅을 막지 않는다', () => {
    const reported: number[] = [];
    let clock = 100;
    const window = openSyncSetupWindow((ms) => reported.push(ms), () => clock);
    clock = 2_450;
    window.finish();
    window.finish();
    expect(reported).toEqual([2_350]);

    const throwing = openSyncSetupWindow(() => {
      throw new Error('sink closed');
    });
    expect(() => throwing.finish()).not.toThrow();
    expect(() => openSyncSetupWindow(undefined).finish()).not.toThrow();
  });

  test('실물 showDashboard() 부팅이 첫 프레임 前 셋업 구간을 보고한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-sync-setup-'));
    const folder = join(root, 'folder');
    const configRoot = join(root, 'config');
    const sessionDir = join(root, 'sessions');
    const markerFile = join(root, 'boot-markers.jsonl');
    const driver = join(root, 'sync-setup-driver.ts');
    const previousConfig = getElanousConfigDirOverride();
    const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    const previousCwd = process.cwd();
    try {
      mkdirSync(folder);
      mkdirSync(configRoot, { recursive: true });
      setElanousConfigDir(configRoot);
      process.env.ELANOUS_SESSION_ROOT = sessionDir;
      process.chdir(folder);
      writeFileSync(
        driver,
        [
          "import { appendFileSync } from 'node:fs';",
          `const markerFile = ${JSON.stringify(markerFile)};`,
          "const mark = (line: string) => appendFileSync(markerFile, line + '\\n');",
          `const { setElanousConfigDir } = await import(${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))});`,
          `setElanousConfigDir(${JSON.stringify(configRoot)});`,
          "setTimeout(() => { mark('timeout'); process.exit(1); }, 90_000).unref();",
          `const { showDashboard } = await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});`,
          'await showDashboard({',
          '  onSyncSetupComplete: (ms) => { mark(`setup=${ms}`); },',
          "  onFirstFrameRendered: () => { mark('first-frame'); process.exit(0); },",
          '});',
          "mark('dashboard-returned');",
        ].join('\n'),
      );

      const child = spawn(process.execPath, [driver], {
        cwd: folder,
        env: {
          ...process.env,
          HOME: join(root, 'home'),
          ELANOUS_STATE_DIR: configRoot,
          ELANOUS_SESSION_ROOT: sessionDir,
          TERM: process.env.TERM ?? 'xterm-256color',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.on('error', reject);
        child.on('close', resolveExit);
      });

      const markers = readFileSync(markerFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim());
      if (code !== 0) {
        throw new Error(`dashboard boot driver rc=${code} stderr=${stderr.slice(-900)} stdout=${stdout.slice(-900)}`);
      }
      const setupIndex = markers.findIndex((line) => line.startsWith('setup='));
      const frameIndex = markers.indexOf('first-frame');
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(frameIndex).toBeGreaterThan(setupIndex);
      const setupMs = Number(markers[setupIndex]?.slice('setup='.length));
      expect(Number.isFinite(setupMs)).toBe(true);
      expect(setupMs).toBeGreaterThanOrEqual(0);
      expect(markers).not.toContain('dashboard-returned');
    } finally {
      process.chdir(previousCwd);
      if (previousConfig !== undefined) setElanousConfigDir(previousConfig);
      else resetElanousConfigDir();
      if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test('셋업 창은 화면 조립이 아니라 첫 프레임 flush 완료 시점에 닫힌다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-sync-setup-flush-'));
    const folder = join(root, 'folder');
    const configRoot = join(root, 'config');
    const sessionDir = join(root, 'sessions');
    const markerFile = join(root, 'flush-markers.jsonl');
    const driver = join(root, 'sync-setup-flush-driver.ts');
    const previousConfig = getElanousConfigDirOverride();
    const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    const previousCwd = process.cwd();
    try {
      mkdirSync(folder);
      mkdirSync(configRoot, { recursive: true });
      setElanousConfigDir(configRoot);
      process.env.ELANOUS_SESSION_ROOT = sessionDir;
      process.chdir(folder);
      writeFileSync(
        driver,
        [
          "import { appendFileSync } from 'node:fs';",
          `const markerFile = ${JSON.stringify(markerFile)};`,
          "const mark = (line: string) => appendFileSync(markerFile, line + '\\n');",
          'const realWrite = process.stdout.write.bind(process.stdout);',
          'process.stdout.write = ((chunk: any, encodingOrCallback?: any, callback?: any) => {',
          "  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;",
          '  const settled = (error?: Error | null) => {',
          "    try { mark('flush'); } catch { /* marker must not break drawing */ }",
          "    if (typeof done === 'function') done(error);",
          '  };',
          "  return typeof encodingOrCallback === 'string' ? realWrite(chunk, encodingOrCallback, settled) : realWrite(chunk, settled);",
          '}) as typeof process.stdout.write;',
          `const { setElanousConfigDir } = await import(${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))});`,
          `setElanousConfigDir(${JSON.stringify(configRoot)});`,
          "setTimeout(() => { mark('timeout'); process.exit(1); }, 90_000).unref();",
          `const { showDashboard } = await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});`,
          'await showDashboard({',
          '  onSyncSetupComplete: (ms) => { mark(`setup=${ms}`); },',
          "  onFirstFrameRendered: () => { mark('first-frame'); process.exit(0); },",
          '});',
          "mark('dashboard-returned');",
        ].join('\n'),
      );

      const child = spawn(process.execPath, [driver], {
        cwd: folder,
        env: {
          ...process.env,
          HOME: join(root, 'home'),
          ELANOUS_STATE_DIR: configRoot,
          ELANOUS_SESSION_ROOT: sessionDir,
          TERM: process.env.TERM ?? 'xterm-256color',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.on('error', reject);
        child.on('close', resolveExit);
      });

      const markers = readFileSync(markerFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim());
      if (code !== 0) {
        throw new Error(`dashboard flush driver rc=${code} stderr=${stderr.slice(-900)} stdout=${stdout.slice(-900)}`);
      }
      const setupIndex = markers.findIndex((line) => line.startsWith('setup='));
      expect(setupIndex).toBeGreaterThan(0);
      expect(markers).toContain('flush');
      expect(markers[setupIndex - 1]).toBe('flush');
      expect(markers.indexOf('first-frame')).toBeGreaterThan(setupIndex);
    } finally {
      process.chdir(previousCwd);
      if (previousConfig !== undefined) setElanousConfigDir(previousConfig);
      else resetElanousConfigDir();
      if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('TUI-FLICKER-DRAW-INTEGRATION — synchronized frame output seam', () => {
  type FrameSink = { readonly chunks: string[]; write: (chunk: string) => void };

  function createFrameSink(): FrameSink {
    const chunks: string[] = [];
    return {
      get chunks() { return chunks; },
      write: (chunk: string) => { chunks.push(chunk); },
    };
  }

  // Drives the same production wrapper (drawDashboardFrameSynchronized) that
  // showDashboard's drawNow calls for both the force path and the queued path:
  // the body writes the three things the real draw writes between the markers —
  // base frame, coordinator modal overlay, prompt repaint.
  function drawFrameThroughSeam(sink: FrameSink, force: boolean): void {
    drawDashboardFrameSynchronized(() => {
      sink.write(`FRAME-BODY:force=${force}`);
      sink.write('COORDINATOR-MODAL-OVERLAY');
      sink.write('PROMPT-REPAINT');
    }, { write: sink.write, isTTY: true, env: {} });
  }

  test('일반·force draw 모두 프레임·overlay·프롬프트를 한 BSU/ESU 안에 출력한다', () => {
    for (const force of [false, true]) {
      const sink = createFrameSink();
      drawFrameThroughSeam(sink, force);

      expect(sink.chunks[0]).toBe(SYNCHRONIZED_OUTPUT_BEGIN);
      expect(sink.chunks[sink.chunks.length - 1]).toBe(SYNCHRONIZED_OUTPUT_END);
      expect(sink.chunks.filter((chunk) => chunk === SYNCHRONIZED_OUTPUT_BEGIN)).toHaveLength(1);
      expect(sink.chunks.filter((chunk) => chunk === SYNCHRONIZED_OUTPUT_END)).toHaveLength(1);

      const body = sink.chunks.slice(1, -1).join('');
      expect(body).toContain(`FRAME-BODY:force=${force}`);
      expect(body).toContain('COORDINATOR-MODAL-OVERLAY');
      expect(body).toContain('PROMPT-REPAINT');
    }
  });

  test('draw 중 예외에도 ESU 가 닫혀 다음 프레임이 살아 있다', () => {
    const sink = createFrameSink();
    expect(() => {
      runSynchronizedFrameDraw(() => {
        sink.write('FRAME-BODY');
        throw new Error('draw blew up mid-frame');
      }, { write: sink.write, env: {} });
    }).toThrow('draw blew up mid-frame');

    expect(sink.chunks).toEqual([
      SYNCHRONIZED_OUTPUT_BEGIN,
      'FRAME-BODY',
      SYNCHRONIZED_OUTPUT_END,
    ]);

    drawFrameThroughSeam(sink, true);
    expect(sink.chunks.slice(3)).toEqual([
      SYNCHRONIZED_OUTPUT_BEGIN,
      'FRAME-BODY:force=true',
      'COORDINATOR-MODAL-OVERLAY',
      'PROMPT-REPAINT',
      SYNCHRONIZED_OUTPUT_END,
    ]);
  });

  test('생산 drawNow 래퍼는 tty sink 만 BSU/ESU 로 감싸고 파이프 출력은 바이트를 그대로 둔다', () => {
    const ttySink = createFrameSink();
    drawDashboardFrameSynchronized(() => {
      ttySink.write('FRAME-BODY');
      ttySink.write('PROMPT-REPAINT');
    }, { write: ttySink.write, isTTY: true, env: {} });

    expect(ttySink.chunks).toEqual([
      SYNCHRONIZED_OUTPUT_BEGIN,
      'FRAME-BODY',
      'PROMPT-REPAINT',
      SYNCHRONIZED_OUTPUT_END,
    ]);

    const pipeSink = createFrameSink();
    drawDashboardFrameSynchronized(() => {
      pipeSink.write('FRAME-BODY');
      pipeSink.write('PROMPT-REPAINT');
    }, { write: pipeSink.write, isTTY: false, env: {} });

    expect(pipeSink.chunks).toEqual(['FRAME-BODY', 'PROMPT-REPAINT']);
  });

  test('close 는 멱등이라 중복 finally 가 stray ESU 를 내지 않는다', () => {
    const sink = createFrameSink();
    const frame = beginSynchronizedFrameOutput({ write: sink.write, env: {} });
    frame.close();
    frame.close();

    expect(sink.chunks).toEqual([SYNCHRONIZED_OUTPUT_BEGIN, SYNCHRONIZED_OUTPUT_END]);
  });

  test('synchronized output 을 지원하지 않는 sink 는 바이트 그대로 둔다', () => {
    const sink = createFrameSink();
    const frame = beginSynchronizedFrameOutput({
      write: sink.write,
      supported: false,
      env: {},
    });
    sink.write('FRAME-BODY');
    frame.close();

    expect(sink.chunks).toEqual(['FRAME-BODY']);
  });

  test('ELANOUS_SYNC_OUTPUT=off 는 래퍼를 끄고 출력 바이트를 그대로 둔다', () => {
    const sink = createFrameSink();
    const frame = beginSynchronizedFrameOutput({
      write: sink.write,
      env: { ELANOUS_SYNC_OUTPUT: 'off' },
    });
    sink.write('FRAME-BODY');
    frame.close();

    expect(sink.chunks).toEqual(['FRAME-BODY']);
  });

  test('coordinator 가 연 region 안에서는 프레임 seam 이 BSU/ESU 를 겹쳐 내지 않는다', () => {
    const sink = createFrameSink();
    const coordinatorRegion = openSynchronizedOutputRegion();
    sink.write(SYNCHRONIZED_OUTPUT_BEGIN);

    drawDashboardFrameSynchronized(() => {
      sink.write('FRAME-BODY');
      sink.write('PROMPT-REPAINT');
    }, { write: sink.write, isTTY: true, env: {} });

    expect(isSynchronizedOutputRegionOpen()).toBe(true);
    sink.write(SYNCHRONIZED_OUTPUT_END);
    coordinatorRegion.close();
    expect(isSynchronizedOutputRegionOpen()).toBe(false);

    expect(sink.chunks).toEqual([
      SYNCHRONIZED_OUTPUT_BEGIN,
      'FRAME-BODY',
      'PROMPT-REPAINT',
      SYNCHRONIZED_OUTPUT_END,
    ]);
  });
});
