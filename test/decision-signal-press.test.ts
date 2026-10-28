import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectDecisionObservations, inspectDecisionSignalKinds, inspectDecisionSignalObservations } from '../scripts/ask-marker-check.js';
import { parseSafeDecisionSignalCommand, pressDecisionSignals } from '../src/self-implement/decision-signal-press.js';
import { resolveDecisionSignalPress, runSelfImplement } from '../src/self-implement/orchestrator.js';
import { seams } from '../src/self-implement/test-seams.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function goal(signals: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'decision-signal-press-'));
  temporary.push(directory);
  const path = join(directory, 'goal.md');
  writeFileSync(path, signals.join('\n'));
  return path;
}

const classified = (source: string) => ({
  kinds: inspectDecisionSignalKinds(source),
  observations: inspectDecisionObservations(source),
  signals: inspectDecisionSignalObservations(source),
});

describe('decision signal press', () => {
  test('executes two parser-classified commands and preserves an unpressable signal by name', () => {
    const source = [
      '판정 신호: 조건 = green; 관측 = `rg -c decision-signal-press test/decision-signal-press.test.ts`; 기대 = positive',
      '판정 신호: 조건 = count; 관측 = `rg -c import test/decision-signal-press.test.ts`; 기대 = positive',
      '판정 신호: 조건 = human; 관측 = 실기기 화면을 본다; 기대 = observed',
    ].join('\n');
    const result = pressDecisionSignals(classified(source), process.cwd());

    expect(result.pressedGreen).toHaveLength(2);
    expect(result.pressedRed).toHaveLength(0);
    expect(result.unpressed).toEqual([{ signal: '판정 신호: 조건 = human; 관측 = 실기기 화면을 본다; 기대 = observed', command: '실기기 화면을 본다', kind: 'unresolved', reason: 'unresolved' }]);
    expect(result.pressedCount).toBe(2);
  });

  test('records a nonzero exit as pressed red and refuses shell composition or arbitrary bun evaluation', () => {
    const source = '판정 신호: 조건 = red; 관측 = `bun test test/does-not-exist.test.ts`; 기대 = blocked';
    const result = pressDecisionSignals(classified(source), process.cwd());

    expect(result.unpressed).toEqual([]);
    expect(result.pressedRed).toHaveLength(1);
    expect(parseSafeDecisionSignalCommand('rg -c needle file; gh pr merge 7')).toEqual({ reason: 'shell-syntax-mixed' });
    expect(parseSafeDecisionSignalCommand('bun -e process.exit(0)')).toEqual({ reason: 'shell-syntax-mixed' });
  });

  test('parses candidate decision signal observations and carries their parser classification to the executor', () => {
    const source = ['- Candidate decision signal:', '  - Observation: `bun scripts/ask-marker-check.ts scripts/ask-marker-check.ts`'].join('\n');
    const parsed = inspectDecisionObservations(source);
    const signals = classified(source).signals;

    expect(parsed.signalCount).toBe(1);
    expect(signals).toEqual([{ signal: '- Candidate decision signal:', command: 'bun scripts/ask-marker-check.ts scripts/ask-marker-check.ts', kind: 'real' }]);
    expect(classified(source).signals[0]?.kind).toBe('real');
  });

  // The end-to-end merge refusal stays covered by orchestrator.test.ts; keep this file at the resolver seam.
  test('resolver passes classified red signals to the injected press without spawning a command', () => {
    const source = '판정 신호: 조건 = false; 관측 = `bun test test/does-not-exist.test.ts`; 기대 = blocked';
    const classification = classified(source);
    let pressCalls = 0;
    const result = resolveDecisionSignalPress('/goal.md', '/worktree', {
      stat: () => ({ isFile: () => true }),
      read: () => source,
      inspectKinds: () => classification.kinds,
      inspectObservations: () => classification.observations,
      inspectSignals: () => classification.signals,
      press: (input, cwd) => {
        pressCalls++;
        expect(cwd).toBe('/worktree');
        expect(input.signals).toEqual(classification.signals);
        return {
          classification: { kinds: input.kinds, observations: input.observations },
          pressedGreen: [],
          pressedRed: [{ signal: input.signals[0]!.signal, command: input.signals[0]!.command!, exitCode: 1, stdout: '(fail) missing test file', durationMs: 0 }],
          pressedBaselineOnly: [],
          unpressed: [],
          pressedCount: 1,
        };
      },
    });
    expect(pressCalls).toBe(1);
    expect(result.decisionSignalPress?.classification).toEqual({ kinds: classification.kinds, observations: classification.observations });
    expect(result.decisionSignalPress?.pressedRed).toHaveLength(1);
  });

  test('zero executable signals preserves auto merge and records zero presses', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let merges = 0;
    const s = seams({
      mergePr: async () => { merges++; return { merged: true }; },
      writeRunLedger: (entry) => events.push({ event: entry.event, data: entry.data }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false }),
    });
    const result = await runSelfImplement({
      feature: 'zero executable signals preserve merge', autoMerge: true,
      goalFile: goal(['판정 신호: 조건 = human; 관측 = 실기기 화면을 본다; 기대 = observed']), seams: s,
    });

    expect(result.stage).toBe('merged');
    expect(merges).toBe(1);
    const decision = events.find(({ event }) => event === 'merge-decision');
    expect(decision?.data).toMatchObject({ decision: 'auto' });
    expect((decision?.data.decisionSignalPress as { pressedCount: number }).pressedCount).toBe(0);
  });
});

// ── 🩸 저자가 붙인 가드 — «과금 안전장치»를 무는 자가 «없었다» ──────────────
//   실물은 옳게 지어졌다(허용 목록 · 셸 없음 · argv). ⛔ 그런데 그 허용 목록을 «없애도» 초록이었다.
//   ⇒ 나중에 누가 그 목록을 넓히면 이 실행기가 «임의의 명령»을 친다.
//
// 🚨 이것이 왜 «과금» 문제인가 — 이 저장소의 실제 골 문면에서:
//     관측 = higgsfield generate create …   ⇐ 한 번에 7.5 크레딧
//     관측 = gh pr …                        ⇐ GitHub «상태를 바꾼다»
//   ⇒ 착지 검사가 크레딧을 태우고 상태를 바꾸면 «검사가 아니라 사고»다.
//
// 🔑 지키는 것은 「목록에 이 셋이 있다」가 «아니라» ***「목록 «밖»은 하나도 안 지나간다」***이다.

describe('허용 목록 — ⛔ 목록 «밖»은 하나도 안 지나간다', () => {
  const MUST_REJECT = [
    'higgsfield generate create kling3_0_turbo --prompt x',   // 💸 과금
    'gh pr merge 123 --squash',                                // 상태 변경
    'rm -rf /tmp/x',                                           // 파괴
    'curl https://example.com',                                // 네트워크
    'bun run build',                                           // bun 이지만 test 가 아니다
    'bun test',                                                // 인자 없는 전 스위트
    'rg foo bar',                                              // rg 이지만 -c 가 아니다
    'bun test a.ts && rm -rf .',                               // 셸 연결
    'bun test $(echo a.ts)',                                   // 명령 치환
    'bun test a.ts; echo x',                                   // 세미콜론
    'bun test a.ts | tee /tmp/x',                              // 파이프
    'bun test `whoami`.ts',                                    // 백틱
  ];

  for (const command of MUST_REJECT) {
    test(`⛔ 거절: ${command}`, () => {
      const parsed = parseSafeDecisionSignalCommand(command);
      expect(parsed).toBeDefined();
      expect(parsed).toHaveProperty('reason');
    });
  }

  test('✅ 허용되는 것은 «읽기 전용 셋»뿐이다', () => {
    expect(parseSafeDecisionSignalCommand('bun test test/x.test.ts')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('bun scripts/ask-marker-check.ts docs/goals/x.md')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('rg -c foo src/')).toBeDefined();
  });

  test('거절된 명령은 «안 침»으로 이름이 남는다 — 조용히 통과하지 않는다', () => {
    const out = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [{ signal: 's1', command: 'higgsfield generate create x', kind: 'real' }],
    }, process.cwd());
    expect(out.pressedCount).toBe(0);
    expect(out.unpressed.map((u) => u.reason)).toEqual(['unsafe-command']);
    expect(out.unpressed[0]?.signal).toBe('s1');   // ⛔ «어느» 신호인지 이름이 남는다
  });
});
