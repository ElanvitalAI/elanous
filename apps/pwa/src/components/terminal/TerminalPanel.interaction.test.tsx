// TerminalPanel INTERACTION contract — the question TerminalPanel.test.tsx cannot answer.
//
// ⭐ Why a second file: that one renders with `renderToStaticMarkup`, which drops
// every handler with the tree and runs no effects, so it can only pin initial
// markup. The question here is behavioral — "when a person clicks a row that lives
// in another universe, does that row's source root reach the daemon call?" — and it
// is only answerable by executing the real onClick. Keeping the two apart also
// keeps this file's module mocks off the SSR contract next door.
//
// ⛔ This is not a DOM test. See react-hook-harness.ts for what the runtime is not.

import { createRequire } from 'node:module';

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import type { DaemonTerminalRenameResult, DaemonTerminalSummary } from '@/lib/daemon-client';

const require = createRequire(import.meta.url);
// ⛔ The `react` module is NOT mocked — see react-hook-harness.ts. Hooks are driven
// through React's own dispatcher slot for the duration of a render pass, so this
// file leaves nothing behind for the sibling suites sharing the process.
const harness = createReactHookHarness(require('react'));

// ⛔ The child components are NOT stubbed, deliberately. The harness calls only the
// top-level component function — it does no reconciliation — so `<XtermView …>` is
// an unrendered element and its module never executes browser code. Stubbing them
// would replace those modules process-wide and turn their own suites red.
// Only the hooks TerminalPanel calls directly need standing in for.
// R-TST23 — the mock.module lines below are process-global. Snapshot the originals and put
// them back after this file (`@/lib/testing/restore-module-mocks`) — without this the fake
// DaemonProvider reached IntakeFrontDoor.test.tsx in the same process (6 red · 09-27).
await restoreModuleMocksAfterAll([
  'sonner', '@/lib/debug', '@/lib/use-pointer-capability', '@/lib/secure-context-guard',
  '@/voice/use-voice-controller', '@/components/providers/DaemonProvider',
], (specifier) => import(specifier));
const actualDaemonProvider = { ...(await import('@/components/providers/DaemonProvider')) };
mock.module('sonner', () => ({ toast: {
  error: (message: string) => { toastMessages.push({ level: 'error', message }); },
  success: (message: string) => { toastMessages.push({ level: 'success', message }); },
} }));
const debugEvents: string[] = [];
mock.module('@/lib/debug', () => ({ debugLog: (event: string) => { debugEvents.push(event); } }));
mock.module('@/lib/use-pointer-capability', () => ({ usePointerCapability: () => ({ isCoarsePointer: false }) }));
mock.module('@/lib/secure-context-guard', () => ({ checkSecureContext: () => ({ isSecure: true }) }));
let onVoiceTranscript: ((text: string) => void) | undefined;
mock.module('@/voice/use-voice-controller', () => ({
  useVoiceController: ({ onTranscript }: { onTranscript: (text: string) => void }) => {
    onVoiceTranscript = onTranscript;
    return { active: false, phase: 'idle', toggle: async () => {} };
  },
}));

/** The PTY the daemon reports from ANOTHER manifest root — the case the whole
 *  source-root contract exists for. `sourceRoot` is what a detail request must
 *  carry; without it the daemon resolves the id against its own root and 404s. */
const FOREIGN = {
  id: 'tui:85858', alive: true, instance: 'prod', kind: 'tui', cmd: 'elanous', startedAt: 1,
  sourceRoot: { name: 'prod', dbPath: '/roots/prod/pty/manifest.db' },
} as unknown as DaemonTerminalSummary;
const LOCAL = { ...FOREIGN, id: 'tui:100', instance: 'local', sourceRoot: undefined } as DaemonTerminalSummary;

const calls: Array<{ endpoint: string; id: string; options: unknown }> = [];
const listOptions: unknown[] = [];
const renameCalls: Array<{ id: string; name: string }> = [];
let acpConnections = 0;
const toastMessages: Array<{ level: 'success' | 'error'; message: string }> = [];
let renameResult: { status: 'success'; id: string; name: string } | { status: 'invalid-name' | 'unknown-pty' | 'denied' | 'failed' | 'owner-unreachable' } = { status: 'success', id: FOREIGN.id, name: 'renamed' };
let promptResult: string | null = null;
let listed: DaemonTerminalSummary[] = [FOREIGN];
// ⛔ 「조회 실패」와 「목록이 비었다」가 다른 값인지 재기 위한 이음매(리뷰 must-fix 2026-08-19).
let listFails = false;

// ⛔ One stable client for the whole file. The real DaemonProvider memoizes its
// value; a mock that rebuilds the object every render changes `client` identity on
// every pass, which re-fires the list effect forever. That is a defect of the mock,
// not of the panel, and it must not be papered over with a render cap.
const client = {
  voiceWsUrl: () => '',
  connectAcp: () => { acpConnections += 1; throw new Error('voice must use the registered terminal input sender'); },
  listTerminals: async (options: unknown) => { listOptions.push(options); if (listFails) throw new Error('list boom'); return { terminals: listed, scope: undefined }; },
  listProgressFrames: async () => ({ logs: [] }),
  fetchTerminalLineage: async (id: string) => ({ key: id, rows: [] }),
  fetchTerminalScrollback: async (id: string, lines: number, options: unknown) => {
    calls.push({ endpoint: 'scrollback', id, options });
    return { id, lines, totalLines: lines, scrollback: 'remote output' };
  },
  fetchTerminalFrame: async (id: string, options: unknown) => {
    calls.push({ endpoint: 'frame', id, options });
    return { id, frame: 'remote frame', frameAt: 1, frameSource: 'stored' };
  },
  renameTerminal: async (id: string, name: string) => {
    renameCalls.push({ id, name });
    return renameResult;
  },
};
const daemon = { client, config: { baseUrl: '', token: '' }, sessionId: 'session-test' };
// Keep the real exports (DaemonContext …): TerminalPanel's own tree imports them.
mock.module('@/components/providers/DaemonProvider', () => ({ ...actualDaemonProvider, useDaemon: () => daemon }));

// TerminalPanel reads window in effects, and the harness runs effects.
// ⛔ Restored in afterAll: `globalThis` outlives this file, and a leftover fake
// window would make a later suite believe it is in a browser.
// ⚠️ `mock.restore()` does not revert module mocks in this Bun build (measured) —
// the module mocks are put back by restoreModuleMocksAfterAll above instead.
const storage = new Map<string, string>();
const priorWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  prompt: () => promptResult,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  },
};
afterAll(() => {
  harness.unmount();
  if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = priorWindow;
});

function button(text: string) {
  const found = harness.findAll((element) => element.type === 'button' && harness.textOf(element).includes(text));
  if (found.length === 0) throw new Error(`no button reading "${text}"`);
  return found[0]!;
}
function click(element: { props: Record<string, unknown> }): void {
  harness.act(() => (element.props.onClick as () => void)());
}

/** Render → open the PTY list → click the only row. Returns the row element so a
 *  test can assert what it displayed. */
async function renderPanel(props: Record<string, unknown> = {}): Promise<void> {
  const { TerminalPanel } = await import('./TerminalPanel');
  calls.length = 0;
  listOptions.length = 0;
  renameCalls.length = 0;
  toastMessages.length = 0;
  debugEvents.length = 0;
  harness.unmount();
  harness.render(() => TerminalPanel(props as never));
  await harness.settle();
}

async function selectTheOnlyRow(): Promise<string> {
  // ⛔ Imported inside the test, not at module scope. `mock.module` replacements
  // for the sibling components stay confined that way; hoisting this import made
  // TuiMirrorView.test.tsx render this file's stub instead of its own subject.
  const { TerminalPanel } = await import('./TerminalPanel');
  calls.length = 0;
  // Without this the next render resumes the previous test's state — the list
  // effect would not re-fetch, and a stale row would be clicked instead.
  harness.unmount();
  harness.render(TerminalPanel as never);
  await harness.settle();
  click(button('PTY 목록'));
  await harness.settle();
  const row = harness.find((element) => element.props.className === 'w-full text-left');
  const text = harness.textOf(row);
  click(row);
  await harness.settle();
  return text;
}

describe('TerminalPanel · voice controls input', () => {
  test('sends trimmed dictation plus a space through the selected terminal\'s registered input sender', async () => {
    const { registerTerminalInput } = await import('./terminal-input-registry');
    listed = [LOCAL];
    storage.clear();
    await renderPanel();
    const tabs = harness.find((element) => typeof element.props.onActiveChange === 'function');
    harness.act(() => (tabs.props.onActiveChange as (id: string) => void)('voice-terminal'));
    await harness.settle();
    const pushed: string[] = [];
    const unregister = registerTerminalInput('voice-terminal', (data) => { pushed.push(data); });
    try {
      acpConnections = 0;
      const controls = harness.find((element) => element.props.onClear !== undefined && element.props.voice !== undefined);
      harness.act(() => ((controls.props.voice as { onToggle: () => void }).onToggle)());
      onVoiceTranscript!('  hello world \n');
      expect(pushed).toEqual(['hello world ']);
      expect(debugEvents).toContain('webterm.voice.stdin-inject');
      expect(acpConnections).toBe(0);
    } finally {
      unregister();
    }
  });

  test('reports an unmounted selected terminal rather than claiming its dictation was injected', async () => {
    listed = [LOCAL];
    storage.clear();
    await renderPanel();
    const tabs = harness.find((element) => typeof element.props.onActiveChange === 'function');
    harness.act(() => (tabs.props.onActiveChange as (id: string) => void)('unmounted-terminal'));
    await harness.settle();
    acpConnections = 0;
    const controls = harness.find((element) => element.props.onClear !== undefined && element.props.voice !== undefined);
    harness.act(() => ((controls.props.voice as { onToggle: () => void }).onToggle)());
    expect(onVoiceTranscript).toBeFunction();
    onVoiceTranscript!('  hello world \n');
    expect(debugEvents).toContain('webterm.voice.stdin-inject-failed');
    expect(debugEvents).not.toContain('webterm.voice.stdin-inject');
    expect(toastMessages).toEqual([{ level: 'error', message: '터미널 입력 전송 실패 — 터미널 연결을 확인하고 다시 말해 주세요.' }]);
    expect(acpConnections).toBe(0);
  });
});

describe('TerminalPanel · live PTY selection without a shell tab', () => {
  test('clicking the actual federated PTY row opens the live component without changing shell tabs or stored tabs', async () => {
    listed = [FOREIGN];
    storage.clear();
    storage.set('elanous.webterm.tabs', '["existing-shell"]');
    await renderPanel();
    click(button('PTY 목록'));
    await harness.settle();
    const tabsBefore = storage.get('elanous.webterm.tabs');
    const tabPropsBefore = harness.find((element) => typeof element.props.onTabsChange === 'function').props;
    click(harness.find((element) => element.props.className === 'w-full text-left'));
    await harness.settle();
    const { PtyLiveViewLazy: PtyLiveView } = await import('./PtyLiveView.lazy');
    const live = harness.findAll((element) => element.type === PtyLiveView);
    expect(live).toHaveLength(1);
    expect(live[0]!.props.terminal).toEqual(FOREIGN);
    const tabPropsAfter = harness.find((element) => typeof element.props.onTabsChange === 'function').props;
    expect(tabPropsAfter.activeId).toBe(tabPropsBefore.activeId);
    expect(tabPropsAfter.ptyTabSelection).toBeUndefined();
    expect(storage.get('elanous.webterm.tabs')).toBe(tabsBefore);
    harness.act(() => (live[0]!.props.onClose as () => void)());
    await harness.settle();
    expect(harness.findAll((element) => element.type === PtyLiveView)).toHaveLength(0);
    expect(harness.find((element) => typeof element.props.onTabsChange === 'function').props.activeId).toBe(tabPropsBefore.activeId);
  });
});

describe('TerminalPanel · URL PTY selection', () => {
  test('initializes a unique URL id after the list resolves without reporting a direct selection', async () => {
    listed = [FOREIGN];
    const selected: string[] = [];
    await renderPanel({ initialPtyId: FOREIGN.id, onPtySelection: (terminal: DaemonTerminalSummary) => selected.push(terminal.id) });

    expect(listOptions).toContainEqual({ all: true, includeTest: true });
    const { PtyLiveViewLazy: PtyLiveView } = await import('./PtyLiveView.lazy');
    expect(harness.find((element) => element.type === PtyLiveView).props.terminal).toEqual(FOREIGN);
    expect(calls).toEqual([{ endpoint: 'scrollback', id: FOREIGN.id, options: { sourceRoot: '/roots/prod/pty/manifest.db' } }]);
    expect(selected).toEqual([]);
  });

  test('does not guess a duplicate or unknown URL id and exposes its resolution status', async () => {
    listed = [FOREIGN, { ...FOREIGN, sourceRoot: { name: 'test', dbPath: '/roots/test/pty/manifest.db' } } as DaemonTerminalSummary];
    await renderPanel({ initialPtyId: FOREIGN.id });
    expect(calls).toEqual([]);
    click(button('PTY 목록'));
    await harness.settle();
    expect(harness.textOf(harness.find((element) => element.props['aria-label'] === 'URL PTY 선택 상태'))).toContain('선택하지 않았습니다');

    listed = [FOREIGN];
    await renderPanel({ initialPtyId: 'missing' });
    expect(calls).toEqual([]);
    click(button('PTY 목록'));
    await harness.settle();
    expect(harness.textOf(harness.find((element) => element.props['aria-label'] === 'URL PTY 선택 상태'))).toContain('찾지 못했습니다');
  });

  test('a failed list never claims the URL id was "not found" — reading failure is not absence', async () => {
    // ⛔ 회귀 방어(리뷰 must-fix 2026-08-19). 조회가 실패하면 ptyRows 는 [] 다.
    //    그것을 해석기에 그대로 넣으면 reason 이 'empty-terminal-list' 로 나와
    //    ***「목록이 비었다」는 «틀린 사실»***이 된다 — 실제로는 「못 읽었다」다.
    // 📌 그리고 이 시험이 «붙드는 전제»는 하나 더 있다: 조회가 실패하면 terminalId 가
    //    안 잡혀 PTY 목록 패널 «자체»가 안 그려진다. 그래서 지금은 오도 문면이 화면에
    //    닿지 않는다. ⛔ 그 전제가 깨지면(패널이 그려지면) 이 시험이 실패해야 한다.
    listFails = true;
    try {
      await renderPanel({ initialPtyId: FOREIGN.id });
      click(button('PTY 목록'));
      await harness.settle();
      const status = harness.findAll((element) => element.props['aria-label'] === 'URL PTY 선택 상태');
      // ⛔ 0개면 이 시험은 «아무것도 안 재는» vacuous 시험이 된다(리뷰 지적 2026-08-19).
      //    그래서 «최소 하나»를 «요구»한다 — 「못 읽었다」는 사람에게 «반드시» 닿아야 한다.
      expect(status.length).toBeGreaterThan(0);
      for (const element of status) {
        const text = harness.textOf(element);
        expect(text).toContain('읽지 못해');
        expect(text).not.toContain('찾지 못했습니다');
      }
    } finally {
      listFails = false;
    }
  });

  test('a direct row click reports the complete row once after its tab becomes active', async () => {
    listed = [FOREIGN];
    const selected: DaemonTerminalSummary[] = [];
    await renderPanel({ onPtySelection: (terminal: DaemonTerminalSummary) => selected.push(terminal) });
    click(button('PTY 목록'));
    await harness.settle();
    click(harness.find((element) => element.props.className === 'w-full text-left'));
    await harness.settle();
    expect(selected).toEqual([FOREIGN]);
    const { PtyLiveViewLazy: PtyLiveView } = await import('./PtyLiveView.lazy');
    expect(harness.findAll((element) => element.type === PtyLiveView)).toHaveLength(1);
  });
});

describe('TerminalPanel · PTY-list and shell tabs', () => {
  test('a row click opens the live view and reports that row without activating a shell tab', async () => {
    const newest = { ...LOCAL, startedAt: 2 } as DaemonTerminalSummary;
    listed = [{ ...FOREIGN, startedAt: 1 }, newest];
    const selected: DaemonTerminalSummary[] = [];
    await renderPanel({ onPtySelection: (terminal: DaemonTerminalSummary) => selected.push(terminal) });
    click(button('PTY 목록'));
    await harness.settle();
    const tabsBefore = harness.find((element) => typeof element.props.onTabsChange === 'function').props.activeId;
    const rows = harness.findAll((element) => element.props.className === 'w-full text-left');
    expect(harness.textOf(rows[0]!)).toContain(LOCAL.id);
    click(rows[0]!);
    await harness.settle();
    const { PtyLiveViewLazy: PtyLiveView } = await import('./PtyLiveView.lazy');
    expect(harness.find((element) => element.type === PtyLiveView).props.terminal).toEqual(newest);
    expect(selected).toEqual([newest]);
    expect(harness.find((element) => typeof element.props.onTabsChange === 'function').props.activeId).toBe(tabsBefore);
    expect(storage.get('elanous.webterm.activeId')).not.toBe(LOCAL.id);
  });

  test('keeps both mounted panel ids while switching to another tab and back', async () => {
    listed = [FOREIGN, LOCAL];
    await renderPanel();
    click(button('PTY 목록'));
    await harness.settle();
    click(harness.findAll((element) => element.props.className === 'w-full text-left')[0]!);
    await harness.settle();
    const tabs = harness.find((element) => typeof element.props.onTabsChange === 'function');
    harness.act(() => (tabs.props.onTabsChange as (ids: readonly string[]) => void)([FOREIGN.id, LOCAL.id]));
    await harness.settle();
    harness.act(() => (tabs.props.onActiveChange as (id: string) => void)(FOREIGN.id));
    await harness.settle();

    const panel = () => harness.find((element) => (
      Array.isArray(element.props.terminalIds)
      && element.props.layout !== undefined
      && typeof element.props.onForeignInputActivity === 'function'
    ));
    expect(panel().props.terminalIds).toEqual([FOREIGN.id, LOCAL.id]);
    expect(panel().props.activeId).toBe(FOREIGN.id);

    harness.act(() => (tabs.props.onActiveChange as (id: string) => void)(LOCAL.id));
    await harness.settle();
    expect(panel().props.terminalIds).toEqual([FOREIGN.id, LOCAL.id]);
    expect(panel().props.activeId).toBe(LOCAL.id);

    harness.act(() => (tabs.props.onActiveChange as (id: string) => void)(FOREIGN.id));
    await harness.settle();
    expect(panel().props.terminalIds).toEqual([FOREIGN.id, LOCAL.id]);
    expect(panel().props.activeId).toBe(FOREIGN.id);
  });
});

describe('TerminalPanel · PTY rename', () => {
  async function openPtyList(): Promise<void> {
    listed = [FOREIGN];
    await renderPanel();
    click(button('PTY 목록'));
    await harness.settle();
  }

  test('does not call renameTerminal when the prompt is cancelled', async () => {
    promptResult = null;
    await openPtyList();
    click(button('이름 바꾸기'));
    await harness.settle();

    expect(renameCalls).toEqual([]);
    expect(toastMessages).toEqual([]);
  });

  test('sends the row id and entered name to renameTerminal, then shows its outcome', async () => {
    promptResult = '';
    renameResult = { status: 'success', id: FOREIGN.id, name: '' };
    await openPtyList();
    click(button('이름 바꾸기'));
    await harness.settle();

    expect(renameCalls).toEqual([{ id: FOREIGN.id, name: '' }]);
    expect(toastMessages).toEqual([{ level: 'success', message: "PTY 이름을 ''(으)로 바꿨습니다." }]);
  });

  test('shows each rename outcome with its explicit feedback and toast level', async () => {
    const outcomes: Array<readonly [DaemonTerminalRenameResult, { level: 'success' | 'error'; message: string }]> = [
      [{ status: 'success', id: FOREIGN.id, name: 'renamed' }, { level: 'success', message: "PTY 이름을 'renamed'(으)로 바꿨습니다." }],
      [{ status: 'invalid-name' }, { level: 'error', message: '이 이름은 사용할 수 없습니다. 다른 이름을 입력해 주세요.' }],
      [{ status: 'unknown-pty' }, { level: 'error', message: '이 PTY를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.' }],
      [{ status: 'denied' }, { level: 'error', message: '이 PTY의 이름을 바꿀 권한이 없습니다.' }],
      [{ status: 'failed' }, { level: 'error', message: 'PTY 이름 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.' }],
      [{ status: 'owner-unreachable' }, { level: 'error', message: 'PTY 소유 프로세스에 연결할 수 없어 이름을 바꾸지 못했습니다.' }],
    ];
    const feedback: string[] = [];
    for (const [outcome, expectedFeedback] of outcomes) {
      promptResult = 'renamed';
      renameResult = outcome;
      await openPtyList();
      click(button('이름 바꾸기'));
      await harness.settle();
      expect(toastMessages).toEqual([expectedFeedback]);
      feedback.push(toastMessages[0]!.message);
    }

    expect(new Set(feedback).size).toBe(6);
  });
});

describe('TerminalPanel · a selected row reaches the daemon carrying its own source root', () => {
  test('clicking a foreign row requests scrollback with its sourceRoot, and switching to the rendered mode requests the frame with the same one', async () => {
    listed = [FOREIGN];
    const rowText = await selectTheOnlyRow();
    expect(rowText).toContain('tui:85858');

    // The default view mode is raw, so a selection is a scrollback request.
    expect(calls).toEqual([
      { endpoint: 'scrollback', id: 'tui:85858', options: { sourceRoot: '/roots/prod/pty/manifest.db' } },
    ]);

    // The mode buttons only exist once a row is selected, so reaching them is
    // itself evidence that the selection landed in state.
    click(button('PTY 목록'));
    await harness.settle();
    click(button('렌더 화면'));
    await harness.settle();
    // Whole array, not calls[1]: an extra or misfired request would otherwise pass.
    expect(calls).toEqual([
      { endpoint: 'scrollback', id: 'tui:85858', options: { sourceRoot: '/roots/prod/pty/manifest.db' } },
      { endpoint: 'frame', id: 'tui:85858', options: { sourceRoot: '/roots/prod/pty/manifest.db' } },
    ]);
  });

  test('two rows sharing an id in different roots are different rows — the second selects, and asks its OWN root', async () => {
    // ⛔ The case the whole source-root contract exists for. A PTY id is unique only
    // within a root, so the federated list can show both. With an id-keyed selection
    // the second click was swallowed as "already selected", and a mode change looked
    // the row up by id and could fetch the other universe's screen.
    listed = [FOREIGN, { ...FOREIGN, sourceRoot: { name: 'test', dbPath: '/roots/test/pty/manifest.db' } } as DaemonTerminalSummary];
    calls.length = 0;
    harness.unmount();
    const { TerminalPanel: Panel } = await import('./TerminalPanel');
    harness.render(Panel as never);
    await harness.settle();
    click(button('PTY 목록'));
    await harness.settle();

    const listRows = () => harness.findAll((element) => element.props.className === 'w-full text-left');
    expect(listRows()).toHaveLength(2);

    click(listRows()[0]!);
    await harness.settle();
    click(button('PTY 목록'));
    await harness.settle();
    // ⛔ Re-query. An element captured before the first click carries that render's
    // closure, so clicking it would test the guard against stale state — which is
    // how this test first passed even with the id-only guard restored.
    click(listRows()[1]!);
    await harness.settle();
    expect(calls).toEqual([
      { endpoint: 'scrollback', id: 'tui:85858', options: { sourceRoot: '/roots/prod/pty/manifest.db' } },
      { endpoint: 'scrollback', id: 'tui:85858', options: { sourceRoot: '/roots/test/pty/manifest.db' } },
    ]);

    // And the mode change follows the row that is actually selected, not the id.
    click(button('PTY 목록'));
    await harness.settle();
    click(button('렌더 화면'));
    await harness.settle();
    expect(calls[2]).toEqual({
      endpoint: 'frame', id: 'tui:85858', options: { sourceRoot: '/roots/test/pty/manifest.db' },
    });
  });

  test('a row with no source root sends no selector, so the daemon keeps resolving against its own root', async () => {
    listed = [LOCAL];
    await selectTheOnlyRow();
    // An empty options object, not a fabricated root: "no selector" and "the
    // current root" are different requests, and only the former keeps the default.
    expect(calls).toEqual([{ endpoint: 'scrollback', id: 'tui:100', options: {} }]);
  });
});
