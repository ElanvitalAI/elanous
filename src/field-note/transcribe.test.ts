import { describe, expect, test } from 'bun:test';
import {
  createCloudSttEngine, createLocalWhisperEngine, splitAudioIntoChunks, transcribeFieldAudio,
  type FieldAudio, type TranscriptionEngine,
} from './transcribe';

const recording: FieldAudio = {
  samples: Float32Array.from({ length: 100 }, (_, index) => index), sampleRate: 10,
  recordedAt: '2026-09-30T09:00:00+09:00',
};

describe('field audio transcription', () => {
  test('splits by sample boundaries with overlap but no empty trailing chunk', () => {
    const chunks = splitAudioIntoChunks(recording, { chunkSeconds: 4, overlapSeconds: 1 });
    expect(chunks.map(({ startSeconds, samples }) => [startSeconds, samples.length])).toEqual([
      [0, 40], [3, 40], [6, 40],
    ]);
    expect(Array.from(chunks[1]!.samples.slice(0, 10))).toEqual(Array.from(recording.samples.slice(30, 40)));
    expect(splitAudioIntoChunks({ ...recording, samples: recording.samples.slice(0, 80) },
      { chunkSeconds: 4, overlapSeconds: 1 }).map(({ startSeconds, samples }) => [startSeconds, samples.length]))
      .toEqual([[0, 40], [3, 40], [6, 20]]);
    expect(splitAudioIntoChunks({ ...recording, samples: new Float32Array() })).toEqual([]);
    expect(splitAudioIntoChunks(recording, { chunkSeconds: 4, overlapSeconds: 0 })
      .map(({ startSeconds, samples }) => [startSeconds, samples.length]))
      .toEqual([[0, 40], [4, 40], [8, 20]]);
    expect(() => splitAudioIntoChunks(recording, { chunkSeconds: 1, overlapSeconds: 1 })).toThrow(RangeError);
    expect(() => splitAudioIntoChunks(recording, { chunkSeconds: 0.01, overlapSeconds: 0.001 })).toThrow(RangeError);
  });

  test('stitches an overlapped utterance once while retaining repeated speech outside overlap and labels', async () => {
    const calls: Array<{ offset: number; language: string; task: string }> = [];
    const engine: TranscriptionEngine = {
      async transcribe(chunk, request) {
        calls.push({ offset: chunk.startSeconds, ...request });
        if (chunk.startSeconds === 0) return [
          { startSeconds: 1, endSeconds: 1.6, text: '안녕하세요', speaker: '가' },
          { startSeconds: 3.2, endSeconds: 3.8, text: '겹친 말', speaker: '나' },
        ];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.21, endSeconds: 0.81, text: ' 겹친 말 ', speaker: '나' },
          { startSeconds: 2, endSeconds: 2.4, text: '안녕하세요', speaker: '가' },
        ];
        if (chunk.startSeconds === 6) return [{ startSeconds: 1, endSeconds: 1.5, text: '미확인' }];
        return [];
      },
    };
    const entries = await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1, defaultSpeaker: '화자 1' });
    expect(calls).toEqual([0, 3, 6].map((offset) => ({ offset, language: 'ko', task: 'transcribe' })));
    expect(entries).toEqual([
      { timestamp: '2026-09-30T00:00:01.000Z', speaker: '가', text: '안녕하세요' },
      { timestamp: '2026-09-30T00:00:03.200Z', speaker: '나', text: '겹친 말' },
      // Chunk 2's «가» never matched chunk 1's speech in the overlap — it is a chunk-scoped ID, so it stays qualified.
      { timestamp: '2026-09-30T00:00:05.000Z', speaker: '가 · 구간 2', text: '안녕하세요' },
      { timestamp: '2026-09-30T00:00:07.000Z', speaker: '화자 1', text: '미확인' },
    ]);
  });

  test('deduplicates the same overlapping utterance despite different chunk-local speaker IDs', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [
          { startSeconds: 3.2, endSeconds: 3.8, text: '같은 발화', speaker: 'A' },
        ];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.25, endSeconds: 0.85, text: '같은 발화', speaker: 'B' },
          { startSeconds: 2, endSeconds: 2.4, text: '같은 발화', speaker: 'B' },
        ];
        return [];
      },
    };
    expect(await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1 })).toEqual([
      // Chunk 2's «B» matched chunk 1's «A» in the overlap — one person, one label (NOTE3a review must-fix).
      { timestamp: '2026-09-30T00:00:03.200Z', speaker: 'A', text: '같은 발화' },
      { timestamp: '2026-09-30T00:00:05.000Z', speaker: 'A', text: '같은 발화' },
    ]);
  });

  test('preserves unknown speaker unless the caller explicitly provides a default', async () => {
    const engine: TranscriptionEngine = {
      transcribe: async () => [{ startSeconds: 0, endSeconds: 0.4, text: '미확인' }],
    };
    const audio = { ...recording, samples: recording.samples.slice(0, 10) };
    expect(await transcribeFieldAudio(audio, engine)).toEqual([
      { timestamp: '2026-09-30T00:00:00.000Z', speaker: '화자 미상', text: '미확인' },
    ]);
    expect(await transcribeFieldAudio(audio, engine, { defaultSpeaker: '안내자' })).toEqual([
      { timestamp: '2026-09-30T00:00:00.000Z', speaker: '안내자', text: '미확인' },
    ]);
  });

  test('stitches partial boundary words only in shared audio, keeping same words elsewhere', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [
          { startSeconds: 1, endSeconds: 1.4, text: '학교', speaker: 'A' },
          { startSeconds: 3.1, endSeconds: 3.9, text: '오늘은 학교', speaker: 'A' },
        ];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.2, endSeconds: 0.8, text: '학교에 갔다', speaker: 'A' },
        ];
        return [];
      },
    };
    expect(await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1 })).toEqual([
      { timestamp: '2026-09-30T00:00:01.000Z', speaker: 'A', text: '학교' },
      { timestamp: '2026-09-30T00:00:03.100Z', speaker: 'A', text: '오늘은 학교에 갔다' },
    ]);
  });

  test('stitches a single boundary-spanning detection against both earlier segments', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [
          { startSeconds: 3.1, endSeconds: 3.45, text: '안녕하세요', speaker: '가' },
          { startSeconds: 3.46, endSeconds: 3.9, text: '오늘은', speaker: '가' },
        ];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.12, endSeconds: 0.89, text: '안녕하세요 오늘은', speaker: '가' },
        ];
        return [];
      },
    };
    expect(await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1 })).toEqual([
      { timestamp: '2026-09-30T00:00:03.100Z', speaker: '가', text: '안녕하세요 오늘은' },
    ]);
  });

  test('stitches one earlier segment against two later boundary detections', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [
          { startSeconds: 3.1, endSeconds: 3.9, text: '안녕하세요 오늘은', speaker: '가' },
        ];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.12, endSeconds: 0.45, text: '안녕하세요', speaker: '가' },
          { startSeconds: 0.46, endSeconds: 0.89, text: '오늘은', speaker: '가' },
        ];
        return [];
      },
    };
    expect(await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1 })).toEqual([
      { timestamp: '2026-09-30T00:00:03.100Z', speaker: '가', text: '안녕하세요 오늘은' },
    ]);
  });

  test('zero-overlap chunks do not merge speech at their shared edge', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [{ startSeconds: 3.8, endSeconds: 4, text: '네', speaker: 'A' }];
        if (chunk.startSeconds === 4) return [{ startSeconds: 0, endSeconds: 0.2, text: '네', speaker: 'A' }];
        return [];
      },
    };
    expect((await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 0 }))
      .map((entry) => entry.timestamp)).toEqual([
      '2026-09-30T00:00:03.800Z', '2026-09-30T00:00:04.000Z',
    ]);
  });

  test('local and cloud adapters forward Korean-first request and preserve timestamp/diarization output', async () => {
    const localInputs: unknown[] = [];
    const cloudInputs: unknown[] = [];
    const segment = [{ startSeconds: 0, endSeconds: 0.4, speaker: 'A', text: '여기' }];
    const local = createLocalWhisperEngine({ transcribe: async (input) => { localInputs.push(input); return segment; } });
    const cloud = createCloudSttEngine({ transcribe: async (input) => { cloudInputs.push(input); return segment; } });
    expect(await transcribeFieldAudio({ ...recording, samples: recording.samples.slice(0, 10) }, local))
      .toEqual([{ speaker: 'A', timestamp: '2026-09-30T00:00:00.000Z', text: '여기' }]);
    expect(await transcribeFieldAudio({ ...recording, samples: recording.samples.slice(0, 10) }, cloud, { language: 'en' }))
      .toEqual([{ speaker: 'A', timestamp: '2026-09-30T00:00:00.000Z', text: '여기' }]);
    expect(localInputs).toEqual([{ audio: expect.any(Float32Array), sampleRate: 10, language: 'ko', task: 'transcribe' }]);
    expect(cloudInputs).toEqual([{ audio: expect.any(Float32Array), sampleRate: 10, language: 'en', timestamps: true, diarization: true }]);
  });

  test('rejects invalid absolute capture time and out-of-bounds segment times', async () => {
    const fake: TranscriptionEngine = { transcribe: async () => [{ startSeconds: 0, endSeconds: 100, text: 'invalid' }] };
    expect(() => splitAudioIntoChunks({ ...recording, recordedAt: '2026-09-30T09:00:00' })).toThrow('timezone offset');
    await expect(transcribeFieldAudio(recording, fake)).rejects.toThrow('Invalid transcription segment times');
  });

  test('a segment ending even slightly after its chunk audio is rejected (10 Hz · 1 s chunk · 1.05–1.08 s)', async () => {
    const tiny: FieldAudio = { ...recording, samples: new Float32Array(10), sampleRate: 10 };
    const engine: TranscriptionEngine = { async transcribe() { return [{ startSeconds: 1.05, endSeconds: 1.08, text: '밖', speaker: 'A' }]; } };
    await expect(transcribeFieldAudio(tiny, engine, { chunkSeconds: 1, overlapSeconds: 0 })).rejects.toThrow('Invalid transcription segment times');
    const exact: TranscriptionEngine = { async transcribe() { return [{ startSeconds: 0.5, endSeconds: 1, text: '끝', speaker: 'A' }]; } };
    expect(await transcribeFieldAudio(tiny, exact, { chunkSeconds: 1, overlapSeconds: 0 })).toHaveLength(1);
  });

  test('a chunk-local ID reused by a different person in a later chunk does not merge with the earlier speaker', async () => {
    const engine: TranscriptionEngine = {
      async transcribe(chunk) {
        if (chunk.startSeconds === 0) return [{ startSeconds: 3.2, endSeconds: 3.8, text: '겹친 말', speaker: 'A' }];
        if (chunk.startSeconds === 3) return [
          { startSeconds: 0.21, endSeconds: 0.81, text: '겹친 말', speaker: 'B' },
          { startSeconds: 2, endSeconds: 2.4, text: '다른 사람 말', speaker: 'A' },
        ];
        return [];
      },
    };
    const entries = await transcribeFieldAudio(recording, engine, { chunkSeconds: 4, overlapSeconds: 1 });
    expect(entries.map(({ speaker, text }) => [speaker, text])).toEqual([['A', '겹친 말'], ['A · 구간 2', '다른 사람 말']]);
  });
});
