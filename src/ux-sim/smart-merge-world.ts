import { randomUUID } from 'node:crypto';

/** Test-only event vocabulary. It intentionally does not import the train execution modules. */
export type TrainRoleTag = 'train-worker' | 'si-warm' | 'gate-warm' | 'remote-parent' | 'rehearsal' | 'export-check' | 'relay-edge';
export interface FakeReadinessHost {
  host: string; ready: boolean; occupied: boolean; preempted: boolean; imageAvailable: boolean;
  registryReadyAtMs: number; credentialExpiresAtMs: number; mirrorSha: string; goldenSha: string; budget: number;
  recipeState: 'ready' | 'partial' | 'failed'; leadMsByRole: Record<TrainRoleTag, number>;
}
export type TrainLoopSignal =
  | { type: 'hotspot-main-drift'; pr: number; currentHead: string; mainHead: string; integratedHead: string; retestId: string; conflictDelta: string[]; priorVerdict: string; baselineErrors?: number; integratedErrors?: number }
  | { type: 'hotspot-retest-result'; pr: number; retestId: string; head: string; result: 'passed' | 'failed'; receiptId: string }
  | { type: 'hotspot-retest-complete'; pr: number; retestId: string; integratedHead: string; verifiedHead: string; result: 'passed' | 'failed'; priorVerdict: string }
  | { type: 'human-intervention-observed'; incident: string }
  | { type: 'merge-only-head'; pr: number; oldHead: string; newHead: string; oldCodeDiffSha: string; newCodeDiffSha: string; waiverHead: string }
  | { type: 'review-repeat'; priorFindings: string[]; currentFindings: string[] }
  | { type: 'reported-sha'; pr: number; reportedSha: string; actualHead: string }
  | { type: 'stacked-base'; pr: number; base: string; main: string }
  | { type: 'duplicate-cell-pr'; cell: string; prs: number[] }
  | { type: 'post-land-conflict'; landedFiles: string[]; queuedPr: number; queuedFiles: string[]; owner: string }
  | { type: 'generated-file-overlap'; path: string; prs: number[] }
  | { type: 'assignment-collision'; pr: number; activePrs: string[]; candidateSlots: string[] }
  | { type: 'idle-seat'; seat: string; cell: string; priority: number; available: boolean }
  | { type: 'worker-exit'; host: string; workerId: string; cap: number }
  | { type: 'host-load'; host: string; percent: number; cap: number }
  | { type: 'role-tag-readiness'; roleTag: TrainRoleTag; edge: 'startup-delay' | 'image-failure' | 'registry-lag' | 'credential-expired' | 'no-substitution-map' | 'stale-mirror' | 'preempted' | 'budget-exhausted' | 'host-contention' | 'countdown-late' | 'golden-sha-mismatch' | 'partial-recipe-failure'; recipe: string; nowMs: number; deadlineMs: number; mirrorSha: string; goldenSha: string; primaryHost: string; substitutionMapAvailable: boolean; alternatives: string[]; hosts: FakeReadinessHost[] }
  | { type: 'release-cycle'; stages: Array<'cut' | 'gate' | 'publish' | 'verify'>; gateHosts: string[]; trainSlots: string[] };
type TrainLoopActionKind =
  | 'main.merge' | 'conflict.delta-transplant' | 'gate.retest' | 'verdict.inherit' | 'pr.requeue-front' | 'gate.retest-rejected'
  | 'waiver.transfer' | 'review.retain-repeat' | 'review.route-new-repair' | 'report.correct-sha' | 'pr.retarget-main'
  | 'duplicate.close' | 'queue.predict-conflict' | 'owner.notify-conflict' | 'generated.split-writer'
  | 'assignment.assign-once' | 'assignment.refuse-active' | 'cell.assign-idle-seat' | 'worker.restart'
  | 'resource.cap-decrement' | 'resource.cap-increment' | 'readiness.assign-alternative-host' | 'readiness.refuse-assignment'
  | 'release.stage-observed' | 'guardian.reserve-gate-hosts' | 'train.reclaim-gate-slots' | 'guardian.release-gate-hosts'
  | 'train.restore-slots' | 'vm.scale-down';
interface TrainLoopAction { kind: TrainLoopActionKind; details?: Record<string, string | number | boolean | Array<string | number>> }
interface SmartMergeQueueCandidate { pr: number; head: string; files: string[] }

/** Scenario oracle, deliberately local to this simulator and not used by runtime code. */
export function planSimulationSignal(signal: TrainLoopSignal): TrainLoopAction[] {
  const action = (kind: TrainLoopActionKind, details?: TrainLoopAction['details']): TrainLoopAction => ({ kind, ...(details ? { details } : {}) });
  switch (signal.type) {
    case 'hotspot-retest-result':
    case 'human-intervention-observed': return [];
    case 'hotspot-main-drift': return signal.conflictDelta.length && /^[a-f0-9]{40}$/i.test(signal.integratedHead) && signal.retestId.trim()
      ? [action('main.merge', { head: signal.mainHead }), action('conflict.delta-transplant', { files: signal.conflictDelta }), action('gate.retest', { pr: signal.pr, head: signal.integratedHead, retestId: signal.retestId })] : [];
    case 'hotspot-retest-complete': return signal.retestId.trim() && signal.result === 'passed' && signal.verifiedHead.toLowerCase() === signal.integratedHead.toLowerCase()
      ? [...(signal.priorVerdict.includes('mustFix0') ? [action('verdict.inherit', { verdict: signal.priorVerdict, head: signal.integratedHead })] : []), action('pr.requeue-front', { pr: signal.pr, head: signal.integratedHead })]
      : [action('gate.retest-rejected', { pr: signal.pr, expectedHead: signal.integratedHead, actualHead: signal.verifiedHead, result: signal.result, retestId: signal.retestId })];
    case 'merge-only-head': return signal.oldHead === signal.waiverHead && signal.oldCodeDiffSha === signal.newCodeDiffSha ? [action('waiver.transfer', { pr: signal.pr, from: signal.oldHead, to: signal.newHead, diffSha: signal.newCodeDiffSha })] : [];
    case 'review-repeat': { const prior = new Set(signal.priorFindings); const repeat = signal.currentFindings.filter((f) => prior.has(f)); const fresh = signal.currentFindings.filter((f) => !prior.has(f)); return [...(repeat.length ? [action('review.retain-repeat', { findings: repeat })] : []), ...(fresh.length ? [action('review.route-new-repair', { findings: fresh })] : [])]; }
    case 'reported-sha': return signal.reportedSha.toLowerCase() === signal.actualHead.toLowerCase() ? [] : [action('report.correct-sha', { pr: signal.pr, actualHead: signal.actualHead })];
    case 'stacked-base': return signal.base === signal.main ? [] : [action('pr.retarget-main', { pr: signal.pr, from: signal.base, to: signal.main })];
    case 'duplicate-cell-pr': return signal.prs.length < 2 ? [] : [action('duplicate.close', { cell: signal.cell, keep: signal.prs[0]!, close: signal.prs.slice(1) })];
    case 'post-land-conflict': { const landed = new Set(signal.landedFiles); const overlap = signal.queuedFiles.filter((f) => landed.has(f)); return overlap.length ? [action('queue.predict-conflict', { pr: signal.queuedPr, files: overlap }), action('owner.notify-conflict', { pr: signal.queuedPr, owner: signal.owner, files: overlap })] : []; }
    case 'generated-file-overlap': return signal.path && signal.prs.length > 1 ? [action('generated.split-writer', { path: signal.path, prs: signal.prs })] : [];
    case 'assignment-collision': return signal.activePrs.includes(String(signal.pr)) ? [action('assignment.refuse-active', { pr: signal.pr })] : signal.candidateSlots.length ? [action('assignment.assign-once', { pr: signal.pr, host: signal.candidateSlots[0]!.split('/')[0]!, slot: Number(signal.candidateSlots[0]!.split('/')[1]) })] : [];
    case 'idle-seat': return signal.available && signal.priority >= 0 ? [action('cell.assign-idle-seat', { seat: signal.seat, cell: signal.cell, priority: signal.priority })] : [];
    case 'worker-exit': return signal.cap > 0 ? [action('worker.restart', { host: signal.host, workerId: signal.workerId })] : [];
    case 'host-load': return signal.percent > 80 ? [action('resource.cap-decrement', { host: signal.host, to: Math.max(0, signal.cap - 1) })] : signal.percent < 40 ? [action('resource.cap-increment', { host: signal.host, to: signal.cap + 1 })] : [];
    case 'role-tag-readiness': { const hosts = new Map(signal.hosts.map((host) => [host.host, host])); const candidates = [signal.primaryHost, ...(signal.substitutionMapAvailable ? signal.alternatives : [])].map((h) => hosts.get(h)).filter((h): h is FakeReadinessHost => !!h); const ready = (host: FakeReadinessHost) => host.ready && !host.occupied && !host.preempted && host.imageAvailable && Math.max(signal.nowMs, host.registryReadyAtMs) + host.leadMsByRole[signal.roleTag] <= signal.deadlineMs && host.credentialExpiresAtMs > signal.deadlineMs && host.mirrorSha === signal.mirrorSha && host.goldenSha === signal.goldenSha && host.budget > 0 && host.recipeState === 'ready'; const selected = candidates.find(ready); return selected ? [action(selected.host === signal.primaryHost ? 'assignment.assign-once' : 'readiness.assign-alternative-host', { host: selected.host })] : [action('readiness.refuse-assignment', { reason: signal.edge })]; }
    case 'release-cycle': return signal.stages.join(',') === 'cut,gate,publish,verify' ? [action('release.stage-observed', { stage: 'cut' }), action('guardian.reserve-gate-hosts', { hosts: signal.gateHosts }), action('train.reclaim-gate-slots', { slots: signal.trainSlots }), ...signal.stages.slice(1).map((stage) => action('release.stage-observed', { stage })), action('train.restore-slots', { slots: signal.trainSlots }), action('vm.scale-down', { hosts: signal.gateHosts }), action('guardian.release-gate-hosts', { hosts: signal.gateHosts })] : [];
  }
}

export interface SmartMergeScenario {
  id: string;
  signal: TrainLoopSignal;
  followupSignals?: TrainLoopSignal[];
  expectedActions: TrainLoopAction['kind'][];
}

/** Ten operator-resolved merge incidents, expressed as fake-world inputs and observable automation actions. */
export const SMART_MERGE_SCENARIOS: readonly SmartMergeScenario[] = [
  {
    id: '01-hotspot-main-drift-repair-and-front-requeue',
    signal: { type: 'hotspot-main-drift', pr: 36001, currentHead: 'a'.repeat(40), mainHead: 'b'.repeat(40),
      integratedHead: 'c'.repeat(40), retestId: 'retest-36001-c', conflictDelta: ['scripts/release-loop/gate-node.ts'], priorVerdict: 'WARN:mustFix0',
      baselineErrors: 3, integratedErrors: 5 },
    followupSignals: [
      { type: 'hotspot-retest-result', pr: 36001, retestId: 'retest-36001-c', head: 'c'.repeat(40), result: 'passed', receiptId: 'receipt:36001:retest-36001-c:' + 'c'.repeat(40) },
      { type: 'hotspot-retest-complete', pr: 36001, retestId: 'retest-36001-c', integratedHead: 'c'.repeat(40), verifiedHead: 'c'.repeat(40),
      result: 'passed', priorVerdict: 'WARN:mustFix0' }],
    expectedActions: ['main.merge', 'conflict.delta-transplant', 'gate.retest', 'verdict.inherit', 'pr.requeue-front'],
  },
  {
    id: '02-merge-only-head-waiver-transfer',
    signal: { type: 'merge-only-head', pr: 36002, oldHead: 'c'.repeat(40), newHead: 'd'.repeat(40),
      oldCodeDiffSha: 'e'.repeat(64), newCodeDiffSha: 'e'.repeat(64), waiverHead: 'c'.repeat(40) },
    expectedActions: ['waiver.transfer'],
  },
  {
    id: '03-repeat-review-finding-versus-new-defect',
    signal: { type: 'review-repeat', priorFindings: ['R1:slot race'], currentFindings: ['R1:slot race', 'R2:missing guard'] },
    expectedActions: ['review.retain-repeat', 'review.route-new-repair'],
  },
  {
    id: '04-correct-mistyped-head-sha',
    signal: { type: 'reported-sha', pr: 36004, reportedSha: 'f'.repeat(40), actualHead: '0'.repeat(40) },
    expectedActions: ['report.correct-sha'],
  },
  {
    id: '05-stacked-pr-retarget-to-main',
    signal: { type: 'stacked-base', pr: 36005, base: 'mvp-b-train-loop-agent-1108-r3', main: 'main' },
    expectedActions: ['pr.retarget-main'],
  },
  {
    id: '06-close-duplicate-cell-pr',
    signal: { type: 'duplicate-cell-pr', cell: 'SMART-MERGE-SIM-SUITE', prs: [36006, 36007] },
    expectedActions: ['duplicate.close'],
  },
  {
    id: '07-predict-queued-pr-conflict-after-land',
    signal: { type: 'post-land-conflict', landedFiles: ['src/graph-runner/runner.ts'], queuedPr: 36008,
      queuedFiles: ['src/graph-runner/runner.ts', 'src/graph-runner/runner.test.ts'], owner: 'TC' },
    expectedActions: ['queue.predict-conflict', 'owner.notify-conflict'],
  },
  {
    id: '08-split-generated-file-writer-contention',
    signal: { type: 'generated-file-overlap', path: 'src/ux-sim/mock-scenario-catalog.json', prs: [36009, 36010] },
    expectedActions: ['generated.split-writer'],
  },
  {
    id: '09-never-double-assign-pr',
    signal: { type: 'assignment-collision', pr: 36011, activePrs: ['36011'], candidateSlots: ['aws1/1', 'gcp2/1'] },
    expectedActions: ['assignment.refuse-active'],
  },
  {
    id: '10-assign-open-op-cell-to-idle-seat',
    signal: { type: 'idle-seat', seat: 'MVP-B', cell: 'SMART-MERGE-SIM-SUITE', priority: 0, available: true },
    expectedActions: ['cell.assign-idle-seat'],
  },
];

/** Guardian and coordinator worker-lifecycle inputs share the same fake world. */
export const TRAIN_GUARDIAN_SCENARIOS: readonly SmartMergeScenario[] = [
  {
    id: 'guardian-restart-dead-worker',
    signal: { type: 'worker-exit', host: 'aws2', workerId: 'train-worker-aws2-1', cap: 2 },
    expectedActions: ['worker.restart'],
  },
  {
    id: 'guardian-high-load-decrement',
    signal: { type: 'host-load', host: 'aws2', percent: 83, cap: 2 },
    expectedActions: ['resource.cap-decrement'],
  },
  {
    id: 'guardian-low-load-increment',
    signal: { type: 'host-load', host: 'aws2', percent: 38, cap: 1 },
    expectedActions: ['resource.cap-increment'],
  },
  {
    id: 'cut-gate-publish-verify-reserve-and-return',
    signal: { type: 'release-cycle', stages: ['cut', 'gate', 'publish', 'verify'],
      gateHosts: ['aws3', 'node-c'], trainSlots: ['aws3/1', 'node-c/1'] },
    expectedActions: [
      'release.stage-observed', 'guardian.reserve-gate-hosts', 'train.reclaim-gate-slots',
      'release.stage-observed', 'release.stage-observed', 'release.stage-observed',
      'train.restore-slots', 'vm.scale-down', 'guardian.release-gate-hosts',
    ],
  },
];

const ROLE_TAGS: readonly TrainRoleTag[] = ['train-worker', 'si-warm', 'gate-warm', 'remote-parent', 'rehearsal', 'export-check', 'relay-edge'];
function readinessHost(host: string, overrides: Partial<FakeReadinessHost> = {}): FakeReadinessHost {
  return { host, ready: true, occupied: false, preempted: false, imageAvailable: true, registryReadyAtMs: 0,
    credentialExpiresAtMs: 20_000, mirrorSha: 'mirror-current', goldenSha: 'golden-current', budget: 1,
    recipeState: 'ready', leadMsByRole: Object.fromEntries(ROLE_TAGS.map((tag) => [tag, 1_000])) as Record<TrainRoleTag, number>,
    ...overrides };
}
function readinessCase(id: string, roleTag: TrainRoleTag, edge: Extract<TrainLoopSignal, { type: 'role-tag-readiness' }>['edge'],
  primaryOverrides: Partial<FakeReadinessHost>, expectedAction: TrainLoopAction['kind'], alternate = true): SmartMergeScenario {
  const primary = readinessHost('primary', primaryOverrides);
  const fallback = readinessHost('fallback');
  return { id, signal: { type: 'role-tag-readiness', roleTag, edge, recipe: `recipe:${roleTag}`, nowMs: 0, deadlineMs: 10_000,
    mirrorSha: 'mirror-current', goldenSha: 'golden-current', primaryHost: 'primary', substitutionMapAvailable: alternate,
    alternatives: alternate ? ['fallback'] : [],
    hosts: [primary, fallback] }, expectedActions: [expectedAction] };
}

/** Role-tagged recipe/readiness edges are simulated without cloud, host, or registry calls. */
export const ROLE_TAG_READINESS_SCENARIOS: readonly SmartMergeScenario[] = [
  readinessCase('readiness-startup-delay', 'train-worker', 'startup-delay', { leadMsByRole: { ...readinessHost('x').leadMsByRole, 'train-worker': 11_000 } }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-image-failure', 'si-warm', 'image-failure', { imageAvailable: false }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-registry-lag', 'gate-warm', 'registry-lag', { registryReadyAtMs: 11_000 }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-credential-expired', 'remote-parent', 'credential-expired', { credentialExpiresAtMs: 1 }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-no-substitution-map', 'rehearsal', 'no-substitution-map', { ready: false }, 'readiness.refuse-assignment', false),
  readinessCase('readiness-stale-mirror', 'export-check', 'stale-mirror', { mirrorSha: 'mirror-old' }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-preempted-host', 'relay-edge', 'preempted', { preempted: true }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-budget-exhausted', 'train-worker', 'budget-exhausted', { budget: 0 }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-host-contention', 'si-warm', 'host-contention', { occupied: true }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-countdown-late', 'gate-warm', 'countdown-late', {
    leadMsByRole: { ...readinessHost('x').leadMsByRole, 'gate-warm': 11_000 } }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-golden-image-sha-mismatch', 'remote-parent', 'golden-sha-mismatch', { goldenSha: 'golden-old' }, 'readiness.assign-alternative-host'),
  readinessCase('readiness-partial-recipe-failure', 'rehearsal', 'partial-recipe-failure', { recipeState: 'partial' }, 'readiness.assign-alternative-host'),
];

export interface SmartMergeScenarioResult {
  id: string;
  world: { revisionBefore: number; completedBefore: string[]; queueBefore: { pr: number; head: string }[];
    revisionAfter: number; completedAfter: string[]; queueAfter: { pr: number; head: string }[] };
  observed: TrainLoopAction['kind'][];
  missing: TrainLoopAction['kind'][];
  unexpected: TrainLoopAction['kind'][];
  humanInterventions: number;
  zeroInterventionAssertion: boolean;
  finalState: { resolved: boolean; assignment: 'assigned' | 'refused' | null; selectedHost: string | null;
    mergedMainHead: string | null; transplantedHead: string | null; landedFiles: string[]; predictedConflicts: string[]; notifiedOwner: string | null;
    queueCandidates: SmartMergeQueueCandidate[];
    typecheckOutput: string | null;
    waiverHead: string | null; correctedSha: string | null; base: string | null; keptPr: number | null; closedPrs: number[];
    retainedFindings: string[]; routedFindings: string[]; activeAssignmentRefused: boolean; idleSeatAssigned: boolean;
    retestedHead: string | null; retestId: string | null; retestReceiptId: string | null; retestEvidenceRunId: string | null; verdictInherited: boolean;
    retestPriorVerdict: string | null; requeued: boolean; writerOwners: Record<string, number[]>; writerCollision: boolean; guardianLeases: string[] };
}

interface SmartMergeWorldFacts {
  mergedMainHead: string | null;
  transplantedHead: string | null;
  retestRequest: { pr: number; retestId: string; head: string; priorVerdict: string } | null;
  retestReceipt: { pr: number; retestId: string; head: string; priorVerdict: string; result: 'passed' | 'failed'; receiptId: string; runId: string } | null;
  retestPassed: { pr: number; retestId: string; head: string; priorVerdict: string; receiptId: string; runId: string } | null;
  retestRejected: boolean;
  verdictInherited: boolean;
  requeued: boolean;
  waiverHead: string | null;
  retainedFindings: string[];
  routedFindings: string[];
  correctedSha: string | null;
  base: string | null;
  keptPr: number | null;
  closedPrs: number[];
  predictedConflicts: string[];
  notifiedOwner: string | null;
  writerOwners: Map<string, number[]>;
  writerCollision: boolean;
  activeAssignmentRefused: boolean;
  assignment: { pr: number; host: string; slot: number } | null;
  idleSeatAssigned: boolean;
  workerRestarted: boolean;
  resourceCap: number | null;
  refusalReason: string | null;
  gateSlotsReclaimed: boolean;
  gateSlotsRestored: boolean;
  vmScaledDown: boolean;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function queueCandidatesFor(signal: TrainLoopSignal, facts: SmartMergeWorldFacts, occupied: ReadonlyMap<number, string>): SmartMergeQueueCandidate[] {
  const ready = (pr: number, files: string[] = [], head = pr.toString(16).padStart(40, '0')): SmartMergeQueueCandidate => ({ pr, head, files });
  let candidates: SmartMergeQueueCandidate[];
  switch (signal.type) {
    case 'hotspot-main-drift': candidates = facts.verdictInherited && facts.requeued ? [ready(signal.pr, [...signal.conflictDelta], facts.retestPassed!.head)] : []; break;
    case 'merge-only-head': candidates = facts.waiverHead === signal.newHead ? [ready(signal.pr, [], signal.newHead)] : []; break;
    case 'reported-sha': candidates = facts.correctedSha === signal.actualHead ? [ready(signal.pr, [], signal.actualHead)] : []; break;
    case 'stacked-base': candidates = facts.base === signal.main ? [ready(signal.pr)] : []; break;
    case 'duplicate-cell-pr': candidates = facts.keptPr === signal.prs[0] ? [ready(facts.keptPr)] : []; break;
    case 'post-land-conflict': candidates = [{ pr: signal.queuedPr, head: signal.queuedPr.toString(16).padStart(40, '0'), files: [...signal.queuedFiles] }]; break;
    case 'generated-file-overlap': candidates = [...facts.writerOwners.entries()].flatMap(([path, owners]) => owners.length === 1 ? [ready(owners[0]!, [path])] : []); break;
    case 'assignment-collision': candidates = facts.assignment?.pr === signal.pr ? [ready(signal.pr)] : []; break;
    case 'hotspot-retest-result': case 'hotspot-retest-complete': case 'human-intervention-observed': case 'review-repeat':
    case 'idle-seat': case 'worker-exit': case 'host-load': case 'role-tag-readiness': case 'release-cycle': candidates = []; break;
  }
  return candidates.filter(({ pr }) => !occupied.has(pr));
}

function readinessEligible(signal: Extract<TrainLoopSignal, { type: 'role-tag-readiness' }>, host: FakeReadinessHost): boolean {
  return host.ready && !host.occupied && !host.preempted && host.imageAvailable
    && Math.max(signal.nowMs, host.registryReadyAtMs) + host.leadMsByRole[signal.roleTag] <= signal.deadlineMs
    && host.credentialExpiresAtMs > signal.deadlineMs && host.mirrorSha === signal.mirrorSha
    && host.goldenSha === signal.goldenSha && host.budget > 0 && host.recipeState === 'ready';
}

function worldResolved(signal: TrainLoopSignal, facts: SmartMergeWorldFacts, leases: string[], slotsExpected: number): boolean {
  switch (signal.type) {
    case 'hotspot-main-drift':
      if (facts.retestRejected) return facts.mergedMainHead === signal.mainHead && facts.transplantedHead === signal.integratedHead
        && !facts.verdictInherited && !facts.requeued;
      return facts.mergedMainHead === signal.mainHead && facts.transplantedHead === signal.integratedHead
        && facts.retestRequest?.pr === signal.pr && facts.retestRequest.retestId === signal.retestId
        && facts.retestRequest.head === signal.integratedHead && facts.retestRequest.priorVerdict === signal.priorVerdict
        && facts.retestReceipt?.result === 'passed'
        && facts.retestPassed?.pr === signal.pr && facts.retestPassed.retestId === signal.retestId
        && facts.retestPassed.head === signal.integratedHead && facts.retestPassed.priorVerdict === signal.priorVerdict
        && facts.retestPassed.receiptId.length > 0 && facts.retestPassed.runId.length > 0
        && facts.verdictInherited && facts.requeued;
    case 'hotspot-retest-result': {
      const receipt = facts.retestReceipt;
      return !!receipt && receipt.pr === signal.pr && receipt.retestId === signal.retestId
        && receipt.head === signal.head && receipt.result === signal.result && receipt.receiptId === signal.receiptId;
    }
    case 'hotspot-retest-complete':
      if (facts.retestRejected) return !facts.verdictInherited && !facts.requeued;
      if (signal.result !== 'passed' || signal.verifiedHead !== signal.integratedHead) return false;
      return facts.retestReceipt?.result === 'passed' && facts.retestPassed?.pr === signal.pr && facts.retestPassed.retestId === signal.retestId
        && facts.retestPassed.head === signal.integratedHead && facts.retestPassed.priorVerdict === signal.priorVerdict
        && facts.retestPassed.receiptId.length > 0
        && facts.retestPassed.runId.length > 0 && facts.verdictInherited && facts.requeued;
    case 'human-intervention-observed': return !!signal.incident.trim();
    case 'merge-only-head': return facts.waiverHead === signal.newHead;
    case 'review-repeat': {
      const prior = new Set(signal.priorFindings);
      return sameStrings(facts.retainedFindings, signal.currentFindings.filter((finding) => prior.has(finding)))
        && sameStrings(facts.routedFindings, signal.currentFindings.filter((finding) => !prior.has(finding)));
    }
    case 'reported-sha': return facts.correctedSha === signal.actualHead;
    case 'stacked-base': return facts.base === signal.main;
    case 'duplicate-cell-pr': return facts.keptPr === signal.prs[0] && sameNumbers(facts.closedPrs, signal.prs.slice(1));
    case 'post-land-conflict': {
      const landed = new Set(signal.landedFiles);
      const overlap = signal.queuedFiles.filter((file) => landed.has(file));
      return sameStrings(facts.predictedConflicts, overlap) && facts.notifiedOwner === signal.owner;
    }
    case 'generated-file-overlap': {
      const owners = [...facts.writerOwners.values()];
      const writerIds = owners.flat();
      return !facts.writerCollision && facts.writerOwners.size === signal.prs.length
        && owners.every((fileOwners) => fileOwners.length === 1) && new Set(writerIds).size === signal.prs.length;
    }
    case 'assignment-collision': return signal.activePrs.includes(String(signal.pr))
      ? facts.activeAssignmentRefused && !facts.assignment
      : facts.assignment?.pr === signal.pr;
    case 'idle-seat': return facts.idleSeatAssigned;
    case 'worker-exit': return facts.workerRestarted;
    case 'host-load': return facts.resourceCap === (signal.percent > 80 ? Math.max(0, signal.cap - 1) : signal.cap + 1);
    case 'role-tag-readiness': {
      const hostByName = new Map(signal.hosts.map((host) => [host.host, host]));
      const candidates = [signal.primaryHost, ...(signal.substitutionMapAvailable ? signal.alternatives : [])];
      const selected = candidates.map((host) => hostByName.get(host)).find((host) => host && readinessEligible(signal, host));
      if (!selected) return facts.refusalReason === signal.edge;
      return facts.assignment?.host === selected.host && facts.assignment.pr === 0;
    }
    case 'release-cycle': return leases.length === signal.gateHosts.length && leases.every((lease) => lease === 'released')
      && facts.gateSlotsReclaimed && facts.gateSlotsRestored && facts.vmScaledDown && slotsExpected === signal.trainSlots.length;
  }
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

/** Run incidents through the test-only oracle and reject actions that do not change this fake world's state. */
export async function runSmartMergeWorld(scenarios: readonly SmartMergeScenario[]): Promise<SmartMergeScenarioResult[]> {
  const results: SmartMergeScenarioResult[] = [];
  const completedIncidents: string[] = [];
  const landQueue = new Map<number, string>();
  for (const scenario of scenarios) {
    const revisionBefore = completedIncidents.length;
    const completedBefore = [...completedIncidents];
    const queueBefore = [...landQueue].map(([pr, head]) => ({ pr, head }));
    const dispatched: TrainLoopAction['kind'][] = [];
    const state: SmartMergeScenarioResult['finalState'] = { resolved: false, assignment: null, selectedHost: null,
      mergedMainHead: null, transplantedHead: null, landedFiles: [], predictedConflicts: [], notifiedOwner: null,
      queueCandidates: [],
      typecheckOutput: null,
      waiverHead: null, correctedSha: null, base: null, keptPr: null, closedPrs: [], retainedFindings: [], routedFindings: [],
      activeAssignmentRefused: false, idleSeatAssigned: false,
      retestedHead: null, retestId: null, retestReceiptId: null, retestEvidenceRunId: null, verdictInherited: false, retestPriorVerdict: null, requeued: false,
      writerOwners: {}, writerCollision: false, guardianLeases: [] };
    const retestReceipts = new Map<string, { pr: number; retestId: string; head: string; priorVerdict: string;
      result: 'passed' | 'failed'; receiptId: string; runId: string }>();
    const initialSignal = scenario.signal;
    const initialWriters = initialSignal.type === 'generated-file-overlap'
      ? new Map([[initialSignal.path, [...initialSignal.prs]]]) : new Map<string, number[]>();
    const facts: SmartMergeWorldFacts = { mergedMainHead: null, transplantedHead: null, retestRequest: null, retestReceipt: null, retestPassed: null,
      retestRejected: false, verdictInherited: false, requeued: false, waiverHead: null, retainedFindings: [], routedFindings: [], correctedSha: null,
      base: null, keptPr: null, closedPrs: [], predictedConflicts: [], notifiedOwner: null, writerOwners: initialWriters,
      writerCollision: initialSignal.type === 'generated-file-overlap' && initialSignal.prs.length > 1,
      activeAssignmentRefused: false, assignment: null, idleSeatAssigned: false, workerRestarted: false, resourceCap: null,
      refusalReason: null, gateSlotsReclaimed: false, gateSlotsRestored: false, vmScaledDown: false };
    let currentSignal = scenario.signal;
    let gateSlotsExpected = 0;
    let humanInterventions = 0;
    const leases: string[] = [];
    const apply = (action: TrainLoopAction) => {
      dispatched.push(action.kind);
      const details = action.details ?? {};
      const requireSignal = <T extends TrainLoopSignal['type']>(type: T): Extract<TrainLoopSignal, { type: T }> => {
        if (currentSignal.type !== type) throw new Error(`${action.kind} received ${currentSignal.type}, expected ${type}`);
        return currentSignal as Extract<TrainLoopSignal, { type: T }>;
      };
      switch (action.kind) {
        case 'main.merge': {
          const signal = requireSignal('hotspot-main-drift');
          if (details.head !== signal.mainHead) throw new Error('fake world rejected merge to unexpected main head');
          facts.mergedMainHead = signal.mainHead;
          return;
        }
        case 'conflict.delta-transplant': {
          const signal = requireSignal('hotspot-main-drift');
          if (facts.mergedMainHead !== signal.mainHead || !sameStrings(details.files, signal.conflictDelta))
            throw new Error('fake world rejected transplant before main merge or with a different conflict delta');
          facts.transplantedHead = signal.integratedHead;
          return;
        }
        case 'gate.retest': {
          const signal = requireSignal('hotspot-main-drift');
          if (facts.transplantedHead !== signal.integratedHead || details.head !== signal.integratedHead || details.retestId !== signal.retestId)
            throw new Error('fake world rejected retest not pinned to the integrated head and retest ID');
          facts.retestRequest = { pr: signal.pr, retestId: signal.retestId, head: signal.integratedHead, priorVerdict: signal.priorVerdict };
          state.retestedHead = signal.integratedHead;
          state.retestId = signal.retestId;
          return;
        }
        case 'verdict.inherit': {
          const signal = requireSignal('hotspot-retest-complete');
          const proof = retestReceipts.get(`${signal.pr}:${signal.retestId}`);
          if (!facts.retestRequest || facts.retestRequest.pr !== signal.pr || facts.retestRequest.retestId !== signal.retestId
            || facts.retestRequest.head !== signal.integratedHead || facts.retestRequest.priorVerdict !== signal.priorVerdict
            || signal.verifiedHead !== signal.integratedHead || signal.result !== 'passed' || !proof
            || proof.head !== signal.integratedHead || proof.priorVerdict !== signal.priorVerdict || proof.result !== 'passed') {
            facts.retestRejected = true;
            state.resolved = true;
            return;
          }
          facts.retestPassed = { pr: signal.pr, retestId: signal.retestId, head: signal.integratedHead, priorVerdict: proof.priorVerdict,
            receiptId: proof.receiptId, runId: proof.runId };
          facts.verdictInherited = true;
          state.retestReceiptId = proof.receiptId;
          state.retestEvidenceRunId = proof.runId;
          state.verdictInherited = true;
          state.retestPriorVerdict = proof.priorVerdict;
          return;
        }
        case 'pr.requeue-front': {
          const signal = requireSignal('hotspot-retest-complete');
          if (!facts.retestPassed || facts.retestPassed.pr !== signal.pr || facts.retestPassed.retestId !== signal.retestId
            || facts.retestPassed.head !== signal.integratedHead || facts.retestPassed.priorVerdict !== signal.priorVerdict
            || details.head !== signal.integratedHead) {
            facts.retestRejected = true;
            state.resolved = true;
            return;
          }
          facts.requeued = true;
          state.requeued = true;
          return;
        }
        case 'gate.retest-rejected': {
          const signal = requireSignal('hotspot-retest-complete');
          const proof = retestReceipts.get(`${signal.pr}:${signal.retestId}`);
          if (signal.result === 'passed' && signal.verifiedHead === signal.integratedHead && facts.retestRequest?.pr === signal.pr
            && facts.retestRequest.retestId === signal.retestId && facts.retestRequest.head === signal.integratedHead
            && facts.retestRequest.priorVerdict === signal.priorVerdict && proof?.head === signal.integratedHead
            && proof.priorVerdict === signal.priorVerdict && proof.result === 'passed')
            throw new Error('fake world rejected refusing a matching successful retest');
          facts.retestRejected = true;
          state.resolved = true;
          return;
        }
        case 'waiver.transfer': {
          const signal = requireSignal('merge-only-head');
          if (signal.oldHead !== signal.waiverHead || signal.oldCodeDiffSha !== signal.newCodeDiffSha || details.to !== signal.newHead)
            throw new Error('fake world rejected unsafe waiver transfer');
          facts.waiverHead = signal.newHead;
          return;
        }
        case 'review.retain-repeat':
        case 'review.route-new-repair': {
          const signal = requireSignal('review-repeat');
          const prior = new Set(signal.priorFindings);
          const expected = signal.currentFindings.filter((finding) => action.kind === 'review.retain-repeat' ? prior.has(finding) : !prior.has(finding));
          if (!sameStrings(details.findings, expected)) throw new Error('fake world rejected review finding classification');
          if (action.kind === 'review.retain-repeat') facts.retainedFindings = expected;
          else facts.routedFindings = expected;
          return;
        }
        case 'report.correct-sha': {
          const signal = requireSignal('reported-sha');
          if (details.actualHead !== signal.actualHead) throw new Error('fake world rejected incorrect head correction');
          facts.correctedSha = signal.actualHead;
          return;
        }
        case 'pr.retarget-main': {
          const signal = requireSignal('stacked-base');
          if (details.to !== signal.main) throw new Error('fake world rejected retarget to a non-main base');
          facts.base = signal.main;
          return;
        }
        case 'duplicate.close': {
          const signal = requireSignal('duplicate-cell-pr');
          if (details.keep !== signal.prs[0] || !sameNumbers(details.close as number[], signal.prs.slice(1)))
            throw new Error('fake world rejected duplicate closure with multiple or incorrect survivors');
          facts.keptPr = signal.prs[0] ?? null;
          facts.closedPrs = signal.prs.slice(1);
          return;
        }
        case 'queue.predict-conflict': {
          const signal = requireSignal('post-land-conflict');
          const landed = new Set(signal.landedFiles);
          const overlap = signal.queuedFiles.filter((file) => landed.has(file));
          if (!sameStrings(details.files, overlap)) throw new Error('fake world rejected conflict prediction with wrong files');
          facts.predictedConflicts = overlap;
          return;
        }
        case 'owner.notify-conflict': {
          const signal = requireSignal('post-land-conflict');
          if (!facts.predictedConflicts.length || details.owner !== signal.owner) throw new Error('fake world rejected notification without conflict evidence');
          facts.notifiedOwner = signal.owner;
          return;
        }
        case 'generated.split-writer': {
          const signal = requireSignal('generated-file-overlap');
          const owners = facts.writerOwners.get(signal.path);
          if (details.path !== signal.path || signal.prs.length < 2 || !sameNumbers(details.prs as number[], signal.prs)
            || !owners || !sameNumbers(owners, signal.prs)) throw new Error('fake world rejected unrelated writer split');
          facts.writerOwners.delete(signal.path);
          for (const pr of signal.prs) facts.writerOwners.set(`${signal.path}.writer-${pr}`, [pr]);
          facts.writerCollision = [...facts.writerOwners.values()].some((fileOwners) => fileOwners.length > 1);
          return;
        }
        case 'assignment.refuse-active': {
          const signal = requireSignal('assignment-collision');
          if (!signal.activePrs.includes(String(signal.pr)) || details.pr !== signal.pr) throw new Error('fake world rejected non-active duplicate refusal');
          facts.activeAssignmentRefused = true;
          state.assignment = 'refused';
          return;
        }
        case 'assignment.assign-once': {
          if (currentSignal.type === 'assignment-collision') {
            const signal = currentSignal;
            if (signal.activePrs.includes(String(signal.pr)) || details.pr !== signal.pr)
              throw new Error('fake world rejected double assignment for an active PR');
            const [host, slotText] = signal.candidateSlots.find((candidate) => candidate === `${details.host}/${details.slot}`)?.split('/') ?? [];
            if (!host || Number(slotText) !== details.slot) throw new Error('fake world rejected assignment to an unavailable slot');
            facts.assignment = { pr: signal.pr, host, slot: Number(slotText) };
            state.assignment = 'assigned';
            state.selectedHost = host;
            return;
          }
          const signal = requireSignal('role-tag-readiness');
          const host = signal.hosts.find((row) => row.host === details.host);
          if (!host || !readinessEligible(signal, host) || host.host !== signal.primaryHost)
            throw new Error('fake world rejected assignment to an unready or non-primary host');
          facts.assignment = { pr: 0, host: host.host, slot: 1 };
          state.assignment = 'assigned';
          state.selectedHost = host.host;
          return;
        }
        case 'cell.assign-idle-seat': {
          const signal = requireSignal('idle-seat');
          if (!signal.available || signal.priority < 0 || details.seat !== signal.seat || details.cell !== signal.cell)
            throw new Error('fake world rejected an unavailable idle-seat assignment');
          facts.idleSeatAssigned = true;
          return;
        }
        case 'worker.restart': {
          const signal = requireSignal('worker-exit');
          if (signal.cap < 1 || details.workerId !== signal.workerId) throw new Error('fake world rejected worker restart beyond cap');
          facts.workerRestarted = true;
          return;
        }
        case 'resource.cap-decrement':
        case 'resource.cap-increment': {
          const signal = requireSignal('host-load');
          const target = action.kind === 'resource.cap-decrement' ? Math.max(0, signal.cap - 1) : signal.cap + 1;
          if (details.to !== target) throw new Error('fake world rejected incorrect capacity adjustment');
          facts.resourceCap = target;
          return;
        }
        case 'readiness.assign-alternative-host': {
          const signal = requireSignal('role-tag-readiness');
          const host = signal.hosts.find((row) => row.host === details.host);
          if (!signal.substitutionMapAvailable || !host || !signal.alternatives.includes(host.host) || !readinessEligible(signal, host))
            throw new Error('fake world rejected missing substitution map or unready alternative');
          facts.assignment = { pr: 0, host: host.host, slot: 1 };
          state.assignment = 'assigned';
          state.selectedHost = host.host;
          return;
        }
        case 'readiness.refuse-assignment': {
          const signal = requireSignal('role-tag-readiness');
          const candidates = [signal.primaryHost, ...(signal.substitutionMapAvailable ? signal.alternatives : [])]
            .map((host) => signal.hosts.find((row) => row.host === host)).filter((host): host is FakeReadinessHost => !!host);
          if (candidates.some((host) => readinessEligible(signal, host))) throw new Error('fake world rejected refusal while a ready mapped host exists');
          facts.refusalReason = signal.edge;
          state.assignment = 'refused';
          return;
        }
        case 'release.stage-observed':
          if (currentSignal.type !== 'release-cycle' || details.stage !== currentSignal.stages[dispatched.filter((kind) => kind === 'release.stage-observed').length - 1])
            throw new Error('fake world rejected out-of-order release stage');
          return;
        case 'train.reclaim-gate-slots': {
          const signal = requireSignal('release-cycle');
          if (dispatched.filter((kind) => kind === 'release.stage-observed').length !== 1 || !sameStrings(details.slots, signal.trainSlots))
            throw new Error('fake world rejected slot reclaim outside cut boundary');
          gateSlotsExpected = signal.trainSlots.length;
          facts.gateSlotsReclaimed = true;
          return;
        }
        case 'train.restore-slots': {
          const signal = requireSignal('release-cycle');
          if (!facts.gateSlotsReclaimed || !sameStrings(details.slots, signal.trainSlots)) throw new Error('fake world rejected restoring unreclaimed slots');
          facts.gateSlotsRestored = true;
          return;
        }
        case 'vm.scale-down': {
          requireSignal('release-cycle');
          if (!facts.gateSlotsRestored) throw new Error('fake world rejected VM scale-down before slot restoration');
          facts.vmScaledDown = true;
          return;
        }
        case 'guardian.reserve-gate-hosts': {
          const signal = requireSignal('release-cycle');
          if (!sameStrings(details.hosts, signal.gateHosts) || leases.length) throw new Error('fake world rejected invalid or duplicate Guardian reservation');
          leases.push(...signal.gateHosts.map(() => 'active'));
          return;
        }
        case 'guardian.release-gate-hosts': {
          const signal = requireSignal('release-cycle');
          if (!sameStrings(details.hosts, signal.gateHosts) || leases.length !== signal.gateHosts.length || leases.some((lease) => lease !== 'active')
            || !facts.gateSlotsRestored || !facts.vmScaledDown) throw new Error('fake world rejected lease release before all host cleanup completed');
          for (let index = 0; index < leases.length; index++) leases[index] = 'released';
          return;
        }
      }
    };
      const runId = `sim-${scenario.id}-${randomUUID()}`;
      const signals = [scenario.signal, ...(scenario.followupSignals ?? [])];
      for (const [index, signal] of signals.entries()) {
        currentSignal = signal;
        const actionRunId = `${runId}-${index}`;
        if (signal.type === 'human-intervention-observed') {
          humanInterventions++;
          continue;
        }
        if (signal.type === 'hotspot-retest-result') {
          const request = facts.retestRequest;
          if (request?.pr === signal.pr && request.retestId === signal.retestId && request.head === signal.head && signal.receiptId.trim()) {
            const receipt = { pr: signal.pr, retestId: signal.retestId, head: signal.head,
              priorVerdict: request.priorVerdict, result: signal.result, receiptId: signal.receiptId, runId: actionRunId };
            retestReceipts.set(`${signal.pr}:${signal.retestId}`, receipt);
            facts.retestReceipt = receipt;
          }
          continue;
        }
        let actions = planSimulationSignal(signal);
        if (signal.type === 'hotspot-retest-complete') {
          const proof = retestReceipts.get(`${signal.pr}:${signal.retestId}`);
          const priorRequest = facts.retestRequest;
          const matchingEvidence = signal.result === 'passed' && signal.verifiedHead === signal.integratedHead
            && proof?.head === signal.integratedHead && proof.priorVerdict === signal.priorVerdict && proof.result === 'passed'
            && priorRequest?.pr === signal.pr && priorRequest.retestId === signal.retestId
            && priorRequest.head === signal.integratedHead && priorRequest.priorVerdict === signal.priorVerdict;
          if (!matchingEvidence) actions = [{ kind: 'gate.retest-rejected', details: { pr: signal.pr, retestId: signal.retestId } }];
        }
        for (const action of actions) {
          apply(action);
          if (facts.retestRejected) break;
        }
      }
      state.mergedMainHead = facts.mergedMainHead;
      state.transplantedHead = facts.transplantedHead;
      state.landedFiles = initialSignal.type === 'post-land-conflict' ? [...initialSignal.landedFiles] : [];
      state.predictedConflicts = [...facts.predictedConflicts];
      state.notifiedOwner = facts.notifiedOwner;
      state.queueCandidates = queueCandidatesFor(initialSignal, facts, landQueue);
      state.waiverHead = facts.waiverHead;
      state.correctedSha = facts.correctedSha;
      state.base = facts.base;
      state.keptPr = facts.keptPr;
      state.closedPrs = [...facts.closedPrs];
      state.retainedFindings = [...facts.retainedFindings];
      state.routedFindings = [...facts.routedFindings];
      state.activeAssignmentRefused = facts.activeAssignmentRefused;
      state.idleSeatAssigned = facts.idleSeatAssigned;
      if (initialSignal.type === 'hotspot-main-drift' && facts.retestPassed && initialSignal.baselineErrors !== undefined
        && initialSignal.integratedErrors !== undefined) {
        const newErrors = initialSignal.integratedErrors - initialSignal.baselineErrors;
        state.typecheckOutput = `[tsc-main-delta] base=${facts.mergedMainHead} base_rc=1 head=${facts.transplantedHead} head_rc=1 baseline_errors=${initialSignal.baselineErrors} head_errors=${initialSignal.integratedErrors} new_errors=${newErrors}`
          + (newErrors > 0 ? `\nerror: main-baseline tsc introduced ${newErrors} TypeScript diagnostic(s)` : '');
      }
      state.guardianLeases = [...leases];
      state.writerOwners = Object.fromEntries([...facts.writerOwners.entries()].map(([path, owners]) => [path, [...owners]]));
      state.writerCollision = facts.writerCollision;
      const observed = dispatched;
      const missing = scenario.expectedActions.filter((kind, index) => observed[index] !== kind);
      const unexpected = observed.filter((kind, index) => scenario.expectedActions[index] !== kind);
      const stateComplete = signals.every((signal) => worldResolved(signal, facts, state.guardianLeases, gateSlotsExpected));
      state.resolved = stateComplete;
      for (const closedPr of state.closedPrs) landQueue.delete(closedPr);
      for (const candidate of state.queueCandidates) landQueue.set(candidate.pr, candidate.head);
      completedIncidents.push(scenario.id);
      results.push({ id: scenario.id,
        world: { revisionBefore, completedBefore, queueBefore, revisionAfter: completedIncidents.length,
          completedAfter: [...completedIncidents], queueAfter: [...landQueue].map(([pr, head]) => ({ pr, head })) },
        observed, missing, unexpected, finalState: state, humanInterventions, zeroInterventionAssertion: humanInterventions === 0 });
  }
  return results;
}
