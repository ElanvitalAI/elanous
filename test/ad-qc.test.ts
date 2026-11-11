import { expect, test } from 'bun:test';
import { assessCaptionedQc, assessQc, QC_UNMEASURED_AXES, type QcFinding, type QcMeasurements, type QcThresholds } from '../src/ad-pipeline/qc.js';

const thresholds: QcThresholds = {
  dialogueLufsTolerance: 1,
  colorDistance: 1,
  frameDiffVariance: 1,
  durationRanges: {
    cut: { minimumSeconds: 3, maximumSeconds: 7 },
    master: { minimumSeconds: 30, maximumSeconds: 30 },
  },
};
const measuredWithinPolicy: QcMeasurements = {
  audioPeakDb: -1,
  dialogueLufs: -14,
  duckingDb: -6,
  captionLines: [{ chars: 12 }, { chars: 16 }],
  captionBottomPercent: 20,
  safeAreaViolations: [],
  aspectRatio: '9:16',
  resolution: '1080x1920',
  colorDistanceBetweenCuts: [0.1],
  colorDistanceWithinCuts: [0.1],
  frameDiffVariance: 0.1,
  renderedContentPresent: true,
  detectedTextRegions: 0,
  durationSeconds: 5,
  durationScope: 'cut',
  negativePromptPresent: true,
};

function resultFor(measurements: QcMeasurements, suppliedThresholds: QcThresholds = thresholds) {
  return assessQc(measurements, suppliedThresholds);
}

/** ⛔ 「못 쟀다」는 «사유를 가져야» 한다 — 그것이 `unmeasured` 축의 계약이다(2026-09-12).
 *  그래서 verdict 가 unmeasured 면 reason 이 비어 있지 않은지까지 «여기서» 단언한다. */
function expectFinding(measurements: QcMeasurements, name: string, verdict: QcFinding['verdict'], suppliedThresholds = thresholds): void {
  expect(resultFor(measurements, suppliedThresholds).findings).toContainEqual(
    verdict === 'unmeasured'
      ? expect.objectContaining({ name, verdict, reason: expect.stringMatching(/\S/u) })
      : expect.objectContaining({ name, verdict }),
  );
}

test('captioned QC assesses only burned-in caption text without unexpected-text', () => {
  expect(assessQc(measuredWithinPolicy).captioned).toBeUndefined();
  expect(assessCaptionedQc(2)).toEqual({ verdict: 'ok', findings: [{ name: 'caption-burned-in', verdict: 'ok' }] });
  expect(assessCaptionedQc(0)).toEqual({ verdict: 'regenerate', findings: [{ name: 'caption-burned-in', verdict: 'regenerate' }] });
  expect(assessCaptionedQc(undefined, 'ocr-frame-extraction-failed')).toEqual({
    verdict: 'unmeasured',
    findings: [{ name: 'caption-burned-in', verdict: 'unmeasured', reason: 'ocr-frame-extraction-failed' }],
  });
});

test('empty measurements fail closed and report every unmeasured axis', () => {
  const emptyResult = resultFor({});

  expect(emptyResult.verdict).toBe('unmeasured');
  expect(emptyResult.findings.map((finding) => finding.name)).toEqual([...QC_UNMEASURED_AXES]);
  expect(emptyResult.findings).toContainEqual({
    name: 'rendered-content-presence',
    verdict: 'unmeasured',
    reason: 'no-rendered-content-presence',
  });
});

test('rendered-content presence is assessed independently of frame-diff variance', () => {
  const missingContentMeasurement = resultFor({ ...measuredWithinPolicy, frameDiffVariance: 0, renderedContentPresent: undefined });
  const nonBooleanContentMeasurement = resultFor({ ...measuredWithinPolicy, frameDiffVariance: 0, renderedContentPresent: 'present' as unknown as boolean });
  const absentContentWithoutVariance = resultFor({ ...measuredWithinPolicy, frameDiffVariance: undefined, renderedContentPresent: false }, {});
  const presentContentWithoutVariance = resultFor({ ...measuredWithinPolicy, frameDiffVariance: undefined, renderedContentPresent: true }, {});

  expect(missingContentMeasurement.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'frame-diff-variance', verdict: 'ok' }),
    { name: 'rendered-content-presence', verdict: 'unmeasured', reason: 'no-rendered-content-presence' },
  ]));
  expect(nonBooleanContentMeasurement.findings).toContainEqual({
    name: 'rendered-content-presence',
    verdict: 'unmeasured',
    reason: 'no-rendered-content-presence',
  });
  expect(absentContentWithoutVariance.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'frame-diff-variance', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
    { name: 'rendered-content-presence', verdict: 'regenerate' },
  ]));
  expect(presentContentWithoutVariance.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'frame-diff-variance', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
    { name: 'rendered-content-presence', verdict: 'ok' },
  ]));
});

test('frame-diff variance evaluates only its measured value and threshold', () => {
  const lowVarianceWithoutContent = resultFor({ ...measuredWithinPolicy, frameDiffVariance: 0, renderedContentPresent: undefined }, { ...thresholds, frameDiffVariance: 5 });
  const highVarianceWithoutContent = resultFor({ ...measuredWithinPolicy, frameDiffVariance: 99, renderedContentPresent: undefined }, { ...thresholds, frameDiffVariance: 5 });

  expect(lowVarianceWithoutContent.findings).toContainEqual({ name: 'frame-diff-variance', verdict: 'ok' });
  expect(highVarianceWithoutContent.findings).toContainEqual({ name: 'frame-diff-variance', verdict: 'regenerate' });
});

test('fully measured policy-compliant media measures rendered content but remains unmeasured until the four manual axes are reviewed', () => {
  const result = resultFor(measuredWithinPolicy);

  expect(result.verdict).toBe('unmeasured');
  expect(result.automatedVerdict).toBe('ok');
  expect(result.manualReviewPending).toEqual([
    'finger-distortion',
    'face-morphing',
    'background-distortion',
    'identity-consistency',
  ]);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'audio-peak', verdict: 'ok' }),
    expect.objectContaining({ name: 'dialogue-loudness', verdict: 'ok' }),
    expect.objectContaining({ name: 'ducking', verdict: 'ok' }),
    expect.objectContaining({ name: 'caption-lines', verdict: 'ok' }),
    expect.objectContaining({ name: 'caption-bottom-percent', verdict: 'ok' }),
    expect.objectContaining({ name: 'safe-area', verdict: 'ok' }),
    expect.objectContaining({ name: 'aspect-ratio', verdict: 'ok' }),
    expect.objectContaining({ name: 'resolution', verdict: 'ok' }),
    expect.objectContaining({ name: 'color-distance-between-cuts', verdict: 'ok' }),
    expect.objectContaining({ name: 'frame-diff-variance', verdict: 'ok' }),
    expect.objectContaining({ name: 'rendered-content-presence', verdict: 'ok' }),
    expect.objectContaining({ name: 'unexpected-text', verdict: 'ok' }),
    expect.objectContaining({ name: 'duration-cut', verdict: 'ok' }),
    expect.objectContaining({ name: 'negative-prompt', verdict: 'ok' }),
    expect.objectContaining({ name: 'finger-distortion', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
    expect.objectContaining({ name: 'face-morphing', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
    expect.objectContaining({ name: 'background-distortion', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
    expect.objectContaining({ name: 'identity-consistency', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }),
  ]));
});

test('aspect ratio derives from resolution without fabricating an absent resolution', () => {
  const derived = resultFor({ ...measuredWithinPolicy, aspectRatio: undefined, resolution: '1080x1920' });
  const missing = resultFor({ ...measuredWithinPolicy, aspectRatio: undefined, resolution: undefined });
  const blank = resultFor({ ...measuredWithinPolicy, aspectRatio: '   ', resolution: undefined });
  const padded = resultFor({ ...measuredWithinPolicy, aspectRatio: ' 9:16 ', resolution: '1080x1920' });

  expect(derived.findings).toContainEqual({ name: 'aspect-ratio', verdict: 'ok' });
  expect(missing.findings).toContainEqual(expect.objectContaining({ name: 'aspect-ratio', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }));
  expect(blank.findings).toContainEqual(expect.objectContaining({ name: 'aspect-ratio', verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }));
  expect(padded.findings).toContainEqual({ name: 'aspect-ratio', verdict: 'regenerate' });
});

test('missing or partial calibrated thresholds preserve dialogue, color, and flicker axes as unmeasured', () => {
  for (const suppliedThresholds of [{}, { dialogueLufsTolerance: 1 }, { colorDistance: 1 }, { frameDiffVariance: 1 }]) {
    const result = resultFor(measuredWithinPolicy, suppliedThresholds);
    expect(result.verdict).toBe('unmeasured');
    if (suppliedThresholds.dialogueLufsTolerance === undefined) expectFinding(measuredWithinPolicy, 'dialogue-loudness', 'unmeasured', suppliedThresholds);
    if (suppliedThresholds.colorDistance === undefined) expectFinding(measuredWithinPolicy, 'color-distance-between-cuts', 'unmeasured', suppliedThresholds);
    if (suppliedThresholds.frameDiffVariance === undefined) expectFinding(measuredWithinPolicy, 'frame-diff-variance', 'unmeasured', suppliedThresholds);
  }
});

test('color-only failure gets grade-fix rather than regenerate', () => {
  const result = resultFor({ ...measuredWithinPolicy, colorDistanceBetweenCuts: [1.01] });

  expect(result.verdict).toBe('grade-fix');
  expect(result.findings).toContainEqual({ name: 'color-distance-between-cuts', verdict: 'grade-fix' });
  expect(result.findings.some((finding) => finding.verdict === 'regenerate')).toBeFalse();
});

test('calibrated RGB-byte distances use the documented 0–441 scale', () => {
  const cutDistances = [22, 23, 154, 51];

  expectFinding(
    { ...measuredWithinPolicy, colorDistanceBetweenCuts: cutDistances },
    'color-distance-between-cuts',
    'grade-fix',
    { ...thresholds, colorDistance: 100 },
  );
  expect(resultFor(
    { ...measuredWithinPolicy, colorDistanceBetweenCuts: cutDistances },
    { ...thresholds, colorDistance: 200 },
  ).findings).toContainEqual({ name: 'color-distance-between-cuts', verdict: 'ok' });
});

test('calibrated dialogue LUFS tolerance compares an unbounded non-negative absolute deviation from −14', () => {
  const tolerance: QcThresholds = { ...thresholds, dialogueLufsTolerance: 1 };
  expect(resultFor({ ...measuredWithinPolicy, dialogueLufs: -14.69 }, tolerance).findings)
    .toContainEqual({ name: 'dialogue-loudness', verdict: 'ok' });
  expectFinding(
    { ...measuredWithinPolicy, dialogueLufs: -15.62 },
    'dialogue-loudness',
    'regenerate',
    tolerance,
  );
  expectFinding(
    { ...measuredWithinPolicy, dialogueLufs: -30 },
    'dialogue-loudness',
    'regenerate',
    tolerance,
  );
});

test('combined findings choose the documented most expensive remediation', () => {
  const result = resultFor({ ...measuredWithinPolicy, audioPeakDb: -0.5, colorDistanceBetweenCuts: [1.01] });

  expect(result.verdict).toBe('regenerate');
  expectFinding({ ...measuredWithinPolicy, audioPeakDb: -0.5, colorDistanceBetweenCuts: [1.01] }, 'audio-peak', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, audioPeakDb: -0.5, colorDistanceBetweenCuts: [1.01] }, 'color-distance-between-cuts', 'grade-fix');
});

test('documented numeric boundaries are inclusive and each outside condition has an independent finding', () => {
  expect(resultFor(measuredWithinPolicy).findings).toContainEqual({ name: 'audio-peak', verdict: 'ok' });
  expectFinding({ ...measuredWithinPolicy, audioPeakDb: -0.5 }, 'audio-peak', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, dialogueLufs: -12.9 }, 'dialogue-loudness', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, dialogueLufs: -15.1 }, 'dialogue-loudness', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, dialogueLufs: -30 }, 'dialogue-loudness', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, duckingDb: -10.1 }, 'ducking', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, duckingDb: -5.9 }, 'ducking', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, captionLines: [{ chars: 11 }] }, 'caption-lines', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, captionLines: [{ chars: 17 }] }, 'caption-lines', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, captionLines: [{ chars: 12 }, { chars: 7 }] }, 'caption-lines', 'ok');
  expectFinding({ ...measuredWithinPolicy, captionLines: [{ chars: 12 }, { chars: 10 }] }, 'caption-lines', 'ok');
  expectFinding({ ...measuredWithinPolicy, captionLines: [{ chars: 12 }, { chars: 12 }, { chars: 12 }] }, 'caption-lines', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, captionBottomPercent: 19.9 }, 'caption-bottom-percent', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, safeAreaViolations: ['top-10%'] }, 'safe-area', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, aspectRatio: '16:9' }, 'aspect-ratio', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, resolution: '1920x1080' }, 'resolution', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, frameDiffVariance: 1.01 }, 'frame-diff-variance', 'regenerate');
  expectFinding({ ...measuredWithinPolicy, detectedTextRegions: 1 }, 'unexpected-text', 'regenerate');
});

test('calibrated thresholds are inclusive and fail only beyond their supplied boundary', () => {
  expect(resultFor(measuredWithinPolicy, { colorDistance: 0.1, frameDiffVariance: 0.1 }).findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'color-distance-between-cuts', verdict: 'ok' }),
    expect.objectContaining({ name: 'frame-diff-variance', verdict: 'ok' }),
  ]));
  expectFinding({ ...measuredWithinPolicy, colorDistanceBetweenCuts: [0.11] }, 'color-distance-between-cuts', 'grade-fix', { colorDistance: 0.1, frameDiffVariance: 1 });
  expectFinding({ ...measuredWithinPolicy, frameDiffVariance: 0.11 }, 'frame-diff-variance', 'regenerate', { colorDistance: 1, frameDiffVariance: 0.1 });
});

test('non-finite or invalid numeric measurements fail closed as unmeasured for every duration scope', () => {
  const invalid: QcMeasurements = {
    ...measuredWithinPolicy,
    audioPeakDb: Number.NaN,
    dialogueLufs: Number.NaN,
    duckingDb: Number.NaN,
    captionLines: [{ chars: Number.NaN }],
    captionBottomPercent: Number.NaN,
    colorDistanceBetweenCuts: [Number.NaN],
    frameDiffVariance: Number.NaN,
    detectedTextRegions: Number.NaN,
    durationSeconds: Number.NaN,
  };
  const result = resultFor(invalid, { colorDistance: Number.NaN, frameDiffVariance: Number.NaN });

  for (const name of ['audio-peak', 'dialogue-loudness', 'ducking', 'caption-lines', 'caption-bottom-percent', 'color-distance-between-cuts', 'frame-diff-variance', 'unexpected-text', 'duration-cut']) {
    expect(result.findings).toContainEqual(expect.objectContaining({ name, verdict: 'unmeasured', reason: expect.stringMatching(/\S/u) }));
  }
  for (const durationScope of ['cut', 'master', undefined] as const) {
    const name = durationScope === 'cut' ? 'duration-cut' : durationScope === 'master' ? 'duration-master' : 'duration-unscoped';
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expectFinding({ ...invalid, durationScope, durationSeconds }, name, 'unmeasured');
    }
  }
});

test('duration ranges are injected per scope and missing ranges remain unmeasured', () => {
  const masterMeasurements = { ...measuredWithinPolicy, durationSeconds: 30, durationScope: 'master' } as const;
  const masterRange: QcThresholds = {
    ...thresholds,
    durationRanges: { master: { minimumSeconds: 30, maximumSeconds: 30 } },
  };

  expect(resultFor(masterMeasurements, masterRange).findings).toContainEqual({ name: 'duration-master', verdict: 'ok' });
  for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expectFinding({ ...masterMeasurements, durationSeconds }, 'duration-master', 'unmeasured', masterRange);
  }
  expectFinding(
    { ...measuredWithinPolicy, durationSeconds: 5, durationScope: 'cut' },
    'duration-cut',
    'unmeasured',
    { ...thresholds, durationRanges: { master: { minimumSeconds: 30, maximumSeconds: 30 } } },
  );
  expectFinding(
    masterMeasurements,
    'duration-master',
    'unmeasured',
    { ...thresholds, durationRanges: { cut: { minimumSeconds: 3, maximumSeconds: 7 } } },
  );
  expectFinding(
    { ...measuredWithinPolicy, durationSeconds: 30, durationScope: undefined },
    'duration-unscoped',
    'unmeasured',
  );
});

test('RFC A3 non-rejecting tips produce warn findings', () => {
  const cutRange: QcThresholds = {
    ...thresholds,
    durationRanges: { cut: { minimumSeconds: 3, maximumSeconds: 7 } },
  };
  const eightSecond = resultFor({ ...measuredWithinPolicy, durationSeconds: 8, durationScope: 'cut' }, cutRange);
  const missingNegativePrompt = resultFor({ ...measuredWithinPolicy, negativePromptPresent: false });

  expect(eightSecond.verdict).toBe('warn');
  expect(eightSecond.findings).toContainEqual({ name: 'duration-cut', verdict: 'warn' });
  expect(missingNegativePrompt.verdict).toBe('warn');
  expect(missingNegativePrompt.findings).toContainEqual({ name: 'negative-prompt', verdict: 'warn' });
});
