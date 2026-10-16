import { expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import type { LogRecord } from '../src/mss/logging/record.js';
import { assessCaptionScreens, createAdPipelineDeps, createAdPipelinePlan, PRODUCTION_STEPS, runAdPipeline, unpricedReason, type AdPipelineDeps, type AdProductionDeps } from '../src/ad-pipeline/run.js';
import { assessProductionReadiness, type StepReadiness } from '../src/ad-pipeline/production.js';
import { buildShootPlan } from '../src/ad-pipeline/shoot-plan.js';
import { createDefaultConceptGenerator, type ConceptVoiceover } from '../src/ad-pipeline/concept.js';
import type { SceneSpec } from '../src/ad-pipeline/scene-spec.js';

type DebugEvent = { category: string; event: string; data?: Record<string, unknown> };

const testRewriteVoiceover = async (input: { readonly beatDurations: readonly number[] }): Promise<readonly string[]> => input.beatDurations.map((_, index) => `새 문장 ${index + 1}`);

function recordDebugEvents(): { events: DebugEvent[]; restore: () => void } {
  const events: DebugEvent[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as never);
  return { events, restore: () => spy.mockRestore() };
}

const conceptScene: SceneSpec = {
  beats: [{ role: 'hook', startSec: 0, endSec: 2, emotion: { primary: 'calm', secondary: 'clear' }, camera: { move: 'static', shotSize: 'wide' }, model: 'model', audio: false, promptCore: 'concept scene', checks: [] }],
  axes: { hook: 'concept', totalSeconds: 2, lock: { lens: '50mm', lighting: 'day', grade: 'neutral', texture: 'clean' } },
  aspectRatio: '9:16',
  forbidden: [],
  provenance: 'generated',
};

const explicitScene: SceneSpec = {
  ...conceptScene,
  beats: [{ ...conceptScene.beats[0], endSec: 3, promptCore: 'explicit scene' }],
  axes: { ...conceptScene.axes, totalSeconds: 3 },
};

function sceneSourceDeps(scene?: SceneSpec, includeAssembly = true): { deps: AdPipelineDeps; calls: string[][] } {
  const calls: string[][] = [];
  const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const assemblyMaterials = { clips: [{ beatIndex: 0, path: '/source/0.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master.mp4' } };
  return {
    calls,
    deps: {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      frontStage: { survey: { category: 'skincare' }, selection: 'candidate-1' },
      collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
      generateConcept: { generate: () => ({ candidates: [{ hook: 'h1', angle: 'a1' }, { hook: 'h2', angle: 'a2' }], categoryForbiddenExpressions: [], tone: 'calm', ...(scene === undefined ? {} : { scene }) }) },
      production: {
        render: runner,
        ...(includeAssembly ? { assembly: assemblyMaterials } : { assemblyMaterials }),
      },
    },
  };
}

test('passes evaluated URL grounding to every approval from the first gate without blocking a failed verdict', async () => {
  const seen: { readonly gate: string; readonly status: string; readonly passed: boolean; readonly summary: string }[] = [];
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, {
    approve: (gate, plan) => {
      if (plan.grounding?.status !== 'evaluated') throw new Error(`Expected evaluated grounding at ${gate}.`);
      seen.push({ gate, status: plan.grounding.status, passed: plan.grounding.verdict.passed, summary: plan.grounding.summary });
      return true;
    },
    stage: () => {},
    onGrounding: () => {},
    collectPageFacts: () => ({
      url: 'https://example.com/p',
      title: 'Sample product',
      nameCandidates: ['Sample serum'],
      priceCandidates: ['29,000원'],
      specRows: {},
      images: [],
    }),
  });

  expect(result).toMatchObject({ status: 'gates-approved', grounding: { status: 'evaluated', verdict: { passed: false } } });
  expect(seen).toHaveLength(4);
  expect(seen[0]).toMatchObject({ gate: 'BRIEF_OK', status: 'evaluated', passed: false });
  expect(seen.every((entry) => entry.summary.length > 0)).toBe(true);
});

test('does not collect or report URL grounding before an existing early block', async () => {
  let collected = 0;
  let reported = 0;
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => { reported += 1; },
    collectPageFacts: () => { collected += 1; throw new Error('must not collect before output setup block'); },
    outputSetupError: 'output setup unavailable',
  });

  expect(result).toMatchObject({ status: 'blocked', reason: 'output setup unavailable', grounding: { status: 'not-collected', reason: 'output setup unavailable' } });
  expect(collected).toBe(0);
  expect(reported).toBe(0);
});

test('passes a successful URL grounding to approvals while text plans omit it and missing collectors still block', async () => {
  const successful: boolean[] = [];
  const passed = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, {
    approve: (_gate, plan) => {
      if (plan.grounding?.status !== 'evaluated') throw new Error('Expected evaluated grounding.');
      successful.push(plan.grounding.verdict.passed);
      return true;
    },
    stage: () => {},
    onGrounding: () => {},
    collectPageFacts: () => ({
      url: 'https://example.com/p',
      title: 'Sample product',
      nameCandidates: ['Sample serum'],
      priceCandidates: ['29,000원'],
      specRows: {
        '화장품 여부': '화장품',
        '내용물의 용량': '50ml',
        '제조업자': 'Sample maker',
        '제조국': '대한민국',
        '사용기한': '개봉 전 36개월',
        '기능성 여부': '해당없음',
      },
      images: [{ src: 'https://example.com/a.png', w: 1200, h: 1600 }],
      expansion: {
        clicked: [],
        before: { docHeight: 1600, imageCount: 1, imagePixels: 1600 },
        after: { docHeight: 1600, imageCount: 1, imagePixels: 1600 },
      },
    }),
  });
  const textGrounding: unknown[] = [];
  const text = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: (_gate, plan) => { textGrounding.push(plan.grounding); return true; },
    stage: () => {},
    onGrounding: () => {},
  });
  let missingApprovals = 0;
  const missing = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, {
    approve: () => { missingApprovals += 1; return true; },
    stage: () => {},
    onGrounding: () => {},
  });

  expect(passed).toMatchObject({ status: 'gates-approved', grounding: { status: 'evaluated', verdict: { passed: true } } });
  expect(successful).toEqual([true, true, true, true]);
  expect(text).toMatchObject({ status: 'gates-approved' });
  expect(textGrounding).toEqual([undefined, undefined, undefined, undefined]);
  expect(missing).toMatchObject({ status: 'blocked', grounding: { status: 'not-collected' } });
  expect(missingApprovals).toBe(0);
});

test('derives assembly output options from injected production identity', async () => {
  const calls: string[][] = [];
  const deps = createAdPipelineDeps({
    ask: () => true,
    report: () => {},
    outputIdentity: { slug: 'umbrella', version: 3, aspect: '9x16', home: '/home/tester', date: '2026-09-11' },
    production: {
      render: { run: async (argv) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } },
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }] },
    },
  });

  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for output-identity assembly.');
  expect(result.masterPath).toBe('/home/tester/Movies/elanous-ad/2026-09-11-umbrella/umbrella_v3_9x16.mp4');
  expect(calls.find((argv) => argv.includes('/home/tester/Movies/elanous-ad/2026-09-11-umbrella/umbrella_v3_9x16.mp4'))).toEqual(expect.arrayContaining(['/home/tester/Movies/elanous-ad/2026-09-11-umbrella/umbrella_v3_9x16.mp4']));
});

test('preserves explicit assembly options over output identity defaults', async () => {
  const calls: string[][] = [];
  const deps = createAdPipelineDeps({
    ask: () => true,
    report: () => {},
    outputIdentity: { slug: 'umbrella', version: 3, aspect: '9x16', home: '/home/tester', date: '2026-09-11' },
    production: {
      render: { run: async (argv) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } },
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/explicit', outputName: 'caller.mp4' } },
    },
  });

  await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  expect(calls.find((argv) => argv.includes('/explicit/caller.mp4'))).toEqual(expect.arrayContaining(['/explicit/caller.mp4']));
});

test('returns a blocked result for an invalid output identity without throwing', async () => {
  const deps = createAdPipelineDeps({
    ask: () => true,
    report: () => {},
    outputIdentity: { slug: '../umbrella', version: 3, aspect: '9x16', home: '/home/tester', date: '2026-09-11' },
    production: {
      render: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      assembly: { scene: explicitScene, clips: [] },
    },
  });

  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('slug') });
});

test('keeps production without options unchanged when output identity is absent', async () => {
  const calls: string[][] = [];
  const deps = createAdPipelineDeps({
    ask: () => true,
    report: () => {},
    production: {
      render: { run: async (argv) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } },
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }] },
    },
  });

  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates without output identity.');
  expect(result).not.toHaveProperty('masterPath');
  expect(calls).toEqual([]);
});

test('keeps existing production dependencies compatible while accepting optional clip execution dependencies', async () => {
  const existing: AdProductionDeps = {
    soundtrack: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  };
  const calls: string[][] = [];
  const clips: NonNullable<AdProductionDeps['clips']> = {
    runner: { run: async (argv) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } },
    workDir: '/work/clips',
  };
  const augmented: AdProductionDeps = { ...existing, clips };

  expect(existing.clips).toBeUndefined();
  expect(augmented.clips?.workDir).toBe('/work/clips');
  await augmented.clips?.runner.run(['clip-tool', '--version']);
  expect(calls).toEqual([['clip-tool', '--version']]);
});

test('assesses every production step as unwired when no readiness evidence is supplied', () => {
  const readiness = assessProductionReadiness();

  expect(readiness).toEqual(PRODUCTION_STEPS.map((step) => ({ step, status: 'unwired' })));
  expect(readiness).toHaveLength(PRODUCTION_STEPS.length);
});

test('derives readiness from dependencies supplied for this run', () => {
  const readiness = assessProductionReadiness({
    dependencies: {
      ground: ['product brief'],
      voiceover: ['approved narration script'],
      render: ['cut timeline', 'soundtrack mix'],
    },
    supplied: ['product brief', 'cut timeline', 'soundtrack mix'],
  });

  expect(readiness).toContainEqual({ step: 'ground', status: 'wired', by: 'product brief' });
  expect(readiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'approved narration script' });
  expect(readiness).toContainEqual({ step: 'render', status: 'wired', by: 'cut timeline, soundtrack mix' });
});

test('reports an empty-string dependency as missing rather than wiring the step', () => {
  const readiness = assessProductionReadiness({
    dependencies: { render: ['', 'soundtrack mix'] },
    supplied: [],
  });

  expect(readiness).toContainEqual({ step: 'render', status: 'needs-input', missing: '' });
});

test('keeps expand unwired even when all of its dependencies are supplied', () => {
  const readiness = assessProductionReadiness({
    dependencies: { expand: ['approved treatment'] },
    supplied: ['approved treatment'],
  });

  expect(readiness.find((item) => item.step === 'expand')).toEqual({ step: 'expand', status: 'unwired' });
});

test('runAdPipeline reports per-run readiness, missing inputs, and permanent expand gap', async () => {
  const baseDeps: AdPipelineDeps = {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
  };
  const empty = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, baseDeps);
  const shootBackend = {
    submit: async () => 'job-1',
    poll: async () => ({ status: 'completed' }),
  };
  const commandRunner = { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const lines = [{ beatIndex: 0, text: 'hydrating serum', voiceId: 'voice-1' }];
  const equipped = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: {
      cut: shootBackend,
      render: commandRunner,
      soundtrack: commandRunner,
      voiceover: { lines, runner: commandRunner },
    },
  });
  const missingVoiceRunner = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: { cut: shootBackend, render: commandRunner, soundtrack: commandRunner, voiceover: { lines } },
  });
  const missingVoiceLines = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: { cut: shootBackend, render: commandRunner, soundtrack: commandRunner, voiceover: { lines: [], runner: commandRunner } },
  });

  if (empty.status !== 'gates-approved' || equipped.status !== 'gates-approved' || missingVoiceRunner.status !== 'gates-approved' || missingVoiceLines.status !== 'gates-approved') {
    throw new Error('Expected production-readiness pipeline results.');
  }
  expect(empty.unwiredProduction).toEqual(PRODUCTION_STEPS);
  // ⭐ `cut` 은 백엔드만으론 «못 찍는다» — 모델별 길이 규칙까지 있어야 wired 다.
  //    🩸 옛 단언은 「백엔드가 있으면 배선됐다」를 못 박아 그 거짓을 지켰다(실물: 그 상태로 submit 0회).
  expect(equipped.plan.unwiredProduction).toEqual(['ground', 'invariants', 'expand', 'cut', 'render']);
  expect(equipped.unwiredProduction).toEqual(['ground', 'invariants', 'expand', 'cut', 'render']);
  expect(equipped.unwiredProduction).not.toEqual(empty.unwiredProduction);
  expect(equipped.unwiredProduction).toContain('expand');
  expect(equipped.productionReadiness).toContainEqual({ step: 'voiceover', status: 'wired', by: 'voice lines, voice command runner' });
  expect(missingVoiceRunner.productionReadiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'voice command runner' });
  expect(missingVoiceLines.productionReadiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'voice lines' });
  expect(missingVoiceRunner.unwiredProduction).toContain('voiceover');
  expect(missingVoiceLines.unwiredProduction).toContain('voiceover');
});

test('runs sound plans through injected runners with stderr loudnorm feedback and one-pass fallbacks', async () => {
  const measurement = JSON.stringify({ input_i: '-18.2', input_tp: '-2.4', input_lra: '4.1', input_thresh: '-28.3', target_offset: '0.1' });
  const run = async (loudnorm: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }) => {
    const voiceCalls: string[][] = [];
    const soundtrackCalls: string[][] = [];
    const voiceRunner = { run: async (argv: readonly string[]) => { voiceCalls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const soundtrack = {
      run: async (argv: readonly string[]) => {
        soundtrackCalls.push([...argv]);
        return argv.includes('/dev/null') ? loudnorm : { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      production: {
        voiceover: { lines: [{ beatIndex: 0, text: 'hydrating serum', voiceId: 'voice-1' }], runner: voiceRunner },
        soundtrack,
        musicBedPath: '/assets/caller-supplied-bed.wav',
        clips: { runner: soundtrack, workDir: '/sound' },
        assembly: { scene: conceptScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/assembly', outputName: 'master.mp4' } },
        render: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      },
    });
    return { result, voiceCalls, soundtrackCalls };
  };

  const measured = await run({ stdout: 'not-measurement', stderr: measurement, exitCode: 0 });
  expect(measured.result.status).toBe('gates-approved');
  // 🔑 #17522 뒤 한 대사는 «두» tts 명령이다 — ⑴ /with-timestamps 를 «한 번» 치고 ⑵ 그 응답에서
  //    오디오와 낱말 정렬을 «갈라» 낸다. 오디오와 타이밍을 따로 만들면 싱크가 깨지므로 한 호출이어야 한다.
  expect(measured.voiceCalls).toHaveLength(2);
  expect(measured.voiceCalls[0]!.join(' ')).toContain('/with-timestamps');
  expect(measured.voiceCalls[1]!.join(' ')).toContain('--extract-elevenlabs-timestamps');
  expect(measured.soundtrackCalls.filter((argv) => argv.includes('/dev/null'))).toHaveLength(1);
  const measuredMix = measured.soundtrackCalls.at(-1)!.join(' ');
  expect(measuredMix).toContain('linear=true');
  expect(measuredMix).toContain('measured_I=-18.2');

  const stdoutOnly = await run({ stdout: measurement, stderr: '', exitCode: 0 });
  expect(stdoutOnly.soundtrackCalls.at(-1)!.join(' ')).not.toContain('linear=true');
  const failedMeasurement = await run({ stdout: '', stderr: measurement, exitCode: 1 });
  expect(failedMeasurement.soundtrackCalls.at(-1)!.join(' ')).not.toContain('linear=true');

  const blockedCalls: string[][] = [];
  const invalidVoiceLine = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      voiceover: { lines: [{ beatIndex: 99, text: 'invalid', voiceId: 'voice-1' }], runner: { run: async (argv) => { blockedCalls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } } },
      soundtrack: { run: async (argv) => { blockedCalls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } },
      musicBedPath: '/assets/caller-supplied-bed.wav',
      clips: { runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, workDir: '/sound' },
      assembly: { scene: conceptScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/assembly', outputName: 'master.mp4' } },
      render: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    },
  });
  expect(invalidVoiceLine).toMatchObject({ status: 'gates-approved', blocked: [expect.stringContaining('sound: Sound plan blocked: Voice line references missing beat 99.')] });
  expect(blockedCalls).toEqual([]);
});

test('carries generated soundtrack output into assembly while preserving explicit and silent audio paths', async () => {
  const baseDeps = { approve: () => true, stage: () => {}, onGrounding: () => {} };
  const assembly = (masterAudio?: { readonly kind: 'soundtrack'; readonly path: string } | { readonly kind: 'silent' }) => ({
    scene: conceptScene,
    clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264' as const, hasAudio: false } }],
    options: { workDir: '/assembly', outputName: 'master.mp4' },
    ...(masterAudio ? { masterAudio } : {}),
  });
  const run = async (options: { readonly voiceover?: boolean; readonly masterAudio?: { readonly kind: 'soundtrack'; readonly path: string } | { readonly kind: 'silent' } }) => {
    const calls: string[][] = [];
    const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { stdout: '', stderr: argv.includes('/dev/null') ? '' : '', exitCode: 0 }; } };
    const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      ...baseDeps,
      production: {
        ...(options.voiceover ? { voiceover: { lines: [{ beatIndex: 0, text: 'hydrating serum', voiceId: 'voice-1' }], runner } } : {}),
        soundtrack: runner,
        musicBedPath: '/assets/bed.wav',
        clips: { runner, workDir: '/sound' },
        assembly: assembly(options.masterAudio),
        render: runner,
      },
    });
    return { calls, result };
  };

  const generated = await run({ voiceover: true });
  const generatedAssembly = generated.calls.find((argv) => argv.includes('/assembly/master.mp4'));
  expect(generatedAssembly).toEqual(expect.arrayContaining(['-i', '/sound/soundtrack.wav']));

  const explicit = await run({ voiceover: true, masterAudio: { kind: 'soundtrack', path: '/caller/explicit.wav' } });
  const explicitAssembly = explicit.calls.find((argv) => argv.includes('/assembly/master.mp4'));
  expect(explicitAssembly).toEqual(expect.arrayContaining(['-i', '/caller/explicit.wav']));
  expect(explicitAssembly).not.toContain('/sound/soundtrack.wav');

  const callerSilent = await run({ voiceover: true, masterAudio: { kind: 'silent' } });
  const callerSilentAssembly = callerSilent.calls.find((argv) => argv.includes('/assembly/master.mp4'));
  expect(callerSilentAssembly).not.toContain('/sound/soundtrack.wav');
  expect(callerSilent.result).toMatchObject({ plan: { masterAudioReason: 'caller-selected-silent-master-audio' } });

  const silent = await run({});
  const silentAssembly = silent.calls.find((argv) => argv.includes('/assembly/master.mp4'));
  expect(silentAssembly).not.toContain('/sound/soundtrack.wav');
  expect(silent.result).toMatchObject({ plan: { masterAudioReason: 'no-sound-plan-output' } });
});

test('plans captions from executed TTS alignment outputs, reports missing or blocked captions, and supplies QC measurements', async () => {
  const alignmentFor = (text: string) => JSON.stringify({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, index) => index * 0.1),
    character_end_times_seconds: [...text].map((_, index) => (index + 1) * 0.1),
  });
  let runIndex = 0;
  const run = async (alignment: string | undefined, height = 1920) => {
    const workDir = `/tmp/ad-caption-production-${runIndex++}`;
    const runner = {
      run: async (argv: readonly string[]) => {
        if (argv.includes('--extract-elevenlabs-timestamps') && alignment !== undefined) await Bun.write(argv.at(-1)!, alignment);
        if (argv[0] === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ width: 1080, height }], format: { duration: '2' } }), stderr: '', exitCode: 0 };
        if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
        if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    return runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      production: {
        voiceover: {
          lines: [
            { beatIndex: 0, text: 'fresh flavors shine brightly', voiceId: 'voice-1' },
            { beatIndex: 0, text: 'fresh flavors shine brightly', voiceId: 'voice-1' },
            { beatIndex: 0, text: 'fresh flavors shine brightly', voiceId: 'voice-1' },
          ],
          runner,
        },
        soundtrack: runner,
        musicBedPath: '/assets/caller-supplied-bed.wav',
        clips: { runner, workDir },
        render: runner,
        assembly: { scene: conceptScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master.mp4' } },
      },
    });
  };

  const planned = await run(alignmentFor('fresh flavors shine brightly'));
  if (planned.status !== 'gates-approved') throw new Error('Expected approved gates for caption planning.');
  expect(planned.captionPlan).toMatchObject({
    blocked: [],
    captions: Array.from({ length: 3 }, () => ({ beatIndex: 0, lines: [{ text: 'fresh flavors' }, { text: 'shine brightly' }] })),
  });
  expect(planned.qc?.findings).toContainEqual({ name: 'caption-lines', verdict: 'ok' });
  expect(planned.qc?.findings).toContainEqual({ name: 'caption-bottom-percent', verdict: 'ok' });

  const alternateHeight = await run(alignmentFor('fresh flavors shine brightly'), 1280);
  if (alternateHeight.status !== 'gates-approved') throw new Error('Expected approved gates for alternate caption resolution.');
  expect(alternateHeight.qc?.findings).toContainEqual({ name: 'caption-bottom-percent', verdict: 'ok' });

  const missing = await run(undefined);
  if (missing.status !== 'gates-approved') throw new Error('Expected approved gates for missing alignment.');
  expect(missing.captionPlan).toEqual({ captions: [], blocked: Array.from({ length: 3 }, () => 'missing-usable-alignment:beat-1') });
  expect(missing.qc?.findings).toContainEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: `caption-plan-blocked:${Array.from({ length: 3 }, () => 'missing-usable-alignment:beat-1').join(',')}` });

  const blocked = await run(alignmentFor('this singlewordistoolong'));
  if (blocked.status !== 'gates-approved') throw new Error('Expected approved gates for blocked captions.');
  expect(blocked.captionPlan).toEqual({ captions: [], blocked: Array.from({ length: 3 }, () => 'caption-line-limits-exceeded:beat-1') });
  expect(blocked.qc?.findings).toContainEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: `caption-plan-blocked:${Array.from({ length: 3 }, () => 'caption-line-limits-exceeded:beat-1').join(',')}` });
});

test('renders planned captions after assembly while preserving the uncaptained master and named failures', async () => {
  const alignment = JSON.stringify({
    characters: [...'fresh flavors shine brightly'],
    character_start_times_seconds: [...'fresh flavors shine brightly'].map((_, index) => index * 0.1),
    character_end_times_seconds: [...'fresh flavors shine brightly'].map((_, index) => (index + 1) * 0.1),
  });
  const run = async (options: { fontPath?: string; failOverlay?: boolean; emptyCaptions?: boolean; emptyVoiceLines?: boolean; textRegions?: number }) => {
    const calls: string[][] = [];
    const runner = {
      run: async (argv: readonly string[]) => {
        calls.push([...argv]);
        if (argv.includes('--extract-elevenlabs-timestamps')) {
          await Bun.write(argv.at(-1)!, options.emptyCaptions ? JSON.stringify({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }) : alignment);
        }
        if (options.failOverlay && argv.includes('/work/captioned-master.mp4')) return { stdout: '', stderr: 'overlay unavailable', exitCode: 1 };
        if (argv[0] === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '2' } }), stderr: '', exitCode: 0 };
        if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
        if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
        if (argv[0]?.includes('ocr-text-regions')) return { stdout: `regions=${options.textRegions ?? 2}`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      production: {
        captionFontPath: options.fontPath,
        // The burned-in caption check plans text OCR only on macOS; pin it so a Linux gate Pod runs the same path.
        qcPlatform: 'darwin',
        voiceover: { lines: options.emptyVoiceLines ? [] : [{ beatIndex: 0, text: 'fresh flavors shine brightly', voiceId: 'voice-1' }], runner },
        soundtrack: runner,
        musicBedPath: '/assets/bed.wav',
        clips: { runner, workDir: '/tmp/ad-caption-render' },
        render: runner,
        assembly: { scene: conceptScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master.mp4' } },
      },
    });
    if (result.status !== 'gates-approved') throw new Error('Expected approved gates for caption rendering.');
    return { result, calls };
  };

  const successful = await run({ fontPath: '/fonts/caption.ttf' });
  expect(successful.result.masterPath).toBe('/work/master.mp4');
  expect(successful.result.captionedMasterPath).toBe('/work/captioned-master.mp4');
  expect(successful.result.captionBlocked).toBeUndefined();
  expect(successful.calls.findIndex((argv) => argv.includes('/work/master.mp4'))).toBeLessThan(successful.calls.findIndex((argv) => argv.includes('/work/captioned-master.mp4')));
  expect(successful.calls.filter((argv) => argv[0] === 'magick')).toHaveLength(2);
  expect(successful.result.qc?.captioned).toEqual({ verdict: 'ok', findings: [{ name: 'caption-burned-in', verdict: 'ok' }] });
  expect(successful.result.qc?.captioned?.findings.some((finding) => finding.name === 'unexpected-text')).toBe(false);
  const captionedTextFrame = successful.calls.find((argv) => argv.includes('/work/captioned-master.mp4') && argv.includes('-frames:v'));
  expect(captionedTextFrame).toEqual(expect.arrayContaining(['-ss', '0.65', '-i', '/work/captioned-master.mp4']));
  expect(successful.calls.filter((argv) => argv.includes('/work/captioned-master.mp4') && (argv.includes('volumedetect') || argv.includes('loudnorm=print_format=json') || argv.includes('rawvideo')))).toEqual([]);

  const emptyBurnIn = await run({ fontPath: '/fonts/caption.ttf', textRegions: 0 });
  expect(emptyBurnIn.result.qc?.captioned).toEqual({ verdict: 'regenerate', findings: [{ name: 'caption-burned-in', verdict: 'regenerate' }] });
  expect(emptyBurnIn.result.qc?.verdict).toBe('regenerate');

  const missingFont = await run({});
  expect(missingFont.result).toMatchObject({ masterPath: '/work/master.mp4', captionBlocked: ['missing-font-path'] });
  expect(missingFont.result.captionedMasterPath).toBeUndefined();
  expect(missingFont.calls.some((argv) => argv[0] === 'magick' || argv.includes('/work/captioned-master.mp4'))).toBe(false);

  const failed = await run({ fontPath: '/fonts/caption.ttf', failOverlay: true });
  expect(failed.result).toMatchObject({ masterPath: '/work/master.mp4', captionBlocked: ['overlay-captions: overlay unavailable'] });
  expect(failed.result.captionedMasterPath).toBeUndefined();

  const empty = await run({ fontPath: '/fonts/caption.ttf', emptyCaptions: true });
  expect(empty.result).toMatchObject({ masterPath: '/work/master.mp4', captionBlocked: ['missing-usable-alignment:beat-1'] });
  expect(empty.result.captionedMasterPath).toBeUndefined();
  expect(empty.calls.some((argv) => argv[0] === 'magick' || argv.includes('/work/captioned-master.mp4'))).toBe(false);

  const noCaptionLines = await run({ fontPath: '/fonts/caption.ttf', emptyVoiceLines: true });
  expect(noCaptionLines.result).toMatchObject({
    masterPath: '/work/master.mp4',
    captionPlan: { captions: [], blocked: [] },
    captionBlocked: ['no-caption-lines'],
  });
  expect(noCaptionLines.result.captionedMasterPath).toBeUndefined();
  expect(noCaptionLines.result.qc?.findings).toContainEqual({ name: 'caption-bottom-percent', verdict: 'unmeasured', reason: 'no-caption-bottom-percent' });
  expect(noCaptionLines.calls.some((argv) => argv[0] === 'magick' || argv.includes('/work/captioned-master.mp4'))).toBe(false);
});

test('assesses each caption screen independently and distinguishes unmeasured caption plans', () => {
  const caption = (text: string) => ({ beatIndex: 0, lines: [{ text: text.slice(0, 12), startMs: 0, endMs: 100 }, { text: text.slice(12), startMs: 100, endMs: 200 }] });
  const valid = caption('fresh flavors shine brightly');
  expect(assessCaptionScreens({}, { captions: [valid, valid, valid], blocked: [] }, undefined)).toEqual({ name: 'caption-lines', verdict: 'ok' });
  expect(assessCaptionScreens({}, { captions: [valid, { beatIndex: 0, lines: [{ text: 'seventeen-characters', startMs: 0, endMs: 100 }] }], blocked: [] }, undefined)).toEqual({ name: 'caption-lines', verdict: 'regenerate' });
  expect(assessCaptionScreens({}, undefined, undefined)).toEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: 'no-caption-plan' });
  expect(assessCaptionScreens({}, { captions: [valid], blocked: ['missing-usable-alignment:beat-2', 'caption-line-limits-exceeded:beat-3'] }, undefined)).toEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: 'caption-plan-blocked:missing-usable-alignment:beat-2,caption-line-limits-exceeded:beat-3' });
  expect(assessCaptionScreens({}, { captions: [], blocked: [] }, undefined)).toEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: 'no-caption-lines' });
});

test('keeps mixed missing or blocked caption beats unmeasured instead of passing their valid lines', async () => {
  const alignmentFor = (text: string) => JSON.stringify({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, index) => index * 0.1),
    character_end_times_seconds: [...text].map((_, index) => (index + 1) * 0.1),
  });
  const mixedCaptionScene: SceneSpec = {
    ...conceptScene,
    beats: [
      conceptScene.beats[0],
      { ...conceptScene.beats[0], role: 'buildup', startSec: 2, endSec: 4, promptCore: 'caption failure beat' },
    ],
    axes: { ...conceptScene.axes, totalSeconds: 4 },
  };
  let runIndex = 0;
  const run = async (secondAlignment: string | undefined) => {
    const workDir = `/tmp/ad-caption-mixed-${runIndex++}`;
    let extractionIndex = 0;
    const runner = {
      run: async (argv: readonly string[]) => {
        if (argv.includes('--extract-elevenlabs-timestamps')) {
          const alignment = extractionIndex++ === 0 ? alignmentFor('fresh flavors shine brightly') : secondAlignment;
          if (alignment !== undefined) await Bun.write(argv.at(-1)!, alignment);
        }
        if (argv[0] === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '4' } }), stderr: '', exitCode: 0 };
        if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
        if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    return runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      production: {
        voiceover: {
          lines: [
            { beatIndex: 0, text: 'fresh flavors shine brightly', voiceId: 'voice-1' },
            { beatIndex: 1, text: 'second caption line', voiceId: 'voice-1' },
          ],
          runner,
        },
        soundtrack: runner,
        musicBedPath: '/assets/caller-supplied-bed.wav',
        clips: { runner, workDir },
        render: runner,
        assembly: {
          scene: mixedCaptionScene,
          clips: [
            { beatIndex: 0, path: '/clip-0.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } },
            { beatIndex: 1, path: '/clip-1.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } },
          ],
          options: { workDir: '/work', outputName: 'master.mp4' },
        },
      },
    });
  };

  const expectedValidCaption = { beatIndex: 0, lines: [{ text: 'fresh flavors' }, { text: 'shine brightly' }] };
  const missing = await run(undefined);
  if (missing.status !== 'gates-approved') throw new Error('Expected approved gates for mixed missing alignment.');
  expect(missing.captionPlan).toMatchObject({ captions: [expectedValidCaption], blocked: ['missing-usable-alignment:beat-2'] });
  expect(missing.qc?.findings).toContainEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: 'caption-plan-blocked:missing-usable-alignment:beat-2' });

  const blocked = await run(alignmentFor('this singlewordistoolong'));
  if (blocked.status !== 'gates-approved') throw new Error('Expected approved gates for mixed blocked captions.');
  expect(blocked.captionPlan).toMatchObject({ captions: [expectedValidCaption], blocked: ['caption-line-limits-exceeded:beat-2'] });
  expect(blocked.qc?.findings).toContainEqual({ name: 'caption-lines', verdict: 'unmeasured', reason: 'caption-plan-blocked:caption-line-limits-exceeded:beat-2' });
});

test('blocks a sound stage without a caller-supplied music bed while voiceover absence still skips silently', async () => {
  const calls: string[][] = [];
  const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const baseProduction = {
    soundtrack: runner,
    clips: { runner, workDir: '/sound' },
    assembly: { scene: conceptScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/assembly', outputName: 'master.mp4' } },
    render: runner,
  };
  const baseDeps = { approve: () => true, stage: () => {}, onGrounding: () => {} };

  const blocked = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: { ...baseProduction, voiceover: { lines: [{ beatIndex: 0, text: 'hydrating serum', voiceId: 'voice-1' }], runner } },
  });
  expect(blocked).toMatchObject({
    status: 'gates-approved',
    blocked: ['sound: Sound plan blocked: Music bed path was not supplied; no loudnorm or ducking commands were planned.'],
    clips: [{ beatIndex: 0, path: '/clip.mp4' }],
  });
  expect(calls).toEqual([]);

  const skipped = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: { ...baseProduction, musicBedPath: '/assets/caller-supplied-bed.wav' },
  });
  expect(skipped.status).toBe('gates-approved');
  expect(calls.some((argv) => argv.includes('/assembly/master.mp4'))).toBe(true);
  expect(calls.some((argv) => argv.includes('/assets/caller-supplied-bed.wav'))).toBe(false);
});

test('logs bounded execution, gate, and readiness metadata without executing unwired dependencies', async () => {
  const { events, restore } = recordDebugEvents();
  const calls: string[] = [];
  const secretPrompt = 'full prompt body https://signed.example/asset?token=api-key asset-id=asset-123';
  try {
    const approved = await runAdPipeline({ kind: 'text', brief: secretPrompt }, {
      approve: () => true,
      stage: (gate) => { calls.push(gate); },
      onGrounding: () => { calls.push('grounding'); },
    });
    const rejected = await runAdPipeline({ kind: 'text', brief: secretPrompt }, {
      approve: (gate) => gate !== 'MASTER_PICK',
      stage: (gate) => { calls.push(`rejected:${gate}`); },
      onGrounding: () => { calls.push('rejected:grounding'); },
    });

    expect(approved.status).toBe('gates-approved');
    expect(rejected).toMatchObject({ status: 'rejected', stoppedGate: 'MASTER_PICK' });
    expect(calls).toEqual(['BRIEF_OK', 'MASTER_PICK', 'PACK_OK', 'VIDEO_OK', 'rejected:BRIEF_OK']);
    expect(events).toContainEqual({
      category: 'ad-pipeline.run',
      event: 'started',
      data: { inputKind: 'text', mode: 'medium', frontRequested: false, wired: 0, needsInput: 6, unwired: 1 },
    });
    expect(events).toContainEqual({ category: 'ad-pipeline.run', event: 'gate-approved', data: { gate: 'BRIEF_OK' } });
    expect(events).toContainEqual({ category: 'ad-pipeline.run', event: 'gate-rejected', data: { gate: 'MASTER_PICK' } });
    expect(events).toContainEqual({
      category: 'ad-pipeline.run',
      event: 'production-readiness',
      data: { wired: 0, needsInput: 6, unwired: 1 },
    });
    expect(JSON.stringify(events)).not.toContain(secretPrompt);
    expect(JSON.stringify(events)).not.toContain('https://signed.example');
    expect(JSON.stringify(events)).not.toContain('api-key');
    expect(JSON.stringify(events)).not.toContain('asset-123');
    const completion = events.find((entry) => entry.category === 'ad-pipeline.run' && entry.event === 'completion-reasons');
    expect(completion?.data).not.toHaveProperty('shootAssets');
    expect(completion?.data).not.toHaveProperty('unpriced');
    expect(completion?.data).not.toHaveProperty('limitedBy');
    expect(completion?.data).not.toHaveProperty('captionBlocked');
    expect(completion?.data).not.toHaveProperty('masterAudioReason');
    expect(completion?.data).not.toHaveProperty('shotParse');
  } finally {
    restore();
  }
});

test('logs present completion reasons while redacting shoot URLs and prompt text', async () => {
  const { events, restore } = recordDebugEvents();
  const secretUrl = 'https://signed.example/asset?token=api-key';
  const secretPrompt = 'full prompt body that must not reach the ledger';
  try {
    const result = await runAdPipeline({ kind: 'text', brief: secretPrompt }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
      frontStage: { survey: { category: 'skincare' }, selection: 'candidate-1', shotMarkdown: 'not a shot block' },
      collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
      generateConcept: createDefaultConceptGenerator({ rewriteVoiceover: testRewriteVoiceover }),
      production: {
        cut: {
          submit: async () => 'job-1',
          poll: async () => ({ status: 'in_progress', resultUrl: secretUrl }),
        },
        durationRules: { model: { minimumSeconds: 2 } },
        creditsPerSecond: { model: 1 },
        referenceAssets: {},
        referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
        shootRunOptions: { submitStaggerMs: 0, maxPollsPerJob: 1 },
        render: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
        assembly: {
          scene: explicitScene,
          clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }],
          options: { workDir: '/work', outputName: 'master.mp4' },
        },
      },
    });

    expect(result.status).toBe('gates-approved');
    const completion = events.find((entry) => entry.category === 'ad-pipeline.run' && entry.event === 'completion-reasons');
    expect(completion?.data).toMatchObject({
      shootAssets: { count: 1, names: ['Beat 1'] },
      limitedBy: ['attempts'],
      masterAudioReason: 'no-sound-plan-output',
      shotParse: { missing: [], formatMismatch: 'Expected ### Shot N or ### 샷 N blocks' },
      disclosure: { step: 'generated-asset-disclosure' },
    });
    expect(JSON.stringify(completion)).not.toContain(secretUrl);
    expect(JSON.stringify(completion)).not.toContain(secretPrompt);
  } finally {
    restore();
  }
});

test('delivers dependency-free execution observations to a registered log sink', async () => {
  const records: LogRecord[] = [];
  const unregister = debug.registerSink({ name: 'ad-production-memory', emit: (record) => records.push(record) });
  try {
    const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      approve: () => true,
      stage: () => {},
      onGrounding: () => {},
    });

    expect(result.status).toBe('gates-approved');
    expect(records).toContainEqual(expect.objectContaining({
      category: 'ad-pipeline.run',
      event: 'started',
      data: expect.objectContaining({ inputKind: 'text', mode: 'medium', frontRequested: false }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      category: 'ad-pipeline.run',
      event: 'production-readiness',
      data: expect.objectContaining({ wired: 0, needsInput: 6, unwired: 1 }),
    }));
  } finally {
    unregister();
  }
});

test('uses the concept result for invariants while preserving explicit production precedence and planning honesty', async () => {
  const { deps } = sceneSourceDeps();
  const manualInvariants = { selection: 'manual', candidates: [{ hook: 'manual hook', angle: 'manual angle' }], categoryForbiddenExpressions: [], tone: 'manual' };
  const conceptBacked = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);
  const productionBacked = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    production: { ...deps.production!, invariants: manualInvariants },
  });
  const plannedWithoutConcept = createAdPipelinePlan({ kind: 'text', brief: 'serum campaign' });
  const plannedWithManualInvariants = createAdPipelinePlan({ kind: 'text', brief: 'serum campaign' }, { production: { invariants: manualInvariants } });
  const plannedWithoutEither = createAdPipelinePlan({ kind: 'text', brief: 'serum campaign' }, { production: {} });

  if (conceptBacked.status !== 'gates-approved' || productionBacked.status !== 'gates-approved') {
    throw new Error('Expected approved gates for invariant provenance cases.');
  }
  expect(conceptBacked.productionReadiness).toContainEqual({ step: 'invariants', status: 'wired', by: 'concept result' });
  expect(conceptBacked.plan.productionInvariants).toEqual({ selected: 'concept', sources: 'concept' });
  expect(productionBacked.productionReadiness).toContainEqual({ step: 'invariants', status: 'wired', by: 'concept result' });
  expect(productionBacked.plan.productionInvariants).toEqual({ selected: 'production', sources: 'both' });
  expect(plannedWithoutConcept.productionReadiness).toContainEqual({ step: 'invariants', status: 'needs-input', missing: 'concept result' });
  expect(plannedWithoutConcept.productionInvariants).toBeUndefined();
  expect(plannedWithManualInvariants.productionReadiness).toContainEqual({ step: 'invariants', status: 'wired', by: 'concept result' });
  expect(plannedWithManualInvariants.productionInvariants).toEqual({ selected: 'production', sources: 'production' });
  expect(plannedWithoutEither.productionReadiness).toContainEqual({ step: 'invariants', status: 'needs-input', missing: 'concept result' });
  expect(plannedWithoutEither.productionInvariants).toBeUndefined();
});

const shotMarkdown = [1, 2, 3].map((shot, index) => `### Shot ${shot}
## 장르 식별
beauty
## 5축 분석
① 톤·감정: calm + clear
③ 구조: ${index === 0 ? 'hook' : index === 2 ? 'climax' : 'buildup'}
④ 후킹 포인트: hydrated skin
카메라: static / wide
렌즈: 50mm
조명: day
색감: neutral
텍스처: clean
## English Prompt
serum reveal ${shot}
## Higgsfield 설정
모델: model
Aspect ratio: 9:16
Duration: 2s
Audio: no`).join('\n\n');

test('uses generated concept voice lines for readiness without treating blocked voiceover as supplied', async () => {
  const runner = { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const baseDeps: AdPipelineDeps = {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    frontStage: { survey: { category: 'skincare' }, selection: 'candidate-1', shotMarkdown, voiceId: 'voice-1' },
    collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
    generateConcept: createDefaultConceptGenerator({ rewriteVoiceover: testRewriteVoiceover }),
    production: { voiceover: { lines: [], runner } },
  };
  const conceptLines = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, baseDeps);
  const blockedConcept = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    frontStage: { ...baseDeps.frontStage!, voiceId: undefined },
  });
  const missingRunner = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...baseDeps,
    production: { voiceover: { lines: [] } },
  });
  const planned = createAdPipelinePlan({ kind: 'text', brief: 'serum campaign' }, { production: baseDeps.production });

  if (conceptLines.status !== 'gates-approved' || blockedConcept.status !== 'gates-approved' || missingRunner.status !== 'gates-approved') {
    throw new Error('Expected approved gates for concept voiceover readiness cases.');
  }
  expect(conceptLines.plan.productionVoiceover).toEqual({ selected: 'concept', sources: 'concept' });
  expect(conceptLines.productionReadiness).toContainEqual({ step: 'voiceover', status: 'wired', by: 'voice lines, voice command runner' });
  expect(blockedConcept.plan.concept?.voiceover).toEqual({ blocked: 'voice-id-required' });
  expect(blockedConcept.productionReadiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'voice lines' });
  expect(missingRunner.productionReadiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'voice command runner' });
  expect(planned.productionReadiness).toContainEqual({ step: 'voiceover', status: 'needs-input', missing: 'voice lines' });
});

test('keeps plan-only image disclosures unset before execution determines production', () => {
  const plan = createAdPipelinePlan({ kind: 'image', paths: ['/assets/product.jpg'] });

  expect(plan.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'shoot backend' });
  expect(plan.disclosure).toBeUndefined();
});

test('wires caller shot markdown into the concept scene, production readiness, and voiceover', async () => {
  const runner = { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const result = await runAdPipeline({ kind: 'image', paths: ['/assets/product.jpg'] }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    frontStage: { survey: { category: 'skincare' }, selection: 'candidate-1', shotMarkdown, voiceId: 'voice-1' },
    collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
    generateConcept: createDefaultConceptGenerator({ rewriteVoiceover: testRewriteVoiceover }),
    production: {
      cut: { submit: async () => 'job-1', poll: async () => ({ status: 'completed', resultUrl: 'https://clips.test/job-1.mp4' }) },
      durationRules: { model: { minimumSeconds: 2 } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      render: runner,
      assemblyMaterials: { clips: [0, 1, 2].map((beatIndex) => ({ beatIndex, path: `/clip-${beatIndex}.mp4`, probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } })), options: { workDir: '/work', outputName: 'master.mp4' } },
      voiceover: { lines: [], runner },
      soundtrack: runner,
      musicBedPath: '/assets/bed.wav',
      clips: { runner, workDir: '/sound' },
    },
  });

  if (result.status !== 'gates-approved' || !result.plan.concept?.scene) throw new Error('Expected caller shots to produce a concept scene.');
  expect(result.plan.concept.scene.beats).toHaveLength(3);
  expect(result.plan.sceneWarnings).toEqual([
    'Beat 1 duration 2s is outside the recommended 5–7 seconds.',
    'Beat 2 duration 2s is outside the recommended 5–7 seconds.',
    'Beat 3 duration 2s is outside the recommended 5–7 seconds.',
  ]);
  expect(result.plan.shotParse).toBeUndefined();
  expect(result.productionReadiness).toContainEqual({ step: 'cut', status: 'wired', by: 'shoot backend, duration rules, credits per second, reference assets, reference delivery, production scene' });
  expect(result.productionReadiness).toContainEqual({ step: 'render', status: 'wired', by: 'render command runner, assembly scene' });
  expect(result.plan.productionVoiceover).toEqual({ selected: 'concept', sources: 'concept' });
  expect(result.plan.concept.voiceover).toMatchObject({ lines: Array.from({ length: 3 }, () => ({ voiceId: 'voice-1' })) });
  expect(result.plan.disclosure).toEqual({ step: 'generated-asset-disclosure', text: '생성된 이미지·영상이 포함되어 있습니다.' });
});

test('keeps real-image runs undisclosed when cut remains needs-input', async () => {
  const result = await runAdPipeline({ kind: 'image', paths: ['/assets/product.jpg'] }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    frontStage: { survey: { category: 'skincare' }, selection: 'candidate-1' },
    collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
    generateConcept: createDefaultConceptGenerator({ rewriteVoiceover: testRewriteVoiceover }),
    production: {
      cut: { submit: async () => 'job-1', poll: async () => ({ status: 'completed' }) },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for a real-image no-scene run.');
  expect(result.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'production scene' });
  expect(result.plan.disclosure).toBeUndefined();
});

test('preserves an already planned disclosure when execution readiness becomes non-generated', async () => {
  let sceneReads = 0;
  const scene: SceneSpec = {
    beats: [{ role: 'hook', startSec: 0, endSec: 2, emotion: { primary: 'calm', secondary: 'clear' }, camera: { move: 'static', shotSize: 'wide' }, model: 'model', audio: false, promptCore: 'product', checks: [] }],
    axes: { hook: 'product', totalSeconds: 2, lock: { lens: '50mm', lighting: 'day', grade: 'neutral', texture: 'clean' } },
    aspectRatio: '9:16',
    forbidden: [],
    provenance: 'real',
  };
  const production: AdProductionDeps = {
    cut: { submit: async () => 'job-1', poll: async () => ({ status: 'completed' }) },
    durationRules: { model: { minimumSeconds: 2 } },
    creditsPerSecond: { model: 1 },
    referenceAssets: {},
    referenceDelivery: { model: { kind: 'repeated' as const, flag: '--image-references' } },
    assembly: {
      get scene() { return sceneReads++ === 0 ? scene : undefined; },
      clips: [],
      options: { workDir: '/work', outputName: 'master.mp4' },
    },
  };
  let plannedDisclosure: ReturnType<typeof createAdPipelinePlan>['disclosure'];
  let capturedPlan = false;
  const result = await runAdPipeline({ kind: 'image', paths: ['/assets/product.jpg'] }, {
    approve: () => true,
    stage: (_gate, plan) => {
      if (!capturedPlan) {
        plannedDisclosure = plan.disclosure;
        capturedPlan = true;
      }
    },
    onGrounding: () => {},
    production,
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for disclosure monotonicity.');
  expect(plannedDisclosure).toEqual({ step: 'generated-asset-disclosure', text: '생성된 이미지·영상이 포함되어 있습니다.' });
  expect(result.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'production scene' });
  expect(result.plan.provenance).toBe('real');
  expect(result.plan.disclosure).toEqual(plannedDisclosure);
});

test('records caller shot parser failures while preserving the no-shot path', async () => {
  const run = (frontStage: AdPipelineDeps['frontStage']) => runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    frontStage,
    collectSurvey: { collect: () => [{ id: 'candidate-1', label: 'lightweight', reason: 'summer demand', evidence: [{ source: 'https://example.test/trend', detail: 'demand' }] }] },
    generateConcept: createDefaultConceptGenerator({ rewriteVoiceover: testRewriteVoiceover }),
    production: {
      cut: { submit: async () => 'job-1', poll: async () => ({ status: 'completed' }) },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      render: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      assemblyMaterials: { clips: [], options: { workDir: '/work', outputName: 'master.mp4' } },
    },
  });
  const failed = await run({ survey: { category: 'skincare' }, selection: 'candidate-1', shotMarkdown: 'not a shot block', voiceId: 'voice-1' });
  const absent = await run({ survey: { category: 'skincare' }, selection: 'candidate-1' });

  if (failed.status !== 'gates-approved' || absent.status !== 'gates-approved') throw new Error('Expected approved gates for front-stage parse cases.');
  expect(failed.plan.concept?.scene).toBeUndefined();
  expect(failed.plan.shotParse).toEqual({ missing: [], formatMismatch: 'Expected ### Shot N or ### 샷 N blocks' });
  expect(absent.plan.concept?.scene).toBeUndefined();
  expect(absent.plan.shotParse).toBeUndefined();
  expect(absent.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'production scene' });
  expect(absent.productionReadiness).toContainEqual({ step: 'render', status: 'needs-input', missing: 'assembly scene' });
  expect(absent.plan.productionVoiceover).toBeUndefined();
  expect(absent.plan.disclosure).toEqual({ step: 'generated-asset-disclosure', text: '생성된 이미지·영상이 포함되어 있습니다.' });
});

test('uses a generated concept scene with assembly absent and independent materials supplied', async () => {
  const { deps, calls } = sceneSourceDeps(conceptScene, false);
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  expect(deps.production?.assembly).toBeUndefined();
  expect(deps.production?.assemblyMaterials).toBeDefined();
  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for concept-scene production input.');
  expect(result).toMatchObject({ status: 'gates-approved', plan: { productionScene: { selected: 'concept', sources: 'concept' } } });
  expect(result.productionReadiness).toContainEqual({ step: 'render', status: 'wired', by: 'render command runner, assembly scene' });
  expect(result.safezonePath).toBe('/work/safezone.png');
  expect(calls).not.toHaveLength(0);
  expect(calls.flat()).toContain('2');

  const { deps: horizontalDeps } = sceneSourceDeps({ ...conceptScene, aspectRatio: '16:9' }, false);
  const horizontal = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, horizontalDeps);
  if (horizontal.status !== 'gates-approved') throw new Error('Expected approved gates for horizontal concept-scene production input.');
  expect(horizontal).not.toHaveProperty('safezonePath');
});

test('keeps an explicit assembly.scene as the production input without a concept scene', async () => {
  const { deps, calls } = sceneSourceDeps();
  const production = deps.production!;
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    production: { ...production, assembly: { ...production.assembly!, scene: explicitScene } },
  });

  expect(result).toMatchObject({ status: 'gates-approved', plan: { productionScene: { selected: 'assembly', sources: 'assembly' } } });
  expect(calls.flat()).toContain('3');
});

test('preserves explicit assembly.scene precedence and records both scene sources', async () => {
  const { deps, calls } = sceneSourceDeps(conceptScene);
  const production = deps.production!;
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    production: { ...production, assembly: { ...production.assembly!, scene: explicitScene } },
  });

  expect(result).toMatchObject({ status: 'gates-approved', plan: { productionScene: { selected: 'assembly', sources: 'both' } } });
  expect(calls).not.toHaveLength(0);
  expect(calls.flat()).toContain('3');
});

test('skips assembly without synthesizing a scene when neither source is present', async () => {
  const { deps, calls } = sceneSourceDeps();
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, deps);

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for no-scene production input.');
  expect(result.plan.concept?.scene).toBeUndefined();
  expect(result.plan.productionScene).toBeUndefined();
  expect(result.productionReadiness).toContainEqual({ step: 'render', status: 'needs-input', missing: 'assembly scene' });
  expect(result.unwiredProduction).toContain('render');
  expect(calls).toEqual([]);
});

test('selects concept voiceover lines for TTS while retaining the production runner', async () => {
  const calls: string[][] = [];
  const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const { deps } = sceneSourceDeps(conceptScene);
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    generateConcept: { generate: () => ({ candidates: [{ hook: 'h1', angle: 'a1' }, { hook: 'h2', angle: 'a2' }], categoryForbiddenExpressions: [], tone: 'calm', scene: conceptScene, voiceover: { lines: [{ beatIndex: 0, text: 'concept narration', voiceId: 'voice-1' }] } }) },
    production: {
      ...deps.production!,
      voiceover: { lines: [], runner },
      soundtrack: runner,
      musicBedPath: '/assets/bed.wav',
      clips: { runner, workDir: '/sound' },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for concept voiceover production input.');
  expect(result.plan.productionVoiceover).toEqual({ selected: 'concept', sources: 'concept' });
  expect(calls.flat().join(' ')).toContain('concept narration');
  expect(calls.filter((argv) => argv.includes('--extract-elevenlabs-timestamps'))).toHaveLength(1);
});

test('records production voiceover precedence, missing runners, absent lines, and blocked concept voiceover', async () => {
  const run = async (conceptVoiceover: ConceptVoiceover | undefined, productionVoiceover: AdProductionDeps['voiceover'] | undefined) => {
    const { deps } = sceneSourceDeps(conceptScene);
    return runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      ...deps,
      generateConcept: { generate: () => ({ candidates: [{ hook: 'h1', angle: 'a1' }, { hook: 'h2', angle: 'a2' }], categoryForbiddenExpressions: [], tone: 'calm', scene: conceptScene, ...(conceptVoiceover ? { voiceover: conceptVoiceover } : {}) }) },
      production: { ...deps.production!, ...(productionVoiceover ? { voiceover: productionVoiceover } : {}) },
    });
  };

  const productionWins = await run(
    { lines: [{ beatIndex: 0, text: 'concept narration', voiceId: 'voice-1' }] },
    { lines: [{ beatIndex: 0, text: 'production narration', voiceId: 'voice-2' }] },
  );
  const missingRunner = await run(
    { lines: [{ beatIndex: 0, text: 'concept narration', voiceId: 'voice-1' }] },
    { lines: [] },
  );
  const absent = await run(undefined, { lines: [] });
  const blocked = await run({ blocked: 'voice-id-required' }, { lines: [] });

  if (productionWins.status !== 'gates-approved' || missingRunner.status !== 'gates-approved' || absent.status !== 'gates-approved' || blocked.status !== 'gates-approved') {
    throw new Error('Expected approved gates for voiceover provenance cases.');
  }
  expect(productionWins.plan.productionVoiceover).toEqual({ selected: 'production', sources: 'both', nonExecutionReason: 'voiceover-runner-missing' });
  expect(missingRunner.plan.productionVoiceover).toEqual({ selected: 'concept', sources: 'concept', nonExecutionReason: 'voiceover-runner-missing' });
  expect(absent.plan.productionVoiceover).toBeUndefined();
  expect(blocked.plan.productionVoiceover).toBeUndefined();
});

test('StepReadiness remains a discriminated model with status-specific evidence', () => {
  const examples: readonly StepReadiness[] = [
    { step: 'ground', status: 'wired', by: 'checklist' },
    { step: 'voiceover', status: 'needs-input', missing: 'script' },
    { step: 'render', status: 'unwired' },
  ];

  expect(examples.map((item) => item.status)).toEqual(['wired', 'needs-input', 'unwired']);
});

test('runs an injected shoot plan after gates with a selected scene and all planning dependencies', async () => {
  const submitted: number[] = [];
  const { deps } = sceneSourceDeps(conceptScene, false);
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    production: {
      ...deps.production!,
      cut: {
        submit: async (command) => { submitted.push(command.beatIndex); return `job-${command.beatIndex}`; },
        poll: async (jobId) => ({ status: 'completed', resultUrl: `https://clips.test/${jobId}.mp4` }),
      },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for wired shooting.');
  expect(submitted).toEqual([0]);
  expect(result.productionReadiness).toContainEqual({ step: 'cut', status: 'wired', by: 'shoot backend, duration rules, credits per second, reference assets, reference delivery, production scene' });
  expect(result.shootRun).toMatchObject({ completed: 1, failed: 0, unknown: 0, timedOut: [], blocked: 0 });
});

test('retains successful shoot results, probes them, and supplies materialized clips to assembly unless clips are explicit', async () => {
  const calls: string[][] = [];
  let probeSucceeds = true;
  const runner = {
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === 'ffprobe') {
        return probeSucceeds
          ? { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1', codec_name: 'h264' }] }), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const production = {
    cut: {
      submit: async (command: { readonly beatIndex: number }) => `job-${command.beatIndex}`,
      poll: async () => ({ status: 'completed', resultUrl: 'https://clips.test/generated.mp4' }),
    },
    durationRules: { model: { minimumSeconds: 2 } },
    creditsPerSecond: { model: 1 },
    referenceAssets: {},
    referenceDelivery: { model: { kind: 'repeated' as const, flag: '--image-references' } },
    shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
    render: runner,
    assembly: { scene: conceptScene, options: { workDir: '/assembly', outputName: 'master.mp4' } },
    shootClipRetention: { options: { workDir: '/retained', s3Available: true, now: '2026-09-11T12:00:00.000Z' }, runner },
  };

  const retained = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {}, production,
  });

  expect(retained.status).toBe('gates-approved');
  const download = calls.findIndex((argv) => argv[0] === 'curl');
  const probe = calls.findIndex((argv) => argv[0] === 'ffprobe');
  const render = calls.findIndex((argv) => argv[0] === 'ffmpeg');
  expect(download).toBeGreaterThanOrEqual(0);
  expect(probe).toBeGreaterThan(download);
  expect(render).toBeGreaterThan(probe);
  const downloadedPath = calls[download]![calls[download]!.indexOf('-o') + 1]!;
  expect(calls[render]).toContain(downloadedPath);
  if (retained.status !== 'gates-approved') throw new Error('Expected approved gates for retained clips.');
  expect(retained.unprobedClipBeats).toEqual([]);
  expect(retained.masterPath).toBe('/assembly/master.mp4');
  expect(retained.shootRun).toMatchObject({ completed: 1, failed: 0, unknown: 0 });
  expect(retained.unwiredProduction).toEqual(['ground', 'invariants', 'expand', 'voiceover', 'soundtrack']);
  expect(retained.productionReadiness).toContainEqual({ step: 'render', status: 'wired', by: 'render command runner, assembly scene' });

  calls.splice(0);
  probeSucceeds = false;
  const unprobed = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {}, production,
  });
  if (unprobed.status !== 'gates-approved') throw new Error('Expected approved gates for unprobed retained clips.');
  const failedProbeDownload = calls.findIndex((argv) => argv[0] === 'curl');
  const failedProbeRender = calls.findIndex((argv) => argv[0] === 'ffmpeg');
  const failedProbeQc = calls.findIndex((argv) => argv[0] === 'ffprobe' && argv.includes('/assembly/master.mp4'));
  expect(unprobed.unprobedClipBeats).toEqual([0]);
  expect(unprobed).not.toHaveProperty('masterPath');
  expect(unprobed.qc).toBeUndefined();
  expect(failedProbeDownload).toBeGreaterThanOrEqual(0);
  expect(failedProbeRender).toBe(-1);
  expect(failedProbeQc).toBe(-1);

  calls.splice(0);
  probeSucceeds = true;
  const explicit = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      ...production,
      assembly: { ...production.assembly, clips: [{ beatIndex: 0, path: '/explicit.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }] },
    },
  });

  if (explicit.status !== 'gates-approved') throw new Error('Expected approved gates for explicit clips.');
  expect(explicit).not.toHaveProperty('unprobedClipBeats');
  expect(calls.some((argv) => argv[0] === 'curl')).toBe(false);
  expect(calls.find((argv) => argv[0] === 'ffmpeg')).toContain('/explicit.mp4');
});

test('retains successful shoot clips before a sound failure without downloading them twice', async () => {
  const calls: string[][] = [];
  const runner = {
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1', codec_name: 'h264' }] }), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      cut: {
        submit: async (command) => `job-${command.beatIndex}`,
        poll: async () => ({ status: 'completed', resultUrl: 'https://clips.test/generated.mp4' }),
      },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
      shootClipRetention: { options: { workDir: '/retained', s3Available: true, now: '2026-09-11T12:00:00.000Z' }, runner },
      voiceover: { lines: [{ beatIndex: 0, text: 'hydrating serum', voiceId: 'voice-1' }], runner },
      soundtrack: runner,
      clips: { runner, workDir: '/sound' },
      assembly: { scene: conceptScene, options: { workDir: '/assembly', outputName: 'master.mp4' } },
      render: runner,
    },
  });

  expect(result).toMatchObject({
    status: 'gates-approved',
    blocked: ['sound: Sound plan blocked: Music bed path was not supplied; no loudnorm or ducking commands were planned.'],
    clips: [{ beatIndex: 0, path: expect.stringContaining('/retained/') }],
    unprobedClipBeats: [],
  });
  expect(calls.filter((argv) => argv[0] === 'curl')).toHaveLength(1);
  expect(calls.filter((argv) => argv[0] === 'ffprobe')).toHaveLength(1);
  expect(calls.some((argv) => argv[0] === 'ffmpeg')).toBe(false);
});

test('returns retained clips when a later clip download rejects', async () => {
  let downloads = 0;
  const runner = {
    run: async (argv: readonly string[]) => {
      if (argv[0] === 'curl') {
        downloads += 1;
        if (downloads === 2) throw new Error('download unavailable');
      }
      return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1', codec_name: 'h264' }] }), stderr: '', exitCode: 0 };
    },
  };
  const scene = { ...conceptScene, beats: [conceptScene.beats[0]!, { ...conceptScene.beats[0]!, startSec: 2, endSec: 4 }] };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      cut: {
        submit: async (command) => `job-${command.beatIndex}`,
        poll: async (jobId) => ({ status: 'completed', resultUrl: `https://clips.test/${jobId}.mp4` }),
      },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
      shootClipRetention: { options: { workDir: '/retained', s3Available: true, now: '2026-09-11T12:00:00.000Z' }, runner },
      render: runner,
      assembly: { scene, options: { workDir: '/assembly', outputName: 'master.mp4' } },
    },
  });

  expect(result).toMatchObject({
    status: 'gates-approved',
    blocked: ['clip-download: Clip download for beat 2 failed: download unavailable'],
    clips: [{ beatIndex: 0, path: expect.stringContaining('/retained/') }],
    unprobedClipBeats: [0],
  });
  expect(result).not.toHaveProperty('masterPath');
});

test('measures and assesses the authoritative assembled master without calibrated QC thresholds', async () => {
  const calls: string[][] = [];
  const runner = {
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === 'ffprobe' && argv.includes('/work/master.mp4')) {
        return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '4' } }), stderr: '', exitCode: 0 };
      }
      if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
      if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      render: runner,
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master' } },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for QC measurement.');
  const qcCalls = calls.filter((argv) => argv[0] === 'ffprobe' || argv.includes('volumedetect') || argv.includes('loudnorm=print_format=json'));
  expect(qcCalls).not.toHaveLength(0);
  expect(qcCalls.every((argv) => argv.includes('/work/master.mp4'))).toBe(true);
  expect(result.qc).toEqual(expect.objectContaining({
    verdict: 'unmeasured',
    automatedVerdict: 'unmeasured',
    manualReviewPending: ['finger-distortion', 'face-morphing', 'background-distortion', 'identity-consistency'],
    findings: expect.arrayContaining([
      // ⛔ #17724·#17726 이후 unmeasured 는 «사유»를 함께 낸다 — 정확 일치가 아니라 objectContaining 이다.
      expect.objectContaining({ name: 'dialogue-loudness', verdict: 'unmeasured' }),
    ]),
  }));
});

test('carries rawvideo samples through runQc into color-distance and rendered-content findings', async () => {
  const runner = {
    run: async (argv: readonly string[]) => {
      if (argv[0] === 'ffprobe') {
        return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '4' } }), stderr: '', exitCode: 0 };
      }
      if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
      if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
      if (argv.includes('rawvideo')) return { stdout: '\uFFFD\u001e(', stderr: '', exitCode: 0, raw: new Uint8Array([200, 30, 40]) };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      render: runner,
      qcThresholds: { colorDistance: 1 },
      assembly: {
        scene: {
          ...explicitScene,
          beats: [
            { ...explicitScene.beats[0], endSec: 2 },
            { ...explicitScene.beats[0], role: 'buildup', startSec: 2, endSec: 4 },
          ],
          axes: { ...explicitScene.axes, totalSeconds: 4 },
        },
        clips: [
          { beatIndex: 0, path: '/clip-0.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } },
          { beatIndex: 1, path: '/clip-1.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } },
        ],
        options: { workDir: '/work', outputName: 'master.mp4' },
      },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for rawvideo QC measurement.');
  expect(result.qc?.findings).toContainEqual(expect.objectContaining({ name: 'color-distance-between-cuts', verdict: 'ok' }));
  expect(result.qc?.findings).toContainEqual(expect.objectContaining({ name: 'rendered-content-presence', verdict: 'ok' }));
});

test('preserves independent QC measurements when one command fails and skips QC without assembly', async () => {
  const calls: string[][] = [];
  const runner = {
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv.includes('volumedetect')) return { stdout: '', stderr: 'volume failed', exitCode: 1 };
      if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-14.0"}', exitCode: 0 };
      if (argv[0] === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '4' } }), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const assembled = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      render: runner,
      qcThresholds: { dialogueLufsTolerance: 1 },
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master.mp4' } },
    },
  });
  if (assembled.status !== 'gates-approved') throw new Error('Expected approved gates for isolated QC failure.');
  expect(assembled.qc?.findings).toContainEqual(expect.objectContaining({ name: 'audio-peak', verdict: 'unmeasured' }));
  expect(assembled.qc?.findings).not.toContainEqual(expect.objectContaining({ name: 'dialogue-loudness', verdict: 'unmeasured' }));

  calls.splice(0);
  const skipped = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: { render: runner },
  });
  if (skipped.status !== 'gates-approved') throw new Error('Expected approved gates without clips.');
  expect(skipped.qc).toBeUndefined();
  expect(calls).toEqual([]);
});

test('reports a regenerate QC verdict without retrying the injected shoot backend, assembly, or QC commands', async () => {
  const calls: string[][] = [];
  const submitted: number[] = [];
  const polled: string[] = [];
  const runner = {
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === 'ffprobe') {
        return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '3' } }), stderr: '', exitCode: 0 };
      }
      if (argv.includes('volumedetect')) return { stdout: '', stderr: 'max_volume: -3.0 dB', exitCode: 0 };
      if (argv.includes('loudnorm=print_format=json')) return { stdout: '', stderr: '{"input_i":"-10.0"}', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      cut: {
        submit: async (command) => { submitted.push(command.beatIndex); return `job-${command.beatIndex}`; },
        poll: async (jobId) => { polled.push(jobId); return { status: 'completed' }; },
      },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
      render: runner,
      qcThresholds: { dialogueLufsTolerance: 1 },
      assembly: { scene: explicitScene, clips: [{ beatIndex: 0, path: '/clip.mp4', probe: { width: 1080, height: 1920, fps: '30/1', codec: 'h264', hasAudio: false } }], options: { workDir: '/work', outputName: 'master.mp4' } },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates for regenerate QC verdict.');
  expect(result.qc?.verdict).toBe('regenerate');
  const qcCalls = calls.filter((argv) => argv[0] === 'ffprobe' || argv.includes('volumedetect') || argv.includes('loudnorm=print_format=json'));
  const assemblyCalls = calls.filter((argv) => argv[0] === 'ffmpeg' && !argv.includes('volumedetect') && !argv.includes('loudnorm=print_format=json'));
  expect(submitted).toEqual([0]);
  expect(polled).toEqual(['job-0']);
  expect(qcCalls).toHaveLength(3);
    // ⛔ #17737 이 OCR 측정 단계를 더해 ffmpeg 호출이 하나 늘었다(5→6).
    //    ⭐ 수로 못박지 않고 «의미»로 단언한다 — 조립이 마스터를 만들고 재시도가 «없다»는 것이 이 시험의 본체다.
    expect(assemblyCalls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(assemblyCalls.map((argv) => argv.join(' '))).size).toBe(assemblyCalls.length);
});

test('skips assembly and QC when configured assembly has no usable clips', async () => {
  const calls: string[][] = [];
  const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true,
    stage: () => {},
    onGrounding: () => {},
    production: {
      render: runner,
      assembly: { scene: explicitScene, clips: [], options: { workDir: '/work', outputName: 'master.mp4' } },
    },
  });

  if (result.status !== 'gates-approved') throw new Error('Expected approved gates without usable assembly clips.');
  expect(result.qc).toBeUndefined();
  expect(calls).toEqual([]);
});

test('does not submit shooting without planning dependencies, a scene, or a cut backend', async () => {
  const submitted: number[] = [];
  const backend = { submit: async () => { submitted.push(1); return 'job-1'; }, poll: async () => ({ status: 'completed' }) };
  const planning = {
    durationRules: { model: { minimumSeconds: 2 } },
    creditsPerSecond: { model: 1 },
    referenceAssets: {},
    referenceDelivery: { model: { kind: 'repeated' as const, flag: '--image-references' } },
  };
  const missingPlanning = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {},
    production: { cut: backend, assembly: { scene: explicitScene, clips: [], options: { workDir: '/work', outputName: 'master.mp4' } } },
  });
  const missingDelivery = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {},
    production: { cut: backend, durationRules: planning.durationRules, creditsPerSecond: planning.creditsPerSecond, referenceAssets: planning.referenceAssets, assembly: { scene: explicitScene, clips: [], options: { workDir: '/work', outputName: 'master.mp4' } } },
  });
  const missingScene = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {}, production: { cut: backend, ...planning },
  });
  const missingCut = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    approve: () => true, stage: () => {}, onGrounding: () => {}, production: { ...planning, assembly: { scene: explicitScene, clips: [], options: { workDir: '/work', outputName: 'master.mp4' } } },
  });

  if (missingPlanning.status !== 'gates-approved' || missingDelivery.status !== 'gates-approved' || missingScene.status !== 'gates-approved' || missingCut.status !== 'gates-approved') throw new Error('Expected approved gates for unwired shooting.');
  expect(submitted).toEqual([]);
  expect(missingPlanning.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'duration rules' });
  expect(missingPlanning.unwiredProduction).toContain('cut');
  expect(missingDelivery.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'reference delivery' });
  expect(missingScene.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'production scene' });
  expect(missingScene.unwiredProduction).toContain('cut');
  expect(missingCut.productionReadiness).toContainEqual({ step: 'cut', status: 'needs-input', missing: 'shoot backend' });
  expect(missingPlanning.shootRun).toBeUndefined();
  expect(missingDelivery.shootRun).toBeUndefined();
  expect(missingScene.shootRun).toBeUndefined();
  expect(missingCut.shootRun).toBeUndefined();
});

test('reports completed, failed, timed-out, unknown, and blocked shoot outcomes without assembly integration', async () => {
  const scene: SceneSpec = {
    ...conceptScene,
    beats: [
      { ...conceptScene.beats[0], promptCore: 'completed', endSec: 2 },
      { ...conceptScene.beats[0], promptCore: 'failed', startSec: 2, endSec: 4 },
      { ...conceptScene.beats[0], promptCore: 'timed out', startSec: 4, endSec: 6 },
      { ...conceptScene.beats[0], promptCore: 'unknown', startSec: 6, endSec: 8 },
      { ...conceptScene.beats[0], promptCore: '', startSec: 8, endSec: 10 },
    ],
    axes: { ...conceptScene.axes, totalSeconds: 10 },
  };
  const { deps, calls } = sceneSourceDeps(scene, false);
  const { render: _render, assemblyMaterials: _assemblyMaterials, ...shootProduction } = deps.production!;
  const result = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...deps,
    mode: 'quality',
    production: {
      ...shootProduction,
      cut: {
        submit: async (command) => `job-${command.beatIndex}`,
        poll: async (jobId) => ({ status: ({ 'job-0': 'completed', 'job-1': 'failed', 'job-2': 'queued', 'job-3': 'mystery' } as Record<string, string>)[jobId] }),
      },
      durationRules: { model: { minimumSeconds: 2 } },
      creditsPerSecond: { model: 1 },
      referenceAssets: {},
      referenceDelivery: { model: { kind: 'repeated', flag: '--image-references' } },
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
    },
  });

  if (result.status !== 'gates-approved' || !result.shootRun) throw new Error('Expected shoot outcomes.');
  expect(result.shootRun).toMatchObject({ completed: 1, failed: 1, unknown: 1, timedOut: [2], blocked: 1 });
  expect(result.shootRun.completed + result.shootRun.failed + result.shootRun.unknown + result.shootRun.timedOut.length + result.shootRun.blocked).toBe(scene.beats.length);
  expect(calls).toEqual([]);
});

test('exposes partial, complete, and empty shoot pricing diagnostics without changing established result fields', async () => {
  const scene: SceneSpec = {
    ...conceptScene,
    beats: [
      { ...conceptScene.beats[0], model: 'priced', promptCore: 'priced beat' },
      { ...conceptScene.beats[0], role: 'buildup', model: 'unpriced', startSec: 2, endSec: 4, promptCore: 'unpriced beat' },
      { ...conceptScene.beats[0], role: 'climax', model: 'priced', startSec: 4, endSec: 6, promptCore: 'second priced beat' },
    ],
    axes: { ...conceptScene.axes, totalSeconds: 6 },
  };
  const run = async (creditsPerSecond: Readonly<Record<string, number>>) => {
    const { deps } = sceneSourceDeps(scene, false);
    return runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
      ...deps,
      mode: 'quality',
      production: {
        ...deps.production!,
        cut: {
          submit: async (command) => `job-${command.beatIndex}`,
          poll: async () => ({ status: 'completed' }),
        },
        durationRules: { priced: { minimumSeconds: 2 }, unpriced: { minimumSeconds: 2 } },
        creditsPerSecond,
        referenceAssets: {},
        referenceDelivery: {
          priced: { kind: 'repeated', flag: '--image-references' },
          unpriced: { kind: 'repeated', flag: '--image-references' },
        },
        shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
      },
    });
  };

  const partial = await run({ priced: 1 });
  const complete = await run({ priced: 1, unpriced: 2 });
  const empty = await run({});
  if (partial.status !== 'gates-approved' || complete.status !== 'gates-approved' || empty.status !== 'gates-approved') throw new Error('Expected approved gates for shoot pricing diagnostics.');

  expect(partial.unpriced).toEqual([{ beatIndex: 1, name: 'Beat 2', reason: 'No credit rate is configured for unpriced.' }]);
  expect(complete.unpriced).toEqual([]);
  expect(empty.unpriced).toEqual([
    { beatIndex: 0, name: 'Beat 1', reason: 'No credit rate is configured for priced.' },
    { beatIndex: 1, name: 'Beat 2', reason: 'No credit rate is configured for unpriced.' },
    { beatIndex: 2, name: 'Beat 3', reason: 'No credit rate is configured for priced.' },
  ]);

  const planOptions = {
    mode: 'quality' as const,
    durationRules: { priced: { minimumSeconds: 2 }, unpriced: { minimumSeconds: 2 } },
    referenceAssets: {},
    referenceDelivery: {
      priced: { kind: 'repeated' as const, flag: '--image-references' },
      unpriced: { kind: 'repeated' as const, flag: '--image-references' },
    },
  };
  expect(buildShootPlan(scene, { ...planOptions, creditsPerSecond: { priced: 1 } }).totalEstimatedCredits).toBeUndefined();
  expect(buildShootPlan(scene, { ...planOptions, creditsPerSecond: {} }).totalEstimatedCredits).toBeUndefined();
  expect(buildShootPlan(scene, { ...planOptions, creditsPerSecond: { priced: 1, unpriced: 2 } }).totalEstimatedCredits).toBe(8);

  const durationUnavailable = await runAdPipeline({ kind: 'text', brief: 'serum campaign' }, {
    ...sceneSourceDeps(scene, false).deps,
    mode: 'quality',
    production: {
      ...sceneSourceDeps(scene, false).deps.production!,
      cut: { submit: async (command) => `job-${command.beatIndex}`, poll: async () => ({ status: 'completed' }) },
      durationRules: { priced: { minimumSeconds: 2 } },
      creditsPerSecond: { priced: 1, unpriced: 2 },
      referenceAssets: {},
      referenceDelivery: planOptions.referenceDelivery,
      shootRunOptions: { submitStaggerMs: 0, submitRetries: 0, maxPollsPerJob: 1 },
    },
  });
  if (durationUnavailable.status !== 'gates-approved') throw new Error('Expected approved gates for an unavailable duration estimate.');
  expect(durationUnavailable.unpriced).toEqual([{ beatIndex: 1, name: 'Beat 2', reason: 'No duration rule is configured for unpriced.' }]);

  const blockedBeatTenPlan = {
    ...buildShootPlan(scene, { ...planOptions, creditsPerSecond: {} }),
    blocked: ['empty-prompt:beat-10'],
  };
  expect(unpricedReason(blockedBeatTenPlan, scene, planOptions.durationRules, 0)).toBe('No credit rate is configured for priced.');
  expect(unpricedReason(blockedBeatTenPlan, scene, planOptions.durationRules, 9)).toBe('empty-prompt:beat-10');

  const planBlocked = {
    ...buildShootPlan(scene, { ...planOptions, creditsPerSecond: {} }),
    blocked: [
      'empty-prompt:beat-1',
      'mode-cut-limit-exceeded:quality:2',
      'invalid-min-generatable-seconds',
    ],
  };
  expect(unpricedReason(planBlocked, scene, planOptions.durationRules, 0)).toBe('empty-prompt:beat-1');
  expect(unpricedReason(planBlocked, scene, planOptions.durationRules, 1)).toBe('mode-cut-limit-exceeded:quality:2');

  const invalidMinimumPlan = {
    ...buildShootPlan(scene, { ...planOptions, creditsPerSecond: {} }),
    blocked: ['invalid-min-generatable-seconds'],
  };
  expect(unpricedReason(invalidMinimumPlan, scene, planOptions.durationRules, 1)).toBe('invalid-min-generatable-seconds');

  expect(partial.status).toBe('gates-approved');
  expect(partial.unwiredProduction).toEqual(['ground', 'expand', 'voiceover', 'soundtrack']);
  expect(partial.masterPath).toBeUndefined();
  expect(partial.qc).toBeUndefined();
});
