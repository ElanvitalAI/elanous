// SIM-WORLD-KERNEL public API (S1) — the types every world hand (memory · ta · verbs · graph · sup) codes against.
// Canonical design: seat-state/OP/evidence/20261118/SIM-WORLD-TA-AND-SUPERVISORS-1118.md §1 (D10) · §4 (verdict rules).
// Published contract: seat-state/TC/SIM-KERNEL-API.md. A rename after publication needs a «변경» line there first.
//
// A world module (e.g. src/ux-sim/sim-world/memory/scenarios.ts) exports:
//   export const simWorldScenarios: readonly SimWorldScenario[]
//   export const simWorldDevices?: readonly SimWorldDeviceDef[]   // optional · the device registration hook
// and the world pack (src/ux-sim/worlds/sim-world-<world>.yaml) lists `{ id, module }` rows that point at it.

import type { IncidentClaimStore } from '../../supervision/incident-claim.js';

/** The reserved `sim world run` ids. `all` expands to every pack in this order. */
export const SIM_WORLD_IDS = ['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip'] as const;
export type SimWorldPackId = typeof SIM_WORLD_IDS[number];
export type SimWorldReservedId = SimWorldPackId | 'all';

/** Which execution engine a scenario drives. `--engine both` runs every scenario once per engine. */
export type SimWorldEngine = 'legacy' | 'graph';
export type SimWorldEngineOption = SimWorldEngine | 'both';

/** One row of a world pack YAML. `module` is repo-relative and must stay under src/ux-sim/sim-world/. */
export interface SimWorldPackRow {
  readonly id: string;
  readonly module: string;
}
export interface SimWorldPack {
  readonly schema: 1;
  readonly world: SimWorldPackId;
  readonly scenarios: readonly SimWorldPackRow[];
}

/** Device registration hook: a world module exports these; the kernel creates each one a scenario names. */
export interface SimWorldDeviceDef<T = unknown> {
  /** Stable id from the design table, e.g. 'D17' or 'D7'. */
  readonly id: string;
  readonly title: string;
  /** Called once per scenario run, inside that scenario's isolated universe. */
  create(ctx: SimWorldDeviceContext): T | Promise<T>;
  /** Optional teardown; a throw here is recorded as an `infra-error`, never swallowed. */
  dispose?(instance: T): void | Promise<void>;
  /** Device-contract hook (quality bar 3) through device-fidelity. See SimWorldDeviceContract. */
  readonly contracts?: readonly SimWorldDeviceContract<T>[];
}
/**
 * Device-contract hook, backed by the ledger device `device-fidelity` (src/ux-sim/device-fidelity.ts). `recording` is a
 * checked-in DeviceRecording of REAL tool output (redacted); `call` picks the recorded call whose real response is the
 * reference shape. After the scenario ran, the kernel passes `responses(instance)` — the raw outputs the fake produced —
 * to compareDeviceResponseShapes, which stores the result in the fidelity store. A yellow fidelity status (missing
 * key, extra key, JSON type change, or no responses) makes the scenario `contract-violation`.
 */
export interface SimWorldDeviceContract<T = unknown> {
  readonly name: string;
  /** Repo-relative DeviceRecording JSON under src/ux-sim/ (version 1, deviceId, calls[].realResponse). */
  readonly recording: string;
  /** Index into recording.calls. */
  readonly call: number;
  responses(instance: T): readonly unknown[] | Promise<readonly unknown[]>;
}
export interface SimWorldDeviceContext {
  readonly world: SimWorldPackId;
  readonly scenarioId: string;
  readonly seed: number;
  readonly engine: SimWorldEngine;
  /** Fresh directory owned by this scenario run (its test universe). */
  readonly universeRoot: string;
  readonly recorder: SimWorldRecorder;
}

export interface SimWorldScenario {
  /** Literal id from the design table, e.g. 'M01', 'A03', 'B14'. */
  readonly id: string;
  readonly title: string;
  /** Device ids this scenario needs; each must be exported by some loaded module, or the run is `infra-error`. */
  readonly devices?: readonly string[];
  /** Engines this scenario supports. Default ['legacy', 'graph'] (engine-agnostic). */
  readonly engines?: readonly SimWorldEngine[];
  run(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome>;
}
export interface SimWorldScenarioContext extends SimWorldDeviceContext {
  /** Same seed + scenario id + engine ⇒ same sequence. Never Math.random in a scenario. */
  readonly random: () => number;
  /** Instance created by a device listed in `devices`. Throws on an unlisted id. */
  device<T>(id: string): T;
  /** Carried from `--only`; scenarios need not read it (the kernel already filtered). */
  readonly only?: string;
}
/**
 * `fail.diff` is the observed-vs-expected text (first line goes to summary.json). `fail.reason` is the literal red
 * reason the scenario OBSERVED; for an expected-red row it must equal the row's `redReason` to count as xfail.
 */
export type SimWorldScenarioOutcome = { readonly ok: true } | { readonly ok: false; readonly diff: string; readonly reason?: string };

// ── D10 recorder ────────────────────────────────────────────────────────────────────────────────────

/** One walk step = one node entry. Format fixed for the H5 legality shadow; see recorder.ts header. */
export interface SimWorldWalkStep {
  readonly i: number;
  readonly node: string;
  /** 1-based visit count of this node within the walk. */
  readonly visit: number;
  /** legacy: si round · graph: runner attempt. Null when the source has none. */
  readonly round: number | null;
  readonly source: 'onNodeEntry' | 'nodeLifecycle' | 'manual';
}
export interface SimWorldWalk {
  readonly schema: 'sim-world.walk/1';
  readonly world: SimWorldPackId;
  readonly scenario: string;
  readonly engine: SimWorldEngine;
  readonly seed: number;
  readonly steps: readonly SimWorldWalkStep[];
  /** Last node entered, or null for an empty walk. */
  readonly terminal: string | null;
}

export type SimWorldClaimOp = 'transact' | 'withCurrent';

export interface SimWorldRecorder {
  /** events.jsonl — free-form scenario/kernel events. `data` is canonicalised (sorted keys, no functions). */
  event(kind: string, data?: Readonly<Record<string, unknown>>): void;
  /** walk.json — append a node entry by hand. */
  step(node: string, round?: number | null): void;
  /** seam-calls.jsonl — record a seam call by hand. */
  seam(name: string, input: unknown, output: unknown): void;
  /** Adapter for SelfImplement `onNodeEntry(node, round)` (orchestrator.ts:2228). */
  readonly onNodeEntry: (node: string, round: number) => void;
  /** Adapter for SelfImplement `onProgress({ stage, message })` (orchestrator.ts:1330) → events.jsonl. */
  readonly onProgress: (event: { readonly stage: string; readonly message: string }) => void;
  /** Adapter for graph runner `deps.nodeLifecycle` (runner-types.ts:237); `arrival` phase becomes a walk step. */
  readonly nodeLifecycle: (event: {
    readonly phase: string; readonly nodeId: string; readonly attempt: number; readonly visit: number;
    readonly outcome?: string; readonly nextNodeId?: string; readonly reason?: string;
  }) => void;
  /** Wrap every function-valued property: each call (and its result or throw) lands in seam-calls.jsonl. */
  wrapSeams<T extends object>(seams: T): T;
  /** Wrap an IncidentClaimStore (incident-claim.ts:24) through its interface; every op lands in claims.jsonl. */
  wrapClaimStore(store: IncidentClaimStore): IncidentClaimStore;
  /** Write the five files. Never throws: a write failure comes back as `{ ok: false }` for the kernel to make loud. */
  finalize(verdict: SimWorldVerdictRecord): { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly dir: string; readonly error: string };
}

// ── verdicts (§4) ───────────────────────────────────────────────────────────────────────────────────

export type SimWorldExpectation = 'red' | 'green';
/** Rule 14 (OPS-RULES §14): absent outcome → 'absent' (UNMEASURED) · malformed outcome → 'malformed' (FAIL) · value → pass/fail. */
export type SimWorldActual = 'pass' | 'fail' | 'infra-error' | 'malformed' | 'absent';
/**
 * pass · xfail · promoted are «not red» for the run exit code; everything else fails the run.
 * xfail is NOT a pass: it is reported separately and counted separately.
 */
export type SimWorldVerdict =
  | 'pass' | 'xfail' | 'promoted'
  | 'promote-required' | 'regression' | 'ratchet-violation' | 'infra-error' | 'unlisted'
  | 'wrong-reason-red' | 'unmeasured' | 'malformed' | 'contract-violation';

export interface SimWorldVerdictRecord {
  readonly world: SimWorldPackId;
  readonly scenario: string;
  readonly engine: SimWorldEngine;
  readonly seed: number;
  readonly expected: SimWorldExpectation | null;
  readonly actual: SimWorldActual;
  readonly verdict: SimWorldVerdict;
  /** First line of the scenario diff or infra error; null on pass. */
  readonly diffFirstLine: string | null;
  /** The literal red reason the scenario reported (fail outcomes only), else null. */
  readonly observedReason: string | null;
}

/** sim-world-expect.json — one row per `<world>/<scenario>` or `<world>/<scenario>@<engine>`. */
export interface SimWorldExpectEntry {
  readonly expect: SimWorldExpectation;
  /** Set when the row first became green; the ratchet never lets it be removed or the row go red. */
  readonly greenSince?: string;
  /** Free-text note for humans. */
  readonly reason: string;
  /** Required on red rows: today's literal red reason. A red failing for another reason is `wrong-reason-red`. */
  readonly redReason?: string;
}
export interface SimWorldExpectTable {
  readonly schema: 1;
  readonly entries: Readonly<Record<string, SimWorldExpectEntry>>;
}

export interface SimWorldSummary {
  readonly schema: 'sim-world.summary/1';
  readonly runId: string;
  readonly seed: number;
  readonly engine: SimWorldEngineOption;
  readonly only: string | null;
  readonly worlds: readonly SimWorldPackId[];
  readonly mainSha: string | null;
  /** The base expectation table this run was judged against (--expect-base), so --replay judges against the same one. */
  readonly expectBase: { readonly path: string; readonly sha256: string } | null;
  readonly counts: Readonly<Record<SimWorldVerdict, number>>;
  readonly scenarios: readonly (SimWorldVerdictRecord & { readonly dir: string; readonly wallMs: number })[];
  /** Wall time per world in ms (quality bar 5: budget 180000 ms per world on minim5; over budget = warning event). */
  readonly worldWallMs: Readonly<Partial<Record<SimWorldPackId, number>>>;
  /** Set by --replay: the run replayed and every record file that differs from it. Any mismatch fails the run. */
  readonly replay: { readonly of: string; readonly mismatches: readonly { readonly dir: string; readonly file: string; readonly firstDiff: string }[] } | null;
  /** Kernel-level skip / refuse / infra events (checklist 1). */
  readonly events: readonly { readonly kind: string; readonly world: SimWorldPackId | null; readonly detail: string }[];
  readonly ok: boolean;
}
