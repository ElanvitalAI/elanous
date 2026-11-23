/**
 * shell-argv-policy — 공용 셸 판정 모듈 시험 (#38454 r4 쪼개기 ① 최소 PR · OP msg:88016, 11-18).
 * 이 파일은 순수 모듈 API(classifyShellArgv·simpleArgv·shellArgvAuditSha256·parseSeatAllowList) 시험만 담는다.
 * seatApprovalDecision 파이프라인 판정표(판정표 · Terra r2 must 5 · sha256 2건)는 src/tui/seat-approval-policy.ts 에 의존하므로 FU PR(#38454 승인 배선)에서 함께 간다.
 * 기대값은 전부 독립 리터럴이다(규칙 11) — production 상수를 import 해 비교하지 않는다.
 * classifyShell(#38448) 이 이 모듈을 그대로 부를 수 있는지도 여기서 증명한다(순수 함수 입력→결정).
 */
import { createHash } from 'node:crypto';
import { describe, test, expect } from 'bun:test';
import { classifyShellArgv, parseSeatAllowList, shellArgvAuditSha256, simpleArgv, type AllowShape } from './shell-argv-policy.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');



describe('sha256 감사 (조항 5) — 원문 인자 대신 해시', () => {
  test('shellArgvAuditSha256 — 독립 계산과 일치', () => {
    expect(shellArgvAuditSha256('git status')).toBe(sha256('git status'));
    expect(shellArgvAuditSha256('git push -u origin hand/x')).toBe(sha256('git push -u origin hand/x'));
  });
});

describe('공용 모듈 순수 함수 — classifyShell(#38448) 이 부를 형태', () => {
  const extra: readonly AllowShape[] = [{ id: 'seat-demo', name: 'seat:seat-demo', tokens: [{ lit: 'demo-tool' }, { lit: 'run' }] }];

  test('simpleArgv — 인용 합체 · 안 닫히면 null', () => {
    expect(simpleArgv('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(simpleArgv('a "b c')).toBe(null);
  });

  test('classifyShellArgv — argv 정확 일치만 승인', () => {
    const allow = classifyShellArgv({ command: 'demo-tool run', argv: ['demo-tool', 'run'], allow: extra });
    expect(allow.verdict).toBe('allow');
    if (allow.verdict === 'allow') expect(allow.reason).toBe('allow shape seat-demo');
    const ask = classifyShellArgv({ command: 'demo-tool run --x', argv: ['demo-tool', 'run', '--x'], allow: extra });
    expect(ask.verdict).toBe('ask-op');
    if (ask.verdict === 'ask-op') expect(ask.reason).toBe('not on the seat allowlist: demo-tool run');
  });

  test('classifyShellArgv — NODE_ENV/CI 접두 허용 · 그 외 거부', () => {
    expect(classifyShellArgv({ command: 'NODE_ENV=x demo-tool run', argv: ['NODE_ENV=x', 'demo-tool', 'run'], allow: extra }).verdict).toBe('allow');
    expect(classifyShellArgv({ command: 'CI=1 demo-tool run', argv: ['CI=1', 'demo-tool', 'run'], allow: extra }).verdict).toBe('allow');
    const deny = classifyShellArgv({ command: 'LD_PRELOAD=y demo-tool run', argv: ['LD_PRELOAD=y', 'demo-tool', 'run'], allow: extra });
    expect(deny.verdict).toBe('deny');
    if (deny.verdict === 'deny') expect(deny.reason).toBe('environment prefix LD_PRELOAD');
  });

  test('classifyShellArgv — 원문에 메타문자 하나라도 → deny', () => {
    const deny = classifyShellArgv({ command: 'demo-tool run | sh', argv: ['demo-tool', 'run', '|', 'sh'], allow: extra });
    expect(deny.verdict).toBe('deny');
    if (deny.verdict === 'deny') expect(deny.reason).toBe('shell metacharacter');
  });

  test('안 닫힌 인용 → 파싱 실패(null) · 판정 모듈도 deny (unterminated quote)', () => {
    const parsed = simpleArgv('git commit -m "unterminated');
    expect(parsed).toBe(null); // 파싱 실패 신호 — 호출자(seatApprovalDecision) 는 unparsed 로 fail-closed
    const deny = classifyShellArgv({ command: 'git commit -m "unterminated', argv: parsed ?? [], allow: [] });
    expect(deny.verdict).toBe('deny');
    if (deny.verdict === 'deny') expect(deny.reason).toBe('unterminated quote');
  });

  test('목록이 비었으면 기본 거부', () => {
    const parsed = simpleArgv('git status');
    const ask = classifyShellArgv({ command: 'git status', argv: parsed ?? [], allow: [] });
    expect(ask.verdict).toBe('ask-op');
    if (ask.verdict === 'ask-op') expect(ask.reason).toBe('not on the seat allowlist: git');
  });
});

describe('OP 보안 재리뷰 #88099 — 인용 환경 접두 우회 · argv/command 불일치 (회귀)', () => {
  test('인용된 환경 접두 모양 토큰(CI=…) 은 접두가 아니라 인자 → 자동 승인 없음 (fail-closed)', () => {
    const command = "'CI=bin/evil' git status";
    const parsed = simpleArgv(command);
    const bypass = classifyShellArgv({ command, argv: parsed ?? [], allow: [] });
    expect(bypass.verdict).not.toBe('allow'); // ask-op · deny 어느 쪽이든 승인은 아님
    if (bypass.verdict === 'ask-op') expect(bypass.reason).toContain('not on the seat allowlist');
  });

  test('부분 인용 토큰(C"…"=…) 도 접두가 아니다 → 자동 승인 없음', () => {
    const command = 'C"I"=bin/evil git status';
    const parsed = simpleArgv(command);
    const bypass = classifyShellArgv({ command, argv: parsed ?? [], allow: [] });
    expect(bypass.verdict).not.toBe('allow');
  });

  test('classifyShellArgv — argv 가 command 파싱과 다르면(위조) deny (argv does not match command)', () => {
    const forged = classifyShellArgv({ command: 'rm -rf /tmp/x', argv: ['git', 'status'], allow: [] });
    expect(forged.verdict).toBe('deny');
    if (forged.verdict === 'deny') expect(forged.reason).toBe('argv does not match command');
  });
});

describe('OP 보안 재리뷰 #88179 — 환경 접두 값이 name/reason 에 원문으로 새는 회귀 (r6 수리)', () => {
  const secret = 'ghp_SECRET123';

  test('인용된 환경 토큰의 값은 name/reason 에 절대 안 남는다 — NAME=**** 로 마스크', () => {
    const command = `GITHUB_TOKEN="${secret}" git status`;
    const parsed = simpleArgv(command);
    const ask = classifyShellArgv({ command, argv: parsed ?? [], allow: [] });
    expect(ask.verdict).not.toBe('allow'); // 접두 아님 → 자동 승인 없음(fail-closed)
    if (ask.verdict === 'ask-op') {
      expect(ask.name).toContain('GITHUB_TOKEN=****');
      expect(ask.name).not.toContain(secret);
      expect(ask.reason).toContain('GITHUB_TOKEN=****');
      expect(ask.reason).not.toContain(secret);
    }
  });

  test('부분 인용 환경 토큰의 값도 마스크 — NAME=****', () => {
    const command = `GITHUB_TOKEN=ghp_"${secret}" git status`;
    const parsed = simpleArgv(command);
    const ask = classifyShellArgv({ command, argv: parsed ?? [], allow: [] });
    expect(ask.verdict).not.toBe('allow');
    if (ask.verdict === 'ask-op') {
      expect(ask.name).not.toContain(secret);
      expect(ask.reason).not.toContain(secret);
      expect(ask.name).toContain('GITHUB_TOKEN=****');
    }
  });

  test('비인용 거부(env) reason 에도 값 안 남는다 — 접두 이름만(environment prefix NAME)', () => {
    const deny = classifyShellArgv({ command: `LD_PRELOAD=${secret} git status`, argv: [`LD_PRELOAD=${secret}`, 'git', 'status'], allow: [] });
    expect(deny.verdict).toBe('deny');
    if (deny.verdict === 'deny') {
      expect(deny.reason).toBe('environment prefix LD_PRELOAD');
      expect(deny.reason).not.toContain(secret);
    }
  });
});

describe('parseSeatAllowList — 버전·잠금·항목 ID·tombstone 스키마 (조항 6)', () => {
  const lockOf = (canonical: string): string => sha256(canonical);

  test('ok — 버전·모양·잠금·항목 ID', () => {
    const canonical = 'version 1\nallow seat-free demo-tool run';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.list.version).toBe(1);
    expect(parsed.list.shapes.map(s => s.id)).toEqual(['seat-free']);
    expect(parsed.list.shapes[0]?.tokens.map(t => (t as { lit?: string }).lit)).toEqual(['demo-tool', 'run']);
    expect(parsed.list.tombstones.size).toBe(0);
  });

  test('ok — revoke 줄은 tombstone 이 되고 살아 있는 모양만 남는다', () => {
    const canonical = 'version 2\nrevoke old-item 1\nallow seat-free demo-tool run';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.list.version).toBe(2);
    expect(parsed.list.shapes.map(s => s.id)).toEqual(['seat-free']);
    expect(parsed.list.tombstones.get('old-item')).toBe(1);
  });

  test.each([
    ['', 'lock line missing or duplicated'],
    ['allow seat-free demo-tool run\nlock abc', 'lock line malformed'],
    [`version 0\nallow a git show\nlock ${lockOf('version 0\nallow a git show')}`, 'version line malformed'],
    [`version x\nallow a git show\nlock ${lockOf('version x\nallow a git show')}`, 'version line malformed'],
    ['version 1\nallow a git show', 'lock line missing or duplicated'],
    ['version 1\nallow a git show\nlock a\nlock b', 'lock line missing or duplicated'],
    ['version 1\nlock a\nallow a git show', 'lock line malformed'],
  ])('스키마 위반: %s', (text, expected) => {
    const parsed = parseSeatAllowList(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(expected);
  });

  test('잠금 불일치 → 거부 (lock mismatch)', () => {
    const parsed = parseSeatAllowList(`version 1\nallow seat-free demo-tool run\nlock ${'0'.repeat(64)}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('lock mismatch');
  });

  test('version 줄이 둘 → 거부 (duplicate version)', () => {
    const canonical = 'version 1\nversion 2\nallow seat-free demo-tool run';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('version line missing or duplicated');
  });

  test('allow 항목 ID 형식 위반 → 거부', () => {
    const canonical = 'version 1\nallow Free-ID git show';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('unknown line: allow');
  });

  test('한 파일에서 철회된 항목이 다시 allow 되면 → 거부', () => {
    const canonical = 'version 1\nallow seat-free demo-tool run\nrevoke seat-free 1';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('revoked and allowed');
  });

  test('모르는 줄 → 거부 (unknown line)', () => {
    const canonical = 'version 1\npermit seat-free demo-tool run';
    const parsed = parseSeatAllowList(`${canonical}\nlock ${lockOf(canonical)}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('unknown line: permit');
  });
});

describe('SHELL-POLICY-REDACT-EDGE-FU — #38524 r3 must (JUD 20261118-1835-PRECISE-38524-r3)', () => {
  const statusOnly: readonly AllowShape[] = [{ id: 'git-status', name: 'seat:git-status', tokens: [{ lit: 'git' }, { lit: 'status' }] }];

  test('ⓒ① «\\GITHUB_TOKEN=S gh pr list» — the value never reaches name or reason', () => {
    const command = '\\GITHUB_TOKEN=S gh pr list';
    const decision = classifyShellArgv({ command, argv: simpleArgv(command)!, allow: statusOnly });
    expect(decision.verdict).not.toBe('allow');
    expect(decision.name).not.toContain('=S');
    expect(decision.reason).not.toContain('=S');
  });

  test('ⓒ② «GITHUB_TOKEN+=S gh» — the append form is masked in name and reason', () => {
    const command = 'GITHUB_TOKEN+=S gh';
    const decision = classifyShellArgv({ command, argv: simpleArgv(command)!, allow: statusOnly });
    expect(decision.verdict).toBe('ask-op');
    expect(decision.name).toBe('GITHUB_TOKEN+=****');
    expect(decision.reason).toBe('not on the seat allowlist: GITHUB_TOKEN+=****');
  });

  test('ⓐ a quoted prefix is an argument, never an env prefix: «\'CI=x\' git status» is not allow (unconditional)', () => {
    expect(classifyShellArgv({ command: 'git status', argv: ['git', 'status'], allow: statusOnly }).verdict).toBe('allow');
    const command = "'CI=x' git status";
    expect(classifyShellArgv({ command, argv: simpleArgv(command)!, allow: statusOnly }).verdict).not.toBe('allow');
  });
});

describe('seat allowlist scoped API paths', () => {
  const body = [
    'version 1',
    'allow pull gh api repos/<segment>/<segment>/pulls/<number>',
    'allow comment gh api repos/<segment>/<segment>/issues/comments/<number>',
  ].join('\n');
  const parsed = parseSeatAllowList(`${body}\nlock ${sha256(body)}\n`);
  test('GET endpoints match exactly; other paths, options and shell metacharacters do not', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    const verdict = (command: string) => classifyShellArgv({ command, argv: simpleArgv(command) ?? [], allow: parsed.list.shapes }).verdict;
    expect(verdict('gh api repos/owner/repo/pulls/42')).toBe('allow');
    expect(verdict('gh api repos/owner/repo/issues/comments/123')).toBe('allow');
    for (const command of [
      'gh api repos/owner/repo/pulls/42/files',
      'gh api repos/owner/repo/issues/42',
      'gh api repos/owner/repo/pulls/../issues',
      'gh api repos/owner/repo/pulls/%32',
      'gh api repos/owner/repo/pulls/42 -X POST',
      'gh api repos/owner/repo/pulls/42 -X DELETE',
      'gh api repos/owner/repo/pulls/42 -f title=x',
      'gh api repos/owner/repo/pulls/42?x=y',
      'gh api repos/owner/repo/pulls/42;echo bad',
    ]) expect(verdict(command)).not.toBe('allow');
  });
  test('unknown and malformed placeholders fail closed', () => {
    for (const template of ['repos/<owner>/pulls/<number>', 'repos/<segment>/../pulls/<number>', 'repos/<segment>/pulls/<number>/']) {
      const bad = `version 1\nallow bad gh api ${template}`;
      expect(parseSeatAllowList(`${bad}\nlock ${sha256(bad)}\n`).ok).toBe(false);
    }
  });
});

describe('SHELL-POLICY-REDACT-EDGE-FU — Terra #38524 처분 3 (dispositions-76d092c6b9fe.json)', () => {
  const lockOf = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');
  const listText = (body: string): string => `${body}\nlock ${lockOf(body)}\n`;

  test('ⓒ allow any: a slot in the program position is refused — «allow any <cmd> <args...>»', () => {
    const parsed = parseSeatAllowList(listText('version 1\nallow any <cmd> <args...>'));
    expect(parsed).toEqual({ ok: false, error: 'allow any must start with a fixed program name' });
  });

  test('ⓒ neighbour: a fixed program with slots after it still parses', () => {
    const parsed = parseSeatAllowList(listText('version 1\nallow ls-path ls <path>'));
    expect(parsed.ok).toBe(true);
  });

  test('ⓑ lastIndex: a g/y RegExp slot gives the same verdict on every call', () => {
    const shapes: readonly AllowShape[] = [{ id: 'cat-file', name: 'seat:cat-file', tokens: [{ lit: 'cat' }, { slot: 'file', re: /^[a-z]+$/g }] }];
    const verdicts = [1, 2, 3].map(() => classifyShellArgv({ command: 'cat notes', argv: ['cat', 'notes'], allow: shapes }).verdict);
    expect(verdicts).toEqual(['allow', 'allow', 'allow']);
  });

  test('ⓑ empty argv: «CI=1» alone and an empty command are denied even with an empty shape on the list', () => {
    const empty: readonly AllowShape[] = [{ id: 'empty', name: 'seat:empty', tokens: [] }];
    expect(classifyShellArgv({ command: 'CI=1', argv: ['CI=1'], allow: empty })).toMatchObject({ verdict: 'deny', reason: 'empty command' });
    expect(classifyShellArgv({ command: '', argv: [], allow: empty }).verdict).toBe('deny');
  });
});
