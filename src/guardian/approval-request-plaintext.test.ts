// APPROVAL-REQUEST-PLAINTEXT-TARGET (0.3.31 · MK) — 파괴·자격 승인 요청은 대상(경로·가지 이름·
// 명령 이름)을 평문으로 싣고, 자격 값은 가리며, 해시는 보조로만 남긴다.
// 기대값은 전부 독립 리터럴이다(제품 상수·렌더 함수로 만들지 않는다 — 규칙 11).
import { describe, test, expect, afterEach } from 'bun:test';
import { checkShellArgv } from './policies/shell-argv.js';
import { runGuardian } from './check.js';
import { setGuardianAuditSinkForTesting } from './audit-sink.js';
import type { GuardianAuditEvent } from './audit-sink.js';
import type { GuardianContext } from './types.js';

const ctxOf = (command: string): GuardianContext =>
  ({ toolId: 'bash', surface: 'tui', shellCommand: command }) as GuardianContext;

// 가짜 토큰 — ghp_ + 36자(실제 자격 아님).
const FAKE_GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

afterEach(() => {
  delete process.env['HARNESS_GUARDIAN_ENABLED'];
  setGuardianAuditSinkForTesting(null);
});

describe('guardian approval request — plaintext target', () => {
  test('rm -r /tmp/x/y: request names the command and carries the path in plain text, hash only auxiliary', () => {
    const v = checkShellArgv(ctxOf('rm -r /tmp/x/y'));
    expect(v.decision).toBe('needs-approval');
    const req = v.approvalRequest ?? '';
    expect(req).toContain('명령 rm');
    expect(req).toContain('대상 /tmp/x/y');
    expect(req).toContain('rm -r /tmp/x/y');
    // 해시는 보조 칸으로 함께 있다 — 요청이 해시 하나뿐이 아님은 위의 «대상 /tmp/x/y» 단언이 증명한다.
    expect(req).toMatch(/보조 감사 해시 sha256:[0-9a-f]{64}/);
  });

  test('git push --force origin mk/feature-x: branch name in plain text', () => {
    const v = checkShellArgv(ctxOf('git push --force origin mk/feature-x'));
    expect(v.decision).toBe('needs-approval');
    const req = v.approvalRequest ?? '';
    expect(req).toContain('명령 git push');
    expect(req).toContain('mk/feature-x');
  });

  test('token-looking value in the command is masked, the path next to it stays plain', () => {
    const v = checkShellArgv(ctxOf(`git push --force origin ${FAKE_GHP}`));
    expect(v.decision).toBe('needs-approval');
    const req = v.approvalRequest ?? '';
    expect(req).not.toContain(FAKE_GHP);
    expect(req).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    expect(req).toContain('****');
    expect(req).toContain('origin');
  });

  test('separate --token value is masked in the target list too; path stays plain', () => {
    const v = checkShellArgv(ctxOf('mytool --token Sup3rS3cretValue1 /tmp/x/y'));
    expect(v.decision).toBe('needs-approval');
    const req = v.approvalRequest ?? '';
    expect(req).not.toContain('Sup3rS3cretValue1');
    expect(req).toContain('/tmp/x/y');
  });

  test('allow and deny verdicts carry no approval request', () => {
    expect(checkShellArgv(ctxOf('git status')).approvalRequest).toBeUndefined();
    expect(checkShellArgv(ctxOf('rm -r /tmp/x/y; true')).approvalRequest).toBeUndefined();
  });

  test('runGuardian demotion keeps the plaintext request; audit stays hash + name only', () => {
    process.env['HARNESS_GUARDIAN_ENABLED'] = '1';
    const events: GuardianAuditEvent[] = [];
    setGuardianAuditSinkForTesting((ev) => { events.push(ev); });
    const verdict = runGuardian({ kind: 'shell-argv' }, ctxOf(`rm -r /tmp/x/y/${FAKE_GHP}`));
    expect(verdict.decision).toBe('deny');
    const req = verdict.approvalRequest ?? '';
    expect(req).toContain('/tmp/x/y/');
    expect(req).not.toContain(FAKE_GHP);
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain('/tmp/x/y');
    expect(auditJson).not.toContain(FAKE_GHP);
  });
});
