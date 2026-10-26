// ── DocOps P1 · L0 문서 컨벤션 린터 (2026-07-13) ─────────────────────────────
//
// 생성 시점의 난립을 줄이는 규칙 층 — **경고만**(차단 없음 · PLAN §3 L0).
// 규칙은 기존 corpus 관행에서 도출(신규 taxonomy 발명 아님):
//   R1 prefix — 알려진 대문자 prefix (기타는 안내)
//   R2 date   — 세션성 prefix(PLAN/HANDOFF/RECAP/FEATURE 등)는 YYYY-MM-DD 권장
//   R3 frontmatter — status의 종류 축과 생명주기 축을 구분해 생명주기 미기재를 안내
//   R4 trailhead — trailhead 가치 prefix 신규 문서의 _index 미등록 경고

import ts from 'typescript';
import { prefixOf, dateOf, parseIndexLinks, type DocKind } from './doc-inventory.js';

/** corpus 관행 기반 허용 prefix (se-doc-map 분포 상위 + 운영 문서 계열). */
export const KNOWN_PREFIXES = new Set([
  'PLAN', 'HANDOFF', 'RECAP', 'CAPABILITIES', 'ROADMAP', 'RESEARCH', 'MANUAL',
  'DESIGN', 'FEATURE', 'REPORT', 'RFC', 'SCHEME', 'INCIDENT', 'MAP', 'AUDIT',
  'ALIGNMENT', 'BACKLOG', 'SPIKE', 'ARCHIVE', 'VISION', 'APPENDIX', 'ARCHITECTURE',
  'FINDING', 'MEASUREMENT',
  'WIKI', // DocOps P3 — 종합(synthesis) 계층: docs/wiki/ 의 living 위키 페이지
]);

/** 날짜 suffix 권장 prefix (세션/아크 단위 문서). */
export const DATED_PREFIXES = new Set(['PLAN', 'HANDOFF', 'RECAP', 'FEATURE', 'REPORT', 'RESEARCH', 'INCIDENT', 'SPIKE', 'AUDIT']);

export interface LintWarning {
  file: string;
  rule: 'prefix' | 'date' | 'frontmatter-status' | 'trailhead';
  message: string;
}

export interface StaleSourceCitationWarning {
  file: string;
  rule: 'stale-source-citation';
  target: string;
  message: string;
}

export interface StaleSourceCitationLintDeps {
  /** 인용한 TypeScript 소스의 본문. null 은 파일이 없거나 읽을 수 없음을 뜻한다. */
  readSource: (sourcePath: string) => string | null;
}

const TYPESCRIPT_LINE_CITATION = /(?<![A-Za-z0-9_@./-])(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.tsx?:\d+(?![A-Za-z0-9_])/g;
const BACKTICK_IDENTIFIER = /`([A-Za-z_$][\w$]*)`/g;

function hasIdentifier(line: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(line);
}

function declarationLines(sourcePath: string, source: string, identifier: string): number[] {
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const record = (name: ts.Identifier | undefined) => {
    if (name?.text === identifier) lines.push(file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      record(node.name);
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && !(node.parent.flags & ts.NodeFlags.Using)
    ) {
      record(ts.isIdentifier(node.name) ? node.name : undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/**
 * TypeScript path:line 인용과 백틱 식별자가 같은 문서 줄에 있을 때만 해당 소스 줄을 대조한다.
 * 소스 읽기는 주입받으므로 파일 시스템·현재 작업 디렉터리에 의존하지 않는다.
 */
export function lintStaleSourceCitations(
  sourceRel: string,
  text: string,
  deps: StaleSourceCitationLintDeps,
): StaleSourceCitationWarning[] {
  const warnings: StaleSourceCitationWarning[] = [];
  for (const documentLine of text.split(/\r?\n/)) {
    const citations = [...documentLine.matchAll(TYPESCRIPT_LINE_CITATION)];
    const identifiers = [...documentLine.matchAll(BACKTICK_IDENTIFIER)].map((match) => match[1]!);
    if (citations.length === 0 || citations.length !== identifiers.length) continue;

    for (const [index, citation] of citations.entries()) {
      const target = citation[0];
      const identifier = identifiers[index]!;
      const separator = target.lastIndexOf(':');
      const sourcePath = target.slice(0, separator);
      const citedLine = Number.parseInt(target.slice(separator + 1), 10);
      const source = deps.readSource(sourcePath);
      // ⛔ 「그 파일을 못 짚었다」는 「좌표가 어긋났다」가 «아니다» — 말하지 않는다.
      //   (문서는 파일명만 적고, 같은 이름의 파일이 여럿이면 어느 것인지 알 수 없다.)
      if (source === null || source === undefined) continue;
      const sourceLines = source.split(/\r?\n/);
      const citedSourceLine = sourceLines[citedLine - 1];
      if (citedSourceLine !== undefined && hasIdentifier(citedSourceLine, identifier)) continue;
      // ⛔⭐ 그 이름이 «그 파일 어디에도» 없으면 이 인용이 그 이름을 가리킨다고 볼 근거가 없다 —
      //   같은 줄의 백틱이 심볼이 아니라 평범한 낱말일 때가 그렇다(`self` · `step` · `deploy`).
      //   ⇒ 「모른다」를 「어긋났다」로 접지 않는다.
      const actualLines = declarationLines(sourcePath, source, identifier);
      if (actualLines.length === 0) continue;
      // ✅ 여기서만 말한다 — 그 이름은 «이 파일에 있는데 그 줄이 아니다». 어디 있는지를 값으로 낸다.
      const where = actualLines.slice(0, 3).join(', ') + (actualLines.length > 3 ? ` 외 ${actualLines.length - 3}곳` : '');
      warnings.push({
        file: sourceRel,
        rule: 'stale-source-citation',
        target,
        message: `stale source citation: ${target} \`${identifier}\` — 그 줄에 없고 ${where}줄에 있다`,
      });
    }
  }
  return warnings;
}

const LIFECYCLE_STATUS = new Set(['active', 'superseded', 'archived']);

/** `status`에 관례상 기록된 문서 종류 축 — DocKind 기존 분류와 corpus의 RFC/INCIDENT를 함께 센다. */
const DOCUMENT_KIND_STATUS = new Set<DocKind | 'rfc' | 'incident'>([
  'plan', 'roadmap', 'research', 'handoff', 'recap', 'reference', 'report', 'other',
  'rfc', 'incident',
]);

/** 단일 문서 린트 — 순수. text 는 프론트매터 검사용(선택). */
export function lintDoc(
  filename: string,
  opts: { text?: string; indexLinks?: Set<string>; relPath?: string } = {},
): LintWarning[] {
  const out: LintWarning[] = [];
  if (!filename.endsWith('.md') || filename.startsWith('_')) return out; // _index 등 메타 제외

  const prefix = prefixOf(filename);
  if (prefix === 'OTHER' || !KNOWN_PREFIXES.has(prefix)) {
    out.push({ file: filename, rule: 'prefix', message: `알 수 없는 prefix — 허용 taxonomy: ${[...KNOWN_PREFIXES].slice(0, 8).join('|')}… (docs lint --rules 참조)` });
  }
  if (DATED_PREFIXES.has(prefix) && !dateOf(filename)) {
    out.push({ file: filename, rule: 'date', message: `${prefix} 문서는 -YYYY-MM-DD suffix 권장 (아크/세션 시점 식별)` });
  }
  if (opts.text && opts.text.startsWith('---\n')) {
    const m = /^---\n[\s\S]*?\bstatus:\s*([^\n]+)/.exec(opts.text.slice(0, 500));
    if (m) {
      const status = m[1]!.trim();
      const documentKind = /^(\S+)\s*\(/.exec(status)?.[1] ?? status;
      if (DOCUMENT_KIND_STATUS.has(documentKind as DocKind | 'rfc' | 'incident')) {
        out.push({ file: filename, rule: 'frontmatter-status', message: `status '${status}'는 문서 종류 축 — 생명주기(active|superseded|archived) 미기재` });
      } else if (!LIFECYCLE_STATUS.has(status)) {
        out.push({ file: filename, rule: 'frontmatter-status', message: `status '${status}' — 알 수 없는 값; 종류 또는 생명주기(active|superseded|archived)여야` });
      }
    }
  }
  if (opts.indexLinks && opts.relPath) {
    const trailheadValue = new Set(['HANDOFF', 'PLAN', 'ROADMAP', 'FEATURE', 'DESIGN', 'RESEARCH', 'REPORT']);
    if (trailheadValue.has(prefix) && !opts.indexLinks.has(opts.relPath)) {
      out.push({ file: filename, rule: 'trailhead', message: `_index.md 미등록 — trailhead 등재 검토 (canonical 이면 필수)` });
    }
  }
  return out;
}

// ── DocOps 링크·계약 정합 검사 (미션 …668871 arc3·2026-07-14) ────────────────────
//
// 문제: 위 lintDoc 는 문서 naming/frontmatter 규칙만 본다. 링크 정합(깨진 링크·anchor·구계약
// 잔재)은 결정론적으로 검사 가능한데 안 하고 있었다. doc-inventory 의 parseIndexLinks(구조화 refs
// — target/fragment/alias/syntax)를 재사용해 **새 파서 없이** 링크 무결성을 검사한다(페이즈 제약).
// LLM 은 깨진 링크 자체 판정에 안 쓴다(결정론) — 의미 모순만 상위에서 설명·우선순위화.

export interface LinkWarning {
  file: string;
  rule: 'broken-link' | 'broken-anchor' | 'ambiguous-link';
  target: string;
  message: string;
}

export interface LinkLintDeps {
  /** 대상 파일 존재 확인(repo 상대 경로). 주입(테스트·결정론). */
  fileExists: (relPath: string) => boolean;
  /** 대상 파일 본문(anchor/fragment 검사용). null 이면 anchor 검사 스킵. */
  readText?: (relPath: string) => string | null;
  /** 재귀 수집한 docs 볼트의 repo 상대 Markdown 경로. 위키 이름 해석에 재사용한다. */
  vaultFiles?: readonly string[];
}

export interface GitHubIssueCommentWarning {
  file: string;
  rule: 'missing-issuecomment' | 'unverifiable-issuecomment' | 'mismatched-issuecomment';
  target: string;
  message: string;
}

export type GitHubIssueCommentStatus =
  | { verdict: 'valid'; status: number; issueUrl?: string }
  | { verdict: 'missing'; status: 404 }
  | { verdict: 'unverifiable'; status?: number; reason: string };

export interface GitHubIssueCommentLintDeps {
  /** GitHub 댓글 API 결과. 주입해 네트워크 없이 판정한다. */
  fetchStatus: (apiUrl: string) => Promise<GitHubIssueCommentStatus>;
  /** bare issuecomment-<id> 포인터를 해석할 저장소 컨텍스트. */
  repository?: { owner: string; repo: string };
  /** GitHub API base URL. 테스트의 loopback 전송 계층에도 쓴다. */
  apiBase?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubIssueCommentFetchOptions {
  timeoutMs?: number;
  /** Authorization 헤더를 붙여도 되는 신뢰 호스트(GHES 등). api.github.com 은 항상 신뢰. */
  trustedAuthHosts?: string[];
}

/** GITHUB_TOKEN 을 실어도 안전한 기본 신뢰 호스트 — 공식 GitHub API 만. */
const DEFAULT_TRUSTED_AUTH_HOSTS = new Set(['api.github.com']);

function normalizedRequestUrl(apiUrl: string): string {
  try {
    return new URL(apiUrl).toString();
  } catch {
    return apiUrl;
  }
}

function hostOf(apiUrl: string): string | null {
  try {
    return new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 신뢰 호스트가 아니면 Authorization 헤더를 제거한다 — 사용자 지정 GITHUB_API_URL 로 토큰이
 * 임의 호스트에 유출되는 것을 막는다(fail-safe: 파싱 불가·비신뢰 호스트면 인증 헤더 탈락).
 */
function headersForHost(headers: HeadersInit, host: string | null, trusted: Set<string>): Headers {
  const out = new Headers(headers);
  if (out.has('authorization') && (host === null || !trusted.has(host))) {
    out.delete('authorization');
  }
  return out;
}

/** HTTP 응답을 issuecomment 린트 verdict로 변환하고 실행 범위에서 동일 요청을 한 번만 보낸다. */
export function createGitHubIssueCommentFetchStatus(
  fetchLike: FetchLike = fetch,
  headers: HeadersInit = { Accept: 'application/vnd.github+json' },
  options: GitHubIssueCommentFetchOptions = {},
): (apiUrl: string) => Promise<GitHubIssueCommentStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const trustedAuthHosts = new Set([
    ...DEFAULT_TRUSTED_AUTH_HOSTS,
    ...(options.trustedAuthHosts ?? []).map((h) => h.toLowerCase()),
  ]);
  const requests = new Map<string, Promise<GitHubIssueCommentStatus>>();

  return (apiUrl) => {
    const key = normalizedRequestUrl(apiUrl);
    const cached = requests.get(key);
    if (cached) return cached;

    const outgoingHeaders = headersForHost(headers, hostOf(key), trustedAuthHosts);
    const request = (async (): Promise<GitHubIssueCommentStatus> => {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await Promise.race([
          fetchLike(key, { headers: outgoingHeaders, signal }),
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ]);
        if (response.status >= 200 && response.status < 300) {
          // ⛔⭐ 본문 파싱은 **best-effort** 다(리뷰 2R must-fix) — 204·빈 본문·비-JSON 2xx 에서
          //    `response.json()` 이 던지면 **존재하는 포인터가 `unverifiable` 로 오판**된다.
          //    ⇒ 파싱 실패는 삼키고 **모든 2xx 는 valid** 로 돌려준다(존재 확인이 이 함수의 계약).
          let body: unknown;
          try { body = await response.json(); } catch { body = undefined; }
          const issueUrl = typeof body === 'object' && body !== null && 'issue_url' in body && typeof body.issue_url === 'string'
            ? body.issue_url
            : undefined;
          // ⛔⭐ **2xx = valid** 다(리뷰 must-fix) — 존재 확인이 이 린터의 계약이고, 본문 파싱 실패는
          //    *"존재하지 않는다"* 도 *"못 봤다"* 도 아니다. `issue_url` 은 소속 대조에만 쓰는 **부가 정보**다.
          return { verdict: 'valid', status: response.status, ...(issueUrl ? { issueUrl } : {}) };
        }
        if (response.status === 404) return { verdict: 'missing', status: 404 };
        return {
          verdict: 'unverifiable', status: response.status,
          reason: response.status === 403 || response.status === 429
            ? 'GitHub authentication or rate limit rejected the request'
            : 'GitHub API returned a non-success response',
        };
      } catch (error) {
        if (signal.aborted) {
          return { verdict: 'unverifiable', reason: `GitHub API request timed out after ${timeoutMs}ms` };
        }
        return { verdict: 'unverifiable', reason: error instanceof Error ? error.message : 'GitHub API request failed' };
      }
    })();
    requests.set(key, request);
    return request;
  };
}

interface GitHubIssueCommentPointer {
  target: string;
  owner?: string;
  repo?: string;
  issueNumber?: string;
  commentId: string;
}

interface GitHubIssueLocation {
  owner: string;
  repo: string;
  issueNumber: string;
}

const ISSUECOMMENT_URL = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)/g;
const ISSUECOMMENT_ID = /(?<![#\w-])issuecomment-(\d+)\b/g;
const GITHUB_ISSUE_API_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

function parseGitHubIssueLocation(issueUrl: string): GitHubIssueLocation | null {
  const match = issueUrl.match(GITHUB_ISSUE_API_URL);
  return match ? { owner: match[1]!, repo: match[2]!, issueNumber: match[3]! } : null;
}

/** 문서 본문에서 full URL과 bare issuecomment 포인터를 중복 없이 추출한다. */
export function githubIssueCommentPointers(text: string): string[] {
  return issueCommentPointers(text).map((pointer) => pointer.target);
}

function issueCommentPointers(text: string, repository?: { owner: string; repo: string }): GitHubIssueCommentPointer[] {
  // ⛔ 명시 타입이 필요하다 — `.map` 추론은 owner/repo/issueNumber 를 **필수**로 잡아서
  //    아래 bare 포인터 `push`(그 셋이 없을 수 있다)가 TS2345 로 깨진다(2026-07-30 실측).
  const pointers: GitHubIssueCommentPointer[] = [...text.matchAll(ISSUECOMMENT_URL)].map((match) => ({
    target: match[0], owner: match[1]!, repo: match[2]!, issueNumber: match[3]!, commentId: match[4]!,
  }));
  const knownCommentIds = new Set(pointers.map((pointer) => pointer.commentId));
  for (const match of text.matchAll(ISSUECOMMENT_ID)) {
    const commentId = match[1]!;
    if (!knownCommentIds.has(commentId)) pointers.push({ target: match[0], commentId, ...repository });
  }
  return pointers;
}

/**
 * GitHub issuecomment 포인터의 실재 여부를 GitHub API 결과로 검사한다.
 * 2xx만 valid, 404만 missing이며 그 외 HTTP·네트워크 오류는 fail-closed unverifiable이다.
 */
export async function lintGitHubIssueCommentPointers(
  sourceRel: string,
  text: string,
  deps: GitHubIssueCommentLintDeps,
): Promise<GitHubIssueCommentWarning[]> {
  const warnings: GitHubIssueCommentWarning[] = [];
  for (const pointer of issueCommentPointers(text, deps.repository)) {
    const { target, owner, repo, commentId } = pointer;
    if (!owner || !repo) {
      warnings.push({
        file: sourceRel,
        rule: 'unverifiable-issuecomment',
        target,
        message: `저장소 컨텍스트 없이 GitHub issuecomment 포인터를 검증할 수 없음: ${target}`,
      });
      continue;
    }
    let result: GitHubIssueCommentStatus;
    try {
      result = await deps.fetchStatus(`${deps.apiBase ?? 'https://api.github.com'}/repos/${owner}/${repo}/issues/comments/${commentId}`);
    } catch (error) {
      result = { verdict: 'unverifiable', reason: error instanceof Error ? error.message : 'GitHub API request failed' };
    }
    if (result.verdict === 'missing') {
      warnings.push({
        file: sourceRel,
        rule: 'missing-issuecomment',
        target,
        message: `삭제되었거나 존재하지 않는 GitHub issuecomment 포인터 (404): ${target}`,
      });
    } else if (result.verdict === 'unverifiable') {
      const status = result.status === undefined ? '' : ` (HTTP ${result.status})`;
      warnings.push({
        file: sourceRel,
        rule: 'unverifiable-issuecomment',
        target,
        message: `검증할 수 없는 GitHub issuecomment 포인터${status}: ${result.reason}: ${target}`,
      });
    } else if (pointer.issueNumber && result.issueUrl) {
      // ⭐ **비실패 진단**(리뷰 must-fix) — 2xx 로 실재하지만 **다른 이슈/PR 소속**인 포인터.
      //    ⛔ 실패로 올리지 않는다: 이 린터의 계약은 *"아직 거기 있나"* 이고, 소속 불일치는
      //      *"없다"* 가 아니라 *"딴 데를 가리킨다"* 는 **다른 사실**이다(CLI 가 exit 을 안 올린다).
      //    ⚠️ `issueUrl` 이 없으면(2xx 인데 본문이 없거나 파싱 실패) **대조 자체를 하지 않는다** — 침묵이 낫다.
      const actual = parseGitHubIssueLocation(result.issueUrl);
      // ⛔⭐ **파싱 실패는 `valid` 로 둔다**(리뷰 3R must-fix) — `issue_url` 형태를 못 읽은 것은
      //    *"다른 데를 가리킨다"* 는 **증거가 아니다**. 대조가 가능할 때만 대조한다.
      // ⭐ GitHub 의 owner/repo 는 **대소문자를 구분하지 않는다**(리뷰 4R must-fix) — 양쪽을 같은
      //    규칙으로 정규화하지 않으면 대문자 owner 와 소문자 owner 를 `mismatched` 로 오진한다.
      const sameRepo = actual
        && actual.owner.toLowerCase() === owner.toLowerCase()
        && actual.repo.toLowerCase() === repo.toLowerCase();
      if (actual && (!sameRepo || actual.issueNumber !== pointer.issueNumber)) {
        warnings.push({
          file: sourceRel,
          rule: 'mismatched-issuecomment',
          target,
          message: `GitHub issuecomment 포인터가 댓글의 실제 issue와 일치하지 않음: ${target} → ${result.issueUrl}`,
        });
      }
    }
  }
  return warnings;
}

/** heading 텍스트 → GitHub 스타일 anchor slug. 순수. */
export function headingSlug(heading: string): string {
  return heading.trim().toLowerCase()
    .replace(/[^\w가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 문서 본문의 heading anchor 집합(결정론). */
export function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) out.add(headingSlug(m[1]!));
  return out;
}

/** 경로 정규화 — ./·../ 해석(순수·POSIX). */
function normalizeRel(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 링크 대상을 repo 상대 경로로 해석. markdown=소스 디렉토리 기준 상대, wiki=docs 볼트 루트 기준. */
export function resolveLinkTarget(rawTarget: string, sourceRel: string, syntax: 'markdown' | 'wiki'): string {
  let t = rawTarget;
  if (!t.endsWith('/') && !/\.[a-z0-9]+$/i.test(t)) t = `${t}.md`; // 확장자 없으면 .md(위키 관행); 디렉토리 트레일링 슬래시는 보정 안 함
  if (syntax === 'wiki') return normalizeRel(t.startsWith('docs/') ? t : `docs/${t}`);
  const baseDir = sourceRel.includes('/') ? sourceRel.slice(0, sourceRel.lastIndexOf('/')) : '';
  return normalizeRel(`${baseDir}/${t}`);
}

/** 위키 이름과 일치하는 재귀 볼트 후보를 반환한다. 명시 경로도 같은 이름 후보와 모호하지 않게 검사한다. */
function wikiCandidates(target: string, vaultFiles: readonly string[]): string[] {
  const filename = target.slice(target.lastIndexOf('/') + 1);
  return vaultFiles.filter((path) => path === target || path.endsWith(`/${filename}`));
}

// CommonMark 펜스는 한 종류의 문자가 3개 이상 이어진 런이다. 열기/닫기 모두 이 하나를 쓴다.
const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 펜스(```/~~~)·인라인(`…`) 코드 영역을 같은 길이 공백으로 비운다.
 * 줄 수·비코드 위치는 유지한다 — 링크 탐색이 코드 인용을 본문으로 세지 않게 하기 위함.
 * 들여쓴(4칸/탭) 줄은 목록 이어짐과 구분하지 못해 비우지 않는다.
 * 패턴은 goal-author 의 linesOutsideFencedCode / inlineCodeContents 를 복사(import 아님).
 */
function blankCodeRegions(document: string): string {
  let fence: { marker: string; length: number } | null = null;
  const outsideBlocks = document.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part;

    const fenceMatch = FENCE_RUN.exec(part);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = { marker, length: fenceMatch[1]!.length };
      else if (marker === fence.marker && fenceMatch[1]!.length >= fence.length && fenceMatch[2]!.trim() === '') fence = null;
      return ' '.repeat(part.length);
    }
    if (fence) return ' '.repeat(part.length);
    return part;
  }).join('');

  return outsideBlocks.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
}

/**
 * 문서 링크 정합 린트 — 파일 존재·anchor/fragment 를 결정론적으로 검사. 기존 parseIndexLinks 재사용
 * (새 링크 파서 없음). 외부/mailto/앵커전용 링크는 parseIndexLinks 가 이미 제외. 순수 + 주입 fs.
 */
export function lintDocLinks(sourceRel: string, text: string, deps: LinkLintDeps): LinkWarning[] {
  const out: LinkWarning[] = [];
  for (const ref of parseIndexLinks(blankCodeRegions(text)).refs) {
    let target = resolveLinkTarget(ref.target, sourceRel, ref.syntax);
    if (ref.syntax === 'wiki' && deps.vaultFiles) {
      const candidates = wikiCandidates(target, deps.vaultFiles);
      if (candidates.length > 1) {
        out.push({ file: sourceRel, rule: 'ambiguous-link', target: ref.target, message: `모호한 위키 링크 — 대상이 여러 개: ${ref.target} (${candidates.join(', ')})` });
        continue;
      }
      if (candidates.length === 1) target = candidates[0]!;
    }
    if (!deps.fileExists(target)) {
      out.push({ file: sourceRel, rule: 'broken-link', target: ref.target, message: `깨진 링크 — 대상 없음: ${ref.target}${ref.fragment ? `#${ref.fragment}` : ''}` });
      continue;
    }
    if (ref.fragment && deps.readText) {
      const body = deps.readText(target);
      if (body != null && !anchorsOf(body).has(headingSlug(ref.fragment))) {
        out.push({ file: sourceRel, rule: 'broken-anchor', target: ref.target, message: `깨진 anchor — #${ref.fragment} 없음 in ${ref.target}` });
      }
    }
  }
  return out;
}
