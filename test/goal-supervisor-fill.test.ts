import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillUnverifiableGoalSlots, type SupervisorGoalFillEvidence } from '../src/self-implement/goal-supervisor-fill.js';
import { defaultSeams } from '../src/self-implement/seams.js';

const original = `Goal title

## 불변식
- UNVERIFIABLE

## 판정 신호
- UNVERIFIABLE

## REQUIRED EVIDENCE
- unchanged
`;

function goal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-supervisor-fill-'));
  const path = join(dir, 'GOAL.txt');
  writeFileSync(path, original);
  return path;
}

const productionGateLog = [
  '[test] PASS bun test test/goal-supervisor-fill.test.ts — 12 pass | 0 fail',
  '[cli-smoke] PASS bun bin/elanous.mjs --help —',
  '',
  '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0',
].join('\n');

// ⛔ 증거 모양을 여기서 다시 적지 않는다 — 갈리면 새 필드가 테스트에 안 보인다(방금 tsc 가 잡았다).
const input = (path: string, independentlyCheck: (document: string, evidence: SupervisorGoalFillEvidence) => Promise<boolean>) => ({
  path, round: 2, gate: { passed: true, log: productionGateLog },
  review: { verdict: 'pass' as const }, independentlyCheck,
});

describe('supervisor goal slot fill', () => {
  test('fills both empty slots from production test and baseline evidence with provenance', async () => {
    const path = goal();
    const result = await fillUnverifiableGoalSlots(input(path, async (document, evidence) =>
      evidence.command === 'bun test test/goal-supervisor-fill.test.ts'
      // ⭐ 두 절이 **서로 다른 것**을 말한다 — 같은 문자열이면 무엇도 검증하지 않는다.
      && document.includes('조건 — bun test test/goal-supervisor-fill.test.ts 가 실패 없이 끝난다')
      && document.includes('관측 — `bun test test/goal-supervisor-fill.test.ts` 요약 줄의 fail 수')
      // ⭐ 기대값이 아니라 **로그에서 읽은 관측값**이 실린다.
      && evidence.observedFail === 0
      && document.includes('이 라운드에서 관측됨 — fail 0')
      && document.includes('이번 라운드 관측값 — fail 0')
      && document.includes('filled-by: supervisor@round-2')));
    const filled = readFileSync(path, 'utf8');
    expect(result).toBe('filled');
    expect(filled).toContain('filled-by: supervisor@round-2');
    expect(filled).not.toContain('UNVERIFIABLE');
    expect(filled).not.toContain('gate passed');
  });

  // ⛔⭐ **생산 검사기 자체**를 부른다(주입 콜백이 아니다) — 종전 판은 콜백에 `fail 99` 를 요구해
  //   의도적으로 거부시키는 Goodhart 였다(리뷰 must-fix). 생산 파서를 약화하면 이 검사가 죽어야 한다.
  test('the production checker rejects a document whose numbers disagree with the gate log', async () => {
    const check = defaultSeams().independentlyCheckGoalSlots!;
    const evidence = { round: 2, command: 'bun test test/goal-supervisor-fill.test.ts', reviewVerdict: 'pass' as const,
      observedFail: 0, baselineLine: '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0', gateLog: productionGateLog };
    const good = `## 불변식\n- filled-by: supervisor@round-2\n  조건 — ${evidence.command} 가 실패 없이 끝난다\n  이 라운드에서 관측됨 — fail 0\n  근거 — round-2 gate [test] PASS ${evidence.command} · ${evidence.baselineLine}\n\n## 판정 신호\n- filled-by: supervisor@round-2\n  관측 — \`${evidence.command}\` 요약 줄의 fail 수\n  이번 라운드 관측값 — fail 0\n  근거 — round-2 review pass · ${evidence.baselineLine}\n`;
    expect(await check(good, evidence)).toBe(true);
    // ⛔ 로그는 fail 0 인데 문서가 fail 3 이라 주장한다 ⇒ 생산 검사기가 거부해야 한다.
    expect(await check(good.replace(/fail 0/g, 'fail 3'), evidence)).toBe(false);
    // ⛔ 정상 수치 **옆에 엉뚱한 수치가 하나 더** 있는 경우 — 다른 검사는 통과시키고 이 가드만 잡는다.
    expect(await check(good.replace('근거 —', '근거 — (이전 라운드 fail 7) '), evidence)).toBe(false);
    // ⛔ baseline 이 로그와 **다르면**(preexisting=9) 거부 — 부분 문자열 검사로는 통과하던 것.
    expect(await check(good.replace('preexisting=0', 'preexisting=9'), evidence)).toBe(false);
    // ⛔ 조건 줄의 명령만 변조 — 근거 줄에 정상 명령이 남아 있어도 거부되어야 한다.
    expect(await check(good.replace(`조건 — ${evidence.command}`, '조건 — bun test other'), evidence)).toBe(false);
    // ⛔ 셸 주입 — 로그에 $(...) 가 있어도 명령으로 실행되지 않고 그냥 거부된다.
    expect(await check(good, { ...evidence, gateLog: '$(touch /tmp/pwned-goal-check)' })).toBe(false);
    expect(existsSync('/tmp/pwned-goal-check')).toBe(false);
  });

  // ⛔⭐ 반증 입력 — 로그가 **스스로 모순**이면(PASS 라고 적혀 있는데 fail 이 있다) 채우지 않는다.
  //   종전 판은 fail 수를 **읽지 않아서** 이런 로그로도 `기대 — fail 0` 을 박을 수 있었다(리뷰 must-fix).
  test('refuses to fill from a self-contradicting gate log that says PASS but reports failures', async () => {
    const path = goal();
    const before = readFileSync(path, 'utf8');
    const result = await fillUnverifiableGoalSlots({
      ...input(path, async () => true),
      gate: { passed: true, log: [
        '[test] PASS bun test test/goal-supervisor-fill.test.ts — 0 pass | 5 fail',
        '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0',
      ].join('\n') },
    });
    expect(result).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(before);   // 바이트 동일
  });

  // PASS에서 실패 귀속 baseline은 실행되지 않는다. 안 잰 값을 0으로 만들어 적지 않는다.
  test('fills from test PASS without inventing an unrun baseline row', async () => {
    const path = goal();
    const result = await fillUnverifiableGoalSlots({
      ...input(path, defaultSeams().independentlyCheckGoalSlots!),
      gate: { passed: true, log: '[test] PASS bun test test/goal-supervisor-fill.test.ts — 5 pass | 0 fail' },
    });
    expect(result).toBe('filled');
    const filled = readFileSync(path, 'utf8');
    expect(filled).toContain('baseline not run (test PASS)');
    expect(filled).not.toContain('[gate-baseline] introduced=0');
  });

  test('leaves unverifiable slots byte-identical when actual gate evidence is absent or contradictory', async () => {
    const path = goal();
    const missing = await fillUnverifiableGoalSlots({ ...input(path, async () => true), gate: { passed: true, log: '[test] PASS' } });
    expect(missing).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);

    const contradictory = await fillUnverifiableGoalSlots({
      ...input(path, async () => true),
      gate: { passed: true, log: productionGateLog.replace('introduced=0', 'introduced=1') },
    });
    expect(contradictory).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('keeps the original document byte-identical when the independent checker rejects the candidate', async () => {
    const path = goal();
    const result = await fillUnverifiableGoalSlots(input(path, async () => false));
    expect(result).toBe('rejected');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('reports already-filled and leaves a fully human-authored goal byte-identical', async () => {
    const path = goal();
    writeFileSync(path, original.replaceAll('- UNVERIFIABLE', '- 사람이 쓴 조건'));
    const before = readFileSync(path, 'utf8');
    expect(await fillUnverifiableGoalSlots(input(path, async () => true))).toBe('already-filled');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('reports unverifiable when gate evidence or review is absent and leaves slots byte-identical', async () => {
    const path = goal();
    const before = readFileSync(path, 'utf8');
    expect(await fillUnverifiableGoalSlots({ ...input(path, async () => true), gate: { passed: false } })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(before);

    expect(await fillUnverifiableGoalSlots({ ...input(path, async () => true), review: undefined })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('keeps a partially authored goal unverifiable rather than treating it as already-filled', async () => {
    const path = goal();
    writeFileSync(path, original.replace('- UNVERIFIABLE', '- 사람이 쓴 조건'));
    const before = readFileSync(path, 'utf8');
    expect(await fillUnverifiableGoalSlots(input(path, async () => true))).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('replaces only each UNVERIFIABLE line and preserves neighboring authored content', async () => {
    const path = goal();
    writeFileSync(path, original.replace(/- UNVERIFIABLE/, '- UNVERIFIABLE\n- 사람이 남긴 불변식')
      .replace('## 판정 신호\n- UNVERIFIABLE', '## 판정 신호\n- UNVERIFIABLE\n- 사람이 남긴 판정 신호'));
    expect(await fillUnverifiableGoalSlots(input(path, async () => true))).toBe('filled');
    const filled = readFileSync(path, 'utf8');
    expect(filled).toContain('- 사람이 남긴 불변식');
    expect(filled).toContain('- 사람이 남긴 판정 신호');
    expect(filled).toContain('## REQUIRED EVIDENCE\n- unchanged');
  });

  test('replaces each authored colon-and-explanation UNVERIFIABLE slot as a whole line', async () => {
    const path = goal();
    const authoredSlot = '- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.';
    writeFileSync(path, original.replaceAll('- UNVERIFIABLE', authoredSlot));
    expect(await fillUnverifiableGoalSlots(input(path, async () => true))).toBe('filled');
    const filled = readFileSync(path, 'utf8');
    expect(filled).not.toContain(authoredSlot);
    expect(filled).not.toContain('UNVERIFIABLE');
    expect(filled).toContain('filled-by: supervisor@round-2');
  });

  test('mutation: removing filled-by provenance from an otherwise valid candidate is rejected', async () => {
    const path = goal();
    const result = await fillUnverifiableGoalSlots(input(path, async (document) =>
      document.includes('filled-by: supervisor@round-2') && !document.includes('UNVERIFIABLE')));
    expect(result).toBe('filled');
    expect(readFileSync(path, 'utf8')).toContain('filled-by: supervisor@round-2');
  });
});
