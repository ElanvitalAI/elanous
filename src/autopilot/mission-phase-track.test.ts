import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inferPhaseTrack, loadTrackRegistry } from './mission-phase-track.js';

const watcherPath = resolve(import.meta.dir, '../../scripts/coord-channel-watch.sh');
const registry = loadTrackRegistry();

describe('mission phase track', () => {
  test.each([
    ['PWA 라이브 시그널 탭을 만든다', 'UX', '🅕'],
    ['HyperFrames 티저 영상', 'MK', '🅣'],
    ['블로그 1편 원고', 'MK', '🅣'],
    ['릴리스 게이트 하니스 원장', 'TC', '🅞'],
    ['판올림 컷 체크리스트', 'OP', '🅢'],
  ])('%s → %s', (text, track, mark) => {
    expect(inferPhaseTrack(text, registry)).toMatchObject({ track, mark, reason: 'keyword' });
  });

  test('title and prompt both count, case-insensitively', () => {
    const result = inferPhaseTrack('PWA 제목\npwa 웹', registry);
    expect(result).toMatchObject({ track: 'UX', reason: 'keyword' });
    expect(result.hits.UX).toBe(3);
  });

  test('English keywords match whole words, not substrings of build', () => {
    const result = inferPhaseTrack('build build 렌더', registry);
    expect(result).toMatchObject({ track: 'MK', mark: '🅣', reason: 'keyword' });
    expect(result.hits).toMatchObject({ UX: 0, MK: 1 });
  });

  test('punctuated English ownership keywords still match case-insensitively', () => {
    expect(inferPhaseTrack('B-ROLL', registry)).toMatchObject({ track: 'MK', reason: 'keyword' });
    expect(inferPhaseTrack('ELANOUS.AI', registry)).toMatchObject({ track: 'UX', reason: 'keyword' });
    expect(inferPhaseTrack('UI', registry)).toMatchObject({ track: 'UX', reason: 'keyword' });
  });

  test('equal top counts leave the track undecided', () => {
    expect(inferPhaseTrack('로드맵 티저', registry)).toMatchObject({ track: null, mark: null, reason: 'tie' });
  });

  test('no owned word leaves the track undecided', () => {
    expect(inferPhaseTrack('전혀 다른 작업', registry)).toMatchObject({ track: null, mark: null, reason: 'none' });
  });

  test('loads four owning tracks and the non-owning courier identity; missing registry is fail-soft', () => {
    expect(registry.map((entry) => entry.id)).toEqual(['OP', 'MK', 'TC', 'UX', 'E']);
    expect(registry.filter((entry) => entry.owns.length > 0).map((entry) => entry.id)).toEqual(['OP', 'MK', 'TC', 'UX']);
    expect(registry.find((entry) => entry.id === 'E')).toMatchObject({ mark: '🅔', owns: [] });
    expect(inferPhaseTrack('페이즈 배달', registry).track).not.toBe('E');
    expect(loadTrackRegistry(resolve(import.meta.dir, 'absent-coord-tracks.json'))).toEqual([]);
  });

  test('coord-channel-watch.sh actual mark extraction reads every mark by 2-letter id and by old alias', () => {
    const watcher = readFileSync(watcherPath, 'utf8').split('\n');
    const lines = ['ENTRY=$(jq ', 'MARK=$(printf ', 'SELF_ID=$(printf ', 'SELF_ALIAS=$(printf '].map((p) => watcher.find((line) => line.startsWith(p)));
    expect(lines.every(Boolean)).toBe(true);
    const cases: Array<[string, string, string, string]> = [
      ['OP', '🅢', 'OP', 'S'], ['S', '🅢', 'OP', 'S'], ['TC', '🅞', 'TC', 'O'], ['O', '🅞', 'TC', 'O'],
      ['MK', '🅣', 'MK', 'T'], ['F', '🅕', 'UX', 'F'], ['E', '🅔', 'E', 'E'],
    ];
    for (const [track, mark, id, alias] of cases) {
      const result = Bun.spawnSync(['bash', '-c', `${lines.join('\n')}\nprintf '%s|%s|%s' "$MARK" "$SELF_ID" "$SELF_ALIAS"`, watcherPath], {
        env: { ...process.env, TRACK: track },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(`${mark}|${id}|${alias}`);
    }
  });
});
