export interface HerdrSeqStore {
  read(): number | undefined;
  write(seq: number): void;
}

const DEFAULT_SEQ_WINDOW = 65_536;

/** Reserve future sequence values before reporting so a SIGKILL restart can advance past the dead process. */
export class HerdrSequenceLease {
  private seq = 0;
  private end = 0;
  private stored: number | undefined;
  private ready = false;
  private failed = false;

  constructor(
    private readonly store: HerdrSeqStore,
    private readonly now: () => number,
    private readonly onFailure: (error: unknown) => void,
    private readonly seqWindow = DEFAULT_SEQ_WINDOW,
  ) {}

  next(): number {
    this.initialize();
    const clock = Math.floor(this.now());
    let next = Number.isFinite(clock) ? Math.max(this.seq + 1, clock) : this.seq + 1;
    if (this.stored !== undefined) next = Math.max(next, this.stored + 1);
    if (next > this.end) this.reserve(next);
    this.seq = next;
    return next;
  }

  private initialize(): void {
    if (this.ready) return;
    try {
      const stored = this.store.read();
      this.stored = typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : undefined;
    } catch (error) { this.fail(error); }
    const clock = Math.floor(this.now());
    this.seq = Number.isFinite(clock) ? Math.max(clock + this.seqWindow, this.stored ?? 0) : (this.stored ?? 0);
    this.reserve(this.seq);
    this.ready = true;
  }

  private reserve(from: number): void {
    const end = from + this.seqWindow;
    try { this.store.write(end); } catch (error) { this.fail(error); }
    this.end = end;
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.onFailure(error);
  }
}

export function staleHerdrReleaseArgs(paneId: string, source: string, agent: string, seq: number): string[] {
  return ['pane', 'release-agent', paneId, '--source', source, '--agent', agent, '--seq', String(seq)];
}
