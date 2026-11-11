// ── 적응형 디깅 grounding 사다리 (PLAN-adaptive-grounding-ladder · G1 · 2026-07-14) ──
//
// 대표 지시: "판단 인프라가 1순위 — 관측성·자기인지·힐링. grounding 도 적응형 해상도 조절형으로
// 상황 따라 디깅." arc1 reconcile false-negative(grounding miss — 문서만 읽고 실구현 못 봄)의 뿌리 =
// 얕은 단발 grounding. 이 엔진은 "이 증거로 판정 가능?"을 self-assess 하고 부족하면 해상도를 한 칸씩
// 올린다: skim(grep+헤더) → read(전문) → git(이력·배선) → verify(호출부·dead-code) → external(스텁).
//
// 한 엔진, 네 소비자: 골(A6-a assessGoalShape)·아크정의(A7-L2 preflight)·아크실행(A7-L3 verify)·
// 페이즈(#4128 noop). 판정 고도는 넷, 판정 깊이는 이 엔진 하나(직교축).
//
// 제1원칙: 무엇을 어디까지 팠나 debug.log('mission.grounding'). fail-soft — 티어 오류는 스킵(다음으로).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { debug } from '../../debug/log.js';
import { grokAgentSearch } from '../../grok/agent-search.js';
import { getGrokApiKey } from '../../config.js';

const execFileAsync = promisify(execFile);

/** 사다리 티어(싼 것 → 깊은 것). external 은 G1 스텁(G3 실구현). */
export const GROUNDING_TIERS = ['skim', 'read', 'git', 'verify', 'external'] as const;
export type GroundingTier = (typeof GROUNDING_TIERS)[number];
export type Confidence = 'high' | 'medium' | 'low';

export interface GroundingResult {
  /** 누적 증거 컨텍스트(판정기 프롬프트에 fold). */
  context: string;
  /** 실독·언급한 파일. */
  files: string[];
  /** 자기인지 — 판정 신뢰도. */
  confidence: Confidence;
  /** confidence !== 'low' && 실증거 확보 — 소비자가 unverified(못 봄) vs unmet(깨짐) 구분. */
  grounded: boolean;
  /** 실제 밟은 티어(관측·감사). */
  tiersUsed: GroundingTier[];
  /** ★ skim 티어(groundMissionInCodebase)가 찾은 skill 계약/코드 심볼 팩트(2026-07-21) — 종전 ladder 가
   *  드롭해 소비처(arc-preflight mirage 판정·redesign)가 skill 재사용을 못 보고 허상 오탐·재사용 미인지. carry. */
  skillFacts?: string[];
  codeFacts?: string[];
}

/** ★ AA4 외부 완성 증거 (RFC-autonomous-act·미션 phase 7·외부 수습·claude-code 2026-07-16). GroundingResult
 *  를 재사용해 "외부(main 머지 등)가 이 범위를 완성했다"를 정규화. complete 는 출처+grounded+범위 일치
 *  일 때만 true(허위 완성 차단). 순수·결정론. */
export interface ExternalCompletion {
  complete: boolean;
  /** 완성 증거 출처(PR #·main SHA 등). 없으면 미인정. */
  source: string | null;
  /** GroundingResult.grounded 재사용 — 근거 충분. */
  grounded: boolean;
  /** 인정/미인정 근거 요약. */
  evidence: string;
}

/** ★ AA5 재사용경계 (RFC-autonomous-act·phase 7). 외부 완성 증거의 적용 범위·신선도를 후속 phase/arc
 *  에 손실 없이 전달. stale/expired 는 결정론적. */
export interface ReuseBoundary {
  /** 적용 가능 범위(파일·심볼) — GroundingResult.files 재사용. */
  scope: string[];
  /** 신선도 — fresh(적용 가능) vs stale(범위 밖·미완성). */
  freshness: 'fresh' | 'stale';
  reason?: string;
}

/**
 * ★ 외부 완성 정규화 (AA4·phase 7·외부 수습). GroundingResult + 외부 증거 출처를 받아 완성 여부를
 * **순수 판정**. 출처 없음·grounded=false·요청 범위가 grounding 파일과 불일치 → 미완성(허위 완성 차단).
 */
export function normalizeExternalCompletion(
  g: Pick<GroundingResult, 'grounded' | 'files'>,
  input: { source: string | null; claimedScope: string[] },
): ExternalCompletion {
  const scopeCovered = input.claimedScope.length > 0
    && input.claimedScope.every((s) => g.files.some((f) => f.includes(s) || s.includes(f)));
  const complete = g.grounded && !!input.source && scopeCovered;
  return {
    complete, source: input.source, grounded: g.grounded,
    evidence: complete ? `외부 완성 인정 — 출처 ${input.source}·범위 일치·grounded`
      : !input.source ? '출처 없음 — 미인정'
      : !g.grounded ? 'grounding 부족 — 미인정(허위 완성 방지)'
      : '범위 불일치 — 미인정',
  };
}

/**
 * ★ 재사용경계 도출 (AA5·phase 7·외부 수습). 외부 완성 증거의 적용 범위·신선도를 결정론적으로 반환.
 * 미완성이거나 범위 비면 stale.
 */
export function deriveReuseBoundary(
  completion: ExternalCompletion,
  g: Pick<GroundingResult, 'files'>,
): ReuseBoundary {
  if (!completion.complete) return { scope: [], freshness: 'stale', reason: completion.evidence };
  if (g.files.length === 0) return { scope: [], freshness: 'stale', reason: '적용 범위 비어 있음' };
  return { scope: g.files, freshness: 'fresh' };
}

export interface GroundingDeps {
  /** T1 skim. The fabric supplies its own codebase-grounding adapter. */
  ground?: (q: string) => Promise<{ grounded: boolean; context: string; files: string[]; skillFacts?: string[]; codeFacts?: string[] }>;
  /** Optional keyword provider for the fabric adapter that owns the skim implementation. */
  searchTerms?: (goal: string) => Promise<string[]>;
  /** Fabric-owned lower-level grounding dependencies (for deterministic callers/tests). */
  codebaseGrounding?: {
    cwd?: string;
    seedPaths?: string[];
    persistent?: false;
    skillIndex?: () => never[];
    pickSkills?: () => Promise<never[]>;
    recallMemory?: () => never[];
    recallSelf?: () => Promise<never[]>;
    refDigest?: () => string;
    listCapsules?: () => never[];
  };
  /** T2 read — 파일 전문 실독(기본 실 fs). */
  readFiles?: (files: string[], repoRoot: string) => string;
  /** T3 git — 이력·배선(기본 git log/-S). */
  gitProbe?: (files: string[], symbols: string[], repoRoot: string) => Promise<string>;
  /** T4 verify — 심볼 호출부(기본 git grep). export-only dead-code 판별. */
  callSites?: (symbols: string[], repoRoot: string) => Promise<string>;
  /** T5 external — 외부조사(G1 스텁·기본 ''). */
  research?: (q: string) => Promise<string>;
  /** 자기인지 LLM(기본 sol). 미주입(test)이면 휴리스틱 폴백. */
  assess?: (prompt: string) => Promise<string>;
  repoRoot?: string;
  /** 최대 티어(1~5·기본 4=verify까지·external 제외). */
  maxTier?: number;
}

export function isImplementationFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  if (!/\.(ts|tsx|js|mjs|cjs|kt|kts|swift|py|sh|bash)$/.test(normalized)) return false;
  if (normalized.includes('.test.')) return false;
  if (/(?:^|\/)src\/test(?:\/|$)/.test(normalized) || /Test\.kt$/.test(normalized)) return false;
  if (/(?:^|\/)[^/]*Tests(?:\/|$)/.test(normalized) || /Tests\.swift$/.test(normalized)) return false;
  return true;
}

/** T2 — 파일 전문(파일당 ~200줄·최대 8파일). skim 헤더보다 깊다. */
function defaultReadFiles(files: string[], repoRoot: string): string {
  const parts: string[] = [];
  for (const f of files.slice(0, 8)) {
    try {
      const body = readFileSync(join(repoRoot, f), 'utf-8').split('\n').slice(0, 200).join('\n');
      parts.push(`### ${f}\n${body}`);
    } catch { /* 접근 실패 스킵 */ }
  }
  return parts.join('\n\n');
}

/** T3 — git 이력: 파일 최근 커밋 + 심볼 도입 이력(-S). "코드는 있는데 언제·어떻게 배선됐나". */
async function defaultGitProbe(files: string[], symbols: string[], repoRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const f of files.filter(isImplementationFile).slice(0, 5)) {
    try {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5', '--', f], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 2_000_000 });
      if (stdout.trim()) parts.push(`### git log ${f}\n${stdout.trim()}`);
    } catch { /* 스킵 */ }
  }
  for (const s of symbols.slice(0, 3)) {
    try {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-3', '-S', s, '--', 'src', 'scripts'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 2_000_000 });
      if (stdout.trim()) parts.push(`### git log -S ${s}(도입/변경 커밋)\n${stdout.trim()}`);
    } catch { /* 스킵 */ }
  }
  return parts.join('\n\n');
}

/** T4 — 심볼 호출부: 정의 외 사용처가 있나(export-only dead-code 판별의 핵심). */
async function defaultCallSites(symbols: string[], repoRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const s of symbols.slice(0, 5)) {
    try {
      const { stdout } = await execFileAsync('git', ['grep', '-n', '-w', s, '--', 'src', 'scripts'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 4_000_000 });
      const lines = stdout.split('\n').filter(Boolean);
      const callers = lines.filter((l) => !/\b(export\s+(async\s+)?(function|const|class|interface|type))\b/.test(l) && !l.includes('.test.'));
      parts.push(`### ${s} — 참조 ${lines.length}건(정의 외 호출부 ${callers.length}건${callers.length === 0 ? ' ⚠️export-only 의심' : ''})\n${callers.slice(0, 6).map((l) => l.slice(0, 160)).join('\n')}`);
    } catch { parts.push(`### ${s} — 참조 0건 ⚠️(미사용/미배선 의심)`); }
  }
  return parts.join('\n\n');
}

/**
 * T5 — 외부조사(Grok web_search·G3·2026-07-14). 낯선 API·라이브러리·개념을 웹에서 확인. grok 키 없으면
 * 스킵(''). ★ 이건 "우리 코드"가 아닌 외부 일반 지식 — grounded(impl 실독) 를 올리지 않고 판단 보조만.
 * 대표 지시(G3·grok websearch 재사용). grokAgentSearch 는 never-throw(키 없음·네트워크 오류=빈 결과).
 */
async function defaultResearch(query: string): Promise<string> {
  if (!getGrokApiKey()) return '';
  const r = await grokAgentSearch(query, { tools: ['web_search'], maxOutputTokens: 1500 });
  if (!r.ok || !r.text.trim()) return '';
  const cites = r.citations.slice(0, 4).map((c) => `- ${c.url}`).join('\n');
  return `(외부 일반 지식 — 우리 코드 아님·판단 보조만)\n${r.text.slice(0, 1500)}${cites ? `\n출처:\n${cites}` : ''}`;
}

/** 심볼 후보 추출(camelCase/PascalCase 식별자 3자+) — git -S·호출부용. 순수. */
export function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([a-z][a-zA-Z0-9]{3,}|[A-Z][a-zA-Z0-9]{3,})\b/g)) {
    const w = m[1]!;
    if (/[A-Z]/.test(w.slice(1)) || /^[A-Z]/.test(w)) out.add(w); // camelCase 또는 PascalCase 만
  }
  return [...out].slice(0, 12);
}

function buildAssessPrompt(query: string, acceptance: string[], evidence: string, curTier: GroundingTier): string {
  return [
    '역할: grounding 충분성 자기평가기. 아래 "판정 대상"을 아래 "수집 증거"로 **지금 자신 있게 판정할 수 있나**.',
    `현재까지 판 티어: ${curTier}. 남은 사다리: skim→read→git→verify→external(깊어질수록 비쌈).`,
    'confidence: high=충분(멈춤) · medium=대체로 되나 한 티어 더 유익 · low=불충분(더 파야 함).',
    'nextTier: 더 필요하면 어느 티어를 팔지(read|git|verify|external). 건너뛰기 가능(예: 코드는 봤고 배선만 궁금 → verify).',
    '핵심: 구현이 실재하는지 + 실제로 배선(호출)됐는지를 코드 근거로 확인했으면 high. 문서만 봤으면 low.',
    '',
    `## 판정 대상(질의)\n${query.slice(0, 500)}`,
    `## 완료 기준\n${acceptance.length ? acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n') : '(명시 없음)'}`,
    '',
    `## 수집 증거\n${evidence.slice(0, 6000)}`,
    '',
    'JSON 한 줄만: {"confidence":"high|medium|low","nextTier":"read|git|verify|external|none","why":"한 줄"}',
  ].join('\n');
}

/** 자기인지 응답 파싱. 실패 → medium(보수적 진행). 순수. */
export function parseAssess(raw: string, curTierIdx: number): { confidence: Confidence; nextTierIdx: number | null } {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { confidence: 'medium', nextTierIdx: curTierIdx + 1 };
    const o = JSON.parse(m[0]) as { confidence?: unknown; nextTier?: unknown };
    const confidence: Confidence = o.confidence === 'high' || o.confidence === 'low' ? o.confidence : 'medium';
    let nextTierIdx: number | null = null;
    if (confidence !== 'high') {
      const ni = typeof o.nextTier === 'string' ? GROUNDING_TIERS.indexOf(o.nextTier as GroundingTier) : -1;
      nextTierIdx = ni > curTierIdx ? ni : curTierIdx + 1; // 지목이 유효(더 깊음)하면 점프, 아니면 +1
    }
    return { confidence, nextTierIdx };
  } catch { return { confidence: 'medium', nextTierIdx: curTierIdx + 1 }; }
}

async function defaultAssess(prompt: string): Promise<string> {
  const { streamRoleLlm } = await import('../../llm/role-stream.js');
  return streamRoleLlm('research', [{ role: 'user', content: prompt }], () => {}, { reasoningEffort: 'low' });
}

/** LLM assess 없을 때(test·미주입) 휴리스틱 — impl 파일 읽었고 호출부 티어까지 갔으면 high. */
function heuristicConfidence(files: string[], tiersUsed: GroundingTier[]): Confidence {
  const impl = files.some(isImplementationFile);
  if (!impl) return 'low'; // 문서만 → 못 봄
  if (tiersUsed.includes('verify') || tiersUsed.includes('git')) return 'high';
  return 'medium';
}

async function gatherTier(
  tier: GroundingTier, query: string,
  ctx: { seedFiles?: string[]; symbols?: string[] },
  curFiles: string[], deps: GroundingDeps, repoRoot: string,
): Promise<{ context: string; files: string[]; skillFacts?: string[]; codeFacts?: string[] }> {
  try {
    if (tier === 'skim') {
      const g = deps.ground
        ? await deps.ground(query)
        : { grounded: false, context: '', files: [] };
      // ★ skillFacts/codeFacts carry(2026-07-21) — 종전 {context,files} 만 반환해 skill 계약·코드 심볼 팩트를
      //   드롭했다(소비처가 skill 재사용을 못 봐 mirage 오탐). skim 이 유일하게 이 팩트를 가진 티어.
      return { context: g.context, files: g.files, ...(g.skillFacts?.length ? { skillFacts: g.skillFacts } : {}), ...(g.codeFacts?.length ? { codeFacts: g.codeFacts } : {}) };
    }
    if (tier === 'read') {
      const targets = [...new Set([...(ctx.seedFiles ?? []), ...curFiles])];
      return { context: (deps.readFiles ?? defaultReadFiles)(targets, repoRoot), files: targets };
    }
    if (tier === 'git') {
      return { context: await (deps.gitProbe ?? defaultGitProbe)(curFiles, ctx.symbols ?? [], repoRoot), files: [] };
    }
    if (tier === 'verify') {
      return { context: await (deps.callSites ?? defaultCallSites)(ctx.symbols ?? [], repoRoot), files: [] };
    }
    // external(G3) — Grok web_search 실배선. 외부 지식은 grounded 안 올림(판단 보조만).
    return { context: await (deps.research ?? defaultResearch)(query), files: [] };
  } catch (e) {
    debug.log('mission.grounding', 'tier-error', { tier, error: e instanceof Error ? e.message.slice(0, 100) : '' }, { level: 'error' });
    return { context: '', files: [] };
  }
}

/**
 * 적응형 디깅 grounding. query 를 얕게 grounding 하고, self-assess 로 부족하면 해상도를 올린다.
 * ctx.seedFiles = 선언 증거(reuseBoundaries·페이즈 파일참조) — grounding miss 방지 핵심.
 * fail-soft — 티어 오류는 스킵. LLM assess 미주입 시 휴리스틱(impl 파일 유무).
 */
export async function adaptiveGround(
  query: string,
  ctx: { seedFiles?: string[]; acceptance?: string[]; symbols?: string[] } = {},
  deps: GroundingDeps = {},
): Promise<GroundingResult> {
  const repoRoot = deps.repoRoot ?? process.cwd();
  // 기본 maxTier=5(external 도달 가능·G3). 단 external 은 self-assess 가 명시 지목할 때만(비쌈·정말
  //   필요시). env ELANOUS_GROUNDING_MAX_TIER=4 로 외부조사 끄기(내부만). 예산 가드=에스컬레이트 상한 3.
  const envMax = Number(process.env.ELANOUS_GROUNDING_MAX_TIER);
  const maxTierIdx = Math.min(Math.max((deps.maxTier ?? (Number.isFinite(envMax) ? envMax : 5)) - 1, 0), GROUNDING_TIERS.length - 1);
  const symbols = ctx.symbols ?? extractSymbols(`${query}\n${(ctx.acceptance ?? []).join('\n')}\n${(ctx.seedFiles ?? []).join('\n')}`);
  const parts: string[] = [];
  const filesSet = new Set<string>(ctx.seedFiles ?? []);
  const tiersUsed: GroundingTier[] = [];
  let skillFacts: string[] = [];   // skim 티어가 실은 팩트 — 최종 반환에 carry(소비처 mirage/재사용 판정용)
  let codeFacts: string[] = [];
  let confidence: Confidence = 'low';
  let tierIdx = 0;
  let escalations = 0;
  const MAX_ESCALATIONS = 3;

  while (tierIdx >= 0 && tierIdx <= maxTierIdx && escalations <= MAX_ESCALATIONS) {
    const tier = GROUNDING_TIERS[tierIdx]!;
    const g = await gatherTier(tier, query, { seedFiles: ctx.seedFiles, symbols }, [...filesSet], deps, repoRoot);
    if (g.context.trim()) parts.push(`## [${tier}]\n${g.context}`);
    for (const f of g.files) filesSet.add(f);
    if (g.skillFacts?.length) skillFacts = g.skillFacts;   // skim 티어만 보유 — 최신값 carry
    if (g.codeFacts?.length) codeFacts = g.codeFacts;
    tiersUsed.push(tier);

    const files = [...filesSet];
    const assess = deps.assess ?? (process.env.NODE_ENV === 'test' ? undefined : defaultAssess);
    let nextTierIdx: number | null;
    if (!assess) {
      confidence = heuristicConfidence(files, tiersUsed);
      nextTierIdx = confidence === 'high' ? null : tierIdx + 1;
    } else {
      let raw = '';
      try { raw = await assess(buildAssessPrompt(query, ctx.acceptance ?? [], parts.join('\n\n'), tier)); } catch { /* fail-soft */ }
      const a = parseAssess(raw, tierIdx);
      confidence = a.confidence;
      nextTierIdx = a.nextTierIdx;
    }
    debug.log('mission.grounding', tier, { confidence, tiersUsed: [...tiersUsed], files: files.slice(0, 6), escalations });
    if (confidence === 'high' || nextTierIdx == null) break;
    const clamped = Math.min(nextTierIdx, maxTierIdx); // 지목이 maxTier 초과면 상한(제일 깊게 허용)까지.
    if (clamped <= tierIdx) break; // 상한 도달·역행 → 더 못 판다·정지.
    escalations += 1;
    tierIdx = clamped;
  }

  const files = [...filesSet];
  const grounded = confidence !== 'low' && files.some(isImplementationFile);
  return { context: parts.join('\n\n'), files, confidence, grounded, tiersUsed, ...(skillFacts.length ? { skillFacts } : {}), ...(codeFacts.length ? { codeFacts } : {}) };
}
