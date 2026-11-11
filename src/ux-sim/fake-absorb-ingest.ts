import type { AbsorbExtraction } from '../intake-plane/absorb-extract.js';

/** Deterministic simulation devices for the seven ABSORB ingest inputs. */
export type AbsorbKind = 'text' | 'web' | 'x' | 'youtube' | 'voice' | 'video' | 'photo';

export interface FakeScrapInput {
  id: string;
  memberId: string;
  kind: AbsorbKind;
  source: 'android-share' | 'android-record' | 'tui' | 'pwa' | 'telegram';
  raw: { text?: string; url?: string; mediaRef?: string; mime?: string };
}

export const FAKE_ABSORB_SCRAPS: readonly FakeScrapInput[] = [
  { id: 'scrap-text', memberId: 'member-a', kind: 'text', source: 'tui', raw: { text: 'Design a local-first lecture notebook' } },
  { id: 'scrap-web', memberId: 'member-a', kind: 'web', source: 'android-share', raw: { url: 'https://example.test/article' } },
  { id: 'scrap-x', memberId: 'member-a', kind: 'x', source: 'telegram', raw: { url: 'https://x.com/example/status/1' } },
  { id: 'scrap-youtube', memberId: 'member-a', kind: 'youtube', source: 'pwa', raw: { url: 'https://youtube.com/watch?v=fixture' } },
  { id: 'scrap-voice', memberId: 'member-a', kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/voice-1', mime: 'audio/wav' } },
  { id: 'scrap-video', memberId: 'member-a', kind: 'video', source: 'android-share', raw: { mediaRef: 'scraps/video-1', mime: 'video/mp4' } },
  { id: 'scrap-photo', memberId: 'member-a', kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-1', mime: 'image/jpeg' } },
  { id: 'scrap-owner-b', memberId: 'member-b', kind: 'text', source: 'tui', raw: { text: 'private to member b' } },
];

export class FakeScrapInbox {
  readonly records = new Map<string, FakeScrapInput>();

  create(input: FakeScrapInput): FakeScrapInput {
    const existing = this.records.get(input.id);
    if (existing) return existing;
    this.records.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  list(memberId: string): FakeScrapInput[] {
    return [...this.records.values()].filter((record) => record.memberId === memberId).map((record) => structuredClone(record));
  }
}

export interface FakeExtractors {
  extract(input: FakeScrapInput): Promise<AbsorbExtraction>;
}

export function createFakeExtractors(options: { failKind?: AbsorbKind } = {}): FakeExtractors {
  return {
    async extract(input) {
      if (input.kind === options.failKind) throw new Error(`simulated ${input.kind} extractor failure`);
      if (input.kind === 'text') {
        const text = input.raw.text?.trim() ?? '';
        return { title: text.slice(0, 80) || 'Untitled note', body: text };
      }
      const labels: Record<Exclude<AbsorbKind, 'text'>, string> = {
        web: 'Web article', x: 'X post', youtube: 'YouTube transcript', voice: 'Voice transcript',
        video: 'Video transcript', photo: 'Photo OCR',
      };
      return { title: labels[input.kind], body: `fixture extraction for ${input.kind}`, ...(input.raw.url ? { originUrl: input.raw.url } : {}) };
    },
  };
}

