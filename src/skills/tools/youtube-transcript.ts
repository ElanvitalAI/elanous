import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: youtube_transcript — T3-A1.
//
// Extracts YouTube transcript via Supadata API (fast path, free,
// no audio download). Probe-gated on SUPADATA_API_KEY — when unset
// the tool hides from the catalog so LLMs don't call it fruitlessly.
//
// Design decisions:
//
//   • Scope is strictly "URL → text+segments"; summarization /
//     learn-note formatting stays with the youtube-master skill.
//     The native tool is the "just give me the transcript" shortcut.
//
//   • Supadata-first. When Supadata fails (rate limit, no captions
//     on that video, etc.) the tool returns provider='none' + an
//     empty text + a hint pointing at the skill's STT fallback
//     pipeline. The LLM can decide whether to escalate.
//
//   • No Cloud STT in the native path. STT requires yt-dlp to
//     download audio + tens of megabytes of audio uploaded to
//     ElevenLabs/OpenAI/Gemini. That's a heavy/slow path and
//     belongs behind the skill's explicit opt-in (`--cloud-stt`).
//
// Truncation: output respects max_bytes (default 64 KB) so long
// podcasts don't blow the LLM context.


import { truncateOutput } from '../../output-truncation.js';

const VIDEO_ID_PATTERNS = [
  /[?&]v=([0-9A-Za-z_-]{11})/,
  /youtu\.be\/([0-9A-Za-z_-]{11})/,
  /\/shorts\/([0-9A-Za-z_-]{11})/,
  /\/embed\/([0-9A-Za-z_-]{11})/,
  /(?:v=|\/)([0-9A-Za-z_-]{11})/,
];

export function extractYoutubeVideoId(url: string): string | null {
  for (const pat of VIDEO_ID_PATTERNS) {
    const m = url.match(pat);
    if (m) return m[1] ?? null;
  }
  return null;
}

export interface YoutubeTranscriptSegment {
  text: string;
  offset: number;       // seconds from start
  duration: number;     // seconds
}

export interface YoutubeTranscriptArgs {
  url: string;
  lang?: string;             // default ko
  max_bytes?: number;        // default 64 KB
}

export interface YoutubeTranscriptResult {
  output: string;            // LLM-facing summary
  text: string;              // full transcript (post-truncate)
  segments: YoutubeTranscriptSegment[];
  provider: 'supadata' | 'none';
  videoId: string;
  truncated: boolean;
  durationSec: number | null;
}

export interface YoutubeTranscriptDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;           // override SUPADATA_API_KEY env
  lang?: string;             // override TRANSCRIPT_LANG env
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export function buildYoutubeTranscriptTool(): LLMToolSpec {
  return {
    name: 'YoutubeTranscript',
    description:
      'Fetch a YouTube video\'s transcript (captions) via Supadata. Returns text + timestamped segments. ' +
      'Use for "what is said in this video?" style questions. For full summarization / study-note generation, ' +
      'prefer the youtube-master skill. Returns provider="none" when captions are missing — in that case ' +
      'escalate via `/run-skill youtube-master <url>` which can fall back to Cloud STT.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'youtube.com / youtu.be / shorts / embed URL.' },
        lang: { type: 'string', description: 'Preferred caption language (default ko).' },
        max_bytes: {
          type: 'integer',
          description: `Truncation cap on transcript text. Default ${DEFAULT_MAX_BYTES}.`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

export async function dispatchYoutubeTranscript(
  rawArgs: Record<string, unknown>,
  deps: YoutubeTranscriptDeps = {},
): Promise<YoutubeTranscriptResult> {
  const url = String(rawArgs.url ?? '').trim();
  if (!url) throw new Error(`'url' is required`);
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) throw new Error(`could not extract YouTube video id from ${url}`);

  const lang = String(rawArgs.lang ?? deps.lang ?? process.env['TRANSCRIPT_LANG'] ?? 'ko');
  const maxBytes = typeof rawArgs.max_bytes === 'number' && rawArgs.max_bytes > 0
    ? rawArgs.max_bytes
    : DEFAULT_MAX_BYTES;

  const apiKey = deps.apiKey ?? process.env['SUPADATA_API_KEY'];
  if (!apiKey) {
    return {
      output: `YoutubeTranscript blocked — SUPADATA_API_KEY is not set. Export it or use \`/run-skill youtube-master ${url}\`.`,
      text: '',
      segments: [],
      provider: 'none',
      videoId,
      truncated: false,
      durationSec: null,
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const params = new URLSearchParams({ url, lang, text: 'false', mode: 'auto' });
  let response: Response;
  try {
    response = await fetchImpl(`https://api.supadata.ai/v1/transcript?${params}`, {
      headers: { 'x-api-key': apiKey },
    });
  } catch (err) {
    return {
      output: `YoutubeTranscript Supadata fetch failed: ${err instanceof Error ? err.message : String(err)}.`,
      text: '', segments: [], provider: 'none', videoId, truncated: false, durationSec: null,
    };
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    return {
      output: `YoutubeTranscript Supadata ${response.status}: ${errBody.slice(0, 200)}. Use youtube-master skill for STT fallback.`,
      text: '', segments: [], provider: 'none', videoId, truncated: false, durationSec: null,
    };
  }

  const data = (await response.json()) as {
    content?: unknown; lang?: string; available_langs?: string[];
  };

  let segments: YoutubeTranscriptSegment[] = [];
  let text = '';
  if (Array.isArray(data.content)) {
    segments = (data.content as Array<{ text?: string; start?: number; offset?: number; duration?: number }>)
      .map((seg) => ({
        text: (seg.text ?? '').trim(),
        offset: (seg.start ?? seg.offset ?? 0) / 1000,
        duration: (seg.duration ?? 0) / 1000,
      }));
    text = segments.map((s) => s.text).filter(Boolean).join(' ');
  } else if (typeof data.content === 'string') {
    text = data.content;
  }

  const lastSeg = segments[segments.length - 1];
  const durationSec = lastSeg ? Math.round(lastSeg.offset + lastSeg.duration) : null;

  const trimmed = truncateOutput(text, {
    toolName: 'youtube_transcript',
    ext: 'txt',
    inlineLimit: maxBytes,
  });

  const segCount = segments.length;
  const durStr = durationSec ? `${Math.round(durationSec / 60)}m` : 'n/a';
  const charStr = text.length.toLocaleString();
  return {
    output: `YoutubeTranscript videoId=${videoId} lang=${lang} segments=${segCount} duration=${durStr} chars=${charStr}${trimmed.spilled ? ' (truncated)' : ''}\n${trimmed.output}`,
    text: trimmed.output,
    segments,
    provider: 'supadata',
    videoId,
    truncated: trimmed.spilled,
    durationSec,
  };
}

/** Probe: is SUPADATA_API_KEY set in env? Native-tool-catalog uses
 *  this to hide the tool when the user can't call it anyway. */
export function youtubeTranscriptProbe(): boolean {
  return !!process.env['SUPADATA_API_KEY'];
}
