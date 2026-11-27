// ELS-SIDECHAT sim world — the sidechat popup end to end, deterministic and seeded: a REAL overlay registry with a REAL
// sidechat hub in its element context (fake clock and timers), REAL attach apps (createAttachApp with fake socket deps —
// the same shape as zaxis-overlay-world.ts) whose `request` routes `op: overlay` into the registry (so ctrl+b / opens it
// like the real server), and a SCRIPTED model stream the scenario feeds chunk by chunk (or fails, or never starts).
// Every frame each viewer writes is checked against the frame invariants (row count, row width in cells, the status line
// never covered) as it is written.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachHandlers, Attached } from '../../../els/attach-client.js';
import { createAttachApp, type AttachApp } from '../../../els/attach-app.js';
import type { ElsResult } from '../../../els/core.js';
import type { ElsRequest } from '../../../els/server.js';
import { createOverlayRegistry, type OverlayRegistry } from '../../../els/overlay-registry.js';
import { elementKeys, elementRenderers } from '../../../els/elements/index.js';
import type { ElementContext } from '../../../els/elements/element.js';
import type { PopupStyle } from '../../../els/popup-style.js';
import { clearRestoredSidechat, createSidechatHub, pushSidechat, watchSidechatClose, type SidechatHub, type SidechatMessage, type SidechatStream } from '../../../els/sidechat-hub.js';
import { fakeTimers, paneRow, prng, rowsOf, type FakeTimers } from './zaxis-overlay-world.js';

const END = Symbol('end');
type Item = string | Error | typeof END;

/** One model call the scenario drives: `say` a chunk, `end`, `fail`. `aborted` = the hub cancelled it. */
export interface ScriptedCall {
  readonly messages: readonly SidechatMessage[];
  readonly say: (text: string) => Promise<void>;
  readonly end: () => Promise<void>;
  readonly fail: (message: string) => Promise<void>;
  readonly aborted: () => boolean;
}

export const settle = async (): Promise<void> => { for (let at = 0; at < 6; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };

export interface SidechatViewer {
  readonly app: AttachApp;
  readonly typed: () => string[];
  readonly size: { cols: number; rows: number };
  readonly last: () => string[];
  readonly frames: () => number;
  readonly press: (...keys: string[]) => void;
  readonly violations: string[];
  /** Lagged viewers only: acts still on the wire. `deliver(n)` lands the oldest n at the server (each push reaches every
   *  viewer at once — so a push of an older state can arrive between two keys, like a real socket). */
  readonly inFlight: () => number;
  readonly deliver: (n?: number) => void;
  /** A3: the terminal is resized (the app re-lays out at the new size). */
  readonly resize: (cols: number, rows: number) => void;
  /** A3: the attach stream of a pane ends (the pane exited) — every attach of that pane in this viewer. */
  readonly endPane: (pane: string) => void;
}

export interface SidechatWorld {
  readonly registry: OverlayRegistry;
  readonly hub: SidechatHub;
  readonly timers: FakeTimers;
  readonly rand: ReturnType<typeof prng>;
  readonly calls: ScriptedCall[];
  readonly viewer: (opts?: { cols?: number; rows?: number; pane?: string; lag?: boolean }) => Promise<SidechatViewer>;
  readonly layer: () => { id: string; props: Record<string, unknown> } | undefined;
  /** Let the throttled push fire (fake clock) and the promise chains settle. */
  readonly flush: () => Promise<void>;
  /** A3: drop a pane from the listing (it exited) — the next ls poll no longer has it. */
  readonly removePane: (pane: string) => void;
  /** A4: the els process dies — viewers drop, the session and its request vanish, overlays.json stays as it was. */
  readonly crash: () => void;
  readonly root: string;
  readonly dispose: () => void;
  /** A1: the fake pane screens the hub's pane reader serves (edit freely: delete = the pane closed). */
  readonly screens: Map<string, { title: string; screen: string }>;
  /** A1: text that must never appear in any frame a viewer writes nor in any pushed overlay stack (raw secrets). */
  readonly forbidden: string[];
  /** Violations seen on the pushed stack (props) — the frame ones live on each viewer. */
  readonly stackViolations: string[];
}

/** The frame invariants: exactly `rows` lines, none wider than `cols` cells, the status line (last) never part of a box. */
export function frameViolations(lines: readonly string[], size: { cols: number; rows: number }): string[] {
  const out: string[] = [];
  if (lines.length !== size.rows) out.push(`rows ${lines.length} ≠ ${size.rows}`);
  lines.forEach((line, at) => { const w = Bun.stringWidth(line); if (w > size.cols) out.push(`row ${at} is ${w} cells > ${size.cols}`); });
  const status = lines.at(-1) ?? '';
  if (/[╭╰├│╮╯┤]/.test(status) && status.includes('Sidechat')) out.push('the status line is covered by the popup');
  return out;
}

/** `context` = extra element context (ELS-TAKEOUT sims: stateDir · vault · notify · openTab). */
/** `wrap` = put a layer around the scripted model stream (ELS-SIDECHAT-SEARCH sims: the two-round search stream). */
/** `opts.root`: reuse another world's state dir — the restarted els server (A4) reads the overlays.json the dead one left.
 *  `opts.style` = ELS-POPUP-STYLE: the popup style the viewers paint with (read at each paint — flip it, then repaint). */
export function createSidechatWorld(seed: number, context: (registry: OverlayRegistry) => Partial<ElementContext> = () => ({}), wrap: (stream: SidechatStream) => SidechatStream = (stream) => stream, opts: { readonly root?: string; readonly style?: () => PopupStyle } = {}): SidechatWorld {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), `els-sidechat-sim-${seed}-`));
  const style = opts.style ?? ((): PopupStyle => 'simple');
  const timers = fakeTimers();
  const calls: ScriptedCall[] = [];
  const screens = new Map<string, { title: string; screen: string }>();
  const forbidden: string[] = [];
  const stackViolations: string[] = [];
  let registry: OverlayRegistry | undefined;
  const hub = createSidechatHub({ now: timers.now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    panes: { title: (pane) => screens.get(pane)?.title, screen: async (pane) => { await Promise.resolve(); return screens.get(pane); } },
    push: () => pushSidechat(registry),
    stream: wrap(async function* (messages, signal) {
      const queue: Item[] = [];
      let wake: (() => void) | undefined;
      const put = async (item: Item): Promise<void> => { queue.push(item); wake?.(); await settle(); };
      signal.addEventListener('abort', () => wake?.());
      calls.push({ messages, say: (text) => put(text), end: () => put(END), fail: (message) => put(new Error(message)), aborted: () => signal.aborted });
      while (true) {
        if (!queue.length) await new Promise<void>((done) => { wake = done; if (signal.aborted) done(); });
        wake = undefined;
        if (signal.aborted) throw new Error('aborted');
        const item = queue.shift();
        if (item === undefined) continue;
        if (item === END) return;
        if (item instanceof Error) throw item;
        yield item;
      }
    }),
  });
  registry = createOverlayRegistry({ dir: join(root, 'els'), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, context: () => ({ sidechat: hub, ...context(registry!) }) });
  const closeWatch = watchSidechatClose(registry, hub);
  const stackWatch = registry.onChange((stack) => { const json = JSON.stringify(stack); for (const one of forbidden) if (json.includes(one)) stackViolations.push(`stack rev ${stack.rev} carries ${JSON.stringify(one)}`); });
  clearRestoredSidechat(registry);                         // as the server does at start (A4)
  const listing = { panes: [paneRow('w1', 'p1', 'one'), paneRow('w1', 'p2', 'two')] };
  const renderers = elementRenderers(style);
  const keys = elementKeys();
  const apps: AttachApp[] = [];

  const viewer = async (opts: { cols?: number; rows?: number; pane?: string; lag?: boolean } = {}): Promise<SidechatViewer> => {
    const wire: (() => void)[] = [];
    const attaches: { pane: string; handlers: AttachHandlers }[] = [];
    const size = { cols: opts.cols ?? 120, rows: opts.rows ?? 30 };
    const typed: string[] = [];
    const writes: string[] = [];
    const violations: string[] = [];
    const reg = registry!;
    const app = createAttachApp({
      request: async (request: ElsRequest): Promise<ElsResult> => {
        if (request.op === 'ls') return { exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: listing.panes }) };
        if (request.op === 'overlay') { const { op: _op, ...rest } = request; return reg.apply(rest); }
        return { exitCode: 0, message: '' };
      },
      attach: (pane: string, _size: unknown, handlers: AttachHandlers): Attached => { attaches.push({ pane, handlers }); return { input: (bytes) => { typed.push(bytes); }, resize: () => {}, scroll: () => {}, detach: () => {} }; },
      write: (text) => {
        writes.push(text);
        for (const one of forbidden) if (text.includes(one)) violations.push(`frame ${writes.length}: shows ${JSON.stringify(one)}`);
        // Only full frames are checked (a partial diff paint starts mid-screen).
        const lines = rowsOf(text);
        if (lines.length >= size.rows) for (const one of frameViolations(lines.slice(0, size.rows), size)) violations.push(`frame ${writes.length}: ${one}`);
      },
      size: () => size,
      cwd: '/work',
      env: { SHELL: '/bin/zsh' },
      setInterval: () => 1,
      clearInterval: () => {},
      pollMs: 1000,
      chatCommand: ['/opt/elanous/bin/elanous'],
      memory: { load: () => ({}), save: () => {} },
      overlays: {
        watch: (onStack) => { const sub = reg.onChange(() => onStack(reg.stack())); onStack(reg.stack()); return { close: () => sub.dispose() }; },
        act: (one) => {
          const land = (): void => { reg.apply({ action: one.action, id: one.id, ...(one.props !== undefined ? { props: one.props } : {}) }); };
          if (opts.lag) wire.push(land); else land();
        },
        renderers,
        keys,
        paintKey: style,
      },
    });
    apps.push(app);
    await app.start(opts.pane ?? 'p1');
    await settle();
    return { app, typed: () => typed, size, last: () => rowsOf(writes.at(-1) ?? ''), frames: () => writes.length, press: (...seq) => { for (const one of seq) app.key(one); }, violations,
      inFlight: () => wire.length, deliver: (n = wire.length) => { for (const land of wire.splice(0, n)) land(); },
      resize: (cols, rows) => { size.cols = cols; size.rows = rows; app.resized(); },
      endPane: (pane) => { for (const one of attaches.filter((entry) => entry.pane === pane)) one.handlers.onEnd(0, 'exited'); } };
  };

  return {
    registry, hub, timers, rand: prng(seed), calls, viewer, screens, forbidden, stackViolations,
    layer: () => { const one = registry!.stack().layers.filter((layer) => layer.kind === 'sidechat').at(-1); return one ? { id: one.id, props: one.props as Record<string, unknown> } : undefined; },
    removePane: (pane) => { listing.panes = listing.panes.filter((row) => row.pane !== pane); },
    flush: async () => { await settle(); timers.advance(200); await settle(); },
    root,
    crash: () => { for (const app of apps) app.key('\u0002q'); closeWatch.dispose(); stackWatch.dispose(); hub.reset(); registry!.dispose(); },
    dispose: () => { for (const app of apps) app.key('\u0002q'); closeWatch.dispose(); stackWatch.dispose(); hub.reset(); registry!.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}
