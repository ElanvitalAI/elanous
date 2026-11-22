import type { CapsuleEvent, CapsuleKind } from '../../turn-capsule/contract.js';

type Row = { at: number; label: string; step: string; count: number; kind: CapsuleKind; done: boolean; ordinal?: number };
const icon: Record<CapsuleKind, string> = { agent: '🤖', shell: '⌨️', harness: '🛠', graph: '◈', mcp: '◇' };
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Session-local folded projection. Tool arguments and outputs never enter this view. */
export class CapsuleActivity {
  private sessionId: string | null;
  private rows = new Map<string, Row>();
  constructor(sessionId: string | null) { this.sessionId = sessionId; }
  setSessionId(sessionId: string): void {
    if (sessionId !== this.sessionId) { this.sessionId = sessionId; this.rows.clear(); }
  }
  accept(event: CapsuleEvent): void {
    if (event.sessionId !== this.sessionId) return;
    const previous = this.rows.get(event.capsuleId);
    const at = event.type === 'capsule-progress' ? event.at : event.endedAt;
    if (previous && (at < previous.at || previous.done)) return;
    if (event.type === 'capsule-done') {
      this.rows.set(event.capsuleId, { at, label: '', step: clean(event.summary), count: 1, kind: event.kind, done: true });
      return;
    }
    const line = clean(event.line);
    const started = line.endsWith(' · started');
    const label = previous?.label ?? (started ? line.slice(0, -10) : '');
    const prefix = label ? `${label} · ` : '';
    const detail = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const match = /^#(\d+)\s+/.exec(detail);
    const ordinal = match ? Number(match[1]) : undefined;
    if (ordinal !== undefined && previous?.ordinal !== undefined && ordinal <= previous.ordinal) return;
    const step = started ? 'started' : detail.replace(/^#\d+\s+/, '');
    this.rows.set(event.capsuleId, { at, label, step, count: previous?.step === step ? previous.count + 1 : 1, kind: event.kind, done: false, ...(ordinal !== undefined ? { ordinal } : {}) });
  }
  lines(): string[] {
    return [...this.rows.values()].map((r) => `${icon[r.kind]} ${r.label ? `${r.label} · ` : ''}${r.step}${r.count > 1 ? ` ×${r.count}` : ''}`);
  }
}
