/**
 * Widget sim harness — every TUI widget/scene is a pure `(model, width, frame?) → lines`. A sim world feeds it a
 * stream of models and this harness checks the invariants that must hold at every frame:
 *   fit       — no line wider than the pane, no more lines than the pane height (when given)
 *   stable    — the same model renders the same lines (no hidden clock / randomness)
 *   still     — a model flagged `still` (nothing changed since the last snapshot) renders identical tween frames
 * Violations come back as data so tests and the sim CLI share one report.
 */

export interface WidgetSimPane {
  readonly width: number;
  readonly height?: number;
}

export interface WidgetSimStep<M> {
  readonly label: string;
  readonly model: M;
  /** Nothing moved since the previous snapshot — every tween frame must be identical. */
  readonly still?: boolean;
}

export interface WidgetSimSubject<M> {
  readonly name: string;
  readonly render: (model: M, width: number, frame: number) => readonly string[];
  /** Tween frames per snapshot (1 for static widgets). */
  readonly frames?: number;
}

export interface WidgetSimViolation {
  readonly subject: string;
  readonly step: string;
  readonly pane: string;
  readonly frame: number;
  readonly kind: 'overflow-width' | 'overflow-height' | 'unstable' | 'moved-while-still';
  readonly detail: string;
}

export interface WidgetSimReport {
  readonly subject: string;
  readonly frames: number;
  readonly violations: readonly WidgetSimViolation[];
}

export function runWidgetSim<M>(subject: WidgetSimSubject<M>, steps: Iterable<WidgetSimStep<M>>, panes: readonly WidgetSimPane[]): WidgetSimReport {
  const frames = Math.max(1, subject.frames ?? 1);
  const violations: WidgetSimViolation[] = [];
  let count = 0;
  for (const step of steps) {
    for (const pane of panes) {
      const paneLabel = `${pane.width}x${pane.height ?? '∞'}`;
      let first: string | undefined;
      for (let frame = 0; frame < frames; frame++) {
        const lines = subject.render(step.model, pane.width, frame);
        count += 1;
        const at = { subject: subject.name, step: step.label, pane: paneLabel, frame };
        lines.forEach((line, i) => {
          const w = Bun.stringWidth(line);
          if (w > pane.width) violations.push({ ...at, kind: 'overflow-width', detail: `line ${i} is ${w} cells: ${line}` });
        });
        if (pane.height !== undefined && lines.length > pane.height) violations.push({ ...at, kind: 'overflow-height', detail: `${lines.length} lines` });
        const again = subject.render(step.model, pane.width, frame).join('\n');
        if (again !== lines.join('\n')) violations.push({ ...at, kind: 'unstable', detail: 'second render differs' });
        if (frame === 0) first = again;
        else if (step.still && again !== first) violations.push({ ...at, kind: 'moved-while-still', detail: 'tween frame differs from frame 0' });
      }
    }
  }
  return { subject: subject.name, frames: count, violations };
}

/** Deterministic PRNG for sim seeds (mulberry32). */
export function simRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
