import { describe, test, expect } from 'bun:test';
import {
  createSearchPlannerState,
  handleRepeatedCandidateListing,
  rememberCandidateListingResult,
} from '../src/session-runtime/search-processor';

/**
 * CC (2026-04-25, log/debug-20260425172430.log) — turn-aware planner.
 *
 * Reproducer: codex/gpt-5.4 issues a same-turn parallel `[Grep, Grep, Grep]`
 * batch on the user's evaluation prompt. With AA + BB landed, the burst
 * was absorbed at turn 0 (BB threshold = 3 for codex) but turn 1 still
 * blocked all 3 fan-out greps because phase != 'idle' was treated as a
 * cross-turn repeat. CC distinguishes same-turn fan-out (model couldn't
 * have seen prior results yet — pass through) from cross-turn repeat
 * (model saw results, still spamming — block).
 */
describe('handleRepeatedCandidateListing — CC turn-aware fan-out', () => {
  function grepListingArgs(path: string, glob = ''): Record<string, unknown> {
    return { pattern: 'foo|bar', path, glob, output_mode: 'files_with_matches' };
  }

  test('first candidate listing is allowed after an earlier Read; later repeats stay guarded', () => {
    const planner = createSearchPlannerState();
    expect(handleRepeatedCandidateListing('Read', { file_path: 'src/a.ts' }, true, undefined, planner, 0).kind).toBe('none');
    expect(planner.phase).toBe('inspecting');
    expect(planner.pendingCandidateScopeKey).toBeNull();

    const first = handleRepeatedCandidateListing('Grep', grepListingArgs('src', '*.ts'), true, undefined, planner, 1);
    expect(first.kind).toBe('none');
    expect(planner.phase).toBe('listed');
    expect(planner.scopeOpenedAtTurn).toBe(1);

    const repeat = handleRepeatedCandidateListing('Grep', grepListingArgs('test', '*.test.ts'), true, undefined, planner, 2);
    expect(repeat.kind).toBe('block');
  });

  test('same-turn parallel fan-out with different scopes all pass through', () => {
    const planner = createSearchPlannerState();

    // Turn 0, call 1 — opens the candidate scope.
    const r1 = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('src', '*.ts'),
      true,
      'codex',
      planner,
      0,
    );
    expect(r1.kind).toBe('none');
    expect(planner.phase).toBe('listed');
    expect(planner.scopeOpenedAtTurn).toBe(0);

    // Turn 0, call 2 — different scope, same turn → fan-out pass-through.
    const r2 = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('test', '*.test.ts'),
      true,
      'codex',
      planner,
      0,
    );
    expect(r2.kind).toBe('none');

    // Turn 0, call 3 — yet another scope, same turn → still pass-through.
    const r3 = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('docs', '*.md'),
      true,
      'codex',
      planner,
      0,
    );
    expect(r3.kind).toBe('none');
  });

  test('cross-turn repeat after results land is still blocked', () => {
    const planner = createSearchPlannerState();

    // Turn 0 — open scope and feed back result candidates.
    handleRepeatedCandidateListing('Grep', grepListingArgs('src', '*.ts'), true, 'codex', planner, 0);
    rememberCandidateListingResult(
      'Grep',
      grepListingArgs('src', '*.ts'),
      'Found 5\nsrc/a.ts\nsrc/b.ts',
      true,
      planner,
    );
    expect(planner.suggestedCandidates.length).toBeGreaterThan(0);

    // Turn 1 — model still issues a broad listing instead of inspecting.
    // Codex family has auto-narrow available (suggestedCandidates non-empty),
    // so the codex path returns auto-read instead of block.
    const r = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('test', '*.test.ts'),
      true,
      'codex',
      planner,
      1,
    );
    expect(r.kind).toBe('auto-read');

    // Continue draining auto-narrow candidates until the budget runs out,
    // at which point the next cross-turn broad listing must hard-block.
    handleRepeatedCandidateListing('Grep', grepListingArgs('docs', '*.md'), true, 'codex', planner, 2);
    const blocked = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('lib', '*.ts'),
      true,
      'codex',
      planner,
      3,
    );
    expect(blocked.kind).toBe('block');
  });

  test('non-codex family cross-turn repeat blocks immediately (no auto-narrow)', () => {
    const planner = createSearchPlannerState();

    handleRepeatedCandidateListing('Grep', grepListingArgs('src', '*.ts'), true, undefined, planner, 0);
    rememberCandidateListingResult(
      'Grep',
      grepListingArgs('src', '*.ts'),
      'Found 5\nsrc/a.ts\nsrc/b.ts',
      true,
      planner,
    );

    // Turn 1, different scope, non-codex → no auto-narrow path → block.
    const r = handleRepeatedCandidateListing(
      'Grep',
      grepListingArgs('test', '*.test.ts'),
      true,
      undefined,
      planner,
      1,
    );
    expect(r.kind).toBe('block');
  });

  test('legacy callers (no currentTurn) keep pre-CC block semantics', () => {
    const planner = createSearchPlannerState();

    // First call without currentTurn — opens scope, scopeOpenedAtTurn stays null.
    const r1 = handleRepeatedCandidateListing('Grep', grepListingArgs('src', '*.ts'), true, undefined, planner);
    expect(r1.kind).toBe('none');
    expect(planner.scopeOpenedAtTurn).toBeNull();

    // Second call without currentTurn — phase != 'idle' AND scopeOpenedAtTurn === null,
    // so the same-turn fan-out branch does NOT fire → block as before.
    const r2 = handleRepeatedCandidateListing('Grep', grepListingArgs('test', '*.test.ts'), true, undefined, planner);
    expect(r2.kind).toBe('block');
  });

  test('same-turn fan-out after a narrowing-followup tool also passes through', () => {
    // Mirrors the live codex log shape: turn 0 starts with a content-mode
    // Grep (narrowing-followup) which sets phase='inspecting', then 2 more
    // files_with_matches Greps land in the same parallel batch.
    const planner = createSearchPlannerState();

    const r1 = handleRepeatedCandidateListing(
      'Grep',
      { pattern: 'foo', output_mode: 'content', path: 'docs', glob: '*.md' },
      true,
      'codex',
      planner,
      0,
    );
    expect(r1.kind).toBe('none');
    expect(planner.phase).toBe('inspecting');
    expect(planner.scopeOpenedAtTurn).toBe(0);

    const r2 = handleRepeatedCandidateListing('Grep', grepListingArgs('src', '*.ts'), true, 'codex', planner, 0);
    expect(r2.kind).toBe('none');

    const r3 = handleRepeatedCandidateListing('Grep', grepListingArgs('test', '*.test.ts'), true, 'codex', planner, 0);
    expect(r3.kind).toBe('none');
  });
});
