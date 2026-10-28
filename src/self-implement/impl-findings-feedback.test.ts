/** IMPL-FINDINGS-FEEDBACK — 병합 PR 본문 절의 postland 되먹임 격리 시험.
 *  원장 1회 기록(중복 억제)·관련 기록만 다음 저작 입력 인용·후속 초안 생성(자동 발사 없음)을 관측한다. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMPL_FINDINGS_LEDGER_EVENT,
  parseImplFindings,
  recordImplFindingsFeedback,
  type ImplFindingsFeedbackInput,
} from './impl-findings-feedback.js';
import { loadRunLedger, runLedgerPath } from './run-ledger.js';

const prBody = [
  '# PR 본문',
  '',
  '## 구현이 밝힌 요구사항',
  '- src/self-implement/impl-findings-feedback.ts 를 신설했다',
  '',
  '## 새 범위',
  '- src/self-implement/impl-findings-feedback.test.ts 격리 시험',
  '',
  '## 남은 것',
  '- 후속 칸 자동 발사 배선',
  ''].join('\n');

const ask = '대상 경로: src/self-implement/impl-findings-feedback.ts · src/self-implement/impl-findings-feedback.test.ts';

const lessonPrompt = '- [AL-eb6797f3b7] 칸=RUN-AUTOPSY-LOOP · class=e-format-trap · lesson=원문을 붙여 넣지 않는다';

describe('impl-findings-feedback', () => {
  test('원장 저장: 병합 PR의 exact-head 구현이 밝힌 요구사항·새 범위·남은 것을 idempotent 원장a', async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'impl-findings-ledger-'));
    try {
      const events: Array<{ category: string; event: string; data: unknown }> = [];
      const followUpCalls: Array<{ prNumber: number; prBody?: string }> = [];
      const input: ImplFindingsFeedbackInput = {
        runId: 'run-0123456789abcdef0123456789abcdef',
        prNumber: 4321,
        prBody,
        ask,
        goalId: '0001f53779f5a2a2',
      };
      const seams = {
        dir: ledgerDir,
        log: (category: string, event: string, data?: unknown) => { events.push({ category, event, data }); },
        selectLessons: () => ({ ids: ['AL-eb6797f3b7'], prompt: lessonPrompt, status: 'loaded' as const, invalidRows: 0 }),
        followUp: (async (merge: { prNumber: number; prBody?: string }) => {
          followUpCalls.push({ prNumber: merge.prNumber, prBody: merge.prBody });
          return { prNumber: merge.prNumber, cellId: '0001f53779f5a2a2', depth: 1, draftHash: 'x', kind: 'draft' as const,
            originalAskFirstLine: ask, remainings: parseImplFindings(merge.prBody ?? '').remaining, queued: false };
        }) as never,
      };

      const first = await recordImplFindingsFeedback(input, seams);

      // 절 파싱 — 구현이 밝힌 요구사항·새 범위·남은 것
      expect(first.findings.requirements).toContain('impl-findings-feedback.ts');
      expect(first.findings.newScope).toContain('impl-findings-feedback.test.ts');
      expect(first.findings.remaining).toEqual(['후속 칸 자동 발사 배선']);

      // 원장 1회 기록
      expect(first.appended).toBe(true);
      const ledgerPath = runLedgerPath(input.runId, ledgerDir);
      const entries = loadRunLedger(input.runId, ledgerDir) ?? [];
      const feedbackEntries = entries.filter((entry) => entry.event === IMPL_FINDINGS_LEDGER_EVENT);
      expect(feedbackEntries).toHaveLength(1);
      expect(feedbackEntries[0]?.data.prNumber).toBe(4321);
      expect(feedbackEntries[0]?.data.remaining).toEqual(['후속 칸 자동 발사 배선']);
      expect(ledgerPath.endsWith('.jsonl')).toBe(true);

      // 관련 기록만 다음 저작 입력에 인용 — 요구사항·새 범위·관련 교훈 프롬프트, 선택/생략 수 로그
      expect(first.authoringInjection).toContain('impl-findings-feedback.ts 를 신설했다');
      expect(first.authoringInjection).toContain('impl-findings-feedback.test.ts 격리 시험');
      expect(first.authoringInjection).toContain(lessonPrompt);
      expect(first.lessonIds).toEqual(['AL-eb6797f3b7']);
      expect(first.injectedSections).toEqual(['구현이 밝힌 요구사항', '새 범위']);
      const injectionEvent = events.find(({ event }) => event === 'authoring-injection');
      expect(injectionEvent?.data).toMatchObject({ selected: 1, invalidRows: 0, status: 'loaded' });
      expect(events.some(({ event }) => event === 'recorded')).toBe(true);

      // 후속 초안 생성 — 자동 발사 없음(queued=false)
      expect(followUpCalls).toEqual([{ prNumber: 4321, prBody }]);
      expect(first.followUp?.queued).toBe(false);
      expect(events.filter(({ event }) => event === 'follow-up-drafted')).toHaveLength(1);

      // 재주입 — 중복 억제: 같은 PR 은 다시 기록하지 않는다
      const second = await recordImplFindingsFeedback(input, seams);
      expect(second.appended).toBe(false);
      const entriesAfter = loadRunLedger(input.runId, ledgerDir) ?? [];
      expect(entriesAfter.filter((entry) => entry.event === IMPL_FINDINGS_LEDGER_EVENT)).toHaveLength(1);
      expect(events.some(({ event }) => event === 'duplicate-suppressed')).toBe(true);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});