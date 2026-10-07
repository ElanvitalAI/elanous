import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkTable, toSrt, toVoScript, type SceneTable } from './scene-table.js';

const base = (): SceneTable => ({
  durationSec: 20,
  subtitles: { maxCharsPerLine: 22, maxLines: 2 },
  vo: { maxWpm: 150 },
  measured: { N: { value: 111 } },
  scenes: [
    { n: 1, start: 0, end: 10, source: ['ae'], vo: null, ko: [] },
    { n: 2, start: 10, end: 20, source: ['live'], vo: 'Say it. It gets done.',
      ko: [{ start: 11, end: 19, lines: ['하룻밤에 {{N}}건이 착지했습니다.'] }] },
  ],
});

describe('scene-table check', () => {
  test('a clean table passes and the SRT carries the measured number', () => {
    const t = base();
    expect(checkTable(t)).toEqual([]);
    expect(toSrt(t)).toBe('1\n00:00:11,000 --> 00:00:19,000\n하룻밤에 111건이 착지했습니다.\n');
    expect(toVoScript(t)).toBe('[2] 00:10–00:20  Say it. It gets done.\n');
  });

  test('a missing measured value is a finding, not a silent placeholder', () => {
    const t = base();
    t.measured = {};
    expect(checkTable(t).some((p) => p.includes('{{N}}'))).toBe(true);
  });

  test('the storyboard draft shape (three lines · 24 chars) is caught', () => {
    const t = base();
    t.scenes[1]!.ko = [{ start: 11, end: 19, lines: ['그 뒤에서 루프 에이전트들이 일을 나눕니다.', '둘', '셋'] }];
    const p = checkTable(t);
    expect(p.some((x) => x.includes('3줄'))).toBe(true);
    expect(p.some((x) => x.includes('> 22'))).toBe(true);
  });

  test('gaps, cue spill and overlap are caught', () => {
    const t = base();
    t.scenes[1]!.start = 11;
    t.scenes[1]!.ko = [{ start: 9, end: 15, lines: ['가'] }, { start: 14, end: 21, lines: ['나'] }];
    const p = checkTable(t);
    expect(p.some((x) => x.includes('이어지지 않는다'))).toBe(true);
    expect(p.some((x) => x.includes('밖으로'))).toBe(true);
    expect(p.some((x) => x.includes('겹친다'))).toBe(true);
  });

  test('public wording: held mechanisms, competitors and promises are caught', () => {
    const t = base();
    t.scenes[1]!.vo = 'Codex sleeps. Coming soon.';
    const p = checkTable(t).join('\n');
    expect(p).toContain('경쟁사 이름');
    expect(p).toContain('특허 보류 기전');
    expect(p).toContain('미래 약속');
  });

  test('VO faster than the cap is caught', () => {
    const t = base();
    t.scenes[1]!.vo = Array.from({ length: 40 }, () => 'word').join(' ');
    expect(checkTable(t).some((x) => x.includes('wpm'))).toBe(true);
  });

  test('the DEMO-VIDEO-1008 table passes', () => {
    const file = join(import.meta.dir, '../../docs/marketing/demo-video-1008/scenes.json');
    const t = JSON.parse(readFileSync(file, 'utf8')) as SceneTable;
    expect(checkTable(t)).toEqual([]);
  });
});
