import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TrackEntry = { id: string; mark: string; owns: string[]; alias?: string };

// Seat ids became two letters on 09-30 (#22085) with the old one-letter id kept as `alias`.
// A track named either way is the same seat — posts and inputs still carry the old letter during the switch.
export function findTrack(idOrAlias: string, registry: TrackEntry[] = loadTrackRegistry()): TrackEntry | undefined {
  return registry.find((track) => track.id === idOrAlias || track.alias === idOrAlias);
}
export function trackPostIds(idOrAlias: string, registry: TrackEntry[] = loadTrackRegistry()): string[] {
  const track = findTrack(idOrAlias, registry);
  return [...new Set([idOrAlias, ...(track ? [track.id, ...(track.alias ? [track.alias] : [])] : [])])];
}

export function loadTrackRegistry(path = resolve(import.meta.dir, '../../scripts/coord-tracks.json')): TrackEntry[] {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || !('tracks' in data) || !Array.isArray(data.tracks)) return [];
    return data.tracks.filter((track: unknown): track is TrackEntry =>
      track !== null && typeof track === 'object' &&
      'id' in track && typeof track.id === 'string' &&
      'mark' in track && typeof track.mark === 'string' &&
      'owns' in track && Array.isArray(track.owns) && track.owns.every((word: unknown) => typeof word === 'string'));
  } catch {
    return [];
  }
}

export function inferPhaseTrack(text: string, registry: TrackEntry[]): {
  track: string | null;
  mark: string | null;
  hits: Record<string, number>;
  reason: 'keyword' | 'tie' | 'none';
} {
  const lower = text.toLocaleLowerCase();
  const hits: Record<string, number> = {};
  let max = 0;
  for (const entry of registry) {
    let count = 0;
    for (const word of entry.owns) {
      const needle = word.toLocaleLowerCase();
      if (!needle) continue;
      let from = 0;
      const english = /[a-z]/i.test(needle);
      while (true) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        const before = lower[index - 1] ?? '';
        const after = lower[index + needle.length] ?? '';
        if (!english || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) count++;
        from = index + needle.length;
      }
    }
    hits[entry.id] = count;
    max = Math.max(max, count);
  }
  if (!max) return { track: null, mark: null, hits, reason: 'none' };
  const winners = registry.filter((entry) => hits[entry.id] === max);
  if (winners.length !== 1) return { track: null, mark: null, hits, reason: 'tie' };
  return { track: winners[0]!.id, mark: winners[0]!.mark, hits, reason: 'keyword' };
}
