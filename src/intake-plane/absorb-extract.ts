import type { AbsorbScrapPayload } from './items.js';

export interface AbsorbExtraction { title: string; body: string; originUrl?: string; transcript?: string; author?: string }
export interface AbsorbExtractorAdapters {
  digestWeb?: (url: string) => Promise<{ title: string; body: string }>;
  digestX?: (url: string) => Promise<{ title: string; body: string; author?: string }>;
  youtubeTranscript?: (url: string) => Promise<{ title: string; transcript: string }>;
  transcribeAudio?: (mediaRef: string) => Promise<string>;
  extractVideoAudio?: (mediaRef: string) => Promise<string>;
  transcribeVideoAudio?: (audioRef: string) => Promise<string>;
  ocrPhoto?: (mediaRef: string) => Promise<string>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

/** Dispatch by the RFC's seven-kind contract; integrations reuse existing surfaces through injected adapters. */
export async function extractAbsorbScrap(scrap: AbsorbScrapPayload, adapters: AbsorbExtractorAdapters): Promise<AbsorbExtraction> {
  switch (scrap.kind) {
    case 'text': {
      const body = required(scrap.raw.text, 'text');
      return { title: body.slice(0, 80), body };
    }
    case 'web': {
      const out = await adapters.digestWeb?.(required(scrap.raw.url, 'url'));
      if (!out) throw new Error('web digest adapter is not configured');
      return { ...out, originUrl: scrap.raw.url };
    }
    case 'x': {
      const out = await adapters.digestX?.(required(scrap.raw.url, 'url'));
      if (!out) throw new Error('X digest adapter is not configured');
      return { ...out, originUrl: scrap.raw.url };
    }
    case 'youtube': {
      const out = await adapters.youtubeTranscript?.(required(scrap.raw.url, 'url'));
      if (!out) throw new Error('YouTube transcript adapter is not configured');
      return { title: out.title, body: out.transcript, transcript: out.transcript, originUrl: scrap.raw.url };
    }
    case 'voice': {
      const transcript = await adapters.transcribeAudio?.(required(scrap.raw.mediaRef, 'mediaRef'));
      if (transcript === undefined) throw new Error('audio STT adapter is not configured');
      return { title: 'Voice note', body: transcript, transcript };
    }
    case 'video': {
      const mediaRef = required(scrap.raw.mediaRef, 'mediaRef');
      const audioRef = await adapters.extractVideoAudio?.(mediaRef);
      if (!audioRef) throw new Error('video audio extraction adapter is not configured');
      const transcript = await adapters.transcribeVideoAudio?.(audioRef);
      if (transcript === undefined) throw new Error('video STT adapter is not configured');
      return { title: 'Video', body: transcript, transcript };
    }
    case 'photo': {
      const text = await adapters.ocrPhoto?.(required(scrap.raw.mediaRef, 'mediaRef'));
      if (text === undefined) throw new Error('photo OCR adapter is not configured');
      return { title: 'Photo note', body: text };
    }
  }
}

export interface AbsorbSummaryCard {
  title: string;
  points: [string, string?, string?];
  tags: string[];
  originUrl?: string;
}

export type AbsorbCardLlm = (input: { title: string; body: string; byok: true }) => Promise<AbsorbSummaryCard>;

/** BYOK only; absent BYOK takes a deterministic first-sentence fallback. */
export async function buildAbsorbSummaryCard(
  extracted: AbsorbExtraction,
  options: { byok?: AbsorbCardLlm } = {},
): Promise<AbsorbSummaryCard> {
  if (options.byok) return options.byok({ title: extracted.title, body: extracted.body, byok: true });
  const sentences = extracted.body.split(/[.!?\n]+/).map((part) => part.trim()).filter(Boolean);
  const points: [string, string?, string?] = [sentences[0] || extracted.title];
  if (sentences[1]) points[1] = sentences[1];
  if (sentences[2]) points[2] = sentences[2];
  const tags = [...new Set((extracted.body.match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 5).map((word) => word.toLocaleLowerCase()))];
  return { title: extracted.title, points, tags, ...(extracted.originUrl ? { originUrl: extracted.originUrl } : {}) };
}
