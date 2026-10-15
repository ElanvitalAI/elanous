import { randomUUID } from 'node:crypto';
import { extractExportedSymbols } from '../autopilot/mission-codebase-gate.js';
import { debug, withAmbientSessionScope } from '../debug/log.js';
import { groundPersistently, type PersistentGroundingDeps } from '../skills/tools/persistent-grounding.js';

export interface GroundGoalDeps {
  /** 구현 대상 worktree 경로(git grep·파일 읽기의 cwd). */
  cwd: string;
  extractExportedSymbols?: (path: string, max?: number, cwd?: string) => string[];
  /** false disables the production persistent loop. */
  persistent?: PersistentGroundingDeps | false;
}

/** GR1 — self-implement round-0 objective 를 위한 codebase-only grounding.
 *  persistent loop가 검증한 후보에 export 심볼명만 붙이며 구현 본문·계약 타입은 유출하지 않는다.
 *  web/skill 외부조사(S3)는 호출하지 않는다. fail-soft: 어떤 실패든 '' 반환(goal-loop 을 막지 않는다). */
/** grounding 블록의 머리말. ⚠️ 소비자(goal-author 의 파서)와 **같은 상수를 공유**한다 —
 *  각자 문자열 리터럴로 갖고 있으면 한쪽이 바뀔 때 파싱이 조용히 0건이 된다. */
export const GROUNDING_HEADER = '## Codebase grounding (existing files + exported symbols)';

function safeObserve(event: string, data: Record<string, unknown>, options?: { level: 'warn' }): void {
  try { debug.log('grounding.persistent', event, data, options); } catch { /* observations must not change grounding */ }
}

function safeErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
  } catch {
    return 'unprintable-error';
  }
}

export async function groundGoalInCodebase(goalText: string, deps: GroundGoalDeps): Promise<string> {
  try {
    const startedAt = performance.now();
    if (deps.persistent === false) {
      safeObserve('skipped', { cwd: deps.cwd, reason: 'disabled' });
      return '';
    }
    const sessionId = deps.persistent?.sessionId ?? `grounding-${randomUUID()}`;
    const persistentStartedAt = performance.now();
    const persistent = await withAmbientSessionScope(
      sessionId,
      () => groundPersistently(goalText, deps.cwd, { ...deps.persistent, sessionId }),
    );
    const persistentElapsedMs = performance.now() - persistentStartedAt;
    if (!persistent?.files.length) {
      safeObserve('empty', { cwd: deps.cwd, reason: persistent ? 'no-candidates' : 'failed-or-no-candidates',
        persistentStopReason: persistent?.stopReason ?? null, candidates: 0 });
      return '';
    }
    const renderingStartedAt = performance.now();
    const extract = deps.extractExportedSymbols ?? extractExportedSymbols;
    let symbolsAttached = 0;
    const lines = persistent.files.slice(0, 12).map((path) => {
      const symbols = extract(path, 12, deps.cwd);
      symbolsAttached += symbols.length;
      return symbols.length ? `- ${path}: ${symbols.join(', ')}` : `- ${path}`;
    });
    const evidence = persistent.evidence.slice(0, 12).map((statement) => `- ${statement}`);
    const block = [
      GROUNDING_HEADER,
      ...lines,
      ...(evidence.length ? ['Read-file-referencing completion evidence (preserved verbatim):', ...evidence] : []),
    ].join('\n');
    const renderingElapsedMs = performance.now() - renderingStartedAt;
    safeObserve('completed', {
      cwd: deps.cwd,
      totalElapsedMs: performance.now() - startedAt,
      persistentElapsedMs,
      renderingElapsedMs,
      candidatesFound: persistent.files.length,
      candidatesIncluded: lines.length,
      symbolsAttached,
      evidenceLinesEmitted: evidence.length,
    });
    return block;
  } catch (error) {
    safeObserve('empty', {
      cwd: deps.cwd,
      reason: 'error',
      candidates: 0,
      error: safeErrorMessage(error),
    }, { level: 'warn' });
    return '';
  }
}
