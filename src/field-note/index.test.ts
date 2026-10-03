import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignFieldNote, generateFieldNote, renderFieldNote, type FieldPhoto, type TranscriptEntry } from './index';

describe('field-note timeline and Markdown', () => {
  test('two-hour JSON transcript and 30 photos form scenes with each photo in its correct time cluster', async () => {
    const photos: FieldPhoto[] = Array.from({ length: 30 }, (_, i) => ({
      file: `photos/p ${i + 1}.jpg`,
      exifTakenAt: `2026:09:30 ${String(9 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 10).padStart(2, '0')}:00`,
    }));
    const entries: TranscriptEntry[] = Array.from({ length: 25 }, (_, i) => ({
      speaker: i % 2 ? 'B' : 'A',
      timestamp: `2026-09-30T${String(9 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}:00`,
      text: `utterance ${i}`,
    }));
    const original = JSON.stringify({ photos, entries });
    const timeline = alignFieldNote(photos, entries);
    expect(timeline.scenes).toHaveLength(3);
    expect(timeline.scenes.map((scene) => scene.photos.length)).toEqual([10, 10, 10]);
    expect(timeline.scenes.map((scene) => scene.photos.map((photo) => photo.file))).toEqual([
      photos.slice(0, 10).map((photo) => photo.file),
      photos.slice(10, 20).map((photo) => photo.file),
      photos.slice(20, 30).map((photo) => photo.file),
    ]);
    expect(timeline.scenes[0]!.photos[0]!.takenAt).toBe('2026-09-30T00:00:00.000Z');
    expect(timeline.scenes[1]!.photos[0]!.takenAt).toBe('2026-09-30T01:00:00.000Z');
    expect(timeline.scenes[2]!.photos[0]!.takenAt).toBe('2026-09-30T02:00:00.000Z');
    // Nearest photo span: 09:35 is closer to 10:00 than to 09:09, 10:35 closer to 11:00 than to 10:09.
    expect(timeline.scenes.map((scene) => scene.transcript.length)).toEqual([7, 12, 6]);
    expect(timeline.scenes[0]!.transcript[0]!.timestamp).toBe('2026-09-30T09:00:00');
    expect(timeline.scenes[2]!.transcript.at(-1)!.timestamp).toBe('2026-09-30T11:00:00');
    expect(timeline.scenes[1]!.transcript[0]!.timestamp).toBe('2026-09-30T09:35:00');
    expect(timeline.scenes[1]!.transcript[0]!.speaker).toBe('B');
    expect(JSON.stringify({ photos, entries })).toBe(original);

    const calls: string[][] = [];
    const note = await generateFieldNote(photos, entries, {
      summarize: async (segment) => {
        calls.push(segment.map((entry) => entry.text));
        return `Summary ${calls.length}`;
      },
      transcribe: async () => { throw new Error('JSON transcript must not be transcribed'); },
    });
    expect(calls.map((segment) => segment.length)).toEqual([7, 12, 6]);
    expect(note.match(/^## 장면 /gm)).toHaveLength(3);
    expect(note.match(/!\[/g)).toHaveLength(30);
    expect(note).toContain('2026-09-30 09:00 UTC+09:00');
    expect(note).toContain('Summary 2');
    const markdownScenes = note.split(/^## 장면 \d+ /m).slice(1);
    expect(markdownScenes).toHaveLength(3);
    markdownScenes.forEach((section, sceneIndex) => {
      for (let i = 1; i <= 30; i++) {
        expect(section.includes(`](<photos/p%20${i}.jpg>)`)).toBe(Math.floor((i - 1) / 10) === sceneIndex);
      }
    });
  });

  test('photo correction shifts clustering, accepts offset timestamps and keeps undated images separate', () => {
    const timeline = alignFieldNote([
      { file: 'late.jpg', exifTakenAt: '2026:09:30 10:00:00' },
      { file: 'no-exif.jpg' },
      { file: 'broken.jpg', exifTakenAt: '2026:02:30 10:00:00' },
      { file: 'invalid-offset.jpg', exifTakenAt: '2026-02-30T10:00:00+09:00' },
      { file: 'early.jpg', exifTakenAt: '2026-09-30T09:00:00+09:00' },
    ], [{ speaker: 'A', timestamp: '2026-09-30T09:55:00+09:00', text: 'near late' }],
    { photoCorrectionMinutes: -60 });
    expect(timeline.scenes).toHaveLength(2);
    expect(timeline.scenes[0]!.photos[0]!.file).toBe('early.jpg');
    expect(timeline.scenes[1]!.photos[0]!.takenAt).toBe('2026-09-30T00:00:00.000Z');
    expect(timeline.scenes[1]!.transcript[0]!.text).toBe('near late');
    expect(timeline.undatedPhotos.map((photo) => photo.file)).toEqual(['no-exif.jpg', 'broken.jpg', 'invalid-offset.jpg']);
    const note = renderFieldNote(timeline);
    expect(note).toContain('_(전사 요약 자리)_');
    expect(note).toContain('## 시각 없음\n\n- 시각 없음 ![no-exif.jpg](<no-exif.jpg>)');
    expect(note).toContain('![broken.jpg](<broken.jpg>)');
    expect(note).toContain('![invalid-offset.jpg](<invalid-offset.jpg>)');
  });

  test('an utterance joins the scene whose photos are nearest in time, not the earlier scene by boundary', () => {
    const timeline = alignFieldNote([
      { file: 'nine.jpg', exifTakenAt: '2026-09-30T09:00:00+09:00' },
      { file: 'eleven.jpg', exifTakenAt: '2026-09-30T11:00:00+09:00' },
    ], [
      { speaker: 'A', timestamp: '2026-09-30T09:05:00+09:00', text: 'after nine' },
      { speaker: 'B', timestamp: '2026-09-30T10:55:00+09:00', text: 'before eleven' },
      { speaker: 'C', timestamp: '2026-09-30T10:00:00+09:00', text: 'exact middle' },
    ]);
    expect(timeline.scenes).toHaveLength(2);
    expect(timeline.scenes[0]!.transcript.map((entry) => entry.text)).toEqual(['after nine', 'exact middle']);
    expect(timeline.scenes[1]!.transcript.map((entry) => entry.text)).toEqual(['before eleven']);
  });

  test('offset-free fractional seconds survive alignment and split photos beyond the exact gap', () => {
    const timeline = alignFieldNote([
      { file: 'first.jpg', exifTakenAt: '2026:09:30 09:00:00.900' },
      { file: 'second.jpg', exifTakenAt: '2026-09-30T09:15:00.950' },
    ], [{ speaker: 'A', timestamp: '2026-09-30T09:15:00.925', text: 'between photos' }]);
    expect(timeline.scenes).toHaveLength(2);
    expect(timeline.scenes.map((scene) => scene.photos[0]!.takenAt)).toEqual([
      '2026-09-30T00:00:00.900Z', '2026-09-30T00:15:00.950Z',
    ]);
    expect(timeline.scenes.map((scene) => scene.transcript.map((entry) => entry.text)))
      .toEqual([[], ['between photos']]);
  });

  test('photo-free transcript stays chronological and is summarized without inventing a photo scene', async () => {
    const entries: TranscriptEntry[] = [
      { speaker: 'B', timestamp: '2026-09-30T11:00:00', text: 'later' },
      { speaker: 'A', timestamp: '2026-09-30T09:00:00', text: 'earlier' },
    ];
    const timeline = alignFieldNote([{ file: 'undated.jpg' }], entries);
    expect(timeline.scenes).toEqual([]);
    expect(timeline.transcriptWithoutPhotos).toEqual([entries[1], entries[0]]);
    expect(renderFieldNote(timeline)).toContain('## 사진 없는 전사\n\n### 전사 요약\n_(전사 요약 자리)_');
    const summarized: string[][] = [];
    const note = await generateFieldNote([{ file: 'undated.jpg' }], entries, {
      summarize: async (segment) => {
        summarized.push(segment.map((entry) => entry.text));
        return 'Summary of the day';
      },
    });
    expect(summarized).toEqual([['earlier', 'later']]);
    expect(note).toContain('Summary of the day');
    expect(note.indexOf('A: earlier')).toBeLessThan(note.indexOf('B: later'));
    expect(note).toContain('## 시각 없음\n\n- 시각 없음 ![undated.jpg]');
    expect((await generateFieldNote([], entries))).toContain('A: earlier');
  });

  test('invalid offset ISO transcript dates are rejected rather than normalized', () => {
    expect(() => alignFieldNote([], [
      { speaker: 'A', timestamp: '2026-02-30T10:00:00+09:00', text: 'impossible' },
    ])).toThrow('Invalid transcript timestamp');
  });

  test('timezone override changes interpretation and display without relying on host timezone', () => {
    const timeline = alignFieldNote([{ file: 'a.jpg', exifTakenAt: '2026:01:01 12:00:00' }],
      [{ speaker: 'S', timestamp: '2026-01-01T12:00:00', text: 'hi' }],
      { timeZoneOffsetMinutes: -300 });
    expect(timeline.scenes[0]!.photos[0]!.takenAt).toBe('2026-01-01T17:00:00.000Z');
    expect(timeline.scenes[0]!.transcript[0]!.text).toBe('hi');
    expect(renderFieldNote(timeline)).toContain('2026-01-01 12:00 UTC-05:00');
  });

  test('photo-only scenes retain summary placeholders without passing an empty segment to the injected summarizer', async () => {
    const calls: string[][] = [];
    const note = await generateFieldNote([
      { file: 'first.jpg', exifTakenAt: '2026:09:30 09:00:00' },
      { file: 'second.jpg', exifTakenAt: '2026:09:30 11:00:00' },
    ], [{ speaker: 'A', timestamp: '2026-09-30T09:05:00', text: 'first scene only' }], {
      summarize: async (entries) => {
        if (entries.length === 0) throw new Error('empty transcript rejected');
        calls.push(entries.map((entry) => entry.text));
        return 'First summary';
      },
    });
    expect(calls).toEqual([['first scene only']]);
    const sections = note.split(/^## 장면 \d+ /m).slice(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('First summary');
    expect(sections[1]).toContain('_(전사 요약 자리)_');
    expect(sections[1]).toContain('![second.jpg](<second.jpg>)');
  });

  test('Markdown photo links resolve actual filenames containing # and ? rather than URL fragments or queries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'field-note-photo-'));
    try {
      const names = ['photo#1.jpg', 'photo?2.jpg'];
      for (const name of names) writeFileSync(join(dir, name), 'photo');
      const note = renderFieldNote(alignFieldNote(names.map((file, i) => ({
        file: join(dir, file),
        exifTakenAt: `2026:09:30 09:0${i}:00`,
      })), []));
      const links = [...note.matchAll(/!\[[^\]]+\]\(<([^>]+)>\)/g)].map((match) => match[1]!);
      expect(links).toHaveLength(2);
      expect(links[0]).toContain('photo%231.jpg');
      expect(links[1]).toContain('photo%3F2.jpg');
      for (const link of links) {
        expect(link).not.toMatch(/[?#]/);
        expect(existsSync(decodeURIComponent(link))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('raw transcription is injected and errors on missing injection or invalid JSON timestamps', async () => {
    const transcript: TranscriptEntry[] = [{ speaker: 'A', timestamp: '2026-01-01T12:00:00Z', text: 'hello' }];
    const note = await generateFieldNote([{ file: 'a.jpg', exifTakenAt: '2026-01-01T12:00:00Z' }], 'audio', {
      transcribe: async (raw) => {
        expect(raw).toBe('audio');
        return transcript;
      },
      summarize: async (segment) => {
        expect(segment).toEqual(transcript);
        return 'Injected summary';
      },
    });
    expect(note).toContain('Injected summary');
    expect(note).toContain('![a.jpg](<a.jpg>)');
    expect(() => alignFieldNote([], [{ speaker: 'A', timestamp: 'bad', text: 'x' }])).toThrow('Invalid transcript timestamp');
    await expect(generateFieldNote([], 'audio')).rejects.toThrow('transcribe dependency');
    expect(() => alignFieldNote([], [], { sceneGapMinutes: -1 })).toThrow(RangeError);
  });
});
