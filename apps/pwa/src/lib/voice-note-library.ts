export type VoiceTimelineEntry =
  | { t: number; kind: 'voice' | 'photo' | 'video'; mediaRef: string; mime: string }
  | { t: number; kind: 'marker'; label: string };
export interface VoiceNote {
  id: string;
  kind: string;
  createdAt: string;
  status?: string;
  folderId?: string | null;
  exports?: { vaultId: string; path: string; savedAt: string }[];
  card?: { title?: string; points?: string[] };
  failure?: { stage: string; reason: string };
  raw: { text?: string; mediaRef?: string; mime?: string; recordedAt?: string; recordedDate?: string; recordedTimeZone?: string;
    classDate?: string; timeline?: VoiceTimelineEntry[] };
}

export function groupVoiceNotes(items: readonly VoiceNote[]): { day: string; notes: VoiceNote[] }[] {
  const groups = new Map<string, VoiceNote[]>();
  for (const item of items) {
    if (item.kind !== 'voice') continue;
    const day = item.raw.recordedDate ?? 'unknown';
    const timeline = item.raw.timeline?.slice() ?? [];
    if (item.raw.mediaRef && !timeline.some((entry) => entry.kind === 'voice')) {
      timeline.push({ t: 0, kind: 'voice', mediaRef: item.raw.mediaRef, mime: item.raw.mime ?? 'audio/mp4' });
    }
    timeline.sort((a, b) => a.t - b.t);
    groups.set(day, [...(groups.get(day) ?? []), { ...item, raw: { ...item.raw, timeline } }]);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([day, notes]) => ({
    day,
    notes: notes.sort((a, b) => (b.raw.recordedAt ?? b.createdAt).localeCompare(a.raw.recordedAt ?? a.createdAt)),
  }));
}

export function memberMediaStorageKey(ref: string, memberId: string): string | null {
  if (!memberId || !ref.startsWith(`${memberId}/`)) return null;
  const key = ref.slice(memberId.length + 1);
  return /^scraps\/[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(key) && !key.split('/').includes('..') ? key : null;
}
