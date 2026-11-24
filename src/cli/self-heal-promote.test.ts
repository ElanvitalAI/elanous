// ── self observe 2층 시험 — «인지» 반복 꼴 감지·승격 + «칸 초안은 출력이지 실행 아님» (ELN-OP-SELF-HEAL-1123 2·3층) ──
// 규율: 인라인 문자열 픽스처 · 기대값 리터럴 · 스파이로 «원장 쓰기 0회»를 잠근다.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { nextReleaseVersion, observeSelfSignals, parseSelfAuditRows, promotionDraft, registerSelfObserveCommand, selfHealCellId } from './self-observe.js';

afterEach(() => { process.exitCode = 0; });

const NOW = new Date('2026-11-23T10:00:00.000Z');
const HOUR_WINDOW = { since: '2026-11-23T09:00:00.000Z', until: '2026-11-23T10:00:00.000Z' };

// 같은 서명 2회(사유의 uid 만 다른 숫자 — 정규화 키가 같은 꼴로 봐야 한다) + 다른 서명 1회 + 창 밖 1회
const REPEAT_FIXTURE = [
  '{"ts":"2026-11-23T09:20:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: state folder /tmp/x belongs to uid 501","sha256":"sha-same-cmd"}',
  '{"ts":"2026-11-23T09:40:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: state folder /tmp/x belongs to uid 502","sha256":"sha-same-cmd"}',
  '{"ts":"2026-11-23T09:50:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: other","sha256":"sha-other-cmd"}',
  '{"ts":"2026-11-23T08:30:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: state folder /tmp/x belongs to uid 503","sha256":"sha-same-cmd"}',
].join('\n');

const observe = (fixture: string) => observeSelfSignals({
  window: HOUR_WINDOW,
  auditRows: parseSelfAuditRows(fixture),
  mailRows: [],
  pendingMail: 0,
  nextVersion: '9.9.99',
});

describe('self observe — 2층 인지(반복 꼴 → 결함 승격 후보)', () => {
  test('다음 판 계산: -dev.N 접미사는 버리고 patch 를 1 올린다', () => {
    expect(nextReleaseVersion('0.3.34-dev.0')).toBe('0.3.35');
    expect(nextReleaseVersion('1.2.3')).toBe('1.2.4');
    expect(() => nextReleaseVersion('가짜')).toThrow();
  });

  test('같은 서명 2회 → 승격 · 사유의 숫자(uid)는 꼴이 아니다 · 창 밖은 계수에 안 들어간다', () => {
    const { denied, promotionCandidates } = observe(REPEAT_FIXTURE);
    expect(denied).toBe(3); // 창 안 3 (09:20 · 09:40 · 09:50), 창 밖 08:30 제외
    expect(promotionCandidates).toHaveLength(1); // sha-same-cmd 2회만 승격 — sha-other-cmd 는 1회
    const candidate = promotionCandidates[0];
    expect(candidate.repeats).toBe(2);
    expect(candidate.firstAt).toBe('2026-11-23T09:20:00.000Z');
    expect(candidate.lastAt).toBe('2026-11-23T09:40:00.000Z');
    expect(candidate.cellId).toMatch(/^ELN-OP-SELF-[0-9A-F]{8}$/);
    expect(candidate.cellId).toBe(selfHealCellId(candidate.signature)); // 같은 꼴 → 같은 이름(추적이 닫힌다)
  });

  test('1회는 사건일 뿐 승격하지 않는다', () => {
    const { promotionCandidates } = observe([
      '{"ts":"2026-11-23T09:20:00.000Z","principal":"eln:tool","action":"do","result":"denied","reason":"once","sha256":"sha-once"}',
    ].join('\n'));
    expect(promotionCandidates).toHaveLength(0);
  });

  test('3회면 계수 3으로 승격하고(2회 이상), 같은 꼴은 창 안 개수만큼 센다', () => {
    const { promotionCandidates } = observe([
      '{"ts":"2026-11-23T09:20:00.000Z","principal":"eln:tool","action":"do","result":"denied","reason":"r","sha256":"s"}',
      '{"ts":"2026-11-23T09:30:00.000Z","principal":"eln:tool","action":"do","result":"denied","reason":"r","sha256":"s"}',
      '{"ts":"2026-11-23T09:40:00.000Z","principal":"eln:tool","action":"do","result":"denied","reason":"r","sha256":"s"}',
    ].join('\n'));
    expect(promotionCandidates).toHaveLength(1);
    expect(promotionCandidates[0].repeats).toBe(3);
  });

  test('칸 초안 문면: ELANOUS_TRACK=OP eln release checklist add <칸이름> --version <다음판> — 붙여 넣을 한 줄', () => {
    const draft = promotionDraft('ELN-OP-SELF-AB12CD34', '9.9.99', 2, 'sig|x', '사유', '2026-11-23T09:40:00.000Z');
    expect(draft).toBe(
      'ELANOUS_TRACK=OP eln release checklist add ELN-OP-SELF-AB12CD34 --version 9.9.99'
      + ' — 근거: ELN-OP-SELF-HEAL-1123 2층 «같은 꼴 2회 = 결함 승격» · 서명 sig|x'
      + ' · 사유 사유 · 마지막 관측 2026-11-23T09:40:00.000Z',
    );
    const { promotionCandidates } = observe(REPEAT_FIXTURE);
    expect(promotionCandidates[0].draft).toContain('--version 9.9.99');
    expect(promotionCandidates[0].draft).toContain('ELANOUS_TRACK=OP eln release checklist add');
  });
});

describe('self observe — 3층 금지: 칸 초안은 출력이지 실행이 아니다', () => {
  test('CLI: 승격 후보가 나와도 칸 생성 실행기 호출은 0회(스파이) — 문면만 찍는다', async () => {
    const cellCreations: string[] = [];
    const logs: string[] = [];
    const program = new Command();
    const self = program.command('self');
    registerSelfObserveCommand(self, {
      now: () => NOW,
      readAudit: () => REPEAT_FIXTURE,
      readMail: () => [],
      readPending: () => 0,
      readVersion: () => '9.9.98',
      out: { log: (line: string) => logs.push(line) },
      createSelfHealCell: (draft: string) => { cellCreations.push(draft); },
    });
    await program.parseAsync(['self', 'observe', '--since', '1h'], { from: 'user' });
    expect(cellCreations).toEqual([]); // checklist add 실행 0회 — 산출물이 «초안»인 이유
    expect(logs[0]).toContain('승격후보 1'); // 회고 한 줄
    expect(logs[1]).toContain('결함 승격 후보 ELN-OP-SELF-');
    expect(logs[2]).toContain('칸 초안(실행 아님');
    expect(logs[2]).toContain('--version 9.9.99'); // 다음 판 = readVersion('9.9.98') + patch 1
  });

  test('모듈은 어떤 원장 쓰기 이음새도 임포트하지 않는다(소스 스캔 — 이전된 retro/daily 규율과 같은 배선 검사)', () => {
    const moduleText = readFileSync(join(import.meta.dir, 'self-observe.ts'), 'utf8');
    expect(moduleText).not.toContain('release-loop/checklist'); // checklist add 실행 모듈
    expect(moduleText).not.toContain('ops-ledger');              // 원장 쓰기
    expect(moduleText).not.toMatch(/spawn[A-Za-z]*\(/);         // 외부 프로세스로 빠져나가는 길
  });
});
