// ── elanous docs — 문서 지식 CLI (DocOps P2 · 2026-07-13) ──────────────────────
//
//   elanous docs search "<질의>" [--limit 8] [--domain elanous] [--kind docs] [--json]
//
// knowledge.db(벡터+FTS5) 하이브리드 검색(RRF) — 의미(임베딩)와 키워드(BM25)
// 양쪽에서 잡는다. 임베딩 다운 시 키워드 단독으로 강등(fail-soft).

import type { Command } from 'commander';
import { registerRfcStatusCommand } from './rfc-status.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defaultEmbed, docsIndexCount, hybridQueryKnowledge, ingestDocsCorpus, knowledgeDbPath, openKnowledgeDb, type DocsCorpusCounts, type EmbedFn } from '../domains/knowledge.js';
import { debug } from '../debug/log.js';
import { fallbackDocsSearch, isLowConfidence } from '../knowledge/docs-search-fallback.js';
import { staleCwdFor, staleCwdHint } from '../knowledge/stale-cwd.js';
import { resolveSearchRoots } from '../knowledge/search-roots.js';
import { runGitCommand } from '../git-fs/runner.js';
import { assessDeclaredRevision, assessDocsStaleness, assessOneDocStaleness, emptyBranchCounts, enrichDocStalenessHistory, formatDocStaleness, formatRemovedIdentifierHistory, STALE_SCORE_THRESHOLD, type DeclaredRevisionAssessment, type DocStaleness } from '../autopilot/discovery/doc-staleness.js';

export interface DocsRevisionDeps {
  readDocument: (repoRoot: string, path: string) => string | null;
  readHistory: (repoRoot: string, path: string) => readonly string[] | null;
  assess: typeof assessDeclaredRevision;
  print: (line: string) => void;
  printError: (line: string) => void;
}

function readRevisionDocument(repoRoot: string, path: string): string | null {
  const root = resolve(repoRoot);
  const fullPath = resolve(root, path);
  const relativePath = relative(root, fullPath);
  if (relativePath === '..' || relativePath.startsWith('../') || !existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

function readRevisionHistory(repoRoot: string, path: string): readonly string[] | null {
  try {
    const result = runGitCommand(repoRoot, ['log', '--format=%s%x00', '--', path], { encoding: 'utf-8' });
    if (result.status !== 0) return null;
    const output = result.stdout;
    if (output === '') return [];
    return output.endsWith('\0') ? output.slice(0, -1).split('\0') : output.split('\0');
  } catch {
    return null;
  }
}

const defaultDocsRevisionDeps: DocsRevisionDeps = {
  readDocument: readRevisionDocument,
  readHistory: readRevisionHistory,
  assess: assessDeclaredRevision,
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
};

function formatDeclaredRevisionAssessment(assessment: DeclaredRevisionAssessment): string {
  switch (assessment.branch) {
    case 'no-declaration': return '판 선언 없음 — 검사 대상 아님';
    case 'invalid-declaration': return '판 선언 형식 오류';
    case 'ambiguous-declaration': return `판 선언 ${assessment.declarations.length}개 — 어느 선언을 쓸지 애매함`;
    case 'history-unavailable': return `선언 v${assessment.declaredRevision} · 이력 못 읽음 — 비교 불가`;
    case 'history-empty': return `선언 v${assessment.declaredRevision} · 읽은 이력에 판 없음`;
    case 'history-invalid': return `선언 v${assessment.declaredRevision} · 이력에 유효한 vN 없음`;
    case 'equal': return `선언 v${assessment.declaredRevision} = 이력 최고 v${assessment.highestHistoryRevision} — 일치`;
    case 'behind': return `선언 v${assessment.declaredRevision} < 이력 최고 v${assessment.highestHistoryRevision} — ${assessment.gap}판 뒤처짐`;
    case 'ahead': return `선언 v${assessment.declaredRevision} > 이력 최고 v${assessment.highestHistoryRevision} — ${assessment.gap}판 앞섬`;
  }
}

export async function runDocsRevision(
  path: string | undefined,
  opts: { json?: boolean },
  repoRoot = process.cwd(),
  overrides: Partial<DocsRevisionDeps> = {},
): Promise<number> {
  const deps: DocsRevisionDeps = { ...defaultDocsRevisionDeps, ...overrides };
  if (!path?.trim()) { deps.printError('elanous docs revision: 문서 경로가 필요합니다'); return 1; }
  try {
    const text = deps.readDocument(repoRoot, path);
    if (text === null) { deps.printError(`elanous docs revision: 문서를 찾을 수 없음 (${path})`); return 1; }
    const assessment = deps.assess(text, deps.readHistory(repoRoot, path));
    if (opts.json) deps.print(JSON.stringify({ path, ...assessment }, null, 2));
    else deps.print(`docs revision — ${path}: ${formatDeclaredRevisionAssessment(assessment)}`);
    return 0;
  } catch (error) {
    deps.printError(`elanous docs revision: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** 검색 한 번에 다시 색인할 변경 문서 상한 — 넘치면 다음 검색이 이어받는다(한 줄 안내). */
export const DOCS_SEARCH_REFRESH_MAX_FILES = 25;

/** 첫 임베딩 실패 뒤엔 바로 던진다 — 임베딩 서버가 죽었을 때 파일마다 타임아웃을 기다리지 않는다. */
function breakerEmbed(embed: EmbedFn = defaultEmbed): EmbedFn {
  let down = false;
  return async (text) => {
    if (down) throw new Error('embedding unavailable');
    try { return await embed(text); } catch (error) { down = true; throw error; }
  };
}

/** 색인 상태 한 줄(없으면 null) — 남은 변경 문서 · 정본 설계 문서(docs/conductor) 뿌리 부재. */
export function docsIndexNotice(refresh: DocsCorpusCounts | null, exists: (path: string) => boolean = existsSync): string | null {
  if (!refresh) return 'docs search: index refresh failed — results may be stale';
  if (refresh.pending > 0) return `docs search: index stale — ${refresh.pending} changed doc(s) not indexed yet (embedding down or over the per-search limit ${DOCS_SEARCH_REFRESH_MAX_FILES}; next search continues)`;
  if (!refresh.rootPaths.some((root) => exists(join(root, 'conductor')))) {
    return 'docs search: no docs/conductor in the index roots — run from a repo worktree or set knowledge.docsRoots';
  }
  return null;
}

/** 설정 `knowledge.docsRoots` — 배열이면(빈 배열 포함) 설정이다. 없으면 undefined(자동 감지). */
export function configuredDocsRoots(raw: unknown): string[] | undefined {
  const knowledge = (raw && typeof raw === 'object' ? (raw as { knowledge?: unknown }).knowledge : undefined) as { docsRoots?: unknown } | undefined;
  if (!knowledge || !Array.isArray(knowledge.docsRoots)) return undefined;
  return knowledge.docsRoots.filter((p): p is string => typeof p === 'string');
}

/** 폴백 적중 한 줄씩 — `(fallback)` 표시 ⊕ 이름/본문 적중 수. */
export function formatFallbackHits(hits: readonly { path: string; nameHits: number; contentHits: number }[]): string[] {
  return hits.map((h) => `(fallback) ${h.nameHits > 0 ? 'name' : 'text'} [name ${h.nameHits} · text ${h.contentHits}] ${h.path}`);
}

/**
 * 색인 결과가 약하면(0건·의미만) 같은 뿌리에서 이름 ⊕ 본문 폴백. 폴백까지 0건 = 진짜 빗나감 →
 * `docs.search-miss {query, roots, hits: 0}` 로 남긴다(어떤 질의가 문서에 없는지 관측).
 */
export function docsSearchFallback(
  query: string,
  matches: readonly { matchedBy: string }[],
  roots: readonly string[],
  k: number,
  log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d, { level: 'warn' }),
): ReturnType<typeof fallbackDocsSearch> {
  const fallback = isLowConfidence(matches) ? fallbackDocsSearch(query, roots, k) : [];
  if (matches.length === 0 && fallback.length === 0) log('docs', 'search-miss', { query, roots: [...roots], hits: 0 });
  return fallback;
}

export async function runDocsSearch(
  query: string,
  opts: { limit?: string; domain?: string; kind?: string; json?: boolean },
): Promise<number> {
  if (!query?.trim()) { console.error('elanous docs search: 질의가 필요합니다'); return 1; }
  // DOCS-SEARCH-INDEX-EMPTY — 색인 자가부트 ⊕ DOCS-SEARCH-CONDUCTOR 증분 자가 갱신: 매 검색이
  // ingestDocsCorpus 를 상한(DOCS_SEARCH_REFRESH_MAX_FILES)으로 돈다 — 무변경 파일은 stat 만(상시 폴링 0).
  // 뿌리 해석은 크론 knowledge-ingest 와 같은 기계(config knowledge.docsRoots 존중·현행 절 후보 포함).
  // 남은 변경·설계 문서 뿌리 부재는 한 줄로 알린다(조용한 잡음 결과 금지).
  const dbMissing = !existsSync(knowledgeDbPath());
  const db = openKnowledgeDb();
  try {
    // 단일 해석기 — env ELANOUS_DOCS_ROOTS > config knowledge.docsRoots > 없음(자동 감지).
    const configuredRoots = resolveSearchRoots().docsRoots;
    let refresh: DocsCorpusCounts | null = null;
    try {
      refresh = await ingestDocsCorpus(db, {
        ...(configuredRoots !== undefined ? { docsRoots: configuredRoots } : {}),
        toolModuleUrl: import.meta.url,
        toolDocsSegments: ['..', '..', 'docs'],
        embed: breakerEmbed(),
        maxFiles: DOCS_SEARCH_REFRESH_MAX_FILES,
      });
    } catch { /* fail-soft — 아래 판정이 안내 */ }
    if (dbMissing && docsIndexCount(db) === 0) {
      console.error(`elanous docs search: knowledge.db 없음 (${knowledgeDbPath()}) — knowledge-ingest 가 한 번은 돌아야 합니다.`);
      return 1;
    }
    const notice = docsIndexNotice(refresh);
    if (notice) console.error(notice);
    // 낡은 cwd 트리 — 설정 뿌리(latest)가 이미 이겼으므로 «latest 도 찾았다» 한 줄만 알린다.
    const stale = configuredRoots !== undefined ? staleCwdFor(process.cwd()) : null;
    if (stale) console.error(`docs search: ${staleCwdHint(stale)}`);
    const k = Math.min(Math.max(Number(opts.limit ?? 8) || 8, 1), 20);
    const matches = await hybridQueryKnowledge(db, query.trim(), {
      k,
      domain: opts.domain ?? 'elanous',
      ...(opts.kind ? { kind: opts.kind as never } : {}),
    });
    const fallback = docsSearchFallback(query.trim(), matches, refresh?.rootPaths ?? [], k);
    if (opts.json) { console.log(JSON.stringify(matches, null, 2)); return 0; }
    if (matches.length === 0 && fallback.length === 0) { console.log('(매치 없음)'); return 0; }
    for (const m of matches) {
      const tag = m.matchedBy === 'both' ? '◈' : m.matchedBy === 'vector' ? '≈' : m.matchedBy === 'title' ? '#' : '⌕';
      const src = m.source_ref ? ` — ${m.source_ref}` : '';
      console.log(`${tag} [${m.ts.slice(0, 10)}·${m.kind}·rrf ${m.rrf.toFixed(3)}] ${m.text.replace(/\n+/g, ' / ').slice(0, 180)}${src}`);
    }
    if (matches.length > 0) console.log(`\n(◈ 의미+키워드 · ≈ 의미 · ⌕ 키워드 · # 문서 이름/제목 — ${matches.length}건)`);
    if (fallback.length > 0) {
      console.log(`\n${formatFallbackHits(fallback).join('\n')}`);
      console.log(`(fallback) index ${matches.length === 0 ? 'had no hits' : 'had only semantic hits'} — filename/content search over the same roots · ${fallback.length}건`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** `elanous docs index` — 변경 문서 전부를 상한 없이 한 번에 색인한다(설치 직후 자동으로도 돈다). */
export async function runDocsIndex(opts: { json?: boolean } = {}): Promise<number> {
  const { refreshDocsIndex } = await import('../knowledge/docs-index-refresh.js');
  const db = openKnowledgeDb();
  try {
    const configuredRoots = resolveSearchRoots().docsRoots;
    const counts = await refreshDocsIndex(db, {
      ...(configuredRoots !== undefined ? { docsRoots: configuredRoots } : {}),
      toolModuleUrl: import.meta.url,
      toolDocsSegments: ['..', '..', 'docs'],
      embed: breakerEmbed(),
    });
    if (opts.json) console.log(JSON.stringify(counts));
    else console.log(`docs index: ${counts.files} doc(s) indexed · ${counts.unchanged} unchanged · ${counts.pending} pending · ${counts.roots} root(s)`);
    if (counts.pending > 0) console.error(`docs index: ${counts.pending} doc(s) still pending (embedding down?) — run again later; searches also catch up`);
    return 0;
  } catch (error) {
    console.error(`elanous docs index: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

/** `docs search --scope/--path/--source` — DocsSearch 와 같은 출처 해석기 · 인용 붙은 결과. */
export async function runDocsSourcesSearch(
  query: string,
  o: { limit?: string; json?: boolean; scope?: string; path?: string[]; source?: string[] },
): Promise<number> {
  const { dispatchDocsSearch } = await import('../skills/tools/docs-search.js');
  try {
    const result = await dispatchDocsSearch({
      query, scope: o.path?.length || o.source?.length ? (o.scope ?? 'custom') : o.scope,
      ...(o.limit ? { limit: Math.min(Math.max(Number(o.limit) || 8, 1), 20) } : {}),
      ...(o.path?.length ? { paths: o.path } : {}), ...(o.source?.length ? { source_ids: o.source } : {}),
    });
    console.log(o.json ? JSON.stringify(result.hits, null, 2) : result.output);
    return 0;
  } catch (error) {
    console.error(`elanous docs search: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** `docs sources` — 출처 목록 ⊕ 실존 검사. 틀린 항목·빠진 경로가 있으면 rc=1. */
export function runDocsSources(o: { json?: boolean }, opts: import('../knowledge/search-roots.js').SearchSourcesOpts = {}, print: (line: string) => void = (l) => console.log(l)): number {
  const { loadSearchSources, sourceHealth, SEARCH_ROOTS_UNCONFIGURED_NOTE, SEARCH_SOURCES_LEGACY_NOTE } = require('../knowledge/search-roots.js') as typeof import('../knowledge/search-roots.js');
  const loaded = loadSearchSources(opts);
  const rows = loaded.sources.map((s) => ({ ...s, enabled: s.enabled !== false, health: sourceHealth(s, opts.exists) }));
  if (o.json) print(JSON.stringify({ origin: loaded.origin, legacy: loaded.legacy, invalid: loaded.invalid, sources: rows }, null, 2));
  else {
    print(`sources (${loaded.origin}) — ${rows.length}`);
    if (loaded.origin === 'none') print(SEARCH_ROOTS_UNCONFIGURED_NOTE);
    for (const r of rows) print(`${r.health === 'ok' ? '✓' : '✗'} ${r.type}:${r.id}${r.enabled ? '' : ' (disabled)'} ${r.path}${r.health === 'ok' ? '' : ` — ${r.health}`}${r.label ? ` · ${r.label}` : ''}`);
    for (const reason of loaded.invalid) print(`✗ invalid ${reason}`);
    if (loaded.legacy) print(SEARCH_SOURCES_LEGACY_NOTE);
  }
  return loaded.invalid.length > 0 || rows.some((r) => r.enabled && r.health !== 'ok') ? 1 : 0;
}

/**
 * ⛔⭐ **주입 심 — `mock.module()` 을 쓰지 않기 위한 자리다**(`.rules/30-harness/testing-gates.md` `R-TST8`).
 *   bun 의 `mock.module()` 은 process-wide 캐시를 «영구» 교체해서 같은 런의 «다른 테스트 파일»이 그것을
 *   상속받는다. 실물로 겪었다: 이 CLI 를 목으로 시험했더니 `doc-staleness.test.ts` 가
 *   `Export named 'assessDocStaleness' not found` 로 죽어 게이트가 «세 라운드» 실패했다.
 *   ⇒ 그래서 목이 아니라 «인자»로 가른다. 기본값은 실물이라 운영 경로는 그대로다.
 */
export interface DocsStaleDeps {
  assessOne: typeof assessOneDocStaleness;
  assessAll: typeof assessDocsStaleness;
  format: typeof formatDocStaleness;
  enrichHistory: (document: DocStaleness, repoRoot: string) => ReturnType<typeof enrichDocStalenessHistory>;
  formatHistory: typeof formatRemovedIdentifierHistory;
  now: () => number;
  emptyBranches: typeof emptyBranchCounts;
  log: (category: string, event: string, data?: Record<string, unknown>) => void;
  print: (line: string) => void;
  printError: (line: string) => void;
}

const defaultDocsStaleDeps: DocsStaleDeps = {
  assessOne: assessOneDocStaleness,
  assessAll: assessDocsStaleness,
  format: formatDocStaleness,
  enrichHistory: enrichDocStalenessHistory,
  formatHistory: formatRemovedIdentifierHistory,
  now: () => Date.now(),
  emptyBranches: emptyBranchCounts,
  log: (category, event, data) => debug.log(category, event, data),
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
};

/**
 * ⭐ 이 도구의 «고유» 판별자는 「지금 없고 과거엔 있던 이름」 하나다. 나머지 셋(깨진 링크 ·
 * superseded 마킹 · staleScore)은 «부가 신호»이고 이미 다른 도구가 낸다.
 * ⇒ 그래서 합집합을 기본으로 내되, ***고유 축만 보는 문을 «명령»으로 연다***(리뷰 2R must-fix ①).
 */
export const DOCS_STALE_AXES = ['removed-identifiers', 'all', 'broken-links', 'superseded', 'stale-score', 'source-paths', 'line-anchors'] as const;
/**
 * ⭐⭐⭐ **기본은 «고유 판별자» 축이다**(리뷰 3R must-fix ①②).
 *   이 명령의 판별자는 「지금 없고 과거엔 있던 이름」 하나다. 나머지 셋(깨진 링크 · superseded ·
 *   staleScore)은 ***이미 다른 도구가 내는 부가 신호***이고, 합집합을 기본으로 내면
 *   `docs stale` 이 791 을 말해 사람이 그것을 「코드가 사라진 문서 수」로 읽는다(실측 46).
 *   ⇒ 합집합을 «없애지는» 않는다 — `--axis all` 로 «명시»할 때만 준다.
 */
export const DEFAULT_DOCS_STALE_AXIS: DocsStaleAxis = 'removed-identifiers';
export type DocsStaleAxis = typeof DOCS_STALE_AXES[number];

function matchesAxis(document: { removedIdentifiers: readonly string[]; brokenLinkCount: number; superseded: boolean; staleScore: number; sourcePaths?: { missing: number; extensionTypos: number }; lineAnchors?: { mismatches: readonly unknown[] }; hasAnySignal?: boolean }, axis: DocsStaleAxis): boolean {
  switch (axis) {
    case 'removed-identifiers': return document.removedIdentifiers.length > 0;
    case 'broken-links': return document.brokenLinkCount > 0;
    case 'superseded': return document.superseded;
    case 'stale-score': return document.staleScore >= STALE_SCORE_THRESHOLD;
    case 'source-paths': return (document.sourcePaths?.missing ?? 0) > 0 || (document.sourcePaths?.extensionTypos ?? 0) > 0;
    case 'line-anchors': return (document.lineAnchors?.mismatches.length ?? 0) > 0;
    default: return document.hasAnySignal ?? true;   // 'all' = 기존 네 신호가 하나라도 있는 것
  }
}

function printLineAnchorMismatches(document: DocStaleness, print: (line: string) => void): void {
  for (const mismatch of document.lineAnchors.mismatches) print(`    ${mismatch.diagnostic} (문서 ${document.path}:${mismatch.documentLine})`);
  // ⛔⭐ 「미판정 N건」만으로는 «고칠 수가 없다» — 어느 줄인지 말한다.
  //   📌 관행: `path:line` 뒤에 백틱 심볼을 같이 적으면 그 인용이 «판정 대상»이 된다.
  //   ⛔ 상한이 있으므로 «몇 개를 안 보여 줬는지»도 같이 낸다 — 목록 길이를 전수로 오독하지 못하게.
  // ⛔ 표시 경로는 «절대 안 던진다» — 이 필드를 안 세운 옛 호출자·픽스처가 있으면
  //   순회가 던져 `runDocsStale` 이 rc=1 을 낸다(실측: 기존 시험 하나가 그렇게 깨졌다).
  const sites = document.lineAnchors.symbolLessSites ?? [];
  for (const site of sites) {
    print(`    line-anchor 미판정: ${site.sourcePath}:${site.citedLine} — ±5줄 안에 «심볼 인용이 없다»`
      + ` (문서 ${document.path}:${site.documentLine})`);
  }
  const hidden = document.lineAnchors.symbolLessCitations - sites.length;
  if (hidden > 0) print(`    … 미판정 ${hidden}건 더 있음(표시 상한 ${sites.length}건). 전수는 --json 의 symbolLessCitations 다.`);
}

export async function runDocsStale(
  path: string | undefined,
  opts: { json?: boolean; axis?: string; history?: boolean },
  repoRoot = process.cwd(),
  overrides: Partial<DocsStaleDeps> = {},
): Promise<number> {
  const axis = (opts.axis ?? DEFAULT_DOCS_STALE_AXIS) as DocsStaleAxis;
  if (!DOCS_STALE_AXES.includes(axis)) {
    (overrides.printError ?? defaultDocsStaleDeps.printError)(`elanous docs stale: --axis 는 ${DOCS_STALE_AXES.join('|')} 중 하나여야 합니다 (받은 값: ${opts.axis})`);
    return 2;
  }
  const deps: DocsStaleDeps = { ...defaultDocsStaleDeps, ...overrides };
  deps.log('docs.stale', 'assessment-start', opts.history ? { path: path ?? null, history: true } : { path: path ?? null });
  const enrich = (document: DocStaleness) => {
    if (!opts.history) return document;
    const startedAt = deps.now();
    const enriched = deps.enrichHistory(document, repoRoot);
    const elapsedMs = deps.now() - startedAt;
    deps.log('docs.stale', 'history-result', { identifiers: enriched.removedIdentifierHistory.length, found: enriched.removedIdentifierHistory.filter((item) => item.status === 'found').length, elapsedMs });
    return { ...enriched, historyElapsedMs: elapsedMs };
  };
  try {
    if (path) {
      const assessed = deps.assessOne(repoRoot, path);
      if (assessed.outcome !== 'assessed') {
        if (assessed.outcome === 'out-of-scope') {
          deps.printError(`elanous docs stale: 파일이 실재하지만 판정 사정거리 밖 (${path})`);
        } else {
          deps.printError(`elanous docs stale: 문서를 찾을 수 없음 (${path})`);
        }
        return 1;
      }
      const document = enrich(assessed.document);
      // ⛔⭐ 단건도 «같은 계약»이다(3R must-fix ②) — 기본 축에서 늙었는지로 답하고,
      //   다른 축의 신호는 «부가»로만 보인다. 그러지 않으면 깨진 링크 하나로 「늙음」이 된다.
      const staleOnAxis = matchesAxis(document, axis);
      deps.log('docs.stale', 'assessment-result', { checked: 1, stale: staleOnAxis ? 1 : 0, axis, hasAnySignal: document.hasAnySignal ? 1 : 0, branches: document.branches ?? deps.emptyBranches() });
      if (opts.json) { deps.print(JSON.stringify({ ...document, axis, stale: staleOnAxis }, null, 2)); return 0; }
      deps.print(deps.format(document, staleOnAxis));
      // ⭐⭐ **단건 모드에만 «줄»을 낸다** — 이름만 주면 사람이 문서를 다시 열어야 하고,
      //   더 나쁘게는 ***「지금 있다고 «주장»한다」와 「은퇴했다고 «기록»한다」***를 못 가른다.
      //   ⛔ 전수 모드에는 «안» 낸다 — 46편에 줄까지 내면 산출이 감당이 안 된다(그 결정은 §6 경계).
      // ⛔⭐ **「현재」로 판정된 문서엔 줄을 «내지 않는다»**(회귀로 잡았다) — 판정과 판정문이 어긋나면
      //   사람이 「현재」라고 읽고 바로 아래에서 늙은 줄을 본다. 그 모순이 곧 오독이다.
      for (const site of staleOnAxis ? document.removedIdentifierSites ?? [] : []) {
        deps.print(`    ${site.identifier}  ${document.path}:${site.line}${site.more ? ` (외 ${site.more}줄)` : ''}`);
        deps.print(`      ${site.text}`);
      }
      if (staleOnAxis && axis === 'line-anchors') printLineAnchorMismatches(document, deps.print);
      if (staleOnAxis && 'removedIdentifierHistory' in document) {
        for (const line of deps.formatHistory(document.removedIdentifierHistory)) deps.print(line);
        deps.print(`    이력 조회 ${document.historyElapsedMs}ms`);
      }
      return 0;
    }
    const summary = deps.assessAll(repoRoot);
    const candidates = axis === 'source-paths' ? summary.sourcePathDocuments : axis === 'line-anchors' ? summary.lineAnchorDocuments : summary.documents;
    const selected = candidates.filter((document) => matchesAxis(document, axis)).map(enrich);
    // ⛔⭐ 관측의 `stale` 도 «축 판정»이다 — 합집합은 `withAnySignal` 이라는 «다른 이름»으로만 싣는다.
    //   그러지 않으면 같은 낱말이 단건 로그에서 46, 전수 로그에서 791 을 뜻한다(4R must-fix ①).
    deps.log('docs.stale', 'assessment-result', { checked: summary.checked, stale: selected.length, axis, withAnySignal: summary.withAnySignal, byAxis: summary.byAxis, branches: summary.branches });
    if (opts.json) deps.print(JSON.stringify({ ...summary, axis, stale: selected.length, documents: selected }, null, 2));
    else {
      // ⛔⭐ 「늙음 N」은 «합집합»이다 — 축을 같이 내지 않으면 사람이 그 N 을
      //   「코드가 사라진 문서 수」로 읽는다(리뷰 1R must-fix ①). 축마다 «따로» 적는다.
      deps.print(`docs stale — ${summary.checked}개 검사 · [--axis ${axis}] 늙음 ${selected.length}개`);
      const pathStatus = summary.sourcePaths.status === 'ok' ? '계산됨' : `못 셈: ${summary.sourcePaths.reason ?? '경로 평가 결과 없음'}`;
      deps.print(`  다른 축(부가 신호): 사라진 식별자 ${summary.byAxis.removedIdentifiers} · 깨진 링크 ${summary.byAxis.brokenLinks} · superseded 마킹 ${summary.byAxis.supersededMarked} · staleScore≥${STALE_SCORE_THRESHOLD} ${summary.byAxis.staleScoreOverThreshold} · 없는 소스 경로 ${summary.sourcePaths.missing} · 확장자 오기 ${summary.sourcePaths.extensionTypos} · 예시 제외 ${summary.sourcePaths.excludedExamples} · 문서 기준 해석 ${summary.sourcePaths.resolvedFromDocument} · ESM 지정자 해석 ${summary.sourcePaths.esmSpecifierResolved} (${pathStatus}) · 늙은 줄 앵커 ${summary.lineAnchors.mismatches} · 줄 앵커 못 셈 ${summary.lineAnchors.unavailable} · 심볼 없는 줄 인용 ${summary.lineAnchors.symbolLessCitations} · 신호 하나라도 ${summary.withAnySignal}`);
      for (const document of selected) {
        deps.print(deps.format(document, true));
        if (axis === 'line-anchors') printLineAnchorMismatches(document, deps.print);
        if ('removedIdentifierHistory' in document) {
          for (const line of deps.formatHistory(document.removedIdentifierHistory)) deps.print(line);
          deps.print(`    이력 조회 ${document.historyElapsedMs}ms`);
        }
      }
    }
    return 0;
  } catch (error) {
    deps.printError(`elanous docs stale: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ── docs (문서 지식 — DocOps P2 하이브리드 검색) ──
export function registerDocsCommands(program: Command): void {
  const docsCmd = program.command('docs')
    .description('문서 지식 검색/관리 — knowledge.db 벡터+BM25 하이브리드 (DocOps)');
  registerRfcStatusCommand(docsCmd);
  docsCmd.command('search <query>')
    .description('하이브리드 검색(RRF) — 의미(임베딩)+키워드(FTS5) 융합. 임베딩 다운 시 키워드 단독')
    .option('--limit <n>', '최대 결과 (기본 8·최대 20)')
    .option('--domain <d>', '도메인 (기본 elanous — finance 신호와 격리)')
    .option('--kind <k>', 'kind 필터 (docs|memory|signal|…)')
    .option('--json')
    .option('--scope <scope>', '출처 범위 repo(기본)|ref|both|custom — 출처는 knowledge.sources / ELANOUS_SOURCES')
    .option('--path <dir>', 'custom 범위 경로(반복 가능 · 실존해야 함)', (v: string, acc: string[] = []) => [...acc, v])
    .option('--source <id>', 'custom 범위 출처 id(반복 가능)', (v: string, acc: string[] = []) => [...acc, v])
    .action(async (query: string, o: { limit?: string; domain?: string; kind?: string; json?: boolean; scope?: string; path?: string[]; source?: string[] }) => {
      const { runDocsSearch, runDocsSourcesSearch } = await import('./docs-cli.js');
      // 범위·경로·출처 id 를 주면 DocsSearch 와 같은 출처 해석기로 찾는다(인용 repo:/ref:/custom:).
      if ((o.scope && o.scope !== 'repo') || o.path?.length || o.source?.length) process.exit(await runDocsSourcesSearch(query, o));
      process.exit(await runDocsSearch(query, o));
    });
  docsCmd.command('index')
    .description('변경된 문서를 한 번에 전부 색인(검색 시 25개 증분 상한 없음) — 설치 직후 자동으로도 돈다')
    .option('--json')
    .action(async (o: { json?: boolean }) => {
      const { runDocsIndex } = await import('./docs-cli.js');
      process.exit(await runDocsIndex(o));
    });
  docsCmd.command('sources')
    .description('검색 출처 목록 ⊕ 검사 — knowledge.sources [{ id, type: repo|ref, path, label?, include?, exclude?, enabled? }] (env ELANOUS_SOURCES 가 이긴다). 바꾸기는 사용자 설정 파일에서')
    .option('--json')
    .action(async (o: { json?: boolean }) => {
      const { runDocsSources } = await import('./docs-cli.js');
      process.exit(runDocsSources(o));
    });
  docsCmd.command('revision <path>')
    .description('문서가 선언한 현재 판과 해당 문서의 git 이력 판을 비교')
    .option('--json', '구조화된 판정 출력')
    .action(async (path: string, o: { json?: boolean }) => {
      const { runDocsRevision } = await import('./docs-cli.js');
      process.exit(await runDocsRevision(path, o));
    });
  docsCmd.command('stale [path]')
    .description('과거 TypeScript 인벤토리와 대조해 실제로 늙은 문서를 판정')
    .option('--json', '구조화된 판정 출력')
    .option('--axis <axis>', '판정 축 — removed-identifiers(기본·고유 판별자)|all(기존 네 축 합집합)|broken-links|superseded|stale-score|source-paths(명시 선택 부가 신호)|line-anchors(「경로:줄 ⊕ 심볼」 인용이 ±5줄 안에서 맞는가)')
    .option('--history', '사라진 식별자의 마지막 제거 커밋을 읽기 전용 이력으로 보강 (느릴 수 있음)')
    .action(async (path: string | undefined, o: { json?: boolean; axis?: string; history?: boolean }) => {
      // ⛔⭐ **sink 를 «먼저» 붙인다** — 붙이지 않으면 `debug.log('docs.stale', …)` 가 «불리는데»
      //   logs.db 에 안 닿아 `elanous logs --exact-category docs.stale` 이 «0건»을 낸다.
      //   📏 2026-08-12 실측: 이 줄이 없어서 라이브 판정 신호 ③(관측이 남는가)이 실패했다.
      //   ⚠️ 「로그 0건」의 세 뜻(미배선 · 다른 경로 · ***sink 미등록***) 중 셋째다 — 계측은 있었다.
      await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli');
      const { runDocsStale } = await import('./docs-cli.js');
      process.exit(await runDocsStale(path, o));
    });
}
