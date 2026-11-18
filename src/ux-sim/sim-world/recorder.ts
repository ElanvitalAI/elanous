// D10 sim-recorder — one deterministic record per scenario run (SIM-WORLD §1 D10 · §4 산출).
//
// Directory: <state>/sim-world/<runId>/<scn>/   (`--engine both` → <scn>@legacy and <scn>@graph)
//   events.jsonl      {"data":{…},"kind":"…","seq":n}                         scenario + adapter events
//   walk.json         SimWorldWalk (schema "sim-world.walk/1")               node entries in entry order
//   seam-calls.jsonl  {"input":…,"output":…|"error":"…","seam":"…","seq":n}  wrapped seam calls
//   claims.jsonl      {"incidentId":…,"op":"transact"|"withCurrent","seq":n,…} wrapped IncidentClaimStore ops
//   verdict.json      SimWorldVerdictRecord
//
// FORMAT (fixed for the H5 legality shadow, which reads walk.json):
//   · every object is written with keys in code-point order; JSON files use 2-space indent + one trailing "\n";
//     jsonl files are one compact object per line, each line ending "\n" (an empty stream is an empty file).
//   · walk step = { i, node, round, source, visit }: i is 0-based entry order, visit is the 1-based count of
//     that node so far, round is the si round / runner attempt (null when the source has none).
//     source: onNodeEntry (SelfImplement orchestrator.ts:2228) · nodeLifecycle (runner-types.ts:237, phase
//     "arrival" only) · manual (recorder.step). terminal = last node entered, or null.
//   · seq is a single counter per stream, reserved when the call STARTS (an async seam that finishes later still
//     owns its start-order seq; its result or error is written into that slot; one still running at finalize stays
//     {"pending":true}). Values are canonicalised: undefined dropped, functions →
//     "[function]", Error → {"error":message}, Date → ISO, Map/Set → arrays, other class instances →
//     "[ClassName]", cycles → "[circular]", non-finite numbers and bigint → strings.
//   · any UUID-shaped string (claim tokens, run ids) becomes "uuid-N" by first appearance in file order
//     (events → walk → seam-calls → claims → verdict). Object keys are emitted in code-point order with no intermediate
//     object, so integer-like keys ("10" < "2" < "a") are not reordered by JS enumeration.
// So: same scenario + seed + engine, with a scenario that does not race itself, ⇒ byte-identical five files.
//
// Nothing is written until finalize(); finalize never throws — a failed serialization (getter/Proxy throw) or write
// returns { ok:false } and the kernel
// turns it into an `infra-error` verdict plus a kernel event (never a silent pass).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncidentClaimStore } from '../../supervision/incident-claim.js';
import type { SimWorldEngine, SimWorldPackId, SimWorldRecorder, SimWorldVerdictRecord, SimWorldWalk, SimWorldWalkStep } from './types.js';

export const SIM_WORLD_RECORD_FILES = ['events.jsonl', 'walk.json', 'seam-calls.jsonl', 'claims.jsonl', 'verdict.json'] as const;

export interface SimWorldRecorderOptions {
  readonly dir: string;
  readonly world: SimWorldPackId;
  readonly scenario: string;
  readonly engine: SimWorldEngine;
  readonly seed: number;
  /** Test seam for the disk-failure axis; defaults to node:fs. */
  readonly fs?: { mkdir(path: string): void; write(path: string, text: string): void };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** Code-point order (not UTF-16 unit order, not JS integer-key enumeration order). */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const diff = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function wrap(open: string, close: string, parts: readonly string[], indent: number, depth: number): string {
  if (parts.length === 0) return `${open}${close}`;
  if (indent <= 0) return `${open}${parts.join(',')}${close}`;
  const pad = ' '.repeat(indent * (depth + 1));
  return `${open}\n${parts.map((part) => `${pad}${part}`).join(',\n')}\n${' '.repeat(indent * depth)}${close}`;
}

/**
 * Emits JSON text directly — no intermediate object, so integer-like keys ("10", "2") keep code-point order instead
 * of JS enumeration order. undefined/symbol members are dropped (array slots become null); throws if a getter or
 * Proxy throws (callers own the never-throws boundary).
 */
function emit(value: unknown, seen: Set<object>, indent: number, depth: number): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'function') return '"[function]"';
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '"[circular]"';
  const object = (entries: readonly (readonly [string, unknown])[]) => wrap('{', '}', entries.flatMap(([key, item]) => {
    const text = emit(item, seen, indent, depth + 1);
    return text === undefined ? [] : [`${JSON.stringify(key)}${indent > 0 ? ': ' : ':'}${text}`];
  }), indent, depth);
  if (value instanceof Error) return object([['error', value.message]]);
  if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString());
  seen.add(value);
  try {
    const list = (items: readonly unknown[]) => wrap('[', ']', items.map((item) => emit(item, seen, indent, depth + 1) ?? 'null'), indent, depth);
    if (Array.isArray(value)) return list(value);
    if (value instanceof Map) return list([...value.entries()]);
    if (value instanceof Set) return list([...value]);
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) return JSON.stringify(`[${(value as object).constructor?.name ?? 'object'}]`);
    const record = value as Record<string, unknown>;
    return object(Object.keys(record).sort(compareCodePoints).map((key) => [key, record[key]] as const));
  } finally { seen.delete(value); }
}

/** Canonical JSON: keys in code-point order at every depth (exported for the kernel's summary and for H5 consumers). */
export function canonicalJson(value: unknown, indent = 0): string {
  return emit(value, new Set(), indent, 0) ?? 'null';
}

export function createSimWorldRecorder(options: SimWorldRecorderOptions): SimWorldRecorder {
  // Each stream holds one serialized (not yet UUID-scrubbed) line per seq. Serializing at record time snapshots the
  // value; a serializer throw is kept and reported by finalize (never thrown into the scenario or the observed code).
  const events: string[] = [];
  const seams: string[] = [];
  const claims: string[] = [];
  const failures: string[] = [];
  const steps: SimWorldWalkStep[] = [];
  const visits = new Map<string, number>();
  const serialize = (stream: string, record: Record<string, unknown>): string => {
    try { return canonicalJson(record); }
    catch (error) {
      failures.push(`${stream} seq ${String(record.seq)}: ${error instanceof Error ? error.message : String(error)}`);
      return canonicalJson({ seq: record.seq, unserializable: true });
    }
  };
  const pushStep = (node: string, round: number | null, source: SimWorldWalkStep['source']) => {
    const visit = (visits.get(node) ?? 0) + 1;
    visits.set(node, visit);
    steps.push({ i: steps.length, node, round, source, visit });
  };
  const event = (kind: string, data: Readonly<Record<string, unknown>> = {}) => {
    events.push(serialize('events', { seq: events.length, kind, data }));
  };
  /** Reserve the seam's seq when the call starts; the result (or error) is written into that same slot. */
  const startSeam = (name: string, input: unknown) => {
    const seq = seams.length;
    seams.push(serialize('seam-calls', { seq, seam: name, input, pending: true }));
    return {
      done: (output: unknown) => { seams[seq] = serialize('seam-calls', { seq, seam: name, input, output }); },
      failed: (error: unknown) => { seams[seq] = serialize('seam-calls', { seq, seam: name, input, error: error instanceof Error ? error.message : String(error) }); },
    };
  };
  const seam = (name: string, input: unknown, output: unknown) => startSeam(name, input).done(output);
  const claim = (record: Record<string, unknown>) => { claims.push(serialize('claims', { ...record, seq: claims.length })); };

  const recorder: SimWorldRecorder = {
    event,
    step: (node, round = null) => pushStep(node, round, 'manual'),
    seam,
    onNodeEntry: (node, round) => pushStep(node, round, 'onNodeEntry'),
    onProgress: ({ stage, message }) => event('si.progress', { stage, message }),
    nodeLifecycle: (lifecycle) => {
      if (lifecycle.phase === 'arrival') pushStep(lifecycle.nodeId, lifecycle.attempt, 'nodeLifecycle');
      event('graph.node-lifecycle', { phase: lifecycle.phase, nodeId: lifecycle.nodeId, attempt: lifecycle.attempt,
        visit: lifecycle.visit, outcome: lifecycle.outcome, nextNodeId: lifecycle.nextNodeId, reason: lifecycle.reason });
    },
    wrapSeams<T extends object>(target: T): T {
      return new Proxy(target, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver) as unknown;
          if (typeof value !== 'function' || typeof property !== 'string') return value;
          return (...args: unknown[]) => {
            const input = args.length === 1 ? args[0] : args;
            const slot = startSeam(property, input);
            let result: unknown;
            try { result = (value as (...a: unknown[]) => unknown).apply(object, args); }
            catch (error) { slot.failed(error); throw error; }
            if (result instanceof Promise) {
              return result.then((resolved) => { slot.done(resolved); return resolved; },
                (error: unknown) => { slot.failed(error); throw error; });
            }
            slot.done(result);
            return result;
          };
        },
      });
    },
    wrapClaimStore(store: IncidentClaimStore): IncidentClaimStore {
      const failed = (op: string, incidentId: string, error: unknown): never => {
        claim({ op, incidentId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      };
      return {
        transact: (incidentId, update) => store.transact(incidentId, (current) => {
          const outcome = update(current);
          claim({ op: 'transact', incidentId, before: current, after: outcome.next, result: outcome.result });
          return outcome;
        }).catch((error: unknown) => failed('transact', incidentId, error)),
        withCurrent: async (input, action, completeWhen) => {
          const outcome = await store.withCurrent(input, action, completeWhen)
            .catch((error: unknown) => failed('withCurrent', input.incidentId, error));
          claim({ op: 'withCurrent', incidentId: input.incidentId, claimToken: input.claimToken, current: outcome.current });
          return outcome;
        },
      };
    },
    finalize(verdict: SimWorldVerdictRecord) {
      try {
        const io = options.fs ?? { mkdir: (path: string) => mkdirSync(path, { recursive: true }), write: (path: string, text: string) => writeFileSync(path, text) };
        if (failures.length > 0) throw new Error(`record serialization failed: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`);
        const walk: SimWorldWalk = { schema: 'sim-world.walk/1', world: options.world, scenario: options.scenario,
          engine: options.engine, seed: options.seed, steps, terminal: steps.at(-1)?.node ?? null };
        // UUIDs are numbered by first appearance in file order (events → walk → seam-calls → claims → verdict).
        const uuids = new Map<string, string>();
        const scrub = (text: string) => text.replace(UUID, (match) => {
          const key = match.toLowerCase();
          if (!uuids.has(key)) uuids.set(key, `uuid-${uuids.size + 1}`);
          return uuids.get(key)!;
        });
        const jsonl = (rows: readonly string[]) => scrub(rows.map((row) => `${row}\n`).join(''));
        const files: [string, string][] = [];
        files.push(['events.jsonl', jsonl(events)]);
        files.push(['walk.json', `${scrub(canonicalJson(walk, 2))}\n`]);
        files.push(['seam-calls.jsonl', jsonl(seams)]);
        files.push(['claims.jsonl', jsonl(claims)]);
        files.push(['verdict.json', `${scrub(canonicalJson(verdict, 2))}\n`]);
        io.mkdir(options.dir);
        for (const [name, text] of files) io.write(join(options.dir, name), text);
        return { ok: true, dir: options.dir };
      } catch (error) {
        let message: string;
        try { message = error instanceof Error ? error.message : String(error); } catch { message = 'unprintable error'; }
        return { ok: false, dir: options.dir, error: message };
      }
    },
  };
  return recorder;
}
