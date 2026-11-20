import { maskApprovalCommandSecrets, seatDefaultAllowShapes } from '../../tui/seat-approval-policy.js';
import { classifyShellArgv, maskEnvAssignments, shellArgvAuditSha256, simpleArgv } from '../../security/shell-argv-policy.js';
import type { GuardianContext, GuardianVerdict } from '../types.js';

/**
 * TC #92362 — Guardian 선호출(pre-call) 정책: Bash 원문 command 를 공용
 * shell-argv 판정기에 넘겨 allow/deny/needs-approval 로 매핑한다.
 * 자리 기본 목록(seatDefaultAllowShapes) 재사용 — bash-runtime 사후 승인과
 * 같은 어휘(조항 5). 판정 이유·감사 페이로드에 인자 원문은 절대 남기지
 * 않는다: 명령 이름과 sha256 감사 해시만.
 *
 * APPROVAL-REQUEST-PLAINTEXT-TARGET (0.3.31 · MK): needs-approval 판정은 «승인 요청»
 * 문면(`approvalRequest`)을 함께 낸다 — 명령 이름 · 대상(경로·가지 이름) 평문 ·
 * 비밀 가린 명령 · 이유, 해시는 보조로 끝에. 해시 단독 요청 금지. 감사 기록(reasons ·
 * auditPayload)은 그대로 해시·이름만이다.
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
  return {
    decision: 'needs-approval',
    reasons: [decision.reason],
    auditPayload,
    approvalRequest: buildApprovalRequest(command, argv, auditPayload.name, decision.reason, auditPayload.sha256),
  };
}

/**
 * 승인 요청 문면 — 대상 = 명령 이름 뒤의 플래그 아닌 토큰(경로·가지 이름 등) 평문.
 * 대상은 «이미 가린» 명령을 다시 나눈 토큰에서 뽑는다 — `--token abc` 처럼 플래그 값이
 * 따로 떨어진 경우도 seat 승인 우편과 같은 가림(maskApprovalCommandSecrets)을 먼저 거친다.
 * 토큰마다 한 번 더 가리고(합집합 · fail-closed), 환경 할당 모양(NAME=value)은 값을 **** 로.
 * sha256 은 감사 원본과 잇는 보조 칸 — 해시 단독 요청은 내지 않는다.
 */
function buildApprovalRequest(command: string, argv: readonly string[], name: string, reason: string, sha256: string): string {
  const maskedCommand = maskApprovalCommandSecrets(command);
  const words = simpleArgv(maskedCommand) ?? argv;
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start += 1;
  const targets = maskEnvAssignments(words.slice(start + name.split(' ').length))
    .filter((word) => !word.startsWith('-'))
    .map((word) => maskApprovalCommandSecrets(word));
  const targetText = targets.length > 0 ? targets.join(' ') : '(없음)';
  return `승인 요청 · 명령 ${maskApprovalCommandSecrets(name)} · 대상 ${targetText}\n`
    + `명령(비밀 가림): ${maskedCommand}\n`
    + `이유: ${maskApprovalCommandSecrets(reason)} · 보조 감사 해시 sha256:${sha256}`;
}
