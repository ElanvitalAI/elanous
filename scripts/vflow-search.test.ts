import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'vflow-search.ts');
const fixture = join(here, 'fixtures', 'vflow-sample.ndjson');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, '--file', fixture, ...args], { encoding: 'utf8' });
}

describe('vflow 검색 CLI', () => {
  it('모델 접두·기법을 AND 로 검색하고 동점이면 프롬프트 길이로 정렬한다', () => {
    const result = run('--model', 'SeEdAnCe', '--technique', 'CRASH ZOOM', '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map((r: { url: string }) => r.url)).toEqual([
      'https://example.test/shot-b', 'https://example.test/shot-a',
    ]);
    expect(result.stderr).toContain('건너뛴 줄 1');
  });

  it('반복 기법은 모두 prompt 또는 keywords 안에 있어야 하고, category 는 정확히 일치한다', () => {
    const result = run('--technique', 'crash zoom', '--technique', 'macro', '--category', 'CAMERA', '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map((r: { url: string }) => r.url)).toEqual([
      'https://example.test/shot-d', 'https://example.test/shot-a',
    ]);
  });

  it('기법은 name·description 만으로는 일치하지 않는다', () => {
    const result = run('--technique', 'quiet');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('일치 0 · 읽은 줄 6');
  });

  it('위치 검색어 둘은 name·description·prompt·keywords 통틀어 AND 이고 JSON 귀속 칸을 보존한다', () => {
    const result = run('toy', 'MACRO', '--model', 'seedance', '--json');
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      url: 'https://example.test/shot-a', model: 'seedance-2-0', category: 'camera',
      name: 'Crash Zoom Macro', prompt: 'Crash zoom into a miniature car, then hold a macro detail on the painted door.',
      keywords: ['crash zoom', 'macro'], author: 'Aster', authorUrl: 'https://example.test/aster', video: null,
    });
  });

  it('사람 출력에는 이름·모델·URL·저작자·240자 이내 프롬프트가 나온다', () => {
    const result = run('--model', 'grok', '--limit', '1', 'whip pan');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Whip Pan · grok-imagine');
    expect(result.stdout).toContain('https://example.test/shot-e');
    expect(result.stdout).toContain('Eden');
    expect(result.stdout).toContain('Whip pan past the window');
    expect(result.stdout).not.toContain('ENDING_SENTINEL');
    expect(result.stdout.split('\n')[3]?.length).toBe(240);
  });

  it('0건은 읽은 줄을 밝히며 정상 종료한다', () => {
    const result = run('absent');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('일치 0 · 읽은 줄 6');
    expect(result.stderr).toContain('건너뛴 줄 1');
  });

  it('JSON 0건은 stdout 에 빈 배열만 내고 읽은 줄과 건너뛴 줄은 stderr 에 알린다', () => {
    const result = run('--json', 'absent');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[]');
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr.trim()).toBe('일치 0 · 읽은 줄 6\n건너뛴 줄 1');
  });

  it('유효한 JSON 이라도 필수 필드 구조가 틀리면 건너뛰고 나머지를 검색한다', () => {
    const dir = mkdtempSync(join(here, 'fixtures', '.vflow-search-'));
    const input = join(dir, 'prompts.ndjson');
    try {
      const lines = readFileSync(fixture, 'utf8').trimEnd().split('\n');
      const valid = JSON.parse(lines[0]!) as Record<string, unknown>;
      const malformed = [
        null, [],
        ...['url', 'model', 'category', 'name', 'description', 'prompt', 'keywords', 'author', 'authorUrl']
          .map((field) => { const row = { ...valid }; delete row[field]; return row; }),
        { ...valid, prompt: null },
        { ...valid, keywords: ['crash zoom', 42] },
        { ...valid, author: 42 },
        { ...valid, authorUrl: false },
      ];
      writeFileSync(input, [...malformed.map((row) => JSON.stringify(row)), ...lines].join('\n') + '\n');
      const result = run('--file', input, '--model', 'seedance', '--technique', 'crash zoom', '--json');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).map((row: { url: string }) => row.url)).toEqual([
        'https://example.test/shot-b', 'https://example.test/shot-a',
      ]);
      expect(result.stderr.trim()).toBe(`건너뛴 줄 ${malformed.length + 1}`);
    } finally {
      unlinkSync(input);
      rmdirSync(dir);
    }
  });

  it('임시 DB 의 spec 배열과 초 길이를 거르고 영상 링크를 두 출력에 보존한다', () => {
    const dir = mkdtempSync(join(here, 'fixtures', '.vflow-spec-'));
    const file = join(dir, 'prompts.ndjson');
    try {
      const base = JSON.parse(readFileSync(fixture, 'utf8').split('\n')[0]!) as Record<string, unknown>;
      const rows = [
        { ...base, url: 'https://example.test/tracking', spec: { camera: ['Slow Tracking'], lighting: ['Golden Hour'], mood: ['Cinematic'], duration: '6s' }, video: { url: 'https://example.test/video.mp4' } },
        { ...base, url: 'https://example.test/orbit', spec: { camera: ['orbit'], lighting: ['Neon'], mood: ['Tense'], duration: '12s' }, video: { url: 'https://example.test/orbit.mp4' } },
        base,
      ];
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
      const json = run('--file', file, '--camera', 'TRACKING', '--json');
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout).map((row: { url: string; video: { url: string } }) => [row.url, row.video.url])).toEqual([
        ['https://example.test/tracking', 'https://example.test/video.mp4'],
      ]);
      const text = run('--file', file, '--camera', 'tracking');
      expect(text.stdout).toContain('https://example.test/video.mp4');
      expect(JSON.parse(run('--file', file, '--lighting', 'golden', '--mood', 'cinema', '--max-seconds', '6', '--json').stdout)).toHaveLength(1);
      expect(JSON.parse(run('--file', file, '--max-seconds', '5', '--json').stdout)).toEqual([]);
      expect(JSON.parse(run('--file', file, '--json').stdout)).toHaveLength(3);
      expect(run('--max-seconds', 'oops').status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('없는 파일은 이름을 밝히고 실패한다', () => {
    const missing = join(here, 'fixtures', 'does-not-exist.ndjson');
    const result = run('--file', missing);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
  });

  it('limit 은 결과 수를 제한하고 잘못된 값은 거부한다', () => {
    expect(JSON.parse(run('--json', '--limit', '2').stdout)).toHaveLength(2);
    const result = run('--limit', '-1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--limit');
  });
});
