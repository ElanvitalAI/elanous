import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRemainings,
  recordFollowUpOnMerge,
  remainingPiecesFromPrBody,
  type FollowUpDraftRecord,
} from '../src/self-implement/follow-up-goals.js';
import { declaredNewFilePaths } from '../src/self-implement/goal-new-paths.js';

/**
 * PR #29858 본문 스냅샷(`.agent/prs/29858.md`)의 «남은 조각» 계약 게이트.
 *
 * ⭐ 왜 «테스트»인가 — 이 PR 의 수리 deliverable 은 코드가 아니라 **PR 본문**이다(리뷰 must-fix:
 *   수용선 0.2.33 · 대표 10-18, "생산 진입점 배선 + 실물 증거"가 이 PR 에서 «미충족»으로 남는다는
 *   점을 «남은 것»에 분명히 적는다). 본문은 사람이 읽지만 병합 뒤에는 **생산 경로도 읽는다**:
 *   `src/self-implement/orchestrator.ts` 의 `draftFollowUpAfterMerge` → `recordFollowUpOnMerge`
 *   → `collectRemainings({ prBody })` → `remainingPiecesFromPrBody`(머리 `## 남은 조각` 아래의
 *   글머리만 수확). ⇒ 그래서 이 게이트는 합성 fixture 가 아니라 **실제 커밋된 본문**을 그 생산
 *   경로에 먹여 «배선 조각이 후속 골 초안 원장에 살아남는가»를 잰다. 머리를 `## 남은 것` 으로
 *   쓰면 파서는 `[]` 를 내고 그 조각은 조용히 사라진다 — 이 게이트가 막는 것이 그것이다.
 *
 * ⛔ 이 게이트가 «하지 않는» 것: 수용선 0.2.33 이 충족됐다고 판정하지 않는다. 반대로, 본문이
 *    그것을 «미충족»으로 밝히고 있는지(과장 주장이 없는지)를 판정한다.
 *
 * 두 번째 생산 진입점: «신설:» 줄은 `src/self-implement/goal-new-paths.ts` 의
 * `declaredNewFilePaths`(저작 TRACED PATHS ⊕ orchestrator 범위 검사가 공유)가 읽는 문면이어야 한다.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PR_BODY_PATH = join(REPO, '.agent', 'prs', '29858.md');
const GOAL_FILE = join(REPO, 'docs', 'goals', 'GOAL-src-grounding-ref-index-ts-src-self-implement-goal-author-ts-ux-4cfdf6c5-2026-10-21.md');

/** base(이 PR 이전 가지)에는 스냅샷이 없다 — ENOENT 스택 대신 실패 이유를 말한다. */
function prBody(): string {
  if (!existsSync(PR_BODY_PATH)) throw new Error(`PR 본문 스냅샷이 이 가지에 커밋돼 있지 않다: ${PR_BODY_PATH}`);
  return readFileSync(PR_BODY_PATH, 'utf8');
}

/** 머리 `start` 아래부터 다음 머리 `end` 앞까지의 절 본문(`end` 가 없으면 파일 끝까지). */
function sectionOf(body: string, start: string, end?: string): string {
  const lines = body.split('\n');
  const from = lines.findIndex((line) => line.trim() === start);
  if (from === -1) return '';
  const to = end === undefined ? -1 : lines.findIndex((line) => line.trim() === end);
  return lines.slice(from + 1, to === -1 ? lines.length : to).join('\n');
}

describe('PR #29858 body — 남은 조각', () => {
  test('the remaining-work section carries the heading the production parser reads, and names «남은 것»', () => {
    // 리뷰 must-fix 의 문구(«남은 것»)와 저장소 생산 파서의 머리(`## 남은 조각`)가 같은 절을 가리킨다.
    const remaining = sectionOf(prBody(), '## 남은 조각');
    expect(remaining).not.toBe('');
    expect(remaining).toContain('«남은 것»');
    expect(remaining).toContain('remainingPiecesFromPrBody');
  });

  test('states that acceptance line 0.2.33 (production wiring + real evidence) is «미충족» in this PR', () => {
    const remaining = sectionOf(prBody(), '## 남은 조각');
    expect(remaining).toContain('0.2.33');
    expect(remaining).toContain('생산 진입점 배선 + 실물 증거');
    expect(remaining).toContain('«미충족»');
    // «미충족» 선언에 근거(배선 부재 · 의도적 경계)가 붙는다 — 판정만 있고 이유가 없으면 안 된다.
    expect(remaining).toContain('배선되지 않았다');
    expect(remaining).toContain('의도적 경계');
  });

  test('the real-evidence section reports measured values and says the wiring evidence is absent', () => {
    const evidence = sectionOf(prBody(), '## 실물', '## 남은 조각');
    expect(evidence).toContain('bun test src/grounding/proactive-ground.test.ts');
    expect(evidence).toContain('10 pass');
    expect(evidence).toContain('26 expect() calls');
    expect(evidence).toContain('bun test src/grounding/ref-index.test.ts src/self-implement/goal-author.test.ts');
    expect(evidence).toContain('511 pass');
    expect(evidence).toContain('2570 expect() calls');
    expect(evidence).toContain('bun test test/pr-29858-remaining-piece.test.ts');
    // 골 문면의 기준값(498 · 측정 시점 main f345b450b4)을 베끼지 않고 실측값으로 바꿨다고 밝힌다.
    expect(evidence).toContain('498');
    expect(evidence).toContain('f345b450b4');
    // 수용선이 요구하는 «생산 진입점을 지나는 실물 증거»가 이 PR 에 없다는 선언이 같은 절에 있다.
    expect(evidence).toContain('«없다»');
  });

  test('the new-file declaration is written in the form the scope check reads', () => {
    // `declaredNewFilePaths` 는 저작(TRACED PATHS)과 실행(orchestrator 범위 검사)이 공유하는 파서다.
    // «신규 파일 선언(newFiles):» 같은 산문은 그것이 읽지 못한다 — «신설:» 줄만 읽는다.
    expect(declaredNewFilePaths(prBody())).toEqual([
      '.agent/prs/29858.md',
      'test/pr-29858-remaining-piece.test.ts',
    ]);
  });

  test('the wiring piece survives the production merge path into the follow-up draft ledger', async () => {
    const body = prBody();
    const pieces = remainingPiecesFromPrBody(body);
    expect(pieces.length).toBe(1);
    expect(pieces[0]).toContain('goal-author');
    expect(pieces[0]).toContain('queryReferences');
    expect(pieces[0]).toContain('ours');
    // 병합 시점이 부르는 집계 경로도 같은 조각 하나만 낸다(이 PR 에 should-fix 는 없다).
    expect(collectRemainings({ prBody: body })).toEqual(pieces);

    // 생산 병합 경로 — `draftFollowUpAfterMerge` 가 부르는 그 함수. 저장소는 전부 주입한다
    // (운영 원장·대기열 무접촉 · `shadow` 모드라 큐에도 넣지 않는다).
    const rows: FollowUpDraftRecord[] = [];
    const record = await recordFollowUpOnMerge(
      {
        prNumber: 29858,
        feature: 'PR #29858 — proactiveReferences 조각(골 분해 1/2)',
        prBody: body,
        goalFile: GOAL_FILE,
      },
      {
        mode: 'shadow',
        readDrafts: () => [],
        appendDraft: (row) => { rows.push(row); },
        log: () => { /* 게이트는 원장 밖 로그를 쓰지 않는다 */ },
      },
    );
    expect(record?.cellId).toBe('879228c6feeb746c');
    expect(record?.kind).toBe('draft');
    expect(record?.remainings).toEqual(pieces);
    expect(record?.draft).toContain('다음 조각 = goal-author');
    expect(record?.draft).toContain('origin/main 에서 시작 · 남은 것만');
    expect(rows.length).toBe(1);
  });
});
