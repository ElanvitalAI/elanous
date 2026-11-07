import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimClock } from './fake-clock.js';
import type { SimWorld } from './world.js';

export const RLA_EVENT_RESPONSE_EVENTS = [
  { id: 'RLA-ER-01', kind: 'gate-regression', name: 'Gate regression introduced>0', baseline: 'immediate detection; attribution 9m; repair/land ≈90m; 4 human resumes', target: 'automatic attribution, repair node, automatic resume', facts: { introducedRegressions: 1, gate: 'typecheck' }, expectedRecovery: { attributed: true, repairNodeCreated: true, autoResumed: true }, maxJudgmentMs: 600_000 },
  { id: 'RLA-ER-02', kind: 'receipt-shard-corruption', name: 'Receipt shard corruption', baseline: 'whole gate rerun 34m', target: 'rerun only the damaged shard', facts: { damagedShardId: 'receipt-shard-7', intactShardsPresent: true }, expectedRecovery: { rerunShardIds: ['receipt-shard-7'], intactShardsSkipped: true }, maxRecoveryMs: 300_000 },
  { id: 'RLA-ER-03', kind: 'stale-generated-artifact', name: 'Stale generated artifact', baseline: 'found only through 41 regressions', target: 'train regeneration commit with zero regressions', facts: { generatedRevision: 'old', sourceRevision: 'current' }, expectedRecovery: { regenerationCommitCreated: true, regressionCount: 0 } },
  { id: 'RLA-ER-04', kind: 'worker-death-stop-at', name: 'Worker death (STOP_AT)', baseline: 'hand-found 25m later', target: 'restart automatically on next tick', facts: { workerStatus: 'stopped', stopAtReached: true }, expectedRecovery: { workerStatus: 'running', restartedOnNextTick: true } },
  { id: 'RLA-ER-05', kind: 'host-outage-load', name: 'Host outage or load', baseline: 'hourly manual check and cell adjustment', target: 'adjust cells and pool automatically', facts: { hostStatus: 'unreachable', loadRatio: 1.3 }, expectedRecovery: { hostCapacityAdjusted: true, poolAdjusted: true } },
  { id: 'RLA-ER-06', kind: 'github-server-push-rejection', name: 'GitHub server push rejection', baseline: 'retry varies by seat', target: 'classify server transient and back off', facts: { pushStatus: 503, responseClass: 'server-error' }, expectedRecovery: { classification: 'server-transient', backoffApplied: true } },
  { id: 'RLA-ER-07', kind: 'rehearsal-unmeasured', name: 'Unmeasured rehearsal stage', baseline: 'manual retry twice; remained unmeasured', target: 'downgrade to full run and issue receipt', facts: { rehearsalStage: 'unmeasured', retryCount: 2 }, expectedRecovery: { fullRunDowngrade: true, receiptIssued: true } },
  { id: 'RLA-ER-08', kind: 'gate-waiver', name: 'Gate waiver', baseline: '20+ manual waivers', target: 'write waiver event ledger and expose it to graph', facts: { waiverPresent: true, waiverReason: 'authorized simulation waiver' }, expectedRecovery: { waiverLedgerWritten: true, graphReadWaiver: true } },
  { id: 'RLA-ER-09', kind: 'normal-release-blocked', name: 'Normal release blocked', baseline: 'missed 06:00 release', target: 'judge emergency release switch', facts: { releaseStatus: 'blocked', scheduledAt: '06:00' }, expectedRecovery: { emergencySwitchJudged: true, emergencyReleaseAuthorized: true } },
  { id: 'RLA-ER-10', kind: 'ta-pod-gate-host-intrusion', name: 'TA Pod gate host intrusion', baseline: 'hand-monitored script', target: 'reserve and block through event hook', facts: { hostId: 'ta-pod-gate', intrusionPresent: true }, expectedRecovery: { hostReserved: true, intrusionBlocked: true } },
] as const;

export const RLA_EVENT_RESPONSE_SAMPLE_COUNT = 3; // RFC §A6 shadow-to-production agreement default.
export type RecoveryLevel = 'automatic' | 'semi-automatic' | 'manual' | 'none';
export interface RlaEventResponseContext {
  readonly world: SimWorld;
  readonly eventId: string;
  readonly kind: (typeof RLA_EVENT_RESPONSE_EVENTS)[number]['kind'];
  readonly sample: number;
  readonly incident: {
    readonly path: string;
    readonly facts: Readonly<Record<string, unknown>>;
    readState(): Readonly<RlaIncidentWorldState>;
    writeRecoveryState(state: Record<string, unknown>): void;
  };
}
export interface RlaEventResponseObserver {
  detected(detectionAutomatic: boolean): void;
  judged(action: string): void;
  recovered(recoveryLevel: RecoveryLevel): void;
}
export type RlaEventResponseResponder = (context: RlaEventResponseContext, observe: RlaEventResponseObserver) => void | Promise<void>;
export interface RlaEventResponseRuntime {
  readonly clock: SimClock;
  readonly inject: (options: {
    runId: string; stateRoot: string; injectionId: string; now: () => Date;
    ledger: readonly { event: string; data?: Record<string, unknown> }[];
    logs: readonly { category: string; event: string; data?: Record<string, unknown> }[];
  }) => unknown;
  readonly responder: RlaEventResponseResponder;
  readonly runId: string;
}
export interface RlaEventResponseScore {
  readonly eventId: string;
  readonly kind: string;
  readonly name: string;
  readonly baseline: string;
  readonly measuredDetectionSamples: number;
  readonly measuredJudgmentSamples: number;
  readonly measuredRecoverySamples: number;
  readonly samples: number;
  readonly detection: 'automatic' | 'manual' | 'mixed' | 'unmeasured';
  readonly averageDetectionMs: number | null;
  readonly averageJudgmentMs: number | null;
  readonly averageAttributionMs: number | null;
  readonly recovery: RecoveryLevel;
  readonly averageRecoveryMs: number | null;
  readonly successCount: number;
  readonly successRate: number;
  readonly pass: boolean;
}

const RECOVERY_RANK: Readonly<Record<RecoveryLevel, number>> = { automatic: 0, 'semi-automatic': 1, manual: 2, none: 3 };
const RECOVERY_BY_RANK = Object.entries(RECOVERY_RANK).sort((a, b) => a[1] - b[1]).map(([level]) => level as RecoveryLevel);
type ObservedSample = {
  detectionAutomatic: boolean | undefined; injectedAt: number; detectedAt: number; judgedAt: number; recoveredAt: number;
  measuredDetection: boolean; measuredJudgment: boolean; measuredRecovery: boolean;
  recoveryLevel: RecoveryLevel; success: boolean;
};
export interface RlaIncidentWorldState {
  readonly eventId: string;
  readonly kind: string;
  readonly sample: number;
  readonly status: string;
  readonly facts: Record<string, unknown>;
  readonly recoveryState?: Record<string, unknown>;
  readonly recoveryObservedAt?: number;
}
type IncidentFixture = RlaIncidentWorldState;

function assertObservedTime(value: number, previous: number, stage: string): void {
  if (!Number.isSafeInteger(value) || value < previous) throw new Error(`${stage} timestamp must be a monotonic nonnegative safe integer`);
}

function missingRecoveryConditions(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): string[] {
  return Object.entries(expected).filter(([key, value]) => JSON.stringify(actual?.[key]) !== JSON.stringify(value)).map(([key]) => key);
}

export function encodeRlaRunIdForFixturePath(runId: string): string[] {
  const codeUnits = Array.from({ length: runId.length }, (_, index) => runId.charCodeAt(index).toString(16).padStart(4, '0'));
  if (codeUnits.length === 0) return ['_empty'];
  const segments: string[] = [];
  for (let index = 0; index < codeUnits.length; index += 60) segments.push(codeUnits.slice(index, index + 60).join(''));
  return segments;
}

/** Writes a concrete incident fixture into the isolated world, then measures observed response callbacks and recovery state. */
export async function runRlaEventResponseScorecard(world: SimWorld, runtime: RlaEventResponseRuntime): Promise<{ pass: boolean; evidenceBasis: 'isolated-world-state'; scores: RlaEventResponseScore[] }> {
  const eventIds = new Set(world.spec.events.map((event) => event.id));
  if (eventIds.size !== world.spec.events.length) throw new Error('world must declare each RLA response event exactly once');
  const missing = RLA_EVENT_RESPONSE_EVENTS.filter((event) => !eventIds.has(event.id));
  if (missing.length) throw new Error(`world is missing registered RLA response events: ${missing.map(({ id }) => id).join(', ')}`);
  const extra = world.spec.events.filter(({ id }) => !RLA_EVENT_RESPONSE_EVENTS.some((event) => event.id === id));
  if (extra.length) throw new Error(`world contains unrelated events for RLA response scorecard: ${extra.map(({ id }) => id).join(', ')}`);

  const runSegment = encodeRlaRunIdForFixturePath(runtime.runId);
  const fixtureDir = join(world.root, 'fixtures', 'rla-event-response');
  mkdirSync(join(fixtureDir, ...runSegment), { recursive: true, mode: 0o700 });
  const scores: RlaEventResponseScore[] = [];
  for (const event of RLA_EVENT_RESPONSE_EVENTS) {
    const samples: ObservedSample[] = [];
    for (let sample = 1; sample <= RLA_EVENT_RESPONSE_SAMPLE_COUNT; sample += 1) {
      const contextBase = { world, eventId: event.id, kind: event.kind, sample } as const;
      const injectionId = `inj-rla-${event.id.toLowerCase()}-${sample}`;
      const now = () => new Date(runtime.clock.now());
      const injectedAt = runtime.clock.now();
      const fixturePath = join(fixtureDir, ...runSegment, `${event.id.toLowerCase()}-${sample}.json`);
      let fixture: IncidentFixture = { eventId: event.id, kind: event.kind, sample, status: 'injected', facts: { ...event.facts }, recoveryObservedAt: undefined };
      const saveFixture = (): void => writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      saveFixture();
      runtime.inject({
        runId: runtime.runId, stateRoot: world.root, injectionId: `${injectionId}-injected`, now,
        ledger: [{ event: 'rla-event-response-stage', data: { eventId: event.id, kind: event.kind, sample, stage: 'injected', observedAt: injectedAt, incidentFacts: fixture.facts, incidentFixture: fixturePath } }],
        logs: [{ category: 'release-loop.event-response', event: 'injected', data: { eventId: event.id, kind: event.kind, sample, observedAt: injectedAt, incidentFacts: fixture.facts, incidentFixture: fixturePath } }],
      });
      const incident: RlaEventResponseContext['incident'] = {
        path: fixturePath,
        facts: fixture.facts,
        readState: () => JSON.parse(readFileSync(fixturePath, 'utf8')) as RlaIncidentWorldState,
        writeRecoveryState(state) {
          fixture = { ...fixture, status: 'recovery-attempted', recoveryState: { ...state }, recoveryObservedAt: runtime.clock.now() };
          saveFixture();
        },
      };
      const context = { ...contextBase, incident };
      let nextStage: 'detected' | 'judged' | 'recovered' = 'detected';
      let detectedAt: number | undefined;
      let judgedAt: number | undefined;
      let recoveredAt: number | undefined;
      let detectionAutomatic: boolean | undefined;
      let action: string | undefined;
      let recoveryLevel: RecoveryLevel | undefined;
      let verifiedSuccess = false;
      let lastObservedAt = injectedAt;
      let complete = false;
      const record = (stage: 'detected' | 'judged' | 'recovered', data: Record<string, unknown>): number => {
        if (complete || nextStage !== stage) throw new Error(`response trace for ${event.id} sample ${sample} expected ${nextStage}, received ${stage}`);
        const observedAt = runtime.clock.now();
        assertObservedTime(observedAt, lastObservedAt, stage);
        let resultEvidence: Record<string, unknown> = {};
        let failureReasons: string[] = [];
        if (stage === 'recovered') {
          const persisted = JSON.parse(readFileSync(fixturePath, 'utf8')) as IncidentFixture;
          const failedConditions = missingRecoveryConditions(persisted.recoveryState, event.expectedRecovery);
          verifiedSuccess = action === event.target && failedConditions.length === 0 && recoveryLevel !== 'none';
          failureReasons = [
            ...(action !== event.target ? ['response-action-mismatch'] : []),
            ...failedConditions.map((condition) => `recovery-condition-missing:${condition}`),
            ...(recoveryLevel === 'none' ? ['recovery-not-achieved'] : []),
          ];
          resultEvidence = { postconditionsMet: failedConditions.length === 0, recoveryEvidence: persisted.recoveryState ?? null, failedConditions, failureReasons };
          fixture = { ...persisted, status: verifiedSuccess ? 'recovered' : 'recovery-failed' };
          saveFixture();
        }
        const evidence = { eventId: event.id, kind: event.kind, sample, stage, observedAt, ...data, ...resultEvidence };
        runtime.inject({
          runId: runtime.runId, stateRoot: world.root, injectionId: `${injectionId}-${stage}`, now,
          ledger: [{ event: 'rla-event-response-stage', data: evidence }],
          logs: [{ category: 'release-loop.event-response', event: stage, data: evidence }],
        });
        nextStage = stage === 'detected' ? 'judged' : 'recovered';
        lastObservedAt = observedAt;
        complete = stage === 'recovered';
        return observedAt;
      };
      const observer: RlaEventResponseObserver = {
        detected(automatic) {
          if (typeof automatic !== 'boolean') throw new Error('detectionAutomatic must be boolean');
          detectionAutomatic = automatic;
          detectedAt = record('detected', { detectionAutomatic: automatic, incidentFixture: fixturePath });
        },
        judged(responseAction) {
          if (!responseAction.trim()) throw new Error('response action must be nonempty');
          action = responseAction;
          judgedAt = record('judged', { action: responseAction, incidentFixture: fixturePath });
        },
        recovered(level) {
          if (!Object.hasOwn(RECOVERY_RANK, level)) throw new Error('recovery level is invalid');
          recoveryLevel = level;
          recoveredAt = record('recovered', { recoveryLevel: level, action, incidentFixture: fixturePath });
        },
      };
      let responseError: string | undefined;
      try { await runtime.responder(context, observer); }
      catch (error) { responseError = error instanceof Error ? error.message : String(error); }
      const missingStages = [
        ...(detectedAt === undefined ? ['detected'] : []), ...(judgedAt === undefined ? ['judged'] : []), ...(recoveredAt === undefined ? ['recovered'] : []),
      ];
      if (missingStages.length) {
        const observedAt = runtime.clock.now();
        fixture = { ...fixture, status: 'incomplete', recoveryState: fixture.recoveryState };
        saveFixture();
        runtime.inject({
          runId: runtime.runId, stateRoot: world.root, injectionId: `${injectionId}-incomplete`, now,
          ledger: [{ event: 'rla-event-response-stage', data: { eventId: event.id, kind: event.kind, sample, stage: 'incomplete', observedAt, missingStages, responseError, incidentFixture: fixturePath } }],
          logs: [{ category: 'release-loop.event-response', event: 'incomplete', data: { eventId: event.id, kind: event.kind, sample, observedAt, missingStages, responseError, incidentFixture: fixturePath } }],
        });
      }
      const sampleSuccess = missingStages.length === 0 && responseError === undefined && complete && verifiedSuccess;
      if (responseError !== undefined) {
        fixture = { ...fixture, status: 'responder-error' };
        saveFixture();
      }
      const verdictAt = runtime.clock.now();
      const verdict = { eventId: event.id, kind: event.kind, sample, stage: 'sample-verdict', observedAt: verdictAt,
        success: sampleSuccess, responseError: responseError ?? null,
        failureReasons: [...missingStages.map((stage) => `stage-not-observed:${stage}`), ...(responseError ? ['responder-error'] : []), ...(!verifiedSuccess && complete ? ['recovery-postconditions-failed'] : [])],
        incidentFixture: fixturePath };
      runtime.inject({
        runId: runtime.runId, stateRoot: world.root, injectionId: `${injectionId}-sample-verdict`, now,
        ledger: [{ event: 'rla-event-response-sample-verdict', data: verdict }],
        logs: [{ category: 'release-loop.event-response', event: 'sample-verdict', data: verdict }],
      });
      const observedDetectedAt = detectedAt ?? injectedAt;
      const observedJudgedAt = judgedAt ?? observedDetectedAt;
      const observedRecoveredAt = recoveredAt ?? observedJudgedAt;
      samples.push({ detectionAutomatic, injectedAt, detectedAt: observedDetectedAt,
        judgedAt: observedJudgedAt, recoveredAt: observedRecoveredAt,
        measuredDetection: detectedAt !== undefined, measuredJudgment: judgedAt !== undefined, measuredRecovery: recoveredAt !== undefined,
        recoveryLevel: recoveryLevel ?? 'none', success: sampleSuccess });
    }
    const avg = (measured: (sample: ObservedSample) => boolean, pick: (sample: ObservedSample) => number): number | null => {
      const observed = samples.filter(measured);
      return observed.length ? Math.round(observed.reduce((sum, sample) => sum + pick(sample), 0) / observed.length) : null;
    };
    const successCount = samples.filter((sample) => sample.success).length;
    const passPerSample = samples.map((sample) => sample.success && sample.detectionAutomatic && sample.recoveryLevel === 'automatic'
      && (!('maxJudgmentMs' in event) || sample.judgedAt - sample.injectedAt <= event.maxJudgmentMs)
      && (!('maxRecoveryMs' in event) || sample.recoveredAt - sample.judgedAt <= event.maxRecoveryMs));
    const detectionModes = new Set(samples.map((sample) => sample.detectionAutomatic));
    const detection: RlaEventResponseScore['detection'] = samples.some((sample) => sample.detectionAutomatic === undefined) ? 'unmeasured'
      : detectionModes.size > 1 ? 'mixed' : samples[0]!.detectionAutomatic ? 'automatic' : 'manual';
    const score: RlaEventResponseScore = {
      eventId: event.id, kind: event.kind, name: event.name, baseline: event.baseline, samples: samples.length,
      measuredDetectionSamples: samples.filter((sample) => sample.measuredDetection).length,
      measuredJudgmentSamples: samples.filter((sample) => sample.measuredJudgment).length,
      measuredRecoverySamples: samples.filter((sample) => sample.measuredRecovery).length,
      detection,
      averageDetectionMs: avg((sample) => sample.measuredDetection, (sample) => sample.detectedAt - sample.injectedAt),
      averageJudgmentMs: avg((sample) => sample.measuredJudgment, (sample) => sample.judgedAt - sample.detectedAt),
      averageAttributionMs: avg((sample) => sample.measuredJudgment, (sample) => sample.judgedAt - sample.injectedAt),
      recovery: RECOVERY_BY_RANK[Math.max(...samples.map((sample) => RECOVERY_RANK[sample.recoveryLevel]))]!,
      averageRecoveryMs: avg((sample) => sample.measuredRecovery, (sample) => sample.recoveredAt - sample.judgedAt),
      successCount, successRate: successCount / samples.length,
      pass: successCount === RLA_EVENT_RESPONSE_SAMPLE_COUNT && passPerSample.every(Boolean),
    };
    scores.push(score);
  }
  return { pass: scores.every((score) => score.pass), evidenceBasis: 'isolated-world-state', scores };
}

export const UX_SIM_DEVICE_METADATA = {
  id: 'MD-UX-SIM-RLA-EVENT-RESPONSE-SCORECARD-TS',
  path: 'src/ux-sim/rla-event-response-scorecard.ts',
  boundary: 'Writes a concrete per-incident fault fixture into the private simulation world, lets a responder inspect and update that state, verifies event-specific recovery postconditions from persisted world state, and records response stages through world-runtime; the fixture is simulation evidence, not a production RLA observation.',
  deviceIds: ['rla-event-response-scorecard'],
  integrityCertificatePresent: false,
  integrityCertificatePath: null,
} as const;
