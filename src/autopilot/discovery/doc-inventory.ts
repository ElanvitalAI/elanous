// ── Self-Evolution SE0 · 문서 인벤토리 스캐너 (2026-07-09) ─────────────────
//
// 문제(대표): docs/ 에 문서가 너무 많다(root 1279·전체 1734). 불필요·중복·stale 이
// 뒤섞여 정렬이 안 된다. 실제 통합/삭제는 별도 일주일 계획으로 하되, **먼저 문서 전체
// 종합맵(성격 포함)** 을 만들어 지반을 본다.
//
// 이 모듈: docs/ 스캔 → 성격(prefix)·주제·날짜·체크박스·크기·stale 분류 → 종합맵 md.
// 순수 분류 로직 + 주입 가능한 fs(테스트). SE1 roadmap-scan 이 이 결과를 재사용.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface DocEntry {
  path: string;          // repo 상대 경로
  filename: string;
  prefix: string;        // PLAN|ROADMAP|RESEARCH|HANDOFF|RECAP|CAPABILITIES|MANUAL|BACKLOG|...
  topic: string;         // prefix~date 사이 슬러그(주제 클러스터 키)
  date: string | null;   // 파일명 YYYY-MM-DD
  sizeBytes: number;
  openBoxes: number;     // '- [ ]' 미완
  doneBoxes: number;     // '- [x]' 완료
  subdir: string;        // '' = root, else 'research' 등
}

/** 문서 성격 대분류 — 정리 전략이 다른 축. */
export type DocKind = 'plan' | 'roadmap' | 'research' | 'handoff' | 'recap' | 'reference' | 'report' | 'other';

const PREFIX_KIND: Record<string, DocKind> = {
  PLAN: 'plan', ROADMAP: 'roadmap', RESEARCH: 'research', HANDOFF: 'handoff',
  RECAP: 'recap', CAPABILITIES: 'reference', MANUAL: 'reference', TECH: 'reference',
  BACKLOG: 'plan', TASK: 'plan', FEATURE: 'plan', PFC: 'reference',
  REPORT: 'report', AUDIT: 'report', LESSONS: 'report', NOTICE: 'other', PLUGIN: 'reference',
};

export function kindOfPrefix(prefix: string): DocKind {
  return PREFIX_KIND[prefix] ?? 'other';
}

/** 파일명 → prefix(선두 대문자 토큰). 대문자-하이픈 아니면 'other'. */
export function prefixOf(filename: string): string {
  const m = /^([A-Z][A-Z0-9]+)-/.exec(filename);
  return m ? m[1]! : 'OTHER';
}

/** 파일명에서 YYYY-MM-DD 추출(마지막 날짜·없으면 null). */
export function dateOf(filename: string): string | null {
  const all = filename.match(/(\d{4}-\d{2}-\d{2})/g);
  return all && all.length ? all[all.length - 1]! : null;
}

/** prefix·date 를 벗겨낸 주제 슬러그(클러스터 키). 소문자·하이픈. */
export function topicOf(filename: string): string {
  let s = filename.replace(/\.md$/, '');
  const p = prefixOf(filename);
  if (p !== 'OTHER') s = s.slice(p.length + 1);
  s = s.replace(/-?\d{4}-\d{2}-\d{2}.*$/, ''); // 날짜 이후 제거
  s = s.replace(/-(v\d+|p\d+|m\d+|phase\d+|eod|closure|entry)$/i, '');
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '(untitled)';
}

/** 체크박스 카운트(미완/완료). */
export function countBoxes(text: string): { open: number; done: number } {
  const open = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  return { open, done };
}

/** stale 점수(0-100) — 오래됨 + 미완 잔존 + 성격(handoff/recap 은 태생 이력). */
export function staleScore(entry: Pick<DocEntry, 'date' | 'openBoxes' | 'doneBoxes' | 'prefix'>, nowMs: number): number {
  let score = 0;
  if (entry.date) {
    const ageDays = Math.max(0, (nowMs - Date.parse(entry.date)) / 86400_000);
    score += Math.min(50, ageDays / 3); // ~150일이면 50점
  }
  const total = entry.openBoxes + entry.doneBoxes;
  if (total > 0) score += Math.round((entry.openBoxes / total) * 30); // 미완 비율
  const kind = kindOfPrefix(entry.prefix);
  if (kind === 'recap' || kind === 'handoff') score += 20; // 세션 이력은 누적 정리 대상
  return Math.min(100, Math.round(score));
}

/** 기존 Markdown/Obsidian 링크 해석기의 구조화 참조. `parseIndexLinks` 반환값은
 * Set 호환을 유지하면서 `refs`에 source-agnostic 원문/fragment/alias를 보존한다.
 * docs-lint는 이 해석 결과를 재사용하며 별도 링크 파서를 만들지 않는다. */
export interface DocLinkRef {
  target: string;
  fragment?: string;
  alias?: string;
  syntax: 'markdown' | 'wiki';
}

export class ParsedDocLinks extends Set<string> {
  constructor(public readonly refs: DocLinkRef[]) { super(refs.map((ref) => ref.target)); }
}

/** _index.md 등 문서 본문 → 링크된 문서 상대경로 집합(docs/ 기준).
 * Markdown `](target.md#anchor)`와 Obsidian `[[path/note#anchor|alias]]`를
 * 동일하게 ./·/·.md·fragment·alias 정규화한다. */
export function parseIndexLinks(indexText: string): ParsedDocLinks {
  const refs: DocLinkRef[] = [];
  const add = (rawTarget: string, syntax: DocLinkRef['syntax'], rawFragment?: string, alias?: string): void => {
    const target = rawTarget.trim().replace(/^\.\//, '').replace(/^\//, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) return;
    refs.push({ target, syntax, ...(rawFragment ? { fragment: rawFragment.trim() } : {}), ...(alias?.trim() ? { alias: alias.trim() } : {}) });
  };
  const wikiLinks = [...indexText.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const m of indexText.matchAll(/\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g)) {
    const startsInsideWikiLink = wikiLinks.some((wiki) => {
      const start = wiki.index!;
      return m.index! >= start && m.index! < start + wiki[0].length;
    });
    if (startsInsideWikiLink) continue;
    const [target, fragment] = m[1]!.split(/#(.+)/, 2);
    add(target!, 'markdown', fragment);
  }
  for (const m of wikiLinks) {
    const [targetAndFragment, alias] = m[1]!.split('|', 2);
    const [target, fragment] = targetAndFragment!.split(/#(.+)/, 2);
    add(target!, 'wiki', fragment, alias);
  }
  return new ParsedDocLinks(refs);
}

/** trailhead 미등록 최근 문서 — _index.md 에 안 걸린 신규 문서(누락 보강 후보).
 *  대표: "문서가 많이 생겨 맵을 다시 만들어야". prefix 화이트리스트(trailhead 가치) + sinceDate 필터. */
export interface IndexGap { path: string; filename: string; prefix: string; date: string | null; openBoxes: number }

const TRAILHEAD_PREFIXES = new Set(['HANDOFF', 'PLAN', 'ROADMAP', 'FEATURE', 'DESIGN', 'RESEARCH', 'REPORT']);

export function indexGaps(
  entries: DocEntry[],
  indexLinks: Set<string>,
  opts: { sinceDate?: string; prefixes?: Set<string> } = {},
): IndexGap[] {
  const since = opts.sinceDate ?? null;
  const prefixes = opts.prefixes ?? TRAILHEAD_PREFIXES;
  const out: IndexGap[] = [];
  for (const e of entries) {
    const rel = e.path.replace(/^docs\//, '');
    if (indexLinks.has(rel)) continue;                     // 이미 등록됨
    if (!prefixes.has(e.prefix)) continue;                 // trailhead 가치 prefix 만
    if (since && (!e.date || e.date < since)) continue;    // 최근 문서만
    out.push({ path: rel, filename: e.filename, prefix: e.prefix, date: e.date, openBoxes: e.openBoxes });
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.filename.localeCompare(b.filename));
}

/** docs/ 재귀 스캔 → DocEntry[]. skipDirs 로 _archive/_superseded 제외 가능.
 *  readText:false 면 본문을 읽지 않는다(체크박스 0) — 색인 선정처럼 stat 만 필요한 호출용. */
export function scanDocs(docsDir: string, opts: { skipDirs?: string[]; readText?: boolean } = {}): DocEntry[] {
  const skip = new Set(opts.skipDirs ?? ['_archive', '_superseded', 'archive', 'node_modules']);
  const out: DocEntry[] = [];
  const repoRoot = join(docsDir, '..');
  const walk = (dir: string, subdir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        walk(full, subdir ? `${subdir}/${name}` : name);
      } else if (name.endsWith('.md')) {
        let text = '';
        if (opts.readText !== false) { try { text = readFileSync(full, 'utf-8'); } catch { /* */ } }
        const boxes = countBoxes(text);
        out.push({
          path: relative(repoRoot, full),
          filename: name,
          prefix: prefixOf(name),
          topic: topicOf(name),
          date: dateOf(name),
          sizeBytes: st.size,
          openBoxes: boxes.open,
          doneBoxes: boxes.done,
          subdir,
        });
      }
    }
  };
  walk(docsDir, '');
  return out;
}
