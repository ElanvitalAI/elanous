// ── VW-term-infra Phase 1 — ExternalTerminalPane ──
//
// Wraps a Shell Runner ShellHandle (mode='vw' · runner-label-bound
// PreviewTerminal) as a Pane. Phase 1 scope is a thin structural
// wrapper over the ShellHandle. The retired VW PaneContent adapter is
// not used by this Pane contract — describe() exposes the runner label,
// snapshot() calls
// into the Shell Runner's bookmark/renderForLLM, and addTap('raw')
// subscribes to the engine chunk stream.
//
// Phase 1 keeps the actual wiring to the Shell Runner's host factory
// behind a TODO; the class is structurally complete and ready for the
// Phase 2 dispatcher refactor to swap it in.

import { debug } from '../debug/log.js';
import type { Rect } from '../display/rect.js';
import type { BoundaryEvent, ShellHandle, ShellStatus } from '../shell-runner/types.js';
import { AbstractPane } from './base.js';
import { emptySnapshot, type PaneSnapshot, type SnapshotOpts } from './snapshot.js';
import {
  PaneTapNotSupportedError,
  type FrameChunk,
  type PaneEvent,
  type RawChunk,
  type TapCallback,
  type TapKind,
  type Unsubscribe,
} from './tap.js';
import type { ClickRegion, PaneKind, PaneRef, TapOptions } from './types.js';

export class ExternalTerminalPane extends AbstractPane {
  constructor(ref: PaneRef, private readonly handle: ShellHandle) {
    super(ref);
  }

  get kind(): PaneKind {
    return { kind: 'external-terminal', shellHandleId: this.handle.id };
  }

  render(bounds: Rect): readonly ClickRegion[] {
    this.lastBounds = bounds;
    return [
      { id: `${this.ref.paneId}:external-terminal:${this.handle.id}`, rect: bounds, kind: 'external-terminal' },
    ];
  }

  protected describeTitle(): string {
    return `runner:${this.ref.runnerLabel ?? this.handle.id}`;
  }

  protected describeSummary(): string {
    return `external-terminal ${this.handle.id} · mode=${this.handle.mode} · status=${this.handle.status}`;
  }

  protected supportedTaps(): readonly TapKind[] {
    return ['raw', 'frame', 'event'];
  }

  async snapshot(_opts?: SnapshotOpts): Promise<PaneSnapshot> {
    const dims = this.lastBounds ?? { row: 0, col: 0, width: 0, height: 0 };
    // Phase 2b will fill with ShellHandle-bound PreviewTerminal
    // renderForLLM + bookmark slice; Phase 1 returns an empty-but-
    // structurally-valid snapshot.
    return emptySnapshot(this.ref, this.kind, dims);
  }

  addTap(kind: TapKind, cb: TapCallback, opts?: TapOptions): Unsubscribe {
    if (kind === 'raw') {
      // ShellHandle.onChunk returns an Unsubscribe directly.
      return this.handle.onChunk((chunk) => {
        const raw: RawChunk = { bytes: chunk.bytes, ts: chunk.ts };
        try { (cb as (c: RawChunk) => void)(raw); } catch { /* isolate */ }
      });
    }

    if (kind === 'frame') {
      // Lossy frame tap: accumulate raw chunks and emit on interval.
      // A future commit (W3-ext) can wire to Shell Runner's registry
      // to fetch the bound PreviewTerminal and call .render(false) for
      // precise frames. For W3 this gives observers a live activity
      // stream they can diff / timestamp without engine changes.
      const throttleMs = Math.max(16, opts?.throttleMs ?? 200);
      const maxBuf = Math.max(1024, opts?.maxBufferBytes ?? 64 * 1024);
      let acc = '';
      const offChunk = this.handle.onChunk((chunk) => {
        acc += chunk.bytes;
        if (acc.length > maxBuf) acc = acc.slice(-maxBuf);
      });
      let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (!acc) return;
        const dims = this.lastBounds ?? { row: 0, col: 0, width: 80, height: 24 };
        const frame: FrameChunk = {
          mime: 'text/ansi',
          bytes: acc,
          dims,
          ts: Date.now(),
        };
        acc = '';
        try { (cb as (f: FrameChunk) => void)(frame); } catch { /* isolate */ }
      }, throttleMs);
      if (debug.enabled) {
        debug.log('pane.tap.frame.start', `${this.ref.paneId}`, {
          kind: 'external-terminal', throttleMs, lossy: true,
        });
      }
      return () => {
        offChunk();
        if (timer) { clearInterval(timer); timer = null; }
        if (debug.enabled) {
          debug.log('pane.tap.frame.stop', `${this.ref.paneId}`, {});
        }
      };
    }

    if (kind === 'event') {
      // W3-ext-2 — fan out Shell Runner lifecycle events.
      //   - onBoundary('cmd-end', exitCode) → PaneEvent.exit
      //   - onStatus('completed' | 'killed') → PaneEvent.exit (fallback
      //     when the engine lacks an exit boundary, e.g. File engine)
      //   - onBoundary('prompt-start') → PaneEvent.title (best-effort —
      //     represents "new command line ready" transitions)
      //   - onStatus('backgrounded') → PaneEvent.unmount (surface flipped
      //     to 'bg' — the pane no longer owns a visible rect)
      // Dedup: after firing 'exit' once we don't re-emit; downstream
      // consumers typically stop caring once the session ended.
      let exitEmitted = false;
      const fire = (ev: PaneEvent): void => {
        if (ev.kind === 'exit') {
          if (exitEmitted) return;
          exitEmitted = true;
        }
        try { (cb as (e: PaneEvent) => void)(ev); } catch { /* isolate */ }
      };
      const offBoundary = this.handle.onBoundary((b: BoundaryEvent) => {
        if (b.kind === 'cmd-end') {
          fire({ kind: 'exit', code: b.exitCode ?? null });
        } else if (b.kind === 'prompt-start') {
          fire({ kind: 'title', title: 'prompt-start' });
        }
      });
      const offStatus = this.handle.onStatus((s: ShellStatus) => {
        if (s === 'completed' || s === 'killed') {
          fire({ kind: 'exit', code: null });
        } else if (s === 'backgrounded') {
          fire({ kind: 'unmount' });
        }
      });
      if (debug.enabled) {
        debug.log('pane.tap.event.start', `${this.ref.paneId}`, {
          kind: 'external-terminal',
        });
      }
      return () => {
        offBoundary();
        offStatus();
        if (debug.enabled) {
          debug.log('pane.tap.event.stop', `${this.ref.paneId}`, {});
        }
      };
    }

    throw new PaneTapNotSupportedError(kind, this.ref.paneId);
  }
}
