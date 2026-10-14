import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { buildUserConfig, resetUserConfig, setUserConfigOverlay } from '../user-config.js';
import { addItem, listChecklist, setItem } from './checklist.js';
import { DEFAULT_PROJECT_AXES, parseRubric, readRubricItems, resolveRubricAxes, rubricGrade, rubricPriority, rubricScore, rubricScoreV2, rubricScoreWith, rubricV2FWeight } from './rubric.js';
import type { RubricV2 } from './rubric.js';

const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  setUserConfigOverlay(null);
  resetUserConfig();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const first = '루브릭: A1 E2 R1 D3 M3 B2 S1 X1 (17)';
const second = '루브릭: A3 E3 R2 D2 M2 B1 S2 X1';

const v2 = (values: Partial<RubricV2> = {}): RubricV2 =>
  ({ L: 0, U: 0, F: 0, O: 0, R: 0, T: 0, M: 0, Z: 1, X: 0, ...values });

test('제목·근거의 축 순서와 옛 괄호 점수를 구분하고 식 그대로 채점한다', () => {
  const r = parseRubric(first);
  expect(r).toEqual({ A: 1, E: 2, R: 1, D: 3, M: 3, B: 2, S: 1, X: 1 });
  expect(rubricScore(r!)).toBe(16.5);
  expect(rubricGrade(rubricScore(r!))).toBe('P1');
  expect(rubricScore(parseRubric(second)!)).toBe(20.5);
  expect(parseRubric('기능 (루브릭: A0 E0 R0 D0 M0 B0 S0 X0)')).toBeNull();
  expect(parseRubric('루브릭: X1 S1 B2 M3 D3 R1 E2 A1 (17)')).toEqual(r);
  expect(parseRubric('제목 루브릭: A1 E2 R1 D3 M3 B2 S1')).toBeNull();
  expect(parseRubric('A1 E2 R1 D3 M3 B2 S1 X1')).toBeNull();
  expect(parseRubric('루브릭: A4 E2 R1 D3 M3 B2 S1 X1')).toBeNull();
});

test('프로젝트 축 공식과 내부 팩 8축 점수를 보존한다', () => {
  expect(DEFAULT_PROJECT_AXES).toEqual([
    { key: 'V', weight: 2 }, { key: 'U', weight: 2 },
    { key: 'R', weight: 2 }, { key: 'S', weight: -0.5 },
  ]);
  expect(rubricScoreWith(DEFAULT_PROJECT_AXES, { V: 3, U: 2, R: 1, S: 2 })).toBe(11);
  expect(rubricScore({ A: 3, E: 2, R: 2, D: 3, M: 3, B: 2, S: 3, X: 1 })).toBe(21.5);
});

test('설정 축은 기본 축을 바꾸거나 더하고, 내부 팩의 축은 격리하며 해석을 기록한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-axes-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  setUserConfigOverlay((cfg) => ({ ...cfg, projects: { p1: { rubric: { axes: [
    { key: 'V', weight: 3 }, { key: '고객', weight: 1 },
  ] } }, elanous: { rubric: { axes: [{ key: 'Y', weight: 99 }] } } } }));
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  try {
    const axes = resolveRubricAxes('p1');
    expect(axes).toEqual([
      { key: 'V', weight: 3 }, { key: 'U', weight: 2 },
      { key: 'R', weight: 2 }, { key: 'S', weight: -0.5 },
      { key: '고객', weight: 1 },
    ]);
    expect(rubricScoreWith(axes, { V: 3, U: 2, R: 1, S: 2, 고객: 4 })).toBe(18);
    const internal = resolveRubricAxes(undefined);
    expect(resolveRubricAxes('other')).toEqual(internal);
    expect(internal).toHaveLength(8);
    expect(resolveRubricAxes('elanous')).toEqual(internal);
    expect(internal.map(({ key }) => key)).toEqual(['A', 'E', 'R', 'D', 'M', 'B', 'S', 'X']);
    expect(events).toContainEqual({ category: 'release.rubric', event: 'axes', data: { project: 'p1', keys: ['V', 'U', 'R', 'S', '고객'] } });
    expect(events).toContainEqual({ category: 'release.rubric', event: 'axes', data: { project: 'elanous', keys: ['A', 'E', 'R', 'D', 'M', 'B', 'S', 'X'] } });
    expect(events).toContainEqual({ category: 'release.rubric', event: 'axes', data: { project: null, keys: ['A', 'E', 'R', 'D', 'M', 'B', 'S', 'X'] } });
  } finally { log.mockRestore(); }
});

test('프로젝트 설정이 없으면 다른 프로젝트 식별자도 내부 8축을 쓴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-unconfigured-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  setUserConfigOverlay((cfg) => ({ ...cfg, projects: {} }));
  expect(resolveRubricAxes('p1')).toEqual(resolveRubricAxes(undefined));
  setUserConfigOverlay((cfg) => ({ ...cfg, projects: { p1: { rubric: { axes: [{ key: '고객', weight: 1 }] } } } }));
  const axes = resolveRubricAxes('p1');
  expect(axes).toEqual([...DEFAULT_PROJECT_AXES, { key: '고객', weight: 1 }]);
  expect(rubricScoreWith(axes, { V: 3, U: 2, R: 1, S: 2, 고객: 4 })).toBe(15);
});

test('잘못된 프로젝트 축은 설정 적재를 막지 않고 축 해석에서 설정 오류 문면으로 멈춘다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-invalid-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ projects: { p1: { rubric: { axes: [{ key: '고객', weight: 'x' }] } } } }));
  // Load the file through the real parser, then serve it via the overlay (the gate may pin a config path by env).
  const loaded = buildUserConfig(path);
  setUserConfigOverlay((cfg) => ({ ...cfg, projects: loaded.projects }));
  expect(() => resolveRubricAxes('p1')).toThrow('[user-config] projects.p1.rubric.axes[0].weight 는 유한한 숫자여야 합니다: x');
  expect(resolveRubricAxes(undefined)).toHaveLength(8);
  expect(() => rubricScoreWith(DEFAULT_PROJECT_AXES, { V: 3, U: 2, R: 1 })).toThrow('루브릭 축 S 값이 없다');
  expect(() => rubricScoreWith([{ key: 'toString', weight: 1 }], { V: 3 })).toThrow('루브릭 축 toString 값이 없다');
  expect(resolveRubricAxes('toString')).toHaveLength(8);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => rubricScoreWith(DEFAULT_PROJECT_AXES, { V: 3, U: 2, R: 1, S: bad })).toThrow('루브릭 축 S 값이 없다');
    expect(() => rubricScoreWith([{ key: 'V', weight: bad }], { V: 3 })).toThrow('루브릭 축 V 가중이 유한수가 아니다');
  }
});

test('rule-only priority uses the numeric rubric and defaults to P2 without a complete line', () => {
  expect(rubricPriority(first)).toBe('P1');
  expect(rubricPriority('루브릭: A0 E0 R0 D0 M0 B0 S0 X0')).toBe('P4');
  expect(rubricPriority('본문에는 점수가 없다')).toBe('P2');
});

test('등급 경계는 포함 여부까지 정확하다', () => {
  for (const [score, grade] of [[11, 'P1'], [10.5, 'P2'], [8, 'P2'], [7.5, 'P3'], [5, 'P3'], [4.5, 'P4']] as const) {
    expect(rubricGrade(score)).toBe(grade);
  }
});

test('루브릭 v2 가중은 L·U 2, F w, O·R·T 1.5, M 1 을 식 그대로 더한다', () => {
  const day = '2026-10-28';
  expect(rubricScoreV2(v2(), day)).toBe(0);
  expect(rubricScoreV2(v2({ L: 3 }), day)).toBe(6);
  expect(rubricScoreV2(v2({ U: 3 }), day)).toBe(6);
  expect(rubricScoreV2(v2({ F: 3 }), day)).toBe(6);
  expect(rubricScoreV2(v2({ O: 3 }), day)).toBe(4.5);
  expect(rubricScoreV2(v2({ R: 3 }), day)).toBe(4.5);
  expect(rubricScoreV2(v2({ T: 3 }), day)).toBe(4.5);
  expect(rubricScoreV2(v2({ M: 3 }), day)).toBe(3);
  expect(rubricScoreV2(v2({ L: 2, U: 1 }), day)).toBe(6);
  expect(rubricScoreV2(v2({ O: 2, T: 1 }), day)).toBe(4.5);
  expect(rubricScoreV2(v2({ L: 1.5 }), day)).toBe(3);
  expect(rubricScoreV2(v2({ L: 3, U: 3, F: 3, O: 3, R: 3, T: 3, M: 3 }), day)).toBe(34.5);
});

test('Z 나눗셈은 같은 V 를 크기 1·2·4·8 로 나눈다', () => {
  const values = { L: 2, U: 1, F: 3, O: 2, R: 0, T: 1, M: 3 }; // w=2 치의 V = 19.5
  expect(rubricScoreV2(v2({ ...values, Z: 1 }), '2026-10-28')).toBe(19.5);
  expect(rubricScoreV2(v2({ ...values, Z: 2 }), '2026-10-28')).toBe(9.75);
  expect(rubricScoreV2(v2({ ...values, Z: 4 }), '2026-10-28')).toBe(4.875);
  expect(rubricScoreV2(v2({ ...values, Z: 8 }), '2026-10-28')).toBe(2.4375);
});

test('X 차감은 위험 하나에 0.5 씩 뺀다', () => {
  const values = { L: 2, U: 1, F: 3, O: 2, R: 0, T: 1, M: 3, Z: 2 }; // X 를 빼기 전 9.75
  expect(rubricScoreV2(v2({ ...values, X: 0 }), '2026-10-28')).toBe(9.75);
  expect(rubricScoreV2(v2({ ...values, X: 1 }), '2026-10-28')).toBe(9.25);
  expect(rubricScoreV2(v2({ ...values, X: 2 }), '2026-10-28')).toBe(8.75);
  expect(rubricScoreV2(v2({ ...values, X: 3 }), '2026-10-28')).toBe(8.25);
});

test('F 가중은 2026-10-28 당일까지 2, 2026-10-29 부터 1 로 바뀐다', () => {
  expect(rubricV2FWeight('2026-10-27')).toBe(2);
  expect(rubricV2FWeight('2026-10-28')).toBe(2);
  expect(rubricV2FWeight('2026-10-28T23:59:59.999Z')).toBe(2);
  expect(rubricV2FWeight('2026-10-29T00:00:00.000Z')).toBe(1);
  expect(rubricV2FWeight('2026-10-29')).toBe(1);
  expect(rubricV2FWeight('2026-10-30')).toBe(1);
  expect(rubricV2FWeight('2025-12-31')).toBe(2);
  expect(rubricV2FWeight('2027-01-01')).toBe(1);
  expect(rubricV2FWeight('+010000-01-01T00:00:00.000Z')).toBe(1);
  expect(rubricV2FWeight('+010000-01-01')).toBe(1);
  expect(rubricV2FWeight('10000-01-01')).toBe(1);
  expect(rubricScoreV2(v2({ F: 3 }), '10000-01-01')).toBe(3);
  expect(rubricV2FWeight('2024-02-29')).toBe(2);
  expect(rubricScoreV2(v2({ F: 3 }), '2026-10-28')).toBe(6);
  expect(rubricScoreV2(v2({ F: 3 }), '2026-10-29')).toBe(3);
});

test('잘못된 축·크기·위험·날짜는 명시적으로 거부한다', () => {
  const day = '2026-10-28';
  expect(() => rubricScoreV2(null as unknown as RubricV2, day)).toThrow('루브릭 v2 값이 축 객체가 아니다');
  expect(() => rubricScoreV2([v2()] as unknown as RubricV2, day)).toThrow('루브릭 v2 값이 축 객체가 아니다');
  expect(() => rubricScoreV2({ ...v2({ F: 3 }), A: 2 } as RubricV2, day)).toThrow('루브릭 v2 알 수 없는 축: A');
  expect(() => rubricScoreV2({ U: 0, F: 0, O: 0, R: 0, T: 0, M: 0, Z: 1, X: 0 } as RubricV2, day)).toThrow('루브릭 v2 축 L 값이 없다');
  expect(() => rubricScoreV2(v2({ L: Number.NaN }), day)).toThrow('루브릭 v2 축 L 값이 없다');
  expect(() => rubricScoreV2(v2({ L: '2' as unknown as number }), day)).toThrow('루브릭 v2 축 L 값이 없다');
  expect(() => rubricScoreV2(v2({ L: 4 }), day)).toThrow('루브릭 v2 축 L 값이 0~3 밖이다: 4');
  expect(() => rubricScoreV2(v2({ L: -1 }), day)).toThrow('루브릭 v2 축 L 값이 0~3 밖이다: -1');
  expect(() => rubricScoreV2(v2({ O: 3.5 }), day)).toThrow('루브릭 v2 축 O 값이 0~3 밖이다: 3.5');
  expect(() => rubricScoreV2(v2({ Z: 3 }), day)).toThrow('루브릭 v2 크기 Z 값이 1·2·4·8 밖이다: 3');
  expect(() => rubricScoreV2(v2({ Z: 0 }), day)).toThrow('루브릭 v2 크기 Z 값이 1·2·4·8 밖이다: 0');
  expect(() => rubricScoreV2(v2({ X: 4 }), day)).toThrow('루브릭 v2 위험 X 값이 0~3 밖이다: 4');
  expect(() => rubricScoreV2(v2({ X: -0.5 }), day)).toThrow('루브릭 v2 위험 X 값이 0~3 밖이다: -0.5');
  expect(() => rubricScoreV2(v2({ L: 3 }), 'not-a-date')).toThrow('루브릭 v2 기준 날짜가 잘못되었다: not-a-date');
  for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-00-01', '2026-01-00', '2026-02-30T00:00:00Z']) {
    expect(() => rubricV2FWeight(bad)).toThrow(`루브릭 v2 기준 날짜가 잘못되었다: ${bad}`);
  }
  expect(() => rubricScoreV2(v2({ F: 3 }), '2026-02-30')).toThrow('루브릭 v2 기준 날짜가 잘못되었다: 2026-02-30');
  expect(() => rubricV2FWeight(new Date('2026-02-30') as unknown as string)).toThrow('루브릭 v2 기준 날짜가 잘못되었다:');
  expect(() => rubricScoreV2(v2({ F: 3 }), new Date('2026-02-30') as unknown as string)).toThrow('루브릭 v2 기준 날짜가 잘못되었다:');
  expect(() => rubricScoreV2(v2({ L: 3 }), new Date(Number.NaN) as unknown as string)).toThrow('루브릭 v2 기준 날짜가 잘못되었다: Invalid Date');
});

test('v1 표면은 v2 추가에 그대로 — v2 줄은 v1 루브릭으로 해석하지 않는다', () => {
  const v2line = '루브릭v2: L3 U3 F3 O3 R3 T3 M3 Z2 X1';
  expect(parseRubric(v2line)).toBeNull();
  expect(parseRubric(`제목 루브릭: A1 E2 R1 D3 M3 B2 S1 X1\n${v2line}`)).toEqual({ A: 1, E: 2, R: 1, D: 3, M: 3, B: 2, S: 1, X: 1 });
  expect(rubricScore({ A: 3, E: 2, R: 2, D: 3, M: 3, B: 2, S: 3, X: 1 })).toBe(21.5);
  expect(rubricGrade(12)).toBe('P1');
  expect(rubricPriority(v2line)).toBe('P2');
  expect(rubricPriority('본문에는 점수가 없다')).toBe('P2');
});

test('rubric 명령은 정렬된 표와 JSON을 출력하고 기존 원장 행을 쓰지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-read-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  addItem('9.9.9', { id: 'LOW', title: `작은 칸 ${first}`, priority: 'P2' });
  addItem('9.9.9', { id: 'HIGH', title: '큰 칸', priority: 'P1' });
  setItem('9.9.9', 'HIGH', { evidence: second }, 'MK');
  addItem('9.9.9', { id: 'NONE', title: '루브릭 없음' });
  const before = listChecklist('9.9.9');
  const dbPath = join(dir, 'release', 'features.sqlite');
  const bytes = readFileSync(dbPath);
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const out: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => { out.push(chunk); callback?.(); return true; }) as typeof process.stdout.write);
  try {
    const run = async (args: string[]) => {
      const program = new Command();
      registerReleaseCommands(program);
      await program.parseAsync(['node', 'elanous', 'release', 'checklist', 'rubric', ...args]);
    };
    await run(['--version', '9.9.9']);
    expect(lines).toEqual([
      'id · 점수 · 등급 · 현재 우선순위',
      'HIGH · 20.5 · P1 · P1',
      'LOW · 16.5 · P1 · P2',
      '루브릭 없는 칸 1',
    ]);
    await run(['--version', '9.9.9', '--json']);
    expect(out.map((line) => JSON.parse(line))).toEqual([{
      version: '9.9.9', rows: [
        { id: 'HIGH', score: 20.5, grade: 'P1', priority: 'P1' },
        { id: 'LOW', score: 16.5, grade: 'P1', priority: 'P2' },
      ], missing: 1,
    }]);
    expect(readRubricItems('9.9.9', dir)).toHaveLength(3);
    expect(listChecklist('9.9.9')).toEqual(before);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(existsSync(join(dir, 'release', '9.9.9', 'checklist.json'))).toBe(false);
    lines.length = 0;
    out.length = 0;
    const parentVersion = new Command();
    registerReleaseCommands(parentVersion);
    await parentVersion.parseAsync(['node', 'elanous', 'release', 'checklist', '--version', '9.9.9', 'rubric', '--json']);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: '9.9.9', missing: 1 });
  } finally { log.mockRestore(); write.mockRestore(); }
});

test('JSON 전용 판도 원장을 만들지 않고 제목·근거를 조회한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-legacy-'));
  dirs.push(dir);
  const path = join(dir, 'release', '9.9.9');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'checklist.json'), JSON.stringify({ version: '9.9.9', items: [
    { id: 'OLD', title: first, evidence: second, priority: 'P2' },
  ] }));
  expect(readRubricItems('9.9.9', dir)).toMatchObject([{ id: 'OLD', title: first, evidence: second, priority: 'P2' }]);
  expect(existsSync(join(dir, 'release', 'features.sqlite'))).toBe(false);
});

test('없는 판 조회는 원장 파일·디렉터리를 만들지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-empty-'));
  dirs.push(dir);
  expect(readRubricItems('9.9.9', dir)).toEqual([]);
  expect(existsSync(join(dir, 'release'))).toBe(false);
});
