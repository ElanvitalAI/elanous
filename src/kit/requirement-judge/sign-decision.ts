// JUDGE-NOT-OVERSTRICT (11-28) — the sign decision of the requirement-judge kit: doneCriterion ⊕ evidence → sign / refuse ⊕ FUs.
//
// S: #40661 (13:04) put doneCriterion decomposition + an LLM judgment in front of every butler sign. Any doubt refused:
//    «doneCriterion 누락» · «분해 불확실» · «판단 불확실» · «필수 미충족» (the LLM, given only PR facts JSON, says a behavioural
//    clause is «not supported» — it can never be, those facts hold receipts and files, not behaviour). 53 of 137 yellow cells of
//    0.3.39 have no doneCriterion at all; the classify role that ran it is the budget tier (codex gpt-6-luna · reasoning off).
// C: 대표 OPS-RULES §판정·증거 (11-22) «같은 head 영수 + focused exit 0 충분 · 미재현 추론 = FU» ⊕ §33·§35 (11-21) «필수/엣지 분리 ·
//    필수 0 이면 PASS + 엣지 FU». A judgment the LLM layer cannot make is not evidence that a must is unmet.
// Q: how does the LLM keep its one legitimate power — refuse when a real must is unmet — without refusing on doubt?
// A: the baseline (done-when.ts judgeCell: same-head receipt ⊕ focused exit 0 ⊕ no security-4) already counts as «must met».
//    The LLM refuses only with a cited contradiction (verbatim clause ⊕ the evidence ids that show it is not met). Every
//    other doubt — empty criterion · decomposition uncertain · LLM unavailable/forbidden · untrusted judgment · uncited
//    «unmet» — signs on the baseline and files one FU «<cell>-FU» naming the part nobody verified. The policy is YAML
//    (graphs/policies/judging.yaml `baseline` · `refuse_must_unmet_when` · `fallback` · `follow_up`); this file only applies it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  classifyBoardRequirements, decomposeDoneCriterion, judgeLlmRoute, readJudgeLlmPolicy,
  type BoardEvidence, type BoardJudgmentInput, type BoardRequirement, type CriterionDecomposition, type RequirementJudgment, type SplitJudgment,
} from './index.js';

export type FallbackKind = 'empty_criterion' | 'judge_unavailable' | 'decomposition_uncertain' | 'judgment_untrusted' | 'must_unmet_uncited';
export type FallbackAction = 'sign-with-fu' | 'refuse';
export interface JudgingSignPolicy {
  readonly version: string;
  readonly baseline: readonly string[];
  readonly refuse: { readonly gap: 'contradicted'; readonly requires: readonly string[] };
  readonly fallback: Readonly<Record<FallbackKind, FallbackAction>>;
  readonly followUp: {
    readonly id: string; readonly priority: string;
    /** FU-FLOOD (OP 11-28): new FU cells this decision path may create per butler tick — over it the sign waits a tick. */
    readonly maxNewPerTick: number;
    /** Kinds whose unverified part is one evidence line on «<cell>-E4» (appended · created only when absent), not a new «<cell>-FU». */
    readonly foldIntoE4: readonly FallbackKind[];
    readonly titles: { readonly empty_criterion: string; readonly unverified: string; readonly e4: string };
  };
}
/** The 대표 rule as a value — used when judging.yaml is unreadable (a broken policy file must not stop every green). */
export const DEFAULT_SIGN_POLICY: JudgingSignPolicy = {
  version: '1', baseline: ['same-head receipt', 'focused exit 0'],
  refuse: { gap: 'contradicted', requires: ['clause', 'evidence_ids'] },
  fallback: { empty_criterion: 'sign-with-fu', judge_unavailable: 'sign-with-fu', decomposition_uncertain: 'sign-with-fu', judgment_untrusted: 'sign-with-fu', must_unmet_uncited: 'sign-with-fu' },
  followUp: { id: '{cell}-FU', priority: 'P2', maxNewPerTick: 3, foldIntoE4: ['must_unmet_uncited', 'decomposition_uncertain'], titles: {
    empty_criterion: '{cell} — doneCriterion 채우기 (판정 집사가 같은 head 영수 + focused exit 0 으로 서명 · 기준이 비어 있었다)',
    unverified: '{cell} — 판정 미확인 부분 검증: {detail} (서명 근거 = 같은 head 영수 + focused exit 0 · 미재현 추론 = FU)',
    e4: '{cell} — E4 sim/test-universe evidence (green signed on same-head receipt + focused exit 0; 판정 미확인 부분 = 근거 줄)',
  } },
};
const KINDS: readonly FallbackKind[] = ['empty_criterion', 'judge_unavailable', 'decomposition_uncertain', 'judgment_untrusted', 'must_unmet_uncited'];
const policyFile = fileURLToPath(new URL('../../../graphs/policies/judging.yaml', import.meta.url));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v : d);

/** Read the sign policy from judging.yaml (missing sections → the 대표 default for that section). */
export function loadJudgingSignPolicy(path: string = policyFile): JudgingSignPolicy {
  let y: Record<string, unknown>;
  try { const parsed: unknown = parse(readFileSync(path, 'utf8')); if (!isRecord(parsed)) return DEFAULT_SIGN_POLICY; y = parsed; } catch { return DEFAULT_SIGN_POLICY; }
  const fb = isRecord(y.fallback) ? y.fallback : {};
  const fu = isRecord(y.follow_up) ? y.follow_up : {};
  const titles = isRecord(fu.titles) ? fu.titles : {};
  return {
    version: String(y.version ?? DEFAULT_SIGN_POLICY.version),
    baseline: Array.isArray(y.baseline) && y.baseline.every(x => typeof x === 'string') ? y.baseline as string[] : DEFAULT_SIGN_POLICY.baseline,
    refuse: DEFAULT_SIGN_POLICY.refuse, // the refusal bar is not loosenable/tightenable by data: contradicted ⊕ clause ⊕ evidence ids
    fallback: Object.fromEntries(KINDS.map(k => [k, fb[k] === 'refuse' ? 'refuse' : 'sign-with-fu'])) as Record<FallbackKind, FallbackAction>,
    followUp: { id: str(fu.id, DEFAULT_SIGN_POLICY.followUp.id), priority: str(fu.priority, DEFAULT_SIGN_POLICY.followUp.priority),
      maxNewPerTick: typeof fu.max_new_per_tick === 'number' && Number.isInteger(fu.max_new_per_tick) && fu.max_new_per_tick >= 0 ? fu.max_new_per_tick : DEFAULT_SIGN_POLICY.followUp.maxNewPerTick,
      foldIntoE4: Array.isArray(fu.fold_into_e4) ? fu.fold_into_e4.filter((k): k is FallbackKind => (KINDS as readonly unknown[]).includes(k)) : DEFAULT_SIGN_POLICY.followUp.foldIntoE4,
      titles: { empty_criterion: str(titles.empty_criterion, DEFAULT_SIGN_POLICY.followUp.titles.empty_criterion), unverified: str(titles.unverified, DEFAULT_SIGN_POLICY.followUp.titles.unverified),
        e4: str(titles.e4, DEFAULT_SIGN_POLICY.followUp.titles.e4) } },
  };
}

/** mode «cell» = a FU cell (added when absent) · «e4-note» = one evidence line on «<cell>-E4» (the cell is added only when absent). */
export interface SignFollowUp { readonly id: string; readonly title: string; readonly reason: FallbackKind | 'edge'; readonly mode: 'cell' | 'e4-note'; readonly line?: string }
export type SignDecision =
  | { sign: true; basis: 'criterion' | 'baseline'; note: string; semantic: string; followUps: SignFollowUp[]; policyVersion: string; model?: string }
  | { sign: false; why: string; cited: Array<{ clause: string; evidenceIds: string[]; reason: string }>; model?: string };

/** A «must unmet» row that meets the refusal bar: gap contradicted ⊕ a verbatim clause of the requirement ⊕ ≥1 real evidence id. */
export function citedMustGap(row: RequirementJudgment, req: BoardRequirement, evidence: readonly BoardEvidence[]): boolean {
  if (row.classification !== 'must' || row.fulfilled || row.gap !== 'contradicted') return false;
  const clause = (row.clause ?? '').trim();
  if (clause.length < 2 || !req.text.includes(clause)) return false;
  return row.evidenceIds.length > 0 && row.evidenceIds.every(id => evidence.some(e => e.id === id));
}

/** A line written onto another cell's evidence must not cite a PR or a receipt (it would bind / judge that cell). */
export const evidenceSafe = (line: string): string => line.replace(/\s+/gu, ' ').replace(/#(\d)/gu, 'PR $1').replace(/pull\//giu, 'pull ').replace(/PREGATE-GREEN\//gu, 'PREGATE-GREEN ').replace(/\.json\b/giu, ' json');
const fill = (t: string, cell: string, detail = ''): string => t.replaceAll('{cell}', cell).replaceAll('{detail}', detail);
const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const reasonLine: Record<FallbackKind, string> = {
  empty_criterion: 'doneCriterion 비어 있음', judge_unavailable: '판정 LLM 불가', decomposition_uncertain: 'doneCriterion 분해 불확실',
  judgment_untrusted: '판정 불확실', must_unmet_uncited: '필수 미충족 주장에 기준 구절·반대 근거 인용 없음',
};

export interface AssessInput { readonly cellId: string; readonly criterion: string | undefined; readonly evidence: readonly BoardEvidence[] }
export interface AssessDeps {
  /** Present-and-undefined = unavailable (→ fallback); absent = the kit's own LLM. */
  decompose?: ((cellId: string, criterion: string) => Promise<CriterionDecomposition>) | undefined;
  judge?: ((input: BoardJudgmentInput) => Promise<SplitJudgment>) | undefined;
  policy?: JudgingSignPolicy;
  /** Observation only: «provider/model» of the judge the caller's ports call (live: judgeLlmRoute at wake). */
  model?: string;
}

/** doneCriterion ⊕ evidence → the sign decision. Precondition: the baseline holds (judgeCell said «sign»). Never throws. */
export async function assessCriterionForSign(input: AssessInput, deps: AssessDeps = {}): Promise<SignDecision> {
  const policy = deps.policy ?? loadJudgingSignPolicy();
  const decompose = 'decompose' in deps ? deps.decompose : (id: string, c: string) => decomposeDoneCriterion(id, c);
  const judge = 'judge' in deps ? deps.judge : (i: BoardJudgmentInput) => classifyBoardRequirements(i);
  const own = !('decompose' in deps) || !('judge' in deps);
  let route: ReturnType<typeof judgeLlmRoute> | null = null;
  if (own) { try { route = judgeLlmRoute(readJudgeLlmPolicy()); } catch { route = null; } }
  const model = deps.model ?? (route?.ok ? `${route.provider}/${route.model}` : undefined);
  const cell = input.cellId;
  const baselineNote = policy.baseline.join(' + ');
  const fuId = fill(policy.followUp.id, cell);
  const fallback = (kind: FallbackKind, detail: string, extraFus: SignFollowUp[] = []): SignDecision => {
    const why = `${reasonLine[kind]}${detail ? ` (${clip(detail, 160)})` : ''}`;
    if (policy.fallback[kind] === 'refuse') return { sign: false, why, cited: [], ...(model ? { model } : {}) };
    // FU-FLOOD: an uncited «unmet» / an uncertain split is one line on the cell's «-E4» FU (an E4 cell itself keeps «-FU»)
    const fold = policy.followUp.foldIntoE4.includes(kind) && !/-E4$/iu.test(cell);
    const fu: SignFollowUp = fold
      ? { id: `${cell}-E4`, title: fill(policy.followUp.titles.e4, cell), reason: kind, mode: 'e4-note', line: evidenceSafe(`판정 미확인 — ${why} (서명 근거 = ${baselineNote} · 미재현 추론 = FU)`) }
      : { id: fuId, title: kind === 'empty_criterion' ? fill(policy.followUp.titles.empty_criterion, cell) : fill(policy.followUp.titles.unverified, cell, clip(why, 220)), reason: kind, mode: 'cell' };
    const where = fold ? `E4 칸 ${fu.id} 근거 한 줄` : `FU ${fu.id}`;
    return { sign: true, basis: 'baseline', note: `${why} → 기준 증거(${baselineNote})로 서명 · ${where}`, semantic: `doneCriterion policy ${policy.version}: baseline (${baselineNote}) · ${why} → ${where}`,
      followUps: [...extraFus, fu], policyVersion: policy.version, ...(model ? { model } : {}) };
  };
  const criterion = input.criterion?.trim() ?? '';
  if (!criterion) return fallback('empty_criterion', '');
  if (route && !route.ok) return fallback('judge_unavailable', route.why);
  if (!decompose || !judge) return fallback('judge_unavailable', !decompose ? 'no decomposition port' : 'no judgment port');
  let decomposition: CriterionDecomposition;
  try { decomposition = await decompose(cell, criterion); } catch (e) { return fallback('judge_unavailable', e instanceof Error ? e.message : String(e)); }
  if (!decomposition.trusted) return fallback(/unavailable/u.test(decomposition.card.reason) ? 'judge_unavailable' : 'decomposition_uncertain', decomposition.card.reason);
  if (!decomposition.requirements.some(r => r.classification === 'must')) return fallback('decomposition_uncertain', 'no must segment');
  const requirements = decomposition.requirements;
  let judgment: SplitJudgment;
  try { judgment = await judge({ cellId: cell, requirements, evidence: input.evidence }); } catch (e) { return fallback('judge_unavailable', e instanceof Error ? e.message : String(e)); }
  if (!judgment?.trusted) return fallback(judgment && /unavailable/u.test(judgment.card.reason) ? 'judge_unavailable' : 'judgment_untrusted', judgment ? judgment.card.reason : 'no judgment');
  if (!Array.isArray(judgment.requirements) || judgment.requirements.length !== requirements.length) return fallback('judgment_untrusted', 'row count differs');
  const seen = new Set<string>();
  for (const row of judgment.requirements) {
    const req = requirements.find(x => x.id === row.id);
    if (!req || seen.has(row.id) || row.classification !== req.classification || typeof row.fulfilled !== 'boolean' || !Array.isArray(row.evidenceIds) ||
      !row.evidenceIds.every(id => input.evidence.some(e => e.id === id)) || (row.fulfilled && !row.evidenceIds.length)) return fallback('judgment_untrusted', 'row missing or evidence not linked');
    seen.add(row.id);
  }
  const textOf = (id: string) => requirements.find(r => r.id === id)!.text;
  const unmetMust = judgment.requirements.filter(x => x.classification === 'must' && !x.fulfilled);
  const cited = unmetMust.filter(x => citedMustGap(x, requirements.find(r => r.id === x.id)!, input.evidence));
  if (cited.length) {
    return { sign: false, cited: cited.map(x => ({ clause: x.clause!.trim(), evidenceIds: x.evidenceIds, reason: x.reason })), ...(model ? { model } : {}),
      why: `필수 미충족 — ${cited.map(x => `«${clip(x.clause!.trim(), 120)}» · 반대 근거 ${x.evidenceIds.join(',')}: ${clip(x.reason, 160)}`).join(' / ')}` };
  }
  // a trusted split: every independent edge left unmet → its own FU (#40661 · «<cell>-FU-<hash>»)
  const edgeFus: SignFollowUp[] = judgment.requirements.filter(x => x.classification === 'edge' && !x.fulfilled).map(x => {
    const text = textOf(x.id);
    return { id: `${cell}-FU-${createHash('sha256').update(text).digest('hex').slice(0, 8).toUpperCase()}`, title: `${cell} — ${text}`, reason: 'edge' as const, mode: 'cell' as const };
  });
  if (unmetMust.length) return fallback('must_unmet_uncited', unmetMust.map(x => `«${clip(textOf(x.id), 80)}»: ${clip(x.reason, 80)}`).join(' · '), edgeFus);
  return { sign: true, basis: 'criterion', followUps: edgeFus, policyVersion: judgment.policyVersion, ...(model ? { model } : {}),
    note: `doneCriterion 필수 ${requirements.filter(r => r.classification === 'must').length} 충족${edgeFus.length ? ` · 엣지 FU ${edgeFus.length}` : ''}`,
    semantic: `doneCriterion policy ${judgment.policyVersion}: ${judgment.requirements.filter(x => x.fulfilled).map(x => `${x.id}=${x.evidenceIds.join(',')}`).join(' · ')}` };
}
