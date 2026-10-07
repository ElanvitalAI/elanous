import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist, setItem } from './checklist.js';
import { parseRubric, readRubricItems, rubricGrade, rubricScore } from './rubric.js';

const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const first = '루브릭: A1 E2 R1 D3 M3 B2 S1 X1 (17)';
const second = '루브릭: A3 E3 R2 D2 M2 B1 S2 X1';

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

test('등급 경계는 포함 여부까지 정확하다', () => {
  for (const [score, grade] of [[11, 'P1'], [10.5, 'P2'], [8, 'P2'], [7.5, 'P3'], [5, 'P3'], [4.5, 'P4']] as const) {
    expect(rubricGrade(score)).toBe(grade);
  }
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
