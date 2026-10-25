import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectAskMarkers } from '../ask-marker-check.js';
import { measureAuthoring, median } from './authoring-metrics.js';

const root = resolve(import.meta.dir, '../..');
const temp = mkdtempSync(join(tmpdir(), 'authoring-metrics-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const ledger = resolve(root, 'scripts/__fixtures__/authoring-paths-10x3.json');

describe('authoring metrics', () => {
  test('ASCII length and heading count', () => {
    expect(measureAuthoring('a.md', '# T\n## A\nx\n')).toMatchObject({
      path: 'a.md', chars: 11, bytes: 11, sections: 2,
    });
  });

  test('chars count string length while bytes count UTF-8', () => {
    expect(measureAuthoring('k.md', '가\n')).toMatchObject({
      path: 'k.md', chars: 2, bytes: 4, sections: 0,
    });
    expect(measureAuthoring('emoji.md', '😀')).toMatchObject({
      path: 'emoji.md', chars: 2, bytes: 4, sections: 0,
    });
  });

  test('median is numeric and empty input stays unknown', () => {
    expect(median([11, 2, 5])).toBe(5);
    expect(median([4, 2])).toBe(3);
    expect(median([])).toBeNull();
  });

  test('marker failures use the existing inspector verdict', () => {
    const text = '# T\n';
    const axes = inspectAskMarkers(text);
    const result = measureAuthoring('a.md', text);
    expect(result.markerAxes).toBe(axes.length);
    expect(result.markerFailed).toBe(axes.filter((axis) => !(axis.marker && axis.extracted)).length);
    expect(result.markerAxes).toBe(9);
    expect(result.markerFailed).toBe(4);
  });

  test('CLI prints a readable table and distinguishes an empty input', () => {
    const present = join(temp, 'table.md');
    writeFileSync(present, '# T\n');
    const table = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', present], {
      cwd: root, encoding: 'utf8',
    });
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('path\tchars\tbytes\tsections\tmarkerAxes\tmarkerFailed\terror');
    expect(table.stdout).toContain(`${present}\t4\t4\t1\t9\t4`);
    expect(table.stdout).toContain('files\t1\tmedianChars\t4\tmedianBytes\t4');

    const empty = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--json'], {
      cwd: root, encoding: 'utf8',
    });
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ files: 0, medianChars: null, medianBytes: null });
  }, 60_000);

  test('CLI measures all valid UTF-8 bytes including a leading BOM', () => {
    const present = join(temp, 'bom.md');
    writeFileSync(present, Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x54, 0x0a]));
    const result = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--json', present], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ path: present, chars: 5, bytes: 7, sections: 0 });
    expect(lines.at(-1)).toEqual({ files: 1, medianChars: 5, medianBytes: 7 });
  }, 60_000);

  test('CLI rejects invalid UTF-8 instead of reporting re-encoded bytes', () => {
    const invalid = join(temp, 'invalid.md');
    const present = join(temp, 'valid.md');
    writeFileSync(invalid, Buffer.from([0xff, 0x0a]));
    writeFileSync(present, '가\n');
    const result = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--json', present, invalid], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ path: invalid, error: 'unreadable' });
    expect(lines).toContainEqual(expect.objectContaining({ path: present, chars: 2, bytes: 4 }));
    expect(lines.at(-1)).toEqual({ files: 1, medianChars: 2, medianBytes: 4 });
  }, 60_000);

  test('CLI keeps unreadable row and fails without dropping readable row', () => {
    const present = join(temp, 'present.md');
    const missing = join(temp, 'missing.md');
    writeFileSync(present, '# T\n');
    const result = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--json', present, missing], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ path: missing, error: 'unreadable' });
    expect(lines).toContainEqual(expect.objectContaining({ path: present, chars: 4, bytes: 4 }));
    expect(lines.at(-1)).toEqual({ files: 1, medianChars: 4, medianBytes: 4 });
  }, 60_000);
});

describe('authoring paths ledger', () => {
  // base 에는 --records 모드가 없다. 그래서 이 블록은 전부 생산 진입점(CLI 자식 프로세스)을
  // 지나 종료 코드·표·stderr 의 행동 차이로 base 와 head 를 구분한다. 신규 export
  // (buildResultTable 등)를 정적 import 하면 base 에서 모듈 로드 에러만 나고 gate 가
  // RED 목격을 집계하지 못하므로(라운드 1 교훈) 여기서는 단위 import 를 쓰지 않는다.
  test('CLI prints the committed 10x3 fixture table with summary and deletion candidates', () => {
    // Gate isolation sets the legacy ignored config env for diagnostics. Keep
    // state-dir isolation, but remove that ignored alias from this subprocess
    // so the CLI's warning does not masquerade as command stderr output.
    const env = { ...process.env };
    delete env.ELANOUS_CONFIG_DIR;
    const run = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', ledger], {
      cwd: root, encoding: 'utf8', env,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.trimEnd().split('\n')).toEqual([
      'task\ttext\telaboration\timplementation',
      'TASK-01\t100.0%/4.0\t100.0%/2.0\t100.0%/1.0',
      'TASK-02\t100.0%/3.0\t100.0%/3.0\t100.0%/2.0',
      'TASK-03\t0.0%/5.0\t100.0%/2.0\t100.0%/1.0',
      'TASK-04\t0.0%/6.0\t100.0%/1.0\t100.0%/1.0',
      'TASK-05\t0.0%/4.0\t100.0%/3.0\t100.0%/2.0',
      'TASK-06\t0.0%/5.0\t100.0%/2.0\t100.0%/1.0',
      'TASK-07\t0.0%/3.0\t0.0%/3.0\t100.0%/2.0',
      'TASK-08\t0.0%/4.0\t0.0%/2.0\t100.0%/1.0',
      'TASK-09\t0.0%/5.0\t0.0%/3.0\t100.0%/1.0',
      'TASK-10\t0.0%/4.0\t0.0%/2.0\t100.0%/2.0',
      'summary\t20.0%/4.3\t60.0%/2.3\t100.0%/1.4',
      'step\twith.landing\twithout.landing\twith.rounds\twithout.rounds\tsamples',
      'compose-complication\t20.0%\t80.0%\t4.3\t1.9\t10/20',
      'marker-self-check\t40.0%\t100.0%\t3.3\t1.4\t20/10',
    ]);
  }, 60_000);

  test('CLI --json prints the fixture grounding rates rounds and candidates', () => {
    const run = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', ledger, '--json'], {
      cwd: root, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const document = JSON.parse(run.stdout) as {
      columns: string[];
      rows: {
        task: string;
        cells: { path: string; landed: number; total: number; groundingRate: number; rounds: number }[];
      }[];
      summary: { path: string; landed: number; total: number; groundingRate: number; rounds: number }[];
      candidates: {
        step: string;
        withSamples: number;
        withoutSamples: number;
        withGroundingRate: number;
        withoutGroundingRate: number;
        withRounds: number;
        withoutRounds: number;
      }[];
    };
    expect(document.columns).toEqual(['text', 'elaboration', 'implementation']);
    expect(document.rows.map((row) => row.task)).toEqual(
      Array.from({ length: 10 }, (_, index) => `TASK-${String(index + 1).padStart(2, '0')}`),
    );
    expect(document.rows[0]!.cells.map((cell) => [cell.landed, cell.total, cell.groundingRate, cell.rounds]))
      .toEqual([[1, 1, 1, 4], [1, 1, 1, 2], [1, 1, 1, 1]]);
    expect(document.summary.map((cell) => [cell.path, cell.landed, cell.total])).toEqual([
      ['text', 2, 10],
      ['elaboration', 6, 10],
      ['implementation', 10, 10],
    ]);
    expect(document.summary.map((cell) => cell.groundingRate)).toEqual([0.2, 0.6, 1]);
    expect(document.summary.map((cell) => cell.rounds)).toEqual([4.3, 2.3, 1.4]);
    expect(document.candidates.map((candidate) => candidate.step)).toEqual([
      'compose-complication',
      'marker-self-check',
    ]);
    expect(document.candidates[0]).toMatchObject({
      withSamples: 10,
      withoutSamples: 20,
      withGroundingRate: 0.2,
      withoutGroundingRate: 0.8,
      withRounds: 4.3,
      withoutRounds: 1.85,
    });
  }, 60_000);

  test('CLI orders deletion candidates by wasted rounds and skips steps without a control group', () => {
    const contrast = join(temp, 'contrast-ledger.json');
    writeFileSync(contrast, JSON.stringify([
      { task: 'T1', path: 'text', landed: false, rounds: 6, procedureSteps: ['dead-slow', 'always-step'] },
      { task: 'T2', path: 'text', landed: false, rounds: 4, procedureSteps: ['dead-slow', 'always-step'] },
      { task: 'T3', path: 'text', landed: true, rounds: 1, procedureSteps: ['always-step', 'quick-win'] },
      { task: 'T4', path: 'text', landed: true, rounds: 1, procedureSteps: ['always-step', 'quick-win'] },
    ]));
    const run = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', contrast], {
      cwd: root, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('task\ttext');
    expect(lines[5]).toBe('summary\t50.0%/3.0');
    expect(lines[6]).toBe('step\twith.landing\twithout.landing\twith.rounds\twithout.rounds\tsamples');
    expect(lines[7]).toBe('dead-slow\t0.0%\t100.0%\t5.0\t1.0\t2/2');
    expect(lines).toHaveLength(8);
    expect(run.stdout).not.toContain('always-step');
    expect(run.stdout).not.toContain('quick-win');
  }, 60_000);

  test('CLI accepts a JSON Lines ledger aggregates repeated cells and names the bad record', () => {
    const good = join(temp, 'ledger.jsonl');
    writeFileSync(good, [
      '{"task":"T1","path":"text","landed":true,"rounds":1,"procedureSteps":[]}',
      '{"task":"T1","path":"text","landed":false,"rounds":5,"procedureSteps":[]}',
      '{"task":"T2","path":"implementation","landed":false,"rounds":3,"procedureSteps":["focused-test"]}',
    ].join('\n'));
    const okRun = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', good], {
      cwd: root, encoding: 'utf8',
    });
    expect(okRun.status).toBe(0);
    expect(okRun.stdout.split('\n')[0]).toBe('task\ttext\timplementation');
    expect(okRun.stdout).toContain('T1\t50.0%/3.0\t—');
    expect(okRun.stdout).toContain('T2\t—\t0.0%/3.0');

    const bad = join(temp, 'bad.jsonl');
    writeFileSync(bad, [
      '{"task":"T1","path":"text","landed":true,"rounds":1}',
      '{"task":"T2","path":"text","landed":"yes","rounds":2}',
    ].join('\n'));
    const badRun = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', bad], {
      cwd: root, encoding: 'utf8',
    });
    expect(badRun.status).toBe(1);
    expect(badRun.stderr).toContain('record 2: landed must be a boolean');
  }, 60_000);

  test('CLI rejects a missing ledger file and a missing --records value', () => {
    const missing = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', join(temp, 'absent.json')], {
      cwd: root, encoding: 'utf8',
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('authoring-metrics: unreadable records ledger:');

    const bare = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records'], {
      cwd: root, encoding: 'utf8',
    });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('authoring-metrics: --records needs a ledger path');
  }, 60_000);

  test('CLI rejects invalid UTF-8 in a records ledger instead of reporting re-encoded bytes', () => {
    const bad = join(temp, 'bad-records.json');
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x41]));
    const run = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', bad], {
      cwd: root, encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('authoring-metrics:');
  }, 60_000);

  test('CLI prints an empty table with candidates none for an empty ledger', () => {
    const empty = join(temp, 'empty-ledger.json');
    writeFileSync(empty, '[]\n');
    const run = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--records', empty], {
      cwd: root, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(3);
    expect(run.stdout).toContain('candidates\tnone');
  }, 60_000);

  test('records mode leaves the positional measurement contract untouched', () => {
    const legacy = spawnSync('bun', ['scripts/goals/authoring-metrics.ts', '--json'], {
      cwd: root, encoding: 'utf8',
    });
    expect(legacy.status).toBe(0);
    expect(JSON.parse(legacy.stdout)).toEqual({ files: 0, medianChars: null, medianBytes: null });
  }, 60_000);
});
