import { describe, expect, test } from 'bun:test';
import { program, runEntrancesAction } from '../index.js';
import {
  CLI_ENTRANCE_BASELINE,
  compareCommandEntranceBaseline,
  evaluateCommandEntranceBaseline,
} from './entrance-baseline.js';
import { collectCommandEntrances } from './entrance-inventory.js';
import { ENTRANCE_REGISTRY } from './entrance-registry.js';

const injectedEntrance = (...path: string[]) => ({
  path,
  name: path.at(-1) ?? '',
  description: '',
  aliases: [],
  options: [],
});

describe('compareCommandEntranceBaseline', () => {
  test('reports a missing baseline path by its identifier', () => {
    const result = compareCommandEntranceBaseline(['self vanished'], [{ path: ['self'] }]);

    expect(result.missing).toEqual(['self vanished']);
    expect(result.added).toEqual(['self']);
  });

  test('passes an equal baseline and assembled entrance set', () => {
    const entrances = collectCommandEntrances(program);

    expect(compareCommandEntranceBaseline(
      entrances.map((entrance) => entrance.path.join(' ')),
      entrances,
    )).toEqual({ missing: [], added: [] });
  });

  test('reports added entrances without treating them as missing regressions', () => {
    const result = compareCommandEntranceBaseline(
      ['self'],
      [{ path: ['self'] }, { path: ['self', 'new-command'] }],
    );

    expect(result.missing).toEqual([]);
    expect(result.added).toEqual(['self new-command']);
  });

  test('matches the current assembled CLI including the TOX tasks command', () => {
    const entrances = collectCommandEntrances(program);
    const result = compareCommandEntranceBaseline(CLI_ENTRANCE_BASELINE, entrances);

    // 판정은 «선언한 입구가 사라졌나»(missing → exit 1)다. 새로 늘어난 명령(added)까지 0 을 요구하면 명령을 더할 때마다 깨진다(오늘의 목록을 박은 자).
    expect(result.missing).toEqual([]);
    expect(entrances.find(entrance => entrance.path.join(' ') === 'tasks')?.aliases).toContain('task');
    expect(CLI_ENTRANCE_BASELINE).toContain('tasks list');
    expect(CLI_ENTRANCE_BASELINE).not.toContain('task');
  });

  test('derives nonzero exit status from missing paths rather than a fixed result', () => {
    expect(evaluateCommandEntranceBaseline(['self vanished'], [{ path: ['self'] }])).toEqual({
      missing: ['self vanished'],
      added: ['self'],
      exitCode: 1,
    });
  });
});

describe('runEntrancesAction', () => {
  test('reports dynamically derived mixed baseline differences in JSON and human output', () => {
    const actualEntrances = [injectedEntrance('self'), injectedEntrance('self', 'actual-only')];
    const baseline = ['self', 'missing-only'];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const expected = evaluateCommandEntranceBaseline(baseline, actualEntrances);

    const evaluation = runEntrancesAction({ json: true }, {
      baseline,
      actualEntrances,
      writeOutput: (line) => output.push(line),
      writeError: (line) => errors.push(line),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });
    const structured = JSON.parse(output[0]);
    const humanOutput: string[] = [];

    runEntrancesAction({}, {
      baseline,
      actualEntrances,
      writeOutput: (line) => humanOutput.push(line),
      writeError: () => {},
      setExitCode: () => {},
    });

    expect(evaluation).toEqual(expected);
    expect(structured.comparison).toEqual({
      missingCount: expected.missing.length,
      addedCount: expected.added.length,
      missing: expected.missing,
      added: expected.added,
    });
    expect(structured.launchEntrances.declarations).toHaveLength(ENTRANCE_REGISTRY.length);
    expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'nl-self-implement'))
      .toMatchObject({ status: 'live', modelExposed: true });
    expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'nl-self-orchestrate'))
      .toMatchObject({ status: 'retired', modelExposed: false });
    // ⛔ 검증 «값»을 얼리지 않는다 — 그 값은 실물 검증이 진행되면 «바뀌라고» 있는 칸이다
    //    (실제로 actualMission 이 unknown→verified 로 바뀌면서 이 줄이 빨개졌다).
    //    ⇒ 무는 것은 「레지스트리에 적힌 그 값이 구조화 산출까지 «흐르는가»」다.
    const planDeclared = ENTRANCE_REGISTRY.find((entrance) => entrance.id === 'cli-harness-plan');
    expect(planDeclared?.verification).toBeDefined();
    expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-harness-plan'))
      .toMatchObject({ status: 'live', verification: planDeclared?.verification, imprintEvidence: 'CLI_HARNESS_PLAN_ENTRANCE' });
    // OLD-DOOR-CLOSE: the outside `dev --ask` door is closed; the registry status flows through as declared.
    expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-dev-ask'))
      .toMatchObject({ status: ENTRANCE_REGISTRY.find((entrance) => entrance.id === 'cli-dev-ask')?.status });
    expect(ENTRANCE_REGISTRY.find((entrance) => entrance.id === 'cli-dev-ask')?.status).toBe('closed');
    expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-dev-ask').modelExposed)
      .toBeUndefined();
    expect(humanOutput[0]).toContain(
      `baseline comparison completed: missing ${expected.missing.length}, added ${expected.added.length}`,
    );
    expect(humanOutput[0]).toContain('missing: missing-only');
    expect(humanOutput[0]).toContain('added: self actual-only');
    expect(humanOutput[0]).toContain('🪦 nl      nl-self-orchestrate (unknown)');
    expect(humanOutput[0]).toContain(
      `cli-harness-plan (stampable) verification=actualMission:${planDeclared?.verification?.actualMission},legacyParity:${planDeclared?.verification?.legacyParity}`,
    );
    expect(errors).toEqual([`missing CLI entrances from baseline: missing: ${expected.missing.join(', ')}`]);
    expect(exitCodes).toEqual([1]);
  });

  test('reports a completed zero-difference comparison and succeeds', () => {
    const actualEntrances = [injectedEntrance('self')];
    const baseline = actualEntrances.map((entrance) => entrance.path.join(' '));
    const output: string[] = [];
    const exitCodes: number[] = [];

    const evaluation = runEntrancesAction({ json: true }, {
      baseline,
      actualEntrances,
      writeOutput: (line) => output.push(line),
      writeError: () => {},
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });
    const structured = JSON.parse(output[0]);
    const humanOutput: string[] = [];

    runEntrancesAction({}, {
      baseline,
      actualEntrances,
      writeOutput: (line) => humanOutput.push(line),
      writeError: () => {},
      setExitCode: () => {},
    });

    expect(evaluation).toMatchObject({ missing: [], added: [], exitCode: 0 });
    expect(structured.comparison).toEqual({ missingCount: 0, addedCount: 0, missing: [], added: [] });
    expect(humanOutput[0]).toContain('baseline comparison completed: missing 0, added 0');
    expect(humanOutput[0]).toContain('missing: (empty)');
    expect(humanOutput[0]).toContain('added: (empty)');
    expect(exitCodes).toEqual([0]);
  });

  test('reports added-only differences while preserving a successful exit', () => {
    const actualEntrances = [injectedEntrance('self'), injectedEntrance('self', 'actual-only')];
    const baseline = ['self'];
    const output: string[] = [];
    const exitCodes: number[] = [];

    const evaluation = runEntrancesAction({}, {
      baseline,
      actualEntrances,
      writeOutput: (line) => output.push(line),
      writeError: () => {},
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    expect(evaluation).toMatchObject({ missing: [], added: ['self actual-only'], exitCode: 0 });
    expect(output[0]).toContain(`baseline comparison completed: missing ${evaluation.missing.length}, added ${evaluation.added.length}`);
    expect(output[0]).toContain('missing: (empty)');
    expect(output[0]).toContain('added: self actual-only');
    expect(exitCodes).toEqual([0]);
  });

  test('discloses truncation and total count for long human drift lists', () => {
    const actualEntrances = [
      injectedEntrance('self'),
      injectedEntrance('self', 'extra-1'),
      injectedEntrance('self', 'extra-2'),
      injectedEntrance('self', 'extra-3'),
      injectedEntrance('self', 'extra-4'),
      injectedEntrance('self', 'extra-5'),
      injectedEntrance('self', 'extra-6'),
    ];
    const output: string[] = [];

    runEntrancesAction({}, {
      baseline: ['self'],
      actualEntrances,
      writeOutput: (line) => output.push(line),
      writeError: () => {},
      setExitCode: () => {},
    });

    const driftLines = output[0].split('\n').slice(-3).join('\n');
    expect(driftLines).toContain('added: self extra-1, self extra-2, self extra-3, self extra-4, self extra-5 (showing 5 of 6; truncated 1)');
    expect(driftLines).not.toContain('self extra-6');
  });

  test('applies the same truncation policy to long missing stdout and stderr drift lists', () => {
    const actualEntrances = [injectedEntrance('self')];
    const baseline = [
      'self',
      'self missing-1',
      'self missing-2',
      'self missing-3',
      'self missing-4',
      'self missing-5',
      'self missing-6',
    ];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];

    runEntrancesAction({}, {
      baseline,
      actualEntrances,
      writeOutput: (line) => output.push(line),
      writeError: (line) => errors.push(line),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    const expectedMissing = 'missing: self missing-1, self missing-2, self missing-3, self missing-4, self missing-5 (showing 5 of 6; truncated 1)';
    const driftLines = output[0].split('\n').slice(-3).join('\n');
    expect(driftLines).toContain(expectedMissing);
    expect(driftLines).not.toContain('self missing-6');
    expect(errors).toEqual([`missing CLI entrances from baseline: ${expectedMissing}`]);
    expect(errors[0]).not.toContain('self missing-6');
    expect(exitCodes).toEqual([1]);
  });

  test('reports an injected missing path and fails the action path', () => {
    const entrances = collectCommandEntrances(program);
    const errors: string[] = [];
    const exitCodes: number[] = [];

    const evaluation = runEntrancesAction({}, {
      baseline: [...entrances.map((entrance) => entrance.path.join(' ')), 'self vanished'],
      actualEntrances: entrances,
      writeOutput: () => {},
      writeError: (line) => errors.push(line),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    expect(evaluation.missing).toEqual(['self vanished']);
    expect(evaluation.exitCode).toBe(1);
    expect(errors).toEqual(['missing CLI entrances from baseline: missing: self vanished']);
    expect(exitCodes).toEqual([1]);
  });
});
