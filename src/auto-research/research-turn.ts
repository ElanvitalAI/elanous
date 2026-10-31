import { streamLLM } from '../llm.js';
import { invokeResearchAxes } from '../research-bridge/index.js';
import { RESEARCH_TURN_DEADLINE_STOP_ERROR } from '../core-turn/research-policy.js';
import { invokeResearch } from '../research-bridge/invoke.js';
import type { AxisFanoutResult } from '../research/axis-fanout.js';
import { routeResearchOutput } from '../research/output-router.js';
import { planGapFollowup, runGapFollowup } from '../research/gap-followup.js';
import type { ResearchGapFollowupInput, ResearchGapFollowupPlan } from '../research/gap-followup.js';
import { debug, redactSecretText } from '../debug/log.js';
import {
  buildWorkingBackwardsContractPrompt,
  formatWorkingBackwardsLadderContext,
  parseWorkingBackwardsContract,
  type WorkingBackwardsOutputContract,
} from '../research/lenses/working-backwards.js';
import { attachResearchEvidence, buildResearchQuestionLadderPrompt,
  parseSixLevelResearchQuestionLadder, type BloomLevel, type ResearchEvidenceEnvelope,
  type SixLevelResearchQuestionLadder } from './question-ladder-contract.js';

export interface ResearchQuestionLadderRunOptions {
  signal?: AbortSignal;
  admitToolCall?: (toolName: string) => boolean;
  allowPartialOnAbort?: boolean;
  allowOutputSkill?: boolean;
  generateContract?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  generate?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  invokeAxes?: (questions: SixLevelResearchQuestionLadder['questions'], signal?: AbortSignal, admitToolCall?: (toolName: string) => boolean) => Promise<AxisFanoutResult>;
  routeOutput?: typeof routeResearchOutput;
  invokeOutputSkill?: (skill: string, args: string, signal?: AbortSignal) => Promise<{ ok: boolean; output: string; error?: string }>;
  /** Test seam for the bounded Bloom 4/5 evidence-gap follow-up. */
  gapFollowup?: typeof runGapFollowup;
  /** Test seam for deciding whether production gap-follow-up has any runnable calls. */
  planGapFollowup?: (input: ResearchGapFollowupInput) => ResearchGapFollowupPlan;
  /** Test/config seam for an explicitly installed private Bloom exemplar pack. */
  bloomExemplarPackPath?: string;
}

export interface ResearchGroundingResult {
  ok: boolean;
  output: string;
  error?: string;
}

function invokeProductionResearchAxes(
  questions: SixLevelResearchQuestionLadder['questions'],
  signal?: AbortSignal,
  admitToolCall?: (toolName: string) => boolean,
): Promise<AxisFanoutResult> {
  return invokeResearchAxes(questions, { signal, admitToolCall });
}

export interface ResearchQuestionLadderRunResult {
  ok: boolean;
  ladder: SixLevelResearchQuestionLadder;
  outputContract?: WorkingBackwardsOutputContract;
  output: string;
  error?: string;
}

export interface WorkingBackwardsBlankSlot {
  id: string;
  title: string;
  purpose: string;
}

export interface WorkingBackwardsPlannedNode {
  /** `ladder` = 사다리 질문 생성 노드(questions가 아직 없을 때), `axis` = 해당 질문의 증거 검색 노드. */
  kind: 'ladder' | 'axis';
  /** 이 노드가 채우려는 출력 계약 섹션 슬롯. */
  sectionId: string;
  /** 노드 식별자 — ladder 계획은 `ladder:<sectionId>`, axis 계획은 사다리 질문 id. */
  nodeId: string;
  /** axis 노드가 물고 있는 사다리 질문의 Bloom 단계. */
  level?: BloomLevel;
  /** axis 노드가 실행할 검색어. */
  searchTerms?: string[];
}

export interface WorkingBackwardsCompletionBoundary {
  /** 아직 채워지지 않은 출력 계약 섹션 슬롯(빈 칸 목록). */
  blankSlots: WorkingBackwardsBlankSlot[];
  /** 빈 칸마다 그 칸을 채울 ladder/axis 노드 계획(노드 계획). */
  nodePlan: WorkingBackwardsPlannedNode[];
  /** 모든 출력 계약 슬롯이 채워졌다 — 호출자는 이때 추가 research를 멈춘다. */
  complete: boolean;
}

function partialResearchOutput(request: string, ladder: SixLevelResearchQuestionLadder, note: string): string {
  const evidence = ladder.evidence.map(item => `- [${item.outcome}] ${item.sourceKind} · ${item.source}: ${item.content}`);
  return [
    `# Partial research: ${request}`,
    `Research stopped at its wall-clock limit (${note}). Synthesize only the evidence listed here and state remaining uncertainty.`,
    ...(evidence.length ? ['', '## Evidence collected before stopping', ...evidence] : ['', 'No source evidence was collected before the deadline.']),
  ].join('\n');
}

/**
 * Working Backwards 완료 경계 — 출력 계약(buildWorkingBackwardsContractPrompt → parse…Contract)의
 * 슬롯 중 채워지지 않은 칸을 찾고 각 칸을 채울 노드 계획을 낸다. questions 없이 부르면 모든 슬롯이
 * 빈 칸이고 계획은 사다리 생성(`ladder:<sectionId>`)이 된다. questions·evidence 와 함께 부르면
 * complete 증거를 1건 이상 가진 질문이 슬롯을 채운 것으로 보고, 빈 칸에는 해당 질문의 axis 검색
 * 노드가 계획된다. 질문은 출력 계약의 sectionId로 배정하며, 할당되지 않은 슬롯은 ladder 노드로 남긴다.
 */
export function planWorkingBackwardsCompletion(
  contract: WorkingBackwardsOutputContract,
  questions: SixLevelResearchQuestionLadder['questions'] = [],
  evidence: ResearchEvidenceEnvelope[] = [],
): WorkingBackwardsCompletionBoundary {
  const fulfilledQuestionIds = new Set(questions
    .filter((question) => evidence.some((item) => item.questionId === question.id && item.outcome === 'complete'))
    .map((question) => question.id));
  const blankSlots: WorkingBackwardsBlankSlot[] = [];
  const nodePlan: WorkingBackwardsPlannedNode[] = [];
  contract.sections.forEach((section) => {
    const assigned = questions.filter((question) => question.sectionId === section.id);
    const unfilled = assigned.filter((question) => !fulfilledQuestionIds.has(question.id));
    if (assigned.length > 0 && unfilled.length === 0) return;
    blankSlots.push({ id: section.id, title: section.title, purpose: section.purpose });
    for (const question of unfilled) {
      nodePlan.push({
        kind: 'axis',
        sectionId: section.id,
        nodeId: question.id,
        level: question.level,
        searchTerms: [...question.searchTerms],
      });
    }
    if (assigned.length === 0) {
      nodePlan.push({ kind: 'ladder', sectionId: section.id, nodeId: `ladder:${section.id}` });
    }
  });
  return { blankSlots, nodePlan, complete: blankSlots.length === 0 };
}

/** 조사 런 귀속용 orchestration 식별자 — 회고 레코드에 싣는다. */
function orchestrationId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `orch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 회고 레코드 — 조사 런 종료 시 주제별로 정확히 1건 저장되고 다음 같은 주제 턴에 1단 근거로 주입된다. */
interface ResearchRetroRecord {
  topic: string;
  observedGap: string;
  orchestrationId: string;
  observedAt: string;
}

/** 주제별 최신 회고 레코드 저장소 — Map.set 이므로 주제당 정확히 1건만 남는다. */
const retroRecordsByTopic = new Map<string, ResearchRetroRecord>();

/** 조사 런에서 채워지지 않은 증거 공백을 회고 문장으로 뽑는다(비밀은 redactSecretText 로 가린다). */
function deriveObservedGap(
  ladder: SixLevelResearchQuestionLadder,
  evidence: ResearchEvidenceEnvelope[],
): string {
  const incomplete = ladder.questions
    .filter((question) => !evidence.some((item) => item.questionId === question.id && item.outcome === 'complete'))
    .map((question) => `${question.id}: ${question.prompt}`);
  return incomplete.length > 0
    ? `unfilled evidence — fill first: ${incomplete.join('; ')}`
    : 'none — every output-contract section slot was filled';
}

/** 회고 레코드를 저장하고 관측 이벤트로 남긴다 — 비밀·자격 문자열은 저장 전에 가린다. */
function saveRetroRecord(topic: string, ladder: SixLevelResearchQuestionLadder, evidence: ResearchEvidenceEnvelope[]): void {
  const record: ResearchRetroRecord = {
    topic: redactSecretText(topic),
    observedGap: redactSecretText(deriveObservedGap(ladder, evidence)),
    orchestrationId: orchestrationId(),
    observedAt: new Date().toISOString(),
  };
  retroRecordsByTopic.set(record.topic, record);
  debug.log('research.turn', 'retro-record-saved', { ...record });
}

/** 같은 주제의 최신 회고 레코드를 1단 근거로 주입한다 — 주입 사실은 debug.log 에 행으로 남는다. */
function retroGroundingContext(topic: string): string {
  const prior = retroRecordsByTopic.get(redactSecretText(topic));
  if (!prior) return '';
  debug.log('research.turn', 'retro-grounding-injected', { ...prior });
  return `\n\n## Prior turn retro (tier-1 grounding)\nTopic: ${prior.topic}\n`
    + `- Fill this gap first: ${prior.observedGap}\n`
    + `- State what changed since last time (지난번 대비 달라진 것).`;
}

/** 완료 경계를 관측 이벤트로 남긴다 — 출력 계약 → 빈 칸 목록 → 노드 계획, 다 차면 stop 로그는 호출자가 남긴다. */
function logCompletionBoundary(stage: string, boundary: WorkingBackwardsCompletionBoundary): void {
  debug.log('research.turn', 'completion-boundary', {
    stage,
    blankSlotIds: boundary.blankSlots.map((slot) => slot.id),
    plannedNodes: boundary.nodePlan.map((node) => `${node.kind}:${node.nodeId}`),
    complete: boundary.complete,
  });
}

/** 완료 경계의 최종 상태를 골격 칸(계약 슬롯별 채움 상태 + 빈 칸 노드 계획)으로 렌더링한다. */
function formatWorkingBackwardsSkeleton(
  contract: WorkingBackwardsOutputContract,
  boundary: WorkingBackwardsCompletionBoundary,
  evidenceRejected = false,
): string {
  const lines = ['## Answer skeleton (Working Backwards output contract)'];
  for (const section of contract.sections) {
    if (!boundary.blankSlots.some((slot) => slot.id === section.id)) {
      lines.push(`- [${section.id}] ${section.title} — ${section.purpose} — filled`);
      continue;
    }
    const plan = boundary.nodePlan
      .filter((node) => node.sectionId === section.id)
      .map((node) => node.kind === 'ladder'
        ? `ladder ${node.nodeId}`
        : `axis ${node.nodeId} (${(node.searchTerms ?? []).join(', ')})`)
      .join(' · ');
    lines.push(`- [${section.id}] ${section.title} — ${section.purpose} — blank · plan: ${plan}`);
  }
  if (boundary.complete) {
    lines.push('Completion boundary: stopped — every output-contract section slot is filled.');
    if (evidenceRejected) lines.push('Completion note: rejected evidence was discarded; the valid evidence above remains available.');
  }
  return lines.join('\n');
}

/** Generate Bloom axes, search each axis natively, and attach its source evidence. */
export async function runResearchQuestionLadder(
  request: string,
  options: ResearchQuestionLadderRunOptions = {},
): Promise<ResearchQuestionLadderRunResult> {
  const initial: SixLevelResearchQuestionLadder = { request, questions: [], evidence: [] };
  let contractRaw: string;
  try {
    contractRaw = await (options.generateContract ?? ((prompt, signal) => defaultGenerate(prompt, 'research-working-backwards-contract', signal)))(
      buildWorkingBackwardsContractPrompt(request), options.signal,
    );
    if (options.signal?.aborted) {
      return options.allowPartialOnAbort
        ? { ok: false, ladder: initial, output: partialResearchOutput(request, initial, 'before question generation'), error: RESEARCH_TURN_DEADLINE_STOP_ERROR }
        : { ok: false, ladder: initial, output: '', error: 'research aborted' };
    }
  } catch (error) {
    const reason = errorText(error);
    if (options.signal?.aborted) {
      return {
        ok: false, ladder: initial,
        output: options.allowPartialOnAbort ? partialResearchOutput(request, initial, 'output-contract generation') : '',
        error: RESEARCH_TURN_DEADLINE_STOP_ERROR,
      };
    }
    debug.log('research.lens', 'working-backwards-contract-failed', { reason }, { level: 'warn' });
    return { ok: false, ladder: initial, output: '', error: `output contract generation failed: ${reason}` };
  }

  let generatedContract: unknown;
  try {
    generatedContract = JSON.parse(extractJson(contractRaw));
  } catch (error) {
    const reason = errorText(error);
    debug.log('research.lens', 'working-backwards-contract-invalid', { reason }, { level: 'warn' });
    return { ok: false, ladder: initial, output: '', error: `output contract returned invalid JSON: ${reason}` };
  }
  const parsedContract = parseWorkingBackwardsContract(generatedContract);
  if (!parsedContract.ok) {
    debug.log('research.lens', 'working-backwards-contract-invalid', { reason: parsedContract.reason }, { level: 'warn' });
    return { ok: false, ladder: initial, output: '', error: parsedContract.reason };
  }
  const outputContract = parsedContract.value;
  debug.log('research.lens', 'selected', { lens: 'working-backwards', bloomLevel: 0 });
  const ladderContext = formatWorkingBackwardsLadderContext(outputContract);
  debug.log('research.lens', 'applied', {
    lens: 'working-backwards', sectionCount: outputContract.sections.length,
    completionCriteriaCount: outputContract.completionCriteria.length,
  });
  const contractBoundary = planWorkingBackwardsCompletion(outputContract);
  logCompletionBoundary('output-contract', contractBoundary);

  let raw: string;
  try {
    const sectionIds = outputContract.sections.map((section) => section.id);
    // Keep the premium exemplar bank outside the TUI's static import closure.
    const { getBloomExemplarContext } = await import('../research/bloom-exemplars.js');
    const { buildResearchBloom45Directive } = await import('../core-turn/deep-turn-bloom.js');
    const bloom45Directive = await buildResearchBloom45Directive();
    const exemplar = getBloomExemplarContext(request, options.bloomExemplarPackPath);
    debug.log('research.turn', 'bloom-exemplars-selected', {
      domain: exemplar.domain, domainSignal: exemplar.domainSignal,
      source: exemplar.source, count: exemplar.count, levels: exemplar.levels,
    });
    raw = await (options.generate ?? ((prompt, signal) => defaultGenerate(prompt, 'research-question-ladder', signal)))(
      `${buildResearchQuestionLadderPrompt(request, sectionIds)}\n\n${bloom45Directive}\n\n${exemplar.context ? `${exemplar.context}\n\n` : ''}${ladderContext}${retroGroundingContext(request)}`,
      options.signal,
    );
    if (options.signal?.aborted) {
      return options.allowPartialOnAbort
        ? { ok: false, ladder: initial, outputContract, output: partialResearchOutput(request, initial, 'before axis searches'), error: RESEARCH_TURN_DEADLINE_STOP_ERROR }
        : { ok: false, ladder: initial, outputContract, output: '', error: 'research aborted' };
    }
    debug.log('research.turn', 'bloom-generated', { questionCount: 6 });
  } catch (error) {
    if (options.signal?.aborted) {
      return {
        ok: false, ladder: initial, outputContract,
        output: options.allowPartialOnAbort ? partialResearchOutput(request, initial, 'question generation') : '',
        error: RESEARCH_TURN_DEADLINE_STOP_ERROR,
      };
    }
    debug.log('research.turn', 'bloom-failed', { reason: errorText(error) }, { level: 'warn' });
    return { ok: false, ladder: initial, outputContract, output: '', error: `question generation failed: ${errorText(error)}` };
  }

  let generated: unknown;
  try {
    generated = JSON.parse(extractJson(raw));
  } catch (error) {
    debug.log('research.turn', 'bloom-validation-failed', { reason: errorText(error) }, { level: 'warn' });
    return { ok: false, ladder: initial, outputContract, output: '', error: `question generation returned invalid JSON: ${errorText(error)}` };
  }
  const parsed = parseSixLevelResearchQuestionLadder(
    withRequest(generated, request), outputContract.sections.map((section) => section.id),
  );
  if (!parsed.ok) {
    debug.log('research.turn', 'bloom-validation-failed', { reason: parsed.reason }, { level: 'warn' });
    return { ok: false, ladder: initial, outputContract, output: '', error: parsed.reason };
  }

  const ladder = parsed.value;
  debug.log('research.turn', 'bloom-ladder-validated', { questionCount: ladder.questions.length });
  debug.log('research.turn', 'deep-bloom-applied', {
    levels: [4, 5], trigger: 'research-intent',
    stage: 'research-ladder',
    questionCount: ladder.questions.filter((question) => question.level === 4 || question.level === 5).length,
  });
  const observedAt = new Date().toISOString();
  let fanout: AxisFanoutResult;
  try {
    fanout = await (options.invokeAxes ?? invokeProductionResearchAxes)(ladder.questions, options.signal, options.admitToolCall);
    if (options.signal?.aborted && !options.allowPartialOnAbort) return { ok: false, ladder, outputContract, output: '', error: 'research aborted' };
    debug.log('research.turn', 'axis-evidence-collected', {
      axisCount: fanout.axes.length,
      evidenceCount: fanout.axes.reduce((count, axis) => count + axis.evidence.length, 0),
    });
  } catch (error) {
    debug.log('research.turn', 'axis-evidence-failed', { reason: errorText(error) }, { level: 'warn' });
    fanout = {
      plan: [],
      axes: ladder.questions.map((question) => ({ questionId: question.id, error: errorText(error), evidence: [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0] ?? question.id,
        ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
        observedAt, content: errorText(error), outcome: 'failed', truncated: false,
      }] })),
    };
  }

  let evidenceRejected = false;
  const sections: string[] = [`# Research: ${request}`, '', `## Output contract\n${ladderContext}`, ''];
  const byQuestion = new Map(fanout.axes.map((axis) => [axis.questionId, axis]));
  for (const question of ladder.questions) {
    const axis = byQuestion.get(question.id);
    const axisEvidence = axis?.evidence ?? [];
    const envelopes: ResearchEvidenceEnvelope[] = axisEvidence.length ? axisEvidence : [{
      questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0] ?? question.id,
      ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
      observedAt, content: axis?.error ?? 'axis evidence missing', outcome: 'failed', truncated: false,
    }];
    const snippets: string[] = [];
    for (const envelope of envelopes) {
      const attached = attachResearchEvidence(ladder, envelope);
      if (!attached.ok) {
        evidenceRejected = true;
        snippets.push(`Evidence rejected: ${attached.reason}`);
        continue;
      }
      ladder.evidence = attached.value.evidence;
      snippets.push(`- [${envelope.outcome}] ${envelope.sourceKind} · ${envelope.source}: ${envelope.content}`);
    }
    sections.push(`## ${question.id} · Bloom ${question.level}: ${question.prompt}`,
      `Search terms: ${question.searchTerms.join(', ')}`,
      ...snippets);
  }

  let finalBoundary = planWorkingBackwardsCompletion(outputContract, ladder.questions, ladder.evidence);
  logCompletionBoundary('axis-fanout', finalBoundary);
  if (finalBoundary.complete) {
    debug.log('research.turn', 'completion-boundary-stop', {
      stage: 'axis-fanout', reason: 'every output-contract section slot is filled',
    });
    debug.log('research.stop', 'stage', {
      stage: 'axis-fanout', reason: 'completion-boundary-satisfied',
      evidenceCount: ladder.evidence.length,
    });
  }
  if (!finalBoundary.complete && !options.signal?.aborted) {
    const followupStartedAt = performance.now();
    const followupInput: ResearchGapFollowupInput = {
      request,
      questions: ladder.questions,
      evidence: ladder.evidence,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let followupPlan: ResearchGapFollowupPlan | undefined;
    if (options.planGapFollowup || !options.gapFollowup) {
      try {
        followupPlan = (options.planGapFollowup ?? planGapFollowup)(followupInput);
        debug.log('research.turn', 'gap-followup-planned', {
          rounds: followupPlan.rounds,
          classifications: followupPlan.classifications.length,
          calls: followupPlan.followups.length,
          elapsedMs: Math.round((performance.now() - followupStartedAt) * 10) / 10,
        });
      } catch (error) {
        debug.log('research.turn', 'gap-followup-plan-failed', {
          reason: errorText(error),
          elapsedMs: Math.round((performance.now() - followupStartedAt) * 10) / 10,
        }, { level: 'warn' });
      }
    }
    if (followupPlan && followupPlan.followups.length === 0) {
      if (followupPlan.classifications.length > 0) {
        sections.push(
          '## Bounded research gap follow-up',
          `Rounds: ${followupPlan.rounds} · budget: ${followupPlan.timeBudgetMs}ms`,
          ...followupPlan.classifications.map((item) => `- ${item.questionId} [${item.action}/${item.reason}]${item.skill ? ` · ${item.skill}` : ''}: ${item.gap}`),
        );
      }
      debug.log('research.turn', 'gap-followup-skipped', {
        reason: 'no-runnable-followup-calls',
        classifications: followupPlan.classifications.length,
        timeBudgetMs: followupPlan.timeBudgetMs,
      });
      debug.log('research.stop', 'stage', {
        stage: 'gap-followup', reason: 'no-runnable-followup-calls',
        classifications: followupPlan.classifications.length,
      });
    } else {
      const executionStartedAt = performance.now();
      debug.log('research.turn', 'gap-followup-started', {
        evidenceCount: ladder.evidence.length,
        completeEvidenceCount: ladder.evidence.filter((item) => item.outcome === 'complete').length,
      });
      try {
        const followup = await (options.gapFollowup ?? runGapFollowup)(followupInput);
        const followupLines = [
          '## Bounded research gap follow-up',
          `Rounds: ${followup.rounds} · budget: ${followup.timeBudgetMs}ms`,
          ...followup.classifications.map((item) => `- ${item.questionId} [${item.action}/${item.reason}]${item.skill ? ` · ${item.skill}` : ''}: ${item.gap}`),
        ];
        for (const envelope of followup.followupEvidence) {
          const attached = attachResearchEvidence(ladder, envelope);
          if (!attached.ok) {
            evidenceRejected = true;
            followupLines.push(`- Evidence rejected: ${attached.reason}`);
            continue;
          }
          ladder.evidence = attached.value.evidence;
          followupLines.push(`- [${envelope.outcome}] ${envelope.sourceKind} · ${envelope.source}: ${envelope.content}`);
        }
        for (const card of followup.discoveryCards ?? []) followupLines.push(card);
        if (followup.classifications.length || followup.followupEvidence.length) sections.push(...followupLines);
        debug.log('research.turn', 'gap-followup-completed', {
          rounds: followup.rounds,
          classifications: followup.classifications.length,
          evidenceCount: followup.followupEvidence.length,
          evidenceAttached: ladder.evidence.length,
          elapsedMs: Math.round((performance.now() - executionStartedAt) * 10) / 10,
        });
        finalBoundary = planWorkingBackwardsCompletion(outputContract, ladder.questions, ladder.evidence);
        logCompletionBoundary('gap-followup', finalBoundary);
        if (finalBoundary.complete) {
          debug.log('research.turn', 'completion-boundary-stop', {
            stage: 'gap-followup', reason: 'every output-contract section slot is filled',
          });
          debug.log('research.stop', 'stage', {
            stage: 'gap-followup', reason: 'completion-boundary-satisfied',
            evidenceCount: ladder.evidence.length,
          });
        }
      } catch (error) {
        debug.log('research.turn', 'gap-followup-failed', {
          reason: errorText(error),
          elapsedMs: Math.round((performance.now() - executionStartedAt) * 10) / 10,
        }, { level: 'warn' });
      }
    }
  }
  if (options.signal?.aborted && !options.allowPartialOnAbort) return { ok: false, ladder, outputContract, output: '', error: 'research aborted' };

  const outputContractSectionIndex = sections.findIndex((section) => section.startsWith('## Output contract\n'));
  if (outputContractSectionIndex < 0) throw new Error('output contract section is missing from research output');
  sections.splice(outputContractSectionIndex + 1, 0,
    formatWorkingBackwardsSkeleton(outputContract, finalBoundary, evidenceRejected));

  // The axis fanout is the last stage allowed to spend the research budget.
  // Once it returns after an abort, keep whatever evidence it collected and
  // return it directly; no post-deadline router/skill stage may discard it or
  // attempt more model work with the already-aborted signal.
  if (options.signal?.aborted && options.allowPartialOnAbort) {
    const partialOutput = sections.join('\n\n');
    saveRetroRecord(request, ladder, ladder.evidence);
    debug.log('research.stop', 'stopped', {
      reason: 'wall-clock-budget', stage: 'after-axis-evidence',
      evidenceCount: ladder.evidence.length,
    });
    return {
      ok: false, ladder, outputContract, output: partialOutput,
      error: RESEARCH_TURN_DEADLINE_STOP_ERROR,
    };
  }

  const incompleteQuestions = ladder.questions.filter((question) =>
    !ladder.evidence.some((item) => item.questionId === question.id && item.outcome === 'complete')).length;
  const allOk = !evidenceRejected && incompleteQuestions === 0;
  debug.log('research.lens', 'verdict', {
    lens: 'working-backwards',
    features: {
      requiredSectionCount: outputContract.sections.length,
      completionCriteriaCount: outputContract.completionCriteria.length,
      questionCount: ladder.questions.length,
      incompleteQuestionCount: incompleteQuestions,
    },
    action: allOk ? 'evidence-ready-for-synthesis' : 'evidence-incomplete',
  });
  const output = sections.join('\n\n');
  let route: ReturnType<typeof routeResearchOutput> | undefined;
  try {
    route = (options.routeOutput ?? routeResearchOutput)({
      question: request,
      synthesizedResult: output,
      axes: ladder.questions.map((question) => `${question.id}: ${question.prompt}`),
    });
  } catch (error) {
    debug.log('research.turn', 'output-router-fallback', { reason: errorText(error) }, { level: 'warn' });
  }
  debug.log('research.turn', 'output-routed', {
    format: route?.format ?? 'text',
    axisCount: route?.observation.axisCount ?? ladder.questions.length,
    selectedSkill: route?.skillCallPlan?.skill,
    fallbackReason: route?.fallbackReason ?? (route ? undefined : 'router-failed'),
  });
  let routedOutput = '';
  const hasCompleteEvidence = ladder.evidence.some((item) => item.outcome === 'complete');
  if (route?.skillCallPlan && options.allowOutputSkill === false) {
    debug.log('research.turn', 'output-skill-skipped', {
      skill: route.skillCallPlan.skill,
      reason: 'research turn tool allowlist excludes skill execution',
      evidenceCount: ladder.evidence.length,
    });
  } else if (route?.skillCallPlan && !hasCompleteEvidence) {
    debug.log('research.turn', 'output-skill-skipped', {
      skill: route.skillCallPlan.skill,
      reason: 'no-complete-evidence',
      evidenceCount: ladder.evidence.length,
    });
  } else if (route?.skillCallPlan) {
    const outputSkillStartedAt = performance.now();
    debug.log('research.turn', 'output-skill-started', {
      skill: route.skillCallPlan.skill,
      evidenceCount: ladder.evidence.length,
      completeEvidenceCount: ladder.evidence.filter((item) => item.outcome === 'complete').length,
    });
    try {
      const formatted = await (options.invokeOutputSkill ?? defaultInvokeOutputSkill)(
        route.skillCallPlan.skill, route.skillCallPlan.args, options.signal,
      );
      if (formatted.ok && formatted.output.trim()) {
        routedOutput = `\n\n## Routed ${route.format} output (${route.skillCallPlan.skill})\n\n${formatted.output.trim()}`;
        debug.log('research.turn', 'output-skill-completed', {
          skill: route.skillCallPlan.skill,
          outputChars: formatted.output.length,
          elapsedMs: Math.round((performance.now() - outputSkillStartedAt) * 10) / 10,
        });
      } else {
        debug.log('research.turn', 'output-skill-fallback', {
          skill: route.skillCallPlan.skill,
          reason: formatted.error ?? 'empty output',
          elapsedMs: Math.round((performance.now() - outputSkillStartedAt) * 10) / 10,
        }, { level: 'warn' });
      }
    } catch (error) {
      debug.log('research.turn', 'output-skill-fallback', {
        skill: route.skillCallPlan.skill,
        reason: errorText(error),
        elapsedMs: Math.round((performance.now() - outputSkillStartedAt) * 10) / 10,
      }, { level: 'warn' });
    }
  }
  saveRetroRecord(request, ladder, ladder.evidence);
  return {
    ok: allOk && !options.signal?.aborted,
    ladder,
    outputContract,
    output: output + routedOutput,
    ...(!allOk || options.signal?.aborted ? { error: options.signal?.aborted ? RESEARCH_TURN_DEADLINE_STOP_ERROR : `${incompleteQuestions} of ${ladder.questions.length} question searches were incomplete` } : {}),
  };
}

async function defaultInvokeOutputSkill(skill: string, args: string, signal?: AbortSignal) {
  const result = await invokeResearch(args, { skill, signal });
  return { ok: result.ok, output: result.output, ...(result.error ? { error: result.error } : {}) };
}

/** Preserve usable partial findings when the grounding seam has only an ok/output contract. */
export function researchTurnForGrounding(result: ResearchQuestionLadderRunResult): ResearchGroundingResult {
  const output = result.output.trim() || result.error || 'Research question ladder failed.';
  return {
    ok: result.ladder.evidence.some((item) => item.outcome === 'complete') && result.output.trim().length > 0,
    output,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function defaultGenerate(prompt: string, usageSite: string, signal?: AbortSignal): Promise<string> {
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    usageSite,
    usagePhase: 'research',
    ...(signal ? { signal } : {}),
  });
}

function withRequest(value: unknown, request: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), request };
}

function extractJson(raw: string): string {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return unfenced.slice(start, end + 1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
