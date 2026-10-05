// clarification 리졸버 lease + 설치된 리졸버의 «실제» 타임아웃 경로.
//
// ⛔ 왜 이 파일이 있나 — 첫 산출의 통합 테스트가 dispatch seam 을 곧바로
//    cancelled 로 돌려 「설치된 리졸버가 실제로 불리는」 경로를 한 번도 안 탔다
//    (무인 리뷰가 Goodhart 로 지적). 여기서는 «진짜 리졸버»를 만들어 부른다.
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { readPendingQuestions } from '../ask-user-question/pending-questions.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import {
  getAskUserQuestionResolver,
  setAskUserQuestionResolver,
  type AskUserQuestionResolver,
} from '../ask-user-question/tool.js';
import { createTestReadlineHost } from '../expression/widget/readline-host.js';
import { createWidgetAskUserResolver } from '../expression/widget/adapters/ask-user-resolver.js';
import { acquireClarificationResolverLease, decideClarificationResolverInstall } from './clarification-resolver-lease.js';

const noopResolver: AskUserQuestionResolver = async () => ({ answers: {}, cancelled: true });

// ⛔ 무조건 null 로 만들면 «남의» 전역 리졸버를 훼손한다(무인 리뷰 R6) — 원래 값을 되돌린다.
let priorResolver: AskUserQuestionResolver | null = null;
let priorStateDir: string | undefined;
let isolatedStateDir: string;
beforeEach(() => {
  priorResolver = getAskUserQuestionResolver();
  priorStateDir = process.env.ELANOUS_STATE_DIR;
  expect(getElanousConfigDirOverride()).toBeUndefined();
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'clarification-lease-state-'));
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
});
afterEach(() => {
  setAskUserQuestionResolver(priorResolver);
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe('acquireClarificationResolverLease', () => {
  test('disabled 면 아무것도 설치하지 않는다', () => {
    const lease = acquireClarificationResolverLease(false, () => noopResolver);
    expect(lease.installed).toBe(false);   // ⭐ 관측은 이 값을 쓴다 — config 조건이 아니다
    expect(getAskUserQuestionResolver()).toBe(null);
    lease.release();
    expect(getAskUserQuestionResolver()).toBe(null);
  });

  test('마지막 lease 만 이전 리졸버를 되돌린다', () => {
    const a = acquireClarificationResolverLease(true, () => noopResolver);
    expect(a.installed).toBe(true);
    const installed = getAskUserQuestionResolver();
    expect(installed).not.toBe(null);

    const b = acquireClarificationResolverLease(true, () => noopResolver);
    expect(getAskUserQuestionResolver()).toBe(installed);

    a.release();
    expect(getAskUserQuestionResolver()).toBe(installed); // 아직 b 가 잡고 있다
    b.release();
    expect(getAskUserQuestionResolver()).toBe(null);
  });

  test('이미 남의 리졸버가 걸려 있으면 설치하지 않는다', () => {
    setAskUserQuestionResolver(noopResolver);
    const lease = acquireClarificationResolverLease(true, () => async () => ({ answers: {} }));
    // ⛔⭐ 켜져 있어도 «설치는 안 됐다» — 이걸 config 조건으로 적으면 관측이 거짓이 된다(R4).
    expect(lease.installed).toBe(false);
    expect(getAskUserQuestionResolver()).toBe(noopResolver);
    lease.release();
    expect(getAskUserQuestionResolver()).toBe(noopResolver);
  });

  // ⛔ 무인 리뷰 must-fix ②의 재현 — 바깥이 리졸버를 null 로 바꾼 뒤 다시 acquire.
  test('lease 활성 중 바깥이 리졸버를 지워도 관리 상태를 덮지 않는다', () => {
    const first = acquireClarificationResolverLease(true, () => noopResolver);
    const managed = getAskUserQuestionResolver();
    expect(managed).not.toBe(null);

    setAskUserQuestionResolver(null); // 바깥이 치웠다

    let created = 0;
    const second = acquireClarificationResolverLease(true, () => { created += 1; return noopResolver; });
    expect(created).toBe(0);                       // ⛔ 새로 설치하지 않는다
    expect(getAskUserQuestionResolver()).toBe(null);

    // 살아 있던 lease 를 놓아도 음수 카운트·조기 제거가 없다.
    second.release();
    first.release();

    // 관리 상태가 온전하면 다음 acquire 가 «정상적으로» 다시 설치된다.
    const third = acquireClarificationResolverLease(true, () => noopResolver);
    expect(getAskUserQuestionResolver()).not.toBe(null);
    third.release();
    expect(getAskUserQuestionResolver()).toBe(null);
  });
});

describe('설치된 리졸버의 실제 타임아웃 경로', () => {
  test('아무도 답하지 않으면 유한 시간 안에 cancelled 로 돌아오고 host 를 닫는다', async () => {
    const host = createTestReadlineHost();
    const resolver = createWidgetAskUserResolver({
      hostFactory: () => host,
      timeoutMs: 20,
    });
    const lease = acquireClarificationResolverLease(true, () => resolver);
    try {
      const installed = getAskUserQuestionResolver();
      expect(installed).toBe(resolver);

      const started = Date.now();
      const result = await installed!({
        questions: [{
          id: 'q1', header: 'H', question: 'Q?',
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
        }],
      } as Parameters<AskUserQuestionResolver>[0]);

      expect(result.cancelled).toBe(true);          // ⭐ 미답이 «취소»로 온다
      expect(Object.keys(result.answers)).toHaveLength(0);
      expect(Date.now() - started).toBeLessThan(5_000); // ⛔ 유한하다(무한 대기 금지)
      await Promise.resolve();
      expect(host.closed).toBe(true);               // ⭐ 타이머 만료가 host 를 닫는다
    } finally {
      lease.release();
    }
  });
});

// ⛔ 무인 리뷰 must-fix ② — 「전역 설치 → 기본 dispatch → escalation → 런 계속」의
//    «실제 연결»을 탄다. dispatch seam 을 주입하지 «않는» 것이 이 테스트의 요점이다.
describe('전역 설치 → 기본 dispatch → escalation (seam 주입 없음)', () => {
  const unresolvedGoal = [
    'Goal',
    '- Clarification:',
    '  - id: delivery_scope',
    '  - header: Delivery',
    '  - question: Which human surface should receive this?',
    '  - options:',
    '    - label: Telegram',
    '      description: Send the question to the Telegram operator.',
    '    - label: Discord',
    '      description: Send the question to the Discord operator.',
    '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: Which human surface should receive this?',
    '',
  ].join('\n');

  test('아무도 답하지 않아도 «폴백 문면 없이» 끝나고 호출자가 계속 갈 수 있다', async () => {
    const { escalateGoalDocumentClarifications } = await import('./goal-clarification-escalation.js');

    const root = mkdtempSync(join(tmpdir(), 'clarification-lease-e2e-'));
    const goalPath = join(root, 'GOAL.txt');
    writeFileSync(goalPath, unresolvedGoal);

    const host = createTestReadlineHost();
    const lease = acquireClarificationResolverLease(true, () => createWidgetAskUserResolver({
      hostFactory: () => host,
      timeoutMs: 20,
    }));
    const fallbackMessages: string[] = [];
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: goalPath,
        delivery: 'terminal',
        fallback: (message) => { fallbackMessages.push(message); },
        // ⛔ dispatch 를 주입하지 «않는다» — 전역 리졸버를 타는 것이 요점이다.
      });

      expect(result.unanswered).toBe(1);
      // ⭐ 리졸버가 설치됐으므로 「리졸버 부재」 폴백 문면이 «나오지 않는다».
      expect(fallbackMessages).toHaveLength(0);
      // ⭐⭐⭐ 그리고 「물었는데 아무도 안 답했다」가 «자기 값»으로 온다.
      expect(result.outcome).toBe('no-response');
      expect(result.answeredBy).toBe('none');
      expect(result.delivery).toBe('terminal');
    } finally {
      lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⭐⭐⭐ 이 골의 핵심 요구 — 「물어볼 데가 없었다」와 「물었는데 무응답」이 «다른 값»이다.
  //    위 테스트와 «같은 골·같은 호출»인데 리졸버만 없앤다(대조군).
  test('리졸버가 없으면 «다른 값»으로 끝난다 — 폴백 문면이 나온다', async () => {
    const { escalateGoalDocumentClarifications } = await import('./goal-clarification-escalation.js');

    const root = mkdtempSync(join(tmpdir(), 'clarification-lease-e2e-none-'));
    const goalPath = join(root, 'GOAL.txt');
    // Resolve the OS account independently of the deterministic runner's redirected HOME.
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('Unable to resolve the real OS account UID');
    const systemHome = process.platform === 'darwin'
      ? execFileSync('dscl', ['.', '-read', `/Users/${userInfo().username}`, 'NFSHomeDirectory'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1)
      : readFileSync('/etc/passwd', 'utf8').split('\n')
        .find((line) => Number(line.split(':')[2]) === uid)?.split(':')[5];
    if (!systemHome) throw new Error('Unable to resolve the real OS account home');
    const operationalRoot = join(systemHome, '.elanous');
    expect(operationalRoot).not.toContain('elanous-deterministic-test-');
    const questionId = `goal-clarification:${goalPath}:delivery_scope`;
    const questionFile = (stateRoot: string) => join(stateRoot, 'ask-user-question', 'pending', `${encodeURIComponent(questionId)}.json`);
    const operationalLedger = join(operationalRoot, 'decisions', 'decisions.jsonl');
    const operationalQuestion = questionFile(operationalRoot);
    const ledgerBefore = existsSync(operationalLedger) ? readFileSync(operationalLedger) : null;
    const questionBefore = existsSync(operationalQuestion) ? readFileSync(operationalQuestion) : null;
    expect(operationalRoot).not.toBe(isolatedStateDir);
    writeFileSync(goalPath, unresolvedGoal);

    setAskUserQuestionResolver(null); // ⛔ 아무도 없다
    const fallbackMessages: string[] = [];
    try {
      const result = await escalateGoalDocumentClarifications({
        goalFile: goalPath,
        delivery: 'telegram',
        testOrigin: true,
        fallback: (message) => { fallbackMessages.push(message); },
      });

      expect(result.unanswered).toBe(1);
      expect(fallbackMessages).toHaveLength(1);                 // ⭐ 폴백이 «불린다»
      expect(fallbackMessages[0]).toContain('no resolver in this surface');
      expect(result.outcome).not.toBe('no-response');           // ⭐⭐⭐ 위와 «다른 값»
      expect(result.answeredBy).toBe('none');
      expect(elanousStateRoot()).toBe(isolatedStateDir);
      const pending = readPendingQuestions();
      expect(pending.ok).toBe(true);
      if (!pending.ok) throw new Error(pending.error);
      expect(pending.questions.map(({ id }) => id)).toEqual([questionId]);
      expect(pending.questions[0]!.testOrigin).toBe(true);
      expect(existsSync(questionFile(isolatedStateDir))).toBe(true);
      expect(existsSync(operationalQuestion) ? readFileSync(operationalQuestion) : null).toEqual(questionBefore);
      expect(existsSync(operationalLedger) ? readFileSync(operationalLedger) : null).toEqual(ledgerBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔ 무인 리뷰 R5 — 「설치했다」와 「그것이 답한다」는 다른 사실이다.
  //    dispatch 를 주입하면 전역 리졸버는 «불리지 않으므로» 표면을 terminal 로 적으면 거짓이다.
  test('dispatch 가 주입되면 전역 리졸버는 «불리지 않는다» — 그 사실이 관측에 남아야 한다', async () => {
    const { escalateGoalDocumentClarifications } = await import('./goal-clarification-escalation.js');

    const root = mkdtempSync(join(tmpdir(), 'clarification-lease-seam-'));
    const goalPath = join(root, 'GOAL.txt');
    writeFileSync(goalPath, unresolvedGoal);

    let resolverCalls = 0;
    const lease = acquireClarificationResolverLease(true, () => async () => {
      resolverCalls += 1;
      return { answers: {}, cancelled: true };
    });
    try {
      expect(lease.installed).toBe(true);
      const result = await escalateGoalDocumentClarifications({
        goalFile: goalPath,
        delivery: 'telegram',
        dispatch: async () => ({ output: 'seam', result: { answers: {} } }),
        fallback: () => {},
      });
      // ⭐ 전역 리졸버는 «한 번도» 안 불렸다 — 설치돼 있어도.
      expect(resolverCalls).toBe(0);
      // ⇒ 그러므로 표면은 호출자가 말한 값이지 우리 터미널이 아니다.
      expect(result.delivery).toBe('telegram');
    } finally {
      lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 비TTY는 사람 대기 리졸버를 설치하지 않고 미답 진행으로 떨어진다.
describe('decideClarificationResolverInstall', () => {
  test('⭐ 비-TTY는 유효한 user-config timeout이어도 미답 진행으로 리졸버 설치를 건너뛴다', () => {
    expect(decideClarificationResolverInstall({ enabled: true, timeoutMs: 20 }, false))
      .toEqual({ install: false, skipReason: 'unattended-proceeds-unanswered' });
  });

  test('TTY도 설치한다', () => {
    expect(decideClarificationResolverInstall({ enabled: true, timeoutMs: 20 }, true))
      .toEqual({ install: true, surface: 'terminal', delivery: 'terminal' });
  });

  test('timeoutMs 가 없으면 «켜져 있어도» 설치하지 않는다 — 무한 대기 금지가 우선', () => {
    expect(decideClarificationResolverInstall({ enabled: true }, true))
      .toEqual({ install: false, skipReason: 'timeout-not-configured' });
  });

  test('꺼져 있으면 disabled 다 — ⛔ 이건 경고할 일이 아니다(정상)', () => {
    expect(decideClarificationResolverInstall({ enabled: false, timeoutMs: 20 }, true))
      .toEqual({ install: false, skipReason: 'disabled' });
  });
});
