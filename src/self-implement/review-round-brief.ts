import { readFileSync, readdirSync, statSync } from 'node:fs';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { join } from 'node:path';

export type ReviewFindingKind = 'a' | 'b' | 'c' | 'd' | 'unclassified';
export type ReviewBriefDirection = 'continue' | 'split' | 'partial-land' | 're-ground' | 'decision-card';

export interface ReviewResultFile {
  path: string;
  mtimeMs: number;
  value: Record<string, unknown>;
}

export interface ReviewBriefInput {
  pr: number;
  head: string;
  body: string;
  changedFiles: string[];
  results: ReviewResultFile[];
  /** Explicit, separately attributed PR disposition comments; not saved reviews. */
  comments?: string[];
  /** Files that matched this PR's review-result naming pattern but could not be read. */
  readErrors?: string[];
}

export interface ReviewBriefFinding {
  id: string;
  sourceHead: string;
  text: string;
  kind: ReviewFindingKind;
}

export interface ReviewRoundBrief {
  status: 'ready' | 'unmeasured' | 'stale' | 'disposition-only' | 'unavailable';
  /** Saved reviewed-head evidence versus a PR author's explicit split disposition. */
  source: 'saved-review' | 'pr-disposition' | 'none';
  pr: number;
  head: string;
  rounds: number;
  currentHeadMeasured: boolean;
  reviewedHead?: string;
  reviewedVerdict: string;
  reviewedRx: ReviewBriefDirection;
  goalQuestion: string;
  acceptanceSignal: string[];
  declaredScopeBoundary: string[];
  coreItems: ReviewBriefFinding[];
  totalCoreItems: number;
  omittedCoreItems: number;
  resultPaths: string[];
  priorFindings: ReviewBriefFinding[];
  scopeItems: ReviewBriefFinding[];
  totalScopeItems: number;
  omittedScopeItems: number;
  scopeBoundary: string;
  totalPriorFindings: number;
  omittedPriorFindings: number;
  rx: ReviewBriefDirection;
  reason?: string;
  dispositionEvidence?: string;
  readErrors?: string[];
}

const MAX_CORE_ITEMS = 5;
const MAX_INTENT_ACCEPTANCE_ITEMS = 5;
const MAX_INTENT_SOURCE_PATHS = 3;
const MAX_INTENT_ITEM_CHARS = 400;
export const REVIEW_BRIEF_INTENT_MAX_CHARS = 12_000;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resultPr(value: Record<string, unknown>): number | null {
  const raw = value.pr;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resultHead(value: Record<string, unknown>): string | null {
  const head = asString(value.headCommit) ?? asString(value.reviewedHeadCommit);
  return head && /^[a-f0-9]{12,40}$/i.test(head) ? head.toLowerCase() : null;
}

function findings(value: Record<string, unknown>): string[] {
  if (Array.isArray(value.mustFix) && value.mustFix.every((item) => typeof item === 'string')) {
    return value.mustFix.map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function hasValidFindings(value: Record<string, unknown>): boolean {
  return Array.isArray(value.mustFix) && value.mustFix.every((item) => typeof item === 'string');
}

function section(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingPattern = new RegExp(`^(#{1,3})\\s*(?:${heading})(?:\\s*[—–:-].*)?\\s*$`, 'i');
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return [];
  const level = headingPattern.exec(lines[start]!.trim())?.[1]?.length ?? 2;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const nextHeading = /^(#{1,6})\s+/.exec(line.trim());
    if (nextHeading && nextHeading[1]!.length <= level) break;
    const text = line.replace(/^\s*[-*]\s*/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

function hasPathReference(text: string, changedFiles: readonly string[], body: string): boolean {
  const paths = [...new Set([...changedFiles, ...(body.match(/(?:src|scripts|test|docs)\/[A-Za-z0-9_./-]+/g) ?? [])])];
  return paths.some((path) => path.length > 3 && text.includes(path));
}

export function classifyReviewFinding(text: string, input: Pick<ReviewBriefInput, 'changedFiles' | 'body'>): ReviewFindingKind {
  const lower = text.toLowerCase();
  if (/\b(?:junit|telemetry|observability) evidence\b|\bmissing (?:log|artifact|ledger) evidence\b|관측 증거|장부 증거/.test(lower)) return 'b';
  if (/\b(?:late lease|lease timeout|timeout race|concurrent|concurrency race|parallel ordering)\b|늦은 lease|lease 시간 초과|동시성 경합/.test(lower)) return 'c';
  if (/\b(?:new (?:test|fixture|evidence) path|missing fixture|separate evidence file)\b|새 시험 경로|별도 증거 파일/.test(lower)) return 'd';
  if (hasPathReference(text, input.changedFiles, input.body) && /accept|assert|must|should|verify|contract|criteria|pass|통과|수용|기준|검증/.test(lower)) return 'a';
  return 'unclassified';
}

function parseReviewResultFiles(dir: string, pr: number): { results: ReviewResultFile[]; errors: string[] } {
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { results: [], errors: [] };
    return { results: [], errors: [`${dir}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const suffix = new RegExp(`-${pr}-([a-f0-9]{7,40})\\.json$`, 'i');
  const rows: ReviewResultFile[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const filenameHead = suffix.exec(name)?.[1]?.toLowerCase();
    if (!filenameHead) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const raw = readFileSync(path, 'utf8');
      const value = JSON.parse(raw) as Record<string, unknown>;
      const head = resultHead(value);
      if (resultPr(value) !== pr || value.reviewed !== true || !head || !head.startsWith(filenameHead)) continue;
      rows.push({ path, mtimeMs: stat.mtimeMs, value });
    } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { results: rows, errors };
}

function explicitSplitDisposition(comments: readonly string[], input: ReviewBriefInput): Pick<ReviewRoundBrief, 'coreItems' | 'totalCoreItems' | 'omittedCoreItems' | 'dispositionEvidence'> | null {
  for (const body of [...comments].reverse()) {
    const match = /남은 범위\s*=\s*(.+?)\.\s*r(\d+)\s*상한 초과로 분리(?:[.。\s]|$)/i.exec(body);
    if (!match) continue;
    const round = Number(match[2]);
    if (!Number.isSafeInteger(round) || round < 1) continue;
    const items = match[1]!.split(/\s*[·⊕]\s*/).map((text) => text.trim()).filter(Boolean);
    if (!items.length) continue;
    const all = items.map((text, index) => ({ id: `${input.pr}:pr-disposition:${round}:${index + 1}`, sourceHead: input.head, text, kind: classifyReviewFinding(text, input) }));
    return { coreItems: all.slice(0, MAX_CORE_ITEMS), totalCoreItems: all.length,
      omittedCoreItems: Math.max(0, all.length - MAX_CORE_ITEMS), dispositionEvidence: body };
  }
  return null;
}

export function buildReviewRoundBrief(input: ReviewBriefInput): ReviewRoundBrief {
  const perHead = new Map<string, ReviewResultFile>();
  for (const result of input.results) {
    const head = resultHead(result.value);
    if (!head || resultPr(result.value) !== input.pr || result.value.reviewed !== true || !hasValidFindings(result.value)) continue;
    const prior = perHead.get(head);
    if (!prior || prior.mtimeMs < result.mtimeMs || (prior.mtimeMs === result.mtimeMs && prior.path.localeCompare(result.path) < 0)) perHead.set(head, result);
  }
  const rounds = perHead.size;
  const currentHeadMeasured = perHead.has(input.head.toLowerCase());
  const latest = [...perHead.values()].sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))[0] ?? null;
  const current = currentHeadMeasured ? perHead.get(input.head.toLowerCase())! : latest;
  const sourceHead = current ? resultHead(current.value)! : input.head;
  const orderedHeads = [...perHead.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs || a[1].path.localeCompare(b[1].path));
  const allFindings = orderedHeads.flatMap(([head, result]) => findings(result.value).map((text, index) => ({
    id: `${input.pr}:${head}:mustFix:${index + 1}`, sourceHead: head, text, kind: classifyReviewFinding(text, input),
  })));
  const historicalFindings = allFindings.filter((item) => !currentHeadMeasured || item.sourceHead !== input.head.toLowerCase());
  const prioritizedHistoricalFindings = !currentHeadMeasured && current
    ? [...historicalFindings.filter((item) => item.sourceHead === sourceHead), ...historicalFindings.filter((item) => item.sourceHead !== sourceHead)]
    : historicalFindings;
  const rawFindings = currentHeadMeasured && current ? findings(current.value) : [];
  const resultPaths = current
    ? [current.path, ...orderedHeads.filter(([head]) => head !== sourceHead).map(([, result]) => result.path)]
    : orderedHeads.map(([, result]) => result.path);
  const classified = rawFindings.map((text, index) => ({ id: `${input.pr}:${sourceHead}:mustFix:${index + 1}`, sourceHead, text, kind: classifyReviewFinding(text, input) }));
  const decisionItems = current ? findings(current.value).map((text, index) => ({ id: `${input.pr}:${sourceHead}:mustFix:${index + 1}`, sourceHead, text, kind: classifyReviewFinding(text, input) })) : [];
  // Saved must-fix entries remain core regardless of their suggested FU kind.
  // b/c/d are routing hints; they never erase a reviewer finding.
  const allCoreItems = classified;
  const coreItems = allCoreItems.slice(0, MAX_CORE_ITEMS);
  const decisionScopeItems = decisionItems.filter((item) => item.kind === 'b' || item.kind === 'c' || item.kind === 'd');
  const allScopeItems = currentHeadMeasured ? decisionScopeItems : [];
  const scopeItems = allScopeItems.slice(0, MAX_CORE_ITEMS);
  const scopeKinds = new Set(allScopeItems.map((item) => item.kind));
  const goalQuestion = section(input.body, 'Q')[0] ?? '';
  const acceptanceSignal = section(input.body, 'A');
  const declaredScopeBoundary = section(input.body, '(?:경계|범위 경계|scope boundary|boundary)');
  const verdict = typeof current?.value.verdict === 'string' ? current.value.verdict.toLowerCase() : '';
  const reviewedRx: ReviewBriefDirection = input.readErrors?.length ? 'decision-card' : decisionItems.length > 0
    ? 'continue'
    : ['pass', 'warn'].includes(verdict) && acceptanceSignal.length > 0 ? 'partial-land' : 'decision-card';
  const unresolvedHistoricalCore = !currentHeadMeasured && historicalFindings.length > 0;
  const rx: ReviewBriefDirection = input.readErrors?.length ? 'decision-card' : currentHeadMeasured ? reviewedRx : unresolvedHistoricalCore ? 'continue' : 'decision-card';
  const candidateDisposition = !input.readErrors?.length && !unresolvedHistoricalCore ? explicitSplitDisposition(input.comments ?? [], input) : null;
  const dispositionRound = candidateDisposition ? Number(/r(\d+)\s*상한 초과로 분리/i.exec(candidateDisposition.dispositionEvidence ?? '')?.[1]) : 0;
  const disposition = candidateDisposition && (!currentHeadMeasured || (Number.isSafeInteger(dispositionRound) && rounds >= dispositionRound))
    ? candidateDisposition : null;
  const scopeBoundary = disposition
    ? currentHeadMeasured
      ? 'PR 작성자의 상한 분리 처분 — 저장된 현재 head must-fix는 core에 그대로 남긴다'
      : 'PR 작성자가 분리한 남은 범위 — 저장된 현재 head 리뷰의 판정으로 취급하지 않는다'
    : scopeKinds.size
      ? `${[...scopeKinds].sort().join('·')} 항목은 FU 후보로 기록하고 주인·칸을 별도 지정한다 · 이 분류만으로 must-fix 를 제거하지 말 것`
      : '분리할 b·c·d 항목 없음 — 미분류 항목은 핵심 검토에 남긴다';
  const status = input.readErrors?.length ? 'unavailable' : disposition && !currentHeadMeasured ? 'disposition-only' : rounds === 0 ? 'unmeasured' : !currentHeadMeasured ? 'stale' : 'ready';
  return {
    status, source: disposition && !currentHeadMeasured ? 'pr-disposition' : rounds ? 'saved-review' : 'none', pr: input.pr, head: input.head,
    rounds, currentHeadMeasured, ...(current ? { reviewedHead: sourceHead } : {}), reviewedVerdict: currentHeadMeasured && !input.readErrors?.length ? verdict || 'unknown' : 'unknown', reviewedRx, goalQuestion, acceptanceSignal, declaredScopeBoundary,
    coreItems: !currentHeadMeasured && disposition ? disposition.coreItems : coreItems, totalCoreItems: !currentHeadMeasured && disposition ? disposition.totalCoreItems : allCoreItems.length, omittedCoreItems: !currentHeadMeasured && disposition ? disposition.omittedCoreItems : Math.max(0, allCoreItems.length - coreItems.length),
    resultPaths, priorFindings: prioritizedHistoricalFindings.slice(0, MAX_CORE_ITEMS),
    totalPriorFindings: historicalFindings.length, omittedPriorFindings: Math.max(0, historicalFindings.length - MAX_CORE_ITEMS),
    scopeItems, totalScopeItems: allScopeItems.length, omittedScopeItems: Math.max(0, allScopeItems.length - scopeItems.length), scopeBoundary, rx: disposition ? 'split' : rx, ...(disposition ? { dispositionEvidence: disposition.dispositionEvidence } : {}),
    ...(status === 'unmeasured' ? { reason: '저장되고 reviewed=true인 리뷰 결과가 없어 라운드를 측정할 수 없습니다' } : {}),
    ...(status === 'stale' ? { reason: '저장 리뷰에 현재 PR head가 없어 현재 라운드의 must-fix를 측정할 수 없습니다' } : {}),
    ...(status === 'unavailable' ? { reason: '리뷰 결과 파일을 모두 읽지 못해 라운드 판정을 사용할 수 없습니다', readErrors: input.readErrors } : {}),
  };
}

export function loadReviewRoundBrief(input: { pr: number; head: string; body: string; changedFiles: string[]; comments?: string[]; reviewResultsDir?: string }): ReviewRoundBrief {
  const dir = input.reviewResultsDir ?? join(effectiveInstanceRoot(), 'review-results');
  const parsed = parseReviewResultFiles(dir, input.pr);
  return buildReviewRoundBrief({ ...input, results: parsed.results, readErrors: parsed.errors });
}

export function reviewBriefEvidence(brief: ReviewRoundBrief, runId?: string): Record<string, unknown> {
  const intentBlock = renderReviewBriefIntentBlock(brief);
  return {
    pr: brief.pr, head: brief.head, round: brief.rounds, rounds: brief.rounds, source: brief.source,
    verdict: brief.currentHeadMeasured ? brief.reviewedVerdict : 'unknown',
    ...(brief.reviewedHead ? { reviewedHead: brief.reviewedHead } : {}),
    key: `${brief.pr}:${brief.head}:${brief.rounds}`, rx: brief.rx,
    coreItems: brief.totalCoreItems, scopeItems: brief.totalScopeItems,
    ...(intentBlock ? { intentBlock } : {}),
    status: brief.status, ...(brief.dispositionEvidence ? { dispositionEvidence: brief.dispositionEvidence } : {}),
    ...(brief.reason ? { reason: brief.reason } : {}), ...(runId ? { runId } : {}),
  };
}

/** Shadow addendum for a future R3 self-review; this function does not alter the live review path. */
export function renderReviewBriefIntentBlock(brief: ReviewRoundBrief): string | null {
  if (brief.status === 'unavailable' || brief.source !== 'saved-review' || brief.rounds < 2 || !brief.reviewedHead) return null;
  const shorten = (text: string) => text.length > MAX_INTENT_ITEM_CHARS ? `${text.slice(0, MAX_INTENT_ITEM_CHARS - 1)}…` : text;
  const paths = brief.resultPaths.slice(0, MAX_INTENT_SOURCE_PATHS).map(shorten);
  const essential = [
    `런 닥터 brief · PR #${brief.pr} · ${brief.currentHeadMeasured ? 'current' : 'prior'} head ${brief.reviewedHead.slice(0, 12)} · current PR head ${brief.head.slice(0, 12)} · rounds=${brief.rounds} · verdict=${brief.reviewedVerdict} · rx=${brief.rx}`,
    ...(brief.goalQuestion ? [`원래 질문: ${shorten(brief.goalQuestion)}`] : []),
    ...(brief.acceptanceSignal.length ? [
      '원래 수용 신호:',
      ...brief.acceptanceSignal.slice(0, MAX_INTENT_ACCEPTANCE_ITEMS).map((item) => `- ${shorten(item)}`),
      ...(brief.acceptanceSignal.length > MAX_INTENT_ACCEPTANCE_ITEMS ? [`수용 신호 ${brief.acceptanceSignal.length - MAX_INTENT_ACCEPTANCE_ITEMS}개 생략`] : []),
    ] : []),
    ...(brief.declaredScopeBoundary.length ? [
      '명시적 범위 경계:',
      ...brief.declaredScopeBoundary.slice(0, MAX_INTENT_ACCEPTANCE_ITEMS).map((item) => `- ${shorten(item)}`),
      ...(brief.declaredScopeBoundary.length > MAX_INTENT_ACCEPTANCE_ITEMS ? [`범위 경계 ${brief.declaredScopeBoundary.length - MAX_INTENT_ACCEPTANCE_ITEMS}개 생략`] : []),
    ] : []),
    '저장된 must-fix (FU 분류도 삭제하지 않음):', ...(brief.coreItems.length ? brief.coreItems.map((item) => `- [${item.kind} · ${item.id}] ${shorten(item.text)}`) : [brief.currentHeadMeasured ? '- 현재 head의 must-fix 없음' : `- 현재 PR head 미측정 · 선택한 reviewed head ${brief.reviewedHead?.slice(0, 12) ?? 'unknown'}의 finding은 아래에 표시`]),
    ...(brief.omittedCoreItems ? [`${brief.omittedCoreItems}개 생략: 핵심 must-fix`] : []),
    ...(!brief.currentHeadMeasured && brief.totalPriorFindings > 0 ? [`실제 처방: 현재 head 리뷰 전까지 과거 미해결 must-fix를 유지하고 계속 진행 (${brief.rx})`] : []),
    `의도적 스코프 경계: ${brief.scopeBoundary}`,
  ];
  const optional = [
    `과거 라운드 검토 항목 (${brief.priorFindings.length}/${brief.totalPriorFindings}, head별 저장 결과):`, ...(brief.priorFindings.length ? brief.priorFindings.map((item) => `- [${item.kind} · ${item.id}] ${shorten(item.text)}`) : ['- 저장된 must-fix 없음']),
    ...(brief.omittedPriorFindings ? [`과거 finding ${brief.omittedPriorFindings}개 생략`] : []),
    `FU 후보 (${brief.scopeItems.length}/${brief.totalScopeItems}):`, ...(brief.scopeItems.length ? brief.scopeItems.map((item) => `- [${item.kind} · ${item.id}] ${shorten(item.text)}`) : ['- 현재 head에서 분류된 FU 후보 없음']),
    ...(brief.omittedCoreItems ? [`핵심 항목 ${brief.omittedCoreItems}개 추가 생략`] : []),
    ...(brief.omittedScopeItems ? [`FU 후보 ${brief.omittedScopeItems}개 생략`] : []),
    ...(brief.resultPaths.length ? [`리뷰 원문 파일 (${paths.length}/${brief.resultPaths.length}): ${paths.join(', ')}`,
      ...(brief.resultPaths.length > MAX_INTENT_SOURCE_PATHS ? [`원문 파일 ${brief.resultPaths.length - MAX_INTENT_SOURCE_PATHS}개 생략`] : [])] : []),
  ];
  const lines = [...essential];
  const sourceReference = brief.resultPaths.length
    ? `참고 원문 (${paths.length}/${brief.resultPaths.length}): ${paths.join(', ')}${brief.resultPaths.length > MAX_INTENT_SOURCE_PATHS ? ` · ${brief.resultPaths.length - MAX_INTENT_SOURCE_PATHS}개 생략` : ''}`
    : '';
  let omitted = 0;
  for (const line of optional) {
    if (lines.join('\n').length + line.length + 1 + sourceReference.length + 101 <= REVIEW_BRIEF_INTENT_MAX_CHARS) lines.push(line);
    else omitted++;
  }
  if (omitted) lines.push(`보조 내용 ${omitted}줄 생략`);
  if (sourceReference) lines.push(sourceReference);
  return lines.join('\n');
}
