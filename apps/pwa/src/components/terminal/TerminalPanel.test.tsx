// TerminalPanel initial SSR render contract. This is initial SSR only; not
// interaction behavior: renderToStaticMarkup does not run browser effects.
// Browser-only wiring is deliberately pinned below by source names only.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, mock, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';

const require = createRequire(import.meta.url);
const react = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => react.createElement(type, key === undefined ? props : { ...props, key });
const jsxDEV = jsx;
const stub = (testId: string) => () => react.createElement('div', { 'data-testid': testId });
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'TerminalPanel.tsx'), 'utf8');

// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다(`@/lib/testing/restore-module-mocks`).
await restoreModuleMocksAfterAll([
  'react/jsx-dev-runtime',
  'sonner',
  '@/components/providers/DaemonProvider',
  '@/lib/use-pointer-capability',
  '@/lib/secure-context-guard',
  '@/voice/use-voice-controller',
  '@/voice/voice-phase-styles',
  '@/components/terminal/XtermView',
  '@/components/terminal/TuiMirrorView',
  '@/components/terminal/TerminalControls',
  '@/components/terminal/ModifierBar',
  '@/components/terminal/TerminalDropZone',
  '@/components/terminal/MultiDeviceIndicator',
  '@/components/terminal/TerminalChatDock',
], (specifier) => import(specifier));

mock.module('react/jsx-dev-runtime', () => ({
  Fragment: Symbol.for('react.fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV,
}));
mock.module('sonner', () => ({ toast: { error: () => {}, success: () => {} } }));

mock.module('@/components/providers/DaemonProvider', () => ({
  useDaemon: () => ({
    client: {
      voiceWsUrl: () => '',
      connectAcp: () => ({ close: () => {} }),
      listTerminals: async () => ({ terminals: [], scope: undefined }),
      listProgressFrames: async () => ({ logs: [] }),
    },
    config: { baseUrl: '', token: '' },
    sessionId: 'session-test',
  }),
}));
mock.module('@/lib/use-pointer-capability', () => ({ usePointerCapability: () => ({ isCoarsePointer: false }) }));
mock.module('@/lib/secure-context-guard', () => ({ checkSecureContext: () => ({ isSecure: true }) }));
mock.module('@/voice/use-voice-controller', () => ({
  useVoiceController: () => ({ active: false, phase: 'idle', toggle: async () => {} }),
}));
mock.module('@/voice/voice-phase-styles', () => ({ VOICE_DOT_COLOR: { idle: '' }, VOICE_PHASE_LABEL: { idle: '' } }));

mock.module('@/components/terminal/XtermView', () => ({ XtermView: stub('xterm-view') }));
mock.module('@/components/terminal/TuiMirrorView', () => ({ TuiMirrorView: stub('tui-mirror-view') }));
mock.module('@/components/terminal/TerminalControls', () => ({ TerminalControls: stub('terminal-controls') }));
mock.module('@/components/terminal/ModifierBar', () => ({ ModifierBar: stub('modifier-bar') }));
mock.module('@/components/terminal/TerminalDropZone', () => ({ TerminalDropZone: stub('terminal-drop-zone') }));
mock.module('@/components/terminal/MultiDeviceIndicator', () => ({ MultiDeviceIndicator: stub('multi-device-indicator') }));
mock.module('@/components/terminal/TerminalChatDock', () => ({ TerminalChatDock: stub('terminal-chat-dock') }));

describe('TerminalPanel · initial SSR render contract', () => {
  test('renders three mode buttons with terminal as the only active initial view', async () => {
    const { TerminalPanel } = await import('./TerminalPanel');
    const html = renderToStaticMarkup(react.createElement(TerminalPanel));

    expect(html).toContain('>터미널</button>');
    expect(html).toContain('🖥 TUI 관측 OFF');
    expect(html).toContain('>PTY 목록</button>');
    expect(html).toMatch(/aria-pressed="true"[^>]*>터미널<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>🖥 TUI 관측 OFF<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>PTY 목록<\/button>/);

    // SSR has no daemon-issued identity yet, so it exposes preparation rather than a terminal surface.
    expect(html).toContain('터미널 이름을 준비하는 중…');
    expect(html).not.toContain('data-testid="xterm-view"');
    expect(html).not.toContain('data-testid="tui-mirror-view"');
    expect(html).not.toContain('aria-label="데몬 PTY 목록"');
  });
});

describe('TerminalPaneLayout · SSR render contract', () => {
  test('renders same-run split and tab terminals concurrently while retaining unknown rows outside slots', async () => {
    const { TerminalPaneLayout } = await import('./TerminalPanel');
    const html = renderToStaticMarkup(react.createElement(TerminalPaneLayout, {
      sessionId: 'session-test',
      onForeignInputActivity: () => {},
      layout: {
        layouts: [{
          runId: 'run-a',
          slots: [
            { terminalId: 'newest', position: 'split' },
            { terminalId: 'older', position: 'tab' },
          ],
        }],
        unknown: [{ id: 'unrelated', reason: 'relationship-unavailable' }],
      },
    }));

    expect(html.match(/data-testid="xterm-view"/g)?.length).toBe(2);
    expect(html).toContain('data-pane-position="split"');
    expect(html).toContain('data-pane-position="tab"');
    expect(html).toContain('data-terminal-id="newest"');
    expect(html).toContain('data-terminal-id="older"');
    expect(html).toContain('data-terminal-id="unrelated" data-pane-relationship="relationship-unavailable"');
    expect(html).toContain('관계를 알 수 없어 배치하지 않았습니다.');
  });

  test('keeps separate run layouts and does not invent a placement for unknown rows', async () => {
    const { TerminalPaneLayout } = await import('./TerminalPanel');
    const html = renderToStaticMarkup(react.createElement(TerminalPaneLayout, {
      sessionId: 'session-test',
      onForeignInputActivity: () => {},
      layout: {
        layouts: [
          { runId: 'run-a', slots: [{ terminalId: 'a', position: 'split' }] },
          { runId: 'run-b', slots: [{ terminalId: 'b', position: 'split' }] },
        ],
        unknown: [{ id: 'unknown', reason: 'relationship-unavailable' }],
      },
    }));

    expect(html).toContain('aria-label="런 run-a 터미널"');
    expect(html).toContain('aria-label="런 run-b 터미널"');
    expect(html).not.toContain('data-terminal-id="unknown" data-pane-position=');
  });

  test('mounts every open tab under its stable terminal id while hiding only inactive panels', async () => {
    const { TerminalPaneLayout } = await import('./TerminalPanel');
    const html = renderToStaticMarkup(react.createElement(TerminalPaneLayout, {
      sessionId: 'session-test',
      terminalIds: ['first', 'second'],
      activeId: 'second',
      onForeignInputActivity: () => {},
      layout: { layouts: [], unknown: [] },
    }));

    expect(html.match(/data-testid="xterm-view"/g)?.length).toBe(2);
    expect(html).toContain('class="hidden" data-pane-position="inactive-tab" data-terminal-id="first"');
    expect(html).toContain('data-pane-position="single" data-terminal-id="second"');
  });
});

describe('TerminalPanel · a row decides its own detail selector', () => {
  test('a row from another manifest root asks for that root; a local row asks for none', async () => {
    const { terminalDetailOptions } = await import('./TerminalPanel');
    const foreign = { id: 'remote-pty', sourceRoot: { name: 'remote', dbPath: '/roots/remote/pty/manifest.db' } };
    const local = { id: 'local-pty' };
    expect(terminalDetailOptions(foreign as never)).toEqual({ sourceRoot: '/roots/remote/pty/manifest.db' });
    // Absent, not empty-string: "no selector" and "the current root" are different
    // requests to the daemon, and only the former preserves the default.
    expect(terminalDetailOptions(local as never)).toEqual({});
  });
});

// ⛔ Source-name pins only. They catch a rename that silently detaches a
// collaborator; they say nothing about behavior. Anything that IS behavior —
// which row a click sends, which selector reaches the daemon — belongs in
// TerminalPanel.interaction.test.tsx, which executes the real handlers.
describe('TerminalPanel · source wiring only; not behavior validation', () => {
  test('pins the three-mode initial state, canonical selection transition, and exclusive render branches', () => {
    expect(SRC).toContain("useState<TerminalPanelView>('terminal')");
    expect(SRC).toContain('terminalPanelViewState(panelView)');
    expect(SRC).toContain('nextTerminalPanelView(current, selected)');
    expect(SRC).toContain("selectPanelView('terminal')");
    expect(SRC).toContain("selectPanelView('observe')");
    expect(SRC).toContain("selectPanelView('pty-list')");
    expect(SRC).toContain("panelView === 'pty-list' ? (");
    expect(SRC).toContain(") : panelView === 'observe' ? (");
    expect(SRC).toContain("panelView !== 'terminal'");
    expect(SRC).not.toContain('observeMode');
    expect(SRC).not.toContain('setObserveMode');
    expect(SRC).toContain('<XtermView');
    expect(SRC).toContain('paneLayout(panePlan(ptyRows))');
    expect(SRC).toContain('<TerminalPaneLayout');
  });

  test('pins minimized-storage and PTY summary, selection, and lineage names', () => {
    expect(SRC).toContain("const MINIMIZED_KEY = 'elanous.webterm.panelsMinimized'");
    expect(SRC).toContain('window.localStorage.setItem(MINIMIZED_KEY');
    expect(SRC).toContain('ptyTerminalRowSummary(terminal)');
    // The row travels whole, not as an id — the id alone drops its source root.
    expect(SRC).toContain('handlePtySelection(terminal, true)');
    expect(SRC).toContain('resolvePtyTerminalId(initialPtyId, ptyRows)');
    expect(SRC).toContain('initialPtyPickDoneRef.current = true');
    expect(SRC).toContain('aria-label="URL PTY 선택 상태"');
    expect(SRC).toContain('ptyTerminalLineageModel(selectedPtyId, ptyLineage)');
    expect(SRC).toContain('aria-label="선택 PTY 계보"');
    expect(SRC).toContain("import { renameOutcomeMessage } from './rename-outcome'");
    expect(SRC).toContain('client.renameTerminal(terminal.id, name)');
    expect(SRC).toContain('renameOutcomeMessage(result)');
    expect(SRC).toContain('이름 변경은 되돌릴 수 있으므로 별도 확인 없이 진행한다.');
  });
});
