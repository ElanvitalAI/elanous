// harness-space — 자기인지 공간 마커(Docker식) 장치 테스트

import { describe, test, expect } from 'bun:test';
import {
  getHarnessSpace, isInHarnessSpace, harnessSpaceEnv, normalizeSpaceId, harnessSpaceSurface, describeHarnessSpace,
  getHarnessRole, executorRoleEnv,
  mintRunId, normalizeRunId, getHarnessRunId, getHarnessRunIdSource, ensureRunId, ensureRunIdentity, pickRunId, perCallRunId, resolveRunIdentity,
  HARNESS_SPACE_ENV, HARNESS_SPACE_ID_ENV, HARNESS_ROLE_ENV, HARNESS_RUN_ID_ENV,
  HARNESS_BOUNDARY_REQUESTS_ENV, HARNESS_BOUNDARY_RESPONSES_ENV,
  harnessBoundaryRequestsEnv, harnessBoundaryResponsesEnv, appendBoundaryResponseLine,
} from './harness-space.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';


describe('harness boundary response mailbox', () => {
  test('same execution id derives distinct request and response paths under one parent without creating either file', () => {
    const executionId = `response-mailbox-${Date.now()}`;
    const request = harnessBoundaryRequestsEnv(executionId)[HARNESS_BOUNDARY_REQUESTS_ENV]!;
    const response = harnessBoundaryResponsesEnv(executionId)[HARNESS_BOUNDARY_RESPONSES_ENV]!;
    expect(response).not.toBe(request);
    expect(dirname(response)).toBe(dirname(request));
    expect(harnessBoundaryResponsesEnv(executionId)).toEqual({ [HARNESS_BOUNDARY_RESPONSES_ENV]: response });
    expect(existsSync(request)).toBe(false);
    expect(existsSync(response)).toBe(false);
  });

  test('blank execution id fails open without response mailbox env', () => {
    expect(harnessBoundaryResponsesEnv('')).toEqual({});
    expect(harnessBoundaryResponsesEnv('   ')).toEqual({});
  });

  test('TENANT-BOUNDARY: appendBoundaryResponseLine 은 익명 payload 를 회신 mailbox 경로에 JSONL 로만 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-boundary-line-'));
    const responses = join(dir, 'responses.jsonl');
    const parent = join(dir, 'nested');
    const env = { [HARNESS_BOUNDARY_RESPONSES_ENV]: join(parent, 'responses.jsonl') };
    appendBoundaryResponseLine(env, { devProject: 'prj-x', project: { name: 'project-abc' } });
    appendBoundaryResponseLine(env, { devProject: 'prj-y' });
    const lines = readFileSync(join(parent, 'responses.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines).toEqual([
      { devProject: 'prj-x', project: { name: 'project-abc' } },
      { devProject: 'prj-y' },
    ]);
    expect(existsSync(responses)).toBe(false);
    expect(appendBoundaryResponseLine({}, { anything: 1 })).toBe('');
    expect(appendBoundaryResponseLine({ [HARNESS_BOUNDARY_RESPONSES_ENV]: '' }, { anything: 1 })).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(['../outside', '/absolute/path', '\\windows\\path', 'nested/../id'])(
    'path-like execution id %j remains inside the response mailbox parent', (executionId) => {
      const response = harnessBoundaryResponsesEnv(executionId)[HARNESS_BOUNDARY_RESPONSES_ENV]!;
      // ⛔⭐ `dirname(response)` 를 기준으로 삼으면 그 검사는 «항상 참»이라 아무것도 증명하지 않는다
      //    (리뷰 should-fix ①). ⇒ 계약이 정한 «고정된» mailbox 부모를 기준으로 잰다.
      const mailboxParent = resolve(tmpdir(), 'elanous-harness-boundary-requests');
      expect(relative(mailboxParent, resolve(response))).not.toStartWith('..');
      expect(dirname(resolve(response))).toBe(mailboxParent);
      expect(existsSync(response)).toBe(false);
      rmSync(response, { force: true });
    },
  );
});

describe('getHarnessSpace', () => {
  test('마커 없으면 null(운영/일반 프로세스)', () => {
    expect(getHarnessSpace({})).toBeNull();
    expect(getHarnessSpace({ FOO: 'bar' })).toBeNull();
    expect(isInHarnessSpace({})).toBe(false);
  });

  test('SPACE 있으면 자기인지(kind+id)', () => {
    const env = { [HARNESS_SPACE_ENV]: 'self-implement', [HARNESS_SPACE_ID_ENV]: 'f1-grounding-a1b2c3' };
    expect(getHarnessSpace(env)).toEqual({ inHarness: true, kind: 'self-implement', id: 'f1-grounding-a1b2c3', runId: '' });
    expect(isInHarnessSpace(env)).toBe(true);
  });

  test('id 없으면 빈 문자열(공간은 인지)', () => {
    expect(getHarnessSpace({ [HARNESS_SPACE_ENV]: 'dev-harness' })).toEqual({ inHarness: true, kind: 'dev-harness', id: '', runId: '' });
  });

  test('알 수 없는 kind → dev-harness 폴백(존재=inHarness 유지)', () => {
    expect(getHarnessSpace({ [HARNESS_SPACE_ENV]: 'weird-kind' })).toEqual({ inHarness: true, kind: 'dev-harness', id: '', runId: '' });
  });

  test('공백만이면 null(fail-safe)', () => {
    expect(getHarnessSpace({ [HARNESS_SPACE_ENV]: '   ' })).toBeNull();
  });

  test('solve-mission kind', () => {
    expect(getHarnessSpace({ [HARNESS_SPACE_ENV]: 'solve-mission', [HARNESS_SPACE_ID_ENV]: 'apm_123' })?.kind).toBe('solve-mission');
  });

  test('dev-hold kind와 id를 수동 레인 공간으로 복원한다', () => {
    expect(getHarnessSpace({ [HARNESS_SPACE_ENV]: 'dev-hold', [HARNESS_SPACE_ID_ENV]: 'dev-run-x' }))
      .toEqual({ inHarness: true, kind: 'dev-hold', id: 'dev-run-x', runId: '' });
  });
});

describe('harnessSpaceEnv — 자식 스폰용 마커 생성', () => {
  test('kind+정규화 id 를 ENV 로', () => {
    const env = harnessSpaceEnv('self-implement', 'F1 그라운딩 배선!!');
    expect(env[HARNESS_SPACE_ENV]).toBe('self-implement');
    // 라틴/한글 혼합·특수문자 → 안전 문자로 정규화(한글은 제거됨)
    expect(env[HARNESS_SPACE_ID_ENV]).not.toContain('!');
    expect(env[HARNESS_SPACE_ID_ENV]).not.toContain(' ');
  });

  test('왕복 — harnessSpaceEnv 로 만든 env 를 getHarnessSpace 가 인지', () => {
    const env = harnessSpaceEnv('dev-harness', 'my-objective');
    expect(getHarnessSpace(env)).toEqual({ inHarness: true, kind: 'dev-harness', id: 'my-objective', runId: '' });
  });

  test('runId 넘기면 ELANOUS_RUN_ID stamp·왕복 인지', () => {
    const env = harnessSpaceEnv('self-implement', 'sp1', 'run-abc123');
    expect(env[HARNESS_RUN_ID_ENV]).toBe('run-abc123');
    expect(getHarnessSpace(env)?.runId).toBe('run-abc123');
  });

  test('runId 생략하면 ELANOUS_RUN_ID 키 없음(coordinator 가 process.env 로 전파)', () => {
    const env = harnessSpaceEnv('self-implement', 'sp1');
    expect(env[HARNESS_RUN_ID_ENV]).toBeUndefined();
  });
});

describe('normalizeSpaceId', () => {
  test('안전 문자만 남기고 앞뒤 정리·64자 상한', () => {
    expect(normalizeSpaceId('  hello world!!  ')).toBe('hello-world');
    expect(normalizeSpaceId('branch/name:1.2-3_4')).toBe('branch/name:1.2-3_4');
    expect(normalizeSpaceId('x'.repeat(100)).length).toBe(64);
    expect(normalizeSpaceId('')).toBe('');
  });

  test('64자 slice 뒤 생긴 끝 하이픈도 제거해 control inbox space id와 일치한다', () => {
    const basename = 'self-impl-goalid-d960c670e39b709b-scripts-shell-rc-through-pipe-test-ts-go-c496a575';
    const spaceId = 'self-impl-goalid-d960c670e39b709b-scripts-shell-rc-through-pipe';

    expect(normalizeSpaceId(basename)).toBe(spaceId);
    expect(normalizeSpaceId(basename)).not.toEndWith('-');
    expect(normalizeSpaceId('-abc-')).toBe('abc');
    expect(normalizeSpaceId('a'.repeat(64))).toBe('a'.repeat(64));
  });
});

describe('harnessSpaceSurface', () => {
  test('harness:<kind> 라벨', () => {
    expect(harnessSpaceSurface({ inHarness: true, kind: 'self-implement', id: 'x', runId: '' })).toBe('harness:self-implement');
  });
});

describe('describeHarnessSpace', () => {
  test('공간이 있으면 kind:id 를 반환한다', () => {
    expect(describeHarnessSpace({ inHarness: true, kind: 'self-implement', id: 'task-e4b3598038ee', runId: '' }))
      .toBe('self-implement:task-e4b3598038ee');
  });

  test('null 이면 no-harness 를 반환한다', () => {
    expect(describeHarnessSpace(null)).toBe('no-harness');
  });
});

describe('getHarnessRole — 세포 역할 분화(2026-07-21 대표: env 로 조율자/실행자)', () => {
  test('마커도 공간도 없으면 null(standalone)', () => {
    expect(getHarnessRole({})).toBeNull();
    expect(getHarnessRole({ FOO: 'bar' })).toBeNull();
  });

  test('명시 role env 우선', () => {
    expect(getHarnessRole({ [HARNESS_ROLE_ENV]: 'coordinator' })).toBe('coordinator');
    expect(getHarnessRole({ [HARNESS_ROLE_ENV]: 'executor' })).toBe('executor');
  });

  test('명시 role 없고 dev-hold 공간이면 standalone이다', () => {
    expect(getHarnessRole({ [HARNESS_SPACE_ENV]: 'dev-hold', [HARNESS_SPACE_ID_ENV]: 'dev-run-x' })).toBeNull();
  });

  test('명시 executor role은 dev-hold standalone 폴백보다 우선한다', () => {
    expect(getHarnessRole({
      [HARNESS_SPACE_ENV]: 'dev-hold',
      [HARNESS_SPACE_ID_ENV]: 'x',
      [HARNESS_ROLE_ENV]: 'executor',
    })).toBe('executor');
  });

  test('명시 role 없고 기존 self-implement 공간이면 executor 폴백(자식 goal-loop 기본)', () => {
    expect(getHarnessRole({ [HARNESS_SPACE_ENV]: 'self-implement', [HARNESS_SPACE_ID_ENV]: 'x' })).toBe('executor');
  });

  test('알 수 없는 role 값은 무시하고 폴백', () => {
    expect(getHarnessRole({ [HARNESS_ROLE_ENV]: 'nonsense' })).toBeNull();
    expect(getHarnessRole({ [HARNESS_ROLE_ENV]: 'nonsense', [HARNESS_SPACE_ENV]: 'dev-harness' })).toBe('executor');
  });

  test('executorRoleEnv — 자식에 실을 role 마커', () => {
    expect(executorRoleEnv()).toEqual({ [HARNESS_ROLE_ENV]: 'executor' });
    // 왕복: 주입한 env 를 getHarnessRole 이 executor 로 인지
    expect(getHarnessRole({ ...executorRoleEnv() })).toBe('executor');
  });
});

describe('run-identity — per-run join anchor(K·2026-07-25)', () => {
  test('mintRunId — run- 접두·uuid 기반·매번 유니크(슬러그충돌 없음)', () => {
    const a = mintRunId();
    const b = mintRunId();
    expect(a).toMatch(/^run-/);
    expect(a).not.toBe(b);          // uuid → 충돌 없음
    expect(a).toBe(normalizeRunId(a)); // 이미 정규화됨(안전문자만)
  });

  test('normalizeRunId — 엄격(경로 traversal 방지·`/`·`:`·`.` 불허·64자)', () => {
    expect(normalizeRunId('  run x!! ')).toBe('run-x');
    // ⭐ should-fix: run-store `<runId>.json` 파일명 안전 — `/`·`:`·`..` 를 제거해 traversal 차단
    expect(normalizeRunId('../../etc/passwd')).toBe('etc-passwd');
    expect(normalizeRunId('a/b:c..d')).toBe('a-b-c-d');
    expect(normalizeRunId('r'.repeat(100)).length).toBe(64);
    expect(normalizeRunId('')).toBe('');
    // mintRunId 산출은 정규화 무영향(멱등)
    expect(normalizeRunId(mintRunId())).toMatch(/^run-[a-z0-9-]+$/);
  });

  test('getHarnessRunId — env 상속 읽기(없으면 빈문자)', () => {
    expect(getHarnessRunId({})).toBe('');
    expect(getHarnessRunId({ [HARNESS_RUN_ID_ENV]: 'run-xyz' })).toBe('run-xyz');
  });

  test('ensureRunIdentity — 최외곽에서 env에 심고 minted·inherited 출처를 함께 반환한다', () => {
    const fresh: NodeJS.ProcessEnv = { ELANOUS_HOST_ID: '01HOSTTEST' };
    const minted = ensureRunIdentity(fresh);
    expect(minted.source).toBe('minted');
    expect(minted.runId).toMatch(/^run-/);
    expect(fresh[HARNESS_RUN_ID_ENV]).toBe(minted.runId);
    expect(fresh.ELANOUS_HOST_ID).toBe('01HOSTTEST');
    // 기존 반환 계약: env에 값이 생긴 뒤 재호출하면 inherited다. PTY reader만 최초 minted 기록을 본다.
    expect(ensureRunIdentity(fresh)).toEqual({ runId: minted.runId, source: 'inherited' });
    expect(getHarnessRunIdSource(fresh)).toBe('minted');

    const inherited: NodeJS.ProcessEnv = { [HARNESS_RUN_ID_ENV]: 'run-parent' };
    expect(ensureRunIdentity(inherited)).toEqual({ runId: 'run-parent', source: 'inherited' });
  });

  test('ensureRunIdentity — 서로 다른 env의 같은 run id는 각자의 최초 출처를 보존한다', () => {
    const mintedEnv: NodeJS.ProcessEnv = {};
    const minted = ensureRunIdentity(mintedEnv);
    const inheritedEnv: NodeJS.ProcessEnv = { [HARNESS_RUN_ID_ENV]: minted.runId };
    expect(ensureRunIdentity(mintedEnv)).toEqual({ runId: minted.runId, source: 'inherited' });
    expect(getHarnessRunIdSource(mintedEnv)).toBe('minted');
    expect(ensureRunIdentity(inheritedEnv)).toEqual({ runId: minted.runId, source: 'inherited' });
    expect(getHarnessRunIdSource(inheritedEnv)).toBe('inherited');
  });

  test('ensureRunId — 기존 문자열 호출자 호환 껍데기', () => {
    const fresh: NodeJS.ProcessEnv = {};
    const minted = ensureRunId(fresh);
    expect(minted).toMatch(/^run-/);
    expect(fresh[HARNESS_RUN_ID_ENV]).toBe(minted);
    expect(ensureRunId(fresh)).toBe(minted);
    expect(ensureRunId({ [HARNESS_RUN_ID_ENV]: 'run-parent' })).toBe('run-parent');
  });

  test('ensureRunId — 상속값이 비정규면 정규화해 되쓴다(MF3·전파==관측 일치)', () => {
    const env: NodeJS.ProcessEnv = { [HARNESS_RUN_ID_ENV]: 'Run X!!' }; // 외부에서 심긴 원문(비정규)
    const resolved = ensureRunId(env);
    expect(resolved).toBe('Run-X');                 // 정규화값 반환
    expect(env[HARNESS_RUN_ID_ENV]).toBe('Run-X');  // env 도 정규화값으로 되씀 → 자식 상속값 == 관측/스탬프값
  });

  test('pickRunId(orchestrate) — 우선순위 resume > 상속 env > 신규 mint(MF2·실코드)', () => {
    // resume 최우선
    expect(pickRunId('run-resumed', 'run-env')).toBe('run-resumed');
    // resume 없으면 상속 env 채택(로컬↔env 분리 방지·MF2)
    expect(pickRunId(undefined, 'run-parent')).toBe('run-parent');
    // 둘 다 없으면 canonical mintRunId(신규·MF2 계약)
    const fresh = pickRunId(undefined, '');
    expect(fresh).toMatch(/^run-[a-z0-9-]+$/);
    // 항상 엄격 정규화(MF3·traversal 방지)
    expect(pickRunId('../evil', '')).toBe('evil');
  });

  test('perCallRunId(detached) — 상속 없으면 매 호출 fresh·env 미변경(MF1/MF4·identity bleed 방지)', () => {
    const env: NodeJS.ProcessEnv = {};
    const a = perCallRunId(env);
    const b = perCallRunId(env);
    expect(a).not.toBe(b);                            // 연속 dispatch → 서로 다른 runId(bleed 없음)
    expect(env[HARNESS_RUN_ID_ENV]).toBeUndefined();  // ⭐ process.env 미변경(부작용 없음)
    // 상속 있으면 채택(nested)
    expect(perCallRunId({ [HARNESS_RUN_ID_ENV]: 'run-parent' })).toBe('run-parent');
  });

  test('전파 왕복 — coordinator ensureRunId → 자식 env spread → getHarnessSpace.runId', () => {
    // coordinator: ensureRunId 로 심음
    const coord: NodeJS.ProcessEnv = {};
    const runId = ensureRunId(coord);
    // 자식 스폰 env = { ...process.env(coord), ...harnessSpaceEnv(...) } (runId 는 process.env 로 상속)
    const childEnv = { ...coord, ...harnessSpaceEnv('self-implement', 'job-1') };
    expect(getHarnessSpace(childEnv)?.runId).toBe(runId);
    // 자식 spaceId 는 per-child, runId 는 공유
    expect(getHarnessSpace(childEnv)?.id).toBe('job-1');
  });
});

// ── resolveRunIdentity 단일 resolver (2026-07-26 · 리뷰 should-fix 로 4곳 중복 통합) ──────
//   계약: 명시 > 상속 > canonical mint · 전 입력 normalizeRunId 통과 · 반환은 항상 non-empty·안전문자.
describe('resolveRunIdentity — runId 해석 SSOT', () => {
  const RUN_ID_ENV = 'ELANOUS_RUN_ID';
  const env = (v?: string): NodeJS.ProcessEnv => (v === undefined ? {} : { [RUN_ID_ENV]: v });

  test('명시값 최우선 — 환경값과 같아도 source=explicit', () => {
    expect(resolveRunIdentity({ explicit: 'run-a', env: env('run-a') }))
      .toEqual({ runId: 'run-a', source: 'explicit' });
  });

  test('명시 없으면 상속(inherited 인자) 채택', () => {
    expect(resolveRunIdentity({ inherited: 'run-space', env: env('run-env') }))
      .toEqual({ runId: 'run-space', source: 'inherited' });
  });

  test('명시·inherited 없으면 env 상속', () => {
    expect(resolveRunIdentity({ env: env('run-env') }))
      .toEqual({ runId: 'run-env', source: 'inherited' });
  });

  test('아무것도 없으면 canonical mint(항상 non-empty)', () => {
    const r = resolveRunIdentity({ env: env() });
    expect(r.source).toBe('minted');
    expect(r.runId).toMatch(/^run-[A-Za-z0-9-]+$/);
  });

  // ⭐ 무인 리뷰가 "상속 경로는 공백/불안전값을 통과시킨다"고 2회 지적했다. 실제로는 상류
  //   getHarnessRunId 가 normalizeRunId 를 통과시켜 그럴 수 없다 — 그 사실을 테스트로 못박아
  //   같은 오지적이 반복되지 않게 한다(그리고 resolver 자체도 방어적으로 재정규화한다).
  test.each([['공백만', '   '], ['불안전 문자만', '///'], ['빈 문자열', '']])(
    '★ 상속 env 가 %s 이면 채택하지 않고 mint 로 폴백', (_l, bad) => {
      const r = resolveRunIdentity({ env: env(bad) });
      expect(r.source).toBe('minted');
      expect(r.runId).toMatch(/^run-[A-Za-z0-9-]+$/);
    });

  test.each([['공백만', '   '], ['불안전 문자만', '///']])(
    '★ inherited 인자가 %s 이면 무시하고 다음 순위로', (_l, bad) => {
      expect(resolveRunIdentity({ inherited: bad, env: env('run-env') }))
        .toEqual({ runId: 'run-env', source: 'inherited' });
    });

  test.each([['공백만', '   '], ['불안전 문자만', '///'], ['빈 문자열', '']])(
    '★ 명시값이 %s 이면 채택하지 않는다(종전 `??` 버그)', (_l, bad) => {
      expect(resolveRunIdentity({ explicit: bad, env: env('run-env') }))
        .toEqual({ runId: 'run-env', source: 'inherited' });
    });

  test('불안전 문자를 포함한 값은 정규화해 쓴다(run-store 파일명·manifest 키 안전)', () => {
    const r = resolveRunIdentity({ explicit: '  run/../evil id  ' });
    expect(r.source).toBe('explicit');
    expect(r.runId).toBe('run-evil-id');
    expect(r.runId).not.toContain('/');
  });
});
