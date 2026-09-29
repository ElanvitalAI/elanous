import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __resetHarnessCommandStartForTesting, notifyHarnessCommandStart } from '../harness/harness-write-boundary.js';
import { HARNESS_BOUNDARY_ENV, HARNESS_BOUNDARY_REQUESTS_ENV, HARNESS_SPACE_ENV, HARNESS_SPACE_ID_ENV } from '../harness/harness-space.js';
import { fileURLToPath } from 'node:url';
import { decideAutoAssist, decideAutoStop, decideBoundaryApproval, decideScreenStallSilenceTermination, hasNovelCompletionSignal, NO_STALL, parseBoundaryApprovalRequest, UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS, type BrainSuggestionAction, type ScreenStallSilenceVerdict } from './auto-intervene.js';
import type { ControlDecision } from '../autopilot/pty-control-loop.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false;
type Assert<T extends true> = T;
type ExpectedBrainActions = 'input' | 'wait' | 'done' | 'no-progress' | 'key' | 'mouse' | 'resize' | 'handoff' | 'ask-human';
type ControlDecisionActionParity = Assert<Equal<ControlDecision['action'], ExpectedBrainActions>>;
type BrainSuggestionActionParity = Assert<Equal<BrainSuggestionAction, ControlDecision['action']>>;
void (0 as unknown as ControlDecisionActionParity);
void (0 as unknown as BrainSuggestionActionParity);

const confirmed = { enabled: true, state: 'working', stallRung: 2, minRung: 2, childAlive: true } as const;

describe('decideAutoStop', () => {
  test('wait와 input 제안은 절대 중단하지 않는다', () => {
    expect(decideAutoStop({ ...confirmed, action: 'wait' }).stop).toBe(false);
    expect(decideAutoStop({ ...confirmed, action: 'input' }).stop).toBe(false);
  });

  test('no-progress 제안은 중단하지 않고 거부 사유에 이름을 남긴다', () => {
    expect(decideAutoStop({ ...confirmed, action: 'no-progress' }))
      .toMatchObject({ stop: false, why: 'action-no-progress', wouldStop: false, evidenceWhy: 'action-no-progress' });
  });

  test('disabled gate shadows an otherwise eligible stop verdict', () => {
    expect(decideAutoStop({ ...confirmed, action: 'done', enabled: false }))
      .toEqual({ stop: false, why: 'disabled', shadowed: true, wouldStop: true, evidenceWhy: 'done-with-stall-rung-2' });
  });

  test('disabled gate still records the later stop evidence refusal', () => {
    expect(decideAutoStop({ ...confirmed, action: 'done', enabled: false, stallRung: NO_STALL }))
      .toEqual({ stop: false, why: 'disabled', shadowed: true, wouldStop: false, evidenceWhy: 'no-stall-confirmation' });
  });

  test('stallRung이 minRung보다 낮으면 중단하지 않는다', () => {
    expect(decideAutoStop({ ...confirmed, action: 'done', stallRung: 1 }).stop).toBe(false);
  });

  test('stall 확증 값이 NaN이면 fail-closed로 중단하지 않는다', () => {
    expect(decideAutoStop({ ...confirmed, action: 'done', stallRung: Number.NaN }).stop).toBe(false);
    expect(decideAutoStop({ ...confirmed, action: 'done', minRung: Number.NaN }).stop).toBe(false);
  });

  test('결정론 화면이 이미 done이면 정보 0으로 중단하지 않고 식별 가능한 사유를 남긴다', () => {
    const result = decideAutoStop({ ...confirmed, state: 'done', action: 'done' });
    expect(result).toMatchObject({ stop: false, why: 'deterministic-state-already-done', wouldStop: false, evidenceWhy: 'deterministic-state-already-done' });
  });

  test('novel한 done과 stall 확증·생존·노브가 모두 맞으면 중단하고 사유를 남긴다', () => {
    const result = decideAutoStop({ ...confirmed, action: 'done' });
    expect(result.stop).toBe(true);
    expect(result.why).not.toBe('');
  });

  test('자식이 이미 종료됐으면 중단하지 않는다', () => {
    expect(decideAutoStop({ ...confirmed, action: 'done', childAlive: false }).stop).toBe(false);
  });

  test('⭐ 음수 minRung 으로도 확증 요구를 무력화할 수 없다 (stall 부재면 중단 금지)', () => {
    for (const minRung of [-1, -5, -0.5]) {
      const v = decideAutoStop({ ...confirmed, action: 'done', stallRung: NO_STALL, minRung });
      expect(v.stop).toBe(false);
      expect(v.why).toBe('no-stall-confirmation');
    }
  });

  test('⭐ 음수 minRung 이어도 확증이 실재하면(rung 0) 정상 중단한다 (과잉 차단 아님)', () => {
    const v = decideAutoStop({ ...confirmed, action: 'done', stallRung: 0, minRung: -3 });
    expect(v.stop).toBe(true);
  });
});

describe('decideScreenStallSilenceTermination', () => {
  const eligible = {
    enabled: true, stallRung: 2, minRung: 2, silentFor: 90, activityGrace: 90,
    childAlive: true, completionDeclared: false,
  } as const;

  test('ordered refusal reasons name the first unmet precondition', () => {
    expect(decideScreenStallSilenceTermination({ ...eligible, enabled: false })).toMatchObject({ terminate: false, why: 'disabled', evidenceSatisfied: true, evidenceWhy: 'screen-stall-rung-2-and-output-silence-90' });
    expect(decideScreenStallSilenceTermination({ ...eligible, stallRung: Number.NaN })).toMatchObject({ terminate: false, why: 'stall-rung-or-min-not-finite', evidenceSatisfied: false, evidenceWhy: 'stall-rung-or-min-not-finite' });
    expect(decideScreenStallSilenceTermination({ ...eligible, stallRung: NO_STALL })).toMatchObject({ terminate: false, why: 'no-stall-confirmation', evidenceSatisfied: false, evidenceWhy: 'no-stall-confirmation' });
    expect(decideScreenStallSilenceTermination({ ...eligible, stallRung: 1 })).toMatchObject({ terminate: false, why: 'stall-rung-1-below-min-2', evidenceSatisfied: false, evidenceWhy: 'stall-rung-1-below-min-2' });
    expect(decideScreenStallSilenceTermination({ ...eligible, silentFor: 89 })).toMatchObject({ terminate: false, why: 'output-recent-silent-for-89-below-grace-90', evidenceSatisfied: false, evidenceWhy: 'output-recent-silent-for-89-below-grace-90' });
    expect(decideScreenStallSilenceTermination({ ...eligible, childAlive: false })).toMatchObject({ terminate: false, why: 'child-not-alive', evidenceSatisfied: false, evidenceWhy: 'child-not-alive' });
    expect(decideScreenStallSilenceTermination({ ...eligible, completionDeclared: true })).toMatchObject({ terminate: false, why: 'completion-already-declared', evidenceSatisfied: false, evidenceWhy: 'completion-already-declared' });
  });

  test('records satisfied evidence while the execution gate remains disabled', () => {
    expect(decideScreenStallSilenceTermination({ ...eligible, enabled: false }))
      .toMatchObject({ terminate: false, why: 'disabled', evidenceSatisfied: true, evidenceWhy: 'screen-stall-rung-2-and-output-silence-90' });
  });

  test('both axes are required in both directions', () => {
    expect(decideScreenStallSilenceTermination({ ...eligible, silentFor: 0 }).terminate).toBe(false);
    expect(decideScreenStallSilenceTermination({ ...eligible, stallRung: 1 }).terminate).toBe(false);
  });

  test('negative minimum cannot remove the existing-stall requirement', () => {
    expect(decideScreenStallSilenceTermination({ ...eligible, minRung: -3, stallRung: NO_STALL }))
      .toMatchObject({ terminate: false, why: 'no-stall-confirmation', evidenceSatisfied: false, evidenceWhy: 'no-stall-confirmation' });
    expect(decideScreenStallSilenceTermination({ ...eligible, minRung: -3, stallRung: 0 }).terminate).toBe(true);
  });

  test('terminates only when enabled and all evidence is present', () => {
    expect(decideScreenStallSilenceTermination(eligible))
      .toEqual({ terminate: true, why: 'screen-stall-rung-2-and-output-silence-90', evidenceSatisfied: true, evidenceWhy: 'screen-stall-rung-2-and-output-silence-90' });
  });

  test('records satisfied evidence independent of the disabled gate (mutation guard)', () => {
    const v = decideScreenStallSilenceTermination({ ...eligible, enabled: false });
    expect(v.terminate).toBe(false);
    expect(v.evidenceSatisfied).toBe(true);
  });

  test('verdict stays a discriminated union on terminate (compile-time)', () => {
    type TrueBranch = Extract<ScreenStallSilenceVerdict, { terminate: true }>;
    type FalseBranch = Extract<ScreenStallSilenceVerdict, { terminate: false }>;
    type TrueBranchExact = Assert<Equal<TrueBranch, { terminate: true; why: string; evidenceSatisfied: boolean; evidenceWhy: string }>>;
    type FalseBranchExact = Assert<Equal<FalseBranch, { terminate: false; why: string; evidenceSatisfied: boolean; evidenceWhy: string }>>;
    type UnionIsBothBranches = Assert<Equal<ScreenStallSilenceVerdict, TrueBranch | FalseBranch>>;
    void (0 as unknown as TrueBranchExact);
    void (0 as unknown as FalseBranchExact);
    void (0 as unknown as UnionIsBothBranches);

    const v = decideScreenStallSilenceTermination(eligible);
    expect(v.terminate).toBe(true);
  });
});

describe('decideAutoAssist', () => {
  const eligible = {
    enabled: true, action: 'input' as const, childAlive: true, ownership: 'owned' as const,
    reachability: { pty: true, supervisorQueue: false }, stallRung: 2, minRung: 2,
  };

  test('disabled gate shadows an otherwise eligible assist verdict', () => {
    expect(decideAutoAssist({ ...eligible, enabled: false }))
      .toEqual({ assist: false, why: 'disabled', shadowed: true, wouldAssist: true, evidenceWhy: 'input-with-stall-rung-2' });
  });

  test('disabled gate still records the later assist evidence refusal', () => {
    expect(decideAutoAssist({ ...eligible, enabled: false, ownership: 'lost' }))
      .toEqual({ assist: false, why: 'disabled', shadowed: true, wouldAssist: false, evidenceWhy: 'ownership-lost' });
  });

  test('각 거부 조건은 고유한 why를 남긴다', () => {
    expect(decideAutoAssist({ ...eligible, action: 'wait' })).toMatchObject({ assist: false, why: 'action-wait', wouldAssist: false, evidenceWhy: 'action-wait' });
    expect(decideAutoAssist({ ...eligible, childAlive: false })).toMatchObject({ assist: false, why: 'child-not-alive', wouldAssist: false, evidenceWhy: 'child-not-alive' });
    expect(decideAutoAssist({ ...eligible, ownership: 'lost' })).toMatchObject({ assist: false, why: 'ownership-lost', wouldAssist: false, evidenceWhy: 'ownership-lost' });
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: false } })).toMatchObject({ assist: false, why: 'child-cannot-receive-input', wouldAssist: false, evidenceWhy: 'child-cannot-receive-input:pty,supervisorQueue' });
    expect(decideAutoAssist({ ...eligible, stallRung: NO_STALL })).toMatchObject({ assist: false, why: 'no-stall-confirmation', wouldAssist: false, evidenceWhy: 'no-stall-confirmation' });
  });

  test('PTY 또는 현재 라운드의 next-round queue로 닿을 수 있으면 수락한다', () => {
    expect(decideAutoAssist(eligible)).toEqual({ assist: true, why: 'input-with-stall-rung-2', shadowed: false, wouldAssist: true, evidenceWhy: 'input-with-stall-rung-2' });
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: true } }))
      .toEqual({ assist: true, why: 'input-with-stall-rung-2', shadowed: false, wouldAssist: true, evidenceWhy: 'input-with-stall-rung-2' });
  });

  test('직접 도달성 필드는 PTY와 supervisor queue 경로를 각각 선언한다', () => {
    const direct = {
      enabled: true, action: 'input' as const, childAlive: true, ownership: 'owned' as const,
      stallRung: 2, minRung: 2,
    };
    expect(decideAutoAssist({ ...direct, canReceiveInput: true, canQueueSupervisorInput: false }))
      .toMatchObject({ assist: true, why: 'input-with-stall-rung-2' });
    expect(decideAutoAssist({ ...direct, canReceiveInput: false, canQueueSupervisorInput: true }))
      .toMatchObject({ assist: true, why: 'input-with-stall-rung-2' });
    expect(decideAutoAssist({ ...direct, canReceiveInput: false, canQueueSupervisorInput: false }))
      .toMatchObject({ assist: false, why: 'child-cannot-receive-input', evidenceWhy: 'child-cannot-receive-input:pty-stdin,supervisor-queue' });
    expect(decideAutoAssist({
      ...direct, canReceiveInput: false, canQueueSupervisorInput: false, reachability: { futureMailbox: true },
    })).toMatchObject({ assist: true, why: 'input-with-stall-rung-2' });
  });

  test('대체 queue 경로가 정체 근거 관문까지 도달하며, 닫힌 모든 경로를 사유에 남긴다', () => {
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: true }, stallRung: NO_STALL }))
      .toMatchObject({ assist: false, why: 'no-stall-confirmation', wouldAssist: false, evidenceWhy: 'no-stall-confirmation' });
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: false } }))
      .toMatchObject({ assist: false, why: 'child-cannot-receive-input', wouldAssist: false, evidenceWhy: 'child-cannot-receive-input:pty,supervisorQueue' });
  });

  test('추가 경로도 일반 도달성 판정에 포함된다', () => {
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: false, futureMailbox: true } }))
      .toMatchObject({ assist: true, why: 'input-with-stall-rung-2' });
    expect(decideAutoAssist({ ...eligible, reachability: { pty: false, supervisorQueue: false, futureMailbox: false } }))
      .toMatchObject({ assist: false, why: 'child-cannot-receive-input', evidenceWhy: 'child-cannot-receive-input:pty,supervisorQueue,futureMailbox' });
  });

  test('수락은 두 전달 경로 중 하나와 나머지 모든 조건을 동시에 요구한다', () => {
    const singleFailures = [
      { enabled: false }, { action: 'done' as const }, { childAlive: false }, { ownership: 'unknown' as const },
      { reachability: { pty: false, supervisorQueue: false } }, { stallRung: 1 },
    ];
    for (const change of singleFailures) expect(decideAutoAssist({ ...eligible, ...change }).assist).toBe(false);
  });

  test('소유권이 owned가 아니면 나머지가 충족돼도 거부한다', () => {
    expect(decideAutoAssist({ ...eligible, ownership: 'unknown' })).toMatchObject({ assist: false, why: 'ownership-unknown', wouldAssist: false, evidenceWhy: 'ownership-unknown' });
  });
});

describe('decideBoundaryApproval', () => {
  const eligible = { requestKind: 'rejected' as const, boundary: '/repo/.worktrees/feat', cwd: '/repo/.worktrees/feat', targetKnown: true, target: '/repo/.worktrees/feat/src/a.ts', commandFirstToken: 'bun' };

  test('대상이 알려진 거부는 «대상»이 경계 밖이면 cwd 가 안이어도 허락 후보가 아니다', () => {
    for (const target of ['/repo/src/a.ts', '/repo/.worktrees/feat-evil/a.ts', '/elsewhere']) {
      expect(decideBoundaryApproval({ ...eligible, target })).toMatchObject({
        requestKind: 'rejected', approve: false, wouldApprove: false, evidenceWhy: 'target-outside-boundary', commandFirstToken: 'bun',
      });
    }
    expect(decideBoundaryApproval({ ...eligible, target: undefined })).toMatchObject({ wouldApprove: false, evidenceWhy: 'target-missing' });
  });

  test('실제 거부 레코드(main-tree-reject 모양)는 파서를 거쳐 target-outside-boundary 로 판정된다', () => {
    const record = {
      requestId: 'req-mt', path: '/repo/src/a.ts', target: '/repo/src/a.ts', boundary: eligible.boundary, cwd: eligible.cwd,
      kind: 'dev', via: 'code-edit', targetKnown: true, childResponsibility: 'child', commandFirstToken: 'bun',
    };
    const parsed = parseBoundaryApprovalRequest(record);
    expect(parsed?.target).toBe('/repo/src/a.ts');
    expect(decideBoundaryApproval(parsed!)).toMatchObject({ wouldApprove: false, evidenceWhy: 'target-outside-boundary' });
  });

  test('허용목록 근거 주석은 2026-08-22 재측정 수치·합계·재현 절차를 보존한다', () => {
    const source = readFileSync(fileURLToPath(new URL('./auto-intervene.ts', import.meta.url)), 'utf8');
    const rationale = source.match(/((?:\/\/.*\n)+)const BOUNDARY_APPROVAL_COMMAND_ALLOWLIST/)?.[1];
    const normalizedRationale = rationale?.replaceAll(/\n\/\/ ?/g, ' ');
    expect(normalizedRationale).toContain('2026-08-22');
    expect(normalizedRationale).toContain('4,000 `harness.boundary`/`request-received` records');
    expect(normalizedRationale).toContain('3,998 first tokens');
    expect(normalizedRationale).toContain('99.95%');
    expect(normalizedRationale).toContain('filtering that category/event, extracting `data.commandFirstToken`, dropping missing values, then grouping and counting');
    expect(normalizedRationale).toContain('five tokens outside the named categories grouped as `other`');

    const distribution = [...(normalizedRationale ?? '').matchAll(/(?:bun|git|cd|set|rg|python3|node|rm|grep|cp|ls|env|pwd|other) (\d{1,3}(?:,\d{3})*)/g)];
    expect(distribution).toHaveLength(14);
    expect(distribution.reduce((total, [, count]) => total + Number(count.replaceAll(',', '')), 0)).toBe(3_998);
  });

  test('허용목록 리터럴은 기존 명령 순서를 보존하고 git만 끝에 더한다', () => {
    const source = readFileSync(fileURLToPath(new URL('./auto-intervene.ts', import.meta.url)), 'utf8');
    expect(source).toContain("const BOUNDARY_APPROVAL_COMMAND_ALLOWLIST = ['bun', 'node', 'rg', 'git'] as const;");
  });

  test('경계 자신과 하위 경로만 내부로 판정하고 접두사 함정은 거부한다', () => {
    expect(decideBoundaryApproval({ ...eligible, cwd: '/repo/.worktrees/feat/src/x.ts' })).toEqual({
      requestKind: 'rejected', approve: false, why: 'boundary-shell-syntax-with-bun', shadowed: true,
      wouldApprove: true, evidenceWhy: 'boundary-shell-syntax-with-bun', commandFirstToken: 'bun',
      observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
    });
    expect(decideBoundaryApproval({ ...eligible, cwd: '/repo/.worktrees/feat-evil' })).toEqual({
      requestKind: 'rejected', approve: false, why: 'outside-boundary', shadowed: true, wouldApprove: false, evidenceWhy: 'outside-boundary', commandFirstToken: 'bun',
      observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
    });
  });

  test('각 거부 갈래는 정확한 그림자 verdict를 남기고 입력 토큰이 있으면 보존한다', () => {
    const cases = [
      [{ ...eligible, cwd: '/outside' }, { evidenceWhy: 'outside-boundary', commandFirstToken: 'bun' }],
      [{ ...eligible, commandFirstToken: undefined }, { evidenceWhy: 'command-token-missing' }],
      [{ ...eligible, commandFirstToken: 'python3' }, { evidenceWhy: 'command-token-not-allowlisted', commandFirstToken: 'python3' }],
    ] as const;
    for (const [input, expected] of cases) {
      expect(decideBoundaryApproval(input)).toEqual({
        requestKind: 'rejected', approve: false, why: expected.evidenceWhy, shadowed: true, wouldApprove: false, evidenceWhy: expected.evidenceWhy,
        ...('commandFirstToken' in expected ? { commandFirstToken: expected.commandFirstToken } : {}),
        observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
      });
    }
  });

  test('경계 외부에서는 targetKnown 및 명령과 무관하게 outside-boundary를 남긴다', () => {
    for (const targetKnown of [true, false, undefined]) {
      for (const commandFirstToken of ['bun', 'git', undefined]) {
        expect(decideBoundaryApproval({ ...eligible, cwd: '/outside', targetKnown, commandFirstToken })).toEqual({
          requestKind: 'rejected', approve: false, why: 'outside-boundary', shadowed: true, wouldApprove: false, evidenceWhy: 'outside-boundary',
          ...(commandFirstToken ? { commandFirstToken } : {}),
          observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
        });
      }
    }
  });

  test('경계 생산자 notifyHarnessCommandStart가 인라인 관측을 mailbox·파서·판정까지 배선한다', () => {
    __resetHarnessCommandStartForTesting();
    const root = mkdtempSync(join(tmpdir(), 'boundary-inline-'));
    const boundary = join(root, 'boundary');
    const requests = join(root, 'requests.jsonl');
    mkdirSync(boundary);
    const env = {
      [HARNESS_SPACE_ENV]: 'self-implement',
      [HARNESS_SPACE_ID_ENV]: 'inline-observation',
      [HARNESS_BOUNDARY_ENV]: boundary,
      [HARNESS_BOUNDARY_REQUESTS_ENV]: requests,
    };
    try {
      for (const [command, inlineCode, wouldApprove] of [
        ['FOO=1 bun -e "spawnSync(\'rm\')"', true, false],
        [['bun -e "process.exit()"'], true, false],
        ['node -e"process.exit()"', true, false],
        ["node -''e 'process.exit()'", true, false],
        ['node "--eval=process.exit()"', true, false],
        ['node \\-e "process.exit()"', true, false],
        ['bun test src/self-implement/auto-intervene.test.ts', false, true],
        ['bun run scripts/x.ts', false, true],
        ['node --require ./preload.cjs --eval "process.exit()"', true, false],
        ['node --require=./preload.cjs --eval "process.exit()"', true, false],
        ['node --conditions development --eval "process.exit()"', true, false],
        ['node script.js -e value', false, true],
        [['node', 'script.js', '-e', 'value'], false, true],
      ] as const) {
        expect(notifyHarnessCommandStart(command, boundary, 'test', env)).toBe(true);
        const record = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>;
        expect(record.inlineCode).toBe(inlineCode);
        const parsed = parseBoundaryApprovalRequest(record);
        expect(parsed?.inlineCode).toBe(inlineCode);
        // 통지 자체에는 허락 후보를 달지 않는다(2026-09-24) — 판정 규칙은 같은 레코드를 «거부»로 넣어 잰다.
        expect(decideBoundaryApproval(parsed!)).toMatchObject({ wouldApprove: false, evidenceWhy: 'not-a-rejection' });
        expect(decideBoundaryApproval({ ...parsed!, requestKind: 'rejected' }).wouldApprove).toBe(wouldApprove);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('경계 내부의 허용 목록 명령은 targetKnown이 참일 때만 승인 가능으로 판정한다', () => {
    expect(decideBoundaryApproval(eligible)).toEqual({
      requestKind: 'rejected', approve: false, why: 'boundary-shell-syntax-with-bun', shadowed: true,
      wouldApprove: true, evidenceWhy: 'boundary-shell-syntax-with-bun', commandFirstToken: 'bun',
      observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
    });
  });

  test('대상을 해석하지 못했거나 targetKnown이 없으면 허용 목록 명령도 승인 후보로 세지 않는다', () => {
    const existingEvidenceWhy = new Set([
      'outside-boundary',
      'command-token-missing',
      'command-token-not-allowlisted',
      'boundary-shell-syntax-with-bun',
    ]);
    for (const targetKnown of [false, undefined]) {
      const verdict = decideBoundaryApproval({ ...eligible, targetKnown });
      expect(verdict).toMatchObject({
        requestKind: 'rejected', approve: false, shadowed: true, wouldApprove: false, evidenceWhy: 'target-unknown', commandFirstToken: 'bun',
      });
      expect(existingEvidenceWhy.has(verdict.evidenceWhy)).toBe(false);
    }
  });

  test('비허용 명령은 targetKnown보다 먼저 토큰 사유로 거절한다', () => {
    for (const targetKnown of [true, false, undefined]) {
      expect(decideBoundaryApproval({ ...eligible, targetKnown, commandFirstToken: 'python3' })).toEqual({
        requestKind: 'rejected', approve: false, why: 'command-token-not-allowlisted', shadowed: true,
        wouldApprove: false, evidenceWhy: 'command-token-not-allowlisted', commandFirstToken: 'python3',
        observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
      });
    }
  });

  test('허용목록 안팎의 토큰을 모두 verdict.commandFirstToken에 그대로 싣는다', () => {
    expect(decideBoundaryApproval({ ...eligible, commandFirstToken: 'bun' })).toMatchObject({
      requestKind: 'rejected', approve: false, wouldApprove: true, evidenceWhy: 'boundary-shell-syntax-with-bun', commandFirstToken: 'bun',
    });
    expect(decideBoundaryApproval({ ...eligible, commandFirstToken: 'python3' })).toMatchObject({
      requestKind: 'rejected', approve: false, wouldApprove: false, evidenceWhy: 'command-token-not-allowlisted', commandFirstToken: 'python3',
    });
  });

  test('headless boundary watcher는 기존 verdict spread 로그 경로로 판정을 관측에 싣는다', () => {
    const source = readFileSync(fileURLToPath(new URL('./headless-elanous-driver.ts', import.meta.url)), 'utf8');
    expect(source).toContain('verdict = decideBoundaryApproval(request);');
    expect(source).toContain("debug.log('harness.boundary', 'approval-shadow', { ...context, requestId: request.requestId, ...verdict });");
  });

  test('경계 내부 git은 하위 명령으로 거르지 않고 승인 가능으로 판정한다', () => {
    for (const commandAction of ['git status', 'git commit', 'git unknown', undefined]) {
      expect(decideBoundaryApproval({ ...eligible, commandFirstToken: 'git', commandAction })).toEqual({
        requestKind: 'rejected', approve: false, why: 'boundary-shell-syntax-with-git', shadowed: true,
        wouldApprove: true, evidenceWhy: 'boundary-shell-syntax-with-git', commandFirstToken: 'git',
        ...(commandAction ? { commandAction } : {}),
        observedRawShellMetacharacters: UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS,
      });
    }
  });

  test('mailbox 요청 파서는 plain object와 필수 필드 타입만 수락하고 non-empty commandAction만 보존한다', () => {
    const valid = { requestId: 'req-1', ...eligible, inlineCode: false, commandAction: 'git status' };
    expect(parseBoundaryApprovalRequest(valid)).toEqual(valid);
    expect(parseBoundaryApprovalRequest({ ...valid, commandAction: '' })).toEqual({ requestId: 'req-1', ...eligible, inlineCode: false });
    expect(parseBoundaryApprovalRequest({ ...valid, inlineCode: true })).toEqual({ ...valid, inlineCode: true });
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '|' })).toEqual({ ...valid, observedRawShellMetacharacters: '|' });
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '' })).toEqual({ ...valid, observedRawShellMetacharacters: '' });
    expect(parseBoundaryApprovalRequest(valid)).not.toHaveProperty('observedRawShellMetacharacters');
    for (const invalid of [null, [], 'request', new Date(), { requestId: 'req-1', boundary: eligible.boundary, cwd: eligible.cwd }, { ...valid, inlineCode: 'true' }, { ...valid, commandAction: 1 }, { ...valid, observedRawShellMetacharacters: 1 }]) {
      expect(parseBoundaryApprovalRequest(invalid)).toBeUndefined();
    }
  });

  test('mailbox 요청 종류를 닫힌 집합으로 정규화하고 decision record까지 보존한다', () => {
    const base = { requestId: 'req-kind', boundary: eligible.boundary, cwd: eligible.cwd, targetKnown: true, commandFirstToken: 'bun' };
    for (const [requestType, requestKind] of [
      [undefined, 'rejected'],
      ['command-start', 'command-start'],
      ['command-start-cap-reached', 'command-start-cap-reached'],
    ] as const) {
      const parsed = parseBoundaryApprovalRequest({ ...base, ...(requestType ? { requestType } : {}) });
      expect(parsed?.requestKind).toBe(requestKind);
      expect(decideBoundaryApproval(parsed!)).toMatchObject({ requestKind });
    }
    expect(parseBoundaryApprovalRequest({ ...base, requestType: 'unexpected' })).toBeUndefined();
  });

  test('mailbox 파서는 canonical 관측 문자와 빈 문자열만 보존하고 원 명령·개행 주입은 버린다', () => {
    const valid = { requestId: 'req-1', ...eligible };
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '|' })).toEqual({ ...valid, observedRawShellMetacharacters: '|' });
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '|&' })).toEqual({ ...valid, observedRawShellMetacharacters: '|&' });
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '' })).toEqual({ ...valid, observedRawShellMetacharacters: '' });
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '\n' })).toEqual({ ...valid, observedRawShellMetacharacters: '\n' });
    const rawCommand = "bun test -- 'src/harness/harness-write-boundary.test.ts' 'src/self-implement/auto-intervene.test.ts'";
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: rawCommand })).toEqual(valid);
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: 'bun test | cat' })).toEqual(valid);
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: 'secret\ninjected-line' })).toEqual(valid);
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: 'not-canonical' })).toEqual(valid);
    expect(parseBoundaryApprovalRequest({ ...valid, observedRawShellMetacharacters: '||' })).toEqual(valid);
  });

  test('다섯 갈래 모두 항상 그림자로만 남는다', () => {
    const verdicts = [
      decideBoundaryApproval({ ...eligible, cwd: '/outside' }),
      decideBoundaryApproval({ ...eligible, targetKnown: true }),
      decideBoundaryApproval({ ...eligible, commandFirstToken: undefined }),
      decideBoundaryApproval({ ...eligible, commandFirstToken: 'git' }),
      decideBoundaryApproval(eligible),
    ];
    for (const verdict of verdicts) {
      expect(verdict.approve).toBe(false);
      expect(verdict.shadowed).toBe(true);
    }
  });

  test('메타문자가 없는 명령이면 observedRawShellMetacharacters가 빈 문자열이다', () => {
    const verdict = decideBoundaryApproval({ ...eligible, command: 'bun test src/self-implement/auto-intervene.test.ts' });
    expect(verdict.observedRawShellMetacharacters).toBe('');
    expect(verdict).toHaveProperty('observedRawShellMetacharacters');
    expect(verdict.approve).toBe(false);
    expect(verdict.shadowed).toBe(true);
  });

  test('메타문자가 있으면 나타난 문자만 등장 순으로 담고 명령 원문은 싣지 않는다', () => {
    const command = 'bun test src/x.ts | tee out.txt && echo done';
    const verdict = decideBoundaryApproval({ ...eligible, command });
    expect(verdict.observedRawShellMetacharacters).toBe('|&');
    expect(verdict.observedRawShellMetacharacters).not.toContain('bun');
    expect(verdict).not.toHaveProperty('command');
    expect(JSON.stringify(verdict)).not.toContain(command);
    expect(verdict.approve).toBe(false);
    expect(verdict.shadowed).toBe(true);
  });

  test('명령 문자열을 못 구한 경로에서는 unknown이지 없음이나 빈 값이 아니다', () => {
    const missing = decideBoundaryApproval(eligible);
    expect(missing.observedRawShellMetacharacters).toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(missing.observedRawShellMetacharacters).not.toBe('');
    expect(missing).toHaveProperty('observedRawShellMetacharacters');
    expect(missing.approve).toBe(false);
    expect(missing.shadowed).toBe(true);

    const emptyCommand = decideBoundaryApproval({ ...eligible, command: '' });
    expect(emptyCommand.observedRawShellMetacharacters).toBe('');
    expect(emptyCommand.observedRawShellMetacharacters).not.toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
  });

  test('개행 메타문자는 관측 칸에 실제 개행으로 남고 공백과 같지 않다', () => {
    const verdict = decideBoundaryApproval({ ...eligible, command: 'bun test\nrg foo' });
    expect(verdict.observedRawShellMetacharacters).toBe('\n');
    expect(verdict.observedRawShellMetacharacters).not.toBe(' ');
    expect(verdict.approve).toBe(false);
    expect(verdict.shadowed).toBe(true);
  });

  test('전달된 관측값은 명령 없이 그대로 쓰고 빈 문자열과 unknown을 가른다', () => {
    expect(decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: '|' })).toMatchObject({
      observedRawShellMetacharacters: '|',
    });
    expect(decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: '\n' })).toMatchObject({
      observedRawShellMetacharacters: '\n',
    });
    const empty = decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: '' });
    expect(empty.observedRawShellMetacharacters).toBe('');
    expect(empty.observedRawShellMetacharacters).not.toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(decideBoundaryApproval(eligible).observedRawShellMetacharacters).toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(JSON.stringify(decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: '|' }))).not.toContain('bun test');
  });

  test('전달된 관측값이 있으면 command를 다시 계산하지 않는다', () => {
    const command = 'bun test src/x.ts | tee out.txt && echo done';
    const verdict = decideBoundaryApproval({ ...eligible, command, observedRawShellMetacharacters: '' });
    expect(verdict.observedRawShellMetacharacters).toBe('');
    expect(verdict.observedRawShellMetacharacters).not.toBe('|&');
    expect(verdict).not.toHaveProperty('command');
    expect(JSON.stringify(verdict)).not.toContain(command);
  });

  test('비정규 관측 문자열은 verdict에 싣지 않고 unknown으로 정규화하며 원문을 남기지 않는다', () => {
    const rawCommand = "bun test -- 'src/a.ts' 'src/b.ts'";
    const injected = decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: rawCommand });
    expect(injected.observedRawShellMetacharacters).toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(JSON.stringify(injected)).not.toContain(rawCommand);
    expect(JSON.stringify(injected)).not.toContain('src/a.ts');

    const newlineInjected = decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: 'secret\ninjected-line' });
    expect(newlineInjected.observedRawShellMetacharacters).toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(JSON.stringify(newlineInjected)).not.toContain('secret');
    expect(JSON.stringify(newlineInjected)).not.toContain('injected-line');

    const arbitrary = decideBoundaryApproval({ ...eligible, observedRawShellMetacharacters: 'not-canonical' });
    expect(arbitrary.observedRawShellMetacharacters).toBe(UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS);
    expect(JSON.stringify(arbitrary)).not.toContain('not-canonical');
  });
});

describe('hasNovelCompletionSignal', () => {
  test('state x action 조합 전체의 완료 정보 추가량을 고정한다', () => {
    const cases = [
      { state: 'done', action: 'done', novel: false },
      { state: 'done', action: 'wait', novel: false },
      { state: 'done', action: 'input', novel: false },
      { state: 'done', action: 'no-progress', novel: false },
      { state: 'working', action: 'done', novel: true },
      { state: 'working', action: 'wait', novel: false },
      { state: 'working', action: 'input', novel: false },
      { state: 'working', action: 'no-progress', novel: false },
      { state: 'unknown', action: 'done', novel: true },
      { state: 'unknown', action: 'wait', novel: false },
      { state: 'unknown', action: 'input', novel: false },
      { state: 'unknown', action: 'no-progress', novel: false },
    ] as const satisfies readonly { state: 'done' | 'working' | 'unknown'; action: 'done' | 'wait' | 'input' | 'no-progress'; novel: boolean }[];
    for (const { state, action, novel } of cases) {
      expect(hasNovelCompletionSignal({ state, action })).toBe(novel);
    }
  });
});
