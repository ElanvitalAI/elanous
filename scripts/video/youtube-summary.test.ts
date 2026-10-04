import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runYoutubeSummary } from './youtube-summary.js';
import type { YoutubeTranscriptResult } from '../../src/skills/tools/youtube-transcript.js';

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const fakeTranscript = (text: string): YoutubeTranscriptResult => ({
  output: text, text, segments: [], provider: text ? 'supadata' : 'none',
  videoId: 'dQw4w9WgXcQ', truncated: false, durationSec: null,
});

test('fake captions and judge yield one local markdown artifact with verdict, 5-7 points and N cards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    let prompt = '';
    const result = await runYoutubeSummary(url, root, {
      transcript: async () => fakeTranscript('The video discusses evidence and examples.'),
      binary: () => { throw new Error('captioned videos must not use STT'); },
      call: async ({ prompt: request }) => {
        prompt = request;
        return { text: JSON.stringify({ verdict: 'Evidence matters.', keyPoints: ['one', 'two', 'three', 'four', 'five', 'six'], cards: ['Q: Why? A: Evidence.', 'Q: How? A: Examples.'] }) };
      },
    });
    expect(prompt).toContain('The video discusses evidence and examples.');
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('expected artifact');
    expect(result.path).toBe(join(root, 'youtube-summary', 'dQw4w9WgXcQ.md'));
    const markdown = readFileSync(result.path, 'utf8');
    expect(markdown).toContain('## One-line verdict\nEvidence matters.');
    expect(markdown.match(/^- /gm)).toHaveLength(6);
    expect(markdown.match(/^### Card /gm)).toHaveLength(2);
    expect(readdirSync(join(root, 'youtube-summary'))).toEqual(['dQw4w9WgXcQ.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fake captions and judge produce all four study-note sections in one local artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    let prompt = '';
    const result = await runYoutubeSummary(url, root, {
      format: 'study-note',
      transcript: async () => fakeTranscript('Evidence precedes interpretation.'),
      binary: () => { throw new Error('captioned videos must not use STT'); },
      call: async ({ prompt: request }) => {
        prompt = request;
        return { text: JSON.stringify({
          concepts: ['Evidence supports a claim.'],
          terms: [{ term: 'Evidence', definition: 'Support for a claim.' }],
          steps: ['Read the evidence.', 'Check the claim.'],
          questions: ['What is evidence?', 'How do you check a claim?', 'Why read first?'],
        }) };
      },
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('expected study note artifact');
    expect(prompt).toContain('Evidence precedes interpretation.');
    expect(prompt).toContain('study note');
    expect(result.path).toBe(join(root, 'youtube-summary', 'dQw4w9WgXcQ.md'));
    const markdown = readFileSync(result.path, 'utf8');
    expect(markdown).toContain('## 개념 정리\n- Evidence supports a claim.');
    expect(markdown).toContain('## 용어 표\n| 용어 | 뜻 |\n| --- | --- |\n| Evidence | Support for a claim. |');
    expect(markdown).toContain('## 단계별 설명\n1. Read the evidence.\n2. Check the claim.');
    expect(markdown).toContain('## 스스로 확인 문제\n1. What is evidence?\n2. How do you check a claim?\n3. Why read first?');
    expect(readdirSync(join(root, 'youtube-summary'))).toEqual(['dQw4w9WgXcQ.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit summary and omitted format produce identical markdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    const deps = {
      transcript: async () => fakeTranscript('Evidence and examples.'),
      call: async () => ({ text: JSON.stringify({ verdict: 'Evidence matters.', keyPoints: ['one', 'two', 'three', 'four', 'five'], cards: ['Q: Why? A: Evidence.'] }) }),
    };
    const omitted = await runYoutubeSummary(url, root, deps);
    if (omitted.outcome !== 'ok') throw new Error('expected summary artifact');
    const original = readFileSync(omitted.path, 'utf8');
    const explicit = await runYoutubeSummary(url, root, { ...deps, format: 'summary' });
    expect(explicit).toEqual(omitted);
    if (explicit.outcome !== 'ok') throw new Error('expected summary artifact');
    expect(readFileSync(explicit.path, 'utf8')).toBe(original);
    expect(original).toContain('## One-line verdict\nEvidence matters.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown format is rejected before fetching captions or writing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    await expect(runYoutubeSummary(url, root, {
      format: 'other',
      transcript: async () => { throw new Error('transcript must not run'); },
      call: async () => { throw new Error('judge must not run'); },
    })).rejects.toThrow('input.format must be summary or study-note');
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('judge rejects malformed study notes without writing an artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    await expect(runYoutubeSummary(url, root, {
      format: 'study-note',
      transcript: async () => fakeTranscript('Evidence and examples.'),
      call: async () => ({ text: JSON.stringify({ concepts: ['Evidence'], terms: [{ term: 'Evidence', definition: 'Support' }], steps: ['Read'], questions: ['Only one?'] }) }),
    })).rejects.toThrow('YouTube study-note judge failed: schema');
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('judge rejects embedded markdown items and headings instead of writing misleading counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    for (const [field, payload] of [
      ['keyPoints', 'one\n- injected point'],
      ['keyPoints', 'one\r- injected point'],
      ['keyPoints', '# Injected heading'],
      ['cards', 'Q: Why?\n### Card 2\nA: Injected.'],
      ['cards', '- Injected list item'],
    ] as const) {
      const summary = { verdict: 'Evidence matters.', keyPoints: ['one', 'two', 'three', 'four', 'five'], cards: ['Q: Why? A: Evidence.'] };
      if (field === 'keyPoints') summary.keyPoints[0] = payload;
      else summary.cards[0] = payload;
      await expect(runYoutubeSummary(url, root, {
        transcript: async () => fakeTranscript('Evidence and examples.'),
        call: async () => ({ text: JSON.stringify(summary) }),
      })).rejects.toThrow('YouTube summary judge failed: schema');
      expect(readdirSync(root)).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('judge rejects cards without a question and answer instead of writing a study note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    for (const card of ['fact', 'Q: Why?', 'A: Evidence.', 'Q: Why? A: ', 'Q: A statement. A: Evidence.']) {
      await expect(runYoutubeSummary(url, root, {
        transcript: async () => fakeTranscript('Evidence and examples.'),
        call: async () => ({ text: JSON.stringify({
          verdict: 'Evidence matters.',
          keyPoints: ['one', 'two', 'three', 'four', 'five'],
          cards: ['Q: How? A: Examples.', card],
        }) }),
      })).rejects.toThrow('YouTube summary judge failed: schema');
      expect(readdirSync(root)).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no captions use real audio download, split and STT orchestration before summarizing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  const previousEngine = process.env.YOUTUBE_SUMMARY2_STT;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  const argsFile = join(root, 'yt-dlp.args');
  const ffmpegArgs = join(root, 'ffmpeg.args');
  let temporaryDir = '';
  let uploads = 0;
  try {
    mkdirSync(bin);
    const ytDlp = join(bin, 'yt-dlp');
    writeFileSync(ytDlp, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nfor arg in "$@"; do\n  case "$arg" in\n    *audio.\\%\\(ext\\)s) file="$arg" ;;\n  esac\ndone\nprintf 'fake audio' > "$(dirname "$file")/audio.mp3"\n`);
    chmodSync(ytDlp, 0o755);
    const ffmpeg = join(bin, 'ffmpeg');
    writeFileSync(ffmpeg, `#!/bin/sh\nprintf '%s\\n' "$@" > '${ffmpegArgs}'\nfor arg in "$@"; do output="$arg"; done\nprintf 'fake chunk' > "$(dirname "$output")/chunk_000.mp3"\n`);
    chmodSync(ffmpeg, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.YOUTUBE_SUMMARY2_STT = 'openai';
    process.env.OPENAI_API_KEY = 'fake-test-key';
    globalThis.fetch = (async (input, init) => {
      uploads++;
      expect(input).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ Authorization: 'Bearer fake-test-key' });
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
      expect(form.get('language')).toBe('ko');
      const file = form.get('file') as File;
      expect(file.name).toBe('chunk_000.mp3');
      expect(await file.text()).toBe('fake chunk');
      const splitOutput = readFileSync(ffmpegArgs, 'utf8').trim().split('\n').at(-1)!;
      temporaryDir = dirname(dirname(splitOutput));
      return new Response('Spoken content, not captions.');
    }) as typeof fetch;
    const result = await runYoutubeSummary(url, root, {
      transcript: async () => fakeTranscript(''),
      call: async ({ prompt }) => {
        expect(prompt).toContain('Transcript for dQw4w9WgXcQ:\nSpoken content, not captions.');
        return { text: JSON.stringify({ verdict: 'Spoken content.', keyPoints: ['one', 'two', 'three', 'four', 'five'], cards: ['Q: What? A: Spoken content.'] }) };
      },
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('expected STT summary artifact');
    expect(readFileSync(result.path, 'utf8')).toContain('## One-line verdict\nSpoken content.');
    expect(uploads).toBe(1);
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args).toContain('-x');
    expect(args).toContain('--audio-format');
    expect(args).toContain('mp3');
    expect(args).toContain(url);
    expect(args).toContain('bestaudio[protocol^=http]/bestaudio/best');
    const splitArgs = readFileSync(ffmpegArgs, 'utf8').trim().split('\n');
    expect(splitArgs).toContain('-segment_time');
    expect(splitArgs).toContain('1500');
    expect(splitArgs.at(-1)).toMatch(/\/chunks\/chunk_%03d\.mp3$/);
    expect(existsSync(temporaryDir)).toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, previous] of [['PATH', previousPath], ['YOUTUBE_SUMMARY2_STT', previousEngine], ['OPENAI_API_KEY', previousKey]] as const) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing yt-dlp or ffmpeg reports stt-unavailable without invoking audio or summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    for (const missing of ['yt-dlp', 'ffmpeg']) {
      const checked: string[] = [];
      const result = await runYoutubeSummary(url, root, {
        transcript: async () => fakeTranscript(''),
        binary: name => {
          checked.push(name);
          if (name === missing) throw new Error(`missing ${name}`);
          return name;
        },
        download: async () => { throw new Error('download must not run'); },
        stt: async () => { throw new Error('stt must not run'); },
        call: async () => { throw new Error('judge must not run'); },
      });
      expect(result).toEqual({ outcome: 'no-transcript', videoId: 'dQw4w9WgXcQ', reason: 'stt-unavailable' });
      expect(checked).toEqual(missing === 'yt-dlp' ? ['yt-dlp'] : ['yt-dlp', 'ffmpeg']);
      expect(readdirSync(root)).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('temporary audio is removed even when STT fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  let temporaryDir = '';
  try {
    await expect(runYoutubeSummary(url, root, {
      transcript: async () => fakeTranscript(''),
      binary: name => name,
      download: async (_source, dir) => {
        temporaryDir = dir;
        writeFileSync(join(dir, 'audio.mp3'), 'fake audio');
        return join(dir, 'audio.mp3');
      },
      split: async audio => [audio],
      stt: async () => { throw new Error('STT failed'); },
      call: async () => { throw new Error('judge must not run'); },
    })).rejects.toThrow('STT failed');
    expect(existsSync(temporaryDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unextractable video id stops before fetching captions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'youtube-summary-'));
  try {
    const result = await runYoutubeSummary('https://www.youtube.com/watch?v=bad', root, {
      transcript: async () => { throw new Error('transcript must not run'); },
      call: async () => { throw new Error('judge must not run'); },
    });
    expect(result).toEqual({ outcome: 'invalid-video-id' });
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
