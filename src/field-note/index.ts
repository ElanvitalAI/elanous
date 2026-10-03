export interface FieldPhoto {
  file: string;
  /** EXIF `YYYY:MM:DD HH:mm:ss`, ISO local time, or ISO time with an offset. */
  exifTakenAt?: string | null;
}

export interface TranscriptEntry {
  speaker: string;
  timestamp: string;
  text: string;
}

export interface FieldNoteOptions {
  /** Minutes east of UTC for offset-free EXIF and transcript timestamps; KST by default. */
  timeZoneOffsetMinutes?: number;
  /** Minutes added to every dated photo after interpreting its EXIF timestamp. */
  photoCorrectionMinutes?: number;
  /** Maximum gap between consecutive photos in the same scene; 15 minutes by default. */
  sceneGapMinutes?: number;
}

export interface TimedPhoto extends FieldPhoto {
  takenAt: string;
}

export interface FieldScene {
  start: string;
  end: string;
  photos: TimedPhoto[];
  transcript: TranscriptEntry[];
}

export interface FieldTimeline {
  scenes: FieldScene[];
  undatedPhotos: FieldPhoto[];
  /** Chronological entries when there are no dated photos to anchor a scene. */
  transcriptWithoutPhotos: TranscriptEntry[];
  timeZoneOffsetMinutes: number;
}

export interface FieldNoteLlm {
  /** Only used for a raw transcript string; JSON entries bypass transcription. */
  transcribe?: (source: string) => Promise<TranscriptEntry[]>;
  summarize?: (entries: readonly TranscriptEntry[]) => Promise<string>;
}

const MINUTE = 60_000;

function validOffset(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= -14 * 60 && minutes <= 14 * 60;
}

function parseTime(value: string, offsetMinutes: number): number | null {
  const input = value.trim();
  const local = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(input);
  const zoned = local ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(input);
  const match = local ?? zoned;
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  if (+year! < 100) return null;
  const milliseconds = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  const utc = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, milliseconds);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== +year! || date.getUTCMonth() + 1 !== +month! ||
      date.getUTCDate() !== +day! || date.getUTCHours() !== +hour! ||
      date.getUTCMinutes() !== +minute! || date.getUTCSeconds() !== +second!) return null;
  if (local) return utc - offsetMinutes * MINUTE;
  // Offset-bearing ISO timestamps are absolute instants, not local wall-clock readings.
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Pure alignment: neither mutates its inputs nor consults the machine clock/timezone. */
export function alignFieldNote(
  photos: readonly FieldPhoto[],
  transcript: readonly TranscriptEntry[],
  options: FieldNoteOptions = {},
): FieldTimeline {
  const offset = options.timeZoneOffsetMinutes ?? 540;
  const correction = options.photoCorrectionMinutes ?? 0;
  const gap = options.sceneGapMinutes ?? 15;
  if (!validOffset(offset) || !Number.isFinite(correction) || !Number.isFinite(gap) || gap < 0) {
    throw new RangeError('Invalid field-note timezone, photo correction, or scene gap');
  }
  const dated: Array<{ photo: TimedPhoto; time: number; order: number }> = [];
  const undatedPhotos: FieldPhoto[] = [];
  photos.forEach((photo, order) => {
    const parsed = photo.exifTakenAt ? parseTime(photo.exifTakenAt, offset) : null;
    if (parsed === null) undatedPhotos.push({ ...photo });
    else dated.push({ photo: { ...photo, takenAt: iso(parsed + correction * MINUTE) }, time: parsed + correction * MINUTE, order });
  });
  dated.sort((a, b) => a.time - b.time || a.order - b.order);

  const groups: typeof dated[] = [];
  for (const item of dated) {
    const last = groups.at(-1);
    if (!last || item.time - last[last.length - 1]!.time > gap * MINUTE) groups.push([item]);
    else last.push(item);
  }

  const entries = transcript.map((entry, order) => {
    const time = parseTime(entry.timestamp, offset);
    if (time === null) throw new RangeError(`Invalid transcript timestamp at index ${order}: ${entry.timestamp}`);
    return { entry: { ...entry }, time, order };
  }).sort((a, b) => a.time - b.time || a.order - b.order);

  // An utterance belongs to the scene whose photo span [first, last] is nearest in time (inside the span = distance 0);
  // a tie goes to the earlier scene. So a 10:55 line next to an 11:00 photo joins the 11:00 scene, not 09:00.
  const spans = groups.map((group) => ({ start: group[0]!.time, end: group[group.length - 1]!.time }));
  const sceneEntries: Array<Array<(typeof entries)[number]>> = groups.map(() => []);
  for (const item of entries) {
    if (groups.length === 0) break;
    let best = 0;
    let bestDistance = Infinity;
    spans.forEach((span, index) => {
      const distance = item.time < span.start ? span.start - item.time : item.time > span.end ? item.time - span.end : 0;
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    });
    sceneEntries[best]!.push(item);
  }
  const scenes = groups.map((group, index) => {
    const assigned = sceneEntries[index]!;
    const times = [group[0]!.time, group[group.length - 1]!.time, ...assigned.map((item) => item.time)];
    return {
      start: iso(Math.min(...times)), end: iso(Math.max(...times)),
      photos: group.map((item) => item.photo), transcript: assigned.map((item) => item.entry),
    };
  });
  return {
    scenes, undatedPhotos,
    transcriptWithoutPhotos: groups.length === 0 ? entries.map((item) => item.entry) : [],
    timeZoneOffsetMinutes: offset,
  };
}

function localTime(instant: string, offset: number): string {
  const shifted = new Date(Date.parse(instant) + offset * MINUTE).toISOString().slice(0, 16).replace('T', ' ');
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${shifted} UTC${sign}${hours}:${minutes}`;
}

function photoLine(photo: FieldPhoto, label: string): string {
  const file = encodeURIComponent(photo.file).replace(/%2F/gi, '/').replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
  const alt = photo.file.split(/[\\/]/).at(-1)?.replace(/\]/g, '\\]') ?? photo.file;
  return `- ${label} ![${alt}](<${file}>)`;
}

/** Synchronous, side-effect-free Markdown rendering; summaries are optional placeholders. */
export function renderFieldNote(timeline: FieldTimeline, summaries: readonly string[] = []): string {
  if (summaries.length > timeline.scenes.length + (timeline.transcriptWithoutPhotos.length ? 1 : 0)) {
    throw new RangeError('More summaries than transcript sections');
  }
  const lines = ['# 현장 노트', ''];
  timeline.scenes.forEach((scene, i) => {
    lines.push(`## 장면 ${i + 1} · ${localTime(scene.start, timeline.timeZoneOffsetMinutes)} – ${localTime(scene.end, timeline.timeZoneOffsetMinutes)}`);
    lines.push('', '### 전사 요약', summaries[i]?.trim() || '_(전사 요약 자리)_', '', '### 사진');
    for (const photo of scene.photos) lines.push(photoLine(photo, localTime(photo.takenAt, timeline.timeZoneOffsetMinutes)));
    lines.push('');
  });
  if (timeline.transcriptWithoutPhotos.length) {
    lines.push('## 사진 없는 전사', '', '### 전사 요약',
      summaries[timeline.scenes.length]?.trim() || '_(전사 요약 자리)_', '', '### 시간순 전사');
    for (const entry of timeline.transcriptWithoutPhotos) {
      lines.push(`- ${entry.timestamp} · ${entry.speaker}: ${entry.text}`);
    }
    lines.push('');
  }
  if (timeline.undatedPhotos.length) {
    lines.push('## 시각 없음', '');
    for (const photo of timeline.undatedPhotos) lines.push(photoLine(photo, '시각 없음'));
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** LLM calls are supplied by the caller; JSON transcripts need no transcription call. */
export async function generateFieldNote(
  photos: readonly FieldPhoto[],
  transcript: readonly TranscriptEntry[] | string,
  llm: FieldNoteLlm = {},
  options: FieldNoteOptions = {},
): Promise<string> {
  let entries: readonly TranscriptEntry[];
  if (typeof transcript === 'string') {
    if (!llm.transcribe) throw new Error('A transcribe dependency is required for raw transcript input');
    entries = await llm.transcribe(transcript);
  } else entries = transcript;
  const timeline = alignFieldNote(photos, entries, options);
  const sections = timeline.scenes.map((scene) => scene.transcript);
  if (timeline.transcriptWithoutPhotos.length) sections.push(timeline.transcriptWithoutPhotos);
  const summaries = llm.summarize
    ? await Promise.all(sections.map((segment) => segment.length ? llm.summarize!(segment) : ''))
    : [];
  return renderFieldNote(timeline, summaries);
}
