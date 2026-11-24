import type { CapsuleEvent, CapsuleKind, CapsuleStatus } from '../../turn-capsule/contract.js';

type Row = { at: number; label: string; step: string; count: number; kind: CapsuleKind; ordinal?: number };
const icon: Record<CapsuleKind, string> = { agent: '🤖', shell: '⌨️', harness: '🛠', graph: '◈', mcp: '◇' };
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** A capsule that just finished — written once into the transcript (chat/capsule-transcript.ts), never kept in the footer. */
export interface FinishedCapsule {
  readonly kind: CapsuleKind;
  readonly icon: string;
  readonly name: string;
  readonly status: CapsuleStatus;
  readonly seconds: number;
  /** «🤖 label · status · Ns» — the capsule's own one-line summary. */
  readonly line: string;
}

/**
 * Session-local projection of RUNNING capsules. Tool arguments and outputs never enter this view.
 * CAPSULE-FOOTER-ONCE (대표 11-24 13:0x): a finished capsule leaves the footer at once — {@link accept} hands it back so
 * the caller writes it into the transcript at that moment; its later events are ignored.
 */
export class CapsuleActivity {
  private sessionId: string | null;
  private rows = new Map<string, Row>();
  private finished = new Set<string>();
  constructor(sessionId: string | null) { this.sessionId = sessionId; }
  setSessionId(sessionId: string): void {
    if (sessionId !== this.sessionId) { this.sessionId = sessionId; this.rows.clear(); this.finished.clear(); }
  }
  /** Folds one event; returns the finished capsule when this event completed it (exactly once per capsule). */
  accept(event: CapsuleEvent): FinishedCapsule | null {
    if (event.sessionId !== this.sessionId || this.finished.has(event.capsuleId)) return null;
    const previous = this.rows.get(event.capsuleId);
    const at = event.type === 'capsule-progress' ? event.at : event.endedAt;
    if (previous && at < previous.at) return null;
    if (event.type === 'capsule-done') {
      const step = clean(event.summary);
      // «label · status · Ns» → «label» (graph summaries carry no seconds) — the folded row names the first capsule.
      const name = step.replace(new RegExp(` · ${event.status}(?: · \\d+s)?$`, 'u'), '') || previous?.label || step;
      this.rows.delete(event.capsuleId);
      if (this.finished.size >= 4096) this.finished.clear();
      this.finished.add(event.capsuleId);
      return { kind: event.kind, icon: icon[event.kind], name, status: event.status,
        seconds: Math.max(0, Math.round((event.endedAt - event.startedAt) / 1000)), line: `${icon[event.kind]} ${step}` };
    }
    const line = clean(event.line);
    const started = line.endsWith(' · started');
    const label = previous?.label ?? (started ? line.slice(0, -10) : '');
    const prefix = label ? `${label} · ` : '';
    const detail = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const match = /^#(\d+)\s+/.exec(detail);
    const ordinal = match ? Number(match[1]) : undefined;
    if (ordinal !== undefined && previous?.ordinal !== undefined && ordinal <= previous.ordinal) return null;
    const step = started ? 'started' : detail.replace(/^#\d+\s+/, '');
    this.rows.set(event.capsuleId, { at, label, step, count: previous?.step === step ? previous.count + 1 : 1, kind: event.kind, ...(ordinal !== undefined ? { ordinal } : {}) });
    return null;
  }

  /** The footer: one live row per capsule kind — «🤖 N running · latest step». Nothing when nothing runs. */
  runningLines(): string[] {
    const byKind = new Map<CapsuleKind, Row[]>();
    for (const row of this.rows.values()) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
    return [...byKind].map(([kind, rows]) => {
      const latest = rows.reduce((a, b) => (b.at >= a.at ? b : a));
      return `${icon[kind]} ${rows.length} running · ${this.body(latest)}`;
    });
  }

  private body(r: Row): string {
    return `${r.label ? `${r.label} · ` : ''}${r.step}${r.count > 1 ? ` ×${r.count}` : ''}`;
  }

  /** Every running capsule on its own row. */
  lines(): string[] {
    return [...this.rows.values()].map((r) => `${icon[r.kind]} ${this.body(r)}`);
  }
}
