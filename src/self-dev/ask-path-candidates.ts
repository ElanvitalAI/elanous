import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface AskPathCandidateOptions {
  readonly cwd: string;
  readonly run?: (command: string, args: readonly string[], options: { cwd: string; encoding: 'utf8' }) => string;
}

export type AskPathCandidates =
  | { readonly tokens: string[]; readonly paths: string[]; readonly error?: undefined }
  | { readonly tokens: string[]; readonly paths: string[]; readonly error: string };

const STOP_WORDS = new Set(['the', 'and', 'test', 'src', 'scripts', 'file', 'path', 'paths', 'code', 'with', 'from', 'this', 'that', 'into', 'for', 'then', 'when', 'have', 'does', 'should', 'will', 'please', 'target', 'change']);
const WORD = /[-/]?[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*/g;

// ⛔ AUTO-TARGET (10-08 실측 · `ask-auto-target-candidates` Pod 로그): 한글 ask 에서 영문 낱말은 거의
//   «포장»뿐이었다 — 디스패처 머리 `[UX · 0.2.20 칸 <ID> · TASK-AGENT(OP 디스패처)]` ⊕ Pod 샤드 꼬리
//   `## Shard identity {"shardId","totalShards","position","summary","siblings"}` ⊕ `## Working-memory handoff`.
//   그 낱말들이 하니스 파일(orchestrate.ts · orchestrator.ts · self-implement-pod.ts · index.ts)을 끌어와
//   네 칸이 엉뚱한 골로 저작됐다. ⇒ 포장을 «증거»에서 걷고, 남는 것이 없으면 «후보 없음»(=근거 없음)을 낸다.
/** Machine-appended sections whose words describe the transport, not the request. */
const WRAPPER_SECTION_HEADINGS = new Set(['shard identity', 'working-memory handoff']);
/** Dispatcher wrapper lines that are identical for every card. */
const WRAPPER_LINE = /^\s*(?:보존 계약|판정)\s*:/;
/** Dispatcher header `[OWNER · <ver> 칸 <ID> · …]` — the title after it is kept. */
const WRAPPER_HEADER = /^\s*\[[^\]\n]*칸[^\]\n]*\]\s*/;
/** Dispatcher evidence label — the evidence itself is kept. */
const WRAPPER_LABEL = /^\s*칸 근거 끝\(남은 것\)\s*:\s*/;
/** Seat/role/surface words and similar labels that name the process, not the code. */
const GENERIC_TOKENS = new Set(['task-agent', 'op', 'mk', 'tc', 'ux', 'ceo', 'coo', 'cmo', 'cto', 'cxo', 'pr', 'prs', 'pod', 'tui', 'pwa', 'cli', 'hitl', 'p0', 'p1', 'p2']);

function isGenericToken(token: string): boolean {
  const lower = token.toLowerCase().replace(/[.]+$/, '');
  if (GENERIC_TOKENS.has(lower)) return true;
  if (/^v?\d+(?:\.\d+)+(?:-[a-z0-9.]+)?$/i.test(lower)) return true;   // version strings
  if (/^[0-9a-f]{7,40}$/.test(lower) && /\d/.test(lower)) return true;  // commit shas
  return false;
}

/** Remove dispatcher/Pod wrapper text so only the request body counts as lexical evidence. */
export function stripAskWrapper(askText: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of askText.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) skipping = WRAPPER_SECTION_HEADINGS.has(heading[1]!.toLowerCase());
    if (skipping || WRAPPER_LINE.test(line)) continue;
    kept.push(line.replace(WRAPPER_HEADER, '').replace(WRAPPER_LABEL, ''));
  }
  return kept.join('\n');
}

function existingFile(fragment: string, cwd: string): string | null {
  const path = fragment.replace(/^\.\//, '');
  if (!path.includes('/') && !/\.[A-Za-z][A-Za-z0-9]*$/.test(path)) return null;
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try { return statSync(absolute).isFile() ? rel.split('\\').join('/') : null; }
  catch { return null; }
}

/** Find existing code paths by lexical evidence from an unmodified ask. */
export function findAskPathCandidates(askText: string, { cwd, run = execFileSync }: AskPathCandidateOptions): AskPathCandidates {
  const scores = new Map<string, Set<string>>();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const body = stripAskWrapper(askText);
  const chunks = [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).concat([body]);
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(WORD)) {
      const raw = match[0];
      const token = raw.replace(/^\//, '');
      const file = existingFile(token, cwd);
      if (file) {
        const hits = scores.get(file) ?? new Set<string>();
        hits.add(token);
        scores.set(file, hits);
      }
      if (STOP_WORDS.has(token.toLowerCase()) || isGenericToken(token) || seen.has(token)) continue;
      if (!file && !token.includes('/') && !token.includes('.') && !token.includes('-') && !token.includes('_')
        && !/[a-z][A-Z]/.test(token) && token.length < 4) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  for (const token of tokens) {
    let matches: string;
    try {
      matches = run('rg', ['-l', '-F', '--glob', '!*.test.ts', '--', token, 'src', 'scripts'], { cwd, encoding: 'utf8' });
    } catch (error) {
      if ((error as { status?: number }).status === 1) continue; // rg: no matches
      return { tokens, paths: [], error: error instanceof Error ? error.message : String(error) };
    }
    for (const path of matches.split(/\r?\n/).filter(Boolean)) {
      const hits = scores.get(path) ?? new Set<string>();
      hits.add(token);
      scores.set(path, hits);
    }
  }
  return {
    tokens,
    paths: [...scores].sort(([a, aHits], [b, bHits]) => bHits.size - aHits.size || a.localeCompare(b, 'en')).slice(0, 5).map(([path]) => path),
  };
}
