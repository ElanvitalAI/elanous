import { afterEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { CompactTerminalBar } from './CompactTerminalBar';
import { TerminalPanel } from './TerminalPanel';
import { TerminalControls } from './TerminalControls';
import { TerminalTabs } from './TerminalTabs';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const require = createRequire(import.meta.url);
const react = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
const renderer = require('react-test-renderer') as {
  act: (callback: () => void | Promise<void>) => Promise<void>;
  create: (element: unknown) => {
    root: { findByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> }; findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
    toJSON: () => unknown;
    update: (element: unknown) => void;
    unmount: () => void;
  };
};
const oldWindow = (globalThis as { window?: unknown }).window;
const oldDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
  if (oldDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = oldDocument;
  if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = oldWindow;
});

const modeNames = ['터미널', '🖥 TUI 관측 OFF', 'PTY 목록', '▦ 나란히'];
const controlNames = ['clear', '카메라', '첨부', 'Live', 'voice→stdin', '● record'];

describe('CompactTerminalBar', () => {
  test('shows one 40px bar, three connection colors, and keeps the action sheet hidden until opened', async () => {
    (globalThis as { window?: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
    let tree!: ReturnType<typeof renderer.create>;
    const render = (status: 'connected' | 'connecting' | 'disconnected') => react.createElement(CompactTerminalBar, {
      activeId: 'term-1', tabs: ['term-1'], status, onSwitch: () => {}, onAdd: () => {},
      actions: react.createElement('button', null, '끝내기'),
      children: modeNames.concat(controlNames).map((name) => react.createElement('button', { key: name }, name)),
    });
    await renderer.act(async () => { tree = renderer.create(render('connected')); });
    expect(tree.root.findByProps({ 'aria-label': '간결한 터미널 상단바' }).props.className).toContain('h-10 max-h-10');
    expect(tree.root.findByProps({ role: 'status' }).props.className).toContain('left-1/2');
    const sheet = () => tree.root.findAllByType('section').filter((section) => section.props['aria-label'] === '터미널 더보기 시트');
    expect(sheet()).toHaveLength(1);
    expect(sheet()[0]!.props['aria-hidden']).toBe(true);
    for (const [state, color, label] of [
      ['connected', 'bg-emerald-500', '연결됨'], ['connecting', 'bg-amber-500', '연결 중'], ['disconnected', 'bg-rose-500', '끊김'],
    ] as const) {
      await renderer.act(async () => { tree.update(render(state)); });
      const dot = tree.root.findByProps({ role: 'status' });
      expect(dot.props.className).toContain(color);
      expect(dot.props.title).toBe(label);
    }
    await renderer.act(async () => { (tree.root.findByProps({ 'aria-label': '터미널 더보기' }).props.onClick as () => void)(); });
    expect(sheet()).toHaveLength(1);
    expect(sheet()[0]!.props['aria-hidden']).toBe(false);
    const labels = tree.root.findAllByType('button').filter((button) => modeNames.concat(controlNames, ['끝내기']).includes(String(button.props.children))).map((button) => String(button.props.children));
    expect(labels).toHaveLength(11);
    expect(labels).toEqual(expect.arrayContaining([...modeNames, ...controlNames, '끝내기']));
    await renderer.act(async () => { tree.unmount(); });
  });

  test('select and new invoke the supplied existing tab handlers', async () => {
    (globalThis as { window?: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
    const selected: string[] = [];
    let added = 0;
    let tree!: ReturnType<typeof renderer.create>;
    await renderer.act(async () => {
      tree = renderer.create(react.createElement(CompactTerminalBar, {
        activeId: 'term-1', tabs: ['term-1', 'term-2'], status: 'connected',
        onSwitch: (id: string) => selected.push(id), onAdd: () => { added += 1; }, actions: null, children: null,
      }));
    });
    const click = async (props: Record<string, unknown>) => {
      await renderer.act(async () => { (tree.root.findByProps(props).props.onClick as () => void)(); });
    };
    await click({ 'aria-label': '터미널 고르기' });
    await click({ role: 'menuitem', children: 'term-2' });
    expect(selected).toEqual(['term-2']);
    await click({ 'aria-label': '터미널 고르기' });
    await click({ role: 'menuitem', children: '+ 새 터미널' });
    expect(added).toBe(1);
    await renderer.act(async () => { tree.unmount(); });
  });

  test('sheet controls render the actual six toolbar actions without a toolbar row', async () => {
    (globalThis as { window?: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
    let tree!: ReturnType<typeof renderer.create>;
    const context = {
      client: { connectAcp: () => ({ send: async () => ({ recordings: [] }), close: () => {} }) },
      sessionId: '', config: { baseUrl: 'https://example.test', token: '', provider: '' }, setConfig: () => {}, setSessionId: () => {},
    };
    await renderer.act(async () => {
      tree = renderer.create(react.createElement(DaemonContext.Provider, { value: context },
        react.createElement(TerminalControls, { terminalId: 'term-1', onClear: () => {}, onAttached: () => {},
          variant: 'sheet', voice: { active: false, phase: 'idle', dotColor: '', phaseLabel: 'idle', onToggle: () => {} } })));
    });
    const toolbar = tree.root.findByProps({ className: 'flex flex-wrap items-center gap-2 text-xs' });
    expect(toolbar.props.className).not.toContain('border-b');
    const labels = JSON.stringify(tree.toJSON());
    for (const name of ['clear', 'attach photo', 'attach files', 'Live', 'voice→stdin', 'record']) expect(labels).toContain(name);
    expect(tree.root.findAllByType('button').filter((button) => button.props['aria-label'] === 'attach photo')).toHaveLength(1);
    expect(tree.root.findAllByType('button').filter((button) => button.props['aria-label'] === 'attach files')).toHaveLength(1);
    expect(readFileSync(new URL('./TerminalControls.tsx', import.meta.url), 'utf8')).toContain('<LiveCameraControl />');
    await renderer.act(async () => { tree.unmount(); });
  });

  test('sheet tab mode retains the real switch, daemon spawn, and confirmed termination handlers', async () => {
    const storage = new Map([['elanous.webterm.tabs', '["term-1","term-2"]']]);
    const sent: string[] = [];
    const selected: string[] = [];
    const acp = {
      state: 'OPEN', close: () => {}, onState: () => () => {},
      send: async (method: string) => {
        sent.push(method);
        if (method === 'terminal/list') return { terminals: [{ terminalId: 'term-1', isAlive: true }, { terminalId: 'term-2', isAlive: false }] };
        if (method === 'terminal/spawn') return { terminalId: 'term-3' };
        return {};
      },
    };
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
      confirm: () => true,
    };
    const context = { client: { connectAcp: () => acp }, sessionId: 'session-test', config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, setSessionId: () => {} };
    let model!: { tabs: readonly string[]; onSwitch: (id: string) => void; onAdd: () => void; actions: unknown; status: string };
    let tree!: ReturnType<typeof renderer.create>;
    await renderer.act(async () => {
      tree = renderer.create(react.createElement(DaemonContext.Provider, { value: context },
        react.createElement(TerminalTabs, { activeId: 'term-1', onActiveChange: (id: string) => selected.push(id), variant: 'sheet',
          renderSheet: (value: typeof model) => { model = value; return react.createElement('div', null, value.actions); } })));
    });
    expect(model.tabs).toEqual(['term-1', 'term-2']);
    expect(model.status).toBe('connected');
    await renderer.act(async () => { model.onSwitch('term-2'); });
    expect(selected).toContain('term-2');
    await renderer.act(async () => { tree.update(react.createElement(DaemonContext.Provider, { value: context },
      react.createElement(TerminalTabs, { activeId: 'term-2', onActiveChange: (id: string) => selected.push(id), variant: 'sheet',
        renderSheet: (value: typeof model) => { model = value; return react.createElement('div', null, value.actions); } }))); });
    expect(model.status).toBe('disconnected');
    await renderer.act(async () => { model.onAdd(); });
    await renderer.act(async () => { await Promise.resolve(); });
    expect(sent).toContain('terminal/spawn');
    expect(selected).toContain('term-3');
    expect(tree.root.findAllByType('button').filter((button) => button.props['aria-label'] === 'terminate term-1')).toHaveLength(1);
    await renderer.act(async () => { (tree.root.findByProps({ 'aria-label': 'terminate term-1' }).props.onClick as () => void)(); });
    await renderer.act(async () => { await Promise.resolve(); });
    expect(sent).toContain('terminal/destroy');
    await renderer.act(async () => { tree.unmount(); });
  });

  test('opened sheet contains exactly four mode and six real toolbar action buttons plus termination', async () => {
    (globalThis as { window?: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
    const context = {
      client: { connectAcp: () => ({ send: async () => ({ recordings: [] }), close: () => {} }) },
      sessionId: '', config: { baseUrl: 'https://example.test', token: '', provider: '' }, setConfig: () => {}, setSessionId: () => {},
    };
    let tree!: ReturnType<typeof renderer.create>;
    await renderer.act(async () => {
      tree = renderer.create(react.createElement(DaemonContext.Provider, { value: context },
        react.createElement(CompactTerminalBar, {
          activeId: 'term-1', tabs: ['term-1'], status: 'connected', onSwitch: () => {}, onAdd: () => {},
          actions: react.createElement('button', { 'aria-label': 'terminate term-1' }, '끝내기'),
          children: [
            ...modeNames.map((name) => react.createElement('button', { key: name }, name)),
            react.createElement(TerminalControls, { key: 'controls', terminalId: 'term-1', onClear: () => {},
              onAttached: () => {}, variant: 'sheet', voice: { active: false, phase: 'idle', dotColor: '', phaseLabel: 'idle', onToggle: () => {} } }),
          ],
        })));
    });
    await renderer.act(async () => { (tree.root.findByProps({ 'aria-label': '터미널 더보기' }).props.onClick as () => void)(); });
    const sheet = tree.root.findByProps({ 'aria-label': '터미널 더보기 시트' });
    const buttons = tree.root.findAllByType('button');
    const labels = JSON.stringify(tree.toJSON());
    for (const name of modeNames) expect(labels).toContain(name);
    for (const name of ['clear', 'attach photo', 'attach files', '📹 Live', 'voice→stdin', '● record']) expect(labels).toContain(name);
    expect(buttons.filter((button) => button.props['aria-label'] === 'terminate term-1')).toHaveLength(1);
    expect(sheet.props['aria-hidden']).toBe(false);
    await renderer.act(async () => { tree.unmount(); });
  });

  // The whole-TerminalPanel mount in a fake window looped forever (no summary line · gate «test run summary absent»);
  // 932/933 switching is verified live in a real browser instead (harvest PR body).
  test('panel switches headers exclusively while retaining the modifier rule and wide header classes', () => {
    const panel = readFileSync(new URL('./TerminalPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain("variant={compact ? 'sheet' : 'default'}");
    expect(panel).toContain("{!compact && <div className={panelsMinimized ? 'hidden' : 'flex items-center gap-2 border-b border-zinc-800 px-3 py-1'}>{modeButtons}</div>}");
    expect(panel).toContain('{!compact && controls}');
    expect(panel).toContain('compact ? <div className="hidden"><MultiDeviceIndicator');
    expect(panel).toContain('{isCoarsePointer && <ModifierBar terminalId={terminalId} />}');
  });
});
