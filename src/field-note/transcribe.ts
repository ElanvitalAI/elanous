import type { TranscriptEntry } from './index';

/** Mono, normalized PCM. The capture instant is required for NOTE1's absolute photo alignment. */
export interface FieldAudio {
  samples: Float32Array;
  sampleRate: number;
  recordedAt: string;
}

export interface AudioChunk {
  samples: Float32Array;
  sampleRate: number;
  /** Offset from the first sample of the recording, in seconds. */
  startSeconds: number;
}

export interface SpeechSegment {
  /** Start and end in seconds relative to the supplied chunk. */
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
}

export interface EngineRequest {
  language: string;
  /** Preserve source-language speech rather than translating it. */
  task: 'transcribe';
}

export interface TranscriptionEngine {
  transcribe(chunk: AudioChunk, request: EngineRequest): Promise<readonly SpeechSegment[]>;
}

/** The caller provides the local Whisper runtime; this module never downloads a model. */
export interface LocalWhisperClient {
  transcribe(input: {
    audio: Float32Array;
    sampleRate: number;
    language: string;
    task: 'transcribe';
  }): Promise<readonly SpeechSegment[]>;
}

/** The caller provides authentication/transport; no network call occurs on construction. */
export interface CloudSttClient {
  transcribe(input: {
    audio: Float32Array;
    sampleRate: number;
    language: string;
    timestamps: true;
    diarization: true;
  }): Promise<readonly SpeechSegment[]>;
}

export function createLocalWhisperEngine(client: LocalWhisperClient): TranscriptionEngine {
  return {
    transcribe: (chunk, request) => client.transcribe({
      audio: chunk.samples, sampleRate: chunk.sampleRate, language: request.language, task: request.task,
    }),
  };
}

export function createCloudSttEngine(client: CloudSttClient): TranscriptionEngine {
  return {
    transcribe: (chunk, request) => client.transcribe({
      audio: chunk.samples, sampleRate: chunk.sampleRate, language: request.language,
      timestamps: true, diarization: true,
    }),
  };
}

export interface TranscriptionOptions {
  /** Default: ko. */
  language?: string;
  /** Default: 30 seconds. */
  chunkSeconds?: number;
  /** Default: 2 seconds. Must be shorter than chunkSeconds. */
  overlapSeconds?: number;
  /** Used only if an engine omits a speaker label. Otherwise the label remains 화자 미상. */
  defaultSpeaker?: string;
}

function validateAudio(audio: FieldAudio): number {
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new RangeError('Audio sampleRate must be a positive integer');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(audio.recordedAt);
  if (!match) throw new RangeError('Audio recordedAt must be an ISO timestamp with a timezone offset');
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!));
  const recordedAt = Date.parse(audio.recordedAt);
  if (calendar.getUTCFullYear() !== +year! || calendar.getUTCMonth() + 1 !== +month! ||
      calendar.getUTCDate() !== +day! || calendar.getUTCHours() !== +hour! ||
      calendar.getUTCMinutes() !== +minute! || calendar.getUTCSeconds() !== +second! ||
      (zone !== 'Z' && (+zone!.slice(1, 3) > 23 || +zone!.slice(4) > 59)) ||
      !Number.isFinite(recordedAt)) {
    throw new RangeError('Invalid audio recordedAt timestamp');
  }
  return recordedAt;
}

/** Sample-index arithmetic avoids gaps and drift from repeated floating-point additions. */
export function splitAudioIntoChunks(audio: FieldAudio, options: TranscriptionOptions = {}): AudioChunk[] {
  validateAudio(audio);
  const chunkSeconds = options.chunkSeconds ?? 30;
  const overlapSeconds = options.overlapSeconds ?? 2;
  if (!Number.isFinite(chunkSeconds) || !Number.isFinite(overlapSeconds) ||
      chunkSeconds <= 0 || overlapSeconds < 0 || overlapSeconds >= chunkSeconds) {
    throw new RangeError('Audio chunk length must exceed nonnegative overlap');
  }
  const size = Math.round(chunkSeconds * audio.sampleRate);
  const overlap = Math.round(overlapSeconds * audio.sampleRate);
  if (size <= 0 || overlap >= size) throw new RangeError('Audio chunk and overlap must span valid samples');
  const chunks: AudioChunk[] = [];
  for (let start = 0; start < audio.samples.length;) {
    const end = Math.min(start + size, audio.samples.length);
    chunks.push({ samples: audio.samples.subarray(start, end), sampleRate: audio.sampleRate,
      startSeconds: start / audio.sampleRate });
    if (end === audio.samples.length) break;
    start = end - overlap;
  }
  return chunks;
}

function mergeOverlappingText(left: string, right: string): string | null {
  if (left === right) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  for (let length = Math.min(left.length, right.length); length >= 2; length--) {
    if (left.endsWith(right.slice(0, length))) return left + right.slice(length);
  }
  return null;
}

interface TimedSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
  chunkIndex: number;
}

/** Return absolute ISO timestamps accepted by NOTE1, preserving speaker labels and chronological order. */
export async function transcribeFieldAudio(
  audio: FieldAudio,
  engine: TranscriptionEngine,
  options: TranscriptionOptions = {},
): Promise<TranscriptEntry[]> {
  const origin = validateAudio(audio);
  const chunks = splitAudioIntoChunks(audio, options);
  const segments: TimedSegment[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const result = await engine.transcribe(chunk, { language: options.language ?? 'ko', task: 'transcribe' });
    const duration = chunk.samples.length / chunk.sampleRate;
    for (const segment of result) {
      if (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
          segment.startSeconds < 0 || segment.endSeconds < segment.startSeconds ||
          // Only floating-point slack — a segment may not end after the chunk's real audio (NOTE3a review must-fix).
          segment.endSeconds > duration + 1e-9) {
        throw new RangeError(`Invalid transcription segment times in chunk ${chunkIndex}`);
      }
      const text = segment.text.trim();
      if (!text) continue;
      segments.push({
        start: chunk.startSeconds + segment.startSeconds,
        end: chunk.startSeconds + segment.endSeconds,
        text, speaker: segment.speaker?.trim() || options.defaultSpeaker?.trim() || '화자 미상',
        chunkIndex,
      });
    }
  }
  segments.sort((a, b) => a.chunkIndex - b.chunkIndex || a.start - b.start);
  const stitched: TimedSegment[] = [];
  const center = (segment: TimedSegment) => {
    const source = chunks[segment.chunkIndex]!;
    return source.startSeconds + source.samples.length / source.sampleRate / 2;
  };
  // Engine speaker IDs are chunk-scoped. A later chunk's ID that matched an earlier chunk's speech in the overlap takes
  // the earlier global label; an ID that never matched is qualified with its chunk so different people never share a label.
  const unlabeled = new Set(['화자 미상', options.defaultSpeaker?.trim()].filter((label): label is string => !!label));
  const qualify = (speaker: string, chunkIndex: number) => chunkIndex && !unlabeled.has(speaker) ? `${speaker} · 구간 ${chunkIndex + 1}` : speaker;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const incoming = segments.filter((segment) => segment.chunkIndex === chunkIndex);
    const speakerMap = new Map<string, string>();
    const previous = stitched.filter((segment) => segment.chunkIndex === chunkIndex - 1);
    const sharedStart = chunk.startSeconds;
    const sharedEnd = chunkIndex ? Math.min(chunk.startSeconds + chunk.samples.length / chunk.sampleRate,
      chunks[chunkIndex - 1]!.startSeconds + chunks[chunkIndex - 1]!.samples.length / audio.sampleRate) : sharedStart;
    const eligible = (segment: TimedSegment) => segment.start <= sharedEnd && segment.end >= sharedStart;
    const consumedPrevious = new Set<TimedSegment>();
    const consumedIncoming = new Set<TimedSegment>();
    const replacements: TimedSegment[] = [];
    // A chunk may split one sentence into several timed segments while its
    // neighbor reports the entire sentence. Match contiguous groups on both sides.
    while (sharedEnd > sharedStart) {
      let best: { earlier: TimedSegment[]; later: TimedSegment[]; text: string } | undefined;
      for (let a = 0; a < previous.length; a++) {
        for (let b = a + 1; b <= previous.length; b++) {
          const earlier = previous.slice(a, b);
          if (earlier.some((item) => consumedPrevious.has(item) || !eligible(item))) break;
          for (let c = 0; c < incoming.length; c++) {
            for (let d = c + 1; d <= incoming.length; d++) {
              const later = incoming.slice(c, d);
              if (later.some((item) => consumedIncoming.has(item) || !eligible(item))) break;
              // Speaker IDs are scoped to each engine call, not stable across chunks.
              // Keep distinct speakers within a chunk separate, but use speech and time across chunks.
              if (earlier.some((item) => item.speaker !== earlier[0]!.speaker) ||
                  later.some((item) => item.speaker !== later[0]!.speaker)) continue;
              const earlierStart = earlier[0]!.start;
              const earlierEnd = Math.max(...earlier.map((item) => item.end));
              const laterStart = later[0]!.start;
              const laterEnd = Math.max(...later.map((item) => item.end));
              if (earlier.some((item) => item.start > laterEnd || item.end < laterStart) ||
                  later.some((item) => item.start > earlierEnd || item.end < earlierStart)) continue;
              const text = mergeOverlappingText(earlier.map((item) => item.text).join(' '),
                later.map((item) => item.text).join(' '));
              if (text !== null && (!best || earlier.length + later.length > best.earlier.length + best.later.length)) {
                best = { earlier, later, text };
              }
            }
          }
        }
      }
      if (!best) break;
      for (const item of best.earlier) consumedPrevious.add(item);
      for (const item of best.later) consumedIncoming.add(item);
      const earlier = best.earlier[0]!;
      const later = best.later[0]!;
      const chosen = Math.abs((later.start + later.end) / 2 - center(later)) <
        Math.abs((earlier.start + earlier.end) / 2 - center(earlier)) ? later : earlier;
      // The earlier side already carries a global label; first match decides the mapping for this chunk-local ID.
      for (const item of best.later) if (!speakerMap.has(item.speaker)) speakerMap.set(item.speaker, earlier.speaker);
      replacements.push({ ...chosen, speaker: earlier.speaker, chunkIndex, text: best.text,
        start: Math.min(...best.earlier.map((item) => item.start), ...best.later.map((item) => item.start)),
        end: Math.max(...best.earlier.map((item) => item.end), ...best.later.map((item) => item.end)) });
    }
    for (let i = stitched.length - 1; i >= 0; i--) {
      if (consumedPrevious.has(stitched[i]!)) stitched.splice(i, 1);
    }
    stitched.push(...incoming.filter((item) => !consumedIncoming.has(item))
      .map((item) => ({ ...item, speaker: speakerMap.get(item.speaker) ?? qualify(item.speaker, chunkIndex) })), ...replacements);
    stitched.sort((a, b) => a.start - b.start || a.chunkIndex - b.chunkIndex);
  }
  return stitched.map(({ start, speaker, text }) => ({
    speaker, text, timestamp: new Date(origin + Math.round(start * 1000)).toISOString(),
  }));
}
