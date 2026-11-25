// docs search 폴백 — 색인(벡터+FTS) 이 0건이거나 의미 유사만 걸린(키워드 근거 없음) 경우,
// 같은 뿌리에서 파일 이름(Glob) ⊕ 본문(Grep) 으로 다시 찾는다. 결과에는 «(fallback)» 을 붙인다.
//
// 관측(11-25 실험): 색인이 낡거나 뿌리가 틀리면 docs search 가 «매치 없음» 으로 끝나고,
// 모델은 그 말을 믿고 멈췄다. 같은 질의를 rg 로 찾으면 바로 나오는 문서였다.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface FallbackHit {
  path: string;
  /** 파일 이름에 걸린 질의 토큰 수. */
  nameHits: number;
  /** 본문에 걸린 질의 토큰 수(rg 가 없으면 0). */
  contentHits: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'archive', '_archive']);
const MAX_FILES = 20_000;

/** 질의 → 토큰(2자 이상 · 소문자). */
export function fallbackTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[\s,·/|]+/).map((t) => t.trim()).filter((t) => t.length >= 2))];
}

function listMarkdown(root: string): string[] {
  const out: string[] = [];
  let st;
  try { st = statSync(root); } catch { return out; }
  if (st.isFile()) return root.endsWith('.md') ? [root] : out;
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(join(dir, e.name)); }
      else if (e.isFile() && e.name.endsWith('.md')) out.push(join(dir, e.name));
    }
  }
  return out;
}

/** 본문 토큰 적중 — 파일별 «걸린 토큰 수». rg 하나로(-i -F -l 를 토큰마다). rg 없으면 빈 맵. */
function contentHitsByRg(tokens: readonly string[], roots: readonly string[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const token of tokens) {
    const r = spawnSync('rg', ['-l', '-i', '-F', '--glob', '*.md', '--', token, ...roots], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return new Map();
    for (const line of (r.stdout ?? '').split('\n')) if (line) hits.set(line, (hits.get(line) ?? 0) + 1);
  }
  return hits;
}

/** 이름 ⊕ 본문 폴백 검색. 정렬 = 이름 적중 우선, 그다음 본문 적중. */
export function fallbackDocsSearch(query: string, roots: readonly string[], limit = 8): FallbackHit[] {
  const tokens = fallbackTokens(query);
  const live = roots.filter((r) => existsSync(r));
  if (tokens.length === 0 || live.length === 0) return [];
  const content = contentHitsByRg(tokens, live);
  const byPath = new Map<string, FallbackHit>();
  for (const file of live.flatMap(listMarkdown)) {
    const name = basename(file).toLowerCase();
    const nameHits = tokens.filter((t) => name.includes(t)).length;
    const contentHits = content.get(file) ?? 0;
    if (nameHits === 0 && contentHits === 0) continue;
    byPath.set(file, { path: file, nameHits, contentHits });
  }
  // rg 가 걸었는데 순회에서 빠진 파일(상한 초과 등)도 살린다.
  for (const [file, contentHits] of content) {
    if (!byPath.has(file)) byPath.set(file, { path: file, nameHits: 0, contentHits });
  }
  return [...byPath.values()]
    .sort((a, b) => (b.nameHits * 10 + b.contentHits) - (a.nameHits * 10 + a.contentHits) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/** 색인 결과가 «약한가» — 0건이거나 키워드·제목 근거 없이 의미 유사만 걸렸다. */
export function isLowConfidence(matches: readonly { matchedBy: string }[]): boolean {
  return matches.length === 0 || matches.every((m) => m.matchedBy === 'vector');
}
