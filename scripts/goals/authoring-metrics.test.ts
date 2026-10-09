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
