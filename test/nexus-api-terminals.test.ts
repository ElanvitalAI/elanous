// CV-3 P4.2 — /v1/terminals + /v1/terminals/:id/scrollback unit tests.
//
// Covers:
//   - list endpoint shape (id · cmd · workdir · alive · startedAt ·
//     outputBytes) sorted by startedAt
//   - scrollback default (50 lines) + custom ?lines · cap at MAX_LINES
//   - scrollback 400 / 404 error paths
//   - auth gate (no bearer 설정 → ok by default · 명시 token + missing
//     header → 401)
//   - parseScrollbackPath edge cases
//
// Test seam: setPtyAdapterForTesting injects a synthetic PTY adapter
// so we can drive registered handles deterministically (same pattern
// as tool-runtime.test.ts).

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

// ⭐P2 — isolate the pty-manifest SQLite (frame endpoint reads it) into a
// throwaway state dir BEFORE any manifest access, so frame tests never
// touch ~/.elanous. Must be set at module load (env is read lazily on first
// manifest op). ELANOUS_STATE_DIR 규율 = logsDbPath 동형.
// beforeAll 로 세우기는 못 씀 — 모듈 로드 시점에 이미 읽힌다. 세우기 전 값은
// 기억해 두고 afterAll 에서 복원(없었으면 삭제)한다. 안 하면 같은 프로세스의
// 뒤 시험이 이 임시 디렉터리를 본다.
const prevEnv = process.env.ELANOUS_STATE_DIR;
const terminalsTestStateDir = mkdtempSync(join(tmpdir(), 'elanous-terminals-test-'));
process.env.ELANOUS_STATE_DIR = terminalsTestStateDir;

import {
  handleTerminalScrollback,
  handleTerminalControl,
  handleTerminalRename,
  handleTerminalsPrune,
  handleTerminalTerminate,
  handleTerminalFrame,
  handleTerminalPng,
  handleTerminalLineage,
  handleTerminalRunGoal,
  handleTerminalRunParticipants,
  handleTerminalsList,
  handleTerminalsView,
  parseTerminalLineagePath,
  parseTerminalRunGoalPath,
  parseTerminalRunParticipantsPath,
  parseTerminalControlPath,
  parseTerminalRenamePath,
  parseTerminalsPrunePath,
  parseTerminalTerminatePath,
  parseScrollbackPath,
  parseFramePath,
  parsePngPath,
  deriveFrameDims,
  terminalTreeNames,
  terminalTreeLabel,
  terminalAgeBadge,
  terminalParentIdentity,
  terminalOriginIdentity,
  terminalOrigin,
  parseTerminalSgr,
} from '../src/nexus/api/terminals.js';
import { ptyManifestDbPath, setPtyManifestDbPathForTesting, upsertPtyManifest, updatePtyManifestFrame, type PtyManifestRow } from '../src/pty-shell/pty-manifest.js';
import { runPtyList } from '../src/cli/pty-takeover-cli.js';
import { requestRemotePtyControl, resetPtyControlIpcForTesting } from '../src/pty-shell/pty-control-ipc.js';
import { debug } from '../src/debug/log.js';
import { appendPtyEvent, resetPtyEventLogForTesting } from '../src/pty-shell/pty-event-log.js';
import { saveSelfDevRun, selfDevRunsDir } from '../src/self-dev/run-store.js';
import { appendRunLedgerEntry, runLedgerDir } from '../src/self-implement/run-ledger.js';
import type { RunningRunsResult } from '../src/self-implement/running-runs.js';
import { registerPreviewTerminalForWebTap, listAllPreviewTerminals, __resetPreviewTapRegistry } from '../src/web-terminal/preview-tap-registry.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import type { PreviewTerminal } from '../src/preview/terminal.js';
import type { AcpServerHandle } from '../src/acp/server.js';
import { handleAuthTraceGet, type MetaApiOpts } from '../src/nexus/api/meta-api.js';
import { _resetForTest as resetAuthTraceForTest, snapshot as authTraceSnapshot } from '../src/nexus/api/auth-trace.js';
import {
  resetForTesting as resetPtyForTest,
  setPtyAdapterForTesting,
  startPty,
  startPtyControlPoller,
  type PtyHandle,
} from '../src/pty-shell/registry.js';

interface MockState {
  outputCb: ((d: string) => void) | null;
  exitCb: ((e: { exitCode: number; signal?: number }) => void) | null;
  written: string[];
  terminateOnKill: boolean;
}

function makeMockSpawn() {
  const states: MockState[] = [];
  function adapter() {
    const s: MockState = { outputCb: null, exitCb: null, written: [], terminateOnKill: false };
    states.push(s);
    return {
      pid: 1000 + states.length,
      write(input: string) { s.written.push(input); },
      kill(signal?: string) {
        if (signal === 'SIGTERM' && s.terminateOnKill) s.exitCb?.({ exitCode: 0, signal: 15 });
      },
      onData(cb: (data: string) => void) {
        s.outputCb = cb;
        return { dispose() { s.outputCb = null; } };
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        s.exitCb = cb;
        return { dispose() { s.exitCb = null; } };
      },
    };
  }
  return { adapter, states };
}

function bareReq(url = 'http://localhost/v1/terminals'): Request {
  return new Request(url);
}

function makePreviewTerminal(pid: number): PreviewTerminal {
  return {
    pid,
    cols: 80,
    rows: 24,
    isAlive: true,
    addRawOutputTap: () => () => {},
  } as unknown as PreviewTerminal;
}

const previewTapHandle = { terminalOutput: async () => {} } as unknown as AcpServerHandle;

function bareUrl(query = ''): URL {
  return new URL(`http://localhost/v1/terminals/x/scrollback${query}`);
}

// Default test opts — bypass the auth gate so we exercise the route
// logic directly. Auth is exercised in its own block below.
const opts: MetaApiOpts = { noAuth: true };

// Spawn a synthetic PTY and feed it `output` so the buffer is non-empty.
function spawnWith(output: string, opts2: { cmd?: string; workdir?: string } = {}): PtyHandle {
  const handle = startPty({
    cmd: opts2.cmd ?? '/bin/bash -lc echo hi',
    detach: false,
    ...(opts2.workdir ? { workdir: opts2.workdir } : {}),
  });
  // The adapter passes the onData callback to the registry; the
  // registry registers a wrapper that feeds appendOutput. We can't
  // reach the wrapper directly, so instead we drive output via the
  // public surface — handle.appendOutput.
  handle.appendOutput(output);
  return handle;
}

let mock: ReturnType<typeof makeMockSpawn>;
beforeEach(() => {
  mock = makeMockSpawn();
  setPtyAdapterForTesting(mock.adapter);
});
afterEach(() => {
  __resetPreviewTapRegistry();
  resetPtyForTest();
  setPtyAdapterForTesting(null);
});
afterAll(() => {
  resetPtyControlIpcForTesting();
  setPtyManifestDbPathForTesting(null);
  resetPtyEventLogForTesting();
  if (prevEnv === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = prevEnv;
  rmSync(terminalsTestStateDir, { recursive: true, force: true });
});

describe('parseScrollbackPath', () => {
  test('matches /v1/terminals/:id/scrollback', () => {
    expect(parseScrollbackPath('/v1/terminals/abc/scrollback')).toBe('abc');
    expect(parseScrollbackPath('/v1/terminals/pty_1234abcd/scrollback')).toBe('pty_1234abcd');
  });

  test('decodes URL-escaped ids', () => {
    expect(parseScrollbackPath('/v1/terminals/with%20space/scrollback')).toBe('with space');
  });

  test('rejects non-matching paths', () => {
    expect(parseScrollbackPath('/v1/terminals')).toBeNull();
    expect(parseScrollbackPath('/v1/terminals/abc')).toBeNull();
    expect(parseScrollbackPath('/v1/terminals/abc/')).toBeNull();
    expect(parseScrollbackPath('/v1/terminals/abc/snapshot')).toBeNull();
    expect(parseScrollbackPath('/v2/terminals/abc/scrollback')).toBeNull();
    expect(parseScrollbackPath('/v1/terminals/abc/sub/scrollback')).toBeNull();
  });
});

describe('terminal run participants', () => {
  const runDir = selfDevRunsDir(process.env.ELANOUS_STATE_DIR);

  test('matches only a run participant collection path', () => {
    expect(parseTerminalRunParticipantsPath('/v1/terminals/runs/run-1/participants')).toBe('run-1');
    expect(parseTerminalRunParticipantsPath('/v1/terminals/runs/with%20space/participants')).toBe('with space');
    expect(parseTerminalRunParticipantsPath('/v1/terminals/runs/run-1/lineage')).toBeNull();
    expect(parseTerminalRunParticipantsPath('/v1/terminals/runs/run-1/participants/')).toBeNull();
  });

  test('distinguishes absent records, pre-tracking records, and tracked empty records', async () => {
    saveSelfDevRun({ runId: 'pre-tracking', createdAt: 1, updatedAt: 1, results: [] }, runDir);
    saveSelfDevRun({ runId: 'tracked-empty', createdAt: 1, updatedAt: 1, results: [], participants: [] }, runDir);

    const missing = await handleTerminalRunParticipants(bareReq(), opts, 'missing').json() as { status: string; participants: unknown[]; scope: string };
    const preTracking = await handleTerminalRunParticipants(bareReq(), opts, 'pre-tracking').json() as { status: string; participants: unknown[]; scope: string };
    const trackedEmpty = await handleTerminalRunParticipants(bareReq(), opts, 'tracked-empty').json() as { status: string; participants: unknown[]; scope: string };

    expect(missing.status).toBe('not-found');
    expect(preTracking.status).toBe('pre-tracking');
    expect(trackedEmpty.status).toBe('tracked');
    expect([missing, preTracking, trackedEmpty].map((body) => body.participants)).toEqual([[], [], []]);
    expect(trackedEmpty.scope).toContain('participated within this run');
    expect(trackedEmpty.scope).toContain('process ancestry or descendency');
    expect(trackedEmpty.scope).toContain('terminal lineage');
  });

  test('returns every participant while exposing transport count without transport contents', async () => {
    saveSelfDevRun({
      runId: 'with-participants',
      createdAt: 1,
      updatedAt: 1,
      results: [],
      participants: [
        { id: 'agent:no-body', kind: 'agent', transports: [], registeredAt: 2, runIdSource: 'explicit' },
        { id: 'pty:two-bodies', kind: 'pty', transports: [{ kind: 'pty', id: 'pty-a' }, { kind: 'pty', id: 'pty-b' }], registeredAt: 3, runIdSource: 'inherited' },
      ],
    }, runDir);

    const body = await handleTerminalRunParticipants(bareReq(), opts, 'with-participants').json() as {
      status: string;
      participants: Array<{ id: string; kind: string; transportCount: number; registeredAt: number; runIdSource: string; transports?: unknown }>;
    };
    expect(body.status).toBe('tracked');
    expect(body.participants).toEqual([
      { id: 'agent:no-body', kind: 'agent', transportCount: 0, registeredAt: 2, runIdSource: 'explicit' },
      { id: 'pty:two-bodies', kind: 'pty', transportCount: 2, registeredAt: 3, runIdSource: 'inherited' },
    ]);
    expect(body.participants.every((participant) => !('transports' in participant))).toBe(true);
  });
});

describe('terminal run original goal', () => {
  test('reads the start feature lazily by run ID and distinguishes missing goal states', async () => {
    const ledgerDir = runLedgerDir(process.env.ELANOUS_STATE_DIR);
    appendRunLedgerEntry({ timestamp: '2026-08-05T00:00:00.000Z', runId: 'run-goal', event: 'start', goalId: 'goal-123', data: { feature: 'src/nexus/api/terminals.ts의 한국어 원래 골 <tag>' } }, ledgerDir);
    appendRunLedgerEntry({ timestamp: '2026-08-05T00:00:00.000Z', runId: 'run-no-feature', event: 'start', data: {} }, ledgerDir);
    appendRunLedgerEntry({ timestamp: '2026-08-05T00:00:00.000Z', runId: 'run-no-start', event: 'progress', data: { feature: 'not the original goal' } }, ledgerDir);

    expect(parseTerminalRunGoalPath('/v1/terminals/runs/run-goal/goal')).toBe('run-goal');
    expect(parseTerminalRunGoalPath('/v1/terminals/runs/with%20space/goal')).toBe('with space');
    expect(parseTerminalRunGoalPath('/v1/terminals/runs/run-goal/goal/')).toBeNull();
    expect(parseTerminalRunGoalPath('/v1/terminals/runs/run-goal/participants')).toBeNull();

    const found = await handleTerminalRunGoal(bareReq(), opts, 'run-goal').json() as { status: string; runId: string; ledgerDirectory: string; goalId: string; goal: string };
    const missingLedger = await handleTerminalRunGoal(bareReq(), opts, 'run-ledger-missing').json() as { runId: string; status: string; ledgerDirectory: string };
    const missingStart = await handleTerminalRunGoal(bareReq(), opts, 'run-no-start').json() as { runId: string; status: string; ledgerDirectory: string };
    const missingGoal = await handleTerminalRunGoal(bareReq(), opts, 'run-no-feature').json() as { runId: string; status: string; ledgerDirectory: string; goalId: null };

    expect(found).toEqual({ status: 'found', runId: 'run-goal', ledgerDirectory: ledgerDir, goalId: 'goal-123', goal: 'src/nexus/api/terminals.ts의 한국어 원래 골 <tag>' });
    expect(missingLedger).toEqual({ runId: 'run-ledger-missing', ledgerDirectory: ledgerDir, status: 'ledger-not-found' });
    expect(missingStart).toEqual({ runId: 'run-no-start', ledgerDirectory: ledgerDir, status: 'start-not-found' });
    expect(missingGoal).toEqual({ runId: 'run-no-feature', ledgerDirectory: ledgerDir, status: 'goal-not-found', goalId: null });

    const view = await handleTerminalsView().text();
    expect(view).toContain('id="originalGoal"');
    expect(view).toContain("'이 셀에는 런 식별자가 없습니다.'");
    expect(view).toContain("'이 런의 원장 파일이 없습니다.'");
    expect(view).toContain("'이 런 원장에는 시작 항목이 없습니다.'");
    expect(view).toContain("'이 런의 시작 항목에 골 문면이 없습니다.'");
  });

  test('renders populated and absent run identifiers and a literal missing-ledger directory in the DOM', async () => {
    const view = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const ledgerDirectory = '/tmp/run&ledger<literal>';
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      if (url === '/v1/terminals') return { ok: true, json: async () => ({ terminals: [
        { id: 'with-run', cmd: 'command', workdir: '/Users/example/source/elan/monad-agent.worktrees/a-very-long-worktree-name', instance: 'test', parentPtyId: 'parent', parentPid: 1, parentKind: 'pty', runId: 'run<&populated', alive: true, outputBytes: 9, startedAt: 1 },
        { id: 'without-run', cmd: 'empty', workdir: '/Users/example/source/elan/monad-agent.worktrees/a-very-long-worktree-name', instance: 'test', parentPtyId: '', parentPid: 0, parentKind: '', runId: '', alive: true, outputBytes: 3, startedAt: 1 },
      ] }) };
      if (url.includes('/runs/run%3C%26populated/goal')) return { ok: true, json: async () => ({ status: 'ledger-not-found', ledgerDirectory }) };
      return { ok: true, json: async () => ({ scrollback: '' }) };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(view))(document, fetch, () => {});
    await settleView();

    const buttons = elements.get('list')!.children.map((item) => item.children[0]!);
    const cardRow = (button: ViewElement) => /^<div class="row1">([\s\S]*)<\/div><div class="sub">/.exec(button.innerHTML)?.[1];
    const cardMetadata = (button: ViewElement) => /<div class="sub">([\s\S]*)<\/div>$/.exec(button.innerHTML)?.[1];
    const withRunRow = cardRow(buttons[0]!);
    const withoutRunRow = cardRow(buttons[1]!);
    const withRunMetadata = cardMetadata(buttons[0]!);
    const withoutRunMetadata = cardMetadata(buttons[1]!);
    expect(withRunRow).toMatch(/^<span class="dot " aria-hidden="true"><\/span><span class="id">with-run<\/span><span class="badge">런 run&lt;&amp;pop<\/span><span class="badge">elan\/a-very-long-worktree-name<\/span><span class="badge">.+<\/span>$/);
    expect(withoutRunRow).toMatch(/^<span class="dot " aria-hidden="true"><\/span><span class="id">without-run<\/span><span class="badge">elan\/a-very-long-worktree-name<\/span><span class="badge">.+<\/span>$/);
    expect(withRunMetadata).toBe('command · test · 부모 P:parent · 출신: 루트 미상 · 에이전트 미상 · 깊이 미상 · 체인 미상 · 9B · 런 run&lt;&amp;populated');
    expect(withoutRunMetadata).toBe('empty · test · 부모 ?:- · 출신: 루트 미상 · 에이전트 미상 · 깊이 미상 · 체인 미상 · 3B · 런 식별자가 없습니다');
    expect(withoutRunMetadata).not.toContain('런 런');
    expect(withoutRunMetadata!.match(/런 식별자가 없습니다/g)).toHaveLength(1);
    buttons[0]!.onclick!();
    await settleView();
    elements.get('originalGoal')!.onclick!();
    await settleView();
    expect(elements.get('scrollback')!.textContent).toBe('이 런의 원장 파일이 없습니다.\n조회 원장 디렉토리: '+ledgerDirectory);
  });

  test('reports the actual ledger directory for a missing ledger', async () => {
    const ledgerDir = runLedgerDir(process.env.ELANOUS_STATE_DIR);
    const missingLedger = await handleTerminalRunGoal(bareReq(), opts, 'run-ledger-not-found').json() as { runId: string; status: string; ledgerDirectory: string };

    expect(missingLedger).toEqual({ runId: 'run-ledger-not-found', status: 'ledger-not-found', ledgerDirectory: ledgerDir });
  });

});

describe('terminal observatory metadata', () => {
  test('wraps complete card-bottom metadata inside the list width without ellipsis', async () => {
    const view = await handleTerminalsView().text();
    const subStyle = /\.sub\{([^}]*)\}/.exec(view)?.[1];

    expect(subStyle).toContain('white-space:normal');
    expect(subStyle).toContain('overflow-wrap:anywhere');
    expect(subStyle).not.toContain('white-space:nowrap');
    expect(subStyle).not.toContain('overflow:hidden');
    expect(subStyle).not.toContain('text-overflow:ellipsis');
  });

  test('derives legacy and harness tree/worktree cases plus separator-free display labels', () => {
    const cases = [
      ['/Users/example/source/elan/monad-agent', { treeName: 'elan', worktreeName: '' }, 'elan'],
      ['/Users/example/source/elan/monad-agent.worktrees/fresh', { treeName: 'elan', worktreeName: 'fresh' }, 'elan/fresh'],
      ['/Users/example/source/demo/monad-agent', { treeName: 'demo', worktreeName: '' }, 'demo'],
      ['/Users/example/.elanous/worktrees/axon-a477b47f/monad-agent.worktrees/self-impl', { treeName: 'axon-a477b47f', worktreeName: 'self-impl' }, 'axon-a477b47f/self-impl'],
      ['/Users/example/.elanous/worktrees/pilot-b8dc9b5c/monad-agent.worktrees/self-impl', { treeName: 'pilot-b8dc9b5c', worktreeName: 'self-impl' }, 'pilot-b8dc9b5c/self-impl'],
      ['/tmp/monad-agent.worktrees/fresh', { treeName: '', worktreeName: 'fresh' }, 'fresh'],
      ['/tmp/source/elan', { treeName: 'elan', worktreeName: '' }, 'elan'],
      ['/tmp/somewhere', { treeName: '', worktreeName: '' }, ''],
      [undefined, { treeName: '', worktreeName: '' }, ''],
    ] as const;
    for (const [workdir, names, label] of cases) {
      expect(terminalTreeNames(workdir)).toEqual(names);
      expect(terminalTreeLabel(workdir)).toBe(label);
    }
  });

  test('exports the shared age badge and parent identity formatting used by the view', () => {
    expect(terminalAgeBadge(99_000, 100_000)).toBe('1s ago');
    expect(terminalParentIdentity({ parentPtyId: 'parent', parentPid: 7, parentKind: 'pty' })).toBe('P:parent');
    expect(terminalParentIdentity({ parentPtyId: '', parentPid: 7, parentKind: 'pty' })).toBe('P:-');
    expect(terminalParentIdentity({ parentPtyId: '', parentPid: 7, parentKind: 'process' })).toBe('p:7');
    expect(terminalParentIdentity({ parentPtyId: '', parentPid: 0, parentKind: '' })).toBe('?:-');
    expect(terminalOriginIdentity({ originRoot: 'external-agent', originAgent: 'claude-code_2-1-221_agent', nestDepth: 0, chainOrigin: 'parent-chain' })).toBe('출신: 루트 external-agent · 에이전트 claude-code_2-1-221_agent · 깊이 0 · 체인 parent-chain');
    expect(terminalOriginIdentity({})).toBe('출신: 루트 미상 · 에이전트 미상 · 깊이 미상 · 체인 미상');
  });
});


describe('parseTerminalSgr', () => {
  test('splits supported SGR runs, resets style, and resolves basic and extended colors to CSS strings', () => {
    expect(parseTerminalSgr('plain \x1b[1;31mred\x1b[0m plain \x1b[38;5;196mindexed\x1b[48;2;1;2;3m truecolor')).toEqual([
      { text: 'plain ', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null } },
      { text: 'red', style: { bold: true, faint: false, italic: false, underline: false, inverse: false, foreground: 'var(--term-red)', background: null } },
      { text: ' plain ', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null } },
      { text: 'indexed', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'rgb(255, 0, 0)', background: null } },
      { text: ' truecolor', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'rgb(255, 0, 0)', background: 'rgb(1, 2, 3)' } },
    ]);
  });

  test('resolves indexed palette cube, grayscale, basic aliases, and truecolor for both foreground and background', () => {
    expect(parseTerminalSgr('\x1b[38;5;21mcube\x1b[38;5;232m gray\x1b[38;5;9m bright\x1b[48;5;255m background\x1b[48;2;7;8;9m true-background')).toEqual([
      { text: 'cube', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'rgb(0, 0, 255)', background: null } },
      { text: ' gray', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'rgb(8, 8, 8)', background: null } },
      { text: ' bright', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'var(--term-bright-red)', background: null } },
      { text: ' background', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'var(--term-bright-red)', background: 'rgb(238, 238, 238)' } },
      { text: ' true-background', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: 'var(--term-bright-red)', background: 'rgb(7, 8, 9)' } },
    ]);
  });

  test('consumes incomplete or invalid extended-color parameters without applying a color', () => {
    expect(parseTerminalSgr('\x1b[38;2;1;2m\x1b[1mbold \x1b[48;5;999mstill-bold')).toEqual([
      { text: 'bold still-bold', style: { bold: true, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null } },
    ]);
  });

  test('supports all requested attributes and bright foreground/background colors', () => {
    expect(parseTerminalSgr('\x1b[2;3;4;7;94;103mstyled')).toEqual([
      { text: 'styled', style: { bold: false, faint: true, italic: true, underline: true, inverse: true, foreground: 'var(--term-bright-blue)', background: 'var(--term-bright-yellow)' } },
    ]);
  });

  test('keeps an SGR-free frame as one identical run and drops non-SGR controls', () => {
    expect(parseTerminalSgr('plain <script>text</script>')).toEqual([
      { text: 'plain <script>text</script>', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null } },
    ]);
    expect(parseTerminalSgr('before\x1b[2Jafter\x1b]0;title\x07!')).toEqual([
      { text: 'beforeafter!', style: { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null } },
    ]);
  });
});

describe('handleTerminalsList', () => {
  test('empty registry → { terminals: [] }', async () => {
    const res = handleTerminalsList(bareReq(), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminals: unknown[] };
    expect(body.terminals).toEqual([]);
  });

  test('serializes owner run usage for every PTY row and preserves ledger-not-found as unknown', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 2, instance: 'local', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [
      row('terminated-owner', 'terminated', 40),
      { ...row('running-owner', 'running', 30), nickname: 'branch-running-owner' },
      row('no-run-owner', '', 20),
      row('unknown-owner', 'missing-ledger', 10),
    ];
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [], listPtyManifestRows: () => rows, listPtyManifestRowsAt: () => [], isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
      runTerminated: (runId) => ({ terminated: true, running: false, '': 'no-run-id', 'missing-ledger': 'ledger-not-found' }[runId] ?? 'ledger-indeterminate') as true | false | 'no-run-id' | 'ledger-not-found' | 'ledger-indeterminate',
    }).json() as { terminals: Array<{ id: string; ownerRunUsage?: string; nickname?: string }> };

    expect(body.terminals.map(({ id, ownerRunUsage }) => ({ id, ownerRunUsage }))).toEqual([
      { id: 'terminated-owner', ownerRunUsage: 'terminated-live-owner' },
      { id: 'running-owner', ownerRunUsage: 'running' },
      { id: 'unknown-owner', ownerRunUsage: 'unknown' },
      { id: 'no-run-owner', ownerRunUsage: 'no-run-id' },
    ]);
    expect(body.terminals.every((terminal) => terminal.ownerRunUsage !== undefined)).toBe(true);
    expect(body.terminals.find((terminal) => terminal.id === 'unknown-owner')).toHaveProperty('ownerRunUsage', 'unknown');
    expect(body.terminals.find((terminal) => terminal.id === 'running-owner')).toHaveProperty('nickname', 'branch-running-owner');
    expect(body.terminals.find((terminal) => terminal.id === 'no-run-owner')).not.toHaveProperty('nickname');
  });

  test('serializes manifest lastControlAt unchanged for local and manifest-only rows, including zero, and omits absent values', async () => {
    const local = spawnWith('local output');
    const row = (id: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 2, instance: 'local', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [
      { ...row(local.id, local.startedAt), lastControlAt: 1_725_000_000_123 },
      { ...row('manifest-zero', 2), lastControlAt: 0 },
      row('manifest-absent', 3),
    ];
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [], listPtyManifestRows: () => rows, listPtyManifestRowsAt: () => [], isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
      queryRunningRuns: () => { throw new Error('not part of lastControlAt serialization'); },
    }).json() as { terminals: Array<{ id: string; lastControlAt?: number }> };

    expect(body.terminals.find((terminal) => terminal.id === local.id)).toHaveProperty('lastControlAt', 1_725_000_000_123);
    expect(body.terminals.find((terminal) => terminal.id === 'manifest-zero')).toHaveProperty('lastControlAt', 0);
    expect(body.terminals.find((terminal) => terminal.id === 'manifest-absent')).not.toHaveProperty('lastControlAt');
  });

  test('classifies persisted producer origin roots without changing subject origins', async () => {
    expect(terminalOrigin({ originRoot: 'human-cli', originAgent: undefined, controller: undefined, parentKind: 'process' })).toBe('human');
    expect(terminalOrigin({ originRoot: 'external-agent', originAgent: 'agent', controller: 'controller', parentKind: 'pty' })).toBe('system');
    expect(terminalOrigin({ originRoot: undefined, originAgent: undefined, controller: undefined, parentKind: '' })).toBe('unknown');
    expect(terminalOrigin({ originRoot: 'unknown-origin', originAgent: 'agent', controller: 'controller', parentKind: 'process' })).toBe('unknown');
    expect(terminalOrigin({ originRoot: 'human', originAgent: undefined, controller: undefined, parentKind: '' })).toBe('unknown');
    expect(terminalOrigin({ originRoot: 'system', originAgent: undefined, controller: undefined, parentKind: '' })).toBe('unknown');

    const human = spawnWith('human output', { cmd: 'pty-system-prefix' });
    const system: PtyManifestRow = {
      id: 'term-external-agent', kind: 'tui', cmd: 'system command', ownerPid: 1, ptyPid: 2, instance: 'remote', startedAt: 30, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 30, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: 'system-run', runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 1, parentKind: 'process',
      originRoot: 'external-agent', originAgent: 'worker', closedAt: 0, codeSha: '',
    };
    const humanManifest: PtyManifestRow = {
      ...system, id: human.id, kind: 'manual', nickname: 'human-cli-branch', cmd: 'preserved manifest command', originRoot: 'human-cli', originAgent: undefined,
      parentPtyId: '', parentPid: 11, parentKind: 'process', runId: '', startedAt: human.startedAt,
    };
    const unknown: PtyManifestRow = {
      ...system, id: 'webterm-ambiguous', kind: 'webterm', cmd: 'tool registration', originRoot: 'unknown-origin', originAgent: 'tool', controller: 'daemon',
      parentPtyId: '', parentPid: 12, parentKind: 'pty', runId: '', startedAt: 31,
    };
    const missing: PtyManifestRow = {
      ...system, id: 'origin-missing', originRoot: undefined, originAgent: undefined, controller: undefined, startedAt: 32,
    };
    const legacyHuman: PtyManifestRow = { ...system, id: 'legacy-human', originRoot: 'human', startedAt: 33 };
    const legacySystem: PtyManifestRow = { ...system, id: 'legacy-system', originRoot: 'system', startedAt: 34 };
    const body = await handleTerminalsList(bareReq(), opts, {
      listPty: () => [human], listPtyManifestRows: () => [humanManifest, system, unknown, missing, legacyHuman, legacySystem], listPtyManifestRowsAt: () => [], ptyManifestTargets: () => [],
      isProcessAlive: () => true, reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string; cmd: string; origin: string }>; subjects: Array<{ id: string; origin: string }> };

    expect(body.terminals.find((terminal) => terminal.id === human.id)).toEqual(expect.objectContaining({ cmd: 'pty-system-prefix', nickname: 'human-cli-branch', origin: 'human', producer: 'process' }));
    expect(body.terminals.find((terminal) => terminal.id === system.id)).toEqual(expect.objectContaining({ origin: 'system', producer: 'process' }));
    for (const terminal of [unknown, missing, legacyHuman, legacySystem]) {
      expect(body.terminals.find((candidate) => candidate.id === terminal.id)).toEqual(expect.objectContaining({ origin: 'unknown' }));
    }
    expect(body.terminals.every((terminal) => 'origin' in terminal)).toBe(true);
    expect(body.subjects).toContainEqual(expect.objectContaining({ id: `pty:${human.id}`, origin: 'system' }));
    expect(body.subjects).toContainEqual(expect.objectContaining({ id: 'subject:system-run', origin: 'system' }));
  });

  // Observed 6,008.02ms under load; allow 13,991.98ms of finite headroom with a 20,000ms per-test budget.
  test('merges web preview PTYs into local and federated lists with their first registration time', async () => {
    const first = makePreviewTerminal(3101);
    const second = makePreviewTerminal(3102);
    registerPreviewTerminalForWebTap(first, 'web-session-a', 'preview', previewTapHandle);
    const firstRegisteredAt = listAllPreviewTerminals()[0]!.firstRegisteredAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    registerPreviewTerminalForWebTap(first, 'web-session-a', 'preview-renamed', previewTapHandle);
    registerPreviewTerminalForWebTap(second, 'web-session-b', 'preview-renamed', previewTapHandle);
    const newerPty = spawnWith('newer', { cmd: 'newer-pty' });
    const olderPty = spawnWith('older', { cmd: 'older-pty' });
    Object.assign(newerPty, { startedAt: firstRegisteredAt + 20 });
    Object.assign(olderPty, { startedAt: firstRegisteredAt - 20 });
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => [],
      listPtyManifestRowsAt: () => [],
      listPty: () => [newerPty, olderPty],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };

    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<{ id: string; startedAt: number; origin: string; producer: string; sourceRoot?: { name: string } }>; subjects: unknown[]; scope: { federated: boolean } };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { terminals: Array<{ id: string; startedAt: number; origin: string; producer: string; sourceRoot?: { name: string } }>; subjects: unknown[]; scope: { federated: boolean } };
    for (const body of [local, federated]) {
      const firstRow = body.terminals.find((terminal) => terminal.id === 'preview-renamed' && terminal.sourceRoot?.name === 'web-session-a');
      const secondRow = body.terminals.find((terminal) => terminal.id === 'preview-renamed' && terminal.sourceRoot?.name === 'web-session-b');
      expect(firstRow?.startedAt).toBe(firstRegisteredAt);
      expect(firstRow?.origin).toBe('unknown');
      expect(firstRow?.producer).toBe('web-registration');
      expect(secondRow?.origin).toBe('unknown');
      expect(secondRow?.producer).toBe('web-registration');
      expect(secondRow).toBeDefined();
      expect(body.terminals.map((terminal) => terminal.id)).toEqual([
        newerPty.id,
        'preview-renamed',
        'preview-renamed',
        olderPty.id,
      ]);
    }
    expect(local.terminals).toHaveLength(4);
    expect(federated.terminals).toHaveLength(4);
    expect(local.subjects).toHaveLength(2);
    expect(federated.subjects).toHaveLength(2);
    expect(local.scope.federated).toBe(false);
    expect(federated.scope.federated).toBe(true);
  }, 20_000);

  test('keeps same-ID process and web-registration rows distinct with producer provenance', async () => {
    const process = spawnWith('process output', { cmd: 'process-command' });
    Object.assign(process, { id: 'shared-terminal-id', startedAt: 100 });
    registerPreviewTerminalForWebTap(makePreviewTerminal(3103), 'web-session', 'shared-terminal-id', previewTapHandle);
    const webRegisteredAt = listAllPreviewTerminals()[0]!.firstRegisteredAt;
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => [],
      listPtyManifestRowsAt: () => [],
      listPty: () => [process],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string; cmd: string; producer: string; startedAt: number; sourceRoot?: { name: string; dbPath: string } }> };

    expect(body.terminals).toHaveLength(2);
    expect(body.terminals.map(({ id, cmd, startedAt, producer, sourceRoot }) => ({ id, cmd, startedAt, producer, sourceRoot }))).toEqual([
      { id: 'shared-terminal-id', cmd: 'web-terminal', startedAt: webRegisteredAt, producer: 'web-registration', sourceRoot: { name: 'web-session', dbPath: 'web-terminal:web-session' } },
      { id: 'shared-terminal-id', cmd: 'process-command', startedAt: 100, producer: 'process', sourceRoot: undefined },
    ]);
  });

  // Observed 6,675.07ms under load; allow 13,324.93ms of finite headroom with a 20,000ms per-test budget.
  test('excludes inactive web preview PTYs from local and federated lists', async () => {
    const active = makePreviewTerminal(3103);
    const inactive = makePreviewTerminal(3104);
    registerPreviewTerminalForWebTap(active, 'web-session', 'active-preview', previewTapHandle);
    registerPreviewTerminalForWebTap(inactive, 'web-session', 'inactive-preview', previewTapHandle);
    (inactive as unknown as { isAlive: boolean }).isAlive = false;
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => [],
      listPtyManifestRowsAt: () => [],
      listPty: () => [],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };

    for (const request of [bareReq(), bareReq('http://localhost/v1/terminals?all=true')]) {
      const body = await handleTerminalsList(request, opts, deps).json() as {
        terminals: Array<{ id: string; alive: boolean; exitCode: number | null }>;
      };
      expect(body.terminals).toEqual([
        expect.objectContaining({ id: 'active-preview', alive: true, exitCode: null }),
      ]);
      expect(body.terminals.find((terminal) => terminal.id === 'inactive-preview')).toBeUndefined();
      expect(body.terminals.some((terminal) => terminal.exitCode === 0)).toBe(false);
    }
  }, 20_000);

  test('keeps PTY hidden-dead scope independent from a same-ID web terminal', async () => {
    registerPreviewTerminalForWebTap(makePreviewTerminal(3103), 'web-session', 'shared-id', previewTapHandle);
    const hiddenPty: PtyManifestRow = {
      id: 'shared-id', kind: 'agent', cmd: 'closed-pty', ownerPid: 1, ptyPid: 2, instance: 'local', startedAt: 1, alive: false,
      exitCode: 0, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 1, codeSha: '',
    };
    const body = await handleTerminalsList(bareReq(), opts, {
      listPtyManifestRows: () => [hiddenPty],
      listPtyManifestRowsAt: () => [],
      ptyManifestTargets: () => [],
      listPty: () => [],
      isProcessAlive: () => false,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string; sourceRoot?: { name: string } }>; scope: { hiddenDead: number } };

    expect(body.terminals).toEqual([
      expect.objectContaining({ id: 'shared-id', sourceRoot: { name: 'web-session', dbPath: 'web-terminal:web-session' } }),
    ]);
    expect(body.scope.hiddenDead).toBe(1);
  });

  test('serializes reusable run assessments once per request without changing terminal fields or scope', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 2, instance: 'local', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [row('running-a', 'running', 40), row('running-b', 'running', 30), row('probable', 'probable', 20), row('ended', 'ended', 10), row('unmatched', 'unmatched', 5), row('without-run', '', 1)];
    const runningRuns: RunningRunsResult = {
      entries: [
        { runId: 'running', status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lifecycle: 'live', lastActivityTimestamp: null, ptyUpdatedAt: null, ledgerDirectories: [], ptyRefs: [] },
        { runId: 'probable', status: 'probable-running', presence: 'ledger-live-pty-not-observed', reason: 'ledger-without-live-pty', lifecycle: 'live', lastActivityTimestamp: null, ptyUpdatedAt: null, ledgerDirectories: [], ptyRefs: [] },
        { runId: 'ended', status: 'ended-unclosed', presence: 'ledger-and-pty-observed', reason: 'ledger-positive-termination-evidence', lifecycle: 'human-stopped', lastActivityTimestamp: null, ptyUpdatedAt: null, ledgerDirectories: [], ptyRefs: [] },
      ],
      counts: { running: 1, 'probable-running': 1, 'ended-unclosed': 1, unknown: 0 }, total: 3, countedStatuses: ['running', 'probable-running'],
      observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null },
      quantities: {
        counts: { value: { running: 1, 'probable-running': 1, 'ended-unclosed': 1, unknown: 0 }, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null } },
        total: { value: 3, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null } },
        entries: { value: 3, population: 'all assessed runs', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null } },
        running: { value: 2, population: 'assessed runs whose status is in countedStatuses', observation: { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null } },
      },
      ledger: { ledgerDirectories: [], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }, pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
    };
    let queries = 0;
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [], listPtyManifestRows: () => rows, listPtyManifestRowsAt: () => [], isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
      queryRunningRuns: () => { queries += 1; return runningRuns; },
    }).json() as { terminals: Array<{ id: string; runId: string; alive: boolean }>; subjects: Array<{ id: string; runId: string; screen: unknown; agent: unknown; talk: unknown; run: { status: string; reason: string; presence: string | null } }>; runningRuns: { running: number; 'probable-running': number; countedStatuses: string[] }; scope: Record<string, unknown> };

    expect(queries).toBe(1);
    expect(body.terminals.map(({ id, runId, alive }) => ({ id, runId, alive }))).toEqual(rows.map(({ id, runId, alive }) => ({ id, runId, alive })));
    expect(body.scope).toEqual({ roots: 1, federated: false, hiddenDead: 0, domain: '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.' });
    expect(body.runningRuns).toEqual({ running: 1, 'probable-running': 1, countedStatuses: ['running', 'probable-running'] });
    expect(body.subjects.find((subject) => subject.runId === 'running')).toEqual(expect.objectContaining({ screen: { ptyIds: ['running-a', 'running-b'], liveCount: 2 }, run: { status: 'running', reason: 'ledger-live-and-pty-alive', presence: 'ledger-live-and-pty-observed' }, talk: [] }));
    expect(body.subjects.find((subject) => subject.runId === 'probable')?.run).toEqual({ status: 'probable-running', reason: 'ledger-without-live-pty', presence: 'ledger-live-pty-not-observed' });
    expect(body.subjects.find((subject) => subject.runId === 'ended')?.run).toEqual({ status: 'ended-unclosed', reason: 'ledger-positive-termination-evidence', presence: 'ledger-and-pty-observed' });
    expect(body.subjects.find((subject) => subject.runId === 'unmatched')?.run).toEqual({ status: 'unknown', reason: 'run-assessment-not-found', presence: null });
    expect(body.subjects.find((subject) => subject.id === 'pty:without-run')?.run).toEqual({ status: 'unknown', reason: 'run-id-missing', presence: null });
  });

  test('keeps terminal subjects with unknown run assessments when the reusable query fails', async () => {
    const pty = spawnWith('query-failure', { cmd: 'query-failure' });
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [], listPtyManifestRowsAt: () => [], isProcessAlive: () => true, listPty: () => [pty],
      queryRunningRuns: () => { throw new Error('ledger unavailable'); },
    }).json() as { subjects: Array<{ run: { status: string; reason: string; presence: string | null } }>; runningRuns: { running: number; 'probable-running': number; countedStatuses: string[] } };

    expect(body.subjects).toEqual([expect.objectContaining({ run: { status: 'unknown', reason: 'run-id-missing', presence: null } })]);
    expect(body.runningRuns).toEqual({ running: 0, 'probable-running': 0, countedStatuses: ['running', 'probable-running'] });
  });

  test('reports local-only scope while preserving the existing local rows', async () => {
    const h = spawnWith('local', { cmd: 'local' });
    const body = await handleTerminalsList(bareReq(), opts).json() as {
      terminals: Array<{ id: string }>;
      scope: { roots: number; federated: boolean; hiddenDead: number; domain: string };
    };
    expect(body.terminals.map((terminal) => terminal.id)).toEqual([h.id]);
    expect(body.scope).toEqual({
      roots: 1,
      federated: false,
      hiddenDead: 0,
      domain: '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.',
    });
  });

  test('keeps PTY-less sub-agent summaries in subjects and scope but out of local, federated, and include-test terminal lists', async () => {
    const queries: Array<{ exactCategories?: string[]; events?: string[]; sinceMs?: number }> = [];
    const rowQueries: Array<{ exactCategories?: string[]; events?: string[]; sinceMs?: number; beforeId?: number }> = [];
    const opened: string[] = [];
    const closed: string[] = [];
    const dispatch = (cid: string, instance: string, ts: number, description: string) => ({ id: ts, ts: new Date(ts).toISOString(), ts_ms: ts, level: 'debug', instance, surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: `${instance}-session`, trace_id: null, data: JSON.stringify({ cid, resolvedAgent: `${instance}-agent`, description }) });
    const finish = (cid: string, instance: string, ts: number) => ({ id: ts, ts: new Date(ts).toISOString(), ts_ms: ts, level: 'debug', instance, surface: 'skill', category: 'agent.done', event: 'finish', session_id: `${instance}-session`, trace_id: null, data: JSON.stringify({ cid }) });
    const store = (path: string, rows: ReturnType<typeof dispatch>[]) => ({
      path,
      query(query: { exactCategories?: string[]; events?: string[]; sinceMs?: number; beforeId?: number }) {
        rowQueries.push(query);
        return rows
          .filter((row) => (!query.exactCategories || query.exactCategories.includes(row.category))
            && (!query.events || query.events.includes(row.event))
            && (query.sinceMs === undefined || row.ts_ms >= query.sinceMs)
            && (query.beforeId === undefined || row.id < query.beforeId))
          .sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id)
          .slice(0, 100);
      },
      close() { closed.push(path); },
    });
    const now = Date.now();
    const localPty = spawnWith('mixed', { cmd: 'mixed' });
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      ptyManifestDbPath: () => '/roots/current/manifest.db',
      listPtyManifestRows: () => [],
      listPtyManifestRowsAt: () => [],
      listPty: () => [localPty],
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
      queryRunningRuns: () => { throw new Error('not needed by this test'); },
      isProcessAlive: () => true,
      getDefaultLogStore: () => store('/roots/local/logs.db', [dispatch('local-open', 'local', localPty.startedAt + 1, 'local task'), finish('local-open', 'local', now)]),
      logInstances: ({ includeTest }: { includeTest?: boolean }) => [
        { name: 'prod-remote', dbPath: '/roots/prod/logs.db', dbExists: true, kind: 'prod' },
        ...(includeTest ? [{ name: 'test-remote', dbPath: '/roots/test/logs.db', dbExists: true, kind: 'test' }] : []),
        { name: 'unreadable', dbPath: '/roots/unreadable/logs.db', dbExists: true, kind: 'prod' },
      ],
      openLogStoreReadOnly(dbPath: string) {
        opened.push(dbPath);
        if (dbPath.includes('unreadable')) throw new Error('unreadable');
        if (dbPath.includes('/test/')) return store(dbPath, [dispatch('test-finished', 'test', now - 1, 'test task'), finish('test-finished', 'test', now)]);
        return store(dbPath, [dispatch('prod-failed', 'prod', now - 2, 'prod task'), { ...finish('prod-failed', 'prod', now), category: 'agent.error', event: 'failed' }]);
      },
    };
    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<Record<string, unknown>>; scope: Record<string, unknown> };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<Record<string, unknown>>; scope: Record<string, unknown> };
    const includeTest = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true&includeTest=true'), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<Record<string, unknown>>; scope: Record<string, unknown> };

    expect(local.scope.hiddenSubAgentRuns).toBe(1);
    expect(federated.scope.hiddenSubAgentRuns).toBe(2);
    expect(includeTest.scope.hiddenSubAgentRuns).toBe(3);
    for (const body of [local, federated, includeTest]) {
      expect(body.terminals.filter((terminal) => terminal.hasPty === false)).toEqual([]);
    }
    expect(local.terminals.map((terminal) => terminal.id)).toEqual([localPty.id]);
    expect(local.subjects).toContainEqual(expect.objectContaining({ id: 'subject:local-open', runId: 'local-open', agent: { names: ['local-agent: local task'], controllers: [] } }));
    expect(federated.subjects).toContainEqual(expect.objectContaining({ id: 'subject:prod-failed', runId: 'prod-failed', agent: { names: ['prod-agent: prod task'], controllers: [] } }));
    expect(federated.subjects).not.toContainEqual(expect.objectContaining({ id: 'subject:test-finished' }));
    expect(includeTest.subjects).toContainEqual(expect.objectContaining({ id: 'subject:test-finished', runId: 'test-finished', agent: { names: ['test-agent: test task'], controllers: [] } }));
    expect(opened).toEqual(['/roots/prod/logs.db', '/roots/unreadable/logs.db', '/roots/prod/logs.db', '/roots/test/logs.db', '/roots/unreadable/logs.db']);
    expect(closed).toEqual(['/roots/prod/logs.db', '/roots/prod/logs.db', '/roots/test/logs.db']);
    expect(queries).toHaveLength(0);
    expect(rowQueries.some((query) => query.exactCategories?.includes('agent.spawn') && query.events?.includes('dispatch'))).toBe(true);
    expect(rowQueries.some((query) => query.exactCategories?.includes('agent.done') && query.events?.includes('finish'))).toBe(true);
    expect(rowQueries.some((query) => query.beforeId !== undefined)).toBe(true);
  });

  test('derives PTY-less background sub-agent status through its task completion event', async () => {
    const now = Date.now();
    const dispatch = { id: 10, ts: new Date(now - 30).toISOString(), ts_ms: now - 30, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: 'background-session', trace_id: null, data: JSON.stringify({ cid: '6bd1d712', resolvedAgent: 'background-agent', description: 'background task' }) };
    const background = { id: 11, ts: new Date(now - 20).toISOString(), ts_ms: now - 20, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'background', session_id: 'background-session', trace_id: null, data: JSON.stringify({ cid: '6bd1d712', taskId: '49ed0fcd-78d4-44d0-8550-796aeb5704b5' }) };
    const completion = { id: 12, ts: new Date(now - 10).toISOString(), ts_ms: now - 10, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.task-routing', event: 'auto-foreground-on-completion', session_id: 'background-session', trace_id: null, data: JSON.stringify({ taskId: '49ed0fcd-78d4-44d0-8550-796aeb5704b5', state: 'done', finishedAt: now - 10, reason: 'background-task-completed' }) };
    const failedDispatch = { ...dispatch, id: 13, ts_ms: now - 29, data: JSON.stringify({ cid: 'background-failed', resolvedAgent: 'background-agent', description: 'failed background task' }) };
    const failedBackground = { ...background, id: 14, ts_ms: now - 19, data: JSON.stringify({ cid: 'background-failed', taskId: 'background-failed-task' }) };
    const failedCompletion = { ...completion, id: 15, ts_ms: now - 9, data: JSON.stringify({ taskId: 'background-failed-task', state: 'error', finishedAt: now - 9, reason: 'background-task-completed' }) };
    const abortedDispatch = { ...dispatch, id: 16, ts_ms: now - 28, data: JSON.stringify({ cid: 'background-aborted', resolvedAgent: 'background-agent', description: 'aborted background task' }) };
    const abortedBackground = { ...background, id: 17, ts_ms: now - 18, data: JSON.stringify({ cid: 'background-aborted', taskId: 'background-aborted-task' }) };
    const abortedCompletion = { ...completion, id: 18, ts_ms: now - 8, data: JSON.stringify({ taskId: 'background-aborted-task', state: 'aborted', finishedAt: now - 8, reason: 'background-task-completed' }) };
    const foregroundDispatch = { ...dispatch, id: 20, ts_ms: now - 25, data: JSON.stringify({ cid: 'foreground', resolvedAgent: 'foreground-agent', description: 'foreground task' }) };
    const foregroundFinish = { ...completion, id: 21, ts_ms: now - 5, category: 'agent.done', event: 'finish', data: JSON.stringify({ cid: 'foreground' }) };
    const rows = [dispatch, background, completion, failedDispatch, failedBackground, failedCompletion, abortedDispatch, abortedBackground, abortedCompletion, foregroundDispatch, foregroundFinish];
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => ({
        query(query: { exactCategories?: string[]; events?: string[]; sinceMs?: number; beforeId?: number }) {
          return rows
            .filter((row) => (!query.exactCategories || query.exactCategories.includes(row.category))
              && (!query.events || query.events.includes(row.event))
              && (query.sinceMs === undefined || row.ts_ms >= query.sinceMs)
              && (query.beforeId === undefined || row.id < query.beforeId))
            .sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id)
            .slice(0, 100);
        },
      }),
    };

    const body = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<{ runId: string; agent: { names: string[] } }> };

    expect(body.terminals).toEqual([]);
    expect(body.subjects.map((subject) => subject.runId).sort()).toEqual(['6bd1d712', 'background-aborted', 'background-failed', 'foreground']);
    expect(body.subjects.find((subject) => subject.runId === '6bd1d712')?.agent.names).toEqual(['background-agent: background task']);
  });

  test('derives PTY-less sub-agent status from the newest terminal event when a cid has several', async () => {
    const now = Date.now();
    const dispatch = { id: 10, ts: new Date(now - 30).toISOString(), ts_ms: now - 30, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: 'multi-session', trace_id: null, data: JSON.stringify({ cid: 'multi', resolvedAgent: 'multi-agent', description: 'multi-terminal task' }) };
    // Same cid, two terminal events: an older failure and a newer finish. The
    // store hands them back newest-first (ts_ms DESC), matching LogStore.query.
    const olderFailed = { id: 11, ts: new Date(now - 20).toISOString(), ts_ms: now - 20, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.error', event: 'failed', session_id: 'multi-session', trace_id: null, data: JSON.stringify({ cid: 'multi' }) };
    const newerFinish = { id: 12, ts: new Date(now - 10).toISOString(), ts_ms: now - 10, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.done', event: 'finish', session_id: 'multi-session', trace_id: null, data: JSON.stringify({ cid: 'multi' }) };
    const rows = [dispatch, olderFailed, newerFinish];
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => ({
        query(query: { exactCategories?: string[]; events?: string[]; sinceMs?: number; beforeId?: number }) {
          return rows
            .filter((row) => (!query.exactCategories || query.exactCategories.includes(row.category))
              && (!query.events || query.events.includes(row.event))
              && (query.sinceMs === undefined || row.ts_ms >= query.sinceMs)
              && (query.beforeId === undefined || row.id < query.beforeId))
            .sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id)
            .slice(0, 100);
        },
      }),
    };

    const body = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<{ runId: string; agent: { names: string[] } }> };

    expect(body.terminals).toEqual([]);
    expect(body.subjects.find((subject) => subject.runId === 'multi')?.agent.names).toEqual(['multi-agent: multi-terminal task']);
  });

  test('stops paging a PTY-less log store that repeats its cursor row', async () => {
    const now = Date.now();
    const repeatedDispatch = { id: 91, ts: new Date(now).toISOString(), ts_ms: now, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: 'repeated-session', trace_id: null, data: JSON.stringify({ cid: 'repeated', resolvedAgent: 'repeat-agent', description: 'repeated cursor row' }) };
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => ({ query: () => [repeatedDispatch] }),
    };

    const body = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<{ runId: string; agent: { names: string[] } }>; scope: Record<string, unknown> };

    expect(body.scope.hiddenSubAgentRuns).toBe(1);
    expect(body.terminals).toEqual([]);
    expect(body.subjects.find((subject) => subject.runId === 'repeated')?.agent.names).toEqual(['repeat-agent: repeated cursor row']);
  });

  test('omits the PTY-less sub-agent count rather than reporting zero when its store is unavailable', async () => {
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => null,
    };
    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { scope: Record<string, unknown> };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { scope: Record<string, unknown> };

    expect(local.scope).not.toHaveProperty('hiddenSubAgentRuns');
    expect(federated.scope).not.toHaveProperty('hiddenSubAgentRuns');
  });

  test('keeps PTY rows available and omits the badge when the local PTY-less log query fails', async () => {
    const pty = spawnWith('local-survives-log-failure', { cmd: 'local' });
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      listPty: () => [pty],
      getDefaultLogStore: () => ({ query() { throw new Error('broken logs schema'); } }),
    };

    const body = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<{ id: string }>; scope: Record<string, unknown> };

    expect(body.terminals).toContainEqual(expect.objectContaining({ id: pty.id }));
    expect(body.scope).not.toHaveProperty('hiddenSubAgentRuns');
  });

  test('uses a stable log-row identity for a PTY-less dispatch without cid', async () => {
    const now = Date.now();
    const deps = {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => ({
        query: () => [{ id: 73, ts: new Date(now).toISOString(), ts_ms: now, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: 'session-without-cid', trace_id: null, data: JSON.stringify({ resolvedAgent: 'fallback-agent', description: 'no cid task' }) }],
      }),
    };

    const body = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<Record<string, unknown>>; subjects: Array<{ id: string; runId: string; agent: { names: string[] } }>; scope: Record<string, unknown> };

    expect(body.scope.hiddenSubAgentRuns).toBe(1);
    expect(body.terminals).toEqual([]);
    expect(body.subjects.find((subject) => subject.id === 'subject:log:73')).toMatchObject({ runId: 'log:73', agent: { names: ['fallback-agent: no cid task'] } });
  });

  test('keeps cid-less rows from federated stores in subjects after excluding them from terminals', async () => {
    const now = Date.now();
    const dispatch = (instance: string) => ({ id: 73, ts: new Date(now).toISOString(), ts_ms: now, level: 'debug', instance, surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: `${instance}-session`, trace_id: null, data: JSON.stringify({ resolvedAgent: `${instance}-agent`, description: `${instance} task` }) });
    const store = (path: string, instance: string) => ({ path, query: ({ exactCategories }: { exactCategories?: string[] }) => exactCategories?.includes('agent.spawn') ? [dispatch(instance)] : [], close() {} });
    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      getDefaultLogStore: () => store('/roots/local/logs.db', 'local'),
      logInstances: () => [{ name: 'remote', dbPath: '/roots/remote/logs.db', dbExists: true }],
      openLogStoreReadOnly: () => store('/roots/remote/logs.db', 'remote'),
    }).json() as { terminals: Array<{ id: string }>; subjects: Array<{ runId: string; agent: { names: string[] } }> };

    expect(body.terminals).toEqual([]);
    expect(body.subjects).toEqual([expect.objectContaining({
      runId: 'log:73',
      agent: { names: ['local-agent: local task', 'remote-agent: remote task'], controllers: [] },
    })]);
  });

  test('preserves the PTY run order without using hasPty to filter log-derived sub-agent summaries', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [row('run-a-new', 'run-a', 100), row('run-a-old', 'run-a', 10), row('run-b', 'run-b', 90)];
    const now = Date.now();
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => rows,
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
      getDefaultLogStore: () => ({ query: ({ exactCategories }: { exactCategories?: string[] }) => exactCategories?.includes('agent.spawn') ? [{ id: 1, ts: new Date(now).toISOString(), ts_ms: 95, level: 'debug', instance: 'local', surface: 'skill', category: 'agent.spawn', event: 'dispatch', session_id: 'session', trace_id: null, data: JSON.stringify({ cid: 'no-pty', resolvedAgent: 'worker', description: 'task' }) }] : [] }),
    }).json() as { terminals: Array<{ id: string; hasPty?: boolean }>; subjects: Array<{ runId: string; agent: { names: string[] } }> };

    expect(body.terminals.map((terminal) => terminal.id)).toEqual(['run-a-new', 'run-a-old', 'run-b']);
    expect(body.terminals.some((terminal) => terminal.hasPty === false)).toBe(false);
    expect(body.subjects.find((subject) => subject.runId === 'no-pty')?.agent.names).toEqual(['worker: task']);
  });

  test('counts dead manifest rows hidden by local cleanup without changing local row order', async () => {
    const local = spawnWith('local', { cmd: 'local' });
    const deadId = `dead:${Math.floor(performance.now() * 1_000)}`;
    upsertPtyManifest({ id: deadId, kind: 'agent', cmd: 'dead', ptyPid: 999_999_999, startedAt: local.startedAt - 1, now: Date.now() });
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: (pid) => pid !== 999_999_999,
    }).json() as { terminals: Array<{ id: string }>; scope: { roots: number; federated: boolean; hiddenDead: number; domain: string } };
    expect(body.terminals.map((terminal) => terminal.id)).toEqual([local.id]);
    expect(body.scope).toEqual({
      roots: 1,
      federated: false,
      hiddenDead: 1,
      domain: '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.',
    });
  });

  test('uses PTY liveness for both local filtering and hidden count when cleanup fails', async () => {
    const ownerAlivePtyDead: PtyManifestRow = {
      id: 'owner-alive-pty-dead', kind: 'agent', cmd: 'dead-pty', ownerPid: 21, ptyPid: 22, instance: 'local',
      startedAt: 1, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const cleanupFailed = () => { throw new Error('cleanup failed'); };
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => [ownerAlivePtyDead],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: (pid) => pid === ownerAlivePtyDead.ownerPid,
      reapDeadPtyManifest: cleanupFailed,
      purgeClosedPtyManifest: cleanupFailed,
      reapStalePtyManifest: cleanupFailed,
      reapOrphanedOwnedPtyManifest: cleanupFailed,
    }).json() as { terminals: Array<{ id: string }>; scope: { hiddenDead: number } };
    expect(body.terminals).toEqual([]);
    expect(body.scope.hiddenDead).toBe(1);
    expect(1 - body.terminals.length).toBe(body.scope.hiddenDead);
  });

  test('counts live-PID rows removed by stale and orphan cleanup in the final hidden total', async () => {
    const row = (id: string): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 31, ptyPid: 32, instance: 'local', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const before = [row('stale-live-pid'), row('orphan-live-pid')];
    let current = before;
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPtyManifestRows: () => current,
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => { current = current.filter((candidate) => candidate.id !== 'stale-live-pid'); return 1; },
      reapOrphanedOwnedPtyManifest: () => { current = current.filter((candidate) => candidate.id !== 'orphan-live-pid'); return 1; },
    }).json() as { terminals: Array<{ id: string }>; scope: { hiddenDead: number } };
    const returnedCandidateCount = body.terminals.filter((terminal) => before.some((candidate) => candidate.id === terminal.id)).length;
    expect(body.terminals).toEqual([]);
    expect(body.scope.hiddenDead).toBe(2);
    expect(before.length - returnedCandidateCount).toBe(body.scope.hiddenDead);
  });

  test('single PTY summary', async () => {
    const h = spawnWith('hello world\n', { cmd: 'foo', workdir: '/tmp' });
    const res = handleTerminalsList(bareReq(), opts);
    const body = (await res.json()) as {
      terminals: Array<{
        id: string;
        cmd: string;
        workdir?: string;
        treeName: string;
        worktreeName: string;
        parentPtyId: string;
        parentPid: number;
        parentKind: string;
        runId: string;
        alive: boolean;
        outputBytes: number;
        startedAt: number;
      }>;
    };
    expect(body.terminals).toHaveLength(1);
    expect(body.terminals[0]!.id).toBe(h.id);
    expect(body.terminals[0]!.cmd).toBe('foo');
    expect(body.terminals[0]!.workdir).toBe('/tmp');
    expect(body.terminals[0]!.treeName).toBe('');
    expect(body.terminals[0]!.worktreeName).toBe('');
    expect(body.terminals[0]!.parentPtyId).toBe('');
    expect(body.terminals[0]!.parentPid).toBe(0);
    expect(body.terminals[0]!.parentKind).toBe('');
    expect(body.terminals[0]!.runId).toBe('');
    expect(body.terminals[0]!.alive).toBe(true);
    expect(body.terminals[0]!.outputBytes).toBe('hello world\n'.length);
  });

  test('serializes local access modes, reports manifest-only rows as unknown, and keeps local values for duplicate IDs', async () => {
    const read = spawnWith('read-output', { cmd: 'read-command', workdir: '/tmp' });
    const write = spawnWith('write-output', { cmd: 'write-command', workdir: '/tmp' });
    const auto = spawnWith('auto-output', { cmd: 'auto-command', workdir: '/tmp' });
    read.setAccessMode('read');
    auto.setAccessMode('auto');
    Object.assign(read, { startedAt: 10 });
    Object.assign(write, { startedAt: 20 });
    Object.assign(auto, { startedAt: 30 });
    registerPreviewTerminalForWebTap(makePreviewTerminal(3105), 'web-session', 'web-only', previewTapHandle);
    const manifestRow = (id: string, overrides: Partial<PtyManifestRow> = {}): PtyManifestRow => ({
      id, kind: 'agent', cmd: 'manifest-command', workdir: '/manifest/workdir', ownerPid: 1, ptyPid: 2,
      instance: 'remote', startedAt: 1, alive: true, exitCode: null, snapshot: 'manifest-output', snapshotAt: 0,
      updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '',
      sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', ...overrides,
    });
    const rows = [
      manifestRow(read.id, { alive: false, cmd: 'overwritten-command', workdir: '/overwritten/workdir', snapshot: 'overwritten-output' }),
      manifestRow('manifest-only'),
    ];
    const body = await handleTerminalsList(bareReq(), opts, {
      listPty: () => [read, write, auto],
      listPtyManifestRows: () => rows,
      ptyManifestTargets: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string; cmd: string; workdir?: string; alive: boolean; outputBytes: number; accessMode: 'read' | 'write' | 'auto' | null; accessModeUnavailableReason: 'owner-process-only' | 'not-applicable' | null }> };

    const localDuplicate = body.terminals.filter((terminal) => terminal.id === read.id);
    expect(localDuplicate).toHaveLength(1);
    expect(localDuplicate[0]).toEqual(expect.objectContaining({
      id: read.id, cmd: 'read-command', workdir: '/tmp', alive: true, outputBytes: 'read-output'.length, accessMode: 'read', accessModeUnavailableReason: null,
    }));
    expect(body.terminals.find((terminal) => terminal.id === write.id)).toEqual(expect.objectContaining({ accessMode: 'write', accessModeUnavailableReason: null }));
    expect(body.terminals.find((terminal) => terminal.id === auto.id)).toEqual(expect.objectContaining({ accessMode: 'auto', accessModeUnavailableReason: null }));
    expect(body.terminals.find((terminal) => terminal.id === 'manifest-only')).toEqual(expect.objectContaining({
      accessMode: null,
      accessModeUnavailableReason: 'owner-process-only',
    }));
    expect(body.terminals.find((terminal) => terminal.id === 'web-only')).toEqual(expect.objectContaining({
      accessMode: null,
      accessModeUnavailableReason: 'not-applicable',
    }));
    const unavailableReasons = new Set(body.terminals
      .filter((terminal) => terminal.accessMode === null)
      .map((terminal) => terminal.accessModeUnavailableReason));
    expect(unavailableReasons).toEqual(new Set(['owner-process-only', 'not-applicable']));
    expect(body.terminals).toHaveLength(5);
    expect(body.terminals.map((terminal) => terminal.id)).toEqual([
      'web-only', auto.id, write.id, read.id, 'manifest-only',
    ]);
  });

  // Observed 6,247.99ms under load; allow 13,752.01ms of finite headroom with a 20,000ms per-test budget.
  test('keeps known run participants adjacent in local and federated observatory lists', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: runId ? 'explicit' : '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [
      row('run-a-older', 'run-a', 90),
      row('other-run', 'run-b', 95),
      row('run-a-newer', 'run-a', 100),
      row('unknown-newer', '', 1_000),
      row('unknown-older', '', 80),
    ];
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      ptyManifestDbPath: () => '/roots/remote/manifest.db',
      listPtyManifestRows: () => rows,
      listPtyManifestRowsAt: () => rows,
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };
    const expected = ['run-a-newer', 'run-a-older', 'other-run', 'unknown-newer', 'unknown-older'];
    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<{ id: string }> };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { terminals: Array<{ id: string }> };

    expect(local.terminals.map((terminal) => terminal.id)).toEqual(expected);
    expect(federated.terminals.map((terminal) => terminal.id)).toEqual(expected);
  }, 20_000);

  // Observed 6,499.68ms under load; allow 13,500.32ms of finite headroom with a 20,000ms per-test budget.
  test('uses run ID as a deterministic tie-breaker when run newest times match', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: runId ? 'explicit' : '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const rows = [
      row('run-b-older', 'run-b', 89),
      row('run-a-older', 'run-a', 90),
      row('run-b-newer', 'run-b', 100),
      row('run-a-newer', 'run-a', 100),
      row('unknown-newer', '', 1_000),
      row('unknown-older', '', 80),
    ];
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      ptyManifestDbPath: () => '/roots/remote/manifest.db',
      listPtyManifestRows: () => rows,
      listPtyManifestRowsAt: () => rows,
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };
    const expected = ['run-a-newer', 'run-a-older', 'run-b-newer', 'run-b-older', 'unknown-newer', 'unknown-older'];
    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<{ id: string }> };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { terminals: Array<{ id: string }> };

    expect(local.terminals.map((terminal) => terminal.id)).toEqual(expected);
    expect(federated.terminals.map((terminal) => terminal.id)).toEqual(expected);
  }, 20_000);

  // Observed 6,253.53ms under load; allow 13,746.47ms of finite headroom with a 20,000ms per-test budget.
  test('keeps Unicode-distinct runs adjacent when equal newest times collate together', async () => {
    const row = (id: string, runId: string, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId, runIdSource: runId ? 'explicit' : '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const decomposed = 'run-e\u0301';
    const composed = 'run-é';
    const rows = [
      row('composed-older', composed, 80),
      row('decomposed-older', decomposed, 90),
      row('composed-newer', composed, 100),
      row('decomposed-newer', decomposed, 100),
      row('unknown', '', 1_000),
    ];
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      ptyManifestDbPath: () => '/roots/remote/manifest.db',
      listPtyManifestRows: () => rows,
      listPtyManifestRowsAt: () => rows,
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };
    const expected = ['decomposed-newer', 'decomposed-older', 'composed-newer', 'composed-older', 'unknown'];
    const local = await handleTerminalsList(bareReq(), opts, deps).json() as { terminals: Array<{ id: string; runId: string; startedAt: number }> };
    const federated = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as { terminals: Array<{ id: string; runId: string; startedAt: number }> };

    expect(local.terminals.map((terminal) => terminal.id)).toEqual(expected);
    expect(federated.terminals.map((terminal) => terminal.id)).toEqual(expected);
    expect(local.terminals.map((terminal) => terminal.runId)).toEqual([decomposed, decomposed, composed, composed, '']);
    expect(local.terminals.map((terminal) => terminal.startedAt)).toEqual([100, 90, 100, 80, 1_000]);
  }, 20_000);

  test('federates requested roots, reports each source path, and hides dead process rows', async () => {
    const row = (id: string, ptyPid: number, startedAt: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid, instance: 'same-name', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0,
      parentKind: '', closedAt: 0, codeSha: '',
    });
    const calls: boolean[] = [];
    const res = handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true&includeTest=true'), opts, {
      ptyManifestTargets({ includeTest }) {
        calls.push(includeTest === true);
        return [{ name: 'same-name', dbPath: '/roots/a/manifest.db' }, { name: 'same-name', dbPath: '/roots/b/manifest.db' }];
      },
      ptyManifestDbPath: () => '/roots/a/manifest.db',
      listPtyManifestRows: () => [],
      listPty: () => [],
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
      queryRunningRuns: () => { throw new Error('not needed by this test'); },
      getDefaultLogStore: () => null,
      listPtyManifestRowsAt(dbPath) {
        return dbPath.includes('/a/') ? [row('live-a', 11, 1), row('dead-a', 12, 2)] : [row('live-b', 13, 3)];
      },
      isProcessAlive(pid) { return pid !== 12; },
    });
    const body = await res.json() as {
      terminals: Array<{ id: string; sourceRoot: { name: string; dbPath: string } }>;
      scope: { roots: number; federated: boolean; hiddenDead: number; domain: string };
    };
    expect(calls).toEqual([true]);
    expect(body.scope).toEqual({
      roots: 2,
      federated: true,
      hiddenDead: 0,
      domain: '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.',
    });
    expect(body.terminals.map((terminal) => terminal.id)).toEqual(['live-b', 'live-a']);
    expect(body.terminals.map((terminal) => terminal.sourceRoot)).toEqual([
      { name: 'same-name', dbPath: '/roots/b/manifest.db' },
      { name: 'same-name', dbPath: '/roots/a/manifest.db' },
    ]);
  });

  // Observed 5,930.60ms under load; allow 14,069.40ms of finite headroom with a 20,000ms per-test budget.
  test('always includes the current manifest root in federated listings using physical-path deduplication', async () => {
    const row = (id: string): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'test', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const reads: string[] = [];
    const deps = {
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }, { name: 'current-alias', dbPath: '/links/current/manifest.db' }],
      ptyManifestDbPath: () => '/roots/current/manifest.db',
      realpath: (path: string) => path === '/links/current/manifest.db' ? '/roots/current/manifest.db' : path,
      listPtyManifestRows: () => [row('current-live')],
      listPtyManifestRowsAt(dbPath: string) {
        reads.push(dbPath);
        return dbPath === '/roots/current/manifest.db' ? [row('current-live')] : [row('remote-live')];
      },
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    };

    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, deps).json() as {
      terminals: Array<{ id: string; sourceRoot?: { name: string; dbPath: string } }>;
      scope: { roots: number; hiddenDead: number };
    };

    expect(reads).toEqual(['/roots/remote/manifest.db', '/roots/current/manifest.db']);
    expect(body.scope).toMatchObject({ roots: 2, hiddenDead: 0 });
    expect(body.terminals).toContainEqual(expect.objectContaining({ id: 'current-live', sourceRoot: { name: 'current-alias', dbPath: '/roots/current/manifest.db' } }));
    expect(body.terminals).toContainEqual(expect.objectContaining({ id: 'remote-live', sourceRoot: { name: 'remote', dbPath: '/roots/remote/manifest.db' } }));

    const missingCurrent = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      ...deps,
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
    }).json() as { terminals: Array<{ id: string; sourceRoot?: { name: string; dbPath: string } }>; scope: { roots: number } };
    expect(missingCurrent.scope.roots).toBe(2);
    expect(missingCurrent.terminals).toContainEqual(expect.objectContaining({ id: 'current-live', sourceRoot: { name: 'current', dbPath: '/roots/current/manifest.db' } }));
  }, 20_000);

  test('projects canonical CLI provenance for local and manifest rows while preserving controller absence and empty values', async () => {
    const local = spawnWith('local output');
    const row = (id: string, startedAt: number, provenance: Pick<PtyManifestRow, 'terminalOriginCategory' | 'terminalOriginReason' | 'externalToolName' | 'controller'>): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: startedAt, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      ...provenance,
    });
    const localManifest = row(local.id, local.startedAt, { terminalOriginCategory: 'direct-human', terminalOriginReason: 'interactive-cli', controller: '' });
    const external = row('external', 2, { terminalOriginCategory: 'external-tool', terminalOriginReason: 'external-launcher', externalToolName: 'codex', controller: 'self-dev' });
    const elanous = row('elanous-reason-equals-category', 1, { terminalOriginCategory: 'elanous', terminalOriginReason: 'elanous' });
    const absentController = row('controller-absent', 0, { terminalOriginCategory: 'unknown', terminalOriginReason: 'unattributed' });
    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      listPty: () => [local],
      ptyManifestTargets: () => [{ name: 'remote', dbPath: '/roots/remote/manifest.db' }],
      listPtyManifestRows: () => [localManifest],
      listPtyManifestRowsAt: () => [external, elanous, absentController],
      isProcessAlive: () => true,
    }).json() as { terminals: Array<Record<string, unknown> & { id: string }>; scope: Record<string, unknown> };
    const byId = (id: string) => body.terminals.find((terminal) => terminal.id === id)!;

    expect(byId(local.id)).toMatchObject({ terminalOriginCategory: 'direct-human', terminalOriginReason: 'interactive-cli', controller: '', cmd: local.cmd, startedAt: local.startedAt });
    expect(byId(external.id)).toMatchObject({ terminalOriginCategory: 'external-tool', terminalOriginReason: 'external-launcher', externalToolName: 'codex', controller: 'self-dev' });
    expect(byId(elanous.id)).toMatchObject({ terminalOriginCategory: 'elanous', terminalOriginReason: 'elanous', origin: 'unknown' });
    expect(byId(absentController.id)).toMatchObject({ terminalOriginCategory: 'unknown', terminalOriginReason: 'unattributed' });
    expect(byId(absentController.id)).not.toHaveProperty('controller');
    expect(body.scope).toMatchObject({ federated: true, roots: 2 });
  });

  test('matches the CLI JSON provenance projection for the same manifest rows', async () => {
    const rows: PtyManifestRow[] = [
      {
        id: 'cli-external', kind: 'agent', cmd: 'external', ownerPid: 1, ptyPid: 11, instance: 'remote', startedAt: 2, alive: true,
        exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 2, frame: '', frameAt: 0, outputBytesTotal: 0,
        runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
        terminalOriginCategory: 'external-tool', terminalOriginReason: 'external-launcher', externalToolName: 'codex', controller: '',
      },
      {
        id: 'cli-elanous-reason-equals-category', kind: 'agent', cmd: 'elanous', ownerPid: 1, ptyPid: 12, instance: 'remote', startedAt: 1, alive: true,
        exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
        runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
        terminalOriginCategory: 'elanous', terminalOriginReason: 'elanous',
      },
      {
        id: 'cli-unknown', kind: 'agent', cmd: 'unknown', ownerPid: 1, ptyPid: 13, instance: 'remote', startedAt: 1, alive: true,
        exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
        runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      },
    ];
    const api = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [], listPtyManifestRows: () => rows, listPtyManifestRowsAt: () => [], isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<Record<string, unknown> & { id: string }> };
    const cli = JSON.parse(runPtyList({
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'success' }),
      currentManifestDbPath: () => '/roots/current/manifest.db', manifestTargets: () => [{ name: 'current', dbPath: '/roots/current/manifest.db' }],
      listManifestRowsAt: () => rows, isProcessAlive: () => true, log() {},
    }, { json: true }).message) as Array<Record<string, unknown> & { id: string }>;

    for (const row of rows) {
      const fields = ['terminalOriginCategory', 'terminalOriginReason', 'externalToolName'];
      const apiRow = api.terminals.find((candidate) => candidate.id === row.id)!;
      const cliRow = cli.find((candidate) => candidate.id === row.id)!;
      expect(Object.fromEntries(fields.filter((field) => field in apiRow).map((field) => [field, apiRow[field]]))).toEqual(
        Object.fromEntries(fields.filter((field) => field in cliRow).map((field) => [field, cliRow[field]])),
      );
    }
  });

  test('keeps same-ID rows from distinct roots while the current root retains its local row', async () => {
    const local = spawnWith('local', { cmd: 'local' });
    const remote: PtyManifestRow = {
      id: local.id, kind: 'agent', cmd: 'duplicate', ownerPid: 1, ptyPid: 11, instance: 'test', startedAt: local.startedAt + 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      ptyManifestTargets: () => [{ name: 'root-a', dbPath: '/roots/a/manifest.db' }, { name: 'root-b', dbPath: '/roots/b/manifest.db' }],
      ptyManifestDbPath: () => '/roots/a/manifest.db',
      listPtyManifestRowsAt: () => [remote],
      isProcessAlive: () => true,
    }).json() as { terminals: Array<{ id: string; cmd: string; sourceRoot?: { dbPath: string } }> };
    expect(body.terminals.map(({ id, cmd, sourceRoot }) => ({ id, cmd, dbPath: sourceRoot?.dbPath }))).toEqual([
      { id: local.id, cmd: 'duplicate', dbPath: '/roots/a/manifest.db' },
      { id: local.id, cmd: 'duplicate', dbPath: '/roots/b/manifest.db' },
      { id: local.id, cmd: 'local', dbPath: undefined },
    ]);
  });

  // ⛔ 리뷰 must-fix 1R — 비연합 경로가 최종 live-only 필터를 잃으면 종료된 in-process PTY 가 되살아난다.
  test('hides an exited in-process PTY from the non-federated list', async () => {
    const exited = {
      id: 'exited-local', cmd: 'gone', workdir: '', startedAt: 5, exitCode: 0,
      snapshot: () => '', isAlive: () => false,
    } as unknown as PtyHandle;
    const body = await handleTerminalsList(bareReq(), opts, {
      ptyManifestTargets: () => [],
      listPty: () => [exited],
      listPtyManifestRows: () => [],
      listPtyManifestRowsAt: () => [],
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string }>; scope: { federated: boolean } };
    expect(body.terminals).toEqual([]);
    expect(body.scope.federated).toBe(false);
  });

  // ⛔ 리뷰 must-fix 2R·3R — 연합 집계가 «정리 후» 행만 세면, 현재 뿌리에서 방금 reap 된 행이
  //   hiddenDead 에서 조용히 빠진다. 수리 전 이 테스트는 0 을 받는다.
  test('counts current-root rows removed by cleanup in the federated hidden total', async () => {
    const row = (id: string): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 41, ptyPid: 42, instance: 'current', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const before = [row('reaped-by-cleanup'), row('live-current')];
    let current = before;
    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      ptyManifestTargets: () => [{ name: 'current', dbPath: '/roots/current/manifest.db' }],
      ptyManifestDbPath: () => '/roots/current/manifest.db',
      listPty: () => [],
      listPtyManifestRows: () => current,
      listPtyManifestRowsAt: () => current,
      isProcessAlive: () => true,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => { current = current.filter((candidate) => candidate.id !== 'reaped-by-cleanup'); return 1; },
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string }>; scope: { roots: number; federated: boolean; hiddenDead: number; domain: string } };
    expect(body.terminals.map((terminal) => terminal.id)).toEqual(['live-current']);
    expect(body.scope).toEqual({
      roots: 1,
      federated: true,
      hiddenDead: 1,
      domain: '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.',
    });
    // ⭐ 「보인 것 + 감춘 것」이 정리 «전» 전수와 같아야 한다 — 이것이 두 경로가 같은 자를 쓴다는 증거다.
    expect(body.terminals.length + body.scope.hiddenDead).toBe(before.length);
  });

  // ⭐ 다른 뿌리는 정리 대상이 아니므로 «읽은 그대로» 센다 — 현재 뿌리 규칙이 남의 뿌리로 새면 안 된다.
  test('counts non-current roots from their own rows without the pre-cleanup snapshot', async () => {
    const row = (id: string, ptyPid: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid: 1, ptyPid, instance: 'other', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    const body = await handleTerminalsList(bareReq('http://localhost/v1/terminals?all=true'), opts, {
      ptyManifestTargets: () => [{ name: 'other', dbPath: '/roots/other/manifest.db' }],
      ptyManifestDbPath: () => '/roots/current/manifest.db',
      listPty: () => [],
      listPtyManifestRows: () => [row('current-root-row', 51)],
      listPtyManifestRowsAt: (dbPath) => dbPath === '/roots/current/manifest.db'
        ? [row('current-root-row', 51)]
        : [row('other-live', 52), row('other-dead', 53)],
      isProcessAlive: (pid) => pid !== 53,
      reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0,
      reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0,
    }).json() as { terminals: Array<{ id: string }>; scope: { hiddenDead: number } };
    expect(body.terminals.map((terminal) => terminal.id)).toEqual(['other-live', 'current-root-row']);
    // 현재 뿌리는 보충되지만, 다른 뿌리의 dead row 는 그 뿌리의 읽기 결과만으로 센다.
    expect(body.scope.hiddenDead).toBe(1);
  });

  test('merges local PTY lineage metadata from its matching manifest row', async () => {
    const previousParent = process.env.ELANOUS_PARENT_PTY_ID;
    const previousRunId = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_PARENT_PTY_ID = 'parent-pty';
    process.env.ELANOUS_RUN_ID = 'run-local-lineage';
    try {
      const workdir = join(
        mkdtempSync(join(tmpdir(), 'elanous-terminal-lineage-')),
        'source',
        'elan',
        'monad-agent.worktrees',
        'fresh',
      );
      mkdirSync(workdir, { recursive: true });
      const handle = spawnWith('child output', {
        cmd: 'child',
        workdir,
      });
      upsertPtyManifest({
        id: handle.id,
        kind: 'agent',
        cmd: handle.cmd,
        workdir: handle.workdir,
        startedAt: handle.startedAt,
        now: Date.now(),
      });
      const res = handleTerminalsList(bareReq(), opts);
      const body = await res.json() as {
        terminals: Array<{ id: string; treeName: string; worktreeName: string; parentPtyId: string; parentPid: number; parentKind: string; runId: string }>;
      };
      expect(body.terminals).toHaveLength(1);
      expect(body.terminals[0]).toMatchObject({
        id: handle.id,
        treeName: 'elan',
        worktreeName: 'fresh',
        parentPtyId: 'parent-pty',
        parentKind: 'pty',
        runId: 'run-local-lineage',
      });
      expect(body.terminals[0]!.parentPid).toBe(process.ppid);
    } finally {
      if (previousParent === undefined) delete process.env.ELANOUS_PARENT_PTY_ID;
      else process.env.ELANOUS_PARENT_PTY_ID = previousParent;
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
    }
  });

  test('orders by startedAt descending (newest first)', async () => {
    const a = spawnWith('A', { cmd: 'first' });
    // Force a measurable Date.now() difference
    await new Promise((r) => setTimeout(r, 5));
    const b = spawnWith('B', { cmd: 'second' });
    const res = handleTerminalsList(bareReq(), opts);
    const body = (await res.json()) as { terminals: Array<{ id: string }> };
    expect(body.terminals.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  test('omits workdir field when undefined (clean JSON)', async () => {
    spawnWith('x', { cmd: 'noworkdir' });
    const res = handleTerminalsList(bareReq(), opts);
    const body = (await res.json()) as { terminals: Array<Record<string, unknown>> };
    expect(body.terminals[0]).not.toHaveProperty('workdir');
  });
});

describe('handleTerminalScrollback', () => {
  test('default ?lines omitted → returns last 50 lines', async () => {
    const h = spawnWith(
      Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n'),
    );
    const res = handleTerminalScrollback(bareReq(), opts, h.id, bareUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      lines: number;
      totalLines: number;
      scrollback: string;
    };
    expect(body.id).toBe(h.id);
    expect(body.totalLines).toBe(100);
    expect(body.lines).toBe(50);
    expect(body.scrollback.startsWith('line-51\n')).toBe(true);
    expect(body.scrollback.endsWith('line-100')).toBe(true);
  });

  test('?lines=N — explicit count', async () => {
    const h = spawnWith(
      Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n'),
    );
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=5'),
    );
    const body = (await res.json()) as {
      lines: number;
      scrollback: string;
    };
    expect(body.lines).toBe(5);
    expect(body.scrollback).toBe('L16\nL17\nL18\nL19\nL20');
  });

  test('?lines exceeds total → returns full buffer (no padding)', async () => {
    const h = spawnWith('only-one-line');
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=999'),
    );
    const body = (await res.json()) as { lines: number; scrollback: string };
    expect(body.lines).toBe(1);
    expect(body.scrollback).toBe('only-one-line');
  });

  test('?lines=invalid → 400 invalid-lines', async () => {
    const h = spawnWith('hi');
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=-3'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-lines');
  });

  test('?lines=NaN → 400', async () => {
    const h = spawnWith('hi');
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=foo'),
    );
    expect(res.status).toBe(400);
  });

  test('distinguishes no selector, an unknown root, and a missing PTY in the selected root', async () => {
    const noSelector = handleTerminalScrollback(bareReq(), opts, 'no-such-pty', bareUrl());
    expect(noSelector.status).toBe(404);
    expect(await noSelector.json()).toEqual({ error: 'not-found', id: 'no-such-pty' });

    const unknownRoot = handleTerminalScrollback(bareReq(), opts, 'no-such-pty', bareUrl('?sourceRoot=missing-root'));
    expect(unknownRoot.status).toBe(404);
    expect(await unknownRoot.json()).toEqual({ error: 'source-root-not-found', id: 'no-such-pty', sourceRoot: 'missing-root' });

    const currentRoot = ptyManifestDbPath();
    const missingSelected = handleTerminalScrollback(bareReq(), opts, 'no-such-pty', bareUrl(`?sourceRoot=${encodeURIComponent(currentRoot)}`));
    expect(missingSelected.status).toBe(404);
    expect(await missingSelected.json()).toEqual(expect.objectContaining({
      error: 'pty-not-found-in-source-root', id: 'no-such-pty', sourceRoot: currentRoot,
    }));
  });

  test('empty id → 400 missing-id', async () => {
    const res = handleTerminalScrollback(bareReq(), opts, '', bareUrl());
    expect(res.status).toBe(400);
  });

  test('caps at MAX_LINES (5000) when ?lines is huge', async () => {
    const h = spawnWith(
      Array.from({ length: 200 }, (_, i) => `L${i}`).join('\n'),
    );
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=999999'),
    );
    const body = (await res.json()) as { lines: number };
    // Buffer only has 200 lines · cap above doesn't kick in here,
    // but should not throw or pad.
    expect(body.lines).toBe(200);
  });

  // P4.2 OQ-3 follow-up — ANSI strip option (#1976).
  test('?ansi=strip removes escape sequences', async () => {
    const h = spawnWith('\x1b[31mred text\x1b[0m\nplain line\n');
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=10&ansi=strip'),
    );
    const body = (await res.json()) as {
      scrollback: string;
      ansiStripped?: boolean;
    };
    expect(body.scrollback).toContain('red text');
    expect(body.scrollback).toContain('plain line');
    expect(body.scrollback).not.toContain('\x1b');
    expect(body.ansiStripped).toBe(true);
  });

  test('?ansi=strip omitted → preserves raw output (default keep)', async () => {
    const h = spawnWith('\x1b[31mred\x1b[0m\n');
    const res = handleTerminalScrollback(bareReq(), opts, h.id, bareUrl('?lines=5'));
    const body = (await res.json()) as {
      scrollback: string;
      ansiStripped?: boolean;
    };
    expect(body.scrollback).toContain('\x1b[31m');
    expect(body.ansiStripped).toBeUndefined();
  });

  test('?ansi=keep → also preserves raw (only strip is special)', async () => {
    const h = spawnWith('\x1b[1mbold\x1b[0m');
    const res = handleTerminalScrollback(
      bareReq(),
      opts,
      h.id,
      bareUrl('?lines=5&ansi=keep'),
    );
    const body = (await res.json()) as { scrollback: string; ansiStripped?: boolean };
    expect(body.scrollback).toContain('\x1b[1m');
    expect(body.ansiStripped).toBeUndefined();
  });
});

describe('terminal control endpoint', () => {
  const controlReq = (body: unknown, token?: string) => new Request('http://localhost/v1/terminals/pty-control/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  test('parses only the terminal control path', () => {
    expect(parseTerminalControlPath('/v1/terminals/abc/control')).toBe('abc');
    expect(parseTerminalControlPath('/v1/terminals/abc/input-text')).toBeNull();
  });

  test('forwards takeover result fields without trimming them', async () => {
    const calls: Array<[string, string, unknown, { timeoutMs?: number } | undefined]> = [];
    const response = await handleTerminalControl(controlReq({ action: 'takeover' }), opts, 'pty-control', {
      async requestRemotePtyControl(id, action, payload, options) {
        calls.push([id, action, payload, options]);
        return { status: 'denied', reason: 'transition-policy', from: 'read', to: 'read', policy: 'locked' };
      },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ id: 'pty-control', action: 'takeover', status: 'denied', reason: 'transition-policy', from: 'read', to: 'read', policy: 'locked' });
    expect(calls).toEqual([['pty-control', 'takeover', undefined, { timeoutMs: 2_000 }]]);
  });

  test('forwards successful release control', async () => {
    const response = await handleTerminalControl(controlReq({ action: 'release' }), opts, 'pty-control', {
      async requestRemotePtyControl() { return { status: 'success', from: 'write', to: 'read', policy: 'open' }; },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'pty-control', action: 'release', status: 'success', from: 'write', to: 'read', policy: 'open' });
  });

  test('forwards input text without returning its characters', async () => {
    const calls: Array<[string, string, unknown, { timeoutMs?: number } | undefined]> = [];
    const response = await handleTerminalControl(controlReq({ action: 'input-text', chars: 'hi\r' }), opts, 'pty-control', {
      async requestRemotePtyControl(id, action, payload, options) {
        calls.push([id, action, payload, options]);
        return { status: 'success' };
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ id: 'pty-control', action: 'input-text', status: 'success' });
    expect(JSON.stringify(body)).not.toContain('hi');
    expect(calls).toEqual([['pty-control', 'input-text', { chars: 'hi\r' }, { timeoutMs: 2_000 }]]);
  });

  test('logs input dispatch metadata without input characters', async () => {
    const level = debug.level();
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      logs.push([category, event, data as Record<string, unknown>]);
    });
    debug.setLevel('diag');
    try {
      await handleTerminalControl(controlReq({ action: 'input-text', chars: 'secret\r' }), opts, 'pty-control', {
        async requestRemotePtyControl() { return { status: 'denied', reason: 'write-arbiter' }; },
      });
    } finally {
      debug.setLevel(level);
      log.mockRestore();
    }
    expect(logs).toEqual([['nexus.terminals.control', 'dispatch', {
      id: 'pty-control', action: 'input-text', status: 'denied', bytes: 7,
    }]]);
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  test('forwards input key characters through the same remote-control path', async () => {
    const calls: Array<[string, string, unknown, { timeoutMs?: number } | undefined]> = [];
    const response = await handleTerminalControl(controlReq({ action: 'input-key', chars: '\u001b[A' }), opts, 'pty-control', {
      async requestRemotePtyControl(id, action, payload, options) {
        calls.push([id, action, payload, options]);
        return { status: 'success' };
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'pty-control', action: 'input-key', status: 'success' });
    expect(calls).toEqual([['pty-control', 'input-key', { chars: '\u001b[A' }, { timeoutMs: 2_000 }]]);
  });

  test('HTTP mouse coordinates cross the same owner IPC and invalid coordinates stop before dispatch', async () => {
    const calls: unknown[] = [];
    const owner = { async requestRemotePtyControl(id: string, action: string, payload: unknown) {
      calls.push([id, action, payload]);
      return { status: 'denied' as const, reason: 'PTY mouse mode is off' };
    } };
    const response = await handleTerminalControl(controlReq({ action: 'input-mouse', x: 10, y: 5, kind: 'click' }), opts, 'pty-control', owner);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ action: 'input-mouse', status: 'denied', reason: 'PTY mouse mode is off' });
    expect(calls).toEqual([['pty-control', 'input-mouse', { x: 10, y: 5, kind: 'click' }]]);
    const invalid = await handleTerminalControl(controlReq({ action: 'input-mouse', x: 0, y: 5, kind: 'click' }), opts, 'pty-control', owner);
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test('forwards an ANSI snapshot payload and preserves its screen result', async () => {
    const calls: Array<[string, string, unknown, { timeoutMs?: number } | undefined]> = [];
    const response = await handleTerminalControl(controlReq({ action: 'snapshot', ansi: true }), opts, 'pty-control', {
      async requestRemotePtyControl(id, action, payload, options) {
        calls.push([id, action, payload, options]);
        return { status: 'success', screen: 'SCREEN' };
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'pty-control', action: 'snapshot', status: 'success', screen: 'SCREEN' });
    expect(calls).toEqual([['pty-control', 'snapshot', { ansi: true }, { timeoutMs: 2_000 }]]);
  });

  test('rejects invalid input payload and invalid JSON before IPC', async () => {
    let calls = 0;
    const deps = { async requestRemotePtyControl() { calls += 1; throw new Error('must not call IPC'); } };
    const inputResponse = await handleTerminalControl(controlReq({ action: 'input-key', chars: '' }), opts, 'pty-control', deps);
    expect(inputResponse.status).toBe(400);
    await expect(inputResponse.json()).resolves.toEqual({ error: 'invalid-payload', reason: 'chars must be a non-empty string' });
    const invalidResponse = await handleTerminalControl(new Request('http://localhost/v1/terminals/pty-control/control', { method: 'POST', body: '{' }), opts, 'pty-control', deps);
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'invalid-json', reason: 'JSON body required' });
    expect(calls).toBe(0);
  });

  test('maps arbiter denial and authentication rejection before IPC', async () => {
    const denied = await handleTerminalControl(controlReq({ action: 'input-text', chars: 'x' }), opts, 'pty-control', {
      async requestRemotePtyControl() { return { status: 'denied', reason: 'write-arbiter' }; },
    });
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toEqual({ id: 'pty-control', action: 'input-text', status: 'denied', reason: 'write-arbiter' });

    let calls = 0;
    const secured: MetaApiOpts = { bearerToken: 'secret' };
    const unauthorized = await handleTerminalControl(controlReq({ action: 'input-text', chars: 'x' }), secured, 'pty-control', {
      async requestRemotePtyControl() { calls += 1; return { status: 'success' }; },
    });
    expect(unauthorized.status).toBe(401);
    expect(calls).toBe(0);
  });

  test('passes the same auth gate and maps missing and timeout owners', async () => {
    const missing = await handleTerminalControl(controlReq({ action: 'release' }), opts, 'pty-control', { async requestRemotePtyControl() { return { status: 'unknown-pty' }; } });
    const timeout = await handleTerminalControl(controlReq({ action: 'release' }), opts, 'pty-control', { async requestRemotePtyControl() { return { status: 'owner-unreachable' }; } });
    expect(missing.status).toBe(404);
    expect(timeout.status).toBe(504);
  });
});

describe('terminal prune endpoint', () => {
  const pruneReq = (query = '', token?: string) => new Request(`http://localhost/v1/terminals/prune${query}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });

  test('limits cleanup to the current root unless cleanupScope explicitly expands it', async () => {
    const rows = new Map([['/local.db', ['local-dead']], ['/prod.db', ['prod-dead']], ['/test.db', ['test-dead']]]);
    const calls: string[] = [];
    const deps = {
      ptyManifestDbPath: () => '/local.db',
      ptyManifestTargets: ({ includeTest }: { includeTest?: boolean }) => includeTest ? [{ name: 'prod', dbPath: '/prod.db' }, { name: 'test', dbPath: '/test.db' }] : [{ name: 'prod', dbPath: '/prod.db' }],
      realpath: (path: string) => path,
      isProcessAlive: () => true,
      reapDeadPtyManifestAt(dbPath: string) {
        calls.push(dbPath);
        const removed = rows.get(dbPath)?.length ?? 0;
        rows.set(dbPath, []);
        return { dbPath, status: 'ok' as const, missingColumns: [], removed, preserved: 0, decisions: [] };
      },
    };
    expect(parseTerminalsPrunePath('/v1/terminals/prune')).toBe(true);
    expect(parseTerminalsPrunePath('/v1/terminals/pty/prune')).toBe(false);

    const defaultCleanup = await handleTerminalsPrune(pruneReq('?all=true&includeTest=true'), opts, deps).json();
    expect(calls).toEqual(['/local.db']);
    expect(rows.get('/prod.db')).toEqual(['prod-dead']);
    expect(defaultCleanup).toEqual({ reaped: 1, retained: 0, retainedReasons: {}, unreadableRoots: 0, scope: { roots: 1, federated: false, mode: 'current', rootNames: ['current'] } });

    rows.set('/local.db', ['local-dead']);
    calls.length = 0;
    const expandedCleanup = await handleTerminalsPrune(pruneReq('?cleanupScope=all&cleanupIncludeTest=true'), opts, deps).json();
    expect(calls).toEqual(['/prod.db', '/test.db', '/local.db']);
    expect(rows.get('/prod.db')).toEqual([]);
    expect(rows.get('/test.db')).toEqual([]);
    expect(expandedCleanup).toEqual({ reaped: 3, retained: 0, retainedReasons: {}, unreadableRoots: 0, scope: { roots: 3, federated: true, mode: 'all', rootNames: ['prod', 'test', 'current'] } });
  });

  test('rejects an invalid cleanupScope before deleting any root', async () => {
    const calls: string[] = [];
    const response = handleTerminalsPrune(pruneReq('?cleanupScope=unknown&all=true'), opts, {
      ptyManifestDbPath: () => '/local.db', ptyManifestTargets: () => [{ name: 'other', dbPath: '/other.db' }],
      reapDeadPtyManifestAt(dbPath) { calls.push(dbPath); throw new Error('must not delete'); }, isProcessAlive: () => false,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-cleanup-scope' });
    expect(calls).toEqual([]);
  });

  test('deduplicates realpath aliases before pruning and aggregating the selected scope', async () => {
    const calls: string[] = [];
    const response = await handleTerminalsPrune(pruneReq('?cleanupScope=all'), opts, {
      ptyManifestDbPath: () => '/current-link.db',
      ptyManifestTargets: () => [
        { name: 'canonical', dbPath: '/canonical.db' },
        { name: 'alias', dbPath: '/canonical-link.db' },
        { name: 'other', dbPath: '/other.db' },
      ],
      realpath: (path) => path === '/canonical-link.db' || path === '/current-link.db' ? '/canonical.db' : path,
      isProcessAlive: () => true,
      reapDeadPtyManifestAt(dbPath) {
        calls.push(dbPath);
        return {
          dbPath, status: 'ok' as const, missingColumns: [], removed: 1, preserved: 1,
          decisions: [{ id: `${dbPath}-alive`, livenessPid: 1, livenessSource: 'owner-pid', action: 'preserve', reason: 'process-alive' }],
        };
      },
    });
    expect(calls).toEqual(['/canonical.db', '/other.db']);
    await expect(response.json()).resolves.toEqual({
      reaped: 2,
      retained: 2,
      retainedReasons: { 'process-alive': 2 },
      unreadableRoots: 0,
      scope: { roots: 2, federated: true, mode: 'all', rootNames: ['canonical', 'other'] },
    });
  });

  // Observed 7,662.75ms under load; allow 12,337.25ms of finite headroom with a 20,000ms per-test budget.
  test('reconciles the same scope hidden-dead count after pruning only dead owners', async () => {
    const manifestRow = (id: string, ownerPid: number): PtyManifestRow => ({
      id, kind: 'agent', cmd: id, ownerPid, ptyPid: ownerPid, instance: 'local', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: 'explicit', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    });
    let rows = [manifestRow('dead', 10), manifestRow('alive', 11)];
    const listDeps = {
      ptyManifestTargets: () => [], ptyManifestDbPath: () => '/local.db', realpath: (path: string) => path,
      listPtyManifestRows: () => rows, listPtyManifestRowsAt: () => [], listPty: () => [], isProcessAlive: (pid: number) => pid === 11,
      reapDeadPtyManifest: () => 0, purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0, reapOrphanedOwnedPtyManifest: () => 0,
    };
    const before = await handleTerminalsList(bareReq(), opts, listDeps).json() as { scope: { hiddenDead: number } };
    const prune = await handleTerminalsPrune(pruneReq(), opts, {
      ptyManifestTargets: listDeps.ptyManifestTargets, ptyManifestDbPath: listDeps.ptyManifestDbPath, realpath: listDeps.realpath, isProcessAlive: listDeps.isProcessAlive,
      reapDeadPtyManifestAt(dbPath) {
        const decisions = rows.map((row) => row.ownerPid === 10
          ? { id: row.id, livenessPid: row.ownerPid, livenessSource: 'owner-pid' as const, action: 'remove' as const, reason: 'process-dead' as const }
          : { id: row.id, livenessPid: row.ownerPid, livenessSource: 'owner-pid' as const, action: 'preserve' as const, reason: 'process-alive' as const });
        rows = rows.filter((row) => row.ownerPid !== 10);
        return { dbPath, status: 'ok' as const, missingColumns: [], removed: 1, preserved: 1, decisions };
      },
    }).json() as { reaped: number; retained: number; retainedReasons: Record<string, number>; unreadableRoots: number; scope: { roots: number; federated: boolean; mode: string; rootNames: string[] } };
    const after = await handleTerminalsList(bareReq(), opts, listDeps).json() as { scope: { hiddenDead: number } };
    expect(prune).toEqual({ reaped: 1, retained: 1, retainedReasons: { 'process-alive': 1 }, unreadableRoots: 0, scope: { roots: 1, federated: false, mode: 'current', rootNames: ['current'] } });
    expect(after.scope.hiddenDead).toBe(before.scope.hiddenDead - prune.reaped);
  }, 20_000);

  test('retains write failures and reports unreadable roots separately', async () => {
    const response = await handleTerminalsPrune(pruneReq('?cleanupScope=all'), opts, {
      ptyManifestDbPath: () => '/local.db',
      ptyManifestTargets: () => [{ name: 'unreadable', dbPath: '/unreadable.db' }],
      realpath: (path) => path,
      isProcessAlive: () => true,
      reapDeadPtyManifestAt(dbPath) {
        return dbPath === '/unreadable.db'
          ? { dbPath, status: 'unreadable', missingColumns: [], removed: 0, preserved: 0, decisions: [] }
          : { dbPath, status: 'write-failed', missingColumns: [], removed: 0, preserved: 1, decisions: [{ id: 'dead', livenessPid: 5, livenessSource: 'owner-pid', action: 'preserve', reason: 'write-failed', plannedAction: 'remove' }] };
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reaped: 0, retained: 1, retainedReasons: { 'write-failed': 1 }, unreadableRoots: 1, scope: { roots: 2, federated: true, mode: 'all', rootNames: ['unreadable', 'current'] } });
  });

  test('uses the rename auth gate', async () => {
    expect(handleTerminalsPrune(pruneReq(), { bearerToken: 'secret' }).status).toBe(401);
  });

  test('routes only an authenticated prune POST through the HTTP server', async () => {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    state.bus = bus;
    const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'prune-token' }, startPort: 55000 + Math.floor(Math.random() * 1000), portRange: 10 });
    try {
      const missingAuth = await fetch(`${server.url}/v1/terminals/prune`, { method: 'POST' });
      expect(missingAuth.status).toBe(401);
      await expect(missingAuth.json()).resolves.toEqual({ error: 'unauthorized' });

      const response = await fetch(`${server.url}/v1/terminals/prune`, { method: 'POST', headers: { authorization: 'Bearer prune-token' } });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ reaped: expect.any(Number), retained: expect.any(Number), unreadableRoots: expect.any(Number), scope: { roots: expect.any(Number), federated: false } });

      const getResponse = await fetch(`${server.url}/v1/terminals/prune`, { headers: { authorization: 'Bearer prune-token' } });
      expect(getResponse.status).toBe(404);
    } finally { server.stop(); }
  });
});

describe('terminal rename endpoint', () => {
  const renameReq = (body: unknown, token?: string) => new Request('http://localhost/v1/terminals/pty-rename/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  test('parses and forwards a name through the rename IPC action', async () => {
    const calls: Array<[string, string, { nickname: string }, number]> = [];
    expect(parseTerminalRenamePath('/v1/terminals/abc/rename')).toBe('abc');
    expect(parseTerminalRenamePath('/v1/terminals/abc/control')).toBeNull();
    const response = await handleTerminalRename(renameReq({ name: 'build shell' }), opts, 'pty-rename', {
      async requestRemotePtyControl(id, action, payload, timeout) {
        calls.push([id, action, payload, timeout]);
        return { status: 'success' };
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'pty-rename', name: 'build shell', status: 'success' });
    expect(calls).toEqual([['pty-rename', 'rename', { nickname: 'build shell' }, 2_000]]);
  });

  test('rejects invalid JSON and non-string names before IPC', async () => {
    const deps = { async requestRemotePtyControl() { throw new Error('must not call IPC'); } };
    const invalidJson = await handleTerminalRename(new Request('http://localhost/v1/terminals/pty-rename/rename', { method: 'POST', body: '{' }), opts, 'pty-rename', deps);
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({ error: 'invalid-json', reason: 'JSON body required' });
    const invalidName = await handleTerminalRename(renameReq({ name: 12 }), opts, 'pty-rename', deps);
    expect(invalidName.status).toBe(400);
    await expect(invalidName.json()).resolves.toEqual({ error: 'invalid-name', reason: 'name must be a string' });
  });

  test('uses control auth and maps missing, unreachable, and denied owners', async () => {
    const secured: MetaApiOpts = { bearerToken: 'secret' };
    expect((await handleTerminalRename(renameReq({ name: 'x' }), secured, 'pty-rename')).status).toBe(401);
    for (const [outcome, expected] of [
      [{ status: 'unknown-pty' }, 404],
      [{ status: 'owner-unreachable' }, 504],
      [{ status: 'denied', reason: 'rename-policy' }, 409],
    ] as const) {
      const response = await handleTerminalRename(renameReq({ name: 'x' }), opts, 'pty-rename', {
        async requestRemotePtyControl() { return outcome; },
      });
      expect(response.status).toBe(expected);
    }
  });

  test('routes a rename POST through the HTTP server to the rename handler', async () => {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    state.bus = bus;
    const server = startNexusHttpServer({
      state,
      registry: new TabRegistry(state),
      eventBus: bus,
      metaApi: { noAuth: true },
      startPort: 54000 + Math.floor(Math.random() * 1000),
      portRange: 10,
    });
    try {
      const response = await fetch(`${server.url}/v1/terminals/unregistered-pty/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new name' }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ id: 'unregistered-pty', name: 'new name', status: 'unknown-pty' });
    } finally {
      server.stop();
    }
  });
});

describe('terminal terminate endpoint', () => {
  const terminateReq = (token?: string) => new Request('http://localhost/v1/terminals/pty-terminate/terminate', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });

  test('parses and forwards termination through the PTY-control action', async () => {
    const calls: Array<[string, string, number]> = [];
    expect(parseTerminalTerminatePath('/v1/terminals/abc/terminate')).toBe('abc');
    expect(parseTerminalTerminatePath('/v1/terminals/abc/rename')).toBeNull();
    const response = await handleTerminalTerminate(terminateReq(), opts, 'pty-terminate', {
      async requestRemotePtyControl(id, action, timeout) {
        calls.push([id, action, timeout]);
        return { status: 'success' };
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'pty-terminate', action: 'terminate', status: 'success' });
    expect(calls).toEqual([['pty-terminate', 'terminate', 2_000]]);
  });

  test('uses the shared auth gate and distinguishes missing target, termination failure, and legacy owner rejection', async () => {
    const secured: MetaApiOpts = { bearerToken: 'secret' };
    expect((await handleTerminalTerminate(terminateReq(), secured, 'pty-terminate')).status).toBe(401);
    for (const [outcome, expected, body] of [
      [{ status: 'unknown-pty' }, 404, { id: 'pty-terminate', action: 'terminate', status: 'unknown-pty' }],
      [{ status: 'failed', reason: 'termination-failed' }, 502, { id: 'pty-terminate', action: 'terminate', status: 'failed', reason: 'termination-failed' }],
      [{ status: 'denied', reason: 'unsupported-action' }, 409, { id: 'pty-terminate', action: 'terminate', status: 'denied', reason: 'unsupported-action' }],
    ] as const) {
      const response = await handleTerminalTerminate(terminateReq(), opts, 'pty-terminate', {
        async requestRemotePtyControl() { return outcome; },
      });
      expect(response.status).toBe(expected);
      await expect(response.json()).resolves.toEqual(body);
    }
  });

  test('routes termination through HTTP to the owning PTY and removes it from the terminal list', async () => {
    const terminal = spawnWith('owned terminal');
    upsertPtyManifest({
      id: terminal.id,
      kind: terminal.kind,
      cmd: terminal.cmd,
      workdir: terminal.workdir,
      startedAt: terminal.startedAt,
      now: Date.now(),
    });
    mock.states[0]!.terminateOnKill = true;
    const stopPtyControlPoller = startPtyControlPoller();
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    state.bus = bus;
    const server = startNexusHttpServer({
      state,
      registry: new TabRegistry(state),
      eventBus: bus,
      metaApi: { noAuth: true },
      startPort: 54000 + Math.floor(Math.random() * 1000),
      portRange: 10,
    });
    try {
      const response = await fetch(`${server.url}/v1/terminals/${encodeURIComponent(terminal.id)}/terminate`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ id: terminal.id, action: 'terminate', status: 'success' });
      const list = await fetch(`${server.url}/v1/terminals`);
      const body = await list.json() as { terminals: Array<{ id: string; alive: boolean }> };
      expect(body.terminals.find((entry) => entry.id === terminal.id)).toBeUndefined();
    } finally {
      server.stop();
      stopPtyControlPoller();
    }
  });
});

describe('parseFramePath', () => {
  test('matches /v1/terminals/:id/frame', () => {
    expect(parseFramePath('/v1/terminals/abc/frame')).toBe('abc');
    expect(parseFramePath('/v1/terminals/tui%3A1234/frame')).toBe('tui:1234');
  });

  test('rejects non-matching paths', () => {
    expect(parseFramePath('/v1/terminals/abc/scrollback')).toBeNull();
    expect(parseFramePath('/v1/terminals/abc')).toBeNull();
    expect(parseFramePath('/v1/terminals/abc/frame/')).toBeNull();
    expect(parseFramePath('/v2/terminals/abc/frame')).toBeNull();
  });
});

describe('handleTerminalFrame', () => {
  // Frames only exist in the shared manifest (a surface self-reports the
  // renderScreen() grid), NOT in the in-process registry. Drive the
  // manifest directly to exercise the endpoint (isolated ELANOUS_STATE_DIR).
  function frameReq(): Request {
    return new Request('http://localhost/v1/terminals/x/frame');
  }
  function frameUrl(query = ''): URL {
    return new URL(`http://localhost/v1/terminals/x/frame${query}`);
  }

  test('returns the self-reported rendered frame without requesting a live snapshot', async () => {
    const id = `tui:${1000 + Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    const screen = '┌ elanous ┐\n│ /help  slash picker │\n└───────┘';
    updatePtyManifestFrame(id, () => screen, now);
    let requests = 0;
    const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl(), {
      async requestRemotePtyControl() { requests++; return { status: 'success', screen: 'must not be used' }; },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; frame: string; frameAt: number; frameSource: string; kind: string; remote: boolean };
    expect(body.id).toBe(id);
    expect(body.frame).toBe(screen);
    expect(body.frameAt).toBe(now);
    expect(body.frameSource).toBe('stored');
    expect(body.kind).toBe('tui');
    expect(body.remote).toBe(true);
    expect(requests).toBe(0);
  });

  test('requests the owner snapshot when the stored frame is absent and returns its live screen', async () => {
    const id = `tui:${2000 + Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    const calls: Array<[string, string, number]> = [];
    const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl(), {
      async requestRemotePtyControl(requestId, action, timeoutMs) {
        calls.push([requestId, action, timeoutMs]);
        return { status: 'success', screen: 'live rendered screen', source: 'live' };
      },
    });
    const body = (await res.json()) as { frame: string; frameAt: number; frameSource: string };
    expect(body.frame).toBe('live rendered screen');
    expect(body.frameAt).toBeGreaterThan(0);
    expect(body.frameSource).toBe('live');
    expect(calls).toEqual([[id, 'snapshot', 2_000]]);
  });

  test('resolves a source-root identifier to the selected manifest DB before requesting its duplicate PTY owner', async () => {
    const id = 'duplicate-pty';
    const sourceRoot = 'owner-b';
    const selectedManifestDbPath = '/roots/owner-b/pty/manifest.db';
    const selected: PtyManifestRow = {
      id, kind: 'tui', cmd: 'owner-b', ownerPid: 202, ptyPid: 203, instance: 'owner-b', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const local: PtyManifestRow = { ...selected, cmd: 'local-owner-a', ownerPid: 101, ptyPid: 102, instance: 'owner-a' };
    const calls: Array<{ id: string; options: { manifestDbPath?: string } | undefined }> = [];
    const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl(`?sourceRoot=${encodeURIComponent(sourceRoot)}`), {
      getPtyManifest: () => local,
      detailTargets: [{ name: sourceRoot, dbPath: selectedManifestDbPath }],
      rowsAt: (dbPath: string) => dbPath === selectedManifestDbPath ? [selected] : [],
      async requestRemotePtyControl(requestId, _action, _timeoutMs, options) {
        calls.push({ id: requestId, options });
        return { status: 'success', screen: 'owner-b live frame' };
      },
    });
    const body = (await res.json()) as { frame: string; frameSource: string; instance: string };
    expect(body).toEqual(expect.objectContaining({ frame: 'owner-b live frame', frameSource: 'live', instance: 'owner-b' }));
    expect(calls).toEqual([{ id, options: { manifestDbPath: selectedManifestDbPath } }]);
  });

  test('uses the resolved remote manifest DB to request the selected duplicate owner and return its live frame', async () => {
    const id = 'duplicate-pty-remote-owner';
    const sourceRoot = 'owner-b';
    const remoteDir = mkdtempSync(join(tmpdir(), 'elanous-remote-owner-'));
    const remoteManifestDbPath = join(remoteDir, 'pty', 'manifest.db');
    mkdirSync(join(remoteDir, 'pty'), { recursive: true });
    const remoteDb = new Database(remoteManifestDbPath);
    remoteDb.run('CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, alive INTEGER NOT NULL)');
    remoteDb.run('INSERT INTO pty_manifest (id, owner_pid, alive) VALUES (?, ?, ?)', [id, 202, 1]);
    const selected: PtyManifestRow = {
      id, kind: 'tui', cmd: 'owner-b', ownerPid: 202, ptyPid: 203, instance: 'owner-b', startedAt: 1, alive: true,
      exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0, outputBytesTotal: 0,
      runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    try {
      const response = handleTerminalFrame(frameReq(), opts, id, frameUrl(`?sourceRoot=${sourceRoot}`), {
        getPtyManifest: () => null,
        detailTargets: [{ name: sourceRoot, dbPath: remoteManifestDbPath }],
        rowsAt: (dbPath: string) => dbPath === remoteManifestDbPath ? [selected] : [],
        requestRemotePtyControl,
      });
      await Bun.sleep(60);
      const request = remoteDb.query('SELECT request_id, owner_pid FROM pty_control_requests WHERE pty_id=?').get(id) as { request_id: string; owner_pid: number } | null;
      expect(request).toEqual(expect.objectContaining({ owner_pid: 202 }));
      remoteDb.run("UPDATE pty_control_requests SET status='success', result_json=? WHERE request_id=?", [JSON.stringify({ status: 'success', screen: 'owner-b live frame', source: 'live' }), request!.request_id]);
      const body = await (await response).json() as { frame: string; frameSource: string; instance: string };
      expect(body).toEqual(expect.objectContaining({ frame: 'owner-b live frame', frameSource: 'live', instance: 'owner-b' }));
    } finally {
      remoteDb.close();
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  test('returns an unavailable frame value for unreachable, bounded-render, and empty snapshot outcomes', async () => {
    const outcomes = [
      { status: 'owner-unreachable' as const },
      { status: 'failed' as const, reason: 'screen-render-timeout' },
      { status: 'success' as const, screen: '' },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const id = `tui:${3000 + index}:${Math.floor(performance.now())}`;
      const now = Date.now();
      upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
      const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl(), {
        async requestRemotePtyControl() { return outcome; },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { frame: string; frameAt: number; frameSource: string };
      expect(body.frame).toBe('');
      expect(body.frameAt).toBe(0);
      expect(body.frameSource).toBe('unavailable');
    }
  });

  test('returns an unavailable frame value when the snapshot request rejects after its timeout', async () => {
    const id = `tui:timeout:${Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl(), {
      async requestRemotePtyControl() { throw new Error('screen-render-timeout'); },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frame: string; frameAt: number; frameSource: string };
    expect(body).toEqual(expect.objectContaining({ frame: '', frameAt: 0, frameSource: 'unavailable' }));
  });

  test('distinguishes no selector, an unknown root, and a missing PTY in the selected root', async () => {
    const noSelector = await handleTerminalFrame(frameReq(), opts, 'no-such-tui', frameUrl());
    expect(noSelector.status).toBe(404);
    expect(await noSelector.json()).toEqual({ error: 'not-found', id: 'no-such-tui' });

    const unknownRoot = await handleTerminalFrame(frameReq(), opts, 'no-such-tui', frameUrl('?sourceRoot=missing-root'));
    expect(unknownRoot.status).toBe(404);
    expect(await unknownRoot.json()).toEqual({ error: 'source-root-not-found', id: 'no-such-tui', sourceRoot: 'missing-root' });

    const currentRoot = ptyManifestDbPath();
    const missingSelected = await handleTerminalFrame(frameReq(), opts, 'no-such-tui', frameUrl(`?sourceRoot=${encodeURIComponent(currentRoot)}`));
    expect(missingSelected.status).toBe(404);
    // dbPath names the root that WAS resolved — the caller can tell "no such root"
    // from "that root has no such PTY" without a second request.
    expect(await missingSelected.json()).toEqual({ error: 'pty-not-found-in-source-root', id: 'no-such-tui', sourceRoot: currentRoot, dbPath: currentRoot });
  });

  test('the live resolver gives scrollback the same three bodies it gives frame', async () => {
    const url = (query = ''): URL => new URL(`http://localhost/v1/terminals/no-such-tui/scrollback${query}`);
    const currentRoot = ptyManifestDbPath();
    const noSelector = handleTerminalScrollback(bareReq(), opts, 'no-such-tui', url());
    const unknownRoot = handleTerminalScrollback(bareReq(), opts, 'no-such-tui', url('?sourceRoot=missing-root'));
    const missingSelected = handleTerminalScrollback(bareReq(), opts, 'no-such-tui', url(`?sourceRoot=${encodeURIComponent(currentRoot)}`));
    expect([noSelector.status, unknownRoot.status, missingSelected.status]).toEqual([404, 404, 404]);
    expect(await noSelector.json()).toEqual({ error: 'not-found', id: 'no-such-tui' });
    expect(await unknownRoot.json()).toEqual({ error: 'source-root-not-found', id: 'no-such-tui', sourceRoot: 'missing-root' });
    expect(await missingSelected.json()).toEqual({ error: 'pty-not-found-in-source-root', id: 'no-such-tui', sourceRoot: currentRoot, dbPath: currentRoot });
  });

  test('empty id → 400 missing-id', async () => {
    const res = await handleTerminalFrame(frameReq(), opts, '', frameUrl());
    expect(res.status).toBe(400);
  });

  test('?ansi=strip removes escape sequences from the frame', async () => {
    const id = `tui:${4000 + Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    updatePtyManifestFrame(id, () => '\x1b[32mgreen\x1b[0m status', now);
    const res = await handleTerminalFrame(frameReq(), opts, id, frameUrl('?ansi=strip'));
    const body = (await res.json()) as { frame: string; ansiStripped?: boolean };
    expect(body.frame).toContain('green');
    expect(body.frame).not.toContain('\x1b');
    expect(body.ansiStripped).toBe(true);
  });

  test('frame endpoint gated by bearer token', async () => {
    const optsWithToken: MetaApiOpts = { bearerToken: 'secret-xyz' };
    const res = await handleTerminalFrame(frameReq(), optsWithToken, 'anything', frameUrl());
    expect(res.status).toBe(401);
  });
});

/** ⭐ The federated list crosses universes, so the two detail endpoints must cross
 *  them the same way. These tests drive the real handlers (not the resolver) and
 *  compare whole bodies, because `objectContaining` is what let `frame` and
 *  `scrollback` drift into different shapes for the same failure. */
describe('terminal detail endpoints — one source-root contract for frame and scrollback', () => {
  const DB_PATH = '/roots/owner-b/pty/manifest.db';
  const SOURCE_ROOT = 'owner-b';
  const ID = 'duplicate-pty';

  function row(overrides: Partial<PtyManifestRow> = {}): PtyManifestRow {
    return {
      id: ID, kind: 'tui', cmd: 'owner-b', ownerPid: 202, ptyPid: 203, instance: 'owner-b', startedAt: 1, alive: true,
      exitCode: null, snapshot: 'remote line one\nremote line two', snapshotAt: 1, updatedAt: 1, frame: 'remote frame', frameAt: 7,
      outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '',
      closedAt: 0, codeSha: '', ...overrides,
    } as PtyManifestRow;
  }
  function detailUrl(path: 'frame' | 'scrollback', query = ''): URL {
    return new URL(`http://localhost/v1/terminals/${ID}/${path}${query}`);
  }
  const never = () => { throw new Error('requestRemotePtyControl must not run for a rejected selector'); };
  // ⛔ The seam is the resolver's INPUTS, not the resolver. Injecting the resolver
  // let a test fabricate `{ dbPath: A, row: <row from B> }` — a pairing the live
  // code cannot produce, so a test could go green on a state that never happens.
  const KNOWN_ROOT = [{ name: SOURCE_ROOT, dbPath: DB_PATH }];

  test('an unknown source root is 404 source-root-not-found with the identical body on both endpoints', async () => {
    const seam = { detailTargets: KNOWN_ROOT, rowsAt: () => [row()] };
    const frame = await handleTerminalFrame(bareReq(), opts, ID, detailUrl('frame', '?sourceRoot=missing'), {
      ...seam, getPtyManifest: () => row(), requestRemotePtyControl: never,
    });
    const scrollback = handleTerminalScrollback(bareReq(), opts, ID, detailUrl('scrollback', '?sourceRoot=missing'), {
      ...seam, getPty: () => undefined, getPtyManifest: () => row(),
    });
    expect(frame.status).toBe(404);
    expect(scrollback.status).toBe(404);
    const expected = { error: 'source-root-not-found', id: ID, sourceRoot: 'missing' };
    expect(await frame.json()).toEqual(expected);
    expect(await scrollback.json()).toEqual(expected);
  });

  test('a known root without the row is 404 pty-not-found-in-source-root and BOTH endpoints carry dbPath', async () => {
    const seam = { detailTargets: KNOWN_ROOT, rowsAt: () => [] };
    const frame = await handleTerminalFrame(bareReq(), opts, ID, detailUrl('frame', `?sourceRoot=${SOURCE_ROOT}`), {
      ...seam, getPtyManifest: () => row(), requestRemotePtyControl: never,
    });
    const scrollback = handleTerminalScrollback(bareReq(), opts, ID, detailUrl('scrollback', `?sourceRoot=${SOURCE_ROOT}`), {
      ...seam, getPty: () => undefined, getPtyManifest: () => row(),
    });
    // The regression this pins: frame used to omit dbPath while scrollback supplied it.
    const expected = { error: 'pty-not-found-in-source-root', id: ID, sourceRoot: SOURCE_ROOT, dbPath: DB_PATH };
    expect(await frame.json()).toEqual(expected);
    expect(await scrollback.json()).toEqual(expected);
  });

  test('a selected foreign row is served by both endpoints instead of the current-root row', async () => {
    const seam = { detailTargets: KNOWN_ROOT, rowsAt: (dbPath: string) => dbPath === DB_PATH ? [row()] : [] };
    const localRow = row({ frame: 'local frame', snapshot: 'local output', instance: 'owner-a' });
    const frame = await handleTerminalFrame(bareReq(), opts, ID, detailUrl('frame', `?sourceRoot=${SOURCE_ROOT}`), {
      ...seam, getPtyManifest: () => localRow, requestRemotePtyControl: never,
    });
    const scrollback = handleTerminalScrollback(bareReq(), opts, ID, detailUrl('scrollback', `?sourceRoot=${SOURCE_ROOT}`), {
      ...seam, getPty: () => undefined, getPtyManifest: () => localRow,
    });
    expect(frame.status).toBe(200);
    expect(scrollback.status).toBe(200);
    expect(await frame.json()).toEqual({
      id: ID, frame: 'remote frame', frameAt: 7, frameSource: 'stored', remote: true, instance: 'owner-b', kind: 'tui',
    });
    expect(await scrollback.json()).toEqual({
      id: ID, lines: 2, totalLines: 2, scrollback: 'remote line one\nremote line two',
    });
  });

  test('a LIVE local handle with the same id does not hijack a selected foreign root', async () => {
    // PTY ids are unique only within a root. Before this, scrollback preferred the
    // local handle even after resolving the foreign row, so asking for owner-b
    // returned owner-a's live output — the exact confusion this endpoint exists to end.
    const localHandleRead: string[] = [];
    const scrollback = handleTerminalScrollback(bareReq(), opts, ID, detailUrl('scrollback', `?sourceRoot=${SOURCE_ROOT}`), {
      detailTargets: KNOWN_ROOT,
      rowsAt: (dbPath: string) => dbPath === DB_PATH ? [row()] : [],
      getPty: () => { localHandleRead.push(ID); return { snapshot: () => 'LOCAL LIVE OUTPUT' } as never; },
      getPtyManifest: () => row({ snapshot: 'local manifest output' }),
    });
    expect(scrollback.status).toBe(200);
    expect(await scrollback.json()).toEqual({
      id: ID, lines: 2, totalLines: 2, scrollback: 'remote line one\nremote line two',
    });
    // Not merely absent from the body — the local handle is never even consulted.
    expect(localHandleRead).toEqual([]);
  });

  test('with no selector and no row anywhere, both endpoints say not-found; when another root has it, both say pty-in-another-source-root', async () => {
    for (const [inAnotherRoot, error] of [[false, 'not-found'], [true, 'pty-in-another-source-root']] as const) {
      const frame = await handleTerminalFrame(bareReq(), opts, ID, detailUrl('frame'), {
        getPtyManifest: () => null,
        isPtyInAnotherManifestRoot: () => inAnotherRoot, requestRemotePtyControl: never,
      });
      const scrollback = handleTerminalScrollback(bareReq(), opts, ID, detailUrl('scrollback'), {
        getPty: () => undefined, getPtyManifest: () => null,
        isPtyInAnotherManifestRoot: () => inAnotherRoot,
      });
      expect(frame.status).toBe(404);
      expect(scrollback.status).toBe(404);
      expect(await frame.json()).toEqual({ error, id: ID });
      expect(await scrollback.json()).toEqual({ error, id: ID });
    }
  });
});

describe('parsePngPath', () => {
  test('matches /v1/terminals/:id/png', () => {
    expect(parsePngPath('/v1/terminals/tui%3A5/png')).toBe('tui:5');
    expect(parsePngPath('/v1/terminals/abc/frame')).toBeNull();
    expect(parsePngPath('/v1/terminals/abc/png/')).toBeNull();
  });

  test('malformed percent-encoding → null (no decodeURIComponent throw)', () => {
    // %ZZ would throw in decodeURIComponent; safeDecodeSegment → null → 404, not a 500.
    expect(parsePngPath('/v1/terminals/%ZZ/png')).toBeNull();
    expect(parseFramePath('/v1/terminals/%E0%A4%A/frame')).toBeNull(); // truncated seq
  });
});

/** Parse a PNG's IHDR width/height (bytes 16-23, big-endian). */
function pngDims(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('deriveFrameDims', () => {
  test('cols = widest line by DISPLAY width (ASCII)', () => {
    expect(deriveFrameDims('abc\nde')).toEqual({ cols: 3, rows: 2 });
  });
  test('CJK/emoji count as 2 display cols (not codepoints)', () => {
    expect(deriveFrameDims('가나다').cols).toBe(6);  // 3 chars × 2
    expect(deriveFrameDims('a\n가').cols).toBe(2);   // widest line = 가 (2)
  });
  test('ANSI SGR does not inflate cols', () => {
    expect(deriveFrameDims('\x1b[31mred\x1b[0m').cols).toBe(3);
  });
  test('single trailing newline drops the phantom row', () => {
    expect(deriveFrameDims('a\nb\n').rows).toBe(2);
    expect(deriveFrameDims('a\nb').rows).toBe(2);
  });
  test('caps at 400×200 (pathological frame)', () => {
    const wide = 'x'.repeat(1000);
    const tall = Array.from({ length: 1000 }, () => 'y').join('\n');
    expect(deriveFrameDims(wide).cols).toBe(400);
    expect(deriveFrameDims(tall).rows).toBe(200);
  });
});

describe('handleTerminalPng (⭐P4 §4-1 on-demand PNG)', () => {
  function pngReq(): Request { return new Request('http://localhost/v1/terminals/x/png'); }

  test('renders the manifest frame to a real PNG with non-trivial IHDR dims', async () => {
    const id = `tui:${5000 + Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    updatePtyManifestFrame(id, () => '┌ elanous ┐\n│ hi   │\n└───────┘', now);
    const res = await handleTerminalPng(pngReq(), opts, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG magic number (\x89PNG) — proves a real image, not an empty body.
    expect(buf[0]).toBe(0x89); expect(buf[1]).toBe(0x50); expect(buf[2]).toBe(0x4e); expect(buf[3]).toBe(0x47);
    const { w, h } = pngDims(buf);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0); // not a 0×0 / truncated render
  });

  test('CJK (fullwidth) frame renders WIDER than an ASCII frame — display-width dims', async () => {
    const now = Date.now();
    const asciiId = `tui:${7100 + Math.floor(performance.now())}`;
    const cjkId = `tui:${7200 + Math.floor(performance.now())}`;
    upsertPtyManifest({ id: asciiId, kind: 'tui', cmd: 'm', startedAt: now, now });
    upsertPtyManifest({ id: cjkId, kind: 'tui', cmd: 'm', startedAt: now, now });
    updatePtyManifestFrame(asciiId, () => 'abc', now);   // 3 display cols
    updatePtyManifestFrame(cjkId, () => '가나다', now);   // 3 chars · 6 display cols
    const a = pngDims(Buffer.from(await (await handleTerminalPng(pngReq(), opts, asciiId)).arrayBuffer()));
    const c = pngDims(Buffer.from(await (await handleTerminalPng(pngReq(), opts, cjkId)).arrayBuffer()));
    // ansiToCells counts 가/나/다 as 2 cells each → wider canvas than 'abc'.
    // A naive line.length would size both equally (3) — this guards the fix.
    expect(c.w).toBeGreaterThan(a.w);
  });

  test('known id with no frame → 404 no-frame', async () => {
    const id = `tui:${6000 + Math.floor(performance.now())}`;
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
    const res = await handleTerminalPng(pngReq(), opts, id);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('no-frame');
  });

  test('unknown id → 404', async () => {
    const res = await handleTerminalPng(pngReq(), opts, 'no-such');
    expect(res.status).toBe(404);
  });

  test('gated by bearer token', async () => {
    const res = await handleTerminalPng(pngReq(), { bearerToken: 'secret-xyz' }, 'anything');
    expect(res.status).toBe(401);
  });
});

describe('handleTerminalLineage', () => {
  function lineageReq(key?: string): Request {
    const suffix = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
    return new Request(`http://localhost/v1/terminals/lineage${suffix}`);
  }

  test('requires bearer authentication', async () => {
    const res = handleTerminalLineage(lineageReq('anything'), { bearerToken: 'secret-xyz' });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({ error: 'unauthorized' });
  });

  test('rejects a missing or empty key', async () => {
    expect(parseTerminalLineagePath('/v1/terminals/lineage')).toBe(true);
    expect(parseTerminalLineagePath('/v1/terminals/lineage/')).toBe(false);
    const missing = handleTerminalLineage(lineageReq(), opts);
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { error: string }).toEqual({ error: 'missing-key' });
    const empty = handleTerminalLineage(lineageReq(''), opts);
    expect(empty.status).toBe(400);
    expect((await empty.json()) as { error: string }).toEqual({ error: 'missing-key' });
  });

  test('rejects an explicit sourceRoot outside the allowed manifest targets', async () => {
    const res = handleTerminalLineage(new Request('http://localhost/v1/terminals/lineage?key=anything&sourceRoot=%2Foutside%2Fmanifest.db'), opts);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found', sourceRoot: '/outside/manifest.db' });
  });

  test('returns an empty successful result when the key has no lineage', async () => {
    const res = handleTerminalLineage(lineageReq('no-such-lineage'), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; groups: unknown[]; unreadablePayloads: number };
    expect(body.key).toBe('no-such-lineage');
    expect(body.groups).toEqual([]);
    expect(body.unreadablePayloads).toBe(0);
  });

  test('preserves parent grouping from lifecycle rows', async () => {
    const now = Date.now();
    appendPtyEvent({
      instance: 'test', surfaceId: 'parent', kind: 'lifecycle', now,
      payload: { event: 'spawned', ptyId: 'parent', kind: 'harness', startedAt: now },
    });
    appendPtyEvent({
      instance: 'test', surfaceId: 'child', kind: 'lifecycle', now: now + 1,
      payload: { event: 'spawned', ptyId: 'child', kind: 'harness', parentPtyId: 'parent', startedAt: now + 1 },
    });
    const res = handleTerminalLineage(lineageReq('child'), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ joinedBy: string; key: string; parentMissing: boolean; rows: Array<{ ptyId: string }> }>;
    };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'parent', parentMissing: false });
    expect(body.groups[0]!.rows.map((row) => row.ptyId)).toEqual(['parent', 'child']);
  });

  // ⭐ 리뷰 should-fix — 응답의 «핵심 계약»을 값으로 못 박는다. `joinedBy` 를 빼거나 뭉개면
  //   소비자가 「단정」과 「추정」을 못 가른다. 그 셋을 각각 문다.
  test('joinedBy 가 run · workdir-heuristic 으로도 «실린다» — 축마다 급이 다르다', async () => {
    const now = Date.now();
    // 부모 간선이 없고 runId 만 같은 둘 ⇒ 'run'(단정)
    for (const id of ['r1', 'r2']) {
      appendPtyEvent({
        instance: 'test', surfaceId: id, kind: 'lifecycle', now,
        payload: { event: 'spawned', ptyId: id, kind: 'harness', runId: 'run-axis', startedAt: now },
      });
    }
    const runBody = (await handleTerminalLineage(lineageReq('run-axis'), opts).json()) as {
      groups: Array<{ joinedBy: string; key: string }>;
    };
    expect(runBody.groups[0]).toMatchObject({ joinedBy: 'run', key: 'run-axis' });

    // 부모도 run 도 없고 workdir 만 같은 둘 ⇒ ⛔ 'workdir-heuristic'(«모호» — 한 worktree 는 여러 런을 담는다)
    for (const id of ['w1', 'w2']) {
      appendPtyEvent({
        instance: 'test', surfaceId: id, kind: 'lifecycle', now,
        payload: { event: 'spawned', ptyId: id, kind: 'harness', workdir: '/tmp/shared-wd', startedAt: now },
      });
    }
    const wdBody = (await handleTerminalLineage(lineageReq('/tmp/shared-wd'), opts).json()) as {
      groups: Array<{ joinedBy: string }>;
    };
    expect(wdBody.groups[0]!.joinedBy).toBe('workdir-heuristic');
  });

  test('parentMissing 이 참으로 실리고 «종료된» PTY 도 결과에 남는다', async () => {
    const now = Date.now();
    // 부모 `ghost-parent` 는 이 뿌리에 «없다»(부모와 자식은 다른 우주에 등록될 수 있다 — 실측 형태).
    appendPtyEvent({
      instance: 'test', surfaceId: 'orphan', kind: 'lifecycle', now,
      payload: { event: 'spawned', ptyId: 'orphan', kind: 'harness', parentPtyId: 'ghost-parent', startedAt: now },
    });
    // 그리고 그 자식은 «죽는다» — ⛔ 종료는 오류가 아니라 상태이므로 결과에서 사라지면 안 된다.
    appendPtyEvent({
      instance: 'test', surfaceId: 'orphan', kind: 'lifecycle', now: now + 5,
      payload: { event: 'exited', ptyId: 'orphan', closedAt: now + 5 },
    });
    const body = (await handleTerminalLineage(lineageReq('ghost-parent'), opts).json()) as {
      groups: Array<{ joinedBy: string; key: string; parentMissing: boolean; rows: Array<{ ptyId: string; alive: boolean }> }>;
    };
    expect(body.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'ghost-parent', parentMissing: true });
    expect(body.groups[0]!.rows.map((row) => row.ptyId)).toContain('orphan');
    expect(body.groups[0]!.rows.find((row) => row.ptyId === 'orphan')!.alive).toBe(false);
  });

  test('읽을 수 없는 원장 줄은 «삼키지 않고 세어서» 응답에 싣는다', async () => {
    const now = Date.now();
    // payload 가 lifecycle 모양이 아니다 ⇒ 조용히 버리면 「없었다」와 「못 읽었다」가 같은 값이 된다.
    appendPtyEvent({ instance: 'test', surfaceId: 'bad', kind: 'lifecycle', now, payload: 'not-an-object' });
    const body = (await handleTerminalLineage(lineageReq('anything-at-all'), opts).json()) as { unreadablePayloads: number };
    expect(body.unreadablePayloads).toBeGreaterThan(0);
  });
});

class ViewElement {
  constructor(readonly tagName = '') {}
  children: ViewElement[] = [];
  className = '';
  textContent = '';
  tabIndex = 0;
  checked = false;
  scrollTop = 0;
  scrollHeight = 0;
  onclick: (() => void) | null = null;
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  private html = '';
  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force === undefined ? !names.has(name) : force;
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    },
  };
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    this.textContent = value
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt);/g, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>' })[entity]!);
  }
  get innerHTML(): string { return this.html; }
  private parent: ViewElement | null = null;
  get parentNode(): ViewElement | null { return this.parent; }
  appendChild(child: ViewElement): ViewElement { child.parent = this; this.children.push(child); return child; }
  /** 정리 루프도 여태 «한 번도» 돌지 않았다 — 후보를 찾는 선택자가 항상 빈 배열이었기 때문이다. */
  remove(): void {
    const siblings = this.parent?.children;
    if (!siblings) return;
    const at = siblings.indexOf(this);
    if (at >= 0) siblings.splice(at, 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  dispatch(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener(); }
  querySelectorAll(selector: string): ViewElement[] {
    // ⛔⭐ 속성 선택자는 «실물처럼» 답해야 한다 — 종전엔 button 외 전부 빈 배열이라
    //   「카드를 다시 찾는다」가 항상 실패해도 테스트가 그것을 못 봤다(계보 카드 무한 증식 회귀).
    if (selector === '[data-pty-key]') return this.children.filter((child) => child.getAttribute('data-pty-key') !== null);
    if (selector !== 'button') return [];
    return this.children.flatMap((child) => child.children.length ? child.children : [child]);
  }
  /** ⛔⭐ 종전엔 «무조건 null» 이었다 — 그래서 카드 재사용 분기가 «한 번도» 실행되지 않았고,
   *  무한 증식 회귀가 테스트를 그대로 통과했다. createElement/appendChild 로 «실제로 만든» 자식만
   *  본다(innerHTML 로 그린 것은 모델하지 않으므로 `.id` 같은 선택자는 그대로 null 이다). */
  querySelector(selector: string): ViewElement | null {
    // ⛔⭐⭐⭐ 속성값 선택자는 CSS 전처리를 «그대로» 흉내 낸다 — CSS Syntax §3.3 이 입력의
    //   U+0000 을 U+FFFD 로 치환하므로, NUL 이 든 키로 만든 선택자는 그 NUL 을 담은 속성과
    //   «영원히» 안 맞는다. 이것이 계보 카드 무한 증식의 기전이고, 이 줄이 그것을 재현한다.
    const attr = /^\[([\w-]+)="([\s\S]*)"\]$/.exec(selector);
    if (attr) {
      const wanted = attr[2]!.replace(/\0/g, '�');
      return this.children.find((child) => child.getAttribute(attr[1]!) === wanted) ?? null;
    }
    const match = selector.startsWith('.')
      ? (child: ViewElement) => child.className === selector.slice(1)
      : (child: ViewElement) => child.tagName === selector;
    return this.children.find(match) ?? null;
  }
  focus(): void {}
}

function viewScript(html: string): string {
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (start < 0 || end < start) throw new Error('terminals view script missing');
  return html.slice(start + '<script>'.length, end);
}

async function settleView(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

function lineageCardTitle(card: ViewElement): string {
  return card.children[0]!.children[0]!.textContent;
}

describe('handleTerminalsView — lineage observatory markup', () => {
  // This is intentionally a shallow string seam: it proves the self-contained HTML
  // retains its required markers and refresh wiring, not that a browser renders panels.
  // ⛔⭐ 배지가 «내부 구현»을 말하고 있었다 — 「원격」은 in-process 레지스트리가 아니라는 뜻일 뿐이라
  //   목록의 거의 전부에 붙어 정보량이 0 이었고, 정작 「이게 무엇인가」(kind)는 id 접두로 짐작해야 했다.
  //   ⊕ 「화면」은 «저장된» 프레임만 봐서, 라이브 렌더를 받을 수 있는 셀에 안 붙었다(E11·E18 이후 낡음).
  test('badges name the kind and the render capability instead of the transport', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const terminals = [
      { id: 'tui:1', kind: 'tui', alive: true, remote: true, frameAt: 5, startedAt: 3 },
      { id: 'self_a', kind: 'self', alive: true, remote: true, frameAt: 0, startedAt: 2 },
      { id: 'local_x', kind: 'pty', alive: true, remote: false, frameAt: 0, startedAt: 1 },
    ];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async () => ({ ok: true, json: async () => ({ terminals, scope: { roots: 1, federated: false, hiddenDead: 0 } }) });
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    const rows = elements.get('list')!.children.map((item) => item.children[0]!.innerHTML);
    expect(rows).toHaveLength(3);
    // 종류가 값으로 보인다 — id 접두를 사람이 해석하지 않아도 된다.
    expect(rows[0]).toContain('>tui</span>');
    expect(rows[1]).toContain('>self</span>');
    expect(rows[2]).toContain('>pty</span>');
    // ⛔ 전송 방식(원격/로컬)은 더는 배지가 아니다.
    expect(rows.join('')).not.toContain('원격');
    expect(rows.join('')).not.toContain('로컬');
    // 「화면」은 «저장된 프레임» 이거나 «살아 있는 원격»이면 붙는다(라이브 렌더를 받을 수 있다).
    expect(rows[0]).toContain('화면');
    expect(rows[1]).toContain('화면');
    // 로컬 in-process 는 소유 프로세스에 라이브 렌더를 물을 수 없다 — 안 붙는다.
    expect(rows[2]).not.toContain('화면');
  });

  test('reports zero PTY-less rows in the dashboard summary for the PTY-only terminal API', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    const terminal = { id: 'pty:root:7', cmd: 'shell', startedAt: 1, instance: 'test:root', alive: true };
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ terminals: [terminal], scope: { roots: 1, federated: false, hiddenDead: 0, hiddenSubAgentRuns: 1 } }) };
    };

    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();

    expect(elements.get('summary')!.textContent).toBe('1개 실행 · 1 live · 0 PTY 없음');
    expect(elements.get('instances')!.textContent).toContain('1건 최근 24시간 현재 범위의 로그 스토어에서 센 PTY 없이 실행된 서브 에이전트 집계');
    expect(calls).toEqual(['/v1/terminals', '/v1/terminals/pty%3Aroot%3A7/scrollback?lines=400']);
  });

  test('selects and loads the first terminal only on the first nonempty list render while preserving an explicit selection', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    let refresh: (() => void) | undefined;
    let terminalsAvailable = false;
    const terminals = [
      { id: 'first', cmd: 'first-shell', alive: true, remote: false, frameAt: 0, startedAt: 1 },
      { id: 'second', cmd: 'second-shell', alive: true, remote: false, frameAt: 0, startedAt: 2 },
    ];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      if (url === '/v1/terminals') return { ok: true, json: async () => ({ terminals: terminalsAvailable ? terminals : [], scope: { roots: 1, federated: false, hiddenDead: 0 } }) };
      return { ok: true, json: async () => ({ scrollback: url.includes('/first/') ? 'first output' : 'second output' }) };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { refresh = callback; });
    await settleView();
    expect(elements.get('list')!.innerHTML).toContain('표시할 PTY 또는 서브 에이전트 실행이 없습니다.');

    terminalsAvailable = true;
    refresh!();
    await settleView();
    let buttons = elements.get('list')!.children.map((item) => item.children[0]!);
    expect(buttons.map((button) => button.getAttribute('aria-current'))).toEqual(['true', 'false']);
    expect(calls).toContain('/v1/terminals/first/scrollback?lines=400');
    expect(elements.get('scrollback')!.children.map((span) => span.textContent).join('')).toBe('first output');

    buttons[1]!.onclick!();
    await settleView();
    refresh!();
    await settleView();
    buttons = elements.get('list')!.children.map((item) => item.children[0]!);
    expect(buttons.map((button) => button.getAttribute('aria-current'))).toEqual(['false', 'true']);
    expect(calls).toContain('/v1/terminals/second/scrollback?lines=400');
  });

  test('replaces a stale source-root selection with the first refreshed terminal and clears detail when the refreshed list is empty', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    const local = { id: 'shared', cmd: 'local-shell', alive: true, remote: false, frameAt: 0, startedAt: 1 };
    const remote = { id: 'shared', cmd: 'remote-shell', alive: true, remote: true, frameAt: 0, startedAt: 2, sourceRoot: { name: 'other', dbPath: '/tmp/other/pty/manifest.db' } };
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      if (url === '/v1/terminals') return { ok: true, json: async () => ({ terminals: [local], scope: { roots: 1, federated: false, hiddenDead: 0 } }) };
      if (url === '/v1/terminals?all=true') return { ok: true, json: async () => ({ terminals: [remote], scope: { roots: 2, federated: true, hiddenDead: 0 } }) };
      if (url === '/v1/terminals?all=true&includeTest=true') return { ok: true, json: async () => ({ terminals: [], scope: { roots: 3, federated: true, hiddenDead: 0 } }) };
      return { ok: true, json: async () => ({ scrollback: url.includes('sourceRoot=') ? 'remote output' : 'local output' }) };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    expect(elements.get('list')!.children.map((item) => item.children[0]!.getAttribute('aria-current'))).toEqual(['true']);

    elements.get('allRoots')!.checked = true;
    elements.get('allRoots')!.dispatch('change');
    await settleView();
    expect(elements.get('list')!.children.map((item) => item.children[0]!.getAttribute('aria-current'))).toEqual(['true']);
    expect(elements.get('detailHead')!.textContent).toContain('remote-shell');
    expect(elements.get('scrollback')!.children.at(-1)?.textContent).toBe('remote output');
    expect(elements.get('scrollback')!.textContent).not.toContain('스크롤백 오류:');

    elements.get('includeTest')!.checked = true;
    elements.get('includeTest')!.dispatch('change');
    await settleView();
    expect(elements.get('list')!.innerHTML).toContain('표시할 PTY 또는 서브 에이전트 실행이 없습니다.');
    expect(elements.get('detailHead')!.textContent).toBe('← 왼쪽에서 실행을 선택하세요');
    expect(elements.get('scrollback')!.textContent).toBe('선택한 실행의 상세가 여기 표시됩니다.');
    expect(calls).not.toContain('/v1/terminals/undefined/scrollback?lines=400');
  });

  test('requeries the default, all, and includeTest scopes when the named controls change', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ terminals: [], scope: { roots: url.includes('includeTest=true') ? 3 : url.includes('all=true') ? 2 : 1, federated: url.includes('all=true'), hiddenDead: 0 } }) };
    };

    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    expect(calls).toEqual(['/v1/terminals']);
    expect(elements.get('allRoots')!.checked).toBe(false);
    expect(elements.get('includeTest')!.checked).toBe(false);
    expect((elements.get('includeTest') as unknown as { disabled?: boolean }).disabled).toBe(true);

    elements.get('allRoots')!.checked = true;
    elements.get('allRoots')!.dispatch('change');
    await settleView();
    expect(calls).toEqual(['/v1/terminals', '/v1/terminals?all=true']);
    expect((elements.get('includeTest') as unknown as { disabled?: boolean }).disabled).toBe(false);

    elements.get('includeTest')!.checked = true;
    elements.get('includeTest')!.dispatch('change');
    await settleView();
    expect(calls).toEqual(['/v1/terminals', '/v1/terminals?all=true', '/v1/terminals?all=true&includeTest=true']);
  });

  test('keeps flat mode while exposing the lineage toggle, ambiguity, cap notice, and shared metadata helpers', async () => {
    const html = await handleTerminalsView().text();
    expect(html).toContain('id="list"');
    expect(html).toContain('id="scrollback"');
    expect(html).toContain('id="lineageMode"');
    expect(html).toContain("workdir-heuristic");
    expect(html).toContain("' · 모호'");
    expect(html).toContain("'외 '+(available.length-6)+'개'");
    expect(html).toContain(terminalTreeNames.toString());
    expect(html).toContain(terminalAgeBadge.toString());
    expect(html).toContain(terminalParentIdentity.toString());
    expect(html).toContain(terminalOriginIdentity.toString());
    expect(html).toContain('origin=terminalOriginIdentity(t)');
    expect(html).toContain('origin=terminalOriginIdentity(row)');
  });

  test('renders the response scope line with root, hidden-dead, domain, and the measured one-store sub-agent count via textContent', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'];
    const domain = '<도메인 문장 표본 · 배선 확인용>';
    const renderScope = async (scope: Record<string, unknown>): Promise<string> => {
      const elements = new Map(ids.map((id) => [id, new ViewElement()]));
      const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
      const fetch = async () => ({ ok: true, json: async () => ({ terminals: [], scope }) });
      new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
      await settleView();
      return elements.get('instances')!.textContent;
    };

    expect(await renderScope({ roots: 2, federated: true, hiddenDead: 7, domain, hiddenSubAgentRuns: 2 }))
      .toBe('2개 인스턴스에서 수집 · 죽은 행 7개 숨김 · '+domain+' · 2건 최근 24시간 현재 범위의 로그 스토어에서 센 PTY 없이 실행된 서브 에이전트 집계');
    expect(await renderScope({ roots: 2, federated: true, hiddenDead: 7, domain }))
      .toBe('2개 인스턴스에서 수집 · 죽은 행 7개 숨김 · '+domain);
  });

  // ⛔⭐ 서버 연합은 #7072 부터 «있었는데» 화면에 그것을 켜는 컨트롤이 없었다 — 사람은 주소창을
  //   손으로 고쳐야 다른 뿌리를 볼 수 있었다(실측: 기본 1뿌리 / all=true 32 / +includeTest 476).
  //   토글 둘이 그 질의를 만들고, 주소창으로 들어온 상태도 그대로 되비춘다.
  test('federation toggles drive the list query and mirror an inbound scope query', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ terminals: [], scope: { roots: 1, federated: false, hiddenDead: 0 } }) }; };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    expect(calls).toContain('/v1/terminals');
    // 테스트 뿌리 포함은 모든 뿌리가 꺼져 있으면 뜻이 없다 — 화면이 그것을 «비활성»으로 말한다.
    expect((elements.get('includeTest') as unknown as { disabled?: boolean }).disabled).toBe(true);

    elements.get('allRoots')!.checked = true;
    elements.get('allRoots')!.dispatch('change'); await settleView();
    expect(calls).toContain('/v1/terminals?all=true');
    expect((elements.get('includeTest') as unknown as { disabled?: boolean }).disabled).toBe(false);

    elements.get('includeTest')!.checked = true;
    elements.get('includeTest')!.dispatch('change'); await settleView();
    expect(calls).toContain('/v1/terminals?all=true&includeTest=true');

    // ⛔ 모든 뿌리를 끄면 테스트 포함도 «같이» 꺼진다 — 뜻 없는 조합을 남기지 않는다.
    elements.get('allRoots')!.checked = false;
    elements.get('allRoots')!.dispatch('change'); await settleView();
    expect(calls[calls.length - 1]).toBe('/v1/terminals');
    expect(elements.get('includeTest')!.checked).toBe(false);
  });

  test('federation toggles reflect a scope query supplied in the address bar', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock', 'allRoots', 'includeTest', 'scopeHint'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ terminals: [], scope: { roots: 3, federated: true, hiddenDead: 0 } }) };
    };
    // 스크립트는 location.search 를 그대로 읽는다 — 링크를 받은 사람이 «화면과 주소가 어긋난 것»을 보면 안 된다.
    new Function('document', 'fetch', 'setInterval', 'location', viewScript(html))(document, fetch, () => {}, { search: '?all=true&includeTest=true' });
    await settleView();
    expect(calls[0]).toBe('/v1/terminals?all=true&includeTest=true');
    expect(elements.get('allRoots')!.checked).toBe(true);
    expect(elements.get('includeTest')!.checked).toBe(true);
    expect((elements.get('includeTest') as unknown as { disabled?: boolean }).disabled).toBe(false);
  });

  test('loads a selected remote cell goal from its source root, safely renders it, and ignores a late response after mode change', async () => {
    const html = await handleTerminalsView().text();
    const ids = ['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'originalGoal', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'];
    const elements = new Map(ids.map((id) => [id, new ViewElement()]));
    const calls: string[] = [];
    let resolveGoal: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = (url: string) => {
      calls.push(url);
      if (url === '/v1/terminals') return Promise.resolve({ ok: true, json: async () => ({ terminals: [{ id: 'remote', cmd: 'agent', alive: true, remote: true, frameAt: 0, runId: 'run-remote', sourceRoot: { name: 'other', dbPath: '/tmp/other/pty/manifest.db' } }] }) });
      if (url.includes('/goal')) return new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => { resolveGoal = resolve; });
      return Promise.resolve({ ok: true, json: async () => ({ scrollback: 'ordinary output' }) });
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('list')!.children[0]!.children[0]!.onclick!();
    await settleView();
    elements.get('originalGoal')!.onclick!();
    expect(calls).toContain('/v1/terminals/runs/run-remote/goal?sourceRoot=%2Ftmp%2Fother%2Fpty%2Fmanifest.db');
    expect(elements.get('originalGoal')!.getAttribute('aria-pressed')).toBe('true');
    elements.get('frameMode')!.checked = false;
    elements.get('frameMode')!.dispatch('change');
    resolveGoal!({ ok: true, json: async () => ({ status: 'found', goal: '<script>late goal</script>' }) });
    await settleView();
    expect(elements.get('originalGoal')!.getAttribute('aria-pressed')).toBe('false');
    expect(elements.get('scrollback')!.children.at(-1)!.textContent).toBe('ordinary output');

    elements.get('originalGoal')!.onclick!();
    await settleView();
    resolveGoal!({ ok: true, json: async () => ({ status: 'found', goal: '<script>literal goal</script>', ledgerDirectory: '/tmp/other/run-ledger' }) });
    await settleView();
    expect(elements.get('scrollback')!.textContent).toBe('<script>literal goal</script>\n\n조회 원장 디렉토리: /tmp/other/run-ledger');
    expect(elements.get('scrollback')!.innerHTML).toBe('');
    expect(elements.get('originalGoal')!.getAttribute('aria-pressed')).toBe('true');
    elements.get('originalGoal')!.onclick!();
    await settleView();
    expect(elements.get('originalGoal')!.getAttribute('aria-pressed')).toBe('false');
    expect(elements.get('scrollback')!.children.at(-1)!.textContent).toBe('ordinary output');
  });

  // ⛔⭐ 「렌더 화면」 토글의 관문은 «저장된» frameAt 만 봤다 — 그래서 서버가 라이브 렌더를 줄 수 있는데도
  //   화면이 그 엔드포인트를 «아예 안 불렀다»(대표 실측: 머리글이 「원시」였고 /frame 은 source=live 였다).
  //   살아 있는 원격 PTY 는 저장분이 없어도 프레임을 시도한다. 네 갈래를 한 자리에서 뭅니다.
  test('requests a live remote frame without a stored frame while preserving toggle, exited, and failure fallbacks', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const calls: string[] = [];
    const terminals = [
      { id: 'remote-live-no-stored-frame', cmd: 'remote', alive: true, remote: true, frameAt: 0 },
      { id: 'stored-frame', cmd: 'stored', alive: true, remote: true, frameAt: 1 },
      { id: 'remote-exited-no-frame', cmd: 'exited', alive: false, remote: true, frameAt: 0 },
    ];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      if (url === '/v1/terminals') return { ok: true, json: async () => ({ terminals }) };
      if (url.includes('remote-live-no-stored-frame/frame')) return { ok: true, json: async () => ({ frame: 'live frame' }) };
      if (url.includes('stored-frame/frame')) return { ok: true, json: async () => ({ frame: 'stored frame' }) };
      if (url.includes('remote-exited-no-frame/scrollback')) return { ok: true, json: async () => ({ scrollback: 'exited record' }) };
      return { ok: false, json: async () => ({}) };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    const buttons = elements.get('list')!.children.map((item) => item.children[0]!);

    expect(calls).toContain('/v1/terminals/remote-live-no-stored-frame/frame');
    expect(elements.get('detailHead')!.textContent).toContain('🖼 렌더 화면');
    expect(elements.get('scrollback')!.children.map((span) => span.textContent).join('')).toBe('live frame');

    buttons[1]!.onclick!(); await settleView();
    expect(calls).toContain('/v1/terminals/stored-frame/frame');

    elements.get('frameMode')!.checked = false;
    elements.get('frameMode')!.dispatch('change'); await settleView();
    expect(calls).toContain('/v1/terminals/stored-frame/scrollback?lines=400');

    elements.get('frameMode')!.checked = true;
    buttons[2]!.onclick!(); await settleView();
    expect(calls).toContain('/v1/terminals/remote-exited-no-frame/scrollback?lines=400');
    expect(calls).not.toContain('/v1/terminals/remote-exited-no-frame/frame');

    buttons[0]!.onclick!(); await settleView();
    const failingFetch = async (url: string) => ({ ok: url === '/v1/terminals', json: async () => url === '/v1/terminals' ? ({ terminals: [terminals[0]] }) : ({}) });
    const failureElements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    failureElements.get('frameMode')!.checked = true;
    const failureDocument = { getElementById: (id: string) => failureElements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(failureDocument, failingFetch, () => {});
    await settleView();
    failureElements.get('list')!.children[0]!.children[0]!.onclick!(); await settleView();
    expect(failureElements.get('scrollback')!.textContent).toContain('프레임 오류: Error');
  });

  test('injects the shared SGR parser and renders ANSI frame text into safe styled spans', async () => {
    const html = await handleTerminalsView().text();
    expect(html).toContain(parseTerminalSgr.toString());
    expect(html).toContain('function renderTerminalFrame(target,frame)');
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => ({ ok: true, json: async () => url === '/v1/terminals'
      ? { terminals: [{ id: 'colored', cmd: 'btop', alive: true, remote: true, frameAt: 1, instance: 'test' }] }
      : { frame: '<script>not markup</script> \x1b[1;31mred\x1b[0m plain' } });
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    const spans = elements.get('scrollback')!.children;
    expect(spans.map((span) => span.textContent).join('')).toBe('<script>not markup</script> red plain');
    expect(spans).toHaveLength(3);
    expect(spans[1]!.style.color).toBe('var(--term-red)');
    expect(spans[1]!.style.fontWeight).toBe('bold');
  });

  test('selects two lineage rows into two cards and refreshes their frame output on the polling interval', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('follow')!.checked = true; elements.get('frameMode')!.checked = true;
    const group = { joinedBy: 'parent', key: 'root', parentMissing: false, rows: [
      { ptyId: 'parent', kind: 'tui', instance: 'test', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: 'run-1', workdir: '/tmp/w', codeSha: 'abc' },
      { ptyId: 'child', kind: 'agent', instance: 'test', alive: true, startedAt: 2, closedAt: 0, parentPtyId: 'parent', parentPid: 1, parentKind: 'tui', runId: 'run-1', workdir: '/tmp/w', codeSha: 'abc' },
    ] };
    const calls: string[] = []; let interval: (() => void) | undefined;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => { calls.push(url); const body = url === '/v1/terminals' ? { terminals: [{ id: 'parent', alive: true, remote: false, frameAt: 1, instance: 'test' }, { id: 'child', alive: true, remote: false, frameAt: 1, instance: 'test' }] } : url.includes('/lineage?') ? { groups: [group] } : { frame: `frame-${calls.length}` }; return { ok: true, json: async () => body }; };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { interval = callback; });
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    expect(elements.get('lineageCards')!.children).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith('/frame'))).toHaveLength(3);
    expect(elements.get('lineageCards')!.children[1]!.querySelector('.lineage-meta')!.textContent).toContain('부모 PTY: parent');
    interval!(); await settleView();
    expect(calls.filter((url) => url.endsWith('/frame'))).toHaveLength(5);
    // ⛔⭐⭐⭐ 폴링이 카드를 «다시 쓰는지» 「또 만드는지」 — 이 한 줄이 없어서 무한 증식이 통과했다.
    //   카드 키에 U+0000 이 들어 있어 CSS 선택자로 만들면 실물 브라우저에서도 «영원히» 안 맞는다
    //   (CSS Syntax §3.3 이 U+0000 을 U+FFFD 로 치환한다) ⇒ 2초마다 카드가 하나씩 쌓였다.
    expect(elements.get('lineageCards')!.children).toHaveLength(2);
    interval!(); await settleView();
    expect(elements.get('lineageCards')!.children).toHaveLength(2);
  });

  test('hides exited lineage cards by default and shows their raw records only after the dedicated button', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const rows = [
      ...Array.from({ length: 7 }, (_, index) => ({ ptyId: `live-${index + 1}`, kind: index === 0 ? 'tui' : 'agent', instance: 'test:root', alive: true, startedAt: index + 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/shared', codeSha: 'abc' })),
      { ptyId: 'dead-1', kind: 'agent', instance: 'test:root', alive: false, startedAt: 8, closedAt: 9, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/shared', codeSha: 'abc' },
      { ptyId: 'dead-2', kind: 'agent', instance: 'test:root', alive: false, startedAt: 9, closedAt: 10, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/shared', codeSha: 'abc' },
    ];
    const group = { joinedBy: 'workdir-heuristic', key: '/tmp/shared', parentMissing: true, rows };
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = url === '/v1/terminals'
        ? { terminals: rows.filter((row) => row.alive).map((row) => ({ id: row.ptyId, alive: true, remote: false, frameAt: 1, instance: 'test:root' })) }
        : url.includes('/lineage?') ? { groups: [group], unreadablePayloads: 0 } : url.includes('/frame') ? { frame: url } : { scrollback: 'raw record' };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    const lineageButton = elements.get('lineageList')!.children[0]!.children[0]!;
    expect(lineageButton.getAttribute('aria-label')).toContain('workdir-heuristic 모호');
    expect(lineageButton.getAttribute('aria-label')).toContain('부모 행이 이 인스턴스에 없음');
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]')).toHaveLength(6);
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]').map((card) => lineageCardTitle(card))).toEqual(['live-1 · tui · test:root · 실행중', 'live-2 · agent · test:root · 실행중', 'live-3 · agent · test:root · 실행중', 'live-4 · agent · test:root · 실행중', 'live-5 · agent · test:root · 실행중', 'live-6 · agent · test:root · 실행중']);
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 2개 보기');
    expect(elements.get('lineageDead')!.getAttribute('aria-expanded')).toBe('false');
    expect(calls.some((url) => url.includes('/dead-'))).toBe(false);

    elements.get('lineageDead')!.onclick!();
    await settleView();
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]')).toHaveLength(6);
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]').map((card) => lineageCardTitle(card))).toEqual(['live-1 · tui · test:root · 실행중', 'live-2 · agent · test:root · 실행중', 'live-3 · agent · test:root · 실행중', 'live-4 · agent · test:root · 실행중', 'dead-1 · agent · test:root · 종료됨', 'dead-2 · agent · test:root · 종료됨']);
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 2개 감추기');
    expect(elements.get('lineageDead')!.getAttribute('aria-expanded')).toBe('true');
    const deadCard = elements.get('lineageCards')!.querySelectorAll('[data-pty-key]').find((card) => lineageCardTitle(card).startsWith('dead-1'))!;
    expect(deadCard.children[2]!.children.map((span) => span.textContent).join('')).toContain('종료됨 · 현재 화면이 아닌 기록');
    expect(calls.some((url) => url.includes('/dead-1/frame'))).toBe(false);
    expect(calls.some((url) => url.includes('/dead-2/frame'))).toBe(false);
    expect(calls.some((url) => url.includes('/dead-1/scrollback?lines=400'))).toBe(true);
    expect(calls.some((url) => url.includes('/dead-2/scrollback?lines=400'))).toBe(true);
  });

  test('fills all six lineage-card slots with exited records after the dedicated button', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const rows = Array.from({ length: 6 }, (_, index) => ({ ptyId: `dead-${index + 1}`, kind: 'agent', instance: 'test', alive: false, startedAt: index + 1, closedAt: index + 2, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/dead', codeSha: 'abc' }));
    const group = { joinedBy: 'parent', key: 'dead-root', parentMissing: false, rows };
    const calls: string[] = [];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      calls.push(url);
      const body = url === '/v1/terminals' ? { terminals: [{ id: 'dead-1', alive: true, remote: false, frameAt: 1, instance: 'test' }] } : url.includes('/lineage?') ? { groups: [group], unreadablePayloads: 0 } : { scrollback: 'raw record' };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]')).toHaveLength(0);
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 6개 보기');
    expect(calls).toContain('/v1/terminals/dead-1/frame');
    expect(calls.some((url) => url.includes('/dead-2/'))).toBe(false);

    elements.get('lineageDead')!.onclick!();
    await settleView();
    const cards = elements.get('lineageCards')!.querySelectorAll('[data-pty-key]');
    expect(cards).toHaveLength(6);
    expect(cards.map((card) => lineageCardTitle(card))).toEqual(['dead-1 · agent · test · 종료됨', 'dead-2 · agent · test · 종료됨', 'dead-3 · agent · test · 종료됨', 'dead-4 · agent · test · 종료됨', 'dead-5 · agent · test · 종료됨', 'dead-6 · agent · test · 종료됨']);
    expect(elements.get('lineageCards')!.querySelector('.more')).toBeNull();
    expect(calls.filter((url) => url.includes('/scrollback?lines=400'))).toHaveLength(6);
    expect(calls).toContain('/v1/terminals/dead-1/frame');
  });

  test('resets shown dead records when keyboard navigation or polling selects another lineage', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const group = (key: string) => ({ joinedBy: 'parent', key, parentMissing: false, rows: [
      { ptyId: `${key}-live`, kind: 'tui', instance: 'test', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/w', codeSha: 'abc' },
      { ptyId: `${key}-dead`, kind: 'agent', instance: 'test', alive: false, startedAt: 1, closedAt: 2, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/w', codeSha: 'abc' },
    ] });
    const alpha = group('alpha');
    const beta = group('beta');
    let phase = 0;
    let interval: (() => void) | undefined;
    let keydown: ((event: { key: string; preventDefault(): void }) => void) | undefined;
    const document = {
      getElementById: (id: string) => elements.get(id)!,
      createElement: (tag: string) => new ViewElement(tag),
      addEventListener: (name: string, listener: (event: { key: string; preventDefault(): void }) => void) => { if (name === 'keydown') keydown = listener; },
    };
    const fetch = async (url: string) => {
      const groups = phase === 0 ? [alpha, beta] : [beta];
      const terminals = groups.map((entry) => ({ id: entry.rows[0]!.ptyId, alive: true, remote: false, frameAt: 1, instance: 'test' }));
      const body = url === '/v1/terminals' ? { terminals } : url.includes('/lineage?') ? { groups, unreadablePayloads: 0 } : { frame: url };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { interval = callback; });
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    elements.get('lineageDead')!.onclick!();
    await settleView();
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 1개 감추기');
    keydown!({ key: 'ArrowDown', preventDefault() {} });
    await settleView();
    expect(elements.get('lineageHead')!.textContent).toContain('beta');
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 1개 보기');
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]').map((card) => lineageCardTitle(card))).toEqual(['beta-live · tui · test · 실행중']);

    keydown!({ key: 'ArrowUp', preventDefault() {} });
    await settleView();
    elements.get('lineageDead')!.onclick!();
    await settleView();
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 1개 감추기');
    phase = 1;
    interval!();
    await settleView();
    expect(elements.get('lineageHead')!.textContent).toContain('beta');
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 1개 보기');
    expect(elements.get('lineageCards')!.querySelectorAll('[data-pty-key]').map((card) => lineageCardTitle(card))).toEqual(['beta-live · tui · test · 실행중']);
  });

  test('click selection uses the complete lineage identity, survives polling, and surfaces unreadable payloads', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('follow')!.checked = true; elements.get('frameMode')!.checked = true;
    const parentGroup = { joinedBy: 'parent', key: 'root', parentMissing: false, rows: [{ ptyId: 'root', kind: 'tui', instance: 'test', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: 'run-1', workdir: '/tmp/w', codeSha: 'abc' }] };
    const runGroup = { joinedBy: 'run', key: 'root-child', parentMissing: false, rows: [{ ptyId: 'child', kind: 'agent', instance: 'test', alive: true, startedAt: 2, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: 'root-child', workdir: '/tmp/w', codeSha: 'abc' }] };
    let interval: (() => void) | undefined;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      const body = url === '/v1/terminals' ? { terminals: [{ id: 'root', alive: true, remote: false, frameAt: 1, instance: 'test' }, { id: 'child', alive: true, remote: false, frameAt: 1, instance: 'test' }] } : url.includes('/lineage?') ? { groups: [parentGroup, runGroup], unreadablePayloads: 1 } : { frame: url };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { interval = callback; });
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    const buttons = elements.get('lineageList')!.children.map((item) => item.children[0]!);
    expect(buttons).toHaveLength(2);
    expect(elements.get('lineageWarning')!.textContent).toContain('일부를 읽지 못함 · 1개');
    buttons[1]!.onclick!();
    expect(buttons.map((button) => button.getAttribute('aria-current'))).toEqual(['false', 'true']);
    expect(elements.get('lineageHead')!.textContent).toContain('root-child');
    interval!(); await settleView();
    expect(elements.get('lineageList')!.children.map((item) => item.children[0]!.getAttribute('aria-current'))).toEqual(['false', 'true']);
    expect(elements.get('lineageHead')!.textContent).toContain('root-child');
  });

  test('keeps the unreadable-ledger warning when no lineage group can be rendered', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      const body = url === '/v1/terminals'
        ? { terminals: [{ id: 'only-live', alive: true, remote: false, frameAt: 0, instance: 'test' }] }
        : { groups: [], unreadablePayloads: 1 };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    expect(elements.get('lineageHead')!.textContent).toContain('표시할 계보가 없습니다.');
    expect(elements.get('lineageWarning')!.textContent).toContain('계보 원장 일부를 읽지 못함 · 1개');
  });

  test('clears a stale unreadable-ledger warning when the next lineage refresh fails', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    let interval: (() => void) | undefined;
    let lineageAttempts = 0;
    const group = { joinedBy: 'parent', key: 'only-live', parentMissing: false, rows: [
      { ptyId: 'only-live', kind: 'tui', instance: 'test', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: '', workdir: '/tmp/w', codeSha: 'abc' },
      { ptyId: 'stale-dead', kind: 'agent', instance: 'test', alive: false, startedAt: 1, closedAt: 2, parentPtyId: 'only-live', parentPid: 0, parentKind: 'tui', runId: '', workdir: '/tmp/w', codeSha: 'abc' },
    ] };
    const fetch = async (url: string) => {
      if (url === '/v1/terminals') return { ok: true, json: async () => ({ terminals: [{ id: 'only-live', alive: true, remote: false, frameAt: 0, instance: 'test' }] }) };
      if (url.includes('/lineage?') && ++lineageAttempts > 1) throw new Error('lineage unavailable');
      return { ok: true, json: async () => ({ groups: [group], unreadablePayloads: 1 }) };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { interval = callback; });
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    expect(elements.get('lineageWarning')!.textContent).toContain('일부를 읽지 못함 · 1개');
    expect(elements.get('lineageDead')!.textContent).toBe('종료된 기록 1개 보기');
    expect(elements.get('lineageDead')!.onclick).not.toBeNull();
    interval!(); await settleView();
    expect(elements.get('lineageWarning')!.textContent).toBe('');
    expect(elements.get('lineageHead')!.textContent).toContain('계보 조회 오류');
    expect(elements.get('lineageDead')!.textContent).toBe('');
    expect(elements.get('lineageDead')!.getAttribute('aria-expanded')).toBe('false');
    expect(elements.get('lineageDead')!.onclick).toBeNull();
  });

  test('routes a federated selection and its lineage query through the source root', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const calls: string[] = [];
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const root = '/roots/remote/manifest.db';
    const terminals = [{ id: 'remote', cmd: 'remote', alive: true, remote: true, frameAt: 1, sourceRoot: { name: 'same-name', dbPath: root } }];
    const fetch = async (url: string) => { calls.push(url); return { ok: true, json: async () => url === '/v1/terminals' ? { terminals } : url.includes('/lineage?') ? { groups: [], unreadablePayloads: 0 } : { frame: 'remote frame' } }; };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('list')!.children[0]!.children[0]!.onclick!();
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    const source = 'sourceRoot='+encodeURIComponent(root);
    expect(calls).toContain('/v1/terminals/remote/frame?'+source);
    expect(calls).toContain('/v1/terminals/lineage?key=remote&'+source);
  });

  test('keeps identical lineage IDs from separate roots distinct and fetches each source-root frame', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const rootA = '/roots/a/manifest.db';
    const rootB = '/roots/b/manifest.db';
    const calls: string[] = [];
    const group = { joinedBy: 'run', key: 'same-run', parentMissing: false, rows: [{ ptyId: 'same-id', kind: 'agent', instance: 'same', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: 'same-run', workdir: '/tmp/w', codeSha: 'abc' }] };
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const terminals = [
      { id: 'same-id', alive: true, remote: true, frameAt: 1, instance: 'same', sourceRoot: { name: 'same', dbPath: rootA } },
      { id: 'same-id', alive: true, remote: true, frameAt: 1, instance: 'same', sourceRoot: { name: 'same', dbPath: rootB } },
    ];
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => url === '/v1/terminals' ? { terminals } : url.includes('/lineage?') ? { groups: [group], unreadablePayloads: 0 } : { frame: url } };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    expect(elements.get('lineageList')!.children).toHaveLength(2);
    expect(elements.get('lineageCards')!.children).toHaveLength(1);
    elements.get('lineageList')!.children[1]!.children[0]!.onclick!();
    await settleView();
    expect(calls).toContain('/v1/terminals/same-id/frame?sourceRoot='+encodeURIComponent(rootA));
    expect(calls).toContain('/v1/terminals/same-id/frame?sourceRoot='+encodeURIComponent(rootB));
  });

  test('maximizes one lineage card through polling, restores it with the same control, and clears it when the card disappears', async () => {
    const html = await handleTerminalsView().text();
    expect(html).toContain('lineageMaximizedKey');
    expect(html).toContain('lineage-maximize');
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const parent = { ptyId: 'parent', kind: 'tui', instance: 'test', alive: true, startedAt: 1, closedAt: 0, parentPtyId: '', parentPid: 0, parentKind: '', runId: 'run-1', workdir: '/tmp/w', codeSha: 'abc' };
    const child = { ptyId: 'child', kind: 'agent', instance: 'test', alive: true, startedAt: 2, closedAt: 0, parentPtyId: 'parent', parentPid: 1, parentKind: 'tui', runId: 'run-1', workdir: '/tmp/w', codeSha: 'abc' };
    let phase = 0;
    let interval: (() => void) | undefined;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const fetch = async (url: string) => {
      const rows = phase === 2 ? [child] : [parent, child];
      const terminals = rows.map((row) => ({ id: row.ptyId, alive: true, remote: false, frameAt: 1, instance: 'test' }));
      const body = url === '/v1/terminals' ? { terminals } : url.includes('/lineage?') ? { groups: [{ joinedBy: 'parent', key: 'root', parentMissing: false, rows }], unreadablePayloads: 0 } : { frame: 'frame-'+phase+'-'+url };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, (callback: () => void) => { interval = callback; });
    await settleView();
    elements.get('lineageMode')!.checked = true; elements.get('lineageMode')!.dispatch('change');
    await settleView();
    const cards = () => elements.get('lineageCards')!.querySelectorAll('[data-pty-key]');
    const parentCard = () => cards().find((card) => lineageCardTitle(card).startsWith('parent'))!;
    const childCard = () => cards().find((card) => lineageCardTitle(card).startsWith('child'))!;
    expect(cards()).toHaveLength(2);
    parentCard().children[0]!.children[1]!.onclick!();
    await settleView();
    expect(parentCard().className).toContain('maximized');
    expect(childCard().className).toContain('hidden');
    expect(parentCard().children[0]!.children[1]!.textContent).toBe('복원');
    expect(parentCard().children[0]!.children[1]!.getAttribute('aria-pressed')).toBe('true');

    phase = 1;
    interval!(); await settleView();
    expect(cards()).toHaveLength(2);
    expect(parentCard().className).toContain('maximized');
    expect(parentCard().children[2]!.children.map((span) => span.textContent).join('')).toContain('frame-1');

    parentCard().children[0]!.children[1]!.onclick!();
    await settleView();
    expect(cards().map((card) => lineageCardTitle(card).split(' · ')[0])).toEqual(['parent', 'child']);
    expect(cards().every((card) => !card.className.includes('hidden'))).toBe(true);
    expect(parentCard().children[0]!.children[1]!.textContent).toBe('최대화');

    parentCard().children[0]!.children[1]!.onclick!();
    phase = 2;
    interval!(); await settleView();
    expect(cards().map((card) => lineageCardTitle(card).split(' · ')[0])).toEqual(['child']);
    expect(childCard().className).not.toContain('hidden');
    expect(childCard().className).not.toContain('maximized');

    childCard().children[0]!.children[1]!.onclick!();
    await settleView();
    expect(childCard().className).not.toContain('maximized');
  });

  test('preserves flat frame and scrollback position plus instance and local/remote metadata', async () => {
    const html = await handleTerminalsView().text();
    const elements = new Map(['list', 'scrollback', 'detailHead', 'summary', 'instances', 'follow', 'frameMode', 'lineageMode', 'lineageList', 'flatDetail', 'lineageDetail', 'lineageHead', 'lineageWarning', 'lineageDead', 'lineageCards', 'clock'].map((id) => [id, new ViewElement()]));
    elements.get('frameMode')!.checked = true;
    const document = { getElementById: (id: string) => elements.get(id)!, createElement: (tag: string) => new ViewElement(tag), addEventListener: () => {} };
    const terminals = [
      { id: 'remote-shell', cmd: 'remote', workdir: '/Users/example/source/elan/monad-agent.worktrees/fresh', alive: true, remote: true, frameAt: 1, instance: 'test:child', outputBytes: 10, startedAt: Date.now() - 1_000, parentPtyId: 'parent', parentPid: 1, parentKind: 'pty' },
      { id: 'local-shell', cmd: 'local', workdir: '/Users/example/source/elan/monad-agent', alive: true, remote: false, frameAt: 0, instance: 'test:root', outputBytes: 20, startedAt: Date.now() - 1_000, parentPtyId: '', parentPid: 2, parentKind: 'process' },
    ];
    const fetch = async (url: string) => {
      const body = url === '/v1/terminals' ? { terminals } : url.endsWith('/frame') ? { frame: 'rendered frame' } : { scrollback: 'raw output' };
      return { ok: true, json: async () => body };
    };
    new Function('document', 'fetch', 'setInterval', viewScript(html))(document, fetch, () => {});
    await settleView();
    const buttons = elements.get('list')!.children.map((item) => item.children[0]!);
    expect(buttons[0]!.getAttribute('aria-label')).toContain('인스턴스 test:child');
    expect(buttons[1]!.getAttribute('aria-label')).toContain('인스턴스 test:root');
    expect(buttons[0]!.innerHTML).toContain('elan/fresh');
    expect(buttons[0]!.innerHTML).toContain('부모 P:parent');
    expect(buttons[1]!.innerHTML).toContain('elan');
    expect(buttons[1]!.innerHTML).toContain('부모 p:2');

    elements.get('scrollback')!.scrollTop = 37;
    buttons[0]!.onclick!(); await settleView();
    expect(elements.get('scrollback')!.scrollTop).toBe(37);
    expect(elements.get('detailHead')!.textContent).toContain('원격(test:child)');

    elements.get('frameMode')!.checked = false;
    elements.get('scrollback')!.scrollTop = 19;
    elements.get('frameMode')!.dispatch('change'); await settleView();
    expect(elements.get('scrollback')!.scrollTop).toBe(19);

    elements.get('follow')!.checked = true;
    elements.get('scrollback')!.scrollHeight = 240;
    buttons[1]!.onclick!(); await settleView();
    expect(elements.get('scrollback')!.scrollTop).toBe(240);
    expect(elements.get('detailHead')!.textContent).toContain('· 로컬');
  });
});

describe('handleTerminals* — auth gate', () => {
  test('auth trace denial responses safely merge bearer mismatches while the terminal gate stays unchanged', async () => {
    resetAuthTraceForTest();
    const optsWithToken: MetaApiOpts = { bearerToken: 'secret-xyz' };
    const missingHeader = handleAuthTraceGet(new Request('http://localhost/v1/diag/auth-trace'), optsWithToken);
    const lengthMismatch = handleAuthTraceGet(new Request('http://localhost/v1/diag/auth-trace', {
      headers: { authorization: 'Bearer short' },
    }), optsWithToken);
    const valueMismatch = handleAuthTraceGet(new Request('http://localhost/v1/diag/auth-trace', {
      headers: { authorization: 'Bearer abcdefghij' },
    }), optsWithToken);

    expect(missingHeader.status).toBe(401);
    expect(lengthMismatch.status).toBe(401);
    expect(valueMismatch.status).toBe(401);
    expect(await missingHeader.json()).toEqual({ error: 'unauthorized', reason: 'missing-auth-header' });
    expect(await lengthMismatch.json()).toEqual({ error: 'unauthorized', reason: 'invalid-bearer' });
    expect(await valueMismatch.json()).toEqual({ error: 'unauthorized', reason: 'invalid-bearer' });
    expect(authTraceSnapshot().map((entry) => entry.reason)).toEqual([
      'missing-auth-header',
      'bearer-length-mismatch',
      'bearer-mismatch',
    ]);

    const terminalResponse = handleTerminalsList(bareReq(), optsWithToken);
    expect(terminalResponse.status).toBe(401);
    expect(await terminalResponse.json()).toEqual({ error: 'unauthorized' });
    resetAuthTraceForTest();
  });

  test('with bearerToken set + correct header → 200', async () => {
    const optsWithToken: MetaApiOpts = { bearerToken: 'secret-xyz' };
    const req = new Request('http://localhost/v1/terminals', {
      headers: { authorization: 'Bearer secret-xyz' },
    });
    const res = handleTerminalsList(req, optsWithToken);
    expect(res.status).toBe(200);
  });

  test('scrollback also gated by bearer', async () => {
    const optsWithToken: MetaApiOpts = { bearerToken: 'secret-xyz' };
    const h = spawnWith('hi');
    const res = handleTerminalScrollback(bareReq(), optsWithToken, h.id, bareUrl());
    expect(res.status).toBe(401);
  });
});
