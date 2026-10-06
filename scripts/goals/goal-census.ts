#!/usr/bin/env bun
/**
 * GOAL-LIFE① — docs/goals 전수 분류(이관 전 측정).
 *
 * GitHub API·gh 를 부르지 않는다. git 이력과 파일 시스템만 읽고,
 * docs/goals 아래 어떤 파일도 쓰지 않는다.
 *
 *   bun scripts/goals/goal-census.ts [--json] [--out <path>]
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';

export type GoalKind = 'GOAL' | 'ASK' | 'other';
export type GoalClass = 'landed' | 'untracked' | 'tracked-no-pr';

export interface GoalCensusEntry {
  readonly path: string;
  readonly classification: GoalClass;
  readonly kind: GoalKind;
  readonly bytes: number;
  /** 추가 날짜 YYYY-MM-DD (KST). 미추적이면 파일 mtime. */
  readonly addedDateKst: string;
  readonly prNumber?: number;
  readonly addCommit?: string;
}

export interface GoalCensusSummary {
  readonly total: number;
  readonly byClass: Record<GoalClass, number>;
  readonly byKind: Record<GoalKind, number>;
  readonly matrix: Record<GoalClass, Record<GoalKind, number>>;
  readonly bytes: number;
  readonly bytesByClass: Record<GoalClass, number>;
  /** 월별 추가 수 — YYYY-MM (KST). */
  readonly addedByMonth: Record<string, number>;
}

export interface GoalCensus {
  readonly entries: readonly GoalCensusEntry[];
  readonly summary: GoalCensusSummary;
}

export interface AddedCommit {
  readonly hash: string;
  readonly subject: string;
  /** git %aI — ISO 8601 with offset. */
  readonly authoredAt: string;
}

export interface CensusGoalsInput {
  readonly repoRoot: string;
  /** 경로(repo 상대, posix) → 그 파일을 처음 추가한 커밋. 없으면 미추적. */
  readonly gitLog: (repoRoot: string) => ReadonlyMap<string, AddedCommit>;
  /** repo 상대 미추적 경로. */
  readonly listUntracked: (repoRoot: string) => readonly string[];
  /** 테스트·대체 루트. 기본 docs/goals. */
  readonly goalsDir?: string;
}

const CLASSES: readonly GoalClass[] = ['landed', 'untracked', 'tracked-no-pr'];
const KINDS: readonly GoalKind[] = ['GOAL', 'ASK', 'other'];

const PR_AT_END = /\(#(\d+)\)\s*$/;

export function classifyKind(relPath: string): GoalKind {
  const base = relPath.split('/').pop() ?? relPath;
  if (base.startsWith('GOAL')) return 'GOAL';
  if (base.startsWith('ASK')) return 'ASK';
  return 'other';
}

export function prNumberFromSubject(subject: string): number | undefined {
  const m = subject.match(PR_AT_END);
  return m ? Number(m[1]) : undefined;
}

/** UTC ISO(또는 offset 포함) → KST YYYY-MM-DD. */
export function kstDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const kst = new Date(t + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyMatrix(): Record<GoalClass, Record<GoalKind, number>> {
  const matrix = {} as Record<GoalClass, Record<GoalKind, number>>;
  for (const c of CLASSES) {
    matrix[c] = { GOAL: 0, ASK: 0, other: 0 };
  }
  return matrix;
}

function measureEntry(repoRoot: string, rel: string): { bytes: number; mtimeIso: string; files: string[] } {
  const abs = resolve(repoRoot, rel);
  const root = resolve(repoRoot);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return { bytes: st.size, mtimeIso: st.mtime.toISOString(), files: [rel] };
    const files: string[] = [];
    walkFiles(abs, root, files);
    let bytes = 0;
    for (const f of files) {
      try { bytes += statSync(resolve(repoRoot, f)).size; } catch { /* skip missing */ }
    }
    return { bytes, mtimeIso: st.mtime.toISOString(), files };
  } catch {
    return { bytes: 0, mtimeIso: new Date(0).toISOString(), files: [] };
  }
}

function earliestAddition(added: ReadonlyMap<string, AddedCommit>, prefix: string): AddedCommit | undefined {
  let best: AddedCommit | undefined;
  for (const [p, c] of added) {
    if (!p.startsWith(prefix)) continue;
    if (!best || c.authoredAt < best.authoredAt) best = c;
  }
  return best;
}

function walkFiles(dir: string, root: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.git') continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(abs, root, out);
    else if (st.isFile()) out.push(relative(root, abs).split('\\').join('/'));
  }
}

/**
 * `ls docs/goals` 와 같은 최상위 이름(파일·디렉터리 각 1).
 * 디렉터리의 크기·착지 근거는 그 아래 파일을 모아 정한다.
 */
export function listGoalFiles(repoRoot: string, goalsDir = 'docs/goals'): string[] {
  const abs = resolve(repoRoot, goalsDir);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  return names.filter((n) => n !== '.' && n !== '..').map((n) => `${goalsDir}/${n}`).sort();
}

export function summarize(entries: readonly GoalCensusEntry[]): GoalCensusSummary {
  const byClass = { landed: 0, untracked: 0, 'tracked-no-pr': 0 } as Record<GoalClass, number>;
  const byKind = { GOAL: 0, ASK: 0, other: 0 } as Record<GoalKind, number>;
  const matrix = emptyMatrix();
  const bytesByClass = { landed: 0, untracked: 0, 'tracked-no-pr': 0 } as Record<GoalClass, number>;
  const addedByMonth: Record<string, number> = {};
  let bytes = 0;
  for (const e of entries) {
    byClass[e.classification] += 1;
    byKind[e.kind] += 1;
    matrix[e.classification][e.kind] += 1;
    bytesByClass[e.classification] += e.bytes;
    bytes += e.bytes;
    const month = e.addedDateKst.slice(0, 7);
    addedByMonth[month] = (addedByMonth[month] ?? 0) + 1;
  }
  return { total: entries.length, byClass, byKind, matrix, bytes, bytesByClass, addedByMonth };
}

export function censusGoals(input: CensusGoalsInput): GoalCensus {
  const goalsDir = input.goalsDir ?? 'docs/goals';
  const prefix = goalsDir.endsWith('/') ? goalsDir : `${goalsDir}/`;
  const files = listGoalFiles(input.repoRoot, goalsDir);
  const added = input.gitLog(input.repoRoot);
  const untracked = new Set(input.listUntracked(input.repoRoot).map((p) => p.split('\\').join('/')));

  const entries: GoalCensusEntry[] = [];
  for (const path of files) {
    if (!path.startsWith(prefix)) continue;
    const kind = classifyKind(path);
    const measured = measureEntry(input.repoRoot, path);
    const { bytes, mtimeIso } = measured;
    const commit = added.get(path) ?? earliestAddition(added, `${path}/`);
    const nestedUntracked = measured.files.length > 0
      && measured.files.every((f) => untracked.has(f) || !added.has(f));
    if (!commit || untracked.has(path) || nestedUntracked) {
      entries.push({
        path,
        classification: 'untracked',
        kind,
        bytes,
        addedDateKst: kstDate(mtimeIso),
      });
      continue;
    }
    const prNumber = prNumberFromSubject(commit.subject);
    if (prNumber !== undefined) {
      entries.push({
        path,
        classification: 'landed',
        kind,
        bytes,
        addedDateKst: kstDate(commit.authoredAt),
        prNumber,
        addCommit: commit.hash,
      });
    } else {
      entries.push({
        path,
        classification: 'tracked-no-pr',
        kind,
        bytes,
        addedDateKst: kstDate(commit.authoredAt),
        addCommit: commit.hash,
      });
    }
  }
  return { entries, summary: summarize(entries) };
}

/**
 * 파일을 처음 추가한 커밋만. `git log --diff-filter=A` 한 번.
 * 최신→과거 순이므로 같은 경로가 다시 나오면 나중 값(최초 추가)이 이긴다.
 */
export function gitLogAdditions(repoRoot: string, goalsDir = 'docs/goals'): Map<string, AddedCommit> {
  const r = spawnSync(
    'git',
    [
      '-C', repoRoot,
      'log',
      '--diff-filter=A',
      '--name-only',
      '--format=@@%H%x09%s%x09%aI',
      '--',
      goalsDir,
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`git log failed: ${(r.stderr || '').trim()}`);
  }
  const out = new Map<string, AddedCommit>();
  let current: AddedCommit | undefined;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('@@')) {
      const body = line.slice(2);
      const tab = body.indexOf('\t');
      const tab2 = body.lastIndexOf('\t');
      if (tab > 0 && tab2 > tab) {
        current = {
          hash: body.slice(0, tab),
          subject: body.slice(tab + 1, tab2),
          authoredAt: body.slice(tab2 + 1),
        };
      }
      continue;
    }
    if (current) out.set(line, current);
  }
  return out;
}

/** 작업 트리의 미추적 파일. `git ls-files --others --exclude-standard`. */
export function gitListUntracked(repoRoot: string, goalsDir = 'docs/goals'): string[] {
  const r = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '--', goalsDir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`git ls-files failed: ${(r.stderr || '').trim()}`);
  }
  return r.stdout.split('\n').filter((p) => p.length > 0);
}

export function formatSummary(census: GoalCensus): string {
  const { summary } = census;
  const lines: string[] = [];
  lines.push(`total ${summary.total}  bytes ${summary.bytes}`);
  lines.push('class × kind');
  const header = ['class', ...KINDS, 'bytes'].join('\t');
  lines.push(header);
  for (const c of CLASSES) {
    const row = [
      c,
      ...KINDS.map((k) => String(summary.matrix[c][k])),
      String(summary.bytesByClass[c]),
    ];
    lines.push(row.join('\t'));
  }
  lines.push('added by month (KST)');
  const months = Object.keys(summary.addedByMonth).sort();
  for (const month of months) lines.push(`${month}\t${summary.addedByMonth[month]}`);
  return lines.join('\n') + '\n';
}

function parseArgs(argv: readonly string[]): { json: boolean; out?: string } {
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--out') {
      out = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--out=')) out = a.slice('--out='.length);
  }
  return { json, out };
}

function main(argv: readonly string[]): void {
  const repoRoot = resolve(import.meta.dir, '../..');
  const args = parseArgs(argv);
  const census = censusGoals({
    repoRoot,
    gitLog: (root) => gitLogAdditions(root),
    listUntracked: (root) => gitListUntracked(root),
  });
  const { summary } = census;
  debug.log('goals.census', 'scanned', {
    total: summary.total,
    landed: summary.byClass.landed,
    untracked: summary.byClass.untracked,
    trackedNoPr: summary.byClass['tracked-no-pr'],
    bytes: summary.bytes,
  });
  const body = args.json ? JSON.stringify(census, null, 2) + '\n' : formatSummary(census);
  if (args.out) writeFileSync(args.out, body);
  process.stdout.write(body);
}

if (import.meta.main) main(process.argv.slice(2));
