import {
  assessDraftTriage,
  decideDraft,
  draftClaimState,
  type DraftDecision,
  type DraftTriageAssessmentInput,
  type DraftTriageInput,
  type DraftTriageNextAction,
  type DraftTriagePr,
} from '../self-dev/draft-triage-rules.js';

export type DraftInventoryScenario =
  | 'merged-twin'
  | 'duplicate-open'
  | 'harvest-reference'
  | 'all-files-landed'
  | 'protected-label'
  | 'running'
  | 'stale'
  | 'harvestable';

export interface DraftInventoryCase {
  scenario: DraftInventoryScenario;
  input: DraftTriageInput;
  expected: DraftDecision['action'];
  assessmentInput: DraftTriageAssessmentInput;
  expectedAssessment: DraftTriageNextAction;
}

const fixedNow = Date.parse('2026-10-26T00:00:00.000Z');
const iso = (offsetMs: number): string => new Date(fixedNow + offsetMs).toISOString();
const CASE_AGE_HOURS = 60;
const CASE_AGE_MS = CASE_AGE_HOURS * 60 * 60_000;

function makeCase(scenario: DraftInventoryScenario, index: number): DraftInventoryCase {
  const number = 10_000 + index;
  const title = `Draft inventory ${scenario} ${index}`;
  const branchStem = `inventory-${scenario}-${index}`;
  const cell = 'MOCK-DRAFT-INVENTORY';
  const body = `골: ${branchStem}\n칸: ${cell}\n카드: mock-draft-${scenario}-${index}`;
  const createdAt = iso(-72 * 60 * 60_000);
  const latestCommitAt = iso(-CASE_AGE_MS);
  const fileChangedAt = iso(-70 * 60 * 60_000);
  const labels = ['elanous:from-ux'];
  const draft: DraftTriagePr = {
    number,
    title,
    branch: `self-impl/${branchStem}-a1b2c3d4-r1`,
    body,
    createdAt,
    latestCommitAt,
    updatedAt: iso(-30 * 60_000),
    changedFiles: ['src/example.ts'],
    latestFileChanges: { 'src/example.ts': fileChangedAt },
    labels,
  };
  const input: DraftTriageInput = {
    draft,
    runStatus: 'self-implement.result final',
    mergedTwins: [],
    openDrafts: [],
    ageHours: CASE_AGE_HOURS,
    liveBranches: new Set<string>(),
  };
  const assessmentInput: DraftTriageAssessmentInput = {
    draft,
    now: new Date(fixedNow),
    runStatus: 'completed',
  };
  let expected: DraftDecision['action'] = 'keep';
  let expectedAssessment: DraftTriageNextAction = 'human';

  switch (scenario) {
    case 'merged-twin':
      input.mergedTwins = [{ number: number + 50_000, title: 'merged twin', branch: 'main', body }];
      assessmentInput.replacement = { number: number + 50_000, evidence: 'same verified goal was merged' };
      expected = 'close';
      expectedAssessment = 'close-b';
      break;
    case 'duplicate-open':
      input.openDrafts = [{
        number: number + 50_000,
        title,
        branch: `self-impl/${branchStem}-d4e5f6a7-r2`,
        body,
        createdAt: iso(-60 * 60 * 60_000),
      }];
      assessmentInput.replacement = { number: number + 50_000, evidence: 'newer same-card draft supersedes this draft' };
      expected = 'close';
      expectedAssessment = 'close-b';
      break;
    case 'harvest-reference':
      input.mergedTwins = [{
        number: number + 50_000,
        title: 'harvested replacement',
        branch: 'main',
        body: `수확 완료 (수확 #${number})`,
      }];
      expected = 'close';
      break;
    case 'all-files-landed':
      input.mergedTwins = [{
        number: number + 50_000,
        title: 'later landed file',
        branch: `self-impl/${branchStem}-b2c3d4e5-r2`,
        body,
        changedFiles: ['src/example.ts'],
        mergedAt: iso(-69 * 60 * 60_000),
      }];
      assessmentInput.replacement = { number: number + 50_000, evidence: 'all changed files landed in the replacement' };
      expected = 'close';
      expectedAssessment = 'close-b';
      break;
    case 'protected-label':
      draft.labels = [...labels, 'elanous:keep'];
      expected = 'keep';
      break;
    case 'running':
      draft.labels = [...labels, 'elanous:running'];
      input.runStatus = 'running';
      input.liveBranches = new Set([draft.branch]);
      assessmentInput.runStatus = 'running';
      expected = 'keep';
      break;
    case 'stale':
      input.runStatus = undefined;
      assessmentInput.ownerConfirmed = true;
      expected = 'close';
      expectedAssessment = 'close-c';
      break;
    case 'harvestable':
      draft.labels = [...labels, 'elanous:harvestable'];
      draft.body = `${body}\n수확보류: harvest-deferred`;
      input.runStatus = 'failed';
      assessmentInput.runStatus = 'failed';
      assessmentInput.gate = 'pass';
      assessmentInput.review = 'approved';
      expected = 'keep';
      expectedAssessment = 'harvest';
      break;
  }

  return { scenario, input, expected, assessmentInput, expectedAssessment };
}

/** Deterministic synthetic inventory; both production draft triage functions run for every case. */
export function buildDraftInventory(count = 200): DraftInventoryCase[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  const scenarios: readonly DraftInventoryScenario[] = [
    'merged-twin', 'duplicate-open', 'harvest-reference', 'all-files-landed',
    'protected-label', 'running', 'stale', 'harvestable',
  ];
  return Array.from({ length: count }, (_, index) => makeCase(scenarios[index % scenarios.length]!, index));
}

export function assessDraftInventory(cases = buildDraftInventory()): {
  total: number;
  byScenario: Record<DraftInventoryScenario, number>;
  byAction: Record<'close' | 'keep', number>;
  triageByAction: Record<DraftTriageNextAction, number>;
  mismatches: string[];
  protectedOrRunningClosed: number;
} {
  const byScenario: Record<DraftInventoryScenario, number> = {
    'merged-twin': 0,
    'duplicate-open': 0,
    'harvest-reference': 0,
    'all-files-landed': 0,
    'protected-label': 0,
    running: 0,
    stale: 0,
    harvestable: 0,
  };
  const byAction = { close: 0, keep: 0 };
  const triageByAction: Record<DraftTriageNextAction, number> = {
    'close-a': 0, 'close-b': 0, 'close-c': 0, harvest: 0, human: 0,
  };
  const mismatches: string[] = [];
  let protectedOrRunningClosed = 0;
  cases.forEach((item, index) => {
    byScenario[item.scenario] += 1;
    const decision = decideDraft(item.input);
    byAction[decision.action] += 1;
    if (decision.action !== item.expected) mismatches.push(`${index}:${item.scenario}:decideDraft expected=${item.expected} actual=${decision.action}`);

    const assessment = assessDraftTriage(item.assessmentInput);
    triageByAction[assessment.nextAction] += 1;
    if (assessment.nextAction !== item.expectedAssessment) mismatches.push(`${index}:${item.scenario}:assessDraftTriage expected=${item.expectedAssessment} actual=${assessment.nextAction}`);

    if ((item.scenario === 'protected-label' || item.scenario === 'running') && decision.action === 'close') {
      protectedOrRunningClosed += 1;
    }
    if (item.scenario === 'running' && draftClaimState(item.input.draft, new Date(fixedNow)) !== 'claimed') {
      mismatches.push(`${index}:running:draftClaimState expected=claimed`);
    }
  });
  return { total: cases.length, byScenario, byAction, triageByAction, mismatches, protectedOrRunningClosed };
}
