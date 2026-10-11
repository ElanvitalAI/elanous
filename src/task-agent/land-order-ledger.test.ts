import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLandOrderRow, joinLandOrderRow, landOrderLedgerPath, type LandOrderRow } from './land-order-ledger.js';
import type { ParsedReviewResult } from './review-result-capture.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const AT = '2026-10-11T01:10:00.000Z';
const review: ParsedReviewResult = { pr: 30, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', head: HEAD, error: null };
const row = (): LandOrderRow => joinLandOrderRow({
  overlapEvidence: { pr: 30, head: HEAD, cardId: 'ta-lo-1', gate: { head: HEAD, baseCommit: BASE, passed: true }, reviewResult: 'review-results/ta-lo-1-30-aaaaaaaaaaaa.json' },
  reviewResult: review,
  landed: { ok: true, landAttempt: { attempt: 1 } },
  at: AT,
});

describe('TA-LAND-ORDER-LEDGER — 겹침 쌍·착지 순서 원장(첫 조각)', () => {
  test('① 겹침 증거 ⊕ 리뷰 결과 ⊕ land 결과 → 칸이 다 찬 한 행', () => {
    expect(row()).toEqual({ pr: 30, head: HEAD, cardId: 'ta-lo-1', gateBase: BASE, reviewVerdict: 'pass', mustFix: 0, landOk: true, landClass: null, at: AT });
  });

  test('② review-results 파일을 못 읽으면 reviewVerdict missing — 0 으로 쓰지 않는다', () => {
    const missing = joinLandOrderRow({
      overlapEvidence: { pr: 30, head: HEAD, cardId: 'ta-lo-1', gate: { head: HEAD, baseCommit: BASE, passed: true } },
      reviewResult: null,
      landed: { ok: false, landAttempt: { attempt: 1, class: 'infra', reason: 'precondition-local-head-clean-tree', retryAllowed: true } },
      at: AT,
    });
    expect(missing.reviewVerdict).toBe('missing');
    expect(missing.mustFix).toBeNull();
    expect(missing.landOk).toBe(false);
    expect(missing.landClass).toBe('infra');
  });

  test('③ 같은 pr+head 를 두 번 append 해도 원장은 한 줄', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'ta-land-order-')), 'task-agent-actions.json');
    appendLandOrderRow(statePath, row());
    appendLandOrderRow(statePath, row());
    const lines = readFileSync(landOrderLedgerPath(statePath), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(row());
  });
});
