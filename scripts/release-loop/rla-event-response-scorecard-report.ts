import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { planMacrophageIncident, type MacrophageIncidentPlan, type MacrophageIncidentSignal } from '../../src/release-loop/macrophage-incident-recovery.js';
import { RLA_EVENT_RESPONSE_EVENTS } from '../../src/ux-sim/rla-event-response-scorecard.js';

export const RLA_SCORECARD_LABEL = '시뮬 사건 대응 성적(그림자 계획기 · 실발행 측정 아님)';
const EXPECTED_KNOWHOW_INCIDENTS = 33;

export interface RlaScorecardInput {
  readonly id: string;
  readonly source: 'knowledge-pack' | 'release-sim-rig';
  readonly eventId?: string;
  readonly signal: MacrophageIncidentSignal;
  readonly plan: MacrophageIncidentPlan;
}

export interface RlaScorecardEventResult {
  readonly eventId: string;
  readonly kind: string;
  readonly name: string;
  readonly baseline: string;
  readonly target: string;
  readonly sampleCount: number;
  readonly plannedCount: number;
  readonly unsupportedCount: number;
  readonly score: number;
  readonly measurement: 'shadow-plan-coverage' | 'no-matching-inputs';
  readonly inputs: readonly { id: string; source: RlaScorecardInput['source']; label: string; step: string; reason: string }[];
}

export interface RlaEventResponseScorecardReport {
  readonly schema: 'elanous.rla-event-response-scorecard.v1';
  readonly label: typeof RLA_SCORECARD_LABEL;
  readonly releaseVersion: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly source: {
    readonly knowledgePackPath: string;
    readonly knowledgePackSha256: string;
    readonly knowledgePackIncidentCount: number;
    readonly unclassifiedKnowledgePackIncidentIds: readonly string[];
    readonly unclassifiedKnowledgePackIncidentPlans: readonly { id: string; label: string; step: string; reason: string; score: 0 }[];
    readonly releaseSimRigPath: string;
    readonly releaseSimRigCaseCount: number;
    readonly unclassifiedReleaseSimRigCaseIds: readonly string[];
    readonly unclassifiedReleaseSimRigCasePlans: readonly { id: string; label: string; step: string; reason: string; score: 0 }[];
  };
  readonly timing: 'unmeasured';
  readonly liveReleaseMeasurement: false;
  readonly scores: readonly RlaScorecardEventResult[];
}

const EVENT_MATCHERS: ReadonlyArray<{ eventId: string; pattern: RegExp }> = [
  { eventId: 'RLA-ER-02', pattern: /receipt.{0,30}(?:corrupt|damag)|(?:corrupt|damag).{0,30}receipt|shard.{0,30}(?:corrupt|damag)/i },
  { eventId: 'RLA-ER-03', pattern: /stale.{0,30}generated|generated.{0,30}artifact/i },
  { eventId: 'RLA-ER-04', pattern: /worker.{0,30}(?:death|died|dead|exit)|STOP_AT/i },
  { eventId: 'RLA-ER-05', pattern: /host.{0,30}(?:outage|down|load|occupied)|(?:outage|unreachable).{0,30}host/i },
  { eventId: 'RLA-ER-06', pattern: /(?:github|server).{0,30}push.{0,20}(?:reject|503)|push.{0,30}(?:reject|503)/i },
  { eventId: 'RLA-ER-07', pattern: /unmeasured.{0,30}rehearsal|rehearsal.{0,30}unmeasured/i },
  { eventId: 'RLA-ER-08', pattern: /waiver|면제/i },
  { eventId: 'RLA-ER-09', pattern: /release.{0,30}blocked|blocked.{0,30}release|missed.{0,20}06:00/i },
  { eventId: 'RLA-ER-10', pattern: /TA Pod.{0,30}intrusion|gate host intrusion/i },
  { eventId: 'RLA-ER-01', pattern: /gate.{0,30}regression|regression.{0,30}gate|introduced.{0,30}regression/i },
];

function eventFor(text: string): string | undefined {
  return EVENT_MATCHERS.find(({ pattern }) => pattern.test(text))?.eventId;
}

function safeSourceFiles(text: string): string[] {
  const matches = text.match(/(?:src|scripts|graphs|test|scenarios)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|yaml|yml|json|md)/g) ?? [];
  return [...new Set(matches.map((path) => path.replace(/[),.;:]+$/g, '')).filter((path) => !path.split('/').includes('..')))].sort();
}

function evidenceFromCause(cause: string, text: string): MacrophageIncidentSignal['evidence'] {
  if (/코드 회귀|introduced failure|introduced regression/i.test(cause)) return 'introduced';
  if (/preexisting|main에서 이미|main 에서 이미/i.test(cause + text)) return 'preexisting';
  if (/환경|호스트|외부|load|부하/i.test(cause)) return 'external';
  if (/측정 불가|원문 없음|관측 결손|unmeasured/i.test(cause)) return 'unmeasured';
  return 'unmeasured';
}

function sourceFromNode(node: string, cause: string): MacrophageIncidentSignal['source'] {
  if (/열차|train/i.test(node)) return 'train';
  if (/호스트|환경|host|machine/i.test(node + cause)) return 'host';
  return 'release-graph';
}

export function parseKnowhowPackIncidents(markdown: string, expectedIncidentCount = EXPECTED_KNOWHOW_INCIDENTS): readonly RlaScorecardInput[] {
  const rows = markdown.split(/\r?\n/).filter((line) => /^\|\s*R\d+[a-z]?\s*\|/.test(line));
  if (rows.length !== expectedIncidentCount) {
    throw new Error(`KNOWHOW pack must contain ${expectedIncidentCount} incident rows; found ${rows.length}`);
  }
  return rows.map((row) => {
    const cells = row.split('|').map(cell => cell.trim()).slice(1, -1);
    const [id, node = '', symptom = '', cause = ''] = cells;
    if (!id || !symptom || !cause) throw new Error(`malformed KNOWHOW incident row: ${id ?? row.slice(0, 80)}`);
    const serialized = cells.join(' | ');
    const eventId = eventFor(serialized);
    const signal: MacrophageIncidentSignal = {
      id,
      source: sourceFromNode(node, cause),
      signature: symptom.slice(0, 240),
      evidence: evidenceFromCause(cause, serialized),
      sourceFiles: safeSourceFiles(serialized),
      retryable: /timeout|타임아웃|재측정|재시도/i.test(serialized),
    };
    return { id, source: 'knowledge-pack' as const, ...(eventId ? { eventId } : {}), signal, plan: planMacrophageIncident(signal) };
  });
}

interface ReleaseSimRig {
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly fault?: { readonly node?: unknown; readonly outcome?: unknown; readonly evidence?: unknown };
    readonly mode?: unknown;
  }[];
}

export function parseReleaseSimRig(yaml: string): { readonly caseCount: number; readonly inputs: readonly RlaScorecardInput[]; readonly unclassifiedInputs: readonly RlaScorecardInput[] } {
  const parsed = parseYaml(yaml) as ReleaseSimRig;
  if (!Array.isArray(parsed.cases)) throw new Error('release-sim-rig must declare cases');
  const allInputs = parsed.cases.map((scenario) => {
    if (typeof scenario.id !== 'string') throw new Error('release-sim-rig case is missing id');
    const serialized = JSON.stringify(scenario);
    const eventId = eventFor(serialized);
    const faultEvidence = scenario.fault?.evidence && typeof scenario.fault.evidence === 'object'
      ? scenario.fault.evidence as Record<string, unknown> : {};
    const sourceFiles = Array.isArray(faultEvidence.introducedFiles)
      ? faultEvidence.introducedFiles.filter((value): value is string => typeof value === 'string' && /^(src|scripts|graphs|test|scenarios)\//.test(value) && !value.split('/').includes('..'))
      : safeSourceFiles(serialized);
    const outcome = scenario.fault?.outcome;
    const evidence: MacrophageIncidentSignal['evidence'] = Array.isArray(faultEvidence.introduced) || sourceFiles.length
      ? 'introduced' : outcome === 'ok' || outcome === 'pass' ? 'self-healed' : 'unmeasured';
    const signal: MacrophageIncidentSignal = {
      id: scenario.id,
      source: 'release-graph',
      signature: scenario.id,
      evidence,
      sourceFiles,
      retryable: outcome === 'error' || outcome === 'fail',
    };
    return { id: scenario.id, source: 'release-sim-rig' as const, ...(eventId ? { eventId } : {}), signal, plan: planMacrophageIncident(signal) };
  });
  return { caseCount: parsed.cases.length, inputs: allInputs.filter((input) => input.eventId), unclassifiedInputs: allInputs.filter((input) => !input.eventId) };
}

export function buildRlaScorecardReport(input: {
  releaseVersion: string;
  runId: string;
  generatedAt?: string;
  knowledgePackPath: string;
  knowledgePackText: string;
  releaseSimRigPath: string;
  releaseSimRigText: string;
  expectedKnowledgePackIncidentCount?: number;
}): RlaEventResponseScorecardReport {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.releaseVersion)) throw new Error(`invalid release version: ${input.releaseVersion}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.runId) || input.runId === '.' || input.runId === '..') throw new Error('invalid release run id');
  const expectedIncidentCount = input.expectedKnowledgePackIncidentCount ?? EXPECTED_KNOWHOW_INCIDENTS;
  const incidents = parseKnowhowPackIncidents(input.knowledgePackText, expectedIncidentCount);
  const rig = parseReleaseSimRig(input.releaseSimRigText);
  const inputs = [...incidents, ...rig.inputs];
  const scores = RLA_EVENT_RESPONSE_EVENTS.map((event): RlaScorecardEventResult => {
    const eventInputs = inputs.filter((candidate) => candidate.eventId === event.id);
    const plannedCount = eventInputs.filter((candidate) => candidate.plan.label !== 'hitl').length;
    const sampleCount = eventInputs.length;
    return {
      eventId: event.id,
      kind: event.kind,
      name: event.name,
      baseline: event.baseline,
      target: event.target,
      sampleCount,
      plannedCount,
      unsupportedCount: sampleCount - plannedCount,
      score: sampleCount === 0 ? 0 : Math.round((plannedCount / sampleCount) * 100),
      measurement: sampleCount === 0 ? 'no-matching-inputs' : 'shadow-plan-coverage',
      inputs: eventInputs.map(({ id, source, plan }) => ({ id, source, label: plan.label, step: plan.step, reason: plan.reason })),
    };
  });
  return {
    schema: 'elanous.rla-event-response-scorecard.v1',
    label: RLA_SCORECARD_LABEL,
    releaseVersion: input.releaseVersion,
    runId: input.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      knowledgePackPath: input.knowledgePackPath,
      knowledgePackSha256: createHash('sha256').update(input.knowledgePackText).digest('hex'),
      knowledgePackIncidentCount: expectedIncidentCount,
      unclassifiedKnowledgePackIncidentIds: incidents.filter((incident) => !incident.eventId).map(({ id }) => id),
      unclassifiedKnowledgePackIncidentPlans: incidents.filter((incident) => !incident.eventId).map(({ id, plan }) => ({ id, label: plan.label, step: plan.step, reason: plan.reason, score: 0 as const })),
      releaseSimRigPath: input.releaseSimRigPath,
      releaseSimRigCaseCount: rig.caseCount,
      unclassifiedReleaseSimRigCaseIds: rig.unclassifiedInputs.map(({ id }) => id),
      unclassifiedReleaseSimRigCasePlans: rig.unclassifiedInputs.map(({ id, plan }) => ({ id, label: plan.label, step: plan.step, reason: plan.reason, score: 0 as const })),
    },
    timing: 'unmeasured',
    liveReleaseMeasurement: false,
    scores,
  };
}

export function writeRlaScorecardReport(report: RlaEventResponseScorecardReport, stateRoot = join(homedir(), '.elanous')): string {
  const path = join(stateRoot, 'release', report.releaseVersion, 'scorecard.json');
  const directory = dirname(path);
  const temporaryPath = join(directory, `.scorecard-${process.pid}-${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return path;
}

interface CompletedReleaseRunLedger {
  readonly runId?: unknown;
  readonly status?: unknown;
  readonly input?: { readonly version?: unknown };
}

export function completedReleaseRun(stateRoot: string, runId: string): { readonly releaseVersion: string; readonly runId: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId) || runId === '.' || runId === '..') throw new Error('invalid release run id');
  const ledgerPath = join(stateRoot, 'graph-runs', 'release-loop', `${runId}.json`);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as CompletedReleaseRunLedger;
  if (ledger.runId !== runId || ledger.status !== 'done' || typeof ledger.input?.version !== 'string') {
    throw new Error(`release run ${runId} must have a matching completed ledger with input.version`);
  }
  return { releaseVersion: ledger.input.version, runId };
}

export function runRlaScorecardReportCli(args: readonly string[], cwd = process.cwd(), expectedKnowledgePackIncidentCount = EXPECTED_KNOWHOW_INCIDENTS): string {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const runId = option('--run-id');
  const knowledgePackPath = option('--knowledge-pack');
  if (!runId || !knowledgePackPath) {
    throw new Error('usage: bun scripts/release-loop/rla-event-response-scorecard-report.ts --run-id <completed-release-run-id> --knowledge-pack <markdown> [--release <version>] [--release-sim-rig <yaml>] [--state-root <path>]');
  }
  const stateRoot = resolve(cwd, option('--state-root') ?? process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous'));
  const releaseRun = completedReleaseRun(stateRoot, runId);
  const requestedVersion = option('--release');
  if (requestedVersion && requestedVersion !== releaseRun.releaseVersion) {
    throw new Error(`release version ${requestedVersion} does not match completed run ${runId} (${releaseRun.releaseVersion})`);
  }
  const releaseSimRigPath = option('--release-sim-rig') ?? 'scenarios/ux-sim/release-sim-rig.yaml';
  const resolveInput = (path: string): string => resolve(cwd, path);
  const resolvedPack = resolveInput(knowledgePackPath);
  const resolvedRig = resolveInput(releaseSimRigPath);
  const report = buildRlaScorecardReport({
    releaseVersion: releaseRun.releaseVersion, runId: releaseRun.runId,
    knowledgePackPath: resolvedPack,
    knowledgePackText: readFileSync(resolvedPack, 'utf8'),
    releaseSimRigPath: resolvedRig,
    releaseSimRigText: readFileSync(resolvedRig, 'utf8'),
    expectedKnowledgePackIncidentCount,
  });
  return writeRlaScorecardReport(report, stateRoot);
}

if (import.meta.main) {
  try {
    const path = runRlaScorecardReportCli(process.argv.slice(2));
    process.stdout.write(`scorecard: ${path}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
