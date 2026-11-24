// ── self observe 집계 시험 — ELN-OP-SELF-HEAL-LOOP 1층 «관측» (칸 근거: ELN-OP-SELF-HEAL-1123) ──
// 규율: 픽스처는 전부 인라인 문자열(실기 파일경로 아님) · 기대값은 제품 상수와 독립된 리터럴.
import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { observeSelfSignals, parseSelfAuditRows, parseSelfMailRows, registerSelfObserveCommand, retroLine, selfObserveWindow } from './self-observe.js';

afterEach(() => { process.exitCode = 0; });

const NOW = new Date('2026-11-23T10:00:00.000Z');
const HOUR_WINDOW = { since: '2026-11-23T09:00:00.000Z', until: '2026-11-23T10:00:00.000Z' };

const AUDIT_FIXTURE = [
  // 창 안(09:30) — 자기 도구 거부 1
  '{"ts":"2026-11-23T09:30:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: guard-command","sha256":"sha-cmd-1"}',
  // 창 경계값(정확히 09:00:00) — 경계는 포함된다
  '{"ts":"2026-11-23T09:00:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: boundary","sha256":"sha-cmd-2"}',
  // 창 밖(08:30, 같은 서명) — 세지 않는다
  '{"ts":"2026-11-23T08:30:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"denied","reason":"denied by rule: guard-command","sha256":"sha-cmd-1"}',
  // 창 안이지만 내가 아님(사람 주체) — 자기 거부가 아니다
  '{"ts":"2026-11-23T09:45:00.000Z","principal":"local:501","kind":"cli","action":"do","result":"denied","reason":"denied by rule: guard-command","sha256":"sha-cmd-3"}',
  // 창 안이지만 거부 아님 — 세지 않는다
  '{"ts":"2026-11-23T09:50:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"executed","sha256":"sha-cmd-4"}',
  // 실행기 거부(executor-refused)도 «내가 막힘»이다 — 창 안 1
  '{"ts":"2026-11-23T09:55:00.000Z","principal":"eln:tool","kind":"eln","action":"do","result":"executor-refused","reason":"executor refused: no pane","sha256":"sha-cmd-5"}',
  // 날짜 해석 불가 — 버리지 않고 «못 잰» 것으로 센다
  '{"ts":"언제였지","principal":"eln:tool","action":"do","result":"denied","reason":"denied by rule: undated"}',
  // 깨진 줄 — 그 줄만 건너뛴다
  '{"ts":"2026-11-23T09:40:00.000Z","principal":"eln:tool"',
  '',
].join('\n');

const MAIL_FIXTURE = [
  '{"createdAt":"2026-11-23T09:10:00.000Z","body":"ELN-OP 명령 정정 — 앞선 우편을 철회한다"}',
  '{"createdAt":"2026-11-23T09:40:00.000Z","body":"«철회» 요청"}',
  '{"createdAt":"2026-11-23T09:50:00.000Z","body":"일상 보고"}',
  '{"createdAt":"2026-11-23T08:45:00.000Z","body":"창 밖의 정정 우편"}',
].join('\n');

describe('self observe — 1층 관측 집계', () => {
  test('시간창: duration · ISO 양쪽 받고 창은 [since, until] 이다', () => {
    expect(selfObserveWindow('1h', NOW)).toEqual(HOUR_WINDOW);
    expect(selfObserveWindow('2026-11-23T09:00:00.000Z', NOW)).toEqual(HOUR_WINDOW);
    expect(selfObserveWindow(undefined, NOW)).toEqual(HOUR_WINDOW); // 기본 1h — OP 명령 원문 «--since 1h»
  });

  test('거부 계수: 창 안 계수 · 창 밖 제외 · 경계값 포함 · 자기(eln:tool)만 · executor-refused 포함', () => {
    const observation = observeSelfSignals({
      window: HOUR_WINDOW,
      auditRows: parseSelfAuditRows(AUDIT_FIXTURE),
      mailRows: parseSelfMailRows(MAIL_FIXTURE),
      pendingMail: 5,
      nextVersion: '9.9.99',
    });
    // 09:30 + 경계 09:00 + 09:55(executor-refused) = 3 · 창 밖/사람 주체/executed 는 제외
    expect(observation.denied).toBe(3);
    expect(observation.undatedAudit).toBe(1);
    expect(observation.promotionCandidates).toHaveLength(0); // 창 밖과 합쳐지지 않는다 — 서명 계수도 창을 쓴다
  });

  test('정정/철회 우편: 창 안 낱말 계수 · 한 우편에 두 낱말이면 1 · 창 밖 제외', () => {
    const observation = observeSelfSignals({
      window: HOUR_WINDOW,
      auditRows: parseSelfAuditRows(AUDIT_FIXTURE),
      mailRows: parseSelfMailRows(MAIL_FIXTURE),
      pendingMail: 5,
      nextVersion: '9.9.99',
    });
    expect(observation.correctionMail).toBe(2); // «정정+철회» 1통(1로 센다) + «철회» 1통
  });

  test('대기 우편 수는 값이면 그대로, 못 읽으면 null(측정불가 ≠ 0)', () => {
    const measured = observeSelfSignals({ window: HOUR_WINDOW, auditRows: [], mailRows: [], pendingMail: 5, nextVersion: '9.9.99' });
    expect(measured.pendingMail).toBe(5);
    const unmeasured = observeSelfSignals({ window: HOUR_WINDOW, auditRows: [], mailRows: null, pendingMail: null, nextVersion: '9.9.99' });
    expect(unmeasured.correctionMail).toBeNull();
    expect(unmeasured.pendingMail).toBeNull();
    expect(retroLine(unmeasured)).toBe(
      '관측 2026-11-23T09:00:00.000Z — 2026-11-23T10:00:00.000Z: 도구거부 0 · 정정/철회 측정불가 · 대기우편 측정불가 · 승격후보 0',
    );
  });

  test('회고 입력 한 줄 포맷 — 숫자 표가 한 줄로 나온다', () => {
    const observation = observeSelfSignals({
      window: HOUR_WINDOW,
      auditRows: parseSelfAuditRows(AUDIT_FIXTURE),
      mailRows: parseSelfMailRows(MAIL_FIXTURE),
      pendingMail: 5,
      nextVersion: '9.9.99',
    });
    expect(retroLine(observation)).toBe(
      '관측 2026-11-23T09:00:00.000Z — 2026-11-23T10:00:00.000Z: 도구거부 3 · 정정/철회 2 · 대기우편 5 · 승격후보 0',
    );
  });

  test('CLI: 기존 `self` 명령군에 `observe` 로 등록되고 회고 한 줄을 찍는다', async () => {
    const logs: string[] = [];
    // console 스파이 없음 — 회고 한 줄은 주입한 out.log 만으로 잠긴다(bun spyOn 팩토리 3인자는 타입 계약 밖).
    try {
      const program = new Command();
      const self = program.command('self');
      registerSelfObserveCommand(self, {
        now: () => NOW,
        readAudit: () => AUDIT_FIXTURE,
        readMail: () => parseSelfMailRows(MAIL_FIXTURE),
        readPending: () => 5,
        readVersion: () => '9.9.8',
        out: { log: (line: string) => logs.push(line) },
      });
      expect(self.commands.map(cmd => cmd.name())).toContain('observe');
      await program.parseAsync(['self', 'observe', '--since', '1h'], { from: 'user' });
      expect(logs).toEqual([
        '관측 2026-11-23T09:00:00.000Z — 2026-11-23T10:00:00.000Z: 도구거부 3 · 정정/철회 2 · 대기우편 5 · 승격후보 0',
      ]);
    } finally { /* 주입 out 만 사용 — 복원할 스파이 없음 */ }
  });
});
