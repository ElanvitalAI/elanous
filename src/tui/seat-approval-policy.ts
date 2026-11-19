/**
 * ELN-SEAT-APPROVAL-POLICY (OP promotion checklist ③ · ELN-SEAT-LIVE 11-18 13:10): an autonomous eln seat has nobody at
 * the keyboard, so every approval prompt (git commit · apt · gcloud ssh on MVP-B / HAND-VM-GOLDEN) sat until its timer
 * and was refused by default — the work stopped. In a seat TUI:
 *   - a command whose argv matches the seat allowlist exactly is approved automatically;
 *   - anything else — destructive, credential, cost, shell expansion, or simply unknown — is asked of OP by mail (HITL),
 *     while the local prompt stays up; the EARLIER answer wins (OP's `accepted`/`rejected` receipt time vs the keyboard).
 * Nothing here ever approves a command the allowlist does not name; the default for the unknown is «ask OP», not «no».
 *
 * Design (#38454 r4 · OP «기본 거부 + argv 정확 일치» Bloom 5, 11-18): 판정 원칙은 공용 모듈(src/security/shell-argv-policy.ts)에
 * 있다 — 자동 승인은 argv 가 허용 목록 항목의 고정 모양과 정확히 일치할 때만 나오고, 메타문자가 하나라도 있거나 환경 접두가
 * NODE_ENV/CI 가 아니면 OP 에게 간다(«안전 명령이니 인자는 자유» 범주는 폐지). 이 파일은 자리몫 게이트(credential · op-only ·
 * destructive · graph)를 그 앞에 두고, 감사 기록은 sha256 감사 해시로 남기되 OP 우편 본문은 비밀만 가린 명령 원문(경로·크기·이유
 * 그대로)에 해시를 덧붙인다(#15 APPROVAL-REQUEST-PLAINTEXT · SEAT-MAIL-EXCHANGE-FIX-1119 — #38454 r4 «해시만» 폐지). The allowlist file
 * itself is OP's single-writer artifact — version + sha256 lock + stable item IDs + revocation tombstones (a resurrected
 * id or a backwards version is refused) at `seat-state/OP/approval-allow/<SEAT>` — read-only here.
 */
import { classifyDestructive } from '../ask-user-question/guardian.js';
import { APPROVAL_APPROVED, type ApprovalOutcome } from '../graph-runner/approval-outcome.js';
import { classifyShellArgv, commandNameFromArgv, parseSeatAllowList, shellArgvAuditSha256, simpleArgv, type AllowShape, type AllowToken } from '../security/shell-argv-policy.js';

export type SeatApprovalDecision
  = { readonly decision: 'allow'; readonly rule: string; readonly name: string; readonly auditSha256: string }
  | { readonly decision: 'ask-op'; readonly reason: string; readonly name: string; readonly auditSha256: string };

// ── 기본 허용 목록 — argv 정확 모양 표 (r3 의 «접두 일치 + rest 검사» 표를 교체 · 조항 2·3) ──────────────
// 슬롯: VALUE 값 토큰 · REFSPEC/BRANCH 는 보호 가지(main/master/HEAD)와 강제/삭제 refspec 을 뺀다.
// 집단 이름(rule)은 r3 로그 문화를 잇는다(auto-approved · status line).
const VALUE = /^(?!-).+$/;
const REFSPEC = /^(?![:+])(?!refs\/heads\/(?:main|master|HEAD)$)(?:refs\/heads\/)?(?!main$|master$|HEAD$)[\w][\w.\/=-]*(?::(?!refs\/heads\/(?:main|master|HEAD)$)(?:refs\/heads\/)?(?!main$|master$|HEAD$)[\w][\w.\/=-]*)?$/;
const BRANCH = /^(?![-+])(?!main$)(?!master$)(?!HEAD$)(?!refs\/heads\/(?:main|master)$)[\w][\w.\/=-]*$/;
const COUNT_FLAG = /^-\d{1,4}$/;
const PR_NUMBER = /^\d+$/;
const HOST = /^(?!-)[\w.-]+$/;
const ZONE = /^(?!-)[\w-]+$/;
const SERVICE_ACCOUNT = /^(?!-)[\w@.-]+$/;
const IMPERSONATION_EQ = /^--impersonate-service-account=[^-][\w@.-]*$/;
const GH_PR_OPT = /^(?:--(?:json|web|comments|url|repo|state|assignee|label|base|head|limit|author)|(?!-).+)$/;
const GH_PR_CREATE_OPT = /^(?:--(?:json|web|repo|title|body|body-file|draft|base|head|fill|fill-first)|(?!-).+)$/;
const ELN_MSG_OPT = /^(?:--(?:from|to|id|json|unread|reason|limit|since|mark-read|state|status|thread|route|checklist|body|title|source|host|seat|watch|poll|wait|once|now|quiet)|(?!-).+)$/;

const lit = (word: string): AllowToken => ({ lit: word });
const slot = (id: string, re: RegExp): AllowToken => ({ slot: id, re });
const rep = (id: string, re: RegExp): AllowToken => ({ rep: id, re });
const shape = (id: string, name: string, ...tokens: readonly AllowToken[]): AllowShape => ({ id, name, tokens });

/** Source: OP 11-18 13:1x «자리 역할별 허용 목록(git add/commit/push · bun test · pregate · gcloud --impersonate 자동화 SA 등)». */
const SEAT_DEFAULT_ALLOW_SHAPES: readonly AllowShape[] = [
  // git 읽기
  shape('git-status', 'git-read', lit('git'), lit('status')),
  shape('git-status-short', 'git-read', lit('git'), lit('status'), lit('--short')),
  shape('git-status-porcelain', 'git-read', lit('git'), lit('status'), lit('--porcelain')),
  shape('git-diff', 'git-read', lit('git'), lit('diff')),
  shape('git-diff-cached', 'git-read', lit('git'), lit('diff'), lit('--cached')),
  shape('git-diff-stat', 'git-read', lit('git'), lit('diff'), lit('--stat')),
  shape('git-diff-paths', 'git-read', lit('git'), lit('diff'), rep('paths', VALUE)),
  shape('git-diff-cached-paths', 'git-read', lit('git'), lit('diff'), lit('--cached'), rep('paths', VALUE)),
  shape('git-log', 'git-read', lit('git'), lit('log')),
  shape('git-log-oneline', 'git-read', lit('git'), lit('log'), lit('--oneline')),
  shape('git-log-oneline-count', 'git-read', lit('git'), lit('log'), lit('--oneline'), slot('count', COUNT_FLAG)),
  shape('git-log-rev', 'git-read', lit('git'), lit('log'), slot('rev', VALUE)),
  shape('git-log-oneline-rev', 'git-read', lit('git'), lit('log'), lit('--oneline'), slot('rev', VALUE)),
  shape('git-show', 'git-read', lit('git'), lit('show')),
  shape('git-show-stat', 'git-read', lit('git'), lit('show'), lit('--stat')),
  shape('git-show-rev', 'git-read', lit('git'), lit('show'), slot('rev', VALUE)),
  shape('git-fetch', 'git-read', lit('git'), lit('fetch')),
  shape('git-fetch-remote', 'git-read', lit('git'), lit('fetch'), slot('remote', VALUE)),
  shape('git-fetch-prune', 'git-read', lit('git'), lit('fetch'), lit('--prune')),
  shape('git-fetch-all', 'git-read', lit('git'), lit('fetch'), lit('--all')),
  shape('git-rev-parse', 'git-read', lit('git'), lit('rev-parse')),
  shape('git-rev-parse-revs', 'git-read', lit('git'), lit('rev-parse'), rep('revs', VALUE)),
  // git 쓰기
  shape('git-add-A', 'git-add', lit('git'), lit('add'), lit('-A')),
  shape('git-add-paths', 'git-add', lit('git'), lit('add'), rep('paths', VALUE)),
  shape('git-commit-m', 'git-commit', lit('git'), lit('commit'), lit('-m'), slot('message', VALUE)),
  shape('git-commit-am', 'git-commit', lit('git'), lit('commit'), lit('-am'), slot('message', VALUE)),
  shape('git-push-u', 'git-push', lit('git'), lit('push'), lit('-u'), slot('remote', VALUE), slot('refspec', REFSPEC)),
  shape('git-push-set-upstream', 'git-push', lit('git'), lit('push'), lit('--set-upstream'), slot('remote', VALUE), slot('refspec', REFSPEC)),
  shape('git-push-force-with-lease', 'git-push', lit('git'), lit('push'), lit('--force-with-lease'), slot('remote', VALUE), slot('refspec', REFSPEC)),
  shape('git-push-remote-refspec', 'git-push', lit('git'), lit('push'), slot('remote', VALUE), slot('refspec', REFSPEC)),
  shape('git-switch-branch', 'git-branch', lit('git'), lit('switch'), slot('branch', BRANCH)),
  shape('git-switch-create', 'git-branch', lit('git'), lit('switch'), lit('-c'), slot('branch', BRANCH)),
  shape('git-checkout-create', 'git-branch', lit('git'), lit('checkout'), lit('-b'), slot('branch', BRANCH)),
  shape('git-worktree-add', 'git-worktree', lit('git'), lit('worktree'), lit('add'), rep('paths', VALUE)),
  shape('git-cherry-pick', 'git-cherry-pick', lit('git'), lit('cherry-pick'), slot('rev', VALUE)),
  shape('git-cherry-pick-continue', 'git-cherry-pick', lit('git'), lit('cherry-pick'), lit('--continue')),
  // 검증
  shape('bun-test', 'bun-test', lit('bun'), lit('test')),
  shape('bun-test-files', 'bun-test', lit('bun'), lit('test'), rep('files', VALUE)),
  shape('bun-test-t', 'bun-test', lit('bun'), lit('test'), lit('-t'), slot('name', VALUE)),
  shape('bun-test-files-t', 'bun-test', lit('bun'), lit('test'), rep('files', VALUE), lit('-t'), slot('name', VALUE)),
  shape('bunx-tsc', 'bun-test', lit('bunx'), lit('tsc')),
  shape('bunx-tsc-noEmit', 'bun-test', lit('bunx'), lit('tsc'), lit('--noEmit')),
  shape('bunx-tsc-noEmit-p', 'bun-test', lit('bunx'), lit('tsc'), lit('--noEmit'), lit('-p'), slot('project', VALUE)),
  shape('bunx-tsc-p', 'bun-test', lit('bunx'), lit('tsc'), lit('-p'), slot('project', VALUE)),
  shape('pregate', 'pregate', lit('seat-state/RES/tools/pregate'), slot('pr', PR_NUMBER)),
  shape('pregate-host', 'pregate', lit('seat-state/RES/tools/pregate'), slot('pr', PR_NUMBER), lit('--host'), slot('host', HOST)),
  // gh pr — 값 토큰은 자유, 옵션 «이름» 은 닫힌 목록(모르는 옵션 → OP)
  shape('gh-pr-view', 'gh-pr', lit('gh'), lit('pr'), lit('view')),
  shape('gh-pr-view-id', 'gh-pr', lit('gh'), lit('pr'), lit('view'), slot('pr', VALUE)),
  shape('gh-pr-view-opts', 'gh-pr', lit('gh'), lit('pr'), lit('view'), rep('opts', GH_PR_OPT)),
  shape('gh-pr-view-id-opts', 'gh-pr', lit('gh'), lit('pr'), lit('view'), slot('pr', VALUE), rep('opts', GH_PR_OPT)),
  shape('gh-pr-list', 'gh-pr', lit('gh'), lit('pr'), lit('list')),
  shape('gh-pr-list-opts', 'gh-pr', lit('gh'), lit('pr'), lit('list'), rep('opts', GH_PR_OPT)),
  shape('gh-pr-checks', 'gh-pr', lit('gh'), lit('pr'), lit('checks'), slot('pr', VALUE)),
  shape('gh-pr-checks-opts', 'gh-pr', lit('gh'), lit('pr'), lit('checks'), slot('pr', VALUE), rep('opts', GH_PR_OPT)),
  shape('gh-pr-diff', 'gh-pr', lit('gh'), lit('pr'), lit('diff'), slot('pr', VALUE)),
  shape('gh-pr-diff-opts', 'gh-pr', lit('gh'), lit('pr'), lit('diff'), slot('pr', VALUE), rep('opts', GH_PR_OPT)),
  shape('gh-pr-comment', 'gh-pr', lit('gh'), lit('pr'), lit('comment'), slot('pr', VALUE), rep('opts', GH_PR_OPT)),
  shape('gh-pr-create', 'gh-pr', lit('gh'), lit('pr'), lit('create'), rep('opts', GH_PR_CREATE_OPT)),
  // eln msg — 값 토큰은 자유, 옵션 «이름» 은 닫힌 목록
  ...['post', 'list', 'ack', 'receipts', 'receipt', 'thread', 'route'].flatMap(sub => [
    shape(`eln-msg-${sub}`, 'eln-msg', lit('eln'), lit('msg'), lit(sub)),
    shape(`eln-msg-${sub}-args`, 'eln-msg', lit('eln'), lit('msg'), lit(sub), rep('args', ELN_MSG_OPT)),
  ]),
  // gcloud — 오직 --impersonate-service-account 자동화 SA 로만. 원격 명령(--command)·--ssh-flag 모양은 목록에 없다.
  shape('gcloud-ssh-imp-eq', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('ssh'), slot('instance', VALUE), slot('impersonation', IMPERSONATION_EQ)),
  shape('gcloud-ssh-imp', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('ssh'), slot('instance', VALUE), lit('--impersonate-service-account'), slot('sa', SERVICE_ACCOUNT)),
  shape('gcloud-ssh-imp-eq-zone', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('ssh'), slot('instance', VALUE), slot('impersonation', IMPERSONATION_EQ), lit('--zone'), slot('zone', ZONE)),
  shape('gcloud-ssh-zone-imp-eq', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('ssh'), slot('instance', VALUE), lit('--zone'), slot('zone', ZONE), slot('impersonation', IMPERSONATION_EQ)),
  shape('gcloud-ssh-zone-imp', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('ssh'), slot('instance', VALUE), lit('--zone'), slot('zone', ZONE), lit('--impersonate-service-account'), slot('sa', SERVICE_ACCOUNT)),
  shape('gcloud-instances-list-imp-eq', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('instances'), lit('list'), slot('impersonation', IMPERSONATION_EQ)),
  shape('gcloud-instances-list-imp', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('instances'), lit('list'), lit('--impersonate-service-account'), slot('sa', SERVICE_ACCOUNT)),
  shape('gcloud-instances-describe-imp-eq', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('instances'), lit('describe'), slot('instance', VALUE), slot('impersonation', IMPERSONATION_EQ)),
  shape('gcloud-instances-describe-imp', 'gcloud-impersonate', lit('gcloud'), lit('compute'), lit('instances'), lit('describe'), slot('instance', VALUE), lit('--impersonate-service-account'), slot('sa', SERVICE_ACCOUNT)),
];

/** Guardian 선호출(pre-call) 재사용 진입점 (TC #92362) — bash-runtime 사후 승인과 guardian shell-argv
 *  정책이 같은 기본 목록을 보도록 한다. OP allow 파일의 extra shapes 는 자리 포트(파일 읽기)가
 *  필요해서 guardian 시점엔 아직 못 읽는다(후속 칸 — HITL 승인 배선과 함께). */
export function seatDefaultAllowShapes(): readonly AllowShape[] {
  return SEAT_DEFAULT_ALLOW_SHAPES;
}

/** Never automatic, whatever any allowlist says: credentials and their files — and the OP-owned allow files themselves. */
const CREDENTIAL = /(\.ssh\/|id_rsa|id_ed25519|\.env(\s|$|\.)|secrets?\.json|credentials|auth\.json|\btoken\b|api[_-]?key|password|passwd|gh\s+auth|security\s+find-generic-password|approval-allow)/i;
/** Merge / process-kill — OP's own list (no pkill · no gh pr merge). */
const OP_ONLY = /(^|\s)(pkill|killall)(\s|$)|\bgh\s+pr\s+merge\b|\bkill\s+-9\b/;

/**
 * Pure policy — 자리몫 게이트(credential · op-only · destructive · graph) 륤 공용 argv 판정으로.
 * 결정 어디에도 인자 원문은 없다: 이유·명령 이름·sha256 감사 해시만 남는다 — 우편 «본문» 의 비밀 가림 원문은 #15(마스킹은 핸들러).
 */
export function seatApprovalDecision(command: string, kind: 'bash' | 'graph', extraAllowShapes: readonly AllowShape[] = []): SeatApprovalDecision {
  const auditSha256 = shellArgvAuditSha256(command);
  if (kind !== 'bash') return { decision: 'ask-op', reason: 'graph approval (not a shell command)', name: '(graph)', auditSha256 };
  const parsed = simpleArgv(command.trim());
  // 기본 표가 먼저다 — 목록 파일 모양은 기본 표가 못 정한 것만 정한다(#38454 Terra ③ 정신).
  const allow = [...SEAT_DEFAULT_ALLOW_SHAPES, ...extraAllowShapes];
  let nameFrom = 0;
  if (parsed !== null) while (nameFrom < parsed.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parsed[nameFrom]!)) nameFrom += 1;
  const name = parsed === null || parsed.length === 0 ? '(unparsed)' : commandNameFromArgv(parsed.slice(nameFrom), allow);
  if (CREDENTIAL.test(command)) return { decision: 'ask-op', reason: 'credential', name, auditSha256 };
  if (OP_ONLY.test(command)) return { decision: 'ask-op', reason: 'op-only (merge · kill)', name, auditSha256 };
  const destructive = classifyDestructive(command);
  if (destructive) return { decision: 'ask-op', reason: `${destructive.severity}: ${destructive.reason}`, name, auditSha256 };
  if (parsed === null || parsed.length === 0) return { decision: 'ask-op', reason: 'unbalanced quote or empty', name, auditSha256 };
  const verdict = classifyShellArgv({ command, argv: parsed, allow });
  return verdict.verdict === 'allow'
    ? { decision: 'allow', rule: verdict.rule ?? 'allow', name, auditSha256 }
    : { decision: 'ask-op', reason: verdict.reason, name, auditSha256 };
}

// Source: #38163 receipts poll cadence for a waiting seat (one SELECT per tick on an indexed column).
const SEAT_APPROVAL_POLL_MS = 5_000;

/** OP's answer on the request mail, with the receipt time (ms) so the earlier answer wins. */
export type SeatApprovalOpDecision = { readonly approved: boolean; readonly atMs: number };

export interface SeatApprovalPorts {
  readonly seat: string;
  /** The interactive prompt (keyboard) — stays up while OP is asked. */
  readonly local: (command: string, callId: string, kind: 'bash' | 'graph', windowMs?: number) => Promise<ApprovalOutcome>;
  /** Close the interactive prompt once OP has answered. */
  readonly cancelLocal: (callId: string) => void;
  /** Post the request to OP; returns the mail id. */
  readonly postRequest: (body: string) => number;
  /** OP's decision on that mail (accepted/rejected receipt and its time) · none yet → null. */
  readonly readDecision: (mailId: number) => SeatApprovalOpDecision | null;
  /** OP 의 허용 목록 파일(seat-state/OP/approval-allow/<SEAT>)이 정의한 추가 모양 — 없으면 []. */
  readonly extraAllowShapes?: () => readonly AllowShape[];
  readonly setStatus: (line: string) => void;
  readonly log: (event: string, data: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
}

const opOutcome = (decision: SeatApprovalOpDecision): ApprovalOutcome => decision.approved ? APPROVAL_APPROVED : { approved: false, reason: 'declined' };

// ── #15 APPROVAL-REQUEST-PLAINTEXT (SEAT-MAIL-EXCHANGE-FIX-1119): the ask-op mail body carries the command itself,
// secrets masked — 경로·크기·이유 stay readable so OP can actually judge (the #92648 오탐 lesson: «echo "rm -rf x"»
// must be visible) — and the sha256 audit hash stays appended to tie the masked text back to the audited original.
const SECRET_MASK = '****';
/** 모양으로 아는 자격 증명: GitHub PAT(ghp/o/u/s/r_) · github_pat_ · sk-… · AWS AKIA · Slack xox… · base64url JWT · PEM 사열. */
const SECRET_TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[posru]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
];
/** 환경 접두 할당(이름은 남기고 값만 가림 — PWD 는 경로라 제외) · https 자격 URL · --password 류 플래그 값. */
const SECRET_ENV_ASSIGNMENT = /(^|[\s;&|(])([A-Za-z0-9_]*?(?:TOKEN|KEY|PASSWD|PASSWORD|SECRET|CREDENTIALS?|AUTH))=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()]+)/gi;
const SECRET_URL_CREDENTIALS = /(https?:\/\/[^:/\s]+:)([^@\s]+)@/gi;
const SECRET_FLAG_VALUE = /(["']?--(?:password|passwd|token|api-key|secret|access-token|pass)["']?[\s=]+)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()"']+)/gi;
/** 긴 base64/base64url 사열(40+ 자 · 대소문자 숫자 섞임): +·/ 없는 사열도 자격으로 본다(JUD ⓒ2) ·
 *  클래스에 / 를 넣지 않는다 — / 로 이어진 경로를 통째로 삼키는 일이 없게(JUD ⓑ: / 뒤 세그먼트는 경로로 그대로) ·
 *  순수 소문자 hex 커밋 sha 도 참조로 가리지 않는다. */
const SECRET_BASE64_BLOB = /\b(?<!\/)(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[0-9])[A-Za-z0-9+_-]{40,}={0,2}/g;

/** 승인 요청 본문용: 명령 원문에서 비밀 값만 **** 로 가린다(#15). */
export function maskApprovalCommandSecrets(command: string): string {
  // JUD 20261119-1014 ⓒ (OP #94939): 공용 redactSecretText(gitleaks 이식 · #38865 합집합 원칙) 을 먼저 돌린다 —
  // Bearer 불투명 토큰 · curl -u 사용자:비번 · postgres:// 등 scheme URL 자격 · mysql -p'비번' 은 공용이 가린다.
  // 승인 요청 전용 규칙은 그 위에 추가로만 적용한다(합집합 · fail-closed).
  const { redactSecretText } = require('../debug/secret-redaction.js') as typeof import('../debug/secret-redaction.js');
  // 특정 모양(ghp_/JWT/…)이 공용보다 먼저: 공용의 generic 부분 가림(예: ey***)이 특정 토큰의 전체 가림(****)을 방해하지 않게(JUD ⓒ2 · r2 회귀 방지).
  let preMasked = command;
  for (const shape of SECRET_TOKEN_SHAPES) preMasked = preMasked.replace(shape, SECRET_MASK);
  // 공용 redactSecretText(gitleaks 이식 · #38865 합집합 원칙) — Bearer 불투명 · curl -u 사용자:비번 · scheme URL 자격 · mysql -p'비번' 을 가린다(JUD ⓒ).
  let masked = redactSecretText(preMasked);
  masked = masked.replace(SECRET_URL_CREDENTIALS, `$1${SECRET_MASK}@`);
  // JUD ⓒ: `curl -u alice:비번` 콜론 자격 인자 — 공용 gitleaks 이식이 안 가리는 모양 · 비번만 가린다(사용자 이름은 OP 판정에 필요).
  const SECRET_COLON_CREDENTIAL_ARG = /(^|[\s"'])(-[uU]\b|--user(?:name)?)\s+([^\s"'@:]+):([^\s"']+)/g;
  masked = masked.replace(SECRET_COLON_CREDENTIAL_ARG, `$1$2 $3:${SECRET_MASK}`);
  // JUD ⓒ: postgres:// 등 https 가 아닌 scheme URL 자격 — 공용이 안 가리는 모양 · 사용자 이름은 유지(OP 판정).
  const SECRET_ANY_SCHEME_URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s'"@\/]+):([^\s'"@\/]+)@/gi;
  masked = masked.replace(SECRET_ANY_SCHEME_URL_CREDENTIALS, `$1$2:${SECRET_MASK}@`);
  // JUD ⓒ: mysql -p'비번' 처럼 플래그 바로 뒤 인용된 자격 값 — 공용·기존 규칙이 안 가리는 모양.
  const SECRET_QUOTED_FLAG_PASSWORD = /(^|[\s"'])(-[pPW]\b)(["'])([^\s"'\\]{3,})(\3)/g;
  masked = masked.replace(SECRET_QUOTED_FLAG_PASSWORD, `$1$2$3${SECRET_MASK}$5`);
  masked = masked.replace(SECRET_ENV_ASSIGNMENT, `$1$2=${SECRET_MASK}`);
  masked = masked.replace(SECRET_FLAG_VALUE, `$1${SECRET_MASK}`);
  masked = masked.replace(SECRET_BASE64_BLOB, SECRET_MASK);
  return masked;
}

/** Wrap the TUI approval handler for a seat. Auto-approve on the allowlist; otherwise ask OP and the keyboard, earlier wins. */
export function createSeatApprovalHandler(ports: SeatApprovalPorts) {
  const now = ports.now ?? Date.now;
  // #25 APPROVAL-REPEAT-AUTO-DENY (SEAT-MAIL-EXCHANGE-FIX-1119 · 결함 #25): 밤 실측 — 같은 명령의 승인 요청이
  // 10회+ 쌓여 전부 거부됐다. 세션 단위 기억(kind ⊕ 감사 해시 → 첫 요청 시각)으로 2회째부터는 OP 에 우편을
  // 더 쌓지 않고 보낸 자리에 즉시 자동 거부로 답한다(옵션·깃발 없는 기본 동작).
  const repeatAsks = new Map<string, { askedAtMs: number; outcome?: ApprovalOutcome }>();
  return async (command: string, callId: string, kind: 'bash' | 'graph', windowMs?: number): Promise<ApprovalOutcome> => {
    const verdict = seatApprovalDecision(command, kind, ports.extraAllowShapes?.() ?? []);
    if (verdict.decision === 'allow') {
      ports.log('auto-approved', { seat: ports.seat, callId, rule: verdict.rule, auditSha256: verdict.auditSha256 });
      ports.setStatus(`자리 허용 목록 자동 승인 · ${verdict.rule}`);
      return APPROVAL_APPROVED;
    }
    const repeatKey = `${kind}:${verdict.auditSha256}`;
    const prior = repeatAsks.get(repeatKey);
    if (prior?.outcome !== undefined && !prior.outcome.approved) {
      // JUD ⓑ: 첫 요청이 거부·시간초과로 끝난 뒤의 재발만 즉시 자동 거부한다(창 = 이 핸들러의 세션 수명).
      ports.log('approval-repeat-denied', { seat: ports.seat, callId, reason: verdict.reason, auditSha256: verdict.auditSha256, firstAskedAtMs: prior.askedAtMs, firstOutcome: prior.outcome.reason });
      ports.setStatus('같은 승인 요청 반복 — 즉시 자동 거부 (OP 우편 없음)');
      return { approved: false, reason: 'repeat-approval-request' };
    }
    if (prior?.outcome?.approved) {
      // JUD ⓑ «승인은 통과»: 한 번 승인된 같은 요청의 재발은 다시 묻지 않고 통과시킨다.
      ports.log('approval-repeat-approved', { seat: ports.seat, callId, reason: verdict.reason, auditSha256: verdict.auditSha256, firstAskedAtMs: prior.askedAtMs });
      ports.setStatus('같은 승인 요청 반복 — 승인 재사용 (OP 우편 없음)');
      return APPROVAL_APPROVED;
    }
    if (prior === undefined) repeatAsks.set(repeatKey, { askedAtMs: now() });
    if (repeatAsks.size > 512) repeatAsks.delete(repeatAsks.keys().next().value as string);
    // 이 요청이 어떤 결정으로 끝나는지 기억한다 — 다음 재발의 자동 거부/통과 판정 재료(JUD ⓑ).
    const remember = (outcome: ApprovalOutcome): ApprovalOutcome => {
      const cur = repeatAsks.get(repeatKey);
      if (cur !== undefined) repeatAsks.set(repeatKey, { askedAtMs: cur.askedAtMs, outcome });
      return outcome;
    };
    let mailId: number | null = null;
    try {
      // #15 APPROVAL-REQUEST-PLAINTEXT (SEAT-MAIL-EXCHANGE-FIX-1119): the body carries the command itself, secrets
      // masked (경로·크기·이유 그대로) so OP can judge it — the sha256 audit hash stays appended. #38454 r4 «hash-only» 폐지.
      const maskedCommand = maskApprovalCommandSecrets(command);
      mailId = ports.postRequest(`[승인 요청 · ${ports.seat}] ${kind === 'bash' ? 'Bash' : '그래프'} · 이유 ${verdict.reason}\n명령(비밀 가림): ${maskedCommand}\n명령 이름: ${maskApprovalCommandSecrets(verdict.name)} · 감사 해시 sha256:${verdict.auditSha256}\n답: eln msg receipt <이 우편 id> accepted --to OP  |  rejected --to OP --reason "…" (화면에서 y/n 도 됨)`);
      ports.log('asked-op', { seat: ports.seat, callId, mailId, reason: verdict.reason, auditSha256: verdict.auditSha256 });
    } catch (error) {
      // Never silent: the keyboard prompt still runs, and the failure is a warn line.
      ports.log('ask-op-failed', { seat: ports.seat, callId, reason: verdict.reason, error: error instanceof Error ? error.message : String(error), auditSha256: verdict.auditSha256 });
    }
    if (mailId === null) return ports.local(command, callId, kind, windowMs).then(remember);
    // AUTHOR-PRECHECK extra «failure swallowed»: a ledger read error is not «OP has not answered» in silence — warn once per request.
    let readErrorLogged = false;
    const read = (): SeatApprovalOpDecision | null => {
      try { return ports.readDecision(mailId!); }
      catch (error) {
        if (!readErrorLogged) {
          readErrorLogged = true;
          ports.log('op-decision-read-failed', { seat: ports.seat, callId, mailId, error: error instanceof Error ? error.message : String(error) });
        }
        return null;
      }
    };
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fromOp = new Promise<SeatApprovalOpDecision | null>(resolve => {
      const tick = (): void => {
        if (stop) { resolve(null); return; }
        const decision = read();
        if (decision !== null) { resolve(decision); return; }
        timer = setTimeout(tick, ports.pollMs ?? SEAT_APPROVAL_POLL_MS);
      };
      tick();
    });
    const fromKeyboard = ports.local(command, callId, kind, windowMs).then(outcome => ({ outcome, atMs: now() }));
    const first = await Promise.race([fromKeyboard.then(k => ({ source: 'keyboard' as const, ...k })), fromOp.then(d => d === null ? null : { source: 'op' as const, decision: d })]);
    stop = true;
    if (timer) clearTimeout(timer);
    let source: 'op' | 'keyboard';
    let outcome: ApprovalOutcome;
    if (first !== null && first.source === 'op') {
      source = 'op'; outcome = opOutcome(first.decision);
      ports.cancelLocal(callId);
    } else {
      const keyboard = first?.source === 'keyboard' ? first : { source: 'keyboard' as const, ...(await fromKeyboard) };
      // #38454 Terra ⑤: the poll is periodic — look once more. OP's receipt that is EARLIER than the keyboard answer (or any
      // OP answer when the keyboard only timed out or was cancelled) wins.
      const late = read();
      const keyboardDecided = keyboard.outcome.approved || keyboard.outcome.reason === 'declined';
      if (late !== null && (!keyboardDecided || late.atMs <= keyboard.atMs)) { source = 'op'; outcome = opOutcome(late); ports.cancelLocal(callId); }
      else { source = 'keyboard'; outcome = keyboard.outcome; }
    }
    if (source === 'op') ports.setStatus(outcome.approved ? `OP 승인 (#${mailId})` : `OP 거부 (#${mailId})`);
    ports.log('decided', { seat: ports.seat, callId, mailId, source, approved: outcome.approved, ...(outcome.approved ? {} : { reason: outcome.reason }), auditSha256: verdict.auditSha256 });
    return remember(outcome);
  };
}

/**
 * The live ledger side of {@link SeatApprovalPorts}: the request is a structured `request` mail to OP, OP's decision is its
 * B1-C receipt (`eln msg receipt <id> accepted|rejected --to OP`).
 * Seat role prefixes (OP 11-18 answer): written by OP ONLY, at `seat-state/OP/approval-allow/<SEAT>` — outside the seat's
 * own folder — and read-only here. A regular file only (a symlink could point into a seat-writable place). An allow file
 * in the seat's own folder (`seat-state/<SEAT>/approval-allow`) is a trace of the seat writing its own permissions: it is
 * ignored and reported (`allow-file-ignored` warn). The list is a versioned single-writer artifact (OP Bloom 5 ⑥):
 * `version` must move forward, the sha256 `lock` must match the remaining lines, and an item ID revoked once (revoke) may
 * never come back — a backwards version or a resurrected tombstone is refused and reported.
 */
export function seatApprovalLedgerPorts(seat: string, deps: { msgPath?: string; seatStateRoot?: string; log?: (event: string, data: Record<string, unknown>) => void } = {}): Pick<SeatApprovalPorts, 'postRequest' | 'readDecision' | 'extraAllowShapes'> {
  const { join } = require('node:path') as typeof import('node:path');
  const { readFileSync, lstatSync } = require('node:fs') as typeof import('node:fs');
  const { homedir } = require('node:os') as typeof import('node:os');
  const msg = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const open = () => new msg.MsgStore(deps.msgPath ?? msg.defaultMsgStorePath());
  const root = deps.seatStateRoot ?? join(homedir(), 'elanous-hq', 'seat-state');
  const report = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* fail-open */ } };
  // 목록 세대 상태(프로세스 안): version 은 단조 증가 · 한 번 철회된 항목 ID 는 되살아나면 거부(Bloom 5 ⑥).
  let lastVersion: number | null = null;
  const tombstones = new Map<string, number>();
  return {
    postRequest: body => { const store = open(); try { return store.post({ from: seat, to: 'OP', body, intent: 'request' }).id; } finally { store.close(); } },
    readDecision: mailId => {
      const store = open();
      try {
        const decided = store.listReceipts({ messageId: mailId }).filter(r => r.recipient === 'OP' && (r.state === 'accepted' || r.state === 'rejected')).at(-1);
        return decided === undefined ? null : { approved: decided.state === 'accepted', atMs: Date.parse(decided.at) };
      } finally { store.close(); }
    },
    extraAllowShapes: () => {
      const seatOwn = join(root, seat, 'approval-allow');
      try { lstatSync(seatOwn); report('allow-file-ignored', { seat, path: seatOwn, reason: 'seat-own-folder (only OP writes allow files)' }); } catch { /* absent: fine */ }
      const file = join(root, 'OP', 'approval-allow', seat);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) { report('allow-file-ignored', { seat, path: file, reason: stat.isSymbolicLink() ? 'symlink' : 'not a regular file' }); return []; }
        const parsed = parseSeatAllowList(readFileSync(file, 'utf8'));
        if (!parsed.ok) { report('allow-file-ignored', { seat, path: file, reason: `unreadable allow list: ${parsed.error}` }); return []; }
        if (lastVersion !== null && parsed.list.version < lastVersion) { report('allow-file-ignored', { seat, path: file, reason: `version ${parsed.list.version} went backwards (last seen ${lastVersion})` }); return []; }
        for (const [id, atVersion] of parsed.list.tombstones) tombstones.set(id, Math.max(tombstones.get(id) ?? 0, atVersion));
        lastVersion = parsed.list.version;
        const resurrected = parsed.list.shapes.find(item => tombstones.has(item.id));
        if (resurrected !== undefined) { report('allow-file-ignored', { seat, path: file, reason: `tombstone ${resurrected.id} resurrected` }); return []; }
        return parsed.list.shapes;
      } catch { return []; }
    },
  };
}
