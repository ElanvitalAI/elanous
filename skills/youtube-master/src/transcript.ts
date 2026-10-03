import { env, requireEnv } from './env.js';
import type { TranscriptSegment } from './types.js';

export interface TranscriptResult {
  text: string | null;
  segments: TranscriptSegment[];
}

export interface SufficiencyResult {
  sufficient: boolean;
  reason: string;
}

/**
 * Fetch transcript via Supadata API.
 * Returns segments with timestamps when available.
 */
export async function fetchSupadataTranscript(url: string): Promise<TranscriptResult> {
  const apiKey = requireEnv('SUPADATA_API_KEY');
  const lang = env('TRANSCRIPT_LANG', 'ko');
  const params = new URLSearchParams({ url, lang, text: 'false', mode: 'auto' });

  let response: Response;
  try {
    response = await fetch(`https://api.supadata.ai/v1/transcript?${params}`, {
      headers: { 'x-api-key': apiKey },
    });
  } catch (e: any) {
    console.log(`⚠️ Supadata fetch 실패: ${e?.message || e}`);
    return { text: null, segments: [] };
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.log(`⚠️ Supadata API 오류: ${response.status} ${errBody}`);
    return { text: null, segments: [] };
  }

  const data = await response.json();

  if (Array.isArray(data.content)) {
    const segments: TranscriptSegment[] = data.content.map((seg: any) => ({
      text: (seg.text || '').trim(),
      offset: (seg.start ?? seg.offset ?? 0) / 1000,
      duration: (seg.duration ?? 0) / 1000,
    }));
    const fullText = segments.map((s) => s.text).filter(Boolean).join(' ');
    return { text: fullText, segments };
  }

  if (typeof data.content === 'string') {
    return { text: data.content, segments: [] };
  }

  return { text: null, segments: [] };
}

/**
 * Judge whether a transcript is sufficient for summarization.
 * Uses heuristic (char count + chars-per-minute).
 */
export function judgeTranscriptSufficiency(
  transcriptText: string,
  durationSec: number,
): SufficiencyResult {
  const charCount = transcriptText.trim().length;
  const charsPerMinute = durationSec > 0
    ? charCount / Math.max(1, durationSec / 60)
    : charCount;

  const sufficient = charCount >= 1200 && charsPerMinute >= 60;
  return {
    sufficient,
    reason: `heuristic (chars=${charCount}, cpm=${charsPerMinute.toFixed(1)})`,
  };
}
