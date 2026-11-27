// ELS-SIDECHAT unit tests — the element (props, key reducer, render) and the server hub (stream, throttle, close,
// errors) in isolation. Literal expectations; the sim (src/ux-sim/sim-world/els/sidechat-world.test.ts) drives it end to end.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSidechat, sidechat, sidechatKey, sidechatProps, sidechatTitle } from './elements/sidechat.js';
import { elementOf } from './elements/index.js';
import { createOverlayRegistry } from './overlay-registry.js';
import { clearRestoredSidechat, createSidechatHub, pushSidechat, sidechatContextText, sidechatErrorMessage, sidechatPanes, watchSidechatClose, type SidechatStream } from './sidechat-hub.js';

const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
const tick = async (): Promise<void> => { for (let at = 0; at < 6; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };

describe('sidechat element', () => {
  test('is registered as an overlay element kind', () => {
    expect(elementOf('sidechat')?.kind).toBe('sidechat');
  });
  test('props keep only client fields and strip control bytes', () => {
    expect(sidechatProps(undefined)).toEqual({ input: '' });
    expect(sidechatProps({ input: 'a\u0007b', edit: { kind: 'type', text: '질문' }, turns: [{ q: 'x', a: 'y' }] })).toEqual({ input: 'a b', edit: { kind: 'type', text: '질문' } });
    expect(sidechatProps('nope')).toBeUndefined();
    expect(sidechatProps({ edit: { kind: 'rm -rf' } })).toEqual({ input: '' });
    expect(sidechatProps({ edit: { kind: 'type', text: '' } })).toEqual({ input: '' });
  });
  test('Korean syllables, Backspace, ctrl+u, Enter', () => {
    let props: { input: string } = { input: '' };
    const edits: unknown[] = [];
    for (const ch of ['한', '국', '어']) { const next = sidechatKey(props, ch) as { input: string; edit: unknown }; edits.push(next.edit); props = next; }
    expect(props.input).toBe('한국어');
    expect(edits).toEqual([{ kind: 'type', text: '한' }, { kind: 'type', text: '국' }, { kind: 'type', text: '어' }]);
    expect(sidechatKey(props, '\u007f')).toEqual({ input: '한국', edit: { kind: 'back' } });
    expect(sidechatKey(props, '\r')).toEqual({ input: '', edit: { kind: 'send' } });
    expect(sidechatKey({ input: '   ' }, '\r')).toBe('consumed');
    expect(sidechatKey({ input: 'x', status: 'streaming' }, '\r')).toBe('consumed');
    expect(sidechatKey({ input: 'abc' }, '\u0015')).toEqual({ input: '', edit: { kind: 'clear' } });
    expect(sidechatKey({ input: 'a' }, '\u001b[A')).toBe('consumed');
    expect(sidechatKey({ input: 'a' }, '\u001b[200~')).toBe('consumed');
    expect(sidechatKey({ input: 'a' }, '\n')).toEqual({ input: 'a ', edit: { kind: 'type', text: ' ' } });
  });
  test('renders a frame of exactly the box size with the input line and help', () => {
    const rows = plain(renderSidechat({ input: '안녕', turns: [], status: 'idle' }, { w: 56, h: 16 }, true));
    expect(rows).toHaveLength(16);
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(56);
    expect(rows[0]).toContain('Sidechat');
    expect(rows[14]).toContain('› 안녕');
    expect(rows[15]).toContain('Enter send · Esc close');
  });
  test('shows the newest rows of a long answer and the thinking state', () => {
    const long = Array.from({ length: 40 }, (_, at) => `line ${at}`).join('\n\n');
    const rows = plain(renderSidechat({ input: '', turns: [{ q: 'q', a: long }], status: 'streaming' }, { w: 40, h: 12 }, true));
    expect(rows.join('\n')).toContain('line 39');
    expect(rows[0]).toContain('answering…');
    expect(plain(renderSidechat({ input: '', turns: [{ q: 'q', a: '' }], status: 'waiting' }, { w: 40, h: 12 }, true))[0]).toContain('thinking…');
  });
  test('without a server hub it says where it runs', () => {
    expect(sidechat.hydrate!({ input: '' }, {})).toEqual({ input: '', turns: [], status: 'idle', note: 'sidechat runs only in an els server' });
  });
});

const ask = (hub: ReturnType<typeof createSidechatHub>, q: string): void => { hub.edit({ kind: 'type', text: q }); hub.edit({ kind: 'send' }); };

describe('sidechat hub', () => {
  const scripted = (chunks: string[], fail?: string): { stream: SidechatStream; signals: AbortSignal[] } => {
    const signals: AbortSignal[] = [];
    return { signals, stream: async function* (_messages, signal) { signals.push(signal); for (const chunk of chunks) { await Promise.resolve(); if (signal.aborted) throw new Error('aborted'); yield chunk; } if (fail) throw new Error(fail); } };
  };
  test('streams an answer and pushes on the throttle, then idle', async () => {
    let pushes = 0;
    const { stream } = scripted(['안', '녕', '하세요']);
    const hub = createSidechatHub({ stream, push: () => { pushes++; }, now: () => 5000 });
    ask(hub, '인사');
    expect(hub.snapshot().status).toBe('waiting');
    await tick(); await tick();
    expect(hub.snapshot()).toEqual({ turns: [{ q: '인사', a: '안녕하세요' }], status: 'idle', input: '', timing: { firstMs: 0, totalMs: 0 } });
    expect(pushes).toBeGreaterThanOrEqual(1);
    hub.edit({ kind: 'send' });                                                // an empty input sends nothing
    expect(hub.snapshot().turns).toHaveLength(1);
  });
  test('a failure becomes one clean line; keys are redacted', async () => {
    const hub = createSidechatHub({ stream: scripted([], 'bad key sk-abcdef123456 at x').stream, push: () => {} });
    ask(hub, 'q');
    await tick(); await tick();
    expect(hub.snapshot().turns[0]!.error).toBe('The model call failed: bad key [redacted] at x');
    expect(sidechatErrorMessage(undefined, 'answer')).toBe('The answer took too long and was stopped. Try a shorter question.');
  });
  test('an empty answer says so', async () => {
    const hub = createSidechatHub({ stream: scripted([]).stream, push: () => {} });
    ask(hub, 'q');
    await tick();
    expect(hub.snapshot().turns[0]!.error).toBe('The model returned an empty answer. Try again.');
  });
  test('reset aborts the request and forgets the session', async () => {
    const { stream, signals } = scripted(['a', 'b', 'c', 'd']);
    const hub = createSidechatHub({ stream, push: () => {} });
    ask(hub, 'q');
    await Promise.resolve(); await Promise.resolve();
    hub.reset();
    await tick();
    expect(signals[0]?.aborted).toBe(true);
    expect(hub.snapshot()).toEqual({ turns: [], status: 'idle', input: '' });
    expect(hub.active()).toBe(false);
  });
  test('through the real registry: open → ask via update → hydrated turns → close resets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-sidechat-unit-'));
    try {
      let registry: ReturnType<typeof createOverlayRegistry> | undefined;
      const hub = createSidechatHub({ stream: scripted(['답', '변']).stream, push: () => pushSidechat(registry) });
      registry = createOverlayRegistry({ dir, context: () => ({ sidechat: hub }) });
      watchSidechatClose(registry, hub);
      const opened = JSON.parse(registry.apply({ action: 'open', kind: 'sidechat', props: {} }).message) as { id: string };
      for (const text of ['질', '문']) registry.apply({ action: 'update', id: opened.id, props: { input: 'stale', edit: { kind: 'type', text } } });
      expect((registry.stack().layers[0]!.props as { input: string }).input).toBe('질문');       // the hub's input, not the client's
      expect(registry.apply({ action: 'update', id: opened.id, props: { input: '', edit: { kind: 'send' } } }).exitCode).toBe(0);
      await tick(); await tick();
      const props = registry.stack().layers[0]!.props as { turns: unknown; status: string; edit?: unknown };
      expect(props.turns).toEqual([{ q: '질문', a: '답변' }]);
      expect(props.status).toBe('idle');
      expect(props.edit).toBeUndefined();
      // A stale client copy (no turns) cannot erase the answer: hydrate re-fills from the hub.
      registry.apply({ action: 'update', id: opened.id, props: { input: 'x', turns: [] } });
      expect((registry.stack().layers[0]!.props as { turns: unknown }).turns).toEqual([{ q: '질문', a: '답변' }]);
      registry.apply({ action: 'close', kind: 'sidechat' });
      expect(hub.active()).toBe(false);
      registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('sidechat after an els restart (A4)', () => {
  test('a restored layer is re-hydrated from the fresh hub with the one-line note; the next key drops the note', () => {
    const root = mkdtempSync(join(tmpdir(), 'els-sidechat-restart-'));
    try {
      const dir = join(root, 'els');
      const deadHub = createSidechatHub({ stream: async function* () { yield 'x'; }, push: () => {} });
      const dead = createOverlayRegistry({ dir, context: () => ({ sidechat: deadHub }) });
      dead.apply({ action: 'open', kind: 'sidechat', props: {} });
      const id = dead.stack().layers[0]!.id;
      // the dead server's last push carried a live session (stale turns, «streaming»)
      deadHub.edit({ kind: 'type', text: 'old question' });
      deadHub.edit({ kind: 'send' });
      dead.apply({ action: 'update', id, props: { input: '' } });
      expect(JSON.stringify(dead.stack())).toContain('old question');
      deadHub.reset();
      dead.dispose();
      const hub = createSidechatHub({ stream: async function* () { yield 'y'; }, push: () => {} });
      const fresh = createOverlayRegistry({ dir, context: () => ({ sidechat: hub }) });
      clearRestoredSidechat(fresh);
      const props = fresh.stack().layers[0]!.props as Record<string, unknown>;
      expect(props).toEqual({ input: '', turns: [], status: 'idle', note: 'Previous sidechat was closed when els restarted.' });
      expect(plain(renderSidechat(props as never, { w: 70, h: 10 }, true)).join('\n')).toContain('Previous sidechat was closed when els restarted.');
      const next = sidechat.key!(fresh.stack().layers[0]!, 'a') as { update: unknown };
      fresh.apply({ action: 'update', id: fresh.stack().layers[0]!.id, props: next.update });
      expect((fresh.stack().layers[0]!.props as Record<string, unknown>).note).toBeUndefined();
      fresh.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('no sidechat layer restored → nothing is opened', () => {
    const root = mkdtempSync(join(tmpdir(), 'els-sidechat-restart-'));
    try {
      const fresh = createOverlayRegistry({ dir: join(root, 'els') });
      clearRestoredSidechat(fresh);
      expect(fresh.stack().layers).toEqual([]);
      fresh.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('sidechat typing indicator and timing (A5)', () => {
  test('the title: spinner while waiting, first-token latency while streaming, first token · total when done', () => {
    expect(sidechatTitle('waiting', 0, undefined)).toBe(' Sidechat · ⠋ thinking… ');
    expect(sidechatTitle('waiting', 3, undefined)).toBe(' Sidechat · ⠸ thinking… ');
    expect(sidechatTitle('waiting', 11, undefined)).toBe(' Sidechat · ⠙ thinking… ');
    expect(sidechatTitle('streaming', undefined, { firstMs: 1234 })).toBe(' Sidechat · answering… · 1.2s first token ');
    expect(sidechatTitle('idle', undefined, { firstMs: 1234, totalMs: 4560 })).toBe(' Sidechat · 1.2s first token · 4.6s total ');
    expect(sidechatTitle('idle', undefined, { totalMs: 30000 })).toBe(' Sidechat · 30.0s total ');
    expect(sidechatTitle('idle', undefined, undefined)).toBe(' Sidechat ');
  });
  test('the body dots cycle with the frame while waiting', () => {
    const at = (typing: number): string => plain(renderSidechat({ input: '', turns: [{ q: 'q', a: '' }], status: 'waiting', typing }, { w: 40, h: 8 }, true)).join('\n');
    expect(at(0)).toContain('│ •   ');
    expect(at(2)).toContain('│ •••');
    expect(at(0)).toContain('⠋ thinking…');
    expect(at(1)).toContain('⠙ thinking…');
  });
  test('hub: the push timer re-arms only while waiting; timing from the injected clock; reset clears it', async () => {
    let clock = 1000;
    const pending: { cb: () => void; ms: number }[] = [];
    let pushes = 0;
    let release: (() => void) | undefined;
    const stream: SidechatStream = async function* () { await new Promise<void>((done) => { release = done; }); yield 'hi'; };
    const hub = createSidechatHub({ stream, push: () => { pushes++; }, now: () => clock,
      setTimer: (cb, ms) => { const one = { cb, ms }; pending.push(one); return one; }, clearTimer: (h) => { const at = pending.indexOf(h as never); if (at >= 0) pending.splice(at, 1); } });
    ask(hub, 'q');
    expect(hub.snapshot().typing).toBe(0);
    const typingTimer = (): { cb: () => void; ms: number } | undefined => pending.find((one) => one.ms === 300);
    expect(typingTimer()).toBeDefined();
    for (let step = 1; step <= 4; step++) { clock += 300; const t = typingTimer()!; pending.splice(pending.indexOf(t), 1); t.cb(); expect(hub.snapshot().typing).toBe(step); }
    expect(pushes).toBe(4);
    clock += 50;                                                               // first token at 1.25 s
    await tick();
    release!();
    await tick(); await tick();
    expect(hub.snapshot().status).toBe('idle');
    expect(hub.snapshot().typing).toBeUndefined();
    expect(hub.snapshot().timing).toEqual({ firstMs: 1250, totalMs: 1250 });
    // idle: the remaining timer (if any) does not re-arm itself
    for (const one of pending.splice(0)) one.cb();
    expect(pending.filter((one) => one.ms === 300)).toEqual([]);
    hub.reset();
    expect(hub.snapshot().timing).toBeUndefined();
  });
});

describe('sidechat context (A1 · ctrl+o)', () => {
  test('ctrl+o is a context edit that keeps the input; the pane prop is validated', () => {
    expect(sidechatKey({ input: 'ab' }, '\u000f')).toEqual({ input: 'ab', edit: { kind: 'context' } });
    expect(sidechatProps({ pane: 'pbdf341f7', edit: { kind: 'context' } })).toEqual({ input: '', pane: 'pbdf341f7', edit: { kind: 'context' } });
    expect(sidechatProps({ pane: '../etc' })).toEqual({ input: '' });
    expect(sidechatProps({ context: { label: 'forged' } })).toEqual({ input: '' });
  });
  test('the header row: «context: <title>» or «context: unavailable», never without the toggle', () => {
    const on = plain(renderSidechat({ input: '', context: { label: 'build log' } }, { w: 50, h: 10 }, true));
    expect(on[1]).toContain('context: build log');
    expect(on).toHaveLength(10);
    expect(plain(renderSidechat({ input: '', context: {} }, { w: 50, h: 10 }, true))[1]).toContain('context: unavailable');
    expect(plain(renderSidechat({ input: '' }, { w: 50, h: 10 }, true)).join('\n')).not.toContain('context:');
  });
  test('context text = last 60 visible lines, trailing blanks dropped, secrets masked', () => {
    const screen = [...Array.from({ length: 100 }, (_, at) => `row ${at + 1}`), 'token ghp_0123456789abcdefABCDEF0123456789abcd', '', '  '].join('\n');
    const text = sidechatContextText(screen);
    expect(text.split('\n')).toHaveLength(60);
    expect(text.split('\n')[0]).toBe('row 42');
    expect(text.split('\n').at(-1)).toBe('token ghp_***');
  });
  test('the pane reader: own workspace only when the layer has one; missing pane = unavailable', async () => {
    const reads: string[] = [];
    const core = {
      paneExists: (ref: string) => (['p1', 'p2'].includes(ref) ? ref : undefined),
      workspaceOf: (ref: string) => (ref === 'p1' ? { id: 'w1', name: 'one' } : { id: 'w2', name: 'two' }),
      read: async (ref: string) => { reads.push(ref); return { exitCode: 0, message: `screen of ${ref}` }; },
      list: () => ({ message: JSON.stringify({ panes: [{ pane: 'p1', title: 'build log' }, { pane: 'p2', title: 'other' }] }) }),
    };
    let owner: string | undefined = 'w1';
    const panes = sidechatPanes(core, () => owner);
    expect(panes.title('p1')).toBe('build log');
    expect(panes.title('p2')).toBeUndefined();
    expect(await panes.screen('p2')).toBeUndefined();
    expect(await panes.screen('p1')).toEqual({ title: 'build log', screen: 'screen of p1' });
    expect(await panes.screen('p9')).toBeUndefined();
    owner = 'two';                                                            // by name too
    expect(await panes.screen('p2')).toEqual({ title: 'other', screen: 'screen of p2' });
    owner = undefined;                                                        // owner-terminal layer: any local pane
    expect(panes.title('p1')).toBe('build log');
    expect(reads).toEqual(['p1', 'p2']);
  });
  test('hub: the context goes with the question, the raw screen never in the snapshot; reset turns it off', async () => {
    const seen: string[][] = [];
    const stream: SidechatStream = async function* (messages) { seen.push(messages.map((one) => one.content)); yield 'ok'; };
    const hub = createSidechatHub({ stream, push: () => {}, setTimer: () => 0, clearTimer: () => {},
      panes: { title: () => 'log', screen: async () => ({ title: 'log', screen: 'KEY=sk-proj-AbCdEf0123456789AbCdEf0123456789xyz' }) } });
    hub.edit({ kind: 'pane', pane: 'p1' });
    hub.edit({ kind: 'context' });
    expect(hub.snapshot().context).toEqual({ label: 'log' });
    hub.edit({ kind: 'type', text: 'why?' });
    hub.edit({ kind: 'send' });
    await tick();
    expect(seen[0]![1]).toContain('KEY=sk-proj-***');
    expect(seen[0]!.join('\n')).not.toContain('AbCdEf0123');
    expect(JSON.stringify(hub.snapshot())).not.toContain('KEY=');
    hub.reset();
    expect(hub.snapshot().context).toBeUndefined();
  });
});
