import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROLL, brollAlignWords, brollDensityPlan, brollSelectClips, brollRender, brollQc } from './broll.js';
import type { RecipeCtx } from './types.js';
import { run, type RunResult } from './ffmpeg.js';

let root: string, clipsDir: string, video: string;
const ctx = (state: Record<string, unknown>, log: RecipeCtx['log'] = () => {}): RecipeCtx => ({ workdir: join(root, 'work'), state, log });
const ok = (out = ''): RunResult => ({ ok: true, code: 0, signal: null, out, err: '' });
const words = [
  { word: 'opening', start: 0, end: 5 },
  { word: 'middle', start: 5, end: 10 },
  { word: 'closing', start: 10, end: 15 },
];
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'broll-'))); // macOS: /var → /private/var
  clipsDir = join(root, 'clips'); mkdirSync(clipsDir);
  video = join(clipsDir, 'shot.mp4'); writeFileSync(video, 'asset');
  writeFileSync(join(root, 'base.mp4'), 'base');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('BROLL alignment and density', () => {
  it('uses supplied aligned words, preserving their timestamps without running an aligner', async () => {
    const run = () => { throw new Error('unexpected external run'); };
    const result = await brollAlignWords(ctx({ aligned_words: words, broll_run: run }));
    expect(result.outcome).toBe('ok');
    expect(result.produced?.aligned_words).toEqual(words);
    expect(result.produced?.narration_seconds).toBe(15);
    expect((await brollAlignWords(ctx({ aligned_words: [{ word: 'overlap', start: 0, end: 2 }, { word: 'next', start: 1, end: 3 }] }))).outcome).toBe('unmeasurable');
  });
  it('reads the Whisper JSON file rather than stdout, and rejects missing or malformed timestamps', async () => {
    const audio = join(root, 'speech.wav'); writeFileSync(audio, 'audio');
    const output = join(root, 'work', 'broll-alignment', 'speech.json');
    const calls: { bin: string; args: readonly string[] }[] = [];
    const align = (segments: unknown, stdout: string) => (bin: string, args: readonly string[]): RunResult => {
      calls.push({ bin, args });
      expect(args.slice(-2)).toEqual(['--output_dir', join(root, 'work', 'broll-alignment')]);
      writeFileSync(output, JSON.stringify(segments));
      return ok(stdout);
    };
    const result = await brollAlignWords(ctx({ audio_path: audio, broll_run: align({ segments: [{ words }] }, 'Detected language: English') }));
    expect(result.outcome).toBe('ok');
    expect(result.produced?.aligned_words).toEqual(words);
    expect(JSON.parse(readFileSync(output, 'utf8')).segments[0].words).toEqual(words);
    expect(calls[0]?.bin).toBe('whisper');
    expect(calls[0]?.args).toContain('--word_timestamps');
    expect(calls[0]?.args).toContain('json');
    const segmented = { segments: [{ words: words.slice(0, 2) }, { words: words.slice(2) }] };
    const parsed = await brollAlignWords(ctx({ audio_path: audio, broll_run: align(segmented, '') }));
    expect(parsed.produced?.aligned_words).toEqual(words);
    const zeroDuration = await brollAlignWords(ctx({ audio_path: audio, broll_run: align({ segments: [{ words: [
      { word: ' Hello', start: 0, end: 0.5 }, { word: ' this', start: 0.5, end: 0.5 }, { word: ' works', start: 0.5, end: 1 },
    ] }] }, 'human-readable stdout') }));
    expect(zeroDuration.outcome).toBe('ok');
    expect(zeroDuration.produced?.aligned_words).toEqual([{ word: ' Hello', start: 0, end: 0.5 }, { word: ' works', start: 0.5, end: 1 }]);
    expect((await brollAlignWords(ctx({ audio_path: audio, broll_run: () => ok(JSON.stringify(words)) }))).outcome).toBe('unmeasurable');
    const escaped = join(root, 'escaped-alignment.json'); writeFileSync(escaped, JSON.stringify({ segments: [{ words }] }));
    symlinkSync(escaped, output);
    expect((await brollAlignWords(ctx({ audio_path: audio, broll_run: () => { throw new Error('should not run'); } }))).outcome).toBe('error');
    rmSync(output);
    symlinkSync(join(root, 'missing-alignment.json'), output);
    expect((await brollAlignWords(ctx({ audio_path: audio, broll_run: () => { throw new Error('should not run'); } }))).outcome).toBe('unmeasurable');
    rmSync(output);
    const unsafeWorkdir = join(root, 'unsafe-align-work'); mkdirSync(unsafeWorkdir);
    symlinkSync(clipsDir, join(unsafeWorkdir, 'broll-alignment'));
    expect((await brollAlignWords({ ...ctx({ audio_path: audio, broll_run: () => { throw new Error('should not run'); } }), workdir: unsafeWorkdir })).outcome).toBe('error');
    expect((await brollAlignWords(ctx({ aligned_words: [{ word: 'x', start: 2, end: 1 }] }))).outcome).toBe('unmeasurable');
    expect((await brollAlignWords(ctx({}))).outcome).toBe('unmeasurable');
  });
  it('executes a Whisper-compatible CLI, inspects its JSON artifact and stdout, then aligns via the default runner', async () => {
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
    const whisper = join(bin, 'whisper');
    writeFileSync(whisper, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[args.indexOf('--output_format') + 1] !== 'json' || args[args.indexOf('--word_timestamps') + 1] !== 'True') process.exit(2);
const output = path.join(args[args.indexOf('--output_dir') + 1], path.parse(args[0]).name + '.json');
fs.writeFileSync(output, JSON.stringify({segments:[{words:[{word:'spoken',start:0,end:1}]}]}));
process.stdout.write('Detected language: English\\n');
`);
    chmodSync(whisper, 0o755);
    const audio = join(root, 'real-cli-audio.wav'); writeFileSync(audio, 'audio');
    const prior = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${prior ?? ''}`;
      mkdirSync(join(root, 'direct'));
      const executed = spawnSync('whisper', [audio, '--output_format', 'json', '--word_timestamps', 'True', '--output_dir', join(root, 'direct')], { encoding: 'utf8' });
      expect(executed.status).toBe(0);
      expect(executed.stdout).toBe('Detected language: English\n');
      expect(JSON.parse(readFileSync(join(root, 'direct', 'real-cli-audio.json'), 'utf8')).segments[0].words[0].word).toBe('spoken');
      expect(existsSync(join(root, 'direct', 'real-cli-audio.json'))).toBe(true);
      const result = await brollAlignWords(ctx({ audio_path: audio }));
      expect(result.outcome).toBe('ok');
      expect(result.produced?.aligned_words).toEqual([{ word: 'spoken', start: 0, end: 1 }]);
      expect(JSON.parse(readFileSync(join(root, 'work', 'broll-alignment', 'real-cli-audio.json'), 'utf8')).segments[0].words[0].word).toBe('spoken');
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
  });
  it('uses the actual Whisper CLI and its word JSON to align spoken audio when opted in', async () => {
    if (process.env.BROLL_REAL_WHISPER !== '1') return;
    const model = process.env.BROLL_WHISPER_MODEL ?? 'tiny.en';
    const source = join(root, 'spoken.wav');
    const generated = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'flite=text=Hello world this is a spoken sample for word alignment:voice=slt', '-ar', '16000', '-ac', '1', source], 30_000);
    expect(generated.ok).toBe(true);
    const previous = process.env.PATH;
    try {
      if (process.env.BROLL_WHISPER_BIN) process.env.PATH = `${process.env.BROLL_WHISPER_BIN}:${previous ?? ''}`;
      const invocations: RunResult[] = [];
      const aligned = await brollAlignWords(ctx({ audio_path: source, broll_run: (bin: string, args: readonly string[], timeoutMs: number) => {
        const r = run(bin, [args[0]!, '--model', model, '--language', 'English', ...args.slice(1)], timeoutMs);
        invocations.push(r);
        return r;
      } }));
      const output = join(root, 'work', 'broll-alignment', 'spoken.json');
      expect(invocations[0]?.ok).toBe(true);
      expect(invocations[0]?.out).not.toContain('"segments"');
      expect(invocations[0]?.out).toContain('Hello world');
      const saved = JSON.parse(readFileSync(output, 'utf8'));
      expect(saved.segments.flatMap((segment: { words?: unknown[] }) => segment.words ?? []).length).toBeGreaterThan(0);
      expect(aligned.outcome).toBe('ok');
      expect((aligned.produced?.aligned_words as unknown[]).length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
  it('uses density in clips/min and word boundaries; zero/invalid density cannot pass', async () => {
    const result = await brollDensityPlan(ctx({ aligned_words: words, density_target: 8 }));
    expect(result.outcome).toBe('ok');
    expect(result.produced?.target_clips).toBe(2);
    expect(result.produced?.broll_slots).toEqual([
      { start: 0, end: 10, prompt: 'opening middle' },
      { start: 10, end: 15, prompt: 'closing' },
    ]);
    expect((await brollDensityPlan(ctx({ aligned_words: words, density_target: 0 }))).outcome).toBe('unmeasurable');
  });
  it('rounds up achievable density and explicitly rejects targets without enough word boundaries', async () => {
    const tenSeconds = [{ word: 'first', start: 0, end: 5 }, { word: 'second', start: 5, end: 10 }];
    const achievable = await brollDensityPlan(ctx({ aligned_words: tenSeconds, density_target: 8 }));
    expect(achievable.outcome).toBe('ok');
    expect(achievable.produced?.target_clips).toBe(2);
    expect(achievable.produced?.broll_slots).toEqual([
      { start: 0, end: 5, prompt: 'first' }, { start: 5, end: 10, prompt: 'second' },
    ]);
    const plannedSlots = achievable.produced?.broll_slots as { start: number; end: number; prompt: string }[];
    const actualClips = plannedSlots.length;
    expect(actualClips * 60 / 10).toBeGreaterThanOrEqual(8);
    const plannedClips = plannedSlots.map((s) => ({ ...s, path: video }));
    const rendered = await brollRender(ctx({ base_video: join(root, 'base.mp4'), clips_dir: clipsDir, broll_clips: plannedClips,
      broll_run: (_bin: string, args: readonly string[]) => { writeFileSync(args.at(-1)!, 'rendered'); return ok(); } }));
    expect(rendered.outcome).toBe('ok');
    const qc = await brollQc(ctx({ ...rendered.produced, broll_clips: plannedClips,
      rendered_clips: actualClips, density_target: 8, broll_run: () => ok('10') }));
    expect(qc.outcome).toBe('unmeasurable');
    const impossible = await brollDensityPlan(ctx({ aligned_words: tenSeconds.slice(0, 1).map((w) => ({ ...w, end: 10 })), density_target: 8 }));
    expect(impossible.outcome).toBe('unmeasurable');
    expect(impossible.note).toContain('달성 불가');
    const uneven = await brollDensityPlan(ctx({ aligned_words: [
      { word: 'one', start: 0, end: 1 }, { word: 'two', start: 1, end: 2 },
      { word: 'three', start: 2, end: 3 }, { word: 'four', start: 3, end: 10 },
    ], density_target: 18 }));
    expect(uneven.outcome).toBe('ok');
    expect(uneven.produced?.target_clips).toBe(3);
    expect((uneven.produced?.broll_slots as unknown[]).length).toBe(3);
  });
});

describe('BROLL clip selection', () => {
  it('times out a clip, signals cancellation, logs skip, then still selects the next clip', async () => {
    const signals: AbortSignal[] = [], logs: string[] = [];
    const slots = [{ start: 0, end: 1, prompt: 'fail' }, { start: 1, end: 2, prompt: 'ok' }];
    const result = await brollSelectClips(ctx({ clips_dir: clipsDir, broll_slots: slots, clip_timeout_ms: 10,
      broll_agent: async (slot: { prompt: string }, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return slot.prompt === 'fail' ? new Promise<string>(() => {}) : video;
      },
    }, (event) => logs.push(event)));
    expect(result.outcome).toBe('ok');
    expect(signals[0]?.aborted).toBe(true);
    expect(result.produced?.broll_clips).toEqual([{ ...slots[1], path: video }]);
    expect(result.produced?.skipped_clips).toEqual([{ index: 0, reason: 'timeout' }]);
    expect(logs).toEqual(['broll.clip-skipped']);
  });
  it('rejects traversal and symlink escapes and continues after an agent error', async () => {
    const outside = join(root, 'outside.mp4'); writeFileSync(outside, 'outside');
    symlinkSync(outside, join(clipsDir, 'link.mp4'));
    const slots = Array.from({ length: 4 }, (_, i) => ({ start: i, end: i + 1, prompt: String(i) }));
    const paths = [join(clipsDir, '..', 'outside.mp4'), join(clipsDir, 'link.mp4'), null, video];
    const r = await brollSelectClips(ctx({ broll_slots: slots, clips_dir: clipsDir,
      broll_agent: async (s: { prompt: string }) => { if (s.prompt === '2') throw new Error('unavailable'); return paths[Number(s.prompt)]; } }));
    expect(r.outcome).toBe('ok');
    expect(r.produced?.broll_clips).toEqual([{ ...slots[3], path: video }]);
    expect((r.produced?.skipped_clips as unknown[]).length).toBe(3);
  });
});

describe('BROLL rendering and QC', () => {
  const clip = { start: 1, end: 3, prompt: 'shot', path: '' };
  it('decodes real FFmpeg overlays, counts only visible slots, and preserves base audio', async () => {
    const dir = join(root, 'real-clips'); mkdirSync(dir);
    const base = join(root, 'real-base.mp4');
    const shot = join(dir, 'green.mp4');
    const secondShot = join(dir, 'blue.mp4');
    const make = (args: string[]) => {
      const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], 30_000);
      expect(r.ok).toBe(true);
    };
    make(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', base]);
    make(['-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10:d=2', '-c:v', 'mpeg4', shot]);
    make(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-c:v', 'mpeg4', secondShot]);
    const broll_clips = [{ start: 1, end: 2, prompt: 'green', path: shot }, { start: 2, end: 3, prompt: 'blue', path: secondShot }];
    const render = await brollRender(ctx({ clips_dir: dir, base_video: base, broll_clips }));
    expect(render.outcome).toBe('ok');
    const output = render.produced?.rendered_path as string;
    const frame = (path: string, time: number): Buffer => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', path, '-frames:v', '1',
        '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 4096 });
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBe(3);
      return r.stdout;
    };
    const before = frame(output, 0.5), inSlot = frame(output, 1.5), secondSlot = frame(output, 2.5);
    expect(before[0]!).toBeGreaterThan(before[1]! + 60);
    expect(inSlot[1]!).toBeGreaterThan(inSlot[0]! + 60);
    expect(secondSlot[2]!).toBeGreaterThan(secondSlot[0]! + 60);
    const audio = (path: string): Buffer => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000',
        '-f', 's16le', '-'], { maxBuffer: 100_000 });
      expect(r.status).toBe(0);
      return r.stdout;
    };
    const originalAudio = audio(base), outputAudio = audio(output);
    expect(originalAudio.length).toBeGreaterThan(40_000);
    expect(outputAudio.equals(originalAudio)).toBe(true);
    const state = { ...render.produced, broll_clips, density_target: 30 };
    expect((await brollQc(ctx(state))).produced).toMatchObject({ qc_pass: true, density_actual: expect.any(Number) });
    const oneCut = join(root, 'one-cut.mp4');
    make(['-i', base, '-i', shot, '-filter_complex',
      '[0:v]scale=1920:1080[v0];[1:v]trim=duration=1,setpts=PTS-STARTPTS+1/TB,scale=1920:1080[b];[v0][b]overlay=enable=between(t\\,1\\,2):eof_action=pass[v]',
      '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-c:a', 'copy', oneCut]);
    copyFileSync(oneCut, output);
    const manifest = `${output}.clips.json`;
    const record = JSON.parse(readFileSync(manifest, 'utf8'));
    const { createHash } = await import('node:crypto');
    record.sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
    writeFileSync(manifest, JSON.stringify(record));
    const missingCut = await brollQc(ctx(state));
    expect(missingCut.outcome).toBe('fail');
    expect(missingCut.produced).toMatchObject({ density_actual: 20, qc_pass: false });
    copyFileSync(base, output);
    record.sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
    writeFileSync(manifest, JSON.stringify(record));
    expect((await brollQc(ctx(state))).produced).toMatchObject({ density_actual: 0, qc_pass: false });
  }, 120_000);
  it('uses argv and safe output path, keeps base audio, and verifies the output exists', async () => {
    let called: { bin: string; args: readonly string[]; timeout: number } | undefined;
    const r = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: video }],
      broll_run: (bin: string, args: readonly string[], timeout: number) => {
        called = { bin, args, timeout }; writeFileSync(args[args.length - 1]!, 'rendered'); return ok();
      } }));
    expect(r.outcome).toBe('ok');
    expect(called?.bin).toBe('ffmpeg');
    expect(called?.args).toContain('0:a?');
    expect(called?.args).toContain(video);
    expect(called?.args.at(-1)).toBe(join(root, 'work', 'broll', 'broll.mp4'));
    expect(called?.args.join(' ')).toContain('between(t,1,3)');
    expect(r.produced?.rendered_path).toBe(called?.args.at(-1));
  });
  it('skips unsafe rendered clips and fails closed if the runner reports success without an output', async () => {
    const r = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: join(root, 'outside.mp4') }], broll_run: () => { throw new Error('not reached'); } }));
    expect(r.outcome).toBe('empty');
    const different = join(root, 'other');
    const absent = await brollRender({ ...ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: video }], broll_run: () => ok() }), workdir: different });
    expect(absent.outcome).toBe('error');
  });
  it('does not mistake a stale output for a successful new render', async () => {
    const r = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: video }], broll_run: () => ok() }));
    expect(r.outcome).toBe('error');
  });
  it('refuses an output directory symlink pointing outside the workdir', async () => {
    const workdir = join(root, 'unsafe-work'); mkdirSync(workdir);
    symlinkSync(clipsDir, join(workdir, 'broll'));
    let called = false;
    const r = await brollRender({ ...ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: video }],
      broll_run: () => { called = true; return ok(); } }), workdir });
    expect(r.outcome).toBe('error');
    expect(called).toBe(false);
    const fileWorkdir = join(root, 'unsafe-file-work'); mkdirSync(fileWorkdir);
    mkdirSync(join(fileWorkdir, 'broll'));
    const outside = join(root, 'escaped-render.mp4'); writeFileSync(outside, 'rendered');
    symlinkSync(outside, join(fileWorkdir, 'broll', 'broll.mp4'));
    const escaped = await brollRender({ ...ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [{ ...clip, path: video }],
      broll_run: () => { called = true; return ok(); } }), workdir: fileWorkdir });
    expect(escaped.outcome).toBe('error');
    expect(called).toBe(false);
  });
  it('rejects synthetic media even when a fake duration claims adequate density', async () => {
    const broll_clips = [{ ...clip, path: video }];
    const render = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips,
      broll_run: (_bin: string, args: readonly string[]) => { writeFileSync(args.at(-1)!, 'rendered'); return ok(); } }));
    expect(render.outcome).toBe('ok');
    const state = { ...render.produced, broll_clips, density_target: 10 };
    const r = await brollQc(ctx({ ...state, broll_run: () => ok('12') }));
    expect(r.outcome).toBe('unmeasurable');
    expect((await brollQc(ctx({ ...state, broll_run: () => ok('5') }))).outcome).not.toBe('pass');
    expect((await brollQc(ctx({ ...state, broll_run: () => ok('not a duration') }))).outcome).toBe('unmeasurable');
    const outside = join(root, 'outside.mp4');
    expect((await brollQc(ctx({ ...state, rendered_path: outside, broll_run: () => { throw new Error('should not probe'); } }))).outcome).toBe('fail');
  });
  it('rejects zero clips, inflated or missing counts, changed output and mismatched render inputs', async () => {
    const broll_clips = [{ ...clip, path: video }];
    const render = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips,
      broll_run: (_bin: string, args: readonly string[]) => { writeFileSync(args.at(-1)!, 'rendered'); return ok(); } }));
    expect(render.outcome).toBe('ok');
    const state = { ...render.produced, broll_clips, density_target: 10, broll_run: () => ok('5') };
    expect((await brollQc(ctx(state))).outcome).not.toBe('pass');
    expect((await brollQc(ctx({ ...state, rendered_clips: 100 }))).outcome).toBe('fail');
    expect((await brollQc(ctx({ ...state, rendered_clips: undefined }))).outcome).toBe('fail');
    expect((await brollQc(ctx({ ...state, broll_clips: [] }))).outcome).toBe('fail');
    expect((await brollQc(ctx({ ...state, broll_clips: [{ ...clip, path: video, end: 4 }] }))).outcome).toBe('fail');
    expect((await brollQc(ctx({ ...state, broll_run: () => ok('0.5') }))).outcome).toBe('fail');
    const path = render.produced?.rendered_path as string;
    const manifest = `${path}.clips.json`;
    const recorded = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(recorded), clips: [] }));
    expect((await brollQc(ctx({ ...state, rendered_clips: 100 }))).outcome).toBe('fail');
    writeFileSync(manifest, recorded);
    const escaped = join(root, 'escaped-clips.json'); writeFileSync(escaped, recorded);
    rmSync(manifest); symlinkSync(escaped, manifest);
    expect((await brollQc(ctx(state))).outcome).toBe('fail');
    rmSync(manifest); writeFileSync(manifest, recorded);
    writeFileSync(path, 'changed-render');
    expect((await brollQc(ctx(state))).outcome).toBe('fail');
    const empty = await brollRender(ctx({ clips_dir: clipsDir, base_video: join(root, 'base.mp4'), broll_clips: [], broll_run: () => { throw new Error('should not render'); } }));
    expect(empty.outcome).toBe('empty');
    const orphan = join(root, 'work', 'broll', 'orphan.mp4');
    writeFileSync(orphan, 'rendered-without-clips');
    expect((await brollQc(ctx({ ...state, rendered_path: orphan, broll_clips: [], rendered_clips: 100 }))).outcome).toBe('fail');
  });
});

it('five recipe exports are available to a graph walker', () => {
  expect(Object.keys(BROLL)).toEqual(['broll-align-words', 'broll-density-plan', 'broll-select-clips', 'broll-render', 'broll-qc']);
});
