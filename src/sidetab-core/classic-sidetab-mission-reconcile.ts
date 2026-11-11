import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ClassicSidetabCandidatePatch {
  agent: 'codex' | 'claude';
  content: string;
}

export interface ClassicSidetabReconcileResult {
  status: 'merged' | 'conflict' | 'unavailable';
  baseSha: string;
  patch?: string;
  reason?: string;
  conflictingPatchOrder?: readonly ['codex', 'claude'];
}

const CANDIDATE_BLOCK = /<SIDETAB-CANDIDATE-V1 base-sha="([0-9a-f]{40})">[ \t]*\r?\n([\s\S]*?)\r?\n<\/SIDETAB-CANDIDATE-V1>/gi;
const SHA = /^[0-9a-f]{40}$/i;

function stripGitLineEnding(value: string): string {
  return value.replace(/\r?\n$/, '');
}

export function sidetabCandidateProtocolPrompt(mission: string, baseSha?: string): string {
  if (!baseSha || !SHA.test(baseSha)) return mission;
  return `${mission}\n\n` +
    `Parent candidate protocol (base ${baseSha}): do not modify, stage, or commit files in the shared checkout. Return your proposed code change as a complete unified Git diff based only on this exact base SHA. Include exactly one block in your result file, with no Markdown fence around the diff:\n` +
    `<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/path b/path\n...\n` +
    `</SIDETAB-CANDIDATE-V1>\n` +
    `If you cannot produce a valid diff against this base, omit the block and state why. Never claim a file edit that is absent from the diff.`;
}

/** Preserve a failed child's well-formed proposal as evidence without making it eligible for reconciliation. */
export function preservedFailedCandidateBlock(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const matches = [...content.matchAll(CANDIDATE_BLOCK)];
  if (matches.length !== 1) return undefined;
  const [, claimedBase, patch] = matches[0]!;
  if (!claimedBase || !SHA.test(claimedBase) || !patch?.trim() || !/^diff --git /m.test(patch)) return undefined;
  return matches[0]![0];
}

export function readClassicSidetabPairBaseSha(cwd: string): string | undefined {
  if (!cwd.trim()) return undefined;
  try {
    const sha = stripGitLineEnding(execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd,
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    return SHA.test(sha) ? sha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function extractCandidate(candidate: ClassicSidetabCandidatePatch, baseSha: string): { patch?: string; reason?: string } {
  const matches = [...candidate.content.matchAll(CANDIDATE_BLOCK)];
  if (matches.length !== 1) return { reason: `${candidate.agent}: expected one SIDETAB-CANDIDATE-V1 block; found ${matches.length}` };
  const [, claimedBase, patch] = matches[0]!;
  if (claimedBase?.toLowerCase() !== baseSha.toLowerCase()) return { reason: `${candidate.agent}: candidate base SHA does not match pair base` };
  if (!patch?.trim() || !/^diff --git /m.test(patch)) return { reason: `${candidate.agent}: candidate block is not a unified Git diff` };
  return { patch: `${patch.trimEnd()}\n` };
}

function runGit(cwd: string, indexPath: string, objectDir: string, alternateObjectDir: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDir,
    },
    ...(input === undefined ? {} : { input }),
  });
}

function withPrivateIndex<T>(cwd: string, baseSha: string, action: (indexPath: string, objectDir: string, alternateObjectDir: string) => T): T {
  const temp = mkdtempSync(join(tmpdir(), 'classic-sidetab-reconcile-'));
  const indexPath = join(temp, 'index');
  const objectDir = join(temp, 'objects');
  mkdirSync(objectDir, { recursive: true, mode: 0o700 });
  try {
    const alternateObjectDir = stripGitLineEnding(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
      cwd, encoding: 'utf8', timeout: 3_000, maxBuffer: 1_024, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    runGit(cwd, indexPath, objectDir, alternateObjectDir, ['read-tree', baseSha]);
    return action(indexPath, objectDir, alternateObjectDir);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function applyCandidates(cwd: string, baseSha: string, patches: readonly string[]): string {
  return withPrivateIndex(cwd, baseSha, (indexPath, objectDir, alternateObjectDir) => {
    for (const patch of patches) runGit(cwd, indexPath, objectDir, alternateObjectDir, ['apply', '--cached', '--binary', '-'], patch);
    return runGit(cwd, indexPath, objectDir, alternateObjectDir, ['diff', '--cached', '--binary', '--no-ext-diff', baseSha]);
  });
}

interface CandidateChangeRange {
  path: string;
  start: number;
  count: number;
  unknown?: true;
}

function candidateChangeRanges(cwd: string, baseSha: string, patch: string): CandidateChangeRange[] {
  return withPrivateIndex(cwd, baseSha, (indexPath, objectDir, alternateObjectDir) => {
    runGit(cwd, indexPath, objectDir, alternateObjectDir, ['apply', '--cached', '--binary', '-'], patch);
    const paths = runGit(cwd, indexPath, objectDir, alternateObjectDir,
      ['diff', '--cached', '--name-only', '-z', '--no-renames', baseSha]).split('\0').filter(Boolean);
    return paths.flatMap((path) => {
      const diff = runGit(cwd, indexPath, objectDir, alternateObjectDir,
        ['diff', '--cached', '--unified=0', '--no-ext-diff', '--no-renames', baseSha, '--', path]);
      const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
        path,
        start: Number(match[1]),
        count: match[2] === undefined ? 1 : Number(match[2]),
      }));
      return ranges.length ? ranges : [{ path, start: 0, count: 0, unknown: true as const }];
    });
  });
}

function changeRangesOverlap(left: CandidateChangeRange, right: CandidateChangeRange): boolean {
  if (left.unknown || right.unknown) return true;
  if (left.count === 0 && right.count === 0) return left.start === right.start;
  if (left.count === 0) return left.start >= right.start && left.start <= right.start + right.count;
  if (right.count === 0) return right.start >= left.start && right.start <= left.start + left.count;
  return left.start < right.start + right.count && right.start < left.start + left.count;
}

function findCandidateOverlap(codex: readonly CandidateChangeRange[], claude: readonly CandidateChangeRange[]): string | undefined {
  for (const left of codex) {
    for (const right of claude) {
      if (left.path === right.path && changeRangesOverlap(left, right)) return left.path;
    }
  }
  return undefined;
}

function repositoryRoot(cwd: string): string {
  return stripGitLineEnding(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }));
}

/** Apply proposed diffs to a private Git index rooted at the pair's pinned base; never touches checkout files. */
export function reconcileClassicSidetabCandidatePatches(input: {
  cwd: string;
  baseSha: string;
  codex: string;
  claude: string;
}): ClassicSidetabReconcileResult {
  const { cwd, baseSha } = input;
  if (!SHA.test(baseSha)) return { status: 'unavailable', baseSha, reason: 'pair base SHA is unavailable or invalid' };
  const codex = extractCandidate({ agent: 'codex', content: input.codex }, baseSha);
  const claude = extractCandidate({ agent: 'claude', content: input.claude }, baseSha);
  if (!codex.patch || !claude.patch) {
    return {
      status: 'unavailable', baseSha,
      reason: [codex.reason, claude.reason].filter(Boolean).join('; '),
    };
  }
  let root: string;
  try {
    root = repositoryRoot(cwd);
  } catch (error) {
    return { status: 'unavailable', baseSha, reason: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) };
  }
  let codexRanges: CandidateChangeRange[];
  let claudeRanges: CandidateChangeRange[];
  try {
    codexRanges = candidateChangeRanges(root, baseSha, codex.patch);
    claudeRanges = candidateChangeRanges(root, baseSha, claude.patch);
  } catch (error) {
    return { status: 'unavailable', baseSha, reason: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) };
  }
  const overlap = findCandidateOverlap(codexRanges, claudeRanges);
  if (overlap) {
    return {
      status: 'conflict', baseSha,
      reason: `candidate diffs overlap base changes in ${overlap}; both originals are preserved`,
      conflictingPatchOrder: ['codex', 'claude'],
    };
  }
  try {
    const patch = applyCandidates(root, baseSha, [codex.patch, claude.patch]);
    if (!patch.trim()) return { status: 'unavailable', baseSha, reason: 'candidate diffs produced no changes' };
    return { status: 'merged', baseSha, patch };
  } catch (error) {
    // Each diff applied to the pinned base independently, but the combined
    // apply did not; preserve both inputs and require a parent decision.
    return {
      status: 'conflict',
      baseSha,
      reason: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800),
      conflictingPatchOrder: ['codex', 'claude'],
    };
  }
}
