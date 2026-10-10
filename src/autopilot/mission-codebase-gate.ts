// ── 미션 내부 grounding 게이트 — 기존 코드/문서 검증 (대표 지시 2026-07-12) ──────
//
// 구현·변경·분석형 미션은 외부 웹조사(omni-crawl)만으로 부족하다. elanous 는 방대한 기존
// 코드(특히 Conatus/finance: trade-*·signal-*·asset-attractiveness)·문서를 보유 → 골 관련
// 기존 파일을 실제로 grep 해서 분해 컨텍스트에 주입해야 환각 파일명·중복 구현을 막는다.
// 외부조사(research=횡단능력)와 대칭인 "내부 grounding=횡단능력". 대부분 도메인에 적용
// (순수 단발 조회만 제외). fail-soft — 실패해도 분해는 진행(grounded:false).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetModel } from '../llm/model-defaults.js';
import { getSkillIndex, type SkillIndexEntry } from '../skills/index.js';
import { searchMemories } from '../memory.js';
import { debug } from '../debug/log.js';
import { localRefGroundingDigest } from '../agent/ref-grounding.js';
import { listContextCapsules } from '../self-implement/context-capsule-store.js';
import type { HarnessContextCapsule } from '../self-implement/context-capsule.js';
import { isRepositoryImplementationCandidate, type DocumentGroundingMatch } from './codebase-grounding.js';
import { registerGoalAuthorGroundMission } from '../self-implement/goal-author.js';
export { isRepositoryImplementationCandidate } from './codebase-grounding.js';
export type CodebaseGrounding = import('./codebase-grounding.js').CodebaseGrounding;
export type { DocumentGroundingMatch, PersistentGroundingEvidenceItem } from './codebase-grounding.js';
import { groundPersistently, type PersistentGroundingDeps } from '../skills/tools/persistent-grounding.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import { llmUsageCostFields } from '../budget/llm-cost.js';

const execFileAsync = promisify(execFile);

function logLlmUsage(site: 'codebase-gate-injected' | 'codebase-gate-dynamic', model: string, usage: LLMUsage): void {
  try {
    debug.log('llm.usage', 'llm-usage', {
      site,
      model,
      ...(usage.provider !== undefined && { provider: usage.provider }),
      ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
      ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
      ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
      ...llmUsageCostFields(model, usage),
    });
  } catch { /* usage observation must not change grounding */ }
}

/** 구현·변경·분석형 골 판정 — 기존 자산을 다루는 미션(순수 단발 조회 제외). 순수함수(테스트). */
export function isImplementationGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  const impl = /구현|만들|설계|개발|고치|수정|리팩토|리팩터|추가|개선|검토|분석|이관|배선|통합|복원|재편|바꿔|변경|정리|점검|migrat|implement|build|refactor|fix|add|analyz|integrat|design|develop|clean|audit/.test(g);
  if (impl) return true;
  const pureQuery = /알려줘|뭐야|얼마|보여줘|조회|현황|목록|리스트|status|list|show|what is|how much/.test(g);
  return !pureQuery && goal.length > 20; // 애매하면 길이로(짧은 단문=조회 경향)
}

export type SearchTermFn = (goal: string) => Promise<string[]>;

type SearchTermsLlmClient = {
  resolveDefaultProvider: (model?: string) => ReturnType<typeof import('../llm.js').resolveDefaultProvider> | undefined;
  streamLLM: typeof import('../llm.js').streamLLM;
};

/** luna 로 골 → 코드 검색 키워드(영문 식별자·도메인 명사). 실패 시 골에서 영문 토큰 추출. */
export async function defaultSearchTerms(
  goal: string,
  llmClient?: SearchTermsLlmClient,
): Promise<string[]> {
  const fallback = Array.from(new Set(goal.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])).slice(0, 8);
  const llmGoal = goal.slice(0, 500);
  debug.log('grounding.search', 'terms-input-truncated', {
    goalChars: goal.length,
    llmGoalChars: llmGoal.length,
    truncatedChars: goal.length - llmGoal.length,
  });
  try {
    const client = llmClient ?? await import('../llm.js');
    const model = budgetModel();
    const provider = client.resolveDefaultProvider(model);
    const prompt =
      'Given a software mission goal (Korean or English), output 6-12 code search keywords to find ' +
      'EXISTING related code/docs in this repo: English identifiers, module names, domain nouns ' +
      '(e.g. memory, decay, archive, consolidate, session, surface-events, signal, trade). ' +
      'Comma-separated, lowercase, no explanation.\n\n' +
      `Goal: ${llmGoal}\nKeywords:`;
    let full = '';
    await client.streamLLM([{ role: 'user', content: prompt }], (_d, all) => { full = all; }, {
      model,
      ...(provider ? { provider } : {}),
      onUsage: (usage) => logLlmUsage('codebase-gate-injected', model, usage),
    });
    const terms = full.split(/[,\n]/).map((s) => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((t) => t.length >= 3);
    return terms.length ? Array.from(new Set(terms)).slice(0, 12) : fallback;
  } catch (error) {
    debug.log('grounding.search', 'terms-llm-fallback', {
      fallbackSource: 'full-goal',
      fallbackTerms: fallback.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/** 하이픈 복합어는 원본의 변별력을 보존하면서 각 구성 토큰도 검색한다. */
export function expandHyphenatedSearchTerms(terms: string[]): string[] {
  return Array.from(new Set(terms.flatMap((term) => [term, ...term.split('-').filter(Boolean)])));
}

/** 낱말 안쪽 문자 — **하이픈을 포함**한다. ⛔ 하이픈을 경계로 치면 `research-and-development` 가
 *  식별자 `and` 에 걸려 *"일반 하이픈 복합어는 식별자가 아니다"* 라는 이 함수의 계약이 깨진다.
 *  ⛔⭐ **결합 문자(`\p{M}`)도 낱말 문자다**(리뷰 2R must-fix) — 빼면 `run◌́ning` 의 결합 부호가
 *  경계로 읽혀 낱말 안쪽 오탐이 그대로 남는다. **아래 토큰 정규식과 반드시 같은 집합**이어야 한다. */
const IDENTIFIER_WORD_CHAR = /[\p{L}\p{M}\p{N}_-]/u;

/** 토큰 분해 — ⛔ `IDENTIFIER_WORD_CHAR` 와 **같은 낱말 문자 집합**에 경로 구분자(`.`/`/`)만 더한다.
 *  두 규칙이 어긋나면 한쪽이 자른 자리를 다른 쪽이 안 잘라 **같은 오탐이 다른 문으로 들어온다**. */
const IDENTIFIER_TOKEN = /[\p{L}\p{M}\p{N}_./-]+/gu;

/** `indexOf` 는 **UTF-16 코드 단위** 인덱스를 준다. 그 자리에서 `s[i]` 를 읽으면 보충 평면 문자
 *  (예: `𐐀`)의 **서로게이트 반쪽**이 나오고, 반쪽은 `\p{L}` 이 아니라 **낱말 경계로 오판**된다
 *  (리뷰 1R must-fix). ⇒ 인접 문자는 **코드포인트 단위**로 읽는다. */
function codePointBefore(haystack: string, at: number): string {
  if (at <= 0) return '';
  const unit = haystack.charCodeAt(at - 1);
  // 낮은 서로게이트면 그 앞의 **높은** 서로게이트까지 합쳐 한 문자로 읽는다.
  // ⛔ 앞이 실제로 높은 서로게이트인지 확인한다(리뷰 3R should-fix) — 비정상 UTF-16(고립 서로게이트)
  //   에서 엉뚱한 앞 문자를 붙여 읽으면 경계를 오판한다.
  const isLow = unit >= 0xDC00 && unit <= 0xDFFF;
  const lead = at >= 2 ? haystack.charCodeAt(at - 2) : 0;
  const paired = isLow && lead >= 0xD800 && lead <= 0xDBFF;
  const start = paired ? at - 2 : at - 1;
  return String.fromCodePoint(haystack.codePointAt(start)!);
}

function codePointAt(haystack: string, at: number): string {
  if (at >= haystack.length) return '';
  return String.fromCodePoint(haystack.codePointAt(at)!);
}

/** `needle` 이 `haystack` 안에 **낱말 통째로** 나타나는가. 앞뒤가 낱말 문자면 매치가 아니다. */
function containsAsWholeWord(haystack: string, needle: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = codePointBefore(haystack, at);
    const after = codePointAt(haystack, at + needle.length);
    if (!IDENTIFIER_WORD_CHAR.test(before) && !IDENTIFIER_WORD_CHAR.test(after)) return true;
    from = at;
  }
}

/** Ask 안에서 실제 저장소 자산으로 확인 가능한 식별자를 찾는다. 일반 하이픈 복합어는 식별자가 아니다.
 *
 * ⛔⭐ **종전 판정은 `normalized.includes(candidate)` = 부분문자열이었다**(`GOAL-S12`). 식별자 집합은
 * 매칭된 파일·문서 **경로를 3자 이상 조각으로 쪼갠 전부**라 `run`·`and` 같은 잡음 조각이 들어오고,
 * 그것이 **`long-run·ning`** · **`c-and-idates`** 안에서 걸렸다. ⇒ 저작기의 *"일반 검색 범위"* 경고가
 * 조용히 꺼지고, 그 경고를 검사하는 테스트가 **저장소가 자랄 때마다 뒤집혔다**(`PATTERNS.md` F9 —
 * 실측 대조군: `#6228` 직전 `1 pass 0 fail` / 이후 `0 pass 1 fail`).
 * ⇒ **낱말 경계**로 판정한다. 경로 안의 식별자(`src/goal-author.ts` 의 `goal-author`)는 앞뒤가
 * `/`·`.` 이라 그대로 걸리고, 낱말 안쪽(`long-running` 의 `run`)은 안 걸린다. */
export function hasRepositorySpecificIdentifier(goal: string, identifiers: readonly string[] = ['elanous']): boolean {
  const normalized = goal.toLowerCase();
  const tokens: string[] = normalized.match(IDENTIFIER_TOKEN) ?? [];
  return identifiers.some((identifier) => {
    const candidate = identifier.trim().toLowerCase();
    return candidate.length >= 3 && (tokens.includes(candidate) || containsAsWholeWord(normalized, candidate));
  });
}

/** git grep 으로 키워드 매칭 구현 파일(src·scripts) 상위 N. 랭킹은 **distinct term coverage**
 *  (서로 다른 키워드가 겹치는 파일 = 진짜 관련)가 핵심 — 흔한 단어(session 등) 하나만 걸린
 *  무관 파일을 밀어낸다. + 파일명 히트 + 내용 히트 + src(구현코드) 우선. 저장소 문서는
 *  `searchRepositoryDocuments`로 별도 참조 컨텍스트에 보존한다. term 별 git grep. */
export async function searchCodebase(terms: string[], limit = 12, cwd?: string): Promise<string[]> {
  return searchRepository(terms, limit, cwd, ['src', 'scripts'], ['src', 'docs', 'scripts']);
}

/** 저장소 문서는 구현 후보와 분리해 참조 컨텍스트로만 반환한다. */
export async function searchRepositoryDocuments(terms: string[], limit = 12, cwd?: string): Promise<string[]> {
  return (await searchRepositoryDocumentsWithMatches(terms, limit, cwd)).map(({ path }) => path);
}

/** 문서 후보의 검색 점수·매칭 검색어·본문 구절을 저작기까지 보존한다. */
export async function searchRepositoryDocumentsWithMatches(terms: string[], limit = 12, cwd?: string): Promise<DocumentGroundingMatch[]> {
  if (!terms.length) return [];
  const paths = ['docs'];
  const counts = new Map<string, Map<string, number>>();
  const excerpts = new Map<string, string>();
  await Promise.all(terms.map(async (term) => {
    try {
      const { stdout } = await execFileAsync('git', ['grep', '-n', '-i', '-I', '-e', term, '--', ...paths], { ...(cwd ? { cwd } : {}), encoding: 'utf-8', maxBuffer: 8_000_000 });
      for (const row of stdout.split('\n').filter(Boolean)) {
        const first = row.indexOf(':');
        const second = row.indexOf(':', first + 1);
        if (first < 1 || second < 0) continue;
        const path = row.slice(0, first);
        if (path.includes('.test.')) continue;
        const matched = counts.get(path) ?? new Map<string, number>();
        matched.set(term, (matched.get(term) ?? 0) + 1);
        counts.set(path, matched);
        if (!excerpts.has(path)) excerpts.set(path, row.slice(second + 1).replace(/\s+/g, ' ').trim().slice(0, 180));
      }
    } catch { /* git grep exits 1 when a term has no matches. */ }
  }));
  return [...counts].map(([path, matched]) => {
    const matchedTerms = [...matched.keys()];
    const occurrences = [...matched.values()].reduce((total, count) => total + count, 0);
    return { path, score: matchedTerms.length * 10 + Math.min(occurrences, 15), matchedTerms, excerpt: excerpts.get(path) ?? '' };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** 흔한 term도 반복 매칭이면 약한 coverage 신호로 남긴다. 로그 감쇠는 1회 우연 히트를
 * 작게 유지하면서 반복된 주제어를 구분하고, 상한 0.5는 흔한 term 하나가 정상 coverage를
 * 대체하지 못하게 한다. */
export function commonTermCoverageWeight(matchLines: number): number {
  return Math.min(0.5, Math.log2(Math.max(matchLines, 0) + 1) / 8);
}

async function searchRepository(terms: string[], limit: number, cwd: string | undefined, paths: string[], commonPaths = paths): Promise<string[]> {
  if (!terms.length) return [];
  const fileTerms = new Map<string, Set<string>>(); // file → 매칭된 서로 다른 term
  const fileLines = new Map<string, number>();       // file → 총 매칭 라인 수
  const fileTermLines = new Map<string, Map<string, number>>(); // file → term별 매칭 라인 수
  const tooCommon = new Set<string>();               // 200+ 파일 매칭 = 밀도 감쇠 대상
  const trackedPaths = await execFileAsync('git', ['ls-files', '--', ...paths], { ...(cwd ? { cwd } : {}), encoding: 'utf-8', maxBuffer: 8_000_000 })
    .then(({ stdout }) => stdout.split('\n').filter(Boolean))
    .catch(() => [] as string[]);
  const pathMatches = new Map(terms.map((term) => [term, trackedPaths.filter((file) => file.toLowerCase().includes(term)).length]));
  // term별 git grep 을 병렬 실행(순차 spawnSync ~16초 → 병렬 ~2초). git grep=현재 워킹트리
  // 파일 검색(history 아님)·gitignore/바이너리 자동 제외. 호출자가 코드와 문서를 분리한다.
  const perTerm = await Promise.all(terms.map(async (t) => {
    try {
      // -c: file:count. -i 무시·-I 바이너리제외. term 하나씩(어느 term 이 걸렸는지 추적).
      const { stdout } = await execFileAsync('git', ['grep', '-c', '-i', '-I', '-e', t, '--', ...paths], { ...(cwd ? { cwd } : {}), encoding: 'utf-8', maxBuffer: 8_000_000 });
      const rows = stdout.split('\n').filter(Boolean);
      const commonRows = commonPaths === paths ? rows : await execFileAsync('git', ['grep', '-c', '-i', '-I', '-e', t, '--', ...commonPaths], { ...(cwd ? { cwd } : {}), encoding: 'utf-8', maxBuffer: 8_000_000 })
        .then(({ stdout }) => stdout.split('\n').filter(Boolean))
        .catch(() => [] as string[]);
      return { t, rows, commonCount: commonRows.length };
    } catch { return { t, rows: [] as string[], commonCount: 0 }; } // git grep no-match = exit 1(throw) → 빈 결과
  }));
  for (const { t, rows, commonCount } of perTerm) {
    if (commonCount > 200) {
      tooCommon.add(t);
      debug.log('grounding.search', 'term-too-common', { term: t, files: commonCount, keptInCandidates: true });
    }
    for (const row of rows) {
      const sep = row.lastIndexOf(':');
      const file = sep > 0 ? row.slice(0, sep) : row;
      if (!file || file.includes('.test.')) continue;
      const cnt = Number(row.slice(sep + 1)) || 0;
      if (!fileTerms.has(file)) fileTerms.set(file, new Set());
      fileTerms.get(file)!.add(t);
      fileLines.set(file, (fileLines.get(file) ?? 0) + cnt);
      const termLines = fileTermLines.get(file) ?? new Map<string, number>();
      termLines.set(t, cnt);
      fileTermLines.set(file, termLines);
    }
  }
  const scored = [...fileTerms].map(([f, ts]) => {
    const termLines = fileTermLines.get(f);
    const cover = [...ts].reduce((total, term) => total + (tooCommon.has(term)
      ? commonTermCoverageWeight(termLines?.get(term) ?? 0)
      : 1), 0);
    const nameTerms = terms.filter((t) => f.toLowerCase().includes(t));
    const nameWeight = nameTerms.reduce((total, term) => {
      const matches = pathMatches.get(term) ?? 0;
      // 경로상 유일한 식별자는 강한 +25를 유지하고, 공유 조각은 매칭 경로 수에 반비례해 감쇠한다.
      const weight = Math.max(1, Math.round(25 / Math.sqrt(Math.max(matches, 1))));
      debug.log('grounding.search', 'name-signal', { term, file: f, common: tooCommon.has(term), pathMatches: matches, weight });
      return total + weight;
    }, 0);
    const src = f.startsWith('src/') ? 1 : 0;                            // 구현 코드 우선
    return { f, score: cover * 10 + nameWeight + Math.min(fileLines.get(f) ?? 0, 15) + src * 3 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.f);
}

export type SkillIndexFn = () => SkillIndexEntry[];

/** luna 매칭 seam(테스트 우회). null=실패(→결정론 fallback)·[]=관련 skill 없음(존중). */
export type SkillPickFn = (goal: string, index: SkillIndexEntry[], limit: number) => Promise<string[] | null>;

/** ★ luna 로 골 의도 ↔ skill 능력 의미매칭(주경로·2026-07-21 luna 승격). 결정론 substring 은 영어term↔한글
 *  description·오타·동의어에 취약(라이브: "digram" 오타로 diagram-master 미매칭·skill 1개만) → 의미판단은
 *  luna 로(도메인판정 luna 승격 #4810 과 동형). closed set(목록 밖 이름 폐기)=mirage 차단. 실패/파싱불가 →
 *  null(호출측 결정론 fallback), 명시적 NONE → [](관련없음 존중). */
export async function pickSkillsViaLlm(goal: string, index: SkillIndexEntry[], limit: number): Promise<string[] | null> {
  try {
    const model = budgetModel();
    const { streamLLM, resolveDefaultProvider } = await import('../llm.js');
    const provider = resolveDefaultProvider(model);
    const catalog = index.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 110)}`).join('\n');
    const prompt =
      'Select reusable skills for a software mission. From the SKILL LIST, pick those whose capability is ' +
      `directly relevant to reuse for the goal (max ${limit}). Match by MEANING, not keyword overlap ` +
      '(the goal and descriptions may be Korean; tolerate typos and synonyms). Output ONLY skill names taken ' +
      'verbatim from the list, comma-separated. If none apply, output exactly NONE.\n\n' +
      `GOAL: ${goal.slice(0, 500)}\n\nSKILL LIST:\n${catalog}\n\nRelevant skill names:`;
    let full = '';
    await streamLLM([{ role: 'user', content: prompt }], (_d, all) => { full = all; }, {
      model,
      ...(provider ? { provider } : {}),
      onUsage: (usage) => logLlmUsage('codebase-gate-dynamic', model, usage),
    });
    const valid = new Set(index.map((s) => s.name.toLowerCase()));
    const picked = full.split(/[,\n]/).map((s) => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter((n) => valid.has(n));                       // closed set — 인덱스 내 skill 만(mirage 차단)
    if (picked.length) return Array.from(new Set(picked)).slice(0, limit);
    return /\bnone\b/i.test(full) ? [] : null;            // NONE=관련없음([]) · 그 외 빈결과=파싱실패(null→fallback)
  } catch { return null; }
}

/** 결정론 substring fallback(luna 실패 시·무회귀 안전망) — term coverage + 골의 skill명 직접언급. terms 는
 *  영어라 대부분 한글인 description 과 "youtube" 정도만 겹치므로 골 CJK/라틴 토큰도 termSet 에 더한다. */
function substringMatchSkills(terms: string[], goal: string, index: SkillIndexEntry[], limit: number): SkillIndexEntry[] {
  const g = goal.toLowerCase();
  const goalTokens = g.split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (/[\p{sc=Hangul}\p{sc=Han}]/u.test(t) ? t.length >= 2 : t.length >= 3));
  const termSet = Array.from(new Set([...terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3), ...goalTokens]));
  return index.map((s) => {
    const hay = `${s.name} ${s.description} ${s.triggers.join(' ')} ${s.extractedTriggers.join(' ')}`.toLowerCase();
    const cover = new Set(termSet.filter((t) => hay.includes(t))).size;
    const nameForms = [s.name.toLowerCase(), s.name.replace(/-/g, ' ').toLowerCase()];
    const named = nameForms.some((n) => n.length >= 4 && g.includes(n)) ? 1 : 0;
    return { s, score: cover + named * 5 };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.s);
}

/** ★ 미션 skill grounding (P1·2026-07-20·luna 승격 2026-07-21) — 골이 가리키는 재사용 가능 skill 의
 *  `SKILL.md`+계약 팩트를 반환. grounding 이 레포 코드(git grep)만 보던 사각 수복. **luna 의미매칭이 주경로**
 *  (골/설명 한글·오타·동의어라 결정론 substring 붕괴), 실패 시 substring fallback. fail-soft.
 *  [[PLAN-reasoning-corpus-unification-2026-07-20]]. */
export async function groundMissionInSkills(
  terms: string[],
  goal: string,
  deps: { skillIndex?: SkillIndexFn; pickSkills?: SkillPickFn } = {},
  limit = 8,   // luna 의미매칭 상위 N(2026-07-21: 5→8 — 관련 skill 을 넉넉히 담아 재현율↑·특수 튜닝 없이)
): Promise<{ files: string[]; lines: string[]; facts: string[] }> {
  try {
    const index = (deps.skillIndex ?? getSkillIndex)();
    if (!index.length) return { files: [], lines: [], facts: [] };
    // 1) luna 의미매칭(주경로) — null=실패(fallback)·[]=관련 skill 없음(존중).
    const picked = await (deps.pickSkills ?? pickSkillsViaLlm)(goal, index, limit);
    let chosen: SkillIndexEntry[];
    if (picked === null) {
      chosen = substringMatchSkills(terms, goal, index, limit);   // 2) 결정론 fallback(무회귀)
    } else {
      const byName = new Map(index.map((s) => [s.name.toLowerCase(), s] as const));
      chosen = picked.map((n) => byName.get(n)).filter((s): s is SkillIndexEntry => !!s);
    }
    const files = chosen.map((s) => join(s.skillDir, 'SKILL.md'));
    const lines = chosen.map((s) =>
      `- ${join(s.skillDir, 'SKILL.md')}: [skill:${s.name}] ${s.description.replace(/\s+/g, ' ').slice(0, 120)}`);
    // ★ L3(워킹메모리 플러스·2026-07-20) — 경로만이 아니라 **계약 팩트 자체**(description=능력 요약)를
    //   `[skill:name] <계약>` 팩트로 → build seed decisions 로 carry → PLAN.md 에 내용이 직접 뜸(구현
    //   에이전트가 Read 안 해도 핵심 계약 보유). [[project_historian_working_memory_debuglog_governance_2026_07_20]].
    const facts = chosen.map((s) => `[skill:${s.name}] ${s.description.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    return { files, lines, facts };
  } catch { return { files: [], lines: [], facts: [] }; }
}

/** P2 회상 seam(테스트 우회) — 선언 기억(searchMemories)·자기이력+문서벡터(dispatchSelfRecall). */
export type RecallMemoryFn = (query: string, limit: number) => string[];
export type RecallSelfFn = (query: string, limit: number) => Promise<string[]>;
/** 로컬 reference repository digest seam. 미주입 시 `~/source/ref`를 탐색하는 기본 digest를 쓴다. */
export type RefDigestFn = (goal: string) => string;

export function refFactsFromDigest(digest: string): string[] {
  // ★ F2(README 메타 소비 완성·2026-07-22) — localRefGroundingDigest 는 `- /path` 아래 `참조 이유:` 등 rich
  //   메타(README 파싱)를 붙이는데, 종전엔 path 만 뽑고 이유를 버려 executor 가 "왜 관련 repo 인지"를 못 받았다.
  //   이제 각 repo 의 뒤따르는 `참조 이유:` 줄을 캡처해 `[ref:name] path — <이유>` 로 보존한다(F1 렌더와 짝).
  const facts: string[] = [];
  const seen = new Set<string>();
  let curIdx = -1;   // 직전 push 한 fact 인덱스(뒤따르는 이유 줄을 붙일 대상)
  for (const line of digest.split('\n')) {
    const trimmed = line.trim();
    const path = trimmed.replace(/^-\s*/, '').trim();
    const name = path.split('/').filter(Boolean).pop();
    if (trimmed.startsWith('- ') && path.startsWith('/') && name && !seen.has(name)) {
      facts.push(`[ref:${name}] ${path}`);
      seen.add(name);
      curIdx = facts.length - 1;
    } else if (curIdx >= 0) {
      const reason = trimmed.match(/^참조\s*이유:\s*(.+)$/);
      if (reason) { facts[curIdx] += ` — ${reason[1]!.trim()}`; curIdx = -1; }   // 이유 1회 부착 후 리셋
    }
  }
  return facts;
}

/** 선언 기억(user/feedback/project/reference) 회상 → `[memory:type] name: desc` 팩트. 읽기전용 파일 store. */
function defaultRecallMemory(query: string, limit: number): string[] {
  try {
    return searchMemories(query, { limit }).map((h) =>
      `[memory:${h.entry.type}] ${h.entry.name}: ${h.entry.description.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  } catch { return []; }
}

/** 자기 구현이력(surface_events domain=elanous) + 문서벡터(knowledge.db·HANDOFF/REPORT/PLAN) 회상 →
 *  `[self:kind]`·`[doc]` 팩트. dispatchSelfRecall 재사용(db 라이프사이클·임베딩 fail-soft 내장·db 없으면 no-op). */
async function defaultRecallSelf(query: string, limit: number): Promise<string[]> {
  try {
    const { dispatchSelfRecall } = await import('../domains/self-awareness-tool.js');
    const r = (await dispatchSelfRecall({ query, limit })) as { events?: Array<{ kind?: string; summary?: string }>; docs?: string | null };
    const out: string[] = [];
    for (const e of (r.events ?? []).slice(0, limit)) {
      if (e.summary) out.push(`[self:${e.kind ?? 'impl'}] ${String(e.summary).replace(/\s+/g, ' ').trim().slice(0, 140)}`);
    }
    if (r.docs) out.push(`[doc] ${String(r.docs).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    return out;
  } catch { return []; }
}

/** ★ 미션 기억·문서 grounding (P2·2026-07-21) — 검색공간을 레포코드+skill 너머 **선언기억·자기이력·문서벡터**로
 *  확장. 제1원칙 3박자(로그+메모리+문서)의 메모리·문서 축. ⚠️ **불변식**: 이 히트는 **참조 컨텍스트(사실 배경)**
 *  로만 쓰고 **파일 실존 주장(files/reusables)로 쓰지 않는다** — 옛 파일 지목이 새 mirage 를 유발하지 않게(mirage
 *  가드=실존검증 유지). 팩트 `[memory:type]`/`[self:kind]`/`[doc]` prefix → decisions carry(경로 아님·내용). fail-soft.
 *  [[PLAN-reasoning-corpus-unification-2026-07-20]] §3 P2. */
export async function groundMissionInMemory(
  goal: string,
  deps: { recallMemory?: RecallMemoryFn; recallSelf?: RecallSelfFn } = {},
  limit = 5,
): Promise<{ facts: string[] }> {
  const [mem, self] = await Promise.all([
    Promise.resolve().then(() => (deps.recallMemory ?? defaultRecallMemory)(goal, limit)).catch(() => [] as string[]),
    (deps.recallSelf ?? defaultRecallSelf)(goal, limit).catch(() => [] as string[]),
  ]);
  return { facts: [...mem, ...self] };
}

/** ★ L4 — 파일의 export 심볼명 추출(순수-ish·정규식). decompose 가 재사용할 실제 계약(함수/타입/클래스).
 *  선언형 export(function/const/class/interface/type/enum) + `export { a, b }` re-export. 상위 max 개. */
export function extractExportedSymbols(path: string, max = 12, cwd?: string): string[] {
  try {
    const src = readFileSync(cwd ? join(cwd, path) : path, 'utf-8');
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (n: string): void => { const s = n.trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
    // 선언형: export [async] function|const|let|class|interface|type|enum NAME
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm)) push(m[1]!);
    // 이름있는 re-export/export 목록: export { a, b as c }
    for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z0-9_$]+$/.test(name)) push(name);
      }
    }
    return out.slice(0, max);
  } catch { return []; }
}

/** 파일 헤더(첫 주석/설명 몇 줄) — 무슨 파일인지 한 줄 요약. */
function fileHeader(path: string, cwd?: string): string {
  try {
    const lines = readFileSync(cwd ? join(cwd, path) : path, 'utf-8').split('\n').slice(0, 8);
    const cmt = lines
      .filter((l) => /^\s*(\/\/|\*|#|>|---)/.test(l))
      .map((l) => l.replace(/^\s*(\/\/|\*|#|>|-)+\s?/, '').trim())
      .filter(Boolean);
    return cmt.join(' ').slice(0, 120) || (lines.find((l) => l.trim())?.slice(0, 80) ?? '');
  } catch { return ''; }
}

/** 골/capsule 텍스트 토큰화 — 소문자 영숫자(2자+)·한글(2자+). 관련도 overlap 용. */
function tokenizeForRelevance(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{2,}|[가-힣]{2,}/g) ?? []));
}

/** capsule 관련도 — 골 토큰과 objective+successCriteria+inScope 토큰 overlap 수. */
function capsuleRelevance(goalTokens: Set<string>, capsule: HarnessContextCapsule): number {
  const capTokens = tokenizeForRelevance([capsule.objective, ...capsule.successCriteria, ...capsule.inScope].join(' '));
  let n = 0;
  for (const t of goalTokens) if (capTokens.has(t)) n++;
  return n;
}

/** F2 검색-코퍼스 dep seam(테스트 주입용). */
export interface CapsuleGroundingDeps {
  listCapsules?: () => Array<{ id: string; capsule: HarnessContextCapsule }>;
}

/**
 * ★ F2 검색-코퍼스(2026-07-25·대표 아이디어) — 상류 PTY 잡 capsule 을 grounding 소스로 검색한다. 골 관련도
 * (토큰 overlap) + 최근성(createdAt desc)으로 상위 limit. 하류 잡이 **dependsOn 없이** 관련 상류 산출을
 * grounding 으로 자동 발견(§11 컨텍스트 교환의 검색-코퍼스 실현). 관련도 0(무관)은 제외 → grounding 오염 방지.
 * 참조 컨텍스트로만(files 승격 아님·mirage 가드 동형). fail-soft(실패=빈 팩트).
 */
export async function groundMissionInCapsules(
  goal: string, deps: CapsuleGroundingDeps = {}, limit = 3,
): Promise<{ facts: string[] }> {
  try {
    const list = (deps.listCapsules ?? listContextCapsules)();
    if (!list.length) return { facts: [] };
    const goalTokens = tokenizeForRelevance(goal);
    // ⚠️관련도를 **전체 후보 대상으로 먼저** 필터한다(MF2 수정) — 최근성으로 먼저 자르면 무관한 신규 capsule 이
    //   쌓였을 때 오래됐지만 관련된 handoff 가 영구 누락된다. 임계 ≥2(1토큰 우연겹침 노이즈 차단·skill grounding
    //   동형) → 관련도·최근성 순 → 상위 limit. perf 상한은 listContextCapsules 의 하드캡(backstop)에 위임.
    //   config-dir 격리로 prod/test·인스턴스 경계는 분리(프로젝트-태그 스코핑은 후속).
    const scored = [...list]
      .map((e) => ({ ...e, score: capsuleRelevance(goalTokens, e.capsule) }))
      .filter((e) => e.score >= 2)
      .sort((a, b) => b.score - a.score || b.capsule.createdAt.localeCompare(a.capsule.createdAt))
      .slice(0, Math.max(0, limit));
    return {
      facts: scored.map((e) =>
        `[pty:${e.id}] ${e.capsule.objective} — 완료기준: ${e.capsule.successCriteria.slice(0, 3).join('; ')}`.slice(0, 200),
      ),
    };
  } catch { return { facts: [] }; }
}

/** ★ 미션 내부 grounding — 골 관련 기존 코드/문서를 실제 grep 해 분해 컨텍스트로 반환.
 *  환각 파일명·중복 구현 방지. fail-soft(실패=grounded:false·분해는 그대로 진행). */
/**
 * 코퍼스 유무 판정 — **근거가 실릴 수 있는 모든 채널**을 본다. 순수.
 *
 * ⛔ 불변식: 채널이 하나라도 비지 않으면 grounded 다. 특히 `skillFacts` 를 빼면 **스킬 계약만 있는
 * 골이 미grounded** 가 된다(`SKILL.md` 경로는 `files` 에 안 실리므로 그 근거는 여기에만 남는다).
 * ⚠️ 순수 함수로 분리한 이유: 집계기를 통째로 부르면 문서 채널이 거의 항상 비지 않아
 * 개별 채널의 기여를 테스트가 못 가른다.
 */
export function isCorpusGrounded(corpus: {
  files: readonly unknown[]; documentFacts: readonly unknown[]; skillFacts: readonly unknown[];
  memoryFacts: readonly unknown[]; refFacts: readonly unknown[]; ptyFacts: readonly unknown[];
}): boolean {
  return corpus.files.length > 0 || corpus.documentFacts.length > 0 || corpus.skillFacts.length > 0
    || corpus.memoryFacts.length > 0 || corpus.refFacts.length > 0 || corpus.ptyFacts.length > 0;
}

export async function groundMissionInCodebase(
  goal: string, deps: { cwd?: string; seedPaths?: readonly string[]; searchTerms?: SearchTermFn; skillIndex?: SkillIndexFn; pickSkills?: SkillPickFn; recallMemory?: RecallMemoryFn; recallSelf?: RecallSelfFn; refDigest?: RefDigestFn; persistent?: PersistentGroundingDeps | false } & CapsuleGroundingDeps = {},
): Promise<CodebaseGrounding> {
  // 호출자가 준 root를 모든 저장소 채널과 corpus 관측에 공유한다. 미지정 호출은 기존처럼 프로세스 cwd를 쓴다.
  const cwdSource = deps.cwd === undefined ? 'process' : 'caller';
  const searchRoot = deps.cwd ?? process.cwd();
  const startedAt = performance.now();
  let searchTermsElapsedMs = 0;
  let persistentElapsedMs = 0;
  let corpusElapsedMs = 0;
  let renderingElapsedMs = 0;
  const observeTiming = () => {
    try {
      debug.log('mission.grounding', 'timing', {
        cwd: searchRoot,
        cwdSource,
        totalElapsedMs: performance.now() - startedAt,
        searchTermsElapsedMs,
        persistentElapsedMs,
        corpusElapsedMs,
        renderingElapsedMs,
      });
    } catch { /* timing observations must not change grounding */ }
  };
  try {
    const searchTermsStartedAt = performance.now();
    let generatedTerms: string[];
    try {
      generatedTerms = await (deps.searchTerms ?? defaultSearchTerms)(goal);
    } finally {
      searchTermsElapsedMs = performance.now() - searchTermsStartedAt;
    }
    const terms = expandHyphenatedSearchTerms(generatedTerms!);
    const persistentDisabled = deps.persistent === false;
    const persistentStartedAt = performance.now();
    let persistent: Awaited<ReturnType<typeof groundPersistently>>;
    try {
      persistent = persistentDisabled
        ? null
        // ⛔⛔ **되돌림 방지**(2026-07-30 실측) — `#6000` 이 이 한 줄로 terms 를 코드 채널에 연결했는데
        //    `#6006`(문서 채널 관련도 선별)이 **수리와 그 회귀 테스트를 함께 지웠다.** 아무 신호도 없었다.
        //    terms 가 여기로 안 가면 코퍼스가 주입하는 검색어가 **코드 채널에 도달하지 않는다**
        //    ⇒ 자가 재려는 seam 을 피측정자가 안 쓴다(그 자의 코드 채널 수치가 무의미해진다).
        : await groundPersistently(goal, searchRoot, { ...deps.persistent, terms });
    } finally {
      persistentElapsedMs = performance.now() - persistentStartedAt;
    }
    debug.log('grounding.search', 'term-expanded', { inputTerms: generatedTerms!.length, outputTerms: terms.length });
    // ★ 코드(git grep)·skill(P1·luna)·기억/문서(P2·3박자)를 **병렬** 회상 — 직렬 latency 회피(각 fail-soft).
    //   skill(P1): 골이 skill 능력("absorb" 등)을 가리키면 SKILL.md 를 근거로(mirage=존재않는 src 지목 차단).
    //   기억/문서(P2): 선언기억·자기이력·문서벡터를 참조 컨텍스트로(files 엔 안 넣음 — mirage 가드 보존).
    const persistentCodeFiles = persistent?.files.slice(0, 12) ?? [];
    const corpusStartedAt = performance.now();
    let corpus: [string[], string[], DocumentGroundingMatch[], Awaited<ReturnType<typeof groundMissionInSkills>>, Awaited<ReturnType<typeof groundMissionInMemory>>, string, Awaited<ReturnType<typeof groundMissionInCapsules>>];
    try {
      corpus = await Promise.all([
        persistentCodeFiles.length ? Promise.resolve(persistentCodeFiles) : searchCodebase(terms, 12, searchRoot),
        Promise.resolve(persistent?.evidence.slice(0, 12) ?? []),
        searchRepositoryDocumentsWithMatches(terms, 12, searchRoot),
        groundMissionInSkills(terms, goal, deps),
        groundMissionInMemory(goal, deps),
        Promise.resolve().then(() => (deps.refDigest ?? localRefGroundingDigest)(goal)).catch(() => ''),
        groundMissionInCapsules(goal, deps),   // ★ F2 — 상류 PTY 잡 capsule 검색-코퍼스(관련도+최근성)
      ]);
    } finally {
      corpusElapsedMs = performance.now() - corpusStartedAt;
    }
    const [codeFiles, persistentEvidence, documentMatches, skills, memory, refDigest, capsules] = corpus!;
    const renderingStartedAt = performance.now();
    const documentFacts = documentMatches.map(({ path }) => path);
    const searched = [...codeFiles, ...skills.files].filter(isRepositoryImplementationCandidate);
    // ⛔⭐ 사람이 ask 에 «이름을 댄» 경로는 후보로 «쓴다» — 종전엔 「내 집합에 들어 있나」만 봤다.
    //   📏 2026-08-11 72차: 접지 채널이 실패하면 facts.files 가 비고, 그러면 ***ask 가 무엇을 대든***
    //     반드시 실패했다(goal-author.ts 의 lacksNamedCandidate). 🅣 가 그 반대 사례도 찾았다
    //     (채널이 «성공»했는데도 code=0). ⇒ 이 배선은 「장애 대비」가 아니라 그 자체로 옳은 계약이다.
    //   ⛔ mirage 가드는 «그대로» — ***git 이 추적하는 파일만*** 들인다(없는 파일을 지목하지 않는다).
    //   ⛔ 그리고 「검색이 찾은 것」과 「사람이 댄 것」을 관측에서 구분한다(출처를 지우지 않는다).
    const seedRequested = [...new Set(deps.seedPaths ?? [])].filter(isRepositoryImplementationCandidate);
    const seedAccepted = seedRequested.length === 0 ? [] : await execFileAsync(
      'git', ['ls-files', '--', ...seedRequested],
      { ...(searchRoot ? { cwd: searchRoot } : {}), encoding: 'utf-8', maxBuffer: 8_000_000 },
    ).then(({ stdout }) => stdout.split('\n').filter(Boolean)).catch(() => [] as string[]);
    const files = [...new Set([...searched, ...seedAccepted])];
    // ⛔ 「code=0」의 «두 뜻»을 가른다(2026-08-11 72차 실측: 저작 절반이 code=0 이었는데
    //   ⓐ 후보가 «처음부터» 없었는지 ⓑ 후보는 있었는데 «정책 필터»가 다 떨궜는지 조회로 못 갈랐다).
    //   ⇒ doc-split 은 «결과»만 말한다. 이 줄이 그 «앞»을 말한다. ⛔ 동작은 바꾸지 않는다.
    // ⛔ 「absent」로 접지 마라 — 「호출자가 껐다」와 「채널이 실패했다」는 다른 사건이다.
    const codeChannel: 'ok' | 'disabled' | 'failed' | 'incomplete' = persistentDisabled
      ? 'disabled'
      : persistent === null ? 'failed'
      : persistent.stopReason === 'goal_complete' ? 'ok' : 'incomplete';
    debug.log('grounding.search', 'code-candidates', {
      persistentChannel: codeChannel,
      fromPersistent: codeFiles.length,
      fromSkills: skills.files.length,
      afterPathPolicy: searched.length,
      droppedByPathPolicy: codeFiles.length + skills.files.length - searched.length,
      // ⛔ 「검색이 찾은 것」과 「사람이 댄 것」을 접지 않는다 — 0의 뜻이 달라진다.
      seedRequested: seedRequested.length,
      seedAccepted: seedAccepted.length,
      totalFiles: files.length,
      terms: terms.length,
    });
    const repositoryIdentifiers = Array.from(new Set([
      'elanous',
      ...files.flatMap((path) => path.split(/[/.\\-]+/)).filter((part) => part.length >= 3),
      ...documentFacts.flatMap((path) => path.split(/[/.\\-]+/)).filter((part) => part.length >= 3),
    ]));
    const genericSearchScope = !hasRepositorySpecificIdentifier(goal, repositoryIdentifiers);
    debug.log('grounding.search', 'doc-split', { code: files.length, docs: documentFacts.length });
    const memoryFacts = memory.facts;
    const refFacts = refFactsFromDigest(refDigest);
    const ptyFacts = capsules.facts;
    // 아무 코퍼스도 없으면 미grounded(기존 동작). 저장소 문서·기억·로컬 ref·상류 capsule 만 있어도 참조 컨텍스트로 seed한다.
    if (!files.length && !documentFacts.length && !skills.facts.length && !memoryFacts.length && !refFacts.length && !ptyFacts.length) {
      // ⛔ 초판은 여기서 **로그 없이** 반환했다 ⇒ 정작 알고 싶은 "왜 0 인가" 가 **조회에 안 뜬다**.
      //   `grounded:false` 를 검색 트리·term 수와 함께 남겨 '진짜 부재'와 '검색어/트리 문제'를 가른다.
      debug.log('mission.grounding', 'corpus', { grounded: false, reason: 'no-corpus', cwd: searchRoot, cwdSource, terms: terms.length, code: 0, docs: 0, skills: 0, skillFacts: 0, codeFacts: 0, memoryFacts: 0, refFacts: 0, ptyFacts: 0, persistentEvidence: persistent?.evidence.length ?? null, persistentStopReason: persistent?.stopReason ?? null, codeChannel });
      return { grounded: false, context: '', files: [], persistentEvidence: [], persistentStopReason: persistent?.stopReason, codeChannel, skillFacts: [], codeFacts: [], memoryFacts: [], documentFacts: [], documentMatches: [], searchTerms: terms, genericSearchScope, refFacts: [], ptyFacts: [] };
    }
    const codeLines = files.map((f) => `- ${f}: ${fileHeader(f, searchRoot)}`);
    const documentLines = documentFacts.map((f) => `- ${f}: ${fileHeader(f, searchRoot)}`);
    // ★ L4 — 상위 코드 파일의 export 심볼을 팩트로. decompose 가 "기존 URL helper" 같은 심볼을 추측/환각하지
    //   않게 **실제 export 계약**을 실어 나른다(경로+헤더만으론 심볼 미표면화 → 재사용 환각). 상위 8개 파일만.
    const codeFacts = files.slice(0, 8).map((f) => {
      const syms = extractExportedSymbols(f, 12, searchRoot);
      return syms.length ? `[code:${f}] ${syms.join(', ')}` : '';
    }).filter(Boolean);
    // 구현 후보와 문서 참조를 같은 후보 목록으로 렌더링하지 않는다. 문서는 배경 근거이며 수정 대상이 아니다.
    const contextSections = [
      codeLines.length || skills.lines.length
        ? ['구현 후보 (고칠 파일·재사용 스킬 — 새로 만들지 말고 재사용·확장 검토·중복 금지):', ...codeLines, ...skills.lines].join('\n')
        : '',
      documentLines.length
        ? ['저장소 문서 참조 (배경 컨텍스트만 — 구현 후보·수정 대상 아님):', ...documentLines].join('\n')
        : '',
    ].filter(Boolean);
    const context = contextSections.length
      ? contextSections.join('\n\n')
      : `참조 지식 ${memoryFacts.length + refFacts.length + ptyFacts.length}건(기억·자기이력·문서·로컬 ref·상류 capsule — decisions 참조·repo 파일 실존 주장 아님)`;
    // 관측(제1원칙) — grounding corpus 확장 결과(코드·문서·skill·기억·로컬 ref·상류 capsule 팩트). 조회: elanous logs --category mission.grounding
    const grounded = isCorpusGrounded({ files, documentFacts, skillFacts: skills.facts, memoryFacts, refFacts, ptyFacts });
    debug.log('mission.grounding', 'corpus', { grounded, cwd: searchRoot, cwdSource, code: files.length, docs: documentFacts.length, skills: skills.files.length, skillFacts: skills.facts.length, codeFacts: codeFacts.length, memoryFacts: memoryFacts.length, refFacts: refFacts.length, ptyFacts: ptyFacts.length, terms: terms.length, persistentEvidence: persistent?.evidence.length ?? null, persistentStopReason: persistent?.stopReason ?? null, codeChannel });
    renderingElapsedMs = performance.now() - renderingStartedAt;
    return {
      grounded,
      context,
      files,
      persistentEvidence,
      persistentEvidenceItems: persistentEvidence.map((text) => ({ text, sourceKind: 'code' })),
      persistentStopReason: persistent?.stopReason,
      codeChannel,
      skillFacts: skills.facts,
      codeFacts,
      memoryFacts,
      documentFacts,
      documentMatches,
      searchTerms: terms,
      genericSearchScope,
      refFacts,
      ptyFacts,
    };
  } catch (e) {
    // ⛔ 초판은 예외를 **조용히 삼켰다** ⇒ 실패로 인한 0 과 진짜 부재가 같은 값이 됐다.
    //   fail-soft 는 유지하되(분해를 막지 않는다) **관측은 남긴다**(제1원칙).
    debug.log('mission.grounding', 'corpus', { grounded: false, reason: 'error', cwd: searchRoot, cwdSource, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200), persistentEvidence: null, persistentStopReason: null, codeChannel: 'failed' }, { level: 'warn' });
    return { grounded: false, context: '', files: [], persistentEvidence: [], skillFacts: [], codeFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] };
  } finally {
    observeTiming();
  }
}

registerGoalAuthorGroundMission(groundMissionInCodebase);
