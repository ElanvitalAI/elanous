import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const SKILLS = ['omni-crawl', 'omni-digest'] as const;

function withStandaloneSkills(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'skills-lite-'));
  try {
    for (const skill of SKILLS) {
      cpSync(join(ROOT, 'skills', skill), join(root, 'skills', skill), {
        recursive: true,
        filter: path => !path.split('/').includes('node_modules') && !['.env', '.env.local'].includes(path.split('/').at(-1) ?? ''),
      });
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    return statSync(path).isDirectory() ? sources(path) : /\.ts$/.test(name) ? [path] : [];
  });
}

test('standalone skill TS, SKILL.md and package.json contain no tsx launcher or dependency', () => {
  for (const skill of SKILLS) {
    const dir = join(ROOT, 'skills', skill);
    for (const path of [...sources(dir), join(dir, 'SKILL.md'), join(dir, 'package.json'), join(dir, 'package-lock.json')]) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toContain('npx tsx');
      expect(text, path).not.toMatch(/"tsx"/);
    }
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).devDependencies?.tsx).toBeUndefined();
  }
});

test('both skill entrypoint shebangs launch bun', () => {
  for (const [skill, script] of [['omni-crawl', 'scripts/main.ts'], ['omni-crawl', 'scripts/monitor.ts'], ['omni-digest', 'scripts/main.ts']]) {
    expect(readFileSync(join(ROOT, 'skills', skill, script), 'utf8').split('\n')[0]).toBe('#!/usr/bin/env bun');
  }
});

test('outside repository, with no npx in PATH, crawl dry-run exits zero and writes JSON', () => {
  withStandaloneSkills(root => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'bun'));
    const result = spawnSync(join(bin, 'bun'), [join(root, 'skills/omni-crawl/scripts/main.ts'), 'query with "quotes"', '--dry-run'], {
      cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('쿼리:   query with "quotes"');
    const json = result.stdout.slice(result.stdout.indexOf('{'));
    expect(JSON.parse(json).engines).toBeArray();
    expect(result.stderr).toBe('');
  });
});

test('standalone crawl keeps positional query, --engine and --print markdown contract', () => {
  withStandaloneSkills(root => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'bun'));
    const result = spawnSync(join(bin, 'bun'), [join(root, 'skills/omni-crawl/scripts/main.ts'), 'query with "quotes"', '--engine', 'unknown', '--print'], {
      cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('---BEGIN_OMNI_CRAWL_MARKDOWN---');
    expect(result.stdout).toContain('---END_OMNI_CRAWL_MARKDOWN---');
  });
});

test('digest delegates to a sibling with the current bun and preserves quoted arguments', () => {
  withStandaloneSkills(root => {
    const sibling = join(root, 'skills/youtube-master');
    mkdirSync(join(sibling, 'scripts'), { recursive: true });
    writeFileSync(join(sibling, 'scripts/main.ts'), `console.log(JSON.stringify(process.argv.slice(2))); console.log('---BEGIN_YOUTUBE_MASTER_MARKDOWN---\\nYouTube ok\\n---END_YOUTUBE_MASTER_MARKDOWN---');`);
    const delegate = join(root, 'skills/omni-digest/src/delegate.ts');
    const url = 'https://youtube.com/watch?v=a&b=2';
    const message = 'quoted "value" with spaces';
    const result = spawnSync(process.execPath, ['-e', `import { delegateYouTube } from ${JSON.stringify(delegate)}; const r = delegateYouTube(${JSON.stringify(url)}, 'rich-cards', ['markdown'], ${JSON.stringify(message)}); console.log('ARGV', r.fullOutput.split('\\n')[0]); console.log('MARKDOWN', r.markdown);`], {
      cwd: root, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ARGV ${JSON.stringify([url, '--format', 'cards', '--target', 'markdown', '--print', '--message', message])}`);
    expect(result.stdout).toContain('MARKDOWN YouTube ok');
  });
});

test('digest calls sibling crawl using bun and keeps query as one argument', () => {
  withStandaloneSkills(root => {
    const query = 'sentence with "quotes" & spaces';
    const fetcher = join(root, 'skills/omni-digest/src/fetch.ts');
    const crawlScript = join(root, 'skills/omni-crawl/scripts/main.ts');
    writeFileSync(crawlScript, `console.log('---BEGIN_OMNI_CRAWL_MARKDOWN---\\n' + JSON.stringify(process.argv.slice(2)) + ' '.repeat(60) + '\\n---END_OMNI_CRAWL_MARKDOWN---');`);
    const result = spawnSync(process.execPath, ['-e', `import { enrichWithOmniCrawl } from ${JSON.stringify(fetcher)}; console.log('RESULT', enrichWithOmniCrawl(${JSON.stringify(query)}));`], {
      cwd: root, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`RESULT ${JSON.stringify([query, '--no-save', '--print'])}`);
  });
});

test('digest STT fallback launches sibling through bun without npx', () => {
  withStandaloneSkills(root => {
    const sibling = join(root, 'skills/youtube-master');
    mkdirSync(join(sibling, 'scripts'), { recursive: true });
    writeFileSync(join(sibling, 'scripts/transcribe-local.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], JSON.stringify(process.argv.slice(2)));`);
    const work = join(root, 'work');
    mkdirSync(work);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Fake ffmpeg only for segmenting a pre-existing audio file; no codec or network is needed.
    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'ffmpeg'), 0o755);
    const media = join(root, 'skills/omni-digest/src/media.ts');
    const result = spawnSync(process.execPath, ['-e', `import { transcribeViaYoutubeMaster } from ${JSON.stringify(media)}; console.log('TRANSCRIPT', await transcribeViaYoutubeMaster(${JSON.stringify(join(work, 'audio.mp3'))}, ${JSON.stringify(work)}));`], {
      cwd: root, env: { ...process.env, PATH: bin, YOUTUBE_MASTER_ROOT: sibling }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`TRANSCRIPT ${JSON.stringify([join(work, 'chunks'), join(work, 'transcript.txt')])}`);
  });
});

test('missing Apify is reported once even if the registry probes then runs it', () => {
  withStandaloneSkills(root => {
    const registry = join(root, 'skills/omni-crawl/src/registry.ts');
    const result = spawnSync(process.execPath, ['-e', `import { getEngine, runRegisteredEngine } from ${JSON.stringify(registry)}; console.log(getEngine('apify').available()); console.log(await runRegisteredEngine('apify', 'query', { limit: 1, depth: 'basic', minFavs: 0, maxItems: 1, lang: 'en' }));`], {
      cwd: root, env: { ...process.env, PATH: '', APIFY_TOKEN: '' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('Apify 없음 — X 트윗 벌크 수집 빠짐 · APIFY_TOKEN 설정하면 벌크 검색 켜짐');
    expect(result.stdout).toContain('false');
  });
});

test('missing Apify leaves crawl markdown available and says what is omitted', () => {
  withStandaloneSkills(root => {
    const result = spawnSync(process.execPath, [join(root, 'skills/omni-crawl/scripts/main.ts'), 'tweets', '--engine', 'apify', '--print'], {
      cwd: root, env: { ...process.env, APIFY_TOKEN: '', PATH: '' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('Apify 없음 — X 트윗 벌크 수집 빠짐 · APIFY_TOKEN 설정하면 벌크 검색 켜짐');
    expect(result.stdout).toContain('---BEGIN_OMNI_CRAWL_MARKDOWN---');
  });
});

test('an invalid Chrome override still searches installed Chrome candidates', () => {
  withStandaloneSkills(root => {
    const capture = join(root, 'skills/omni-crawl/src/capture.ts');
    const result = spawnSync(process.execPath, ['-e', `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      const existsSync = fs.existsSync;
      mock.module('node:fs', () => ({ ...fs, existsSync: (path) => path === '/usr/bin/google-chrome' || existsSync(path) }));
      const { chromeAvailable } = await import(${JSON.stringify(capture)});
      console.log('CHROME_AVAILABLE', chromeAvailable());
    `], {
      cwd: root, env: { ...process.env, OMNI_CRAWL_CHROME: join(root, 'no-chrome') }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('CHROME_AVAILABLE true');
  });
});

test('without Chrome, capture reports the missing local engine and still tries CDP fallback', () => {
  withStandaloneSkills(root => {
    const dir = join(root, 'captures');
    const capture = join(root, 'skills/omni-crawl/src/capture.ts');
    const result = spawnSync(process.execPath, ['-e', `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      const existsSync = fs.existsSync;
      mock.module('node:fs', () => ({ ...fs, existsSync: (path) =>
        ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
          '/usr/bin/chromium-browser'].includes(path) ? false : existsSync(path) }));
      const { captureScreenshot } = await import(${JSON.stringify(capture)});
      const calls = [];
      globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), method: opts?.method ?? 'GET' }); throw Error('CDP unavailable'); };
      const screenshot = await captureScreenshot('https://example.com', { allowPrivate: true });
      console.log('CDP_RESULT', JSON.stringify({ screenshot, calls }));
    `], {
      cwd: root, env: { ...process.env, PATH: '', OMNI_CRAWL_CHROME: join(root, 'no-chrome'), OMNI_CRAWL_CAPTURE_DIR: dir }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('Chrome 없음 — 로컬 스크린샷 빠짐 · 설치하면 headless 캡처 켜짐 (CDP 폴백은 계속)');
    const observed = JSON.parse(result.stdout.split('CDP_RESULT ')[1]);
    expect(observed.screenshot).toBeNull();
    expect(observed.calls).toEqual([
      { url: 'http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com', method: 'PUT' },
      { url: 'http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com', method: 'GET' },
    ]);
  });
});

test('without ffmpeg, actual digest entrypoint still summarizes text from a video post', () => {
  withStandaloneSkills(root => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const preload = join(root, 'offline-fetch.ts');
    writeFileSync(preload, `
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/2/tweets/search/recent')) return Response.json({ data: [] });
        if (String(url).includes('/2/tweets/')) return Response.json({
          data: { id: '123', author_id: 'author', conversation_id: '123', text: 'A new battery lasts 48 hours',
            public_metrics: { like_count: 10 } },
          includes: { users: [{ name: 'Author', username: 'author' }],
            media: [{ media_key: 'video1', type: 'video', variants: [{ content_type: 'video/mp4', url: 'https://example.com/video.mp4' }] }] },
        });
        if (url === 'https://api.x.ai/v1/responses') {
          const request = JSON.parse(opts.body);
          if (!JSON.stringify(request).includes('A new battery lasts 48 hours')) throw Error('Source text missing from summary request');
          return Response.json({ output: [{ content: [{ type: 'output_text', text: 'GENRE: Tech#Battery\\nKEYWORDS: battery\\n# Summary\\nThe new battery lasts 48 hours.' }] }] });
        }
        throw Error('Unexpected network request: ' + url);
      };
    `);
    const main = join(root, 'skills/omni-digest/scripts/main.ts');
    const result = spawnSync(process.execPath, ['--preload', preload, main, 'https://x.com/author/status/123', '--format', 'essential', '--no-obsidian', '--print'], {
      cwd: root, env: { ...process.env, PATH: bin, HOME: root, BEARER_TOKEN: 'offline', XAI_API_KEY: 'offline' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('ffmpeg 없음 — 영상 오디오 추출·전사 빠짐 · 설치하면 영상 전사 켜짐');
    expect(result.stdout).toContain('---BEGIN_OMNI_DIGEST_MARKDOWN---');
    expect(result.stdout).toContain('The new battery lasts 48 hours.');
    expect(result.stdout).toContain('---END_OMNI_DIGEST_MARKDOWN---');
  });
});

test('without ffmpeg, digest visual ingestion skips video frames without downloading', () => {
  withStandaloneSkills(root => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const visual = join(root, 'skills/omni-digest/src/visual.ts');
    const result = spawnSync(process.execPath, ['-e', `import { absorbTweetVisuals } from ${JSON.stringify(visual)}; console.log('VISUAL', await absorbTweetVisuals([{ type: 'video', bestMp4Url: 'https://example.com/media.mp4', mediaKey: 'test' }], { tweetId: 'test' }));`], {
      cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('ffmpeg 없음 — 영상 오디오 추출·전사 빠짐 · 설치하면 영상 전사 켜짐');
    expect(result.stdout.trim()).toBe('VISUAL null');
  });
});

test('without optional ffmpeg and whisper, the engine probe reports each once to stderr', () => {
  withStandaloneSkills(root => {
    const bin = join(root, 'bin');
    // Neither optional binary is visible to the engine probe.
    mkdirSync(bin);
    const media = join(root, 'skills/omni-digest/src/media.ts');
    const result = spawnSync(process.execPath, ['-e', `import { mediaEngineAvailable } from ${JSON.stringify(media)}; console.log(mediaEngineAvailable('ffmpeg'), mediaEngineAvailable('whisper'), mediaEngineAvailable('ffmpeg'));`], {
      cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim().split('\n')).toEqual([
      'ffmpeg 없음 — 영상 오디오 추출·전사 빠짐 · 설치하면 영상 전사 켜짐',
      'whisper 없음 — 로컬 음성 전사 빠짐 · 설치하면 오프라인 전사 켜짐 (youtube-master 폴백은 계속)',
    ]);
    expect(result.stdout.trim()).toBe('false false false');
  });
});
