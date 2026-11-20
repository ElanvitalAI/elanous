// GRAPH-MEMORY-SCOPES storage port — the runner-side seam for the three memory layers (instance · template · global).
// The runner never touches a concrete store: the host injects `deps.memory = { port, tenant }` (tenant comes from the
// authenticated host, never from graph input). Any implementation (the sim D17 store, a SQLite adapter) satisfies it.
//   - A write always lands in the instance layer of this run.
//   - Template/global rows come only from `promote`, and a promote carries the approver of a human-decided approval node
//     of this same run; with no such approver the runner passes none and the store refuses (approval-required).
//   - Tenant isolation is the store's duty given the tenant on every call; the runner supplies one tenant per run.
export type PortMemoryScope = 'instance' | 'template' | 'global';
export interface PortMemoryRow { readonly id: string; readonly scope: PortMemoryScope; readonly runId: string; readonly key: string; readonly text: string }
/** Structured template key (display and docs write `seat:<SEAT>`; the store id rule keeps `:` out of ids). */
export interface TemplateKey { readonly namespace: 'seat'; readonly id: string }
/** Same rule as `src/seat-memory/seat-memory.ts` SEAT_ID. */
const SEAT_NAME = /^[A-Z][A-Z0-9_-]{0,63}$/;
/** Fields on every port call. `seatKey` is optional and is the SEAT NAME only (e.g. `TC`;
 * checked against the seat-name rule). It is never an els pane owner token: a token in a permanent key would store a secret and
 * change on every restart. When present it is attached to the instance key space so two seats of one tenant do not share lines. */
interface PortCall { tenant: string; seatKey?: string; graphId: string; runId: string }
export interface GraphMemoryPort {
  read(input: PortCall & { scopes: readonly PortMemoryScope[]; templateKey?: TemplateKey }): Promise<readonly PortMemoryRow[]>;
  write(input: PortCall & { nodeId: string; key: string; text: string; ttlMs?: number }): Promise<PortMemoryRow>;
  promote(input: PortCall & { nodeId: string; sourceId: string; to: 'template' | 'global'; approval?: { by: string }; templateKey?: TemplateKey }): Promise<PortMemoryRow>;
}
/** isolated-session = read only; session · inline = may write the instance layer (default session). */
export type MemoryIsolationMode = 'isolated-session' | 'session' | 'inline';
/** The one place every write passes before the port (a throw refuses it). Real wiring to memory-triage/write-gate.ts
 * `applyMemoryWriteGate` is a follow-up; this is the signature slot only. */
export type MemoryWriteGate = (write: { tenant: string; seatKey?: string; graphId: string; runId: string; nodeId: string;
  key: string; text: string }) => void | Promise<void>;
export interface GraphMemoryBinding {
  readonly port: GraphMemoryPort; readonly tenant: string; readonly seatKey?: string;
  readonly mode?: MemoryIsolationMode; readonly writeGate?: MemoryWriteGate;
}
/** MEMORY-SEAT-TEMPLATE-KEY (#39188 §4-3): with a seatKey, template reads and template promotes use key `{namespace:'seat', id:<seat name>}` (shown as `seat:<SEAT>`)
 * (seat memory is a key space of the template layer, not a separate store); without one nothing is added. */
const templateSpace = (b: GraphMemoryBinding): { templateKey?: TemplateKey } => b.seatKey ? { templateKey: { namespace: 'seat', id: b.seatKey } } : {};
const callBase = (b: GraphMemoryBinding, graphId: string, runId: string): PortCall => {
  if (b.seatKey !== undefined && !SEAT_NAME.test(b.seatKey)) throw new Error('memory refused: seatKey must be a seat name');
  return { tenant: b.tenant, ...(b.seatKey ? { seatKey: b.seatKey } : {}), graphId, runId };
};
/** What a handler may ask for through its result: lines to remember, keys of this run's lines to promote. */
export interface HandlerMemoryRequest {
  readonly write?: readonly { key: string; text: string; ttlMs?: number }[];
  readonly promote?: readonly { key: string; to: 'template' | 'global'; approvalNode?: string }[];
}
const SCOPES: readonly PortMemoryScope[] = ['instance', 'template', 'global'];

/** Rows the node may see: this run's instance lines, its graph's template lines, the tenant's global lines. */
export function readNodeMemory(binding: GraphMemoryBinding, graphId: string, runId: string): Promise<readonly PortMemoryRow[]> {
  return binding.port.read({ ...callBase(binding, graphId, runId), ...templateSpace(binding), scopes: SCOPES });
}

function parseRequest(raw: unknown): HandlerMemoryRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('handler memory request must be an object');
  const request = raw as Record<string, unknown>;
  const lines = (name: string, need: (row: Record<string, unknown>) => boolean) => {
    const value = request[name];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(row => row && typeof row === 'object' && need(row as Record<string, unknown>)))
      throw new Error(`handler memory request ${name} is malformed`);
    return value as Record<string, unknown>[];
  };
  const write = lines('write', row => typeof row.key === 'string' && typeof row.text === 'string' &&
    (row.ttlMs === undefined || typeof row.ttlMs === 'number'));
  const promote = lines('promote', row => typeof row.key === 'string' && (row.to === 'template' || row.to === 'global') && (row.approvalNode === undefined || typeof row.approvalNode === 'string'));
  return { write: write as never, promote: promote as never };
}

/**
 * Apply a handler's memory request in order: every write first, then every promote. Any store refusal throws, so the node
 * fails closed with the store's literal message in its output. `approvedBy` is the decider of an earlier approval node of
 * this run — a promote without it is passed on without approval and the store refuses it.
 */
export async function applyHandlerMemory(binding: GraphMemoryBinding, ctx: { graphId: string; runId: string; nodeId: string },
  rawRequest: unknown, approverFor: (entry: { approvalNode?: string; to: 'template' | 'global' }, sourceId: string) => string | undefined): Promise<Array<{ key: string; id: string }>> {
  const request = parseRequest(rawRequest);
  if ((request.write?.length || request.promote?.length) && binding.mode === 'isolated-session')
    throw new Error('memory write refused: read-only-binding');
  const call = callBase(binding, ctx.graphId, ctx.runId);
  const base = { ...call, nodeId: ctx.nodeId };
  const written: Array<{ key: string; id: string }> = [];
  for (const line of request.write ?? []) {
    await binding.writeGate?.({ ...base, key: line.key, text: line.text });
    const row = await binding.port.write({ ...base, key: line.key, text: line.text, ...(line.ttlMs === undefined ? {} : { ttlMs: line.ttlMs }) });
    written.push({ key: line.key, id: row.id });
  }
  for (const entry of request.promote ?? []) {
    const own = await binding.port.read({ ...call, scopes: ['instance'] });
    const source = own.find(row => row.runId === ctx.runId && row.key === entry.key);
    if (!source) throw new Error(`memory promote refused: not-found (${entry.key})`);
    const approvedBy = approverFor(entry, source.id);
    if (!approvedBy) throw new Error('memory promote refused: approval-required');
    await binding.port.promote({ ...base, sourceId: source.id, to: entry.to, ...(entry.to === 'template' ? templateSpace(binding) : {}), approval: { by: approvedBy } });
  }
  return written;
}
