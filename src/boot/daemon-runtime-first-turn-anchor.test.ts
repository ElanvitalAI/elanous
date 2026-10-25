// TUI-CONTINUE-SESSION (0.2.35) — 데몬(ACP TUI) 경로의 첫 턴도 in-process TUI 와 같은 universal
// 프리앰블을 받는다: 그 턴의 cwd 앵커(AGENTS.md) ⊕ 자리 로컬 지시(AGENTS.local.md)가 첫 턴에만 실리고,
// 다시 붙은 세션(detach 후 `--continue`)의 첫 턴에서도 같다.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpTurnContext } from '../acp/server.js';
import * as coreTurn from '../core-turn/index.js';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { createProject } from '../project/project-store.js';
import { createSession } from '../session/index.js';
import { DaemonSessionHistory, createDaemonRunTurn, createDaemonRuntime } from './daemon-runtime.js';

afterEach(() => { spyOn(coreTurn, 'runCoreTurn').mockRestore(); });

const noop = async () => {};

function systemTextOf(ctx: { messages: Array<{ role: string; content: unknown }> }): string {
  return ctx.messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}

interface PreambleLogPayload {
  anchorFiles: string[];
  localAnchorFiles: string[];
  source: string;
  cwd: string;
}

function firstTurnPreambleCalls(logSpy: { mock: { calls: unknown[][] } }): PreambleLogPayload[] {
  return logSpy.mock.calls
    .filter(([category, event]) => category === 'boot.daemon-runtime' && event === 'first-turn-universal-preamble')
    .map((call) => call[2] as PreambleLogPayload);
}

function acpTurnInput(
  sessionId: string,
  cwd: string,
  userText: string,
  promptMeta: Record<string, unknown> = { input_source: { kind: 'daemon-api', route: '/v1/prompt' } },
): AcpTurnContext {
  return {
    sessionId, cwd, codexArgs: [], userText, promptBlocks: [{ type: 'text', text: userText }], promptMeta,
    isAborted: () => false, push: noop, pushWithMeta: noop,
    pushToolCall: noop, pushToolResult: noop, pushSessionUpdate: noop, pushUsage: noop,
    requestApproval: async () => 'allow-once',
  } as AcpTurnContext;
}

test('daemon first turn anchors AGENTS.md + AGENTS.local.md from the server project, and only on the first turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-first-turn-anchor-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const logSpy = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), '# Shared guide\nSHARED-GUIDE-0.2.35\n');
    writeFileSync(join(project, 'AGENTS.local.md'), '# Seat\nSEAT-LOCAL-0.2.35\n');

    const projectEntry = createProject({ name: 'daemon anchor project', primaryFolder: project });
    const session = createSession({ projectId: projectEntry.id });
    const turnSystems: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSystems.push(systemTextOf(ctx));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: project, systemPrompt: 'Base' });
    for (const text of ['첫 턴', '둘째 턴']) {
      await run(acpTurnInput(session.id, project, text));
    }

    expect(turnSystems).toHaveLength(2);
    expect(turnSystems[0]).toContain('SHARED-GUIDE-0.2.35');
    expect(turnSystems[0].match(/SHARED-GUIDE-0\.2\.35/g)).toHaveLength(1);
    expect(turnSystems[0]).toContain('SEAT-LOCAL-0.2.35');
    expect(turnSystems[1]).not.toContain('SEAT-LOCAL-0.2.35');

    const anchorCalls = logSpy.mock.calls.filter(
      ([category, event]) => category === 'boot.daemon-runtime' && event === 'first-turn-universal-preamble',
    );
    expect(anchorCalls).toHaveLength(1);
    const payload = anchorCalls[0]![2] as { anchorFiles: string[]; localAnchorFiles: string[]; source: string; cwd: string };
    expect(payload.cwd).toBe(project);
    expect(payload.source).toBe('project');
    expect(payload.anchorFiles).toContain('AGENTS.md');
    expect(payload.localAnchorFiles).toContain('AGENTS.local.md');
  } finally {
    logSpy.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon TUI without a server-assigned project does not anchor the daemon process cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-unassigned-anchor-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const logSpy = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const cwd = process.cwd();
    const session = createSession();
    const turnSystems: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSystems.push(systemTextOf(ctx));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: cwd, systemPrompt: 'Base' });
    await run(acpTurnInput(session.id, cwd, '프로젝트 미지정 턴'));

    expect(turnSystems).toHaveLength(1);
    expect(turnSystems[0]).not.toContain('AGENTS.md');
    expect(firstTurnPreambleCalls(logSpy)).toHaveLength(0);
  } finally {
    logSpy.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon TUI anchors only the server-assigned project folder, ignoring a client-supplied cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-proj-anchor-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const logSpy = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    // Session assignment is server-owned. A remote prompt may send another cwd,
    // but that path must never become an anchor read root.
    const projectFolder = join(root, 'proj-A');
    const turnFolder = join(root, 'work', 'dir');
    for (const folder of [projectFolder, turnFolder]) {
      mkdirSync(join(folder, '.git'), { recursive: true });
    }
    writeFileSync(join(projectFolder, 'AGENTS.md'), '# Project guide\nPROJ-A-GUIDE-0.2.35\n');
    writeFileSync(join(projectFolder, 'AGENTS.local.md'), '# Seat\nPROJECT-LOCAL-0.2.35\n');
    writeFileSync(join(turnFolder, 'AGENTS.md'), '# Turn guide\nWORK-DIR-GUIDE-0.2.35\n');
    writeFileSync(join(turnFolder, 'AGENTS.local.md'), '# Seat\nWORK-DIR-LOCAL-0.2.35\n');

    const project = createProject({ name: 'Project A', primaryFolder: projectFolder });
    const session = createSession({ projectId: project.id });
    const turnSystems: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSystems.push(systemTextOf(ctx));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: turnFolder, systemPrompt: 'Base' });
    await run(acpTurnInput(session.id, turnFolder, '프로젝트 폴더 밖 턴'));

    expect(turnSystems).toHaveLength(1);
    expect(turnSystems[0]).toContain('PROJ-A-GUIDE-0.2.35');
    expect(turnSystems[0]).toContain('PROJECT-LOCAL-0.2.35');
    expect(turnSystems[0]).not.toContain('WORK-DIR-GUIDE-0.2.35');
    expect(turnSystems[0]).not.toContain('WORK-DIR-LOCAL-0.2.35');

    const preambleCalls = firstTurnPreambleCalls(logSpy);
    expect(preambleCalls).toHaveLength(1);
    expect(preambleCalls[0]!.cwd).toBe(projectFolder);
    expect(preambleCalls[0]!.source).toBe('project');
  } finally {
    logSpy.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-TUI ACP surfaces keep their existing project instructions without a universal preamble', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-daemon-cwd-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const logSpy = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), '# Project guide\nPWA-PROJECT-GUIDE\n');
    writeFileSync(join(project, 'AGENTS.local.md'), '# Seat\nPWA-LOCAL-MUST-NOT-LOAD\n');
    const projectEntry = createProject({ name: 'PWA project', primaryFolder: project });
    const session = createSession({ projectId: projectEntry.id });
    const turnSystems: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSystems.push(systemTextOf(ctx));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: project, systemPrompt: 'Base' });
    await run(acpTurnInput(session.id, process.cwd(), 'PWA turn', { input_source: { kind: 'pwa' } }));

    expect(turnSystems).toHaveLength(1);
    expect(turnSystems[0]).toContain('PWA-PROJECT-GUIDE');
    expect(turnSystems[0]).not.toContain('PWA-LOCAL-MUST-NOT-LOAD');
    expect(firstTurnPreambleCalls(logSpy)).toHaveLength(0);
  } finally {
    logSpy.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon first turn after a re-attached session (--continue) carries the same preamble', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-reattach-anchor-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const oldHistoryDir = process.env.ELANOUS_HISTORY_DIR;
  const logSpy = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    delete process.env.ELANOUS_HISTORY_DIR;
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), '# Project\nREATTACH-SHARED-0.2.35\n');
    writeFileSync(join(project, 'AGENTS.local.md'), '# Seat\nREATTACH-LOCAL-0.2.35\n');

    const projectEntry = createProject({ name: 'Reattach project', primaryFolder: project });
    const session = createSession({ projectId: projectEntry.id });
    const turnSystems: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSystems.push(systemTextOf(ctx));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });

    // Exercise createDaemonRuntime's production read-through + session-store mirror.
    const firstRuntime = createDaemonRuntime({ tools: 'readonly', toolCwd: project, systemPrompt: 'Base' });
    firstRuntime.history.register(session.id, [], { origin: 'cli' });
    await firstRuntime.runTurn(acpTurnInput(session.id, project, '이어가기 전'));
    expect(turnSystems[0]).toContain('REATTACH-LOCAL-0.2.35');
    expect(turnSystems[0].match(/REATTACH-SHARED-0\.2\.35/g)).toHaveLength(1);

    // Reattach like `--continue`: a new production runtime reads persisted messages,
    // but injects the universal preamble once in this process.
    turnSystems.length = 0;
    const reattached = createDaemonRuntime({ tools: 'readonly', toolCwd: project, systemPrompt: 'Base' });
    expect(reattached.history.get(session.id).length).toBeGreaterThan(0);
    await reattached.runTurn(acpTurnInput(session.id, project, '이어가기 후'));

    expect(turnSystems).toHaveLength(1);
    expect(turnSystems[0]).toContain('REATTACH-LOCAL-0.2.35');
    const anchorCalls = logSpy.mock.calls.filter(
      ([category, event]) => category === 'boot.daemon-runtime' && event === 'first-turn-universal-preamble',
    );
    expect(anchorCalls).toHaveLength(2);
  } finally {
    logSpy.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    if (oldHistoryDir === undefined) delete process.env.ELANOUS_HISTORY_DIR; else process.env.ELANOUS_HISTORY_DIR = oldHistoryDir;
    rmSync(root, { recursive: true, force: true });
  }
});
