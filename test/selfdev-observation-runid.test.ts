// ── self-dev 관측 실행-태깅 (2026-07-26) ──────────────────────────────────────
//
// ⭐ 왜 필요했나 (실측 사건): 같은 시간대에 `elanous dev` 3개를 띄웠더니 로그가 한 카테고리에 섞여
//   ① 한 실행의 실패 원인을 **특정하지 못했고**
//   ② **다른 실행의 게이트 로그를 자기 것으로 오독**해 "게이트가 거짓 통과했다"는 잘못된 결론에 도달했다.
//   관측이 있어도 조회가 실행을 못 가르면 자기인지가 안 된다(제1원칙).
//
// 계약: `self-implement` 카테고리 발화는 **전부 runId 를 싣는다**. 25곳을 손으로 고치는 대신 단일
// `observe` 헬퍼로 감싸 새 발화가 조용히 빠지는 것을 구조적으로 막고, 아래 ratchet 이 그 규율을 고정한다.

import { test, expect, describe, spyOn, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log';
import { runSelfImplement, makeRunObserver } from '../src/self-implement/orchestrator';
import { appendRunLedgerEntry } from '../src/self-implement/run-ledger';

const ORCH = 'src/self-implement/orchestrator.ts';
const INDEX = 'src/index.ts';

/** 주석을 걷어낸 소스 — 주석 속 예시가 배선으로 오인되지 않게. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** raw 발화 스캐너 — 소스에서 `debug.log('self-implement', …)` 직접 호출을 뽑는다.
 *  따옴표 3종(작은·큰·백틱 템플릿)을 모두 받는다: 하나라도 빠지면 그 형태로 우회된다. */
function scanRawEmits(src: string): string[] {
  return [...stripComments(src).matchAll(/debug\.log\(\s*['"`]self-implement['"`]\s*,\s*([^,)]+)/g)]
    .map((m) => m[1]!.trim());
}

describe('ratchet — self-implement 관측은 전부 runId 를 싣는다', () => {
  // ⭐ must-fix(4R) — 실 소스에 raw 호출이 0개라, **스캐너 자신이 세 형태를 실제로 잡는지**는
  //    소스만 봐서는 증명되지 않는다(정규식이 망가져도 계속 통과). fixture 로 직접 검증한다.
  test.each([
    ["작은따옴표", `debug.log('self-implement', 'ev', {});`],
    ["큰따옴표", `debug.log("self-implement", 'ev', {});`],
    ["백틱 템플릿", 'debug.log(`self-implement`, \'ev\', {});'],
    ["공백 삽입", `debug.log(  'self-implement' ,  'ev', {});`],
  ])('★ 스캐너가 raw 발화를 잡는다 — %s', (_label, fixture) => {
    expect(scanRawEmits(fixture)).toHaveLength(1);
  });

  test('스캐너가 무관한 호출·주석은 세지 않는다(오탐 0)', () => {
    expect(scanRawEmits(`debug.log('other-comp', 'ev', {});`)).toEqual([]);
    expect(scanRawEmits(`// debug.log('self-implement', 'ev', {});`)).toEqual([]);
    expect(scanRawEmits(`/* debug.log('self-implement', 'ev', {}); */`)).toEqual([]);
  });

  test('★ orchestrator raw 발화 allowlist는 비원장 종결 보조 로그뿐이고 각각 fail-soft 다', () => {
    // ⚠️ 한계(숨기지 않음): 텍스트 기반이라 `const l = debug.log; l(...)` 같은 별칭은 못 잡는다.
    // 완전 차단은 AST 가 필요하며, 그 형태를 도입한다면 이 가드를 함께 올릴 것.
    const src = readFileSync(ORCH, 'utf-8');
    expect(scanRawEmits(src)).toEqual([]);
    expect(src).toMatch(/observe\('prior-findings\.unreadable',\s*\{ error:/);
    expect(src).toMatch(/observe\('prior-findings\.loaded',\s*\{/);
    for (const event of ['goal-execution-record', 'goal-execution-record-failed', 'goal-run-store-failed']) {
      expect(src).toMatch(new RegExp(`logRunAwareFailSoft\\(\\s*runId\\s*,\\s*['\"]${event}['\"]`));
    }
    expect(src).toMatch(/function logRunAwareFailSoft[\s\S]*?try \{ log\([\s\S]*?\} catch \{ \/\* fail-soft \*\//);
  });
});

// ── 실행 검증 (must-fix 2R: 소스 정규식만으로는 실제 전파를 입증 못 한다) ──────────────────
describe('실행 — 발화된 로그가 실제로 같은 runId 를 싣는다', () => {
  const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
  let spy: ReturnType<typeof spyOn> | null = null;

  const capture = (): void => {
    spy = spyOn(debug, 'log').mockImplementation(((comp: string, event: string, data?: Record<string, unknown>) => {
      if (comp === 'self-implement') seen.push({ event, data: data ?? {} });
    }) as never);
  };
  afterEach(() => { spy?.mockRestore(); spy = null; seen.length = 0; });

  /** 최소 fake seam — 실제 git/PR 없이 시퀀서만 돌리고 원장은 임시 상태 디렉터리에 쓴다. */
  const ledgerStateDir = mkdtempSync(join(tmpdir(), 'selfdev-observation-ledger-'));
  const seams = () => ({
    // ⛔⭐⭐⭐ 기본을 «무동작»으로 — 안 채우면 실제 계정 스토어를 읽고 codex 자식을 띄우고
    //   ~/.elanous/budget 에 쓴다(= 테스트가 «운영 쿼터를 소모»한다 · 리뷰 must-fix).
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    createWorktree: async ({ branch }: { branch: string }) => ({ path: '/tmp/wt', branch }),
    implement: async () => ({ ok: true, summary: 'done' }),
    gate: async () => ({ passed: true }),
    openPr: async () => ({ url: 'u', number: 1 }),
    writeRunLedger: (entry: Parameters<typeof appendRunLedgerEntry>[0]) => appendRunLedgerEntry(entry, join(ledgerStateDir, 'run-ledger')),
  });
  afterEach(() => rmSync(ledgerStateDir, { recursive: true, force: true }));

  test('★ 한 run 의 모든 self-implement 발화가 **동일한** runId 를 싣는다', async () => {
    capture();
    await runSelfImplement({ feature: 'x', runId: 'run-fixed-a', seams: seams() } as never);
    expect(seen.length).toBeGreaterThan(3);
    const ids = new Set(seen.map((e) => e.data.runId));
    expect([...ids]).toEqual(['run-fixed-a']);   // 하나로 수렴 · 빠진 발화 없음
    expect(existsSync(join(ledgerStateDir, 'run-ledger', 'run-fixed-a.jsonl'))).toBe(true);
  });

  test('★ 서로 다른 run 은 서로 다른 runId 로 갈린다 (동시 실행 분리의 핵심)', async () => {
    capture();
    await runSelfImplement({ feature: 'x', runId: 'run-A', seams: seams() } as never);
    const a = seen.filter((e) => e.data.runId === 'run-A').length;
    await runSelfImplement({ feature: 'y', runId: 'run-B', seams: seams() } as never);
    const b = seen.filter((e) => e.data.runId === 'run-B').length;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // 섞이지 않는다 — 두 집합의 합이 전체와 같다(제3의 값이 없다).
    expect(seen.filter((entry) => entry.data.runId !== 'run-A' && entry.data.runId !== 'run-B')).toEqual([]);
  });

  test('★ 호출자 data.runId 가 식별자를 덮어쓰지 못한다 (충돌을 실제로 주입)', () => {
    // ⚠️ must-fix(2R): 종전엔 정상 로그만 재확인해서 병합 동작을 전혀 검증하지 못했다(Goodhart).
    //    순수 팩토리에 **충돌하는 runId 를 직접 넣어** 어느 쪽이 이기는지 본다.
    const out: Array<Record<string, unknown>> = [];
    const observe = makeRunObserver('run-authoritative', ((_c: string, _e: string, d?: Record<string, unknown>) => {
      out.push(d ?? {});
    }) as never, undefined, () => {});

    observe('ev', { runId: 'run-IMPOSTOR', other: 1 });
    expect(out[0]!.runId).toBe('run-authoritative');   // 병합 순서가 뒤집히면 'run-IMPOSTOR'
    expect(out[0]!.other).toBe(1);                     // 나머지 필드는 보존

    observe('ev2', {});
    expect(out[1]!.runId).toBe('run-authoritative');
  });

  test('★ run-identity 의 source 가 거짓이 되지 않는다 — mint 는 minted 로 기록 (must-fix 5R)', async () => {
    const ids: Array<Record<string, unknown>> = [];
    spy = spyOn(debug, 'log').mockImplementation(((comp: string, event: string, data?: Record<string, unknown>) => {
      if (comp === 'run-identity' && event === 'own') ids.push(data ?? {});
    }) as never);

    const prev = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;   // 상속 없음 → canonical mint 경로
    try {
      const first = await runSelfImplement({ feature: 'x', seams: seams() } as never);   // runId 미지정
      const second = await runSelfImplement({ feature: 'y', seams: seams() } as never);
      expect(first.runId).not.toBe(second.runId);
      expect(ids).toHaveLength(2);
      // 래퍼가 runId 만 explicit 로 재전달하면 여기가 'explicit' 이 된다 = 관측이 거짓말.
      expect(ids.map((identity) => identity.source)).toEqual(['minted', 'minted']);
    } finally { if (prev === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = prev; }
  });

  test('★ 명시 runId 는 explicit 로 정직하게 기록된다(무회귀)', async () => {
    const ids: Array<Record<string, unknown>> = [];
    spy = spyOn(debug, 'log').mockImplementation(((comp: string, event: string, data?: Record<string, unknown>) => {
      if (comp === 'run-identity' && event === 'own') ids.push(data ?? {});
    }) as never);
    await runSelfImplement({ feature: 'x', runId: 'run-explicit', seams: seams() } as never);
    expect(ids[0]!.source).toBe('explicit');
    expect(ids[0]!.runId).toBe('run-explicit');
  });

  test('관측기는 로깅이 던져도 삼킨다 — 관측 실패가 파이프라인을 죽이면 안 된다', () => {
    const observe = makeRunObserver('r', (() => { throw new Error('sink down'); }) as never, undefined, () => {});
    expect(() => observe('ev', {})).not.toThrow();
  });

  test('★ hang(step-timeout) 경로도 runId 를 싣는다', async () => {
    capture();
    const r = await runSelfImplement({
      feature: 'x', runId: 'run-hang', stepTimeouts: { implement: 50 },
      seams: { ...seams(), implement: () => new Promise(() => {}) },
    } as never);
    const to = seen.find((e) => e.event === 'step-timeout');
    expect(r.ok).toBe(false);
    expect(to?.data.runId).toBe('run-hang');
  }, 30_000);

  test('★ hang + throwing sink에서도 step-timeout과 raw 종결 기록을 실제 호출하고 timed-out을 반환한다', async () => {
    const priorProvider = process.env.ELANOUS_LLM_PROVIDER;
    const priorEscalationProvider = process.env.ELANOUS_ESCALATE_PROVIDER;
    delete process.env.ELANOUS_LLM_PROVIDER;
    delete process.env.ELANOUS_ESCALATE_PROVIDER;
    try {
      spy = spyOn(debug, 'log').mockImplementation((() => {
        throw new Error('sink down');
      }) as never);
      const r = await runSelfImplement({
        feature: 'x', runId: 'run-hang2', stepTimeouts: { implement: 50 },
        seams: { ...seams(), implement: () => new Promise(() => {}) },
      } as never);
      expect(r.ok).toBe(false);
      expect(r.stage).toBe('timed-out');
      const calls = spy.mock.calls as Array<[string, string, Record<string, unknown>]>;
      expect(calls.some(([component, event]) => component === 'self-implement' && event === 'step-timeout')).toBe(true);
      expect(calls.some(([component, event]) => component === 'self-implement' && event === 'goal-execution-record')).toBe(true);
    } finally {
      if (priorProvider === undefined) delete process.env.ELANOUS_LLM_PROVIDER;
      else process.env.ELANOUS_LLM_PROVIDER = priorProvider;
      if (priorEscalationProvider === undefined) delete process.env.ELANOUS_ESCALATE_PROVIDER;
      else process.env.ELANOUS_ESCALATE_PROVIDER = priorEscalationProvider;
    }
  }, 30_000);

  test('★ 기록 writer와 sink가 모두 던져도 raw 실패 기록을 실제 호출하고 terminal 결과를 보존한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfdev-observation-'));
    const goalFile = join(dir, 'goal.md');
    writeFileSync(goalFile, '# goal\n');
    try {
      spy = spyOn(debug, 'log').mockImplementation(((component: string, event: string) => {
        if (component === 'self-implement' && event === 'goal-execution-record-failed') throw new Error('sink down');
      }) as never);
      const r = await runSelfImplement({
        feature: 'x', runId: 'run-record-failed', goalFile,
        writeGoalExecutionRecord: () => { throw new Error('writer down'); },
        seams: {
          ...seams(),
          escalateGoalClarifications: async () => ({ outcome: 'skipped' }),
        },
      } as never);
      expect(r.stage).toBe('pr-declined');
      const calls = spy.mock.calls as Array<[string, string, Record<string, unknown>]>;
      expect(calls.some(([component, event]) => component === 'self-implement' && event === 'goal-execution-record-failed')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** dev-pipeline 발화를 뽑는다 — **payload(3번째 인자부터)만** 본다.
 *  ⚠️ 이벤트명(2번째 인자)까지 훑으면 `debug.log('dev-pipeline', runIdEvent, payload)` 처럼
 *  이름에 runId 가 든 **미태깅** 호출을 태깅으로 오판한다(리뷰 must-fix 7R).
 *
 *  ⚠️⚠️ **알려진 한계 (정지 지점 · 숨기지 않는다)**: 이 스캐너들(`scanDevEmits`·`scanRawEmits`)은
 *  텍스트 정규식이라 원리적으로 못 막는 형태가 남는다 —
 *    · `runIdPayload` 같은 **이름만 비슷한 변수**나 4번째 옵션 인자의 `runId` → 태깅으로 오판(위양성)
 *    · `const l = debug.log; l('dev-pipeline', …)` 같은 **별칭 호출** → 아예 미탐지
 *  정확한 판정은 3번째 인자를 괄호 균형으로 파싱해야 하고, 그건 사실상 AST 다. 8라운드에 걸쳐
 *  조일수록 새 우회 형태가 계속 나왔으므로 **여기서 멈춘다** — 이 가드의 역할은 "완벽한 차단"이 아니라
 *  **흔한 실수(새 발화가 태깅을 빠뜨림)를 값싸게 잡는 것**이다. 실제 전파 보장은 위 실행 테스트
 *  (동일 runId 수렴 · run 분리 · 충돌 주입 · hang 경로)가 진다. AST 전환은 후속 과제. */
function scanDevEmits(src: string): Array<{ payload: string }> {
  return [...stripComments(src).matchAll(/debug\.log\(\s*['"`]dev-pipeline['"`]\s*,\s*[^,]+,\s*([^;]*)/g)]
    .map((m) => ({ payload: m[1] ?? '' }));
}

describe('ratchet — dev-pipeline 관측도 실행을 가른다', () => {
  // ⭐ must-fix(7R) — 스캐너 자신이 미태깅을 잡는지 fixture 로 증명한다(orchestrator 쪽과 동일 규율).
  test.each([
    ['변수 payload 미태깅', `debug.log('dev-pipeline', 'done', payload);`, false],
    ['이벤트명에 runId(미태깅)', `debug.log('dev-pipeline', runIdEvent, payload);`, false],
    ['정상 태깅', `debug.log('dev-pipeline', 'done', { runId: devRunId, ok });`, true],
    ['백틱 컴포넌트 + 태깅', 'debug.log(`dev-pipeline`, \'done\', { runId: x });', true],
  ])('★ 스캐너 판정 — %s', (_label, fixture, expected) => {
    const emits = scanDevEmits(fixture);
    expect(emits).toHaveLength(1);
    expect(/runId/.test(emits[0]!.payload)).toBe(expected);
  });

  test('★ `elanous dev` 진입점이 runId 를 확정하고 세 발화 전부에 싣는다', () => {
    const rawSource = readFileSync(INDEX, 'utf-8');
    const start = rawSource.indexOf('.action(async (textParts: string[], opts: Record<string, any>, command: Command) => {', rawSource.indexOf("const selfDevCmd = program"));
    const end = rawSource.indexOf('\n  });\n\n// ──', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const src = stripComments(rawSource.slice(start, end));
    // 진입점에서 mint-once(자식이 상속하도록 env 에 심는다).
    // ⚠️ 선언 형태(`const`/`let`)에 묶지 않는다 — 형태를 바꾸면 배선이 멀쩡한데 가드가 깨진다(실측).
    // ⛔⭐⭐ **이 줄이 45차에 «두 번째로» 울었다**(`OBS-T19` 의 형태 그대로) — `[S]` 의 `#7054` 가
    //   `ensureRunId()` 를 `ensureRunIdentity()` 로 바꿨고 **계약은 살아 있었다**(`index.ts:4234`).
    //   ⇒ ***소스 정규식은 「계약」이 아니라 「문면」을 문다.*** 그래서 mint 하는 «두 형태»를 다 받는다.
    //   ⛔ 그래도 이것은 여전히 «문면»이다 — 진짜 답은 실물 argv 로 무는 것이고 그건 후속이다.
    expect(src).toMatch(/devRunId\s*=\s*(?:ensureRunId\(\)|identity\.runId)/);
    // ⚠️ must-fix(6R·7R): 객체 리터럴만 집계하면 변수 payload 를 놓치고, 인자 구분 없이 훑으면
    //    이벤트명에 든 runId 를 태깅으로 오판한다. **payload 만** 보고 전수 단정한다.
    const emits = scanDevEmits(src);
    expect(emits.length).toBeGreaterThanOrEqual(3);   // plan · done · rejected|error
    expect(emits.filter((e) => !/runId/.test(e.payload))).toEqual([]);
  });

  test('★ catch 안 관측이 fail-soft 다 — 로거가 던져도 console.error·exit(1) 을 우회하지 않는다', () => {
    const src = stripComments(readFileSync(INDEX, 'utf-8'));
    // 계약은 둘이다: ⑴ 에러 발화가 «자기 try» 로 감싸여 있고 ⑵ 같은 catch 경로가 여전히 «사용자에게» 말한다.
    //
    // ⛔⭐ 종전엔 이 둘을 «하나의 인접 정규식»으로 못 박았고, 그래서 «두 번» 울었다 —
    //    ① `console.error` 단독을 요구해 JSON 분기가 생기자 울었고,
    //    ② `if (…) { console.error` 로 고쳤더니 그 분기 안이 `writeStdoutJson` 으로 바뀌자 또 울었다.
    //    두 번 다 ***계약은 지켜지고 있었고 «모양»만 바뀌었다.***
    //
    // ⛔⭐⭐ 그리고 이 파일엔 `debug.log('dev-pipeline'` 이 «여섯 곳» 있다 — 닻 없이 첫 매치를 쓰면
    //    ***엉뚱한 자리를 보고 늘 초록이 된다***(실측: 감쌈을 벗겨도·사용자 출력을 지워도 초록이었다).
    //    ⇒ 닻은 «의미»로 잡는다 — 이 경로를 경로이게 하는 것은 `DevPipelineError` 를 가르는 발화다.
    const anchor = src.indexOf("debug.log('dev-pipeline', e instanceof DevPipelineError");
    expect(anchor, 'dev-pipeline 에러 경로의 발화를 못 찾았다 — 이 자가 무엇을 봤는지 알 수 없다').toBeGreaterThan(-1);

    const before = src.slice(Math.max(0, anchor - 80), anchor);
    expect(/try\s*\{\s*$/.test(before), `에러 경로의 발화가 «자기 try» 로 안 감싸여 있다 — 앞: ${before.slice(-60)}`).toBe(true);

    const after = src.slice(anchor);
    const closed = /^[^;]*;\s*\}\s*catch\s*\{[^}]*\}/.exec(after);
    expect(closed, '발화 뒤에 catch 가 안 온다 — 로거가 던지면 아래가 통째로 우회된다').not.toBeNull();

    const pathEnd = after.indexOf('completionGuard.conclude');
    expect(pathEnd, 'catch 경로의 끝(completionGuard.conclude)을 못 찾았다').toBeGreaterThan(-1);
    const userFacingPath = after.slice(closed![0].length, pathEnd);
    expect(
      /console\.(?:error|log)|writeStdoutJson/.test(userFacingPath),
      `관측 뒤 사용자 출력이 없다 — 살펴본 구간: ${userFacingPath.slice(0, 200)}`,
    ).toBe(true);
  });

  test('사람이 읽는 종료 출력에도 run 과 auto-merge 생략 이유를 조건부로 노출한다', () => {
    const src = stripComments(readFileSync(INDEX, 'utf-8'));
    // ⛔⭐ 종전엔 여기서 `run=${devRunId}` 문면을 «index.ts 소스»에서 찾았다. 조립을 순수 함수로
    //    옮기면서 그 문면이 dev-cli 로 갔다 ⇒ ***같은 계약인데 자리가 바뀌면 ratchet 이 운다.***
    //    ⇒ 「runId 가 그 줄에 실린다」는 계약은 아래 «행동» 테스트가 문다(더 강하다).
    //      여기서는 진입점이 runId 를 «그 함수에 넘기는지»만 남긴다 — 배선 ratchet 의 본분.
    expect(src).toMatch(/runId:\s*devRunId/);
    // ⛔⭐ 소스 정규식은 «문면이 있다»만 말하고 «무엇이 찍히나»를 못 말한다(무인 리뷰: Goodhart).
    //    ⇒ 조립을 순수 함수로 뺐고, 아래 별도 describe 가 «행동»을 직접 문다.
    //    여기서는 진입점이 그 함수를 «부르는지»만 남긴다(배선 ratchet 의 본분).
    expect(src).toMatch(/renderDevCompletionLine\(\{/);
  });
});

// ⭐ 행동 테스트 — 마지막 줄이 «실제로» 무엇을 담는가. 소스 문면이 아니라 산출을 문다.
describe('formatDevCompletionLine — auto-merge 생략 이유는 «조건부»로만 붙는다', () => {
  test('이유가 있으면 붙고, 없으면 «아무것도» 안 붙는다', async () => {
    const { formatDevCompletionLine } = await import('../src/self-dev/dev-cli.js');
    const base = { kind: 'self', ok: true, runId: 'run-x', outcome: 'completed' } as const;

    const withReason = formatDevCompletionLine({ ...base, mergeSkipReason: 'signal-incomplete' });
    expect(withReason).toContain('merge-skip=signal-incomplete');

    const withoutReason = formatDevCompletionLine({ ...base });
    expect(withoutReason).not.toContain('merge-skip');
    // ⛔ 「없을 때 안 붙는다」만 물면 «항상 안 붙어도» 통과한다 ⇒ 나머지가 그대로인지도 문다.
    expect(withoutReason).toBe('[dev] self 완료 · ok=true · outcome=completed · run=run-x');

    // ⛔⭐⭐ 포매터만 물면 «배선»(result.mergeReason → 마지막 줄)이 삭제돼도 통과한다(리뷰 must-fix 3R).
    //    ⇒ «결과 객체»를 넣어 최종 문자열을 받는 경로로 문다 — 배선을 지우면 이 단언이 운다.
    const { renderDevCompletionLine } = await import('../src/self-dev/dev-cli.js');
    expect(renderDevCompletionLine({
      kind: 'self', ok: true, runId: 'run-y',
      result: { outcome: 'completed', mergeReason: 'merge-guard-blocked' },
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · merge-skip=merge-guard-blocked · run=run-y');
    // ⭐ self 가 아니면 result 를 읽지 «않는다» — 잘못된 표면에서 이유가 새지 않게.
    expect(renderDevCompletionLine({
      kind: 'shell', ok: true, runId: 'run-z',
      result: { outcome: 'completed', mergeReason: 'merge-guard-blocked' },
    })).toBe('[dev] shell 완료 · ok=true · run=run-z');
  });
});

describe('renderDevCompletionLine — 머지 도착지는 실제 머지 때만 붙는다', () => {
  test('merged base를 표시하고, 미머지 결과에는 도착지를 덧붙이지 않는다', async () => {
    const { renderDevCompletionLine } = await import('../src/self-dev/dev-cli.js');

    expect(renderDevCompletionLine({
      kind: 'self', ok: true, runId: 'run-merged', base: 'feature/stacked-base',
      result: { outcome: 'completed', merged: true },
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · merged=true · merged-into=unknown · merged-pr=unconfirmed · run=run-merged');

    expect(renderDevCompletionLine({
      kind: 'self', ok: true, runId: 'run-unmerged', base: 'feature/stacked-base',
      result: { outcome: 'completed', merged: false },
    })).toBe('[dev] self 완료 · ok=true · outcome=completed · run=run-unmerged');
  });
});

// ⛔⭐⭐ 실패 관측의 «갈래»를 고정한다 — dev 는 DevPipelineError 를 `rejected` 로, 그 밖을 `error` 로
//    갈라 왔다. 자동 워크트리 착지가 자식 예외를 «먼저» 삼키는 래퍼를 넣으면서 그 구분이
//    사라질 뻔했다(무인 리뷰 must-fix). ⇒ 두 자리 «모두»가 그 분기를 갖는지 고정한다.
// ⚠️ 한계(숨기지 않음): 실물 `elanous dev` 를 띄워 관측을 캡처하는 것이 더 강하지만 수십 분이 들어
//    이 착지에 비례하지 않는다. 그 층은 별도 착지에서 연다.
describe('ratchet — dev 실패 관측은 rejected 와 error 를 «가른다»', () => {
  test('★ 래퍼 경로와 바깥 catch «둘 다» DevPipelineError 로 분기한다', () => {
    const src = stripComments(readFileSync(INDEX, 'utf-8'));
    const branches = [...src.matchAll(/instanceof\s+DevPipelineError\s*\?\s*'rejected'\s*:\s*'error'/g)];
    // ⭐ 「하나라도 있다」가 아니라 «둘»을 문다 — 한 자리만 고치면 다른 자리가 조용히 다르게 말한다.
    expect(`branches=${branches.length}`).toBe('branches=2');
  });
});
