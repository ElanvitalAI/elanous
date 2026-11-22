/**
 * JUDGE-SCOPE-FROM-GOAL — 판정은 골의 «완료선» 안에서만 뒤집힌다(대표 11-22 다섯 칸 계약).
 *
 * 판정 파일 `~/.elanous/review-results/judb-<PR>-<head12>.json` 은 판정 자리가 쓴다. 옛 칸
 * (verdict·head·reviewer·tier·mustFix·edges)은 그대로 두고 두 칸을 더한다:
 *   goalLines: [{ id, verdict }]  — 완료선 id 마다 pass/fail
 *   fu: [...]                     — 완료선 밖 지적. 판정을 «절대» 뒤집지 않는다
 * PR 본문이나 연결된 골에 완료선 id 가 있으면 verdict = 모든 id 가 pass 일 때만 PASS, 아니면 HOLD.
 * 완료선 id 가 없으면 판정 자리가 쓴 verdict 를 그대로 둔다(옛 판정 파일·옛 골).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGoalContract } from './goal-contract-fields.js';

export type JudgeLineVerdict = 'pass' | 'fail';
export interface JudgeGoalLine { readonly id: string; readonly verdict: JudgeLineVerdict }

export interface JudgeVerdictFile {
  readonly verdict: 'pass' | 'hold';
  readonly head: string;
  readonly reviewer?: string;
  readonly tier?: string;
  readonly mustFix?: readonly string[];
  readonly edges?: readonly string[];
  readonly goalLines?: readonly JudgeGoalLine[];
  readonly fu?: readonly string[];
}

/** PR 본문 또는 골 문서의 `## 골 계약` → `### 완료선` id 들(구조로 읽는다). */
export function doneLineIdsFrom(text: string): string[] {
  return parseGoalContract(text)?.doneLines.map((line) => line.id) ?? [];
}

export interface GoalScopedVerdict {
  readonly verdict: 'pass' | 'hold';
  readonly scoped: boolean;
  readonly failed: readonly string[];
  readonly missing: readonly string[];
}

export function resolveGoalScopedVerdict(file: Pick<JudgeVerdictFile, 'verdict' | 'goalLines'>, doneLineIds: readonly string[]): GoalScopedVerdict {
  if (doneLineIds.length === 0) return { verdict: file.verdict, scoped: false, failed: [], missing: [] };
  const byId = new Map((file.goalLines ?? []).map((line) => [line.id, line.verdict]));
  const failed = doneLineIds.filter((id) => byId.get(id) === 'fail');
  const missing = doneLineIds.filter((id) => !byId.has(id));
  return { verdict: failed.length === 0 && missing.length === 0 ? 'pass' : 'hold', scoped: true, failed, missing };
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`judge verdict: ${field} must be a string array`);
  return value as string[];
}

export function parseJudgeVerdictFile(raw: string): JudgeVerdictFile {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.verdict !== 'pass' && value.verdict !== 'hold') throw new Error('judge verdict: verdict must be pass or hold');
  if (typeof value.head !== 'string' || !value.head) throw new Error('judge verdict: head is required');
  let goalLines: JudgeGoalLine[] | undefined;
  if (value.goalLines !== undefined) {
    if (!Array.isArray(value.goalLines)) throw new Error('judge verdict: goalLines must be an array');
    goalLines = value.goalLines.map((line: unknown) => {
      const row = line as Record<string, unknown> | null;
      if (!row || typeof row.id !== 'string' || !row.id || (row.verdict !== 'pass' && row.verdict !== 'fail')) {
        throw new Error('judge verdict: goalLines[] needs {id, verdict: pass|fail}');
      }
      return { id: row.id, verdict: row.verdict };
    });
  }
  const mustFix = stringArray(value.mustFix, 'mustFix');
  const edges = stringArray(value.edges, 'edges');
  const fu = stringArray(value.fu, 'fu');
  return {
    verdict: value.verdict,
    head: value.head,
    ...(typeof value.reviewer === 'string' ? { reviewer: value.reviewer } : {}),
    ...(typeof value.tier === 'string' ? { tier: value.tier } : {}),
    ...(mustFix ? { mustFix } : {}),
    ...(edges ? { edges } : {}),
    ...(goalLines ? { goalLines } : {}),
    ...(fu ? { fu } : {}),
  };
}

/** 판정 파일을 읽어 완료선 범위로 verdict 를 다시 매긴다. */
export function readGoalScopedJudgeVerdict(path: string, doneLineIds: readonly string[]): JudgeVerdictFile & GoalScopedVerdict {
  const file = parseJudgeVerdictFile(readFileSync(path, 'utf8'));
  const scoped = resolveGoalScopedVerdict(file, doneLineIds);
  return { ...file, ...scoped };
}

/** 쓰는 쪽 — 완료선 id 가 있으면 verdict 를 goalLines 로 매겨 적는다(fu 는 보지 않는다). */
export function writeJudgeVerdictFile(path: string, file: JudgeVerdictFile, doneLineIds: readonly string[]): JudgeVerdictFile {
  const normalized = parseJudgeVerdictFile(JSON.stringify(file));
  const written = { ...normalized, verdict: resolveGoalScopedVerdict(normalized, doneLineIds).verdict };
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
  return written;
}

/** self gate — 바뀐 파일 중 `내부 문서 `*`` 에 계약이 있으면 그 완료선 id 를 읽는다. */
export function goalDoneLinesForChangedFiles(cwd: string, changedFiles: readonly string[], read: (path: string) => string = (path) => readFileSync(path, 'utf8')): { path: string; ids: string[] }[] {
  const linked: { path: string; ids: string[] }[] = [];
  for (const file of changedFiles) {
    if (!file.startsWith('docs/goals/') || !file.endsWith('.md')) continue;
    let text: string;
    try { text = read(`${cwd}/${file}`); } catch { continue; }
    const ids = doneLineIdsFrom(text);
    if (ids.length > 0) linked.push({ path: file, ids });
  }
  return linked;
}

export function formatGoalDoneLines(linked: readonly { path: string; ids: readonly string[] }[]): string[] {
  return linked.map((goal) => `goal done-lines: ${goal.path} → ${goal.ids.join(', ')}`);
}
