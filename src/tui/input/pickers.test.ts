/**
 * TUI-DIET-SEAM-PICKERS — behaviour tests for createInputPickers.
 *
 * The real modal openers (createFinderModal / createSearchModal /
 * createTransferPickerModal / createSshPickerModal) run unchanged; only
 * the display coordinator, the scanners and the dashboard closures are
 * fakes. Assertions are on behaviour (modal push/dispose, key-binding
 * lifecycle, state writes through the accessors, navigation), never on
 * source text.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchModalHandle } from '../../chat/search/modal.js';
import { createWorkingDirState, type WorkingDirState } from '../../working-dir/index.js';
import { createInputPickers, type InputPickersDeps, type InputPickersState } from './pickers.js';

interface FakeBinding { id: string; key: string; when?: () => boolean; handler: () => unknown; disposed: boolean }
interface FakeModal { surface: unknown; disposed: boolean }

function makeHarness(root: string, overrides: Partial<InputPickersDeps> = {}) {
  const modals: FakeModal[] = [];
  const bindings: FakeBinding[] = [];
  const display = {
    pushModal(surface: unknown) {
      const m: FakeModal = { surface, disposed: false };
      modals.push(m);
      return { id: `m${modals.length}`, dispose: () => { m.disposed = true; } };
    },
    registerKeyBinding(b: { id: string; key: string; when?: () => boolean; handler: () => unknown }) {
      const fb: FakeBinding = { ...b, disposed: false };
      bindings.push(fb);
      return { dispose: () => { fb.disposed = true; } };
    },
  };
  let agentSearchModal: SearchModalHandle | null = null;
  let agentSearchHandle: { dispose: () => void } | null = null;
  let agentRosterCursor = 0;
  let agentCursorLockedId = '';
  let agentCursorManual = false;
  let chatScrollOffset = 5;
  const chatLines: string[] = [];
  const state: InputPickersState = {
    get agentSearchModal() { return agentSearchModal; },
    set agentSearchModal(v) { agentSearchModal = v; },
    get agentSearchHandle() { return agentSearchHandle; },
    set agentSearchHandle(v) { agentSearchHandle = v; },
    get agentRosterCursor() { return agentRosterCursor; },
    set agentRosterCursor(v) { agentRosterCursor = v; },
    get agentCursorLockedId() { return agentCursorLockedId; },
    set agentCursorLockedId(v) { agentCursorLockedId = v; },
    get agentCursorManual() { return agentCursorManual; },
    set agentCursorManual(v) { agentCursorManual = v; },
    get chatScrollOffset() { return chatScrollOffset; },
    set chatScrollOffset(v) { chatScrollOffset = v; },
    get chatLines() { return chatLines; },
  };
  const events: string[] = [];
  const focusCalls: Array<[string, string | undefined]> = [];
  const scanCalls: Array<Record<string, unknown>> = [];
  let draws = 0;
  const workingDir: WorkingDirState = createWorkingDirState(root);
  const deps: InputPickersDeps = {
    state,
    display: display as unknown as InputPickersDeps['display'],
    agentSurfaceStore: {
      syncTasks: () => [
        { id: 'aaaa1111-first', name: 'alpha', definitionName: 'def-a', summary: '' },
        { id: 'bbbb2222-second', name: 'beta', definitionName: 'def-b', summary: 'second agent' },
      ],
    } as unknown as InputPickersDeps['agentSurfaceStore'],
    workingDir,
    dockedPreview: {} as InputPickersDeps['dockedPreview'],
    transferFeedbackRuntime: {
      onNoFilesToTransfer: () => { events.push('transfer:no-files'); },
      onTransferDisabled: (reason) => { events.push(`transfer:disabled:${reason ?? ''}`); },
      onNoTransferTargets: () => { events.push('transfer:no-targets'); },
    },
    finderFeedbackRuntime: {
      onFinderScanStarted: (t) => { events.push(`scan:start:${t}`); },
      onFinderScanCompleted: (o) => { events.push(`scan:done:${o.count}:${o.backend}`); },
      onFinderScanEmpty: () => { events.push('scan:empty'); },
      onSshConnectStarted: (o) => { events.push(`ssh:start:${o.name}`); },
      onSshConnectSucceeded: (n) => { events.push(`ssh:ok:${n}`); },
      onSshConnectFailed: (n, m) => { events.push(`ssh:fail:${n}:${m}`); },
    },
    currentThemeTokens: () => undefined as unknown as ReturnType<InputPickersDeps['currentThemeTokens']>,
    currentWorkspaceOwnerId: () => 'test-workspace',
    activeBrowserWidgetId: () => 'browser:test',
    resolveBrowserStateById: () => null,
    fmtBytes: (n) => `${n}B`,
    runTransfer: async () => { events.push('transfer:run'); },
    closeAgentRosterSearch: () => {
      events.push('roster:close');
      agentSearchHandle?.dispose();
      agentSearchHandle = null;
      agentSearchModal = null;
    },
    pushDebugLine: (line) => { events.push(`debug:${line}`); },
    refreshRemotePreviewBridge: async () => {},
    refreshWorkingDirPreview: () => { events.push('preview:refresh'); },
    setWorkingFocus: (next, reason) => { focusCalls.push([next, reason]); },
    startRemoteModeBridge: () => {},
    draw: () => { draws += 1; },
    ...overrides,
  };
  return {
    deps,
    pickers: createInputPickers(deps),
    modals,
    bindings,
    events,
    focusCalls,
    scanCalls,
    workingDir,
    chatLines,
    get draws() { return draws; },
    get modal() { return agentSearchModal; },
    get handle() { return agentSearchHandle; },
    get cursor() { return { agentRosterCursor, agentCursorLockedId, agentCursorManual }; },
    get chatScrollOffset() { return chatScrollOffset; },
  };
}

let root = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tui-pickers-')));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'target.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'other.txt'), 'x');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fakeScan = (paths: string[], calls?: Array<Record<string, unknown>>) =>
  (async (opts: Record<string, unknown> = {}) => {
    calls?.push(opts);
    return { paths, truncated: false, backend: 'fd' as const, durationMs: 3 };
  }) as unknown as NonNullable<InputPickersDeps['scanFinder']>;

describe('createInputPickers — openFinderPicker', () => {
  test('accept: disposes modal + all three preview bindings, navigates to the file, focuses browser', async () => {
    const target = join(root, 'sub', 'target.txt');
    const h = makeHarness(root, { scanFinder: fakeScan([target]) });
    await h.pickers.openFinderPicker();

    expect(h.modals).toHaveLength(1);
    expect(h.modal).not.toBeNull();
    expect(h.bindings.map((b) => b.key).sort()).toEqual(['C-/', 'C-]', 'C-_']);
    expect(h.events).toContain('scan:done:1:fd');
    // Bindings are scoped to THIS picker via the live state accessor.
    const slash = h.bindings.find((b) => b.key === 'C-/')!;
    expect(slash.when?.()).toBe(true);

    h.modal!.accept();

    expect(h.modals[0]!.disposed).toBe(true);
    expect(h.bindings.every((b) => b.disposed)).toBe(true);
    expect(h.modal).toBeNull();
    expect(slash.when?.()).toBe(false);
    expect(h.workingDir.cwd).toBe(join(root, 'sub'));
    expect(h.workingDir.entries[h.workingDir.cursor]?.name).toBe('target.txt');
    expect(h.focusCalls).toEqual([['browser', 'agent-roster-search-pick']]);
    expect(h.chatScrollOffset).toBe(-1);
    expect(h.events).toContain('preview:refresh');
  });

  test('cancel: disposes modal + bindings without navigating', async () => {
    const h = makeHarness(root, { scanFinder: fakeScan([join(root, 'sub', 'target.txt')]) });
    const before = h.workingDir.cwd;
    await h.pickers.openFinderPicker();
    h.modal!.cancel();
    expect(h.modals[0]!.disposed).toBe(true);
    expect(h.bindings.every((b) => b.disposed)).toBe(true);
    expect(h.modal).toBeNull();
    expect(h.workingDir.cwd).toBe(before);
    expect(h.focusCalls).toEqual([]);
  });

  test('Ctrl+/ cycles preview mode through the chatLines/chatScrollOffset accessors', async () => {
    const h = makeHarness(root, { scanFinder: fakeScan([join(root, 'sub', 'target.txt')]) });
    await h.pickers.openFinderPicker();
    const slash = h.bindings.find((b) => b.key === 'C-/')!;
    slash.handler();
    expect(h.chatLines.at(-1)).toContain('finder preview: HOVER');
    expect(h.chatScrollOffset).toBe(-1);
    h.modal!.cancel();
  });

  test('empty scan: reports empty and opens no modal', async () => {
    const h = makeHarness(root, { scanFinder: fakeScan([]) });
    await h.pickers.openFinderPicker();
    expect(h.events).toContain('scan:empty');
    expect(h.modals).toHaveLength(0);
    expect(h.bindings).toHaveLength(0);
    expect(h.modal).toBeNull();
  });
});

describe('createInputPickers — openDirectoryPicker', () => {
  test('scans dirs and accept cd’s the browser + focuses it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = makeHarness(root, { scanFinder: fakeScan([join(root, 'sub')], calls) });
    await h.pickers.openDirectoryPicker();
    expect(calls[0]?.kind).toBe('dir');
    h.modal!.accept();
    expect(h.modals[0]!.disposed).toBe(true);
    expect(h.modal).toBeNull();
    expect(h.workingDir.cwd).toBe(join(root, 'sub'));
    expect(h.focusCalls).toEqual([['browser', 'alt-c-dir-pick']]);
  });

  test('remote mode is refused with a warning and no scan', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = makeHarness(root, { scanFinder: fakeScan([join(root, 'sub')], calls) });
    (h.workingDir as unknown as { remote: unknown }).remote = { host: { name: 'h' }, cwd: '/' };
    await h.pickers.openDirectoryPicker();
    expect(calls).toHaveLength(0);
    expect(h.modals).toHaveLength(0);
    expect(h.chatLines.at(-1)).toContain('directory finder is local-only');
    expect(h.chatScrollOffset).toBe(-1);
  });
});

describe('createInputPickers — openAgentRosterSearch', () => {
  test('accept writes cursor/lock/manual through the accessors and closes via the passed-in closer', () => {
    const h = makeHarness(root);
    h.pickers.openAgentRosterSearch();
    expect(h.modals).toHaveLength(1);
    expect(h.handle).not.toBeNull();
    // Re-open while active is a no-op.
    h.pickers.openAgentRosterSearch();
    expect(h.modals).toHaveLength(1);

    h.modal!.down();
    h.modal!.accept();
    expect(h.cursor).toEqual({ agentRosterCursor: 1, agentCursorLockedId: 'bbbb2222-second', agentCursorManual: true });
    expect(h.events).toContain('roster:close');
    expect(h.modals[0]!.disposed).toBe(true);
    expect(h.modal).toBeNull();
  });

  test('cancel closes without moving the cursor', () => {
    const h = makeHarness(root);
    h.pickers.openAgentRosterSearch();
    h.modal!.cancel();
    expect(h.cursor).toEqual({ agentRosterCursor: 0, agentCursorLockedId: '', agentCursorManual: false });
    expect(h.events).toContain('roster:close');
  });
});

describe('createInputPickers — openTransferPicker / openSshPicker', () => {
  test('transfer with no files reports and opens nothing', () => {
    const h = makeHarness(root);
    h.pickers.openTransferPicker([]);
    expect(h.events).toEqual(['transfer:no-files']);
    expect(h.modals).toHaveLength(0);
  });

  test('ssh picker opens a modal and cancel disposes it', () => {
    const h = makeHarness(root);
    h.pickers.openSshPicker();
    expect(h.modals).toHaveLength(1);
    expect(h.modal).not.toBeNull();
    h.modal!.cancel();
    expect(h.modals[0]!.disposed).toBe(true);
    expect(h.modal).toBeNull();
  });
});
