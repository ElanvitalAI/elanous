import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQcMeasurementPlan, parseQcMeasurements, shouldRunQcMeasurementCommand, textRegionUnavailableReason, type QcMeasurementOutputs } from '../src/ad-pipeline/qc-measure.js';
import type { SceneSpec } from '../src/ad-pipeline/scene-spec.js';

const scene = (boundaries: readonly number[]): SceneSpec => ({
  beats: boundaries.map((startSec, index) => ({
    role: index === 0 ? 'hook' : 'transition', startSec, endSec: startSec + 5,
    emotion: { primary: 'calm', secondary: 'focused' }, camera: { move: 'static', shotSize: 'medium' },
    model: 'model', audio: true, promptCore: 'frame', checks: [],
  })),
  axes: { hook: 'hook', totalSeconds: boundaries.length * 5, lock: { lens: '50mm', lighting: 'soft', grade: 'neutral', texture: 'film' } },
  aspectRatio: '9:16', forbidden: [], provenance: 'generated',
});

const probe = JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '30.000000' } });
const volume = '[Parsed_volumedetect_0 @ 0xa4ec0a700] mean_volume: -23.0 dB\n[Parsed_volumedetect_0 @ 0xa4ec0a700] max_volume: -3.2 dB';
const loudness = 'ffmpeg log before JSON\n{ "input_i" : "-19.09", "input_tp" : "-3.19" }';

function outputs(overrides: QcMeasurementOutputs = {}): QcMeasurementOutputs {
  return {
    probe: { stdout: probe }, volume: { stderr: volume }, loudness: { stderr: loudness },
    'text-compile': {}, 'text-frame': {},
    'cut-before-0': { raw: new Uint8Array([75, 82, 79]) },
    'cut-after-0': { raw: new Uint8Array([0, 0, 0]) },
    'within-before-0': { raw: new Uint8Array([10, 20, 30]) },
    'within-after-0': { raw: new Uint8Array([12, 21, 31]) },
    ...overrides,
  };
}

const twentyFourFpsFixture = {
  source: 'ffmpeg fixture capture: 24fps frame IDs encoded as RGB, then each complete planned argv was executed externally',
  cases: [
    {
      boundary: 10,
      before: {
        argv: ['ffmpeg', '-v', 'error', '-i', '/fixtures/24fps-frame-id.mp4', '-vf', "select='lt(t\\,10)',scale=1:1,reverse,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        selectedPts: 9.958333333333334,
        rgb: [239, 0, 0],
      },
      after: {
        argv: ['ffmpeg', '-v', 'error', '-i', '/fixtures/24fps-frame-id.mp4', '-vf', "select='gte(t\\,10)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        selectedPts: 10,
        rgb: [240, 0, 0],
      },
    },
    {
      boundary: 10.01,
      before: {
        argv: ['ffmpeg', '-v', 'error', '-i', '/fixtures/24fps-frame-id.mp4', '-vf', "select='lt(t\\,10.01)',scale=1:1,reverse,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        selectedPts: 10,
        rgb: [240, 0, 0],
      },
      after: {
        argv: ['ffmpeg', '-v', 'error', '-i', '/fixtures/24fps-frame-id.mp4', '-vf', "select='gte(t\\,10.01)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        selectedPts: 10.041666666666666,
        rgb: [241, 0, 0],
      },
    },
  ],
} as const;

describe('QC measurement adapter', () => {
  test('builds named ffprobe, audio, and boundary RGB commands without executing them', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');

    expect(plan.commands.map((command) => command.step)).toEqual(['probe', 'volume', 'loudness', 'text-tempdir', 'text-compile', 'text-frame', 'text-regions', 'text-cleanup', 'cut-before-0', 'cut-after-0', 'within-before-0', 'within-after-0', 'within-before-1', 'within-after-1']);
    expect(plan.commands[0].argv).toEqual(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', '/tmp/master.mp4']);
    expect(plan.commands[1].argv).toEqual(['ffmpeg', '-hide_banner', '-i', '/tmp/master.mp4', '-af', 'volumedetect', '-f', 'null', '/dev/null']);
    expect(plan.commands[2].argv).toEqual(['ffmpeg', '-hide_banner', '-i', '/tmp/master.mp4', '-af', 'loudnorm=print_format=json', '-f', 'null', '/dev/null']);
    const textTempDirectory = plan.textTempDirectory;
    expect(textTempDirectory).toStartWith('/tmp/ocr-text-regions-');
    if (textTempDirectory === undefined) throw new Error('darwin plan must include OCR artifacts');
    expect(plan.commands[3].argv).toEqual(['mkdir', '-p', textTempDirectory]);
    expect(plan.commands[4].argv).toEqual(['swiftc', 'scripts/ocr-text-regions.swift', '-o', `${textTempDirectory}/ocr-text-regions`]);
    expect(plan.commands[5].argv).toEqual(['ffmpeg', '-y', '-v', 'error', '-i', '/tmp/master.mp4', '-frames:v', '1', `${textTempDirectory}/frame.png`]);
    expect(plan.commands[6].argv).toEqual([`${textTempDirectory}/ocr-text-regions`, `${textTempDirectory}/frame.png`]);
    expect(plan.commands[7].argv).toEqual(['rm', '-rf', textTempDirectory]);
    expect(plan.commands[8].argv).toContain("select='lt(t\\,10)',scale=1:1,reverse,trim=end_frame=1");
    expect(plan.commands[9].argv).toContain("select='gte(t\\,10)',scale=1:1,trim=end_frame=1");
    expect(plan.commands[10].argv).toEqual(['ffmpeg', '-v', 'error', '-i', '/tmp/master.mp4', '-vf', "select='gte(t\\,1)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    expect(plan.commands[11].argv).toEqual(['ffmpeg', '-v', 'error', '-i', '/tmp/master.mp4', '-vf', "select='gte(t\\,4)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    expect(plan.commands[12].argv).toEqual(['ffmpeg', '-v', 'error', '-i', '/tmp/master.mp4', '-vf', "select='gte(t\\,11)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    expect(plan.commands[13].argv).toEqual(['ffmpeg', '-v', 'error', '-i', '/tmp/master.mp4', '-vf', "select='gte(t\\,14)',scale=1:1,trim=end_frame=1", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  });

  test('seeks only the text frame when an explicit caption time is supplied while retaining the default argv', () => {
    const defaultPlan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const captionedPlan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/captioned.mp4', 'darwin', { textFrameAtSeconds: 3.5 });

    expect(defaultPlan.commands.find((command) => command.step === 'text-frame')?.argv).toEqual([
      'ffmpeg', '-y', '-v', 'error', '-i', '/tmp/master.mp4', '-frames:v', '1', `${defaultPlan.textTempDirectory}/frame.png`,
    ]);
    expect(captionedPlan.commands.find((command) => command.step === 'text-frame')?.argv).toEqual([
      'ffmpeg', '-y', '-v', 'error', '-ss', '3.5', '-i', '/tmp/captioned.mp4', '-frames:v', '1', `${captionedPlan.textTempDirectory}/frame.png`,
    ]);
  });

  test('uses distinct OCR artifacts for repeated and parallel video measurement plans', () => {
    const first = buildQcMeasurementPlan(scene([0, 10]), '/tmp/first.mp4', 'darwin');
    const second = buildQcMeasurementPlan(scene([0, 10]), '/tmp/second.mp4', 'darwin');
    const firstOcr = first.commands.filter((command) => command.step === 'text-compile' || command.step === 'text-frame' || command.step === 'text-regions');
    const secondOcr = second.commands.filter((command) => command.step === 'text-compile' || command.step === 'text-frame' || command.step === 'text-regions');

    expect(first.textTempDirectory).not.toBe(second.textTempDirectory);
    expect(firstOcr.flatMap((command) => command.argv)).not.toContain(second.textTempDirectory);
    expect(secondOcr.flatMap((command) => command.argv)).not.toContain(first.textTempDirectory);
    expect(first.commands.find((command) => command.step === 'text-frame')?.argv).toContain('/tmp/first.mp4');
    expect(second.commands.find((command) => command.step === 'text-frame')?.argv).toContain('/tmp/second.mp4');
    expect(parseQcMeasurements(first, outputs({ 'text-regions': { stdout: 'regions=2' } })).detectedTextRegions).toBe(2);
    expect(parseQcMeasurements(second, outputs({ 'text-regions': { stdout: 'regions=5' } })).detectedTextRegions).toBe(5);
  });

  test('plans exactly one interior RGB pair per sufficiently long beat in a five-beat scene', () => {
    const boundaries = [0, 5, 10, 15, 20];
    const plan = buildQcMeasurementPlan(scene(boundaries), '/tmp/five-beat-master.mp4');

    for (const [index, startSec] of boundaries.entries()) {
      const endSec = startSec + 5;
      const samples = plan.commands.filter((command) => command.step === `within-before-${index}` || command.step === `within-after-${index}`);

      expect(samples).toHaveLength(2);
      const earlySampleSec = startSec + 1;
      const lateSampleSec = endSec - 1;
      expect(samples[0].argv).toContain(`select='gte(t\\,${earlySampleSec})',scale=1:1,trim=end_frame=1`);
      expect(samples[1].argv).toContain(`select='gte(t\\,${lateSampleSec})',scale=1:1,trim=end_frame=1`);
      for (const sample of samples) {
        expect(sample.argv).not.toContain('-ss');
        expect(sample.argv).not.toContain('reverse');
        expect(sample.argv).toContain('-vf');
      }
    }
    expect(plan.skippedWithinCutBeatNumbers).toEqual([]);
  });

  test('matches externally captured complete-command 24fps boundary fixtures without running ffmpeg', () => {
    for (const fixture of twentyFourFpsFixture.cases) {
      const plan = buildQcMeasurementPlan(scene([0, fixture.boundary]), '/fixtures/24fps-frame-id.mp4');
      const before = plan.commands.find((command) => command.step === 'cut-before-0');
      const after = plan.commands.find((command) => command.step === 'cut-after-0');

      expect(before?.argv).toEqual(fixture.before.argv);
      expect(after?.argv).toEqual(fixture.after.argv);
      expect(fixture.before.selectedPts).toBeCloseTo(fixture.boundary === 10 ? 9.958333333333334 : 10);
      expect(fixture.after.selectedPts).toBeCloseTo(fixture.boundary === 10 ? 10 : 10.041666666666666);
      expect(fixture.before.rgb[0]).toBe(fixture.boundary === 10 ? 239 : 240);
      expect(fixture.after.rgb[0]).toBe(fixture.boundary === 10 ? 240 : 241);
    }
  });

  test('parses fixture output by its native format and derives color distances plus rendered content', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const measured = parseQcMeasurements(plan, outputs());

    expect(measured).toMatchObject({ resolution: '1080x1920', durationSeconds: 30, durationScope: 'master', audioPeakDb: -3.2, dialogueLufs: -19.09, renderedContentPresent: true });
    expect(measured.colorDistanceBetweenCuts).toEqual([Math.hypot(75, 82, 79)]);
    expect(measured.colorDistanceWithinCuts).toEqual([Math.hypot(2, 1, 1)]);
  });

  test.if(process.platform === 'darwin')('runs the compiled Vision OCR binary against known text and blank images', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ad-qc-vision-'));
    const source = join(directory, 'known-text.txt');
    const binary = join(directory, 'ocr-text-regions');
    const blankSource = join(directory, 'blank.txt');
    try {
      writeFileSync(source, 'VISION OCR KNOWN TEXT');
      writeFileSync(blankSource, '');
      const thumbnail = Bun.spawnSync(['qlmanage', '-t', '-s', '1200', '-o', directory, source]);
      const blankThumbnail = Bun.spawnSync(['qlmanage', '-t', '-s', '1200', '-o', directory, blankSource]);
      expect(thumbnail.exitCode).toBe(0);
      expect(blankThumbnail.exitCode).toBe(0);
      const textImage = join(directory, readdirSync(directory).find((name) => name.startsWith('known-text.txt') && name.endsWith('.png'))!);
      const blankImage = join(directory, readdirSync(directory).find((name) => name.startsWith('blank.txt') && name.endsWith('.png'))!);
      const compilation = Bun.spawnSync(['swiftc', 'scripts/ocr-text-regions.swift', '-o', binary]);
      expect(compilation.exitCode).toBe(0);
      const recognized = Bun.spawnSync([binary, textImage]);
      const empty = Bun.spawnSync([binary, blankImage]);
      expect(recognized.exitCode).toBe(0);
      expect(empty.exitCode).toBe(0);
      const recognizedOutput = recognized.stdout.toString();
      expect(Number(/regions=(\d+)/.exec(recognizedOutput)?.[1])).toBeGreaterThanOrEqual(1);
      expect(/\n\s*\d+\.\d+\s+.+\sbox=(?:0(?:\.\d+)?|1(?:\.0+)?),(?:0(?:\.\d+)?|1(?:\.0+)?),(?:0(?:\.\d+)?|1(?:\.0+)?),(?:0(?:\.\d+)?|1(?:\.0+)?)/.test(recognizedOutput)).toBeTrue();
      expect(/regions=0(?:\s|$)/.test(empty.stdout.toString())).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('parses zero and positive OCR region counts while isolating malformed OCR output', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');

    expect(parseQcMeasurements(plan, outputs({ 'text-regions': { stdout: 'regions=0\n' } })).detectedTextRegions).toBe(0);
    expect(parseQcMeasurements(plan, outputs({ 'text-regions': { stdout: 'Vision complete regions=12 elapsed=4ms' } })).detectedTextRegions).toBe(12);
    expect(parseQcMeasurements(plan, outputs({ 'text-regions': { stdout: 'regions=-1' } })).detectedTextRegions).toBeUndefined();
    expect(parseQcMeasurements(plan, outputs({ 'text-regions': { ok: false, stdout: 'regions=3' } })).detectedTextRegions).toBeUndefined();
  });

  test('transports valid Vision boxes without changing OCR counts, while skipping legacy and malformed boxes', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const visionOutput = [
      'regions=2',
      '  0.99  Hello Elanous box=0.125000,0.250000,0.500000,0.100000',
      '  0.90  안녕하세요 box=0,0.5,0.25,0.125',
    ].join('\n');
    const measured = parseQcMeasurements(plan, outputs({ 'text-regions': { stdout: visionOutput } }));
    const legacy = parseQcMeasurements(plan, outputs({ 'text-regions': { stdout: 'regions=1\n  0.50  legacy text' } }));
    const malformed = parseQcMeasurements(plan, outputs({
      'text-regions': { stdout: [
        'regions=7',
        '  0.90  bad box=left,0,0.2,0.1',
        '  0.80  range box=0,0,1.2,0.1',
        '  0.70  empty-first box=,0.2,0.3,0.4',
        '  0.60  empty-all box=,,,',
        '  0.50  literal box=0.9,0.8,0.7,0.6 box=0.1,0.2,0.3,0.4',
        '  0.40  invalid-suffix box=0.2,0.3,0.4,0.5 box=,,,',
      ].join('\n') },
    }));

    expect(measured.detectedTextRegions).toBe(2);
    expect(measured.textRegionBoxes).toEqual([
      { x: 0.125, y: 0.25, width: 0.5, height: 0.1 },
      { x: 0, y: 0.5, width: 0.25, height: 0.125 },
    ]);
    expect(legacy.detectedTextRegions).toBe(1);
    expect(legacy.textRegionBoxes).toEqual([]);
    expect(malformed.detectedTextRegions).toBe(7);
    expect(malformed.textRegionBoxes).toEqual([{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]);
  });

  test('distinguishes OCR failure and platform unavailability while preserving every existing axis', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const nonMacPlan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'linux');
    const baseline = parseQcMeasurements(plan, outputs());
    const failed = parseQcMeasurements(plan, outputs({ 'text-regions': { ok: false, stderr: 'Vision failed' } }));
    const unavailable = parseQcMeasurements(nonMacPlan, outputs());

    expect(textRegionUnavailableReason(plan, outputs({ 'text-regions': { ok: false } }))).toBe('ocr-recognition-failed');
    expect(textRegionUnavailableReason(nonMacPlan, outputs())).toBe('ocr-platform-unavailable');
    expect(failed.detectedTextRegions).toBeUndefined();
    expect(unavailable.detectedTextRegions).toBeUndefined();
    expect(nonMacPlan.commands.map((command) => command.step)).not.toContain('text-compile');
    for (const measurement of [failed, unavailable]) {
      expect(measurement).toMatchObject({
        resolution: baseline.resolution,
        durationSeconds: baseline.durationSeconds,
        dialogueLufs: baseline.dialogueLufs,
        audioPeakDb: baseline.audioPeakDb,
        colorDistanceBetweenCuts: baseline.colorDistanceBetweenCuts,
        colorDistanceWithinCuts: baseline.colorDistanceWithinCuts,
      });
    }
  });

  test('blocks OCR execution and result adoption when compilation or frame extraction fails', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const compile = plan.commands.find((command) => command.step === 'text-compile')!;
    const frame = plan.commands.find((command) => command.step === 'text-frame')!;
    const regions = plan.commands.find((command) => command.step === 'text-regions')!;

    expect(shouldRunQcMeasurementCommand(frame, { 'text-compile': { ok: false } })).toBeFalse();
    expect(shouldRunQcMeasurementCommand(regions, { 'text-compile': { ok: false }, 'text-frame': {} })).toBeFalse();
    expect(shouldRunQcMeasurementCommand(regions, { 'text-compile': {}, 'text-frame': { ok: false } })).toBeFalse();
    expect(shouldRunQcMeasurementCommand(compile, { 'text-tempdir': { ok: false } })).toBeFalse();
    const compilationFailedWithStaleSuccess = outputs({ 'text-compile': { ok: false }, 'text-frame': {}, 'text-regions': { stdout: 'regions=7' } });
    const frameFailedWithStaleSuccess = outputs({ 'text-compile': {}, 'text-frame': { ok: false }, 'text-regions': { stdout: 'regions=7' } });

    expect(parseQcMeasurements(plan, compilationFailedWithStaleSuccess).detectedTextRegions).toBeUndefined();
    expect(textRegionUnavailableReason(plan, compilationFailedWithStaleSuccess)).toBe('ocr-compile-failed');
    expect(parseQcMeasurements(plan, frameFailedWithStaleSuccess).detectedTextRegions).toBeUndefined();
    expect(textRegionUnavailableReason(plan, frameFailedWithStaleSuccess)).toBe('ocr-frame-extraction-failed');
  });

  test('reads a nested loudnorm JSON object followed by unrelated stderr text', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const measured = parseQcMeasurements(plan, outputs({
      loudness: { stderr: 'ffmpeg metadata {"ignored":{"brace":"{inside}"},"input_i":"-19.09"} completed successfully' },
    }));

    expect(measured.dialogueLufs).toBe(-19.09);
  });

  test('marks completely black sampled frames absent while preserving measured zero color distance', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const measured = parseQcMeasurements(plan, outputs({ 'cut-before-0': { raw: new Uint8Array([0, 0, 0]) } }));

    expect(measured.colorDistanceBetweenCuts).toEqual([0]);
    expect(measured.renderedContentPresent).toBeFalse();
  });

  test('preserves a successful non-black sample but leaves incomplete boundary distance unmeasured', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const measured = parseQcMeasurements(plan, outputs({ 'cut-after-0': { ok: false } }));

    expect(measured.colorDistanceBetweenCuts).toBeUndefined();
    expect(measured.renderedContentPresent).toBeTrue();
  });

  test('leaves only failed or malformed axes undefined instead of substituting zero', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const malformedProbe = JSON.stringify({ streams: [{ width: null, height: false }], format: { duration: '' } });
    const measured = parseQcMeasurements(plan, outputs({ probe: { stdout: malformedProbe }, volume: { ok: false }, loudness: { stderr: '{not json' }, 'cut-after-0': { ok: false } }));

    expect(measured.resolution).toBeUndefined();
    expect(measured.durationSeconds).toBeUndefined();
    expect(measured.audioPeakDb).toBeUndefined();
    expect(measured.dialogueLufs).toBeUndefined();
    expect(measured.colorDistanceBetweenCuts).toBeUndefined();
    expect(measured.renderedContentPresent).toBeTrue();
  });

  test('skips too-short beats by one-based beat number without issuing or substituting an interior measurement', () => {
    const baseScene = scene([0, 10]);
    const shortScene: SceneSpec = { ...baseScene, beats: baseScene.beats.map((beat, index) => index === 1 ? { ...beat, endSec: 12 } : beat) };
    const plan = buildQcMeasurementPlan(shortScene, '/tmp/master.mp4');

    expect(plan.skippedWithinCutBeatNumbers).toEqual([2]);
    expect(plan.commands.map((command) => command.step)).not.toContain('within-before-1');
    expect(plan.commands.map((command) => command.step)).not.toContain('within-after-1');
  });

  test('omits the within-cut metric when every pair is unavailable', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10]), '/tmp/master.mp4', 'darwin');
    const incomplete = parseQcMeasurements(plan, outputs({ 'within-after-0': { raw: new Uint8Array([1, 2]) } }));
    const unavailable = parseQcMeasurements(plan, outputs({ 'within-before-0': { ok: false }, 'within-after-0': { ok: false } }));

    expect(incomplete.colorDistanceWithinCuts).toBeUndefined();
    expect(unavailable.colorDistanceWithinCuts).toBeUndefined();
    expect(unavailable.colorDistanceBetweenCuts).toEqual([Math.hypot(75, 82, 79)]);
  });

  test('excludes only a malformed interior pair while preserving valid interior and boundary distances', () => {
    const plan = buildQcMeasurementPlan(scene([0, 10, 20]), '/tmp/master.mp4');
    const measured = parseQcMeasurements(plan, outputs({
      'cut-before-1': { raw: new Uint8Array([30, 40, 50]) },
      'cut-after-1': { raw: new Uint8Array([33, 44, 55]) },
      'within-before-1': { raw: new Uint8Array([5, 5, 5]) },
      'within-after-1': { raw: new Uint8Array([5, 5]) },
      'within-before-2': { raw: new Uint8Array([1, 2, 3]) },
      'within-after-2': { raw: new Uint8Array([4, 6, 3]) },
    }));

    expect(measured.colorDistanceBetweenCuts).toEqual([Math.hypot(75, 82, 79), Math.hypot(3, 4, 5)]);
    expect(measured.colorDistanceWithinCuts).toEqual([Math.hypot(2, 1, 1), 5]);
  });

  test('retains the real-world calibration sample for the following threshold goal', () => {
    const cutDistances = [20.49, 24.23, 155.13, 52.04];
    const withinCutMedian = 2.24;
    const withinCutMaximum = 11.05;

    expect(cutDistances).toEqual([20.49, 24.23, 155.13, 52.04]);
    expect(withinCutMedian).toBe(2.24);
    expect(withinCutMaximum).toBe(11.05);
  });

  test('distinguishes no scene cut boundaries from a measured empty boundary result', () => {
    const plan = buildQcMeasurementPlan(scene([0]), '/tmp/master.mp4');
    const measured = parseQcMeasurements(plan, { probe: { stdout: probe } });

    expect(plan.cutBoundaries).toEqual([]);
    expect(measured.colorDistanceBetweenCuts).toBeUndefined();
    expect(measured).toMatchObject({ resolution: '1080x1920', durationSeconds: 30 });
  });
});
