import { seatDefaultAllowShapes } from '../../tui/seat-approval-policy.js';
import { classifyShellArgv, shellArgvAuditSha256, simpleArgv } from '../../security/shell-argv-policy.js';
import type { GuardianContext, GuardianVerdict } from '../types.js';

/**
 * TC #92362 — Guardian 선호출(pre-call) 정책: Bash 원문 command 를 공용
 * shell-argv 판정기에 넘겨 allow/deny/needs-approval 로 매핑한다.
 * 자리 기본 목록(seatDefaultAllowShapes) 재사용 — bash-runtime 사후 승인과
 * 같은 어휘(조항 5). 판정 이유·감사 페이로드에 인자 원문은 절대 남기지
 * 않는다: 명령 이름과 sha256 감사 해시만.
 */
export function checkShellArgv(ctx: GuardianContext): GuardianVerdict {
  const command = ctx.shellCommand;
  if (command === undefined) {
    // Fail-closed: catalog 가 bash 를 선언했는데 command 가 없으면 수용不可.
    return {
      decision: 'deny',
      reasons: ['shell-argv fail-closed: guardian context carries no shell command (TC #92362)'],
      auditPayload: { sha256: null },
    };
  }
  const sha256 = shellArgvAuditSha256(command);
  const argv = simpleArgv(command);
  if (argv === null || argv.length === 0) {
    // Fail-closed: 인용 미종결 등 파싱 실패 — 원문 없이도 거절 사유 기록.
    return {
      decision: 'deny',
      reasons: ['shell-argv fail-closed: shell command did not parse (TC #92362)'],
      auditPayload: { sha256 },
    };
  }
  const decision = classifyShellArgv({ command, argv, allow: seatDefaultAllowShapes() });
  const auditPayload = { sha256: decision.auditSha256 ?? sha256, name: decision.name ?? argv[0] };
  if (decision.verdict === 'allow') {
    return { decision: 'allow', reasons: [decision.reason], auditPayload };
  }
  if (decision.verdict === 'deny') {
    return { decision: 'deny', reasons: [decision.reason], auditPayload };
  }
  return { decision: 'needs-approval', reasons: [decision.reason], auditPayload };
}
