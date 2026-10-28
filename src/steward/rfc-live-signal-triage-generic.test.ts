import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { appendTriageTick, readTriageTicks, triageTickLedgerPath, type TriageTickRecord } from './triage-budget.js';

const RFC_PATH = resolve(import.meta.dir, '../../docs/RFC-live-signal-plugin-generation-2026-10-12.md');
// 골 문면 그대로의 고정 문자열 — `rg -n -F '수용선(0.2.33 부터 필수): 새 코드는 실제 생산' 내부 문서 `RFC-live-signal-plugin-generation-2026-10-12`` 대조.
const ACCEPTANCE_PHRASE = '수용선(0.2.33 부터 필수): 새 코드는 실제 생산';
const SYMPTOMS = ['plan-limit', 'notification-flood', 'banned-fallback'] as const;
const RECORD_HEADING = '### TRIAGE-GENERIC — 운영 증상 셋 처방 기록';

const doc = (): string => readFileSync(RFC_PATH, 'utf8');
const section = (text: string, startMarker: string, endMarker: string): string => {
  const start = text.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
};

describe('RFC TRIAGE-GENERIC 칸 — 문서 문구 대조', () => {
  test('수용선 문구가 문서에 1행 이상 있다(rg -F 고정 문자열 대조)', () => {
    const lines = doc().split('\n').filter(line => line.includes(ACCEPTANCE_PHRASE));
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  test('TRIAGE-GENERIC 칸 1행이 처방 기록 원장 등록 지점을 명시하고 그 지점은 실물과 일치한다', () => {
    const row = doc().split('\n').find(line => line.startsWith('| TRIAGE-GENERIC |'));
    expect(row).toBeDefined();
    expect(row!).toContain('처방 기록 원장');
    expect(row!).toContain('steward/triage-ticks.jsonl');
    expect(row!).toContain('appendTriageTick');
    expect(row!).toContain('readTriageTicks');
    expect(row!).toContain('src/steward/triage-budget.ts');
    expect(row!).toContain('runStewardStageCommand');
    expect(row!).toContain('src/steward/triage.ts');
    expect(row!).toContain('graphs/steward/steward.yaml');
    expect(row!).toContain('graphs/steward/recipes.yaml');

    // 문서가 가리키는 등록 지점은 실물 코드에 실재한다(문서 → 코드 무결성).
    const budget = readFileSync(resolve(import.meta.dir, 'triage-budget.ts'), 'utf8');
    expect(budget).toContain('export function readTriageTicks');
    expect(budget).toContain('export function appendTriageTick');
    expect(budget).toContain("'steward', 'triage-ticks.jsonl'");
    const triage = readFileSync(resolve(import.meta.dir, 'triage.ts'), 'utf8');
    expect(triage).toContain('export async function runStewardStageCommand');
  });

  test('§5 운영 증상 셋이 각각 처방 기록 1건(증상당 기록 행 1줄 · 닫힌 메뉴 구조)', () => {
    const block = section(doc(), RECORD_HEADING, '## §6');
    for (const symptom of SYMPTOMS) {
      const rows = block.split('\n').filter(line => line.startsWith(`| ${symptom} |`));
      expect(rows.length).toBe(1); // 처방 기록 1건
    }
    const header = block.split('\n').find(line => line.includes('처방 메뉴(싼 것부터)'));
    expect(header).toBeDefined();
    expect(header!).toContain('비용 확인');
    expect(header!).toContain('승인 경계');
    expect(header!).toContain('사다리(루프 → 자리 → 사람)');
    // 판정과 집행의 분리 · 기존 실물 재사용(재발명 금지)을 밝힌다.
    expect(block).toContain('triageIssues');
    expect(block).toContain('scheduleTriage');
    expect(block).toContain('appendTriageTick');
  });

  test('문서가 새로 인용하는 저장소 경로는 모두 실재한다(깨진 링크 0)', () => {
    const text = doc();
    const slices = [section(text, RECORD_HEADING, '## §6'), section(text, '| TRIAGE-GENERIC |', '## §9')];
    const cited = new Set<string>();
    for (const slice of slices) {
      for (const match of slice.matchAll(/`((?:src|graphs|docs|scripts)\/[A-Za-z0-9._/-]+\.(?:ts|md|yaml|json))`/g)) cited.add(match[1]!);
    }
    expect(cited.size).toBeGreaterThan(0);
    const missing = [...cited].filter(path => !existsSync(resolve(import.meta.dir, '../..', path)));
    expect(missing).toEqual([]);
  });
});

describe('처방 기록 원장 장치(격리 tmpdir — 실물 appendTriageTick/readTriageTicks 경로)', () => {
  test('운영 증상 셋이 각각 처방 기록 1건을 원장에 남긴다', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-triage-generic-'));
    try {
      const prescriptions: Record<(typeof SYMPTOMS)[number], string> = {
        'plan-limit': '일시 정지 후 리셋 뒤 이어감',
        'notification-flood': '댓글 대신 라벨',
        'banned-fallback': '금지 대체 차단 후 원 모델 재시도',
      };
      for (const symptom of SYMPTOMS) {
        const record: TriageTickRecord = {
          at: '2026-10-27T00:00:00.000Z', mode: 'shadow', key: symptom, ticks: 1, issues: 1,
          deadlineMs: 240_000, perIssueMs: 90_000, concurrency: 4,
          reused: 0, judged: 1, timedOut: 0, deferred: 0,
          health: 'degraded', degraded: [symptom], healed: [], liveStreak: 0, liveEligible: false,
          events: [{ index: 1, cycle: 1, issue: symptom, outcome: 'judged', degraded: true, why: `${symptom} — 처방 1건: ${prescriptions[symptom]}` }],
        };
        appendTriageTick(root, record);
      }
      expect(existsSync(triageTickLedgerPath(root))).toBe(true);
      const ticks = readTriageTicks(root);
      expect(ticks).toHaveLength(SYMPTOMS.length);
      for (const [index, symptom] of SYMPTOMS.entries()) {
        expect(ticks[index]?.key).toBe(symptom);
        expect(ticks[index]?.degraded).toEqual([symptom]);
        expect(ticks[index]?.events[0]?.issue).toBe(symptom);
        expect(ticks[index]?.events[0]?.why).toContain('처방 1건');
      }
      // 원장은 루트별로 격리된다 — 다른 루트에서는 이 기록이 보이지 않는다.
      expect(readTriageTicks(join(root, 'elsewhere'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
