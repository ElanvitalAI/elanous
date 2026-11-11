// ── V4 (Phase 1 Bundle 2) — Voice → SerializableSurfaceIntent parser ──
//
// HANDOFF §5 V4: "음성 명령 'line 42 의 단어들 받아 적어줘' 를
// `word-select` consumer 로 normalize". This file lands the parser
// (pure function) + the intent envelope. Wiring into the actual STT
// post-router happens in a follow-up — V4 PR keeps the code surface
// small + tested.
//
// Parser strategy: regex-driven phrase recognition. Two lanes:
//
//   • Korean lane (default for the dogfood user): "line N 의 단어들",
//     "line N 단어 받아", "라인 N", "line N 받아 적어줘", "그 줄
//     단어들 가져와".
//   • English lane: "line N words", "select word at line N", "grab
//     line N words".
//
// Both lanes resolve to the same `SerializableSurfaceIntent` shape
// from `terminal-surface-intent.ts`. When the phrase doesn't match,
// we return null so the caller can fall through to LLM.
//
// Per substrate G6 the intent carries `capability` — but the parser
// has no live capability vector. We emit `capability: null` and let
// the consumer chain re-derive from a host-resolved exposure. This
// is a small extension of the substrate's serializable intent shape
// (see `VoiceSurfaceIntent` below) so we don't fake a capability at
// parse time.

import type { TerminalUserExposure } from '../../terminal/posture.js';

export type VoiceSurfaceIntentKind =
  | 'word-select-line'
  | 'word-select-token'
  | 'range-select-line'
  /** X7 (Bundle 3) — "이 화면 무슨 일이야" / "what's on screen". Voice
   *  query that asks for a vision LLM analysis of the focused pane.
   *  No row/col — `line` is unused (set to 0 sentinel). */
  | 'screen-vision-query';

/**
 * Parser-side intent — host fills in the substrate envelope
 * (`surfaceId`, `capability`, `exposure`) before forwarding to the
 * canonical consumer chain.
 */
export interface VoiceSurfaceIntent {
  readonly kind: VoiceSurfaceIntentKind;
  /** 1-based line number from the user phrase. 0 means "current
   *  caret line" (when the user said "이 줄" without a number). */
  readonly line: number;
  /** Optional column hint when the user specified a token position
   *  (e.g. "line 42 의 3 번째 단어"). 1-based. */
  readonly column?: number;
  /** Recognised phrase — useful for telemetry / debug logs. */
  readonly transcript: string;
  /** Lane that matched ('ko' or 'en'). */
  readonly lane: 'ko' | 'en';
}

// ── Parsers ─────────────────────────────────────────────────────────

interface PhrasePattern {
  re: RegExp;
  /** Extract intent from match groups. Returns null when match passes
   *  but intent extraction fails (e.g. parseInt yielded NaN). */
  build: (m: RegExpExecArray, transcript: string) => VoiceSurfaceIntent | null;
}

const KOREAN_PATTERNS: ReadonlyArray<PhrasePattern> = [
  // X7 — "이 화면 무슨 일이야" / "이 pane 분석해줘" / "지금 화면 어떻게 됐어"
  {
    re: /(?:이|지금|현재)\s*(?:화면|pane|패널|판|디스플레이)\s*(?:무슨|뭐|어떻|어떻게|상태|분석|어떡|일이|뭔|봐|보여|봐줘)/i,
    build: (_m, transcript) => ({
      kind: 'screen-vision-query',
      line: 0,
      transcript,
      lane: 'ko',
    }),
  },
  // "line 42 의 단어들 받아 적어줘"
  // "라인 42 단어들 가져와"
  // "line 42 받아 적어줘"
  {
    re: /(?:line|라인)\s*(\d+)\s*(?:의|에|선|줄)?\s*(?:단어들|단어|받아|가져와|적어|복사|copy)/i,
    build: (m, transcript) => {
      const line = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(line)) return null;
      return {
        kind: m[0]?.includes('단어') || /word|token/i.test(transcript) ? 'word-select-line' : 'range-select-line',
        line,
        transcript,
        lane: 'ko',
      };
    },
  },
  // "이 줄 단어들" — uses caret line (line=0 sentinel)
  {
    re: /(?:이|현재|지금)\s*(?:줄|라인|line)\s*(?:의|에)?\s*(?:단어|받아|가져)/i,
    build: (_m, transcript) => ({
      kind: 'word-select-line',
      line: 0,
      transcript,
      lane: 'ko',
    }),
  },
  // "line 42 의 3 번째 단어"
  {
    re: /(?:line|라인)\s*(\d+)\s*(?:의|에|선)?\s*(\d+)\s*번째\s*단어/i,
    build: (m, transcript) => {
      const line = Number.parseInt(m[1] ?? '', 10);
      const column = Number.parseInt(m[2] ?? '', 10);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
      return {
        kind: 'word-select-token',
        line,
        column,
        transcript,
        lane: 'ko',
      };
    },
  },
];

const ENGLISH_PATTERNS: ReadonlyArray<PhrasePattern> = [
  // X7 — "what's on screen" / "what's happening" / "describe this pane" /
  //       "what's wrong with the screen"
  {
    re: /(?:what(?:'s| is)\s*(?:on|happening|going|wrong))\s*(?:on|with|in)?\s*(?:the\s*)?(?:screen|pane|terminal)/i,
    build: (_m, transcript) => ({
      kind: 'screen-vision-query',
      line: 0,
      transcript,
      lane: 'en',
    }),
  },
  {
    re: /(?:describe|analyze|read)\s*(?:this\s*|the\s*)?(?:pane|screen|terminal|output)/i,
    build: (_m, transcript) => ({
      kind: 'screen-vision-query',
      line: 0,
      transcript,
      lane: 'en',
    }),
  },
  // "line 42 words" / "select line 42 words" / "grab line 42 words"
  {
    re: /(?:select|grab|copy)?\s*line\s*(\d+)\s*(?:words?|tokens?)/i,
    build: (m, transcript) => {
      const line = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(line)) return null;
      return {
        kind: 'word-select-line',
        line,
        transcript,
        lane: 'en',
      };
    },
  },
  // "select line 42" — entire line range
  {
    re: /(?:select|grab|copy)\s*line\s*(\d+)\b(?!\s*(?:words?|tokens?))/i,
    build: (m, transcript) => {
      const line = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(line)) return null;
      return {
        kind: 'range-select-line',
        line,
        transcript,
        lane: 'en',
      };
    },
  },
  // "word at line 42 column 3"
  {
    re: /word\s*at\s*line\s*(\d+)\s*(?:column|col)\s*(\d+)/i,
    build: (m, transcript) => {
      const line = Number.parseInt(m[1] ?? '', 10);
      const column = Number.parseInt(m[2] ?? '', 10);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
      return {
        kind: 'word-select-token',
        line,
        column,
        transcript,
        lane: 'en',
      };
    },
  },
];

/**
 * Parse a transcript into a VoiceSurfaceIntent. Returns null when no
 * phrase matches (caller should pass the transcript through to the
 * regular LLM turn handler).
 *
 * Parser is order-sensitive: more specific patterns ("3 번째 단어")
 * are tried before generic ones. First match wins; the rest are not
 * re-evaluated.
 */
export function parseVoiceSurfaceIntent(
  transcript: string,
): VoiceSurfaceIntent | null {
  if (!transcript || typeof transcript !== 'string') return null;
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;

  // Try column-aware Korean patterns first (more specific).
  for (const pat of KOREAN_PATTERNS.slice().reverse()) {
    const m = pat.re.exec(trimmed);
    if (m) {
      const built = pat.build(m, trimmed);
      if (built) return built;
    }
  }
  // Then English column-aware → general → range patterns.
  for (const pat of ENGLISH_PATTERNS.slice().reverse()) {
    const m = pat.re.exec(trimmed);
    if (m) {
      const built = pat.build(m, trimmed);
      if (built) return built;
    }
  }
  return null;
}

// ── Envelope helpers ────────────────────────────────────────────────

/**
 * Convert a parsed `VoiceSurfaceIntent` into the substrate
 * `SerializableSurfaceIntent` shape the consumer chain expects.
 * The host provides `surfaceId` + `paneKind` + a live `exposure` so
 * the capability vector can be derived.
 *
 * Returns the same `SerializableSurfaceIntent` shape as the mouse
 * lane — consumers can't tell whether the intent came from a click
 * or a voice command. The chain stays uniform.
 */
import type {
  SerializableSurfaceIntent,
} from '../../surface/terminal-surface-intent.js';
import { deriveTerminalCapability, type TerminalExposureSnapshot } from '../../terminal/posture.js';

export interface VoiceIntentEnvelopeOpts {
  voice: VoiceSurfaceIntent;
  surfaceId: string;
  paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
  exposure: TerminalExposureSnapshot;
  /** Resolves caret line (1-based) when the voice intent carries
   *  `line === 0` (sentinel for "current line"). Returns 1 when the
   *  caret store is empty. */
  resolveCaretLine?: () => number;
}

export function envelopeVoiceSurfaceIntent(
  opts: VoiceIntentEnvelopeOpts,
): SerializableSurfaceIntent {
  const line = opts.voice.line === 0
    ? (opts.resolveCaretLine?.() ?? 1)
    : opts.voice.line;
  // Convert 1-based line → 0-based row used by the substrate.
  const row = Math.max(0, line - 1);
  const col = Math.max(0, (opts.voice.column ?? 1) - 1);
  const capability = deriveTerminalCapability(opts.exposure);

  // Range-select-line variant uses range-select-end with start=col 0
  // and end=col Infinity-equivalent (the consumer's range extractor
  // clamps to line length). We send a single end intent — the consumer
  // synthesizes a cell range when no anchor is present.
  if (opts.voice.kind === 'range-select-line') {
    return {
      kind: 'range-select-end',
      surfaceId: opts.surfaceId,
      paneKind: opts.paneKind,
      row,
      col: Number.MAX_SAFE_INTEGER, // consumer clamps to line.length
      exposure: opts.exposure,
      capability,
    };
  }

  return {
    kind: 'word-select',
    surfaceId: opts.surfaceId,
    paneKind: opts.paneKind,
    row,
    col,
    exposure: opts.exposure,
    capability,
  };
}

/** Token exposure helpers for tests and debug logs. */
export type { TerminalUserExposure };
