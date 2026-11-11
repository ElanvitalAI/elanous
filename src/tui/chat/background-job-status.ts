/** Session-scoped, immutable projection of the REPL child's task state. */
export interface BackgroundJobSnapshot {
  readonly sessionId: string;
  readonly promised: boolean;
  readonly running: number;
  readonly pending: number;
  readonly tasks?: readonly BackgroundTaskSnapshot[];
}

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly label: string;
  readonly state: 'pending' | 'running' | 'done' | 'error' | 'aborted';
}

const TASK_STATES = new Set(['pending', 'running', 'done', 'error', 'aborted']);

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
    const tasks = Array.isArray(frame.tasks) ? frame.tasks.filter((task): task is BackgroundTaskSnapshot =>
      task && typeof task === 'object' && typeof task.id === 'string' && typeof task.label === 'string'
      && TASK_STATES.has(task.state)) : [];
    this.current = Object.freeze({
      sessionId: frame.sessionId,
      promised: frame.promised,
      running: frame.running,
      pending: frame.pending,
      ...(Array.isArray(frame.tasks) ? { tasks } : {}),
    }) as BackgroundJobSnapshot;
    this.bySession.set(frame.sessionId as string, this.current);
    return true;
  }

  snapshot(): BackgroundJobSnapshot | null { return this.current; }

  /** The visible prefix must be long enough to select this exact task with /tasks stop. */
  displayTaskId(id: string): string {
    const tasks = this.current?.tasks ?? [];
    for (let length = Math.min(8, id.length); length < id.length; length++) {
      const prefix = id.slice(0, length);
      if (tasks.filter((task) => task.id.startsWith(prefix)).length === 1) return prefix;
    }
    return id;
  }

  taskLines(): string[] {
    return (this.current?.tasks ?? []).map((task) => {
      const state = task.state === 'error' ? 'failed' : task.state;
      return `${this.displayTaskId(task.id)} · ${task.label} · ${state}`;
    });
  }

  resolveTask(prefix: string): string | null {
    const matches = (this.current?.tasks ?? []).filter((task) => task.id.startsWith(prefix));
    return matches.length === 1 ? matches[0]!.id : null;
  }

  clear(): void {
    this.current = null;
    if (this.sessionId) this.bySession.delete(this.sessionId);
  }

  line(): string {
    const state = this.current;
    if (!state) return '';
    const parts: string[] = [];
    if (state.running > 0) parts.push(`⧗ 백그라운드 ${state.running}`);
    if (state.pending > 0) parts.push(`✓ 결과 대기 ${state.pending}`);
    if (parts.length === 0 && state.promised) parts.push('⚠ 약속한 백그라운드 없음');
    return parts.join(' · ');
  }
}
