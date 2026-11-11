// ── reuse-existence explorer (적응형 해상도 진단 첫 슬라이스 · 2026-07-13 · 대표 설계) ──
//
// DESIGN-adaptive-resolution-self-healing §2·§5: 진단이 "재사용 안 함/자가충족"으로 반복 실패한
// 페이즈를 얕은 heuristic("과대 -> split")으로 오판할 수 있다. 해법 = 선언된 재사용 경계 각각이
// **코드베이스+백업에 실제로 존재하는지**를 예산 무제한으로 탐색해 `실존@위치 / 유사 / 전무` 맵을
// 산출하고, 그 실측으로 heal 을 교정한다(split -> rebuild-with-map / thin-implement).
//
// 케이스(P7): sub7 이 "replay 로더 재구현·snapshotToCrashSignal 자가충족"으로 3회+ split 오판됐으나,
// 재사용 대상(runPriceGuardCycle·signal-pool 등)이 거의 다 실존 -> 올바른 heal 은 split 이 아니라
// "재사용맵 실어 rebuild". 이 모듈이 그 실존 검증을 결정론화한다(순수 함수 + search seam).

import { requirePosixShellCommand } from '../platform/default-shell.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rgListFiles, rgFilesWithMatches } from '../tool-runtime/ripgrep-core.js';
import { getUserConfig } from '../user-config/reader.js';
import type { HealKind } from './mission-phase-diagnosis.js';

export type ExistenceStatus = 'exists' | 'similar' | 'absent';

export interface ReuseExistence {
  /** 원 재사용 경계 문자열(워킹메모리 reusables 등). */
  boundary: string;
  status: ExistenceStatus;
  /** exists/similar 면 매칭 위치(파일 목록·상한). */
  locations: string[];
  /** 어떤 토큰이 매칭됐나(디버그·맵 표시). */
  matchedToken?: string;
  /** 판정 보조 설명(전무·토큰 없음 등). */
  note?: string;
}

/** 탐색 seam — 토큰 → {exact: 심볼/파일 정확 매칭, similar: 부분/케이스무시 매칭}. 기본=ripgrep.
 *  테스트는 이 seam 주입으로 fs 미접촉. 예산 무제한(진단 검증 탐색·잘못된 heal 이 더 비쌈). */
export type ExistenceSearch = (token: string) => { exact: string[]; similar: string[] };

const STOPWORDS = new Set([
  'with', 'from', 'this', 'that', 'when', 'then', 'only', 'must', 'need', 'does', 'into',
  'over', 'else', 'true', 'false', 'null', 'type', 'kind', 'note', 'test', 'tests', 'seam',
  'pattern', 'loader', 'replay', 'signal', 'style', 'value', 'result',
]);

/** 재사용 경계 문자열 -> 탐색 토큰(코드 식별자 후보). 순수. 한글/일반 영단어 노이즈는 배제하고
 *  camelCase·PascalCase·kebab·snake·dotted(파일명) 만 남긴다. "runFooCycle+FooDeps (replay 로더)"
 *  -> ['runFooCycle', 'FooDeps']. */
export function extractSearchTokens(boundary: string): string[] {
  const raw = boundary.match(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw) {
    if (tok.length < 4) continue;
    const codeish = /[a-z][A-Z]/.test(tok)          // camelCase hump
      || /[-_.]/.test(tok)                          // kebab/snake/dotted(파일명)
      || /^[A-Z][a-z]+[A-Z]/.test(tok);             // PascalCase 다단어
    if (!codeish) continue;
    const k = tok.toLowerCase();
    if (STOPWORDS.has(k)) continue;
    // 단일 소문자 일반 단어(코드 아님) 배제 — codeish 통과분만 남으므로 대부분 걸러짐.
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tok);
  }
  return out;
}

/** 재사용 경계들의 실존 맵 산출. 각 경계의 토큰을 탐색해 exact 있으면 exists, similar 만 있으면
 *  similar, 아무 매칭 없으면 absent. 토큰 자체가 없으면(자연어만) absent+note. 순수(search seam). */
export function exploreReuseExistence(
  boundaries: readonly string[],
  opts: { search?: ExistenceSearch; extraRoots?: string[] } = {},
): ReuseExistence[] {
  // ★ extraRoots(대표 2026-07-18) — grounding 이 발견한 디렉토리를 검색 공간에 더한다(동적·오픈 월드).
  const search = opts.search ?? defaultExistenceSearch(opts.extraRoots?.length ? { extraRoots: opts.extraRoots } : {});
  return boundaries.map((boundary) => {
    const tokens = extractSearchTokens(boundary);
    if (tokens.length === 0) {
      return { boundary, status: 'absent' as const, locations: [], note: '탐색 토큰 없음(코드 식별자 미검출)' };
    }
    let similarBest: { locations: string[]; matchedToken: string } | null = null;
    for (const tok of tokens) {
      const { exact, similar } = search(tok);
      if (exact.length) return { boundary, status: 'exists' as const, locations: exact.slice(0, 5), matchedToken: tok };
      if (similar.length && !similarBest) similarBest = { locations: similar.slice(0, 5), matchedToken: tok };
    }
    if (similarBest) return { boundary, status: 'similar' as const, ...similarBest };
    return { boundary, status: 'absent' as const, locations: [] };
  });
}

/** 실존 맵 -> 사람/프롬프트용 텍스트(rebuild 워킹메모리에 실을 재사용맵). 순수. */
export function formatExistenceMap(existence: readonly ReuseExistence[]): string {
  if (!existence.length) return '(재사용 경계 없음)';
  const mark: Record<ExistenceStatus, string> = { exists: '실존', similar: '유사', absent: '전무' };
  const lines = existence.map((e) => {
    const where = e.locations.length ? `@${e.locations.slice(0, 3).join(', ')}` : '';
    return `- [${mark[e.status]}] ${e.boundary}${where}${e.matchedToken ? ` (토큰: ${e.matchedToken})` : ''}`;
  });
  return `재사용 실존 맵:\n${lines.join('\n')}`;
}

// ── ★ ungrounded 결정론 오탐 필터 (2026-07-18 · 정확도 개선·대표) ─────────────
// critique LLM 이 verdict=ungrounded 를 냈을 때만 호출한다. 실존맵(git grep 결정론)이 "빌드차단 허상"을
// 명백히 반증하는 경우에 한해 **severity 만 critical→minor 로 de-escalate**(verdict=ungrounded 는 유지) 하고,
// 애매하면 none(무변경)으로 LLM 을 존중한다. **verdict 를 절대 지우지 않으므로 새 false-negative 가 원천 불가능**
// → "기존 판정보다 나빠지지 않음"이 구조적으로 보장(대표 제1요구). LLM verdict 가 ungrounded 가 아니면 애초에
// 호출하지 않으므로 다른 렌즈(단일책임·명세·스코프) 판정엔 무영향.
//
// 왜 clear(→ok) 는 안 하나: "지목 [전무]" 는 (정당)미션이 만들 산출물일 수도 (문제)인용하는 미충족 의존성일
//   수도 있는데 동사만으론 구별 불가(라이브 dogfood 확인: "설계하라" 페이즈가 자기 산출물 .md 와 미충족 의존
//   .md 를 둘 다 [전무]로 지목 → LLM ungrounded 는 의존 갭을 잡은 정당 판정이었다). 그래서 verdict 는 안 건드리고
//   severity 만 낮춘다. 대상이 실존(existsCount>0)하는데 신설동사가 없으면 "빌드차단(critical)" 근거는 약하다
//   (중복 재구현=신설동사 필요·허상=대상 부재 필요·둘 다 불성립). 라이브: "재사용 지점을 조사하라"(실존 9/10)
//   ungrounded critical → 같은 모델 rerun 시 under_specified(minor) 로 흔들림 = 그 critical 은 불안정한 오탐.

/** 창작(신설) 의도 동사 — 명백히 새로 만드는 것. 애매어(조립/연결/설계)는 제외(보수적). */
const NEW_INTENT_VERBS = ['신설', '작성', '구현', '정의', '생성', '만들', '새로', 'scaffold', 'implement', 'create'];
/** 재사용(비창작) 의도 동사 — 기존 자산을 조사/확장/배선. 창작 함의 없는 것만(보수적). */
const REUSE_INTENT_VERBS = ['재사용', '확장', '배선', '수정', '조사', '추적', '회귀', 'reuse', 'extend'];

/** 페이즈 텍스트의 동사 의도(순수) — 신설/재사용 각각 하나라도 있으면 true. */
export function detectVerbIntent(text: string): { hasNew: boolean; hasReuse: boolean } {
  const t = text || '';
  return { hasNew: NEW_INTENT_VERBS.some((v) => t.includes(v)), hasReuse: REUSE_INTENT_VERBS.some((v) => t.includes(v)) };
}

export interface UngroundedOverride {
  /** downgrade=critical→minor(빌드차단 아님·verdict 유지) · none=무변경. verdict 는 절대 안 바꾼다(무회귀 보장). */
  action: 'downgrade' | 'none';
  kind: 'reuse-exists' | 'none';
  reason: string;
}

/** LLM ungrounded verdict 결정론 오탐 검사(순수). existence=결정론 실존맵. verdict 는 유지하고 severity 만
 *  낮출지 판정(clear 없음 — false-negative 원천 차단). 실존 과반(>=0.5) & 재사용동사 O & 신설동사 X 면
 *  "빌드차단 허상" 근거가 약함(허상=대상부재 필요·중복=신설동사 필요·둘 다 불성립) → critical→minor. */
export function classifyUngroundedOverride(input: {
  phaseText: string;
  existence: readonly ReuseExistence[];
}): UngroundedOverride {
  const total = input.existence.length;
  if (total === 0) return { action: 'none', kind: 'none', reason: '' };
  const exists = input.existence.filter((e) => e.status === 'exists').length;
  const { hasNew, hasReuse } = detectVerbIntent(input.phaseText);

  // 재사용 실존 — 실존 과반이고 순수 재사용 의도면 빌드차단 허상 근거 약함. severity 만 minor(verdict 유지).
  if (exists / total >= 0.5 && hasReuse && !hasNew) {
    return { action: 'downgrade', kind: 'reuse-exists',
      reason: `재사용 페이즈(신설 전제 없음)에 지목 심볼 ${exists}/${total}건 실존 — 빌드차단 허상 근거 약함(중복 재구현도 신설동사 없어 무근거). 결정론 severity→minor(verdict 유지).` };
  }
  return { action: 'none', kind: 'none', reason: '' };
}

export interface HealRevision {
  heal: HealKind;
  confidence: 'high' | 'med' | 'low';
  rationale: string;
  /** rebuild 로 교정 시 실어보낼 재사용맵(formatExistenceMap). */
  reuseMap: string;
  /** heal 이 바뀌었는가(split -> rebuild 등). */
  changed: boolean;
}

/** 실존 맵 + 현재 heal -> 교정 heal(DESIGN §2.5). 핵심 교정: split 판정인데 재사용 대상이 대부분
 *  실존/유사면 "과대"가 아니라 "재사용 미이행" -> rebuild-with-map(split 남발 방지). 전부 전무면
 *  상류 결손 가능성(heal 유지·맵만 첨부). 순수·결정론. */
export function reviseHealFromExistence(input: {
  currentHeal: HealKind;
  existence: readonly ReuseExistence[];
}): HealRevision {
  const total = input.existence.length;
  const exists = input.existence.filter((e) => e.status === 'exists').length;
  const similar = input.existence.filter((e) => e.status === 'similar').length;
  const reuseMap = formatExistenceMap(input.existence);
  const presentRatio = total > 0 ? (exists + similar) / total : 0;

  // split 판정 + 재사용 대상 과반 실존/유사 -> rebuild-with-map(과대 오판 교정).
  if (input.currentHeal === 'split' && total > 0 && presentRatio >= 0.5) {
    return {
      heal: 'rebuild',
      confidence: exists >= similar ? 'high' : 'med',
      rationale: `선언된 재사용 경계 ${total}건 중 실존 ${exists}·유사 ${similar}(과반 존재) — 과대(split) 아니라 재사용 미이행. 재사용맵 실어 rebuild.`,
      reuseMap,
      changed: true,
    };
  }
  return {
    heal: input.currentHeal,
    confidence: 'med',
    rationale: total > 0
      ? `재사용 경계 ${total}건 중 실존 ${exists}·유사 ${similar} — 과반 미달(상류 결손 가능). heal 유지·맵 첨부.`
      : '재사용 경계 없음 — heal 유지.',
    reuseMap,
    changed: false,
  };
}

/** 탐색+교정 합성(배선 편의) — 선언된 재사용 경계 -> 실존 맵 -> heal 교정. run-mission 진단 경로가
 *  heal==='split' 인 reuse-violation 페이즈에 호출(fail-soft). 순수(search seam 주입 가능). */
export function assessReuseAndReviseHeal(input: {
  boundaries: readonly string[];
  currentHeal: HealKind;
  search?: ExistenceSearch;
}): HealRevision & { existence: ReuseExistence[] } {
  const existence = exploreReuseExistence(input.boundaries, input.search ? { search: input.search } : {});
  const revision = reviseHealFromExistence({ currentHeal: input.currentHeal, existence });
  return { ...revision, existence };
}

// ── ★ 실존 맵 경로 검사 (비평 오탐 수복 · 2026-07-17) ─────────────────────
// 버그: defaultExistenceSearch 가 `rg -w -l token`(파일 "내용" 검색)만 해서, 재사용 경계가
// 파일 경로(예: src/skills/tools/youtube-transcript.ts → 토큰 youtube-transcript.ts)면 그 파일이
// 실존해도 [전무] 오판했다(파일은 자기 이름을 본문에 안 담고 import 는 .js 씀 → 내용 매칭 0).
// → ungrounded false positive 대량 발생(실측 코드경로 7/7 오탐). 수복: 파일명꼴 토큰은 파일
// "경로" 존재를 먼저 확인(rg --files → basename 매칭). 심볼(함수/타입)은 기존 내용 검색 유지.

const FILE_TOKEN_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|sql|sh|py)$/i;

/** 파일명꼴 토큰인가(코드/문서 확장자로 끝나는 경로/이름). */
export function isFileNameToken(token: string): boolean {
  return FILE_TOKEN_RE.test(token);
}

/** ★ config 확장 자산 루트(하드코딩 탈피·대표 지적 2026-07-18) — autopilot.existenceRoots 로 재사용 자산이
 *  있을 곳을 사용자가 명시(예외적 고정 소스). 특정 디렉토리를 코드에 못박지 않고 config 로 유연화. fail-soft. */
function configExistenceRoots(): string[] {
  try {
    const roots = (getUserConfig().raw?.autopilot as { existenceRoots?: unknown } | undefined)?.existenceRoots;
    return Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [];
  } catch { return []; }
}

/** ★ grounding 발견 파일 → 검색 디렉토리(대표 2026-07-18 근본) — 공간을 미리 하드코딩(오픈 월드 불가)하지
 *  않고, 이 미션이 조사(grounding)에서 실제 touch 한 파일의 디렉토리를 검색 공간으로 쓴다. 스킬·.elanous·유저
 *  커스텀 어디든 미션이 발견한 곳이면 자동 포함. 순수(경로 목록 → 상위 디렉토리 집합). */
export function groundingDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const p = (f || '').trim();
    if (!p) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p;
    if (dir && existsSync(dir)) dirs.add(dir);
  }
  return [...dirs];
}

/** 기본 탐색기 — 공유 ripgrep-core 사용(Glob 툴·미션 루프와 동일 discovery). 파일명꼴 토큰=경로 존재
 *  (rg --files --glob basename·.ts↔.js 무관), 심볼=내용 매칭(-w exact / -i similar). rg 없으면 빈 결과(fail-soft).
 *  ★ 자산 소스(대표 2026-07-18) = 코드(repoRoot) + 레거시 백업 + config 확장 + extraRoots(grounding 발견
 *  디렉토리·동적). 공간을 미리 하드코딩하지 않고 미션이 조사에서 발견한 공간을 재사용한다(오픈 월드 대응). */
export function defaultExistenceSearch(opts: { repoRoot?: string; backupDirs?: string[]; extraRoots?: string[] } = {}): ExistenceSearch {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const backups = opts.backupDirs ?? defaultBackupDirs();
  const extra = [...(opts.extraRoots ?? []), ...configExistenceRoots()];
  const roots = [repoRoot, ...backups, ...extra].filter((d) => existsSync(d));
  return (token: string) => {
    if (!token) return { exact: [], similar: [] };
    // ★ 파일명꼴 토큰은 경로 존재 먼저(공유 rg --files --glob — 내용검색이 실재 파일을 [전무] 오판하던 버그 수복).
    if (isFileNameToken(token)) {
      const stem = token.replace(FILE_TOKEN_RE, '');
      const byPath = rgListFiles({ roots, globs: [`**/${token}`, `**/${stem}.{ts,tsx,js,jsx,mjs,cjs}`] }).paths.slice(0, 20);
      if (byPath.length) return { exact: byPath, similar: [] };
    }
    // 심볼(함수/타입) 은 내용 매칭(공유 프리미티브·-w exact / -i similar).
    const exact = rgFilesWithMatches(token, { roots, wholeWord: true }).paths.slice(0, 20);
    if (exact.length) return { exact, similar: [] };
    const similar = rgFilesWithMatches(token, { roots, ignoreCase: true }).paths.slice(0, 20);
    return { exact: [], similar };
  };
}

function defaultBackupDirs(): string[] {
  const base = join(homedir(), '.elanous', 'backups');
  const out: string[] = [];
  try {
    // clean-slate-* 백업 트리(레거시 산출물 탐색용). readdir 대신 알려진 패턴만(fail-soft).
    const r = spawnSync(requirePosixShellCommand('sh'), ['-c', `ls -d ${base}/clean-slate-* 2>/dev/null`], { encoding: 'utf-8' });
    if (r.status === 0) out.push(...r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { /* fail-soft */ }
  return out;
}

