import { expect, test } from 'bun:test';
import { groupVoiceNotes, memberMediaStorageKey } from './voice-note-library';

test('groups by recording-local date, keeps class date separate, and orders media offsets', () => {
  const groups = groupVoiceNotes([
    { id: 'a', kind: 'voice', createdAt: '2026-11-12T02:00:00Z', raw: { recordedAt: '2026-11-11T15:30:00.000Z', recordedDate: '2026-11-12', classDate: '2026-11-10', timeline: [
      { t: 2400, kind: 'photo', mediaRef: 'photo', mime: 'image/jpeg' }, { t: 1200, kind: 'marker', label: '마커' },
      { t: 0, kind: 'voice', mediaRef: 'voice', mime: 'audio/mp4' },
    ] } },
    { id: 'b', kind: 'voice', createdAt: '2026-11-13T00:00:00Z', raw: { recordedAt: '2026-11-11T23:00:00.000Z', recordedDate: '2026-11-12' } },
    { id: 'other', kind: 'text', createdAt: '2026-11-13T00:00:00Z', raw: {} },
  ]);
  expect(groups.map((group) => group.day)).toEqual(['2026-11-12']);
  expect(groups[0]?.notes.map((note) => note.id)).toEqual(['b', 'a']);
  expect(groups[0]?.notes[1]?.raw.classDate).toBe('2026-11-10');
  expect(groups[0]?.notes[1]?.raw.timeline?.map((entry) => entry.kind)).toEqual(['voice', 'marker', 'photo']);
});

test('media playback only requests a key in the verified member namespace', () => {
  expect(memberMediaStorageKey('member-a/scraps/voice-1/timeline/0.m4a', 'member-a')).toBe('scraps/voice-1/timeline/0.m4a');
  expect(memberMediaStorageKey('member-b/scraps/voice-1/timeline/0.m4a', 'member-a')).toBeNull();
  expect(memberMediaStorageKey('member-a/scraps/../secret', 'member-a')).toBeNull();
});

test('marker and photo timeline still exposes the original voice recording once', () => {
  const [group] = groupVoiceNotes([{ id: 'voice-1', kind: 'voice', createdAt: '2026-11-13T00:00:00Z',
    raw: { mediaRef: 'member-a/scraps/audio-1', mime: 'audio/m4a', timeline: [
      { t: 4000, kind: 'marker', label: '핵심' },
      { t: 5000, kind: 'photo', mediaRef: 'member-a/scraps/photo-1', mime: 'image/jpeg' },
    ] } }]);
  expect(group?.notes[0]?.raw.timeline).toEqual([
    { t: 0, kind: 'voice', mediaRef: 'member-a/scraps/audio-1', mime: 'audio/m4a' },
    { t: 4000, kind: 'marker', label: '핵심' },
    { t: 5000, kind: 'photo', mediaRef: 'member-a/scraps/photo-1', mime: 'image/jpeg' },
  ]);
  expect(group?.notes[0]?.raw.timeline?.filter((entry) => entry.kind === 'voice')).toHaveLength(1);
});
