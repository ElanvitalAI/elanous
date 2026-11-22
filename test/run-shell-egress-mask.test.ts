// ── RUNSHELL-OUTPUT-EGRESS-MASK(ROSTER-0333-60 · #1순위) RED —
// RunShell 출력(stdout/stderr/notice)이 모델로 나가는 출구에서 기존 공용
// redactSecretText(gitleaks 이식 룰셋 · 새 정규식 0)으로 가려지는지.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchRunShell, runShellCapsuleNoticeText, maskRunShellEgress } from '../src/skills/tools/shell';
import { runShellScript } from '../src/skills/tools/run-shell-script';
import { redactSecretText } from '../src/debug/log';
import { _resetApprovalCacheForTesting } from '../src/shell-primitive/approval-cache';
import { setShellApprover, setAuditSinkForTesting } from '../src/shell-primitive';

const SECRET = 'sk-or-v1-abcdef0123456789abcdef0123456789';

describe('RunShell 출력 egress 비밀 마스킹', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rs-egress-'));
    _resetApprovalCacheForTesting();
    setShellApprover(null);
    setAuditSinkForTesting(() => { /* swallow audit in tests */ });
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    _resetApprovalCacheForTesting();
    setShellApprover(null);
    setAuditSinkForTesting(null);
  });

  test('stdout 의 공급자 키 원문이 결과에서 가려진다', async () => {
    const res = await dispatchRunShell({
      command: ['bash', '-lc', `echo "key=${SECRET}"`], cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain(SECRET);
    expect(res.stdout).toContain('sk-or-v1-***');
  });

  test('stderr 의 Bearer 토큰 원문이 결과에서 가려진다', async () => {
    const res = await dispatchRunShell({
      command: ['bash', '-lc', `echo "Authorization: Bearer ${SECRET}" >&2`], cwd,
    });
    expect(res.stderr).not.toContain(SECRET);
  });

  test('캡슐 완주 통지문(notice) 원문도 가려진다', async () => {
    const res = await dispatchRunShell({
      command: ['bash', '-lc', `echo "token: ${SECRET}"`], cwd,
    });
    const notice = runShellCapsuleNoticeText(res);
    expect(notice).not.toContain(SECRET);
  });
});

// ── RUNSHELL-OUTPUT-EGRESS-MASK 후속 RED → GREEN — escaped-quote 를 포함한 secret형 JSON stdout ──
// 원인: redactSecretText 값 클래스가 백슬래시를 삼켜 \" 의 이스케이프를 벗겨 JSON 을 파손.
//   redactSecretText(String.raw`{"note":"say \"token=abcdef123456\" out loud"}`) → parse FAIL
//   redactSecretText(String.raw`{"plain":"token=abcdef123456"}`)                → parse OK
// 패치: maskRunShellEgress 의 stdout 경로만 구조 보존(parse → 값 단위 가림 → 재직렬화).
describe('RunShell egress 마스킹의 JSON 구조 보존', () => {
  const secretJson = String.raw`{"note":"say \"token=abcdef123456\" out loud"}`;
  const plainJson = String.raw`{"plain":"token=abcdef123456"}`;

  test('RED 원인 문서화: redactSecretText 직접 적용은 escaped-quote 포함 JSON 을 파손한다(룰셋 무변경 · 고장 명세)', () => {
    // 룰셋(secret-redaction.ts)은 건드리지 않는다 — 이 동작 자체가 고장의 원인이며
    // 패치는 maskRunShellEgress 의 stdout 경로에서 구조를 보존하는 것으로 회피한다.
    const masked = redactSecretText(secretJson);
    expect(() => JSON.parse(masked)).toThrow();
  });

  test('GREEN: maskRunShellEgress 를 통과한 stdout 은 escaped-quote 포함 JSON 이 파손 없이 가려진다', () => {
    const res = maskRunShellEgress({
      output: 'RunShell outcome=exit exitCode=0 elapsed=1ms', exitCode: 0, outcome: 'exit',
      elapsedMs: 1, stdout: secretJson, stderr: '', truncated: false,
      approvalKey: 't', sandboxed: false, sandboxTool: 'none',
    });
    const parsed = JSON.parse(res.stdout) as { note: string };
    expect(parsed.note).toBe('say "token=***" out loud');
  });

  test('GREEN: script mode 종단 — step stdout 이 해당 JSON 이면 selected 가 나온다(구조 보존 마스킹본 경유)', async () => {
    // 목 dispatchOne — 실제 dispatchRunShell 출구와 동일하게 maskRunShellEgress 를 적용한다.
    // 새 배선(rawInternal 원문 재귀)에서는 내부 step 이 원문을 받으므로 이 시험은 방어 대조:
    // «설령 마스킹본이 와도 구조 보존 덕에 parse·select 는 살아남는다»를 고정한다.
    const dispatchOne = async () => maskRunShellEgress({
      output: 'RunShell outcome=exit exitCode=0 elapsed=1ms', exitCode: 0, outcome: 'exit' as const,
      elapsedMs: 1, stdout: secretJson, stderr: '', truncated: false,
      approvalKey: 'test', sandboxed: false, sandboxTool: 'none' as const,
    });
    const res = await runShellScript(
      [{ id: 's1', command: ['eln', 'ops', 'status', '--json'], select: ['note'] }],
      undefined, 5000, dispatchOne,
    );
    const receipt = (JSON.parse(res.stdout) as { steps: { id: string; selected?: Record<string, unknown> }[] }).steps[0]!;
    expect(receipt.selected?.note).toBeDefined();
    expect(String(receipt.selected?.note)).not.toContain('abcdef123456');
  });

  // RSEM-RAW-RECEIPT(OP #126921·MOB-1 #126930·OP 수리 지시 #126945) — script step 재귀는
  // 원문(unmasked) stdout으로 영수(sha·bytes)·JSON.parse·select를 계산하고, 모델로 가는
  // 최종 결과만 단일 출구에서 마스킹한다. 실스폰 종단 근거: evidence/rsem-e2e-proof-r1.md.
  test('GREEN: script step 재귀는 원문 기준 영수·select — 모델 결과만 마스킹(rawInternal 배선)', async () => {
    const createHash = (await import('node:crypto')).createHash;
    const rawStdout = secretJson; // 토큰 원문 포함
    const expectedSha = createHash('sha256').update(rawStdout).digest('hex');
    // §5 배선 그대로: 재귀 호출은 rawInternal 로 원문 반환, 외측이 단일 출구 마스킹.
    const rawInternalResult = {
      output: 'RunShell outcome=exit exitCode=0 elapsed=1ms', exitCode: 0, outcome: 'exit' as const,
      elapsedMs: 1, stdout: rawStdout, stderr: '', truncated: false,
      approvalKey: 't', sandboxed: false, sandboxTool: 'none' as const,
    };
    const dispatchOne = async () => maskRunShellEgress(rawInternalResult, { rawInternal: true });
    const res = await runShellScript(
      [{ id: 's1', command: ['eln', 'ops', 'status', '--json'], select: ['note'] }],
      undefined, 5000, dispatchOne,
    );
    const outer = JSON.parse(res.stdout) as { steps: { id: string; stdoutSha256: string; bytes: number; selected?: Record<string, unknown> }[] };
    // ① 영수는 원문 기준(마스킹본 sha 아님)
    expect(outer.steps[0]!.stdoutSha256).toBe(expectedSha);
    expect(outer.steps[0]!.bytes).toBe(Buffer.byteLength(rawStdout));
    // ② select 는 원문에서 성공(토큰 식별자는 selected 가림 유지)
    expect(outer.steps[0]!.selected?.note).toBeDefined();
    expect(String(outer.steps[0]!.selected?.note)).not.toContain('abcdef123456');
    // ③ 모델로 가는 최종 결과는 마스킹(단일 출구) — 외측 res 는 maskRunShellEgress(scriptResult) 결과
    const maskedOuter = maskRunShellEgress(res);
    expect(maskedOuter.stdout).not.toContain('abcdef123456');
    expect(() => JSON.parse(maskedOuter.stdout)).not.toThrow();
  });

  test('GREEN: 구조 동등 — 재직렬화 결과는 원문과 구조가 같고 비밀 값만 가려진다(깊은 비교)', () => {
    const original = {
      note: 'say "token=abcdef123456" out loud',
      nested: { token: 'sk-or-v1-abcdef0123456789abcdef0123456789' },
      list: ['xoxb-1234567890abcdefghij'],
      plain: 'token=abcdef123456',
      number: 42, flag: true, nil: null,
    };
    const res = maskRunShellEgress({
      output: '', exitCode: 0, outcome: 'exit', elapsedMs: 0,
      stdout: JSON.stringify(original), stderr: '', truncated: false,
      approvalKey: 't', sandboxed: false, sandboxTool: 'none',
    });
    const masked = JSON.parse(res.stdout);
    expect(Object.keys(masked).sort()).toEqual(Object.keys(original).sort());
    expect(Object.keys(masked.nested as object).sort()).toEqual(Object.keys(original.nested).sort());
    expect(Array.isArray(masked.list)).toBe(true);
    expect(masked.number).toBe(42);
    expect(masked.flag).toBe(true);
    expect(masked.nil).toBeNull();
    // 비밀 본문만 가려졌는지 — 식별 접두는 남고 본문은 없다.
    expect(String((masked.nested as { token: string }).token)).toBe('sk-or-v1-***');
    expect(String((masked.list as string[])[0])).toBe('xoxb-***');
    expect(String(masked.plain)).toBe('token=***');
    expect(String(masked.note)).toBe('say "token=***" out loud');
    expect(res.stdout).not.toContain('abcdef123456');
    expect(res.stdout).not.toContain('abcdef0123456789');
  });

  test('GREEN: 비-JSON stdout 은 기존 텍스트 축 폴백(escaped-quote 없는 secret형 JSON parse OK 대조군 포함)', () => {
    expect(() => JSON.parse(redactSecretText(plainJson))).not.toThrow();
    const nonJson = `plain text with ${SECRET}`;
    const res = maskRunShellEgress({
      output: '', exitCode: 0, outcome: 'exit', elapsedMs: 0,
      stdout: nonJson, stderr: '', truncated: false,
      approvalKey: 't', sandboxed: false, sandboxTool: 'none',
    });
    expect(res.stdout).not.toContain(SECRET);
    expect(res.stdout).toContain('sk-or-v1-***');
  });
});

// ── RSEM-JSONFIX-R2(OP #128225 · JUD-B #128222) RED→GREEN — 원문 텍스트 위 값 치환 ──
// 재현(mbp probe /tmp/judb-39537-7CHOqKrV/probe-39537.ts): parse→객체 재구성→stringify
// 마스킹이 {"__proto__":{"marker":"own-value"},"big":9007199254740993,...} 에서
// __proto__ own 키 삭제(OWN_PROTO_AFTER=false)·9007199254740993 → …992 변형.
// 패치: 구조 재직렬화 금지 — 원문 stdout 의 비밀 «값» 리터럴만 위치 기반 치환.
describe('RunShell egress 마스킹 — 원문 텍스트 위 값 치환(구조 재직렬화 금지)', () => {
  const judProbeJson = '{"__proto__":{"marker":"own-value"},"big":9007199254740993,"normal":{"key":"value","count":7}}';
  const secretWithStructureJson = '{"__proto__":{"marker":"own-value"},"big":9007199254740993,"normal":{"key":"value","count":7},"note":"token=abcdef123456"}';
  const escapedQuoteBigJson = String.raw`{"note":"say \"token=abcdef123456\" out loud","big":9007199254740993}`;

  const runMask = (stdout: string) => maskRunShellEgress({
    output: 'RunShell outcome=exit exitCode=0 elapsed=1ms', exitCode: 0, outcome: 'exit',
    elapsedMs: 1, stdout, stderr: '', truncated: false,
    approvalKey: 't', sandboxed: false, sandboxTool: 'none',
  });

  test('비밀 없는 JSON stdout 은 원문과 바이트 단위로 동일(__proto__ own 키·2^53 정수 보존)', () => {
    expect(runMask(judProbeJson).stdout).toBe(judProbeJson);
  });

  test('비밀 포함 — 비밀 든 리터럴만 치환: __proto__ 키·2^53 정수·나머지 바이트 원문 그대로, JSON 유효', () => {
    const masked = runMask(secretWithStructureJson).stdout;
    expect(masked).not.toContain('abcdef123456');
    expect(masked).toContain('"token=***"');
    expect(masked).toContain('"__proto__":{"marker":"own-value"}');
    expect(masked).toContain('"big":9007199254740993');
    expect(masked).toContain('"normal":{"key":"value","count":7}');
    expect(() => JSON.parse(masked)).not.toThrow();
  });

  test('escaped-quote 비밀값 + 2^53 정수 — 이스케이프 보존·정수 불변·JSON 유효', () => {
    const masked = runMask(escapedQuoteBigJson).stdout;
    expect(masked).not.toContain('abcdef123456');
    expect(masked).toContain('token=***');
    expect(masked).toContain('"big":9007199254740993');
    const parsed = JSON.parse(masked) as { note: string; big: unknown };
    expect(parsed.note).toBe('say "token=***" out loud');
  });

  // ── RSEM-KEYFIX-R3 (jud-39537-6eb6a2057b8d mustFix · OP #128535) —
  // 비밀이 객체 «키»에 들어간 경우(중첩 포함). 값만 가리는 이전 head 는 키 원문이
  // 모델 출력에 그대로 남았다.
  test('KEYFIX-R3: 중첩 객체 키에 든 비밀도 가려진다 — 비밀 없는 키·숫자는 원문 그대로', () => {
    const nestedKeyJson = '{"outer":{"inner":{"token=abcdef123456":{"deep":true}},"keep":1}}';
    const masked = runMask(nestedKeyJson).stdout;
    expect(masked).not.toContain('abcdef123456');
    expect(masked).toContain('"token=***"');
    expect(masked).toContain('"keep":1');
    expect(masked).toContain('{"deep":true}');
    expect(() => JSON.parse(masked)).not.toThrow();
  });

  test('KEYFIX-R3: 키 충돌 — 마스킹된 키가 기존 키와 겹쳐도 비밀 미노출·JSON 유효', () => {
    const collisionJson = '{"token=abcdef123456":"first","token=***":"second","plain":"x"}';
    const masked = runMask(collisionJson).stdout;
    expect(masked).not.toContain('abcdef123456');
    expect((masked.match(/"token=\*\*\*"/g) ?? []).length).toBe(2); // 위치 기반 — 중복 키 그대로
    expect(() => JSON.parse(masked)).not.toThrow();
    const parsed = JSON.parse(masked) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(['token=***', 'plain']); // 중복 키 — 파서는 마지막 키 우선
    expect(parsed['token=***']).toBe('second');
    expect(parsed['plain']).toBe('x');
  });

  test('KEYFIX-R3: 비밀 아닌 키·값은 바이트 불변 — 이스케이프·키 순서 유지', () => {
    const cleanJson = '{"name":"a","count":2,"note":"say \\"token=abcdef123456\\" loud"}';
    const masked = runMask(cleanJson).stdout;
    expect(masked).toContain('"name":"a"');
    expect(masked).toContain('"count":2');
    expect(masked).toContain('say \\"token=***\\" loud');
    expect(masked.indexOf('"name"')).toBeLessThan(masked.indexOf('"count"'));
    expect(() => JSON.parse(masked)).not.toThrow();
  });
});
