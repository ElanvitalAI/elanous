import type { ModelFamily } from '../models/prompts.js';
import { debug } from '../debug/log.js';

export interface SearchPlannerState {
  phase: 'idle' | 'listed' | 'inspecting';
  pendingCandidateScopeKey: string | null;
  suggestedCandidates: string[];
  nextCandidateIndex: number;
  maxAutoNarrowCandidates: number;
  /** CC (2026-04-25, log/debug-20260425172430) — turn when phase first
   *  transitioned out of 'idle'. Lets `handleRepeatedCandidateListing`
   *  distinguish a same-turn parallel fan-out (multiple Greps issued
   *  together by the model BEFORE seeing any result — pass-through) from
   *  a cross-turn repeat (model saw results and is still spamming broad
   *  searches — block). `null` = not yet opened OR turn info unavailable
   *  (legacy callers without dispatch ctx). */
  scopeOpenedAtTurn: number | null;
}

export function createSearchPlannerState(opts: { maxAutoNarrowCandidates?: number } = {}): SearchPlannerState {
  return {
    phase: 'idle',
    pendingCandidateScopeKey: null,
    suggestedCandidates: [],
    nextCandidateIndex: 0,
    maxAutoNarrowCandidates: Math.max(1, opts.maxAutoNarrowCandidates ?? 2),
    scopeOpenedAtTurn: null,
  };
}

export function getScopedCandidateListingKey(
  name: string,
  args: Record<string, unknown>,
  scopedAnalysis: boolean,
): string | null {
  if (!scopedAnalysis) return null;
  if (name === 'Grep') {
    const mode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
    if (mode && mode !== 'files_with_matches') return null;
    return [
      'grep',
      typeof args.path === 'string' ? args.path : '.',
      typeof args.glob === 'string' ? args.glob : '',
      typeof args.type === 'string' ? args.type : '',
    ].join('|');
  }
  if (name === 'Glob') {
    return [
      'glob',
      typeof args.path === 'string' ? args.path : '.',
      typeof args.pattern === 'string' ? args.pattern : '',
    ].join('|');
  }
  if (name === 'ListDir') {
    return [
      'listdir',
      typeof args.path === 'string' ? args.path : '.',
    ].join('|');
  }
  return null;
}

export function isNarrowingFollowupTool(name: string, args: Record<string, unknown>): boolean {
  if (name === 'Read' || name === 'Lsp' || name === 'AstGrep' || name === 'ast_grep_search') return true;
  if (name === 'Grep') {
    const mode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
    return mode === 'content' || mode === 'count';
  }
  return false;
}

export function buildRepeatedCandidateListingBlockMessage(candidates: readonly string[] = []): string {
  const followup = candidates.length > 0
    ? `Try next: ${candidates.slice(0, 2).map(p => `Read(file_path=${JSON.stringify(p)})`).join(' ; ')} ; or use AstGrep/Lsp.`
    : 'Use Read, AstGrep, Lsp, or Grep(output_mode="content"|"count") on the current candidates.';
  return [
    'RUNTIME BLOCKED — candidate list already exists for this turn.',
    'Do not issue another `files_with_matches` search yet.',
    followup,
  ].join(' ');
}

export function handleRepeatedCandidateListing(
  name: string,
  args: Record<string, unknown>,
  scopedAnalysis: boolean,
  modelFamily: ModelFamily | undefined,
  planner: SearchPlannerState | undefined,
  // CC (2026-04-25) — current tool-loop turn index. Lets us distinguish
  // a same-turn parallel fan-out (pass-through) from a cross-turn repeat
  // (block). Optional for backwards-compat with callers that haven't
  // plumbed the dispatch ctx yet — undefined falls back to pre-CC
  // semantics so older tests + paths keep working.
  currentTurn?: number,
): { kind: 'none' } | { kind: 'block'; message: string } | { kind: 'auto-read'; filePath: string } {
  if (!planner) return { kind: 'none' };
  if (isNarrowingFollowupTool(name, args)) {
    const prevPhase = planner.phase;
    planner.phase = 'inspecting';
    if (prevPhase === 'idle' && currentTurn !== undefined && planner.scopeOpenedAtTurn === null) {
      planner.scopeOpenedAtTurn = currentTurn;
    }
    if (prevPhase !== 'inspecting') {
      debug.log('session-runtime.search', 'planner.phase-transition', {
        reason: 'narrowing-followup-tool',
        tool: name,
        prevPhase,
        nextPhase: planner.phase,
        scopeOpenedAtTurn: planner.scopeOpenedAtTurn,
      });
    }
    return { kind: 'none' };
  }
  const candidateKey = getScopedCandidateListingKey(name, args, scopedAnalysis);
  if (!candidateKey) return { kind: 'none' };
  // A narrowing read can move the planner to inspecting before any listing ran.
  // Only a recorded candidate scope makes a later listing a repeat.
  if (planner.phase !== 'idle' && planner.pendingCandidateScopeKey !== null) {
    // CC same-turn fan-out: when the current call lands in the SAME turn
    // that opened the scope, the model couldn't possibly have seen the
    // earlier results yet — this is parallel exploration, not a stuck
    // loop. Pass through. Cross-turn repeats (model saw results, still
    // issuing broad listings) keep the existing auto-narrow / block
    // logic. See log/debug-20260425172430 for the over-block reproducer.
    if (
      currentTurn !== undefined
      && planner.scopeOpenedAtTurn !== null
      && planner.scopeOpenedAtTurn === currentTurn
    ) {
      debug.log('session-runtime.search', 'planner.same-turn-fanout-passthrough', {
        tool: name,
        candidateKey,
        currentTurn,
        scopeOpenedAtTurn: planner.scopeOpenedAtTurn,
        phase: planner.phase,
        suggestedCandidateCount: planner.suggestedCandidates.length,
      });
      return { kind: 'none' };
    }
    if (
      modelFamily === 'codex'
      && planner.suggestedCandidates.length > 0
      && planner.nextCandidateIndex < Math.min(planner.suggestedCandidates.length, planner.maxAutoNarrowCandidates)
    ) {
      const filePath = planner.suggestedCandidates[planner.nextCandidateIndex]!;
      planner.phase = 'inspecting';
      planner.nextCandidateIndex += 1;
      debug.log('session-runtime.search', 'planner.auto-narrow', {
        tool: name,
        candidateKey,
        filePath,
        suggestedCandidateCount: planner.suggestedCandidates.length,
        nextCandidateIndex: planner.nextCandidateIndex,
        maxAutoNarrowCandidates: planner.maxAutoNarrowCandidates,
      });
      return { kind: 'auto-read', filePath };
    }
    debug.log('session-runtime.search', 'planner.repeated-listing-blocked', {
      tool: name,
      candidateKey,
      phase: planner.phase,
      currentTurn,
      scopeOpenedAtTurn: planner.scopeOpenedAtTurn,
      suggestedCandidateCount: planner.suggestedCandidates.length,
      nextCandidateIndex: planner.nextCandidateIndex,
      maxAutoNarrowCandidates: planner.maxAutoNarrowCandidates,
    });
    return { kind: 'block', message: buildRepeatedCandidateListingBlockMessage(planner.suggestedCandidates) };
  }
  const firstCandidateScope = planner.pendingCandidateScopeKey === null;
  planner.phase = 'listed';
  planner.pendingCandidateScopeKey = candidateKey;
  planner.nextCandidateIndex = 0;
  if (currentTurn !== undefined && (firstCandidateScope || planner.scopeOpenedAtTurn === null)) {
    planner.scopeOpenedAtTurn = currentTurn;
  }
  debug.log('session-runtime.search', 'planner.candidate-scope-opened', {
    tool: name,
    candidateKey,
    phase: planner.phase,
    scopeOpenedAtTurn: planner.scopeOpenedAtTurn,
  });
  return { kind: 'none' };
}

function extractSuggestedCandidatesFromText(text: string): string[] {
  const marker = '[Suggested next Read/Lsp candidates]';
  const idx = text.indexOf(marker);
  if (idx < 0) return [];
  const lines = text
    .slice(idx + marker.length)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) break;
    out.push(line.slice(2));
  }
  return out;
}

function looksLikeCandidatePath(line: string): boolean {
  if (!line) return false;
  if (line.startsWith('[') || line.startsWith('(') || line.startsWith('…')) return false;
  if (line.startsWith('... ') || line.startsWith('Full output saved to')) return false;
  if (line.includes(' matched ') || line.startsWith('Found ')) return false;
  return (
    line.startsWith('/')
    || line.startsWith('./')
    || /^[A-Za-z0-9._-]+\//.test(line)
  );
}

function extractFallbackCandidatesFromText(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!looksLikeCandidatePath(line)) continue;
    out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

function extractCandidatePathsFromText(text: string): string[] {
  const suggested = extractSuggestedCandidatesFromText(text);
  const fallback = extractFallbackCandidatesFromText(text);
  return [...new Set([...suggested, ...fallback])].slice(0, 5);
}

export function rememberCandidateListingResult(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  scopedAnalysis: boolean,
  planner: SearchPlannerState | undefined,
): void {
  if (!planner) return;
  const candidateKey = getScopedCandidateListingKey(name, args, scopedAnalysis);
  if (!candidateKey) return;
  const text = typeof result === 'string'
    ? result
    : result && typeof result === 'object' && typeof (result as any).output === 'string'
      ? (result as any).output
      : '';
  const candidates = extractCandidatePathsFromText(text);
  if (candidates.length === 0) return;
  planner.phase = 'listed';
  planner.pendingCandidateScopeKey = candidateKey;
  planner.suggestedCandidates = candidates;
  planner.nextCandidateIndex = 0;
  debug.log('session-runtime.search', 'planner.candidates-remembered', {
    tool: name,
    candidateKey,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 3),
  });
}
