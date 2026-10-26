/** Session-scoped, immutable projection of the REPL child's task state. */
export interface BackgroundJobSnapshot {
  readonly sessionId: string;
  readonly promised: boolean;
  readonly running: number;
  readonly pending: number;
}

function nonnegativeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class BackgroundJobStatus {
  private sessionId: string | null;
  private current: BackgroundJobSnapshot | null = null;
  private readonly bySession = new Map<string, BackgroundJobSnapshot>();

  constructor(sessionId: string | null) { this.sessionId = sessionId; }

  setSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    if (this.sessionId && this.current) this.bySession.set(this.sessionId, this.current);
    this.sessionId = sessionId;
    this.current = this.bySession.get(sessionId) ?? null;
  }

  accept(json: string): boolean {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return false; }
    if (!value || typeof value !== 'object') return false;
    const frame = value as Record<string, unknown>;
    if (frame.sessionId !== this.sessionId || typeof frame.promised !== 'boolean'
      || !nonnegativeCount(frame.running) || !nonnegativeCount(frame.pending)) return false;
    this.current = Object.freeze({
      sessionId: frame.sessionId,
      promised: frame.promised,
      running: frame.running,
      pending: frame.pending,
    }) as BackgroundJobSnapshot;
    this.bySession.set(frame.sessionId as string, this.current);
    return true;
  }

  snapshot(): BackgroundJobSnapshot | null { return this.current; }

  clear(): void {
    this.current = null;
    if (this.sessionId) this.bySession.delete(this.sessionId);
  }

  line(): string {
    const state = this.current;
    if (!state) return '';
    const parts: string[] = [];
    if (state.running > 0) parts.push(`⧗ 백그라운드 ${state.running}`);
    if (state.pending > 0) parts.push(`✓ 백그라운드 끝 ${state.pending} · 결과 대기`);
    if (parts.length === 0 && state.promised) parts.push('⚠ 약속한 백그라운드 없음');
    return parts.join(' · ');
  }
}
