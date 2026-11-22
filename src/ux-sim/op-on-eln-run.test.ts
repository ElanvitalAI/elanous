import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OP_WORLD_REPLAY_DISPOSITIONS } from './op-world-evaluator.js';

// 종단 회귀(#39377 shouldFix b): agent 경계(가짜 eln)만 목킹하고
// choice 디코딩 → 월드 적용 → 영수증 verdict 까지 실경로로 돌린다.
const runner = join(import.meta.dir, 'op-on-eln-run.ts');
const fakeEln = join(import.meta.dir, 'fixtures', 'op-on-eln-fake-eln.ts');

interface DecisionComparison {
  eligible: number;
  observed: number;
  matched: number;
  mismatched: number;
  unobserved: number;
}

interface GraphRun {
  // JUD-C #129124: verdict 는 stdout summary 가 아니라 영수증 파일 자체에서 읽는다.
  verdict: string;
  comparison: DecisionComparison | null;
  sceneCount: number;
  scoredSceneCount: number;
}

async function runOpGraph(fakeMode: 'correct' | 'wrong' | 'silent'): Promise<GraphRun> {
  const output = join(mkdtempSync(join(tmpdir(), 'op-on-eln-run-test-')), 'receipt.json');
  const env: Record<string, string | undefined> = { ...process.env, ELANOUS_OP_FAKE_MODE: fakeMode };
  delete env.ELANOUS_OP_WORLD_ANSWER_KEY; // 기본 그래프 실행: 외부 정답키 없음
  const child = Bun.spawn([process.execPath, runner, '--eln', fakeEln, '--output', output], {
    env, stdout: 'pipe', stderr: 'pipe',
  });
  const [, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exit !== 0) throw new Error(`op-on-eln-run exit ${exit}: ${stderr.trim().slice(-600)}`);
  const receipt = JSON.parse(readFileSync(output, 'utf8')) as {
    verdict: string;
    actualDecisionComparison: DecisionComparison | null;
    sceneCount: number;
    scoredSceneCount: number;
  };
  return {
    verdict: receipt.verdict,
    comparison: receipt.actualDecisionComparison,
    sceneCount: receipt.sceneCount,
    scoredSceneCount: receipt.scoredSceneCount,
  };
}

describe('op-on-eln-run — 기본 실행의 내장 정답 비교 기록 (#39377 mustFix ①)', () => {
  // 시간 상한 근거: ask() 1회 상한 120 s(op-on-eln-run.ts) × 스폰 22회(장면 21 + 재시도 후속 1)의
  // 최악이 아니라, 가짜 응답이 즉시 반환되는 실측(수 초) 위 여유치다.
  test('정답키 없음에도 106개 선택형 재현의 관측·정답 비교가 영수증에 기록된다', async () => {
    const run = await runOpGraph('correct');
    // 장면 수: SCENES 4(op-on-eln-world.ts) + ACTION_REPLAY 3(op-world-replay.ts) + 선택형 14(= ceil(106/8))
    expect(run.sceneCount).toBe(21);
    // 채점 장면 수: 선택형 14장면은 채점에서 제외(op-on-eln-run.ts)
    expect(run.scoredSceneCount).toBe(7);
    expect(run.comparison).not.toBeNull();
    // 판단 수: ledger 76 + op-mail 30(op-world-decision-fixtures.ts)
    expect(run.comparison!.eligible).toBe(106);
    expect(run.comparison!.matched).toBe(106);
    expect(run.comparison!.mismatched).toBe(0);
    expect(run.comparison!.unobserved).toBe(0);
    expect(run.verdict).toBe('ok');
  }, 240_000);

  test('전보기 오답은 mismatched 106·verdict fail 로 기록된다', async () => {
    const run = await runOpGraph('wrong');
    expect(run.comparison!.mismatched).toBe(106);
    expect(run.comparison!.unobserved).toBe(0);
    expect(run.verdict).toBe('fail');
  }, 240_000);

  // JUD-C #128898 mustFix: 기본 실행 경로에 «선택형 미응답»을 실제로 주입하고
  // 영수증에 unobserved 와 실패 verdict 가 기록되는 종단 회귀.
  test('선택형 미응답(silent)은 unobserved 106·verdict fail 로 영수증에 기록된다', async () => {
    const run = await runOpGraph('silent');
    // 출처: JUD-C #128898 — eligible 은 내장 판단 수(ledger 76 + op-mail 30 = 106)와 같다
    expect(run.comparison!.eligible).toBe(106);
    // 출처: JUD-C #128898 — choice 미제출 → observedDisposition null → unobserved 106
    expect(run.comparison!.unobserved).toBe(106);
    expect(run.comparison!.matched).toBe(0);
    expect(run.comparison!.mismatched).toBe(0);
    // 출처: JUD-C #128898 — unobserved>0 은 failedComparison → verdict fail
    expect(run.verdict).toBe('fail');
  }, 240_000);
});

describe('op-on-eln-run — 프롬프트 처분 안내는 형식만 (terra r4 mustFix ① · #39377)', () => {
  // 계약: 프롬프트는 처분 토큰 «형식»(열거)만 안내한다. 어느 장면에 어느 토큰이
  // 정답인지의 매핑은 채점기(op-world-evaluator.ts · op-world-score.ts)에만 둔다.
  // 에이전트가 안내문만 읽고 정답 처분을 제출할 수 있으면 안 된다.
  const sceneCues: Record<string, readonly string[]> = {
    'replay-gate-stop': ['게이트 보류'],
    'replay-scoped-repair': ['최소 범위 수리'],
    'replay-direct-edit': ['격리 직접 수정'],
  };

  test('토큰을 담은 안내 문장에 장면별 정답 매핑 큐가 공존하지 않는다', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'op-on-eln-prompt-capture-'));
    const output = join(mkdtempSync(join(tmpdir(), 'op-on-eln-run-test-')), 'receipt.json');
    const env: Record<string, string | undefined> = { ...process.env, ELANOUS_OP_FAKE_MODE: 'correct', ELANOUS_OP_FAKE_PROMPT_CAPTURE: captureDir };
    delete env.ELANOUS_OP_WORLD_ANSWER_KEY;
    const child = Bun.spawn([process.execPath, runner, '--eln', fakeEln, '--output', output], {
      env, stdout: 'pipe', stderr: 'pipe',
    });
    const [, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exit !== 0) throw new Error(`op-on-eln-run exit ${exit}: ${stderr.trim().slice(-600)}`);
    for (const [sceneId, token] of Object.entries(OP_WORLD_REPLAY_DISPOSITIONS)) {
      const promptText = readFileSync(join(captureDir, `${sceneId}.txt`), 'utf8');
      const tokenLines = promptText.split('\n').filter(line => line.includes(token));
      // 형식 안내(토큰 열거)는 여전히 존재한다.
      expect(tokenLines.length).toBeGreaterThan(0);
      // 정답 매핑 금지: 토큰을 담은 안내 문장에 그 장면의 정답 큐가 나타나면 유출이다.
      for (const cue of sceneCues[sceneId]!) {
        expect(tokenLines.some(line => line.includes(cue))).toBe(false);
      }
    }
  }, 240_000);
});
