// A scripted child target for the S3 test universe; it does not implement admission or a production worker.
export type S3Fault = 'hold' | 'death' | 'delay' | 'duplicate' | 'burst' | 'approval' | 'disconnect';
export type S3Event = { readonly kind: 'started' | 'completed' | 'failed' | 'approval' | 'disconnected'; readonly id: string; readonly text?: string };

export class S3AgentFixture {
  readonly events: S3Event[] = [];
  private readonly held = new Map<string, string>();
  constructor(private readonly emit: (event: S3Event) => void = () => {}) {}
  private push(event: S3Event): void { this.events.push(event); this.emit(event); }
  start(id: string, fault: S3Fault, text: string): void {
    if (this.held.has(id)) throw new Error(`duplicate active fixture id: ${id}`);
    this.push({ kind: 'started', id });
    if (fault === 'death') { this.push({ kind: 'failed', id }); return; }
    if (fault === 'disconnect') { this.push({ kind: 'disconnected', id }); return; }
    if (fault === 'approval') this.push({ kind: 'approval', id });
    if (fault === 'hold' || fault === 'delay' || fault === 'approval') { this.held.set(id, text); return; }
    const count = fault === 'duplicate' ? 2 : 1;
    for (let i = 0; i < count; i++) this.push({ kind: 'completed', id, text });
  }
  release(id: string): boolean {
    const text = this.held.get(id);
    if (text === undefined) return false;
    this.held.delete(id); this.push({ kind: 'completed', id, text }); return true;
  }
  stop(id: string): boolean {
    if (!this.held.delete(id)) return false;
    this.push({ kind: 'failed', id }); return true;
  }
  burst(ids: readonly string[], text: string): void { for (const id of ids) this.start(id, 'burst', text); }
}
