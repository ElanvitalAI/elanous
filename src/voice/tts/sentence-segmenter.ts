// PR-S1V.7 (sprint 22 Phase 2 · 2026-04-29) — Sentence-boundary
// segmenter for streaming auto-TTS.
//
// Walks an LLM response chunk-by-chunk, accumulates text, and pulls
// out *complete sentences* whenever it can. The leftover (partial
// sentence at the trailing edge) stays in the buffer until the next
// chunk lands a boundary, or until `flushRemainder()` forces it out at
// stream end.
//
// Code blocks (``` fences) are stripped: the spoken stream stays
// readable when the LLM dumps a multi-line snippet that nobody wants
// to hear character by character. The fenced text is dropped silently —
// the user still sees it on screen, the speaker just skips it.
//
// Why this is a separate module: the chunk → sentence boundary problem
// is tricky enough (multilingual punctuation, code fences, escaped
// punctuation in URLs) that it deserves its own unit-tested file. The
// auto-TTS controller stays focused on TTS lifecycle and just calls
// `segmenter.feed(chunk)` / `segmenter.flushRemainder()`.

// ── Public types ───────────────────────────────────────────────────

export interface SentenceSegmenter {
  /** Feed a chunk. Returns any sentences that the chunk completed. */
  feed(chunk: string): string[];
  /** Returns whatever's still buffered as a final sentence. The
   *  segmenter is reset after this call (next `feed` starts fresh). */
  flushRemainder(): string[];
  /** Discard buffered state without emitting. Used on ESC cancel. */
  reset(): void;
  /** True when an unmatched ``` opener has been seen — for tests +
   *  diagnostics. */
  isInCodeFence(): boolean;
}

export interface SentenceSegmenterOpts {
  /** Hard cap on the buffered, not-yet-emitted text. When exceeded,
   *  the buffer is emitted as a single forced sentence so a runaway
   *  response without sentence punctuation (e.g. one giant URL line)
   *  can't pile up forever. Default 2000 chars · `ELANOUS_AUTO_TTS_MAX_LENGTH`. */
  maxSentenceChars?: number;
}

// Sentence boundaries: ASCII `.?!` plus the common CJK fullwidth
// punctuation `。？！` (Korean / Japanese / Chinese all use these).
// Newlines also count — markdown lists / paragraphs split on `\n`.
const BOUNDARY_CHARS = new Set(['.', '?', '!', '。', '？', '！']);

const FENCE_TOKEN = '```';

const DEFAULT_MAX_SENTENCE_CHARS = 2000;

// ── Implementation ─────────────────────────────────────────────────

export function createSentenceSegmenter(opts: SentenceSegmenterOpts = {}): SentenceSegmenter {
  const maxChars = opts.maxSentenceChars ?? DEFAULT_MAX_SENTENCE_CHARS;
  let buffer = '';
  let inFence = false;
  // When a chunk lands mid-fence-token (e.g. "..` `\n"), defer judging
  // the boundary until we have a couple more chars. Tracking a small
  // pending tail keeps the toggle robust to chunk splits.
  let pendingFenceTail = '';

  function feed(chunk: string): string[] {
    const text = pendingFenceTail + chunk;
    pendingFenceTail = '';
    const out: string[] = [];

    let i = 0;
    while (i < text.length) {
      // Code-fence boundary handling — flip state at every ```. Anything
      // inside the fence is dropped from `buffer`.
      const fenceIdx = text.indexOf(FENCE_TOKEN, i);
      if (fenceIdx === -1) {
        const tail = text.slice(i);
        // If the trailing fragment ends in 1-2 backticks, those might
        // be the head of a fence opener / closer split across the next
        // chunk. Defer ALL trailing backticks (not just one) so chunks
        // like ['..', '`code'] can be assembled into '```code' on the
        // next feed and the fence flips correctly.
        const trailMatch = /[`]{1,2}$/.exec(tail);
        if (trailMatch) {
          const trailLen = trailMatch[0].length;
          pendingFenceTail = tail.slice(tail.length - trailLen);
          if (!inFence) buffer += tail.slice(0, tail.length - trailLen);
        } else {
          if (!inFence) buffer += tail;
        }
        break;
      }

      // Process up to the fence token, then toggle.
      if (!inFence) buffer += text.slice(i, fenceIdx);
      inFence = !inFence;
      i = fenceIdx + FENCE_TOKEN.length;
    }

    // Extract sentences from `buffer`.
    while (true) {
      const cut = findSentenceCut(buffer);
      if (cut === -1) break;
      const sentence = buffer.slice(0, cut + 1).trim();
      buffer = buffer.slice(cut + 1).replace(/^\s+/, '');
      if (sentence) out.push(sentence);
    }

    // Newline-only splits — emit anything terminated by `\n` even
    // without sentence punctuation (markdown bullets / paragraphs).
    while (true) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1).replace(/^\s+/, '');
      if (line) out.push(line);
    }

    // Hard cap — force-flush a runaway buffer.
    if (buffer.length >= maxChars) {
      const forced = buffer.trim();
      if (forced) out.push(forced);
      buffer = '';
    }

    return out;
  }

  function flushRemainder(): string[] {
    const tail = (pendingFenceTail + buffer).trim();
    buffer = '';
    pendingFenceTail = '';
    inFence = false;
    return tail ? [tail] : [];
  }

  function reset(): void {
    buffer = '';
    pendingFenceTail = '';
    inFence = false;
  }

  function isInCodeFence(): boolean {
    return inFence;
  }

  return { feed, flushRemainder, reset, isInCodeFence };
}

/** Find the first sentence-terminator in `s`. Returns the position of
 *  the boundary char, or -1 if none. URLs (`https://example.com/foo.bar`)
 *  are not handled specially — the cost of a brief mid-URL pause is
 *  preferable to a big NLP detector. */
function findSentenceCut(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch && BOUNDARY_CHARS.has(ch)) {
      // Require the next char to be whitespace, end-of-string, or a
      // closing quote/paren — a `.` followed immediately by a digit or
      // letter is probably a decimal or initialism, not a boundary.
      const next = s[i + 1];
      if (next === undefined || /[\s)\]'"」』）】]/.test(next)) {
        return i;
      }
    }
  }
  return -1;
}
