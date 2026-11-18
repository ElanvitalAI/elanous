import { describe, test, expect, afterEach } from 'bun:test';
import { classifyShellArgv, simpleArgv } from '../../security/shell-argv-policy.js';
import type { AllowShape } from '../../security/shell-argv-policy.js';
import { checkShellArgv } from './shell-argv.js';
import { runGuardian } from '../check.js';
import { setGuardianAuditSinkForTesting } from '../audit-sink.js';
import type { GuardianAuditEvent } from '../audit-sink.js';
import type { GuardianContext } from '../types.js';

const ctxOf = (command?: string): GuardianContext =>
  ({ toolId: 'bash', surface: 'tui', ...(command === undefined ? {} : { shellCommand: command }) }) as GuardianContext;

afterEach(() => {
  delete process.env['HARNESS_GUARDIAN_ENABLED'];
  setGuardianAuditSinkForTesting(null);
});

// ── 시험 1: 리터럴 4종 — 빈 allowlist 로 classifyShellArgv 판정 (전부 allow 아님) ──
describe('classifyShellArgv — TC #92362 literal hazards (empty allowlist)', () => {
  const EMPTY: readonly AllowShape[] = [];
  const classify = (command: string) => {
    const argv = simpleArgv(command);
    if (argv === null) throw new Error(`literal did not parse: ${command}`);
    return classifyShellArgv({ command, argv, allow: EMPTY }).verdict;
  };

  test('sudo -n true → ask-op (never allow)', () => {
    expect(classify('sudo -n true')).toBe('ask-op');
    expect(classify('sudo -n true')).not.toBe('allow');
  });
  test('rm -rf /tmp/guardian-t → ask-op (never allow)', () => {
    expect(classify('rm -rf /tmp/guardian-t')).toBe('ask-op');
    expect(classify('rm -rf /tmp/guardian-t')).not.toBe('allow');
  });
  test('git push --force → ask-op (never allow)', () => {
    expect(classify('git push --force')).toBe('ask-op');
    expect(classify('git push --force')).not.toBe('allow');
  });
  test('sqlite3 … "DROP TABLE t;" → deny — quoted ";" is still a metacharacter (never allow)', () => {
    expect(classify('sqlite3 /tmp/t.db "DROP TABLE t;"')).toBe('deny');
    expect(classify('sqlite3 /tmp/t.db "DROP TABLE t;"')).not.toBe('allow');
  });
});

// ── 시험 2: 정책 매핑 단위 — checkShellArgv 가 판정을 GuardianVerdict 로 1:1 ──
describe('checkShellArgv — verdict mapping (seat default allowlist)', () => {
  test('allow shape → allow', () => {
    const v = checkShellArgv(ctxOf('gh pr list'));
    expect(v.decision).toBe('allow');
  });
  test('deny (metachar) → deny', () => {
    const v = checkShellArgv(ctxOf('sqlite3 /tmp/t.db "DROP TABLE t;"'));
    expect(v.decision).toBe('deny');
  });
  test('ask-op → needs-approval', () => {
    const v = checkShellArgv(ctxOf('sudo -n true'));
    expect(v.decision).toBe('needs-approval');
  });
  test('fail-closed: no shellCommand in context → deny', () => {
    const v = checkShellArgv(ctxOf(undefined));
    expect(v.decision).toBe('deny');
    expect(v.auditPayload?.sha256 ?? null).toBeNull();
  });
  test('fail-closed: unparsable command (unterminated quote) → deny', () => {
    const v = checkShellArgv(ctxOf('sqlite3 /tmp/t.db "DROP'));
    expect(v.decision).toBe('deny');
  });
});

// ── 시험 3: runGuardian 강등·감사 — ask-op → 무인 deny, 원문 비유출 ──
describe('runGuardian — shell-argv ask-op demotion + audit (TC #92362)', () => {
  test('HARNESS_GUARDIAN_ENABLED=1: ask-op demoted to deny, policy shell-argv-ask-op-denied, raw command never leaked', () => {
    process.env['HARNESS_GUARDIAN_ENABLED'] = '1';
    const events: GuardianAuditEvent[] = [];
    setGuardianAuditSinkForTesting((ev) => {
      events.push(ev);
    });

    const verdict = runGuardian({ kind: 'shell-argv' } as never, ctxOf('sudo -n true'));

    // 무인 fail-closed: needs-approval 는 never 로 배출되지 않는다.
    expect(verdict.decision).toBe('deny');
    expect(verdict.decision).not.toBe('needs-approval');
    expect(verdict.reasons.join(' ')).toContain('ask-op demoted to deny');

    // 감사 레코드: 정책 이름은 강등 흔적을 남긴다.
    const ev = events.find((e) => (e as { policy?: string }).policy === 'shell-argv-ask-op-denied');
    expect(ev).toBeDefined();

    // 원문 명령 비유출: 감사 레코드 전체에 명령 원문이 없다 (절단/요약만).
    const evJson = JSON.stringify(events);
    expect(evJson).not.toContain('sudo -n true');
    expect(evJson).not.toContain('-n true');
    // 판정 페이로드도 sha256 해시·이름만.
    const payloadJson = JSON.stringify(verdict.auditPayload ?? {});
    expect(payloadJson).not.toContain('-n');
    expect(payloadJson).not.toContain('true');
  });
});
