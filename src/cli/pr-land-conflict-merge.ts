export const CONFLICT_MERGE_ALLOWED_PATH_EXTENSIONS = ['.md', '.tsv'] as const;

export type ConflictVerdict = 'append-only' | 'needs-repair' | 'unmeasured';
export type ConflictAnalysisInput = {
  path: string;
  base: string;
  ours: string;
  theirs: string;
};
export type ConflictHunkAnalysis = {
  path: string;
  verdict: ConflictVerdict;
  hunks: number;
  base: string;
  ours: string;
  theirs: string;
};

function allowedPath(path: string): boolean {
  return CONFLICT_MERGE_ALLOWED_PATH_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function lineCount(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

type Insertion = { at: number; lines: string[] };
function additions(base: string, changed: string): Insertion[] | undefined {
  const baseLines = base.split('\n');
  const changedLines = changed.split('\n');
  if (baseLines.at(-1) === '' && changedLines.at(-1) === '') { baseLines.pop(); changedLines.pop(); }
  let cursor = 0;
  let pending: string[] = [];
  const insertions: Insertion[] = [];
  for (const line of changedLines) {
    if (cursor < baseLines.length && line === baseLines[cursor]) {
      if (pending.length) insertions.push({ at: cursor, lines: pending });
      pending = [];
      cursor++;
    } else pending.push(line);
  }
  if (cursor !== baseLines.length) return undefined;
  if (pending.length) insertions.push({ at: cursor, lines: pending });
  return insertions;
}

export function addedLines(base: string, changed: string): string[] | undefined {
  const changes = additions(base, changed);
  return changes?.flatMap((insertion) => insertion.lines);
}

export function classifyConflictHunks(base: string | null | undefined, ours: string | null | undefined, theirs: string | null | undefined, path: string): ConflictHunkAnalysis {
  const result = { path, hunks: 1, base: base ?? '', ours: ours ?? '', theirs: theirs ?? '' };
  if (base == null || ours == null || theirs == null) return { ...result, verdict: 'unmeasured' };
  if (!allowedPath(path)) return { ...result, verdict: 'needs-repair' };
  const oursAdded = additions(base, ours);
  const theirsAdded = additions(base, theirs);
  if (!oursAdded || !theirsAdded) return { ...result, verdict: 'needs-repair' };
  return { ...result, verdict: 'append-only' };
}

export type AppendMergeResult = { verdict: 'append-only'; content: string } | { verdict: 'needs-repair' | 'unmeasured' };
export function mergeAppendOnly(base: string, ours: string, theirs: string, path: string): AppendMergeResult {
  const analysis = classifyConflictHunks(base, ours, theirs, path);
  if (analysis.verdict !== 'append-only') return { verdict: analysis.verdict };
  const baseLines = base.split('\n');
  const oursAdded = additions(base, ours)!;
  const theirsAdded = additions(base, theirs)!;
  const byAnchor = new Map<number, string[]>();
  const anchors = new Set([...theirsAdded, ...oursAdded].map((insertion) => insertion.at));
  for (const anchor of anchors) {
    const theirsLines = theirsAdded.filter((insertion) => insertion.at === anchor).flatMap((insertion) => insertion.lines);
    const oursLines = oursAdded.filter((insertion) => insertion.at === anchor).flatMap((insertion) => insertion.lines);
    const commonCounts = new Map<string, number>();
    const availableTheirs = new Map<string, number>();
    for (const line of theirsLines) availableTheirs.set(line, (availableTheirs.get(line) ?? 0) + 1);
    for (const line of oursLines) {
      const count = availableTheirs.get(line) ?? 0;
      if (count > 0) {
        commonCounts.set(line, (commonCounts.get(line) ?? 0) + 1);
        availableTheirs.set(line, count - 1);
      }
    }
    const commonInOrder = (lines: readonly string[]) => {
      const remaining = new Map(commonCounts);
      return lines.filter((line) => {
        const count = remaining.get(line) ?? 0;
        if (count === 0) return false;
        remaining.set(line, count - 1);
        return true;
      });
    };
    if (commonInOrder(theirsLines).join('\0') !== commonInOrder(oursLines).join('\0')) return { verdict: 'needs-repair' };
    const remainingTheirs = new Map<string, number>();
    for (const line of theirsLines) remainingTheirs.set(line, (remainingTheirs.get(line) ?? 0) + 1);
    const lines = [...theirsLines];
    for (const line of oursLines) {
      const duplicateCount = remainingTheirs.get(line) ?? 0;
      if (duplicateCount > 0) remainingTheirs.set(line, duplicateCount - 1);
      else lines.push(line);
    }
    byAnchor.set(anchor, lines);
  }
  const additionsInOrder = [...byAnchor.values()].flat();
  if (additionsInOrder.some((line) => line.startsWith('|'))) {
    const tableBase = [...baseLines].reverse().find((line) => line.startsWith('|'));
    const expectedCells = tableBase ? lineCount(tableBase) : undefined;
    if (expectedCells !== undefined && additionsInOrder.some((line) => line.startsWith('|') && lineCount(line) !== expectedCells)) return { verdict: 'needs-repair' };
  }
  const baseContent = baseLines.at(-1) === '' ? baseLines.slice(0, -1) : baseLines;
  const output: string[] = [];
  for (let index = 0; index <= baseContent.length; index++) {
    output.push(...(byAnchor.get(index) ?? []));
    if (index < baseContent.length) output.push(baseContent[index]!);
  }
  const trailingNewline = base.endsWith('\n') || ours.endsWith('\n') || theirs.endsWith('\n');
  return { verdict: 'append-only', content: output.join('\n') + (trailingNewline ? '\n' : '') };
}

export function checkTheirsLinesKept(theirsAdded: readonly string[], result: string): boolean {
  const remaining = result.split('\n');
  return theirsAdded.every((line) => {
    const index = remaining.indexOf(line);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

export type ConflictRepairGoalInput = {
  files: readonly string[];
  oursDiff: string;
  theirsDiff: string;
  oursTitle: string;
  theirsTitle: string;
  oursBody?: string;
  theirsBody?: string;
  hunks: readonly string[];
};
export function buildConflictRepairGoal(input: ConflictRepairGoalInput): string {
  const files = [...new Set(input.files)];
  const hunkText = input.hunks.join('\n\n');
  return [
    `대상 경로: ${files.join(', ')}`,
    `경계: ${files.join(', ')}`,
    `PR 제목(의도): ${input.oursTitle}`,
    ...(input.oursBody ? [`PR 의도 본문:\n${input.oursBody}`] : []),
    `main 제목(의도): ${input.theirsTitle}`,
    ...(input.theirsBody ? [`main 커밋 본문:\n${input.theirsBody}`] : []),
    'PR diff:', input.oursDiff,
    'main diff:', input.theirsDiff,
    '충돌 덩어리:', hunkText,
  ].join('\n');
}

export type ConflictRepairDecision = 'automerge' | 'launch' | 'escalate';
export type ConflictRepairPlan = {
  decision: ConflictRepairDecision;
  reason: string;
  goal?: string;
  mergedFiles?: Record<string, string>;
};
export function planConflictRepair(input: {
  analyses: readonly ConflictAnalysisInput[];
  files?: readonly string[];
  oursDiff?: string;
  theirsDiff?: string;
  oursTitle?: string;
  theirsTitle?: string;
  oursBody?: string;
  theirsBody?: string;
  attemptsForHead?: number;
  attemptsForPr?: number;
}): ConflictRepairPlan {
  if ((input.attemptsForHead ?? 0) >= 1 || (input.attemptsForPr ?? 0) >= 2) return { decision: 'escalate', reason: 'repair-attempt-limit' };
  if (!input.analyses.length || input.analyses.some((analysis) => !analysis.path
    || typeof analysis.base !== 'string' || typeof analysis.ours !== 'string' || typeof analysis.theirs !== 'string')) {
    return { decision: 'escalate', reason: 'conflict-analysis-unmeasured' };
  }
  const files = input.files ?? input.analyses.map((analysis) => analysis.path);
  const complete = collectConflictAnalysis(files, input.analyses);
  if (complete.verdict === 'unmeasured') return { decision: 'escalate', reason: 'conflict-analysis-incomplete' };
  const merged = complete.analyses.map((analysis) => ({
    path: analysis.path,
    result: mergeAppendOnly(analysis.base, analysis.ours, analysis.theirs, analysis.path),
  }));
  if (merged.every(({ result }) => result.verdict === 'append-only')) {
    const mergedFiles: Record<string, string> = {};
    for (const { path, result } of merged) if (result.verdict === 'append-only') mergedFiles[path] = result.content;
    return { decision: 'automerge', reason: 'append-only', mergedFiles };
  }
  const hunks = input.analyses.map(({ path, base, ours, theirs }) => `FILE ${path}\n--- BASE ---\n${base}\n--- PR (ours) ---\n${ours}\n--- MAIN (theirs) ---\n${theirs}`);
  return {
    decision: 'launch', reason: 'needs-repair',
    goal: buildConflictRepairGoal({
      files,
      oursDiff: input.oursDiff ?? '', theirsDiff: input.theirsDiff ?? '',
      oursTitle: input.oursTitle ?? '', theirsTitle: input.theirsTitle ?? '', hunks,
      oursBody: input.oursBody, theirsBody: input.theirsBody,
    }),
  };
}

export type MergeTreeConflictPaths = { measured: true; paths: string[] } | { measured: false; paths: [] };
export function parseMergeTreeConflictPaths(output: string, status: number | null): MergeTreeConflictPaths {
  if (status !== 1 || !output.includes('\0')) return { measured: false, paths: [] };
  const fields = output.split('\0');
  if (!/^[a-f0-9]{40,64}$/i.test(fields[0]?.trim() ?? '')) return { measured: false, paths: [] };
  const separator = fields.indexOf('', 1);
  if (separator < 0) return { measured: false, paths: [] };
  const records = fields.slice(1, separator);
  if (!records.length) return { measured: false, paths: [] };
  const stageRecord = /^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t(.+)$/i;
  const stagedPaths = new Map<string, Set<string>>();
  let stagedRecords = 0;
  for (const record of records) {
    const match = stageRecord.exec(record);
    if (match) {
      stagedRecords++;
      const path = match[4]!;
      const stages = stagedPaths.get(path) ?? new Set<string>();
      if (stages.has(match[3]!)) return { measured: false, paths: [] };
      stages.add(match[3]!);
      stagedPaths.set(path, stages);
    }
  }
  if (stagedRecords) {
    if (stagedRecords !== records.length) return { measured: false, paths: [] };
    return { measured: true, paths: [...stagedPaths.keys()] };
  }
  if (records.some((record) => !record || /^[0-7]{6}\s/.test(record) || record.includes('\n'))) return { measured: false, paths: [] };
  if (new Set(records).size !== records.length) return { measured: false, paths: [] };
  return { measured: true, paths: records };
}

export type ConflictSnapshotResult = { verdict: ConflictVerdict; analyses: ConflictHunkAnalysis[]; missingPaths: string[] };
export function collectConflictAnalysis(conflictPaths: readonly string[], snapshots: readonly ConflictAnalysisInput[]): ConflictSnapshotResult {
  const expected = [...new Set(conflictPaths)].sort();
  const byPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
  const missingPaths = expected.filter((path) => !byPath.has(path));
  const extraPaths = [...byPath.keys()].filter((path) => !expected.includes(path));
  if (missingPaths.length || extraPaths.length || snapshots.length !== expected.length) {
    return {
      verdict: 'unmeasured', missingPaths,
      analyses: expected.map((path) => ({ path, verdict: 'unmeasured', hunks: 0, base: byPath.get(path)?.base ?? '', ours: byPath.get(path)?.ours ?? '', theirs: byPath.get(path)?.theirs ?? '' })),
    };
  }
  const analyses = expected.map((path) => {
    const snapshot = byPath.get(path)!;
    return classifyConflictHunks(snapshot.base, snapshot.ours, snapshot.theirs, path);
  });
  return { verdict: analyses.some((analysis) => analysis.verdict === 'unmeasured') ? 'unmeasured' : analyses.some((analysis) => analysis.verdict === 'needs-repair') ? 'needs-repair' : 'append-only', analyses, missingPaths };
}
