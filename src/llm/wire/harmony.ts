// ─── OpenAI Harmony channel filter ──────────────────────────────────
//
// gpt-oss / gemma-4 / qwen3-thinking et al. emit OpenAI Harmony tokens
// into `delta.content` when LM Studio (or vLLM / Ollama) passes the
// model's native channel-formatted output through the OpenAI-compat
// `/v1/chat/completions` endpoint without stripping markers.
//
// Spec (https://developers.openai.com/cookbook/articles/openai-harmony +
// https://github.com/openai/harmony · verified via omni-crawl 2026-05-14):
//   - `<|start|>{role}[<|channel|>{channel} [to=...] [<|constrain|>json]] <|message|>{content}{<|end|>|<|return|>|<|call|>}`
//   - Channels (assistant-only): `final` (user-facing) · `analysis`
//     (internal CoT) · `commentary` (tool calls / preambles).
//   - Some non-OpenAI fine-tunes use `thought` as an alias for
//     `analysis` (seen with `mlx-community/gemma-4-26b-a4b-it` on
//     LM Studio 2026-05-14 dogfood).
//
// Routing policy:
//   - `final` channel content → user-facing text delta (text)
//   - `analysis` / `thought` → reasoning delta (renders in thinking pane)
//   - `commentary` → reasoning delta (lower-stakes; tool calls themselves
//     arrive via the OpenAI `tool_calls` API path, not via channel
//     content)
//   - Unknown channel → reasoning delta (safer than discarding)
//
// Marker tokens consumed (never emitted as content):
//   `<|start|>` `<|end|>` `<|return|>` `<|call|>` `<|message|>` `<|channel|>` `<|constrain|>`
//
// Backwards compat: when the stream NEVER produces a `<|channel|>` or
// `<|start|>` marker, all content passes through as text unchanged —
// existing non-Harmony providers (Anthropic, Codex, vanilla OpenAI,
// Gemini) see no behavior change.
//
// Stream safety: deltas may split markers mid-token. The filter
// buffers the trailing unrecognised prefix (potential partial marker)
// until either the marker completes or it's proven to NOT be a marker.

export interface HarmonyToolCall {
  name: string;
  argsJson: string;
}

interface HarmonyFilterOutput {
  textDelta: string;
  reasoningDelta: string;
  /** Tool calls decoded from the Harmony `commentary to=functions.X …
   *  <|call|>` channel. gemma-4 / gpt-oss on LM Studio route tool calls
   *  through channel *content* (not the native OpenAI `tool_calls`
   *  field), so without this they were silently rendered as reasoning
   *  text and never executed. Undefined on normal streams. */
  toolCalls?: HarmonyToolCall[];
}

type HarmonyState = 'pre' | 'header' | 'header_broken' | 'body';
type HarmonyChannel = 'final' | 'analysis' | 'thought' | 'commentary' | 'unknown';

const HARMONY_MARKERS = [
  '<|start|>',
  '<|end|>',
  '<|return|>',
  '<|call|>',
  '<|message|>',
  '<|channel|>',
  '<|constrain|>',
  // 2026-05-14 dogfood — tolerant variants for fine-tunes that emit
  // malformed Harmony tokens. mlx-community/gemma-4-26b-a4b-it on
  // LM Studio streams `<|channel>thought\n<channel|>` instead of
  // the spec `<|channel|>thought<|message|>...<|end|>`. We treat:
  //   - `<|channel>`  as a "broken open" — channel name follows
  //                   inline (header-broken state), terminated by
  //                   the next whitespace; body starts immediately
  //                   without `<|message|>`.
  //   - `<channel|>`  as a "broken close" — equivalent to `<|end|>`.
  // The classic `<|channel|>` (with both pipes) still works.
  '<|channel>',
  '<channel|>',
] as const;

export class HarmonyChannelFilter {
  private buffer = '';
  private state: HarmonyState = 'pre';
  private channel: HarmonyChannel = 'unknown';
  private headerBuffer = '';
  private harmonySeen = false;
  // Harmony tool-call decoding: gemma-4 / gpt-oss emit tool calls via
  // the `commentary to=functions.X` channel + `<|call|>` terminator
  // instead of the native tool_calls field. `pendingToolName` is set
  // while a tool-call body streams; its content buffers into
  // `toolArgsBuffer`; finalized calls collect in `completedToolCalls`
  // and drain out on each push()/flush().
  private pendingToolName: string | null = null;
  private toolArgsBuffer = '';
  private completedToolCalls: HarmonyToolCall[] = [];
  // Set after a `<|constrain|>` marker so the trailing constraint value
  // (e.g. `json`) is swallowed instead of corrupting the header/tool
  // name. Cleared when a new header starts or the body begins.
  private headerSwallow = false;

  push(chunk: string): HarmonyFilterOutput {
    this.buffer += chunk;
    let textOut = '';
    let reasoningOut = '';

    while (this.buffer.length > 0) {
      // Locate the next `<` (potential marker start). All Harmony
      // markers — both spec (`<|channel|>`, `<|end|>`, ...) and the
      // gemma-4 tolerant variants (`<|channel>`, `<channel|>`) —
      // begin with `<`. Scanning on bare `<` instead of `<|` is the
      // only way the broken-close `<channel|>` (no leading `<|`)
      // gets reached. False positives (legitimate `<` in content,
      // e.g. `2 < 3`) cost a single literal-emit iteration each.
      const markerStart = this.buffer.indexOf('<');
      const safeEnd = markerStart === -1 ? this.buffer.length : markerStart;

      // Flush safe content (before any `<`) to the current sink.
      if (safeEnd > 0) {
        const safe = this.buffer.slice(0, safeEnd);
        this.routeContent(safe, (text, reasoning) => {
          textOut += text;
          reasoningOut += reasoning;
        });
        this.buffer = this.buffer.slice(safeEnd);
      }

      // No marker start at all → done.
      if (markerStart === -1) break;

      // Try to consume a complete marker at the buffer head.
      const consumed = this.tryConsumeMarker();
      if (consumed === 'partial') {
        // Wait for more chunks to complete the marker.
        break;
      }
      if (consumed === 'consumed') {
        // Marker ate buffer prefix · loop continues.
        continue;
      }
      // `consumed === 'literal'` — buffer starts with `<` but it's
      // not a Harmony marker (legitimate content `<foo>`, `2 < 3`).
      // Emit the leading `<` as content and let the loop reprocess
      // the rest.
      this.routeContent(this.buffer[0]!, (text, reasoning) => {
        textOut += text;
        reasoningOut += reasoning;
      });
      this.buffer = this.buffer.slice(1);
    }

    return this.drain(textOut, reasoningOut);
  }

  /** Flush any trailing buffered partial-marker state as if it were
   *  literal content. Called on stream end so a half-formed `<|cha`
   *  doesn't get silently dropped. */
  flush(): HarmonyFilterOutput {
    let textOut = '';
    let reasoningOut = '';
    if (this.buffer.length > 0) {
      this.routeContent(this.buffer, (text, reasoning) => {
        textOut += text;
        reasoningOut += reasoning;
      });
      this.buffer = '';
    }
    // Stream ended mid tool-call (no explicit terminator) — emit what
    // we have so a trailing call isn't lost.
    this.finalizePendingTool();
    return this.drain(textOut, reasoningOut);
  }

  private routeContent(
    content: string,
    sink: (text: string, reasoning: string) => void,
  ): void {
    if (content.length === 0) return;
    if (this.state === 'header') {
      // Accumulate header text — parsed on `<|message|>`. After a
      // `<|constrain|>` marker the constraint value (e.g. `json`) is
      // swallowed so it doesn't get appended to the tool name.
      if (!this.headerSwallow) this.headerBuffer += content;
      return;
    }
    if (this.state === 'header_broken') {
      // gemma-4 variant: channel name follows `<|channel>` inline,
      // terminated by the first whitespace/newline. Anything before
      // the whitespace is the channel name; whitespace itself
      // terminates the header + enters BODY (no `<|message|>`
      // needed). Body content (if any) follows in subsequent
      // routeContent calls.
      for (let i = 0; i < content.length; i++) {
        const ch = content[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          this.applyParsedHeader(this.headerBuffer);
          this.headerBuffer = '';
          this.state = 'body';
          // Remaining content after the terminating whitespace
          // belongs to the body — recurse with the tail. The
          // whitespace itself is swallowed (it's the header
          // terminator, not content).
          const tail = content.slice(i + 1);
          if (tail.length > 0) this.routeContent(tail, sink);
          return;
        }
        this.headerBuffer += ch;
      }
      return;
    }
    if (this.state === 'pre') {
      // Before any Harmony marker: pass content as text for
      // backwards compat with non-Harmony streams. Once we've seen
      // a marker, content in `pre` is discarded (it's between
      // messages — `<|end|>{...}<|start|>` whitespace etc.).
      if (!this.harmonySeen) {
        sink(content, '');
      }
      return;
    }
    // state === 'body'
    if (this.pendingToolName !== null) {
      // Harmony tool-call args JSON — buffer for emission on the
      // terminator marker instead of leaking into reasoning text.
      this.toolArgsBuffer += content;
      return;
    }
    switch (this.channel) {
      case 'final':
        sink(content, '');
        break;
      case 'analysis':
      case 'thought':
      case 'commentary':
      case 'unknown':
        sink('', content);
        break;
    }
  }

  /** Attempt to consume a marker at the current buffer head.
   *  Returns:
   *    - 'consumed' if a full marker was recognised and consumed
   *    - 'partial' if the buffer head is a prefix of a known marker
   *      (caller should wait for more input)
   *    - 'literal' if the `<|` is followed by non-marker text */
  private tryConsumeMarker(): 'consumed' | 'partial' | 'literal' {
    for (const marker of HARMONY_MARKERS) {
      if (this.buffer.startsWith(marker)) {
        this.buffer = this.buffer.slice(marker.length);
        this.handleMarker(marker);
        return 'consumed';
      }
    }
    // Buffer head is `<|` but no full marker yet — is it a prefix?
    for (const marker of HARMONY_MARKERS) {
      if (marker.startsWith(this.buffer)) return 'partial';
    }
    return 'literal';
  }

  private handleMarker(marker: string): void {
    this.harmonySeen = true;
    switch (marker) {
      case '<|channel|>':
        this.state = 'header';
        this.headerBuffer = '';
        this.headerSwallow = false;
        break;
      case '<|channel>':
        // gemma-4 broken-open variant — no trailing `|`. Channel
        // name follows inline, terminated by whitespace, body
        // starts immediately (no `<|message|>` separator).
        this.state = 'header_broken';
        this.headerBuffer = '';
        this.headerSwallow = false;
        break;
      case '<|message|>':
        // Header complete; parse channel + optional tool target.
        this.applyParsedHeader(this.headerBuffer);
        this.headerBuffer = '';
        this.state = 'body';
        break;
      case '<|end|>':
      case '<|return|>':
      case '<|call|>':
      case '<channel|>':
        // `<|call|>` is the Harmony tool-call terminator; `<|end|>` /
        // `<|return|>` end a normal message; `<channel|>` is the gemma-4
        // broken-close variant. Finalize any pending tool-call body on
        // all of them (gemma-4 occasionally closes a call with the
        // broken `<channel|>` rather than the spec `<|call|>`).
        this.finalizePendingTool();
        this.state = 'pre';
        this.channel = 'unknown';
        this.headerBuffer = '';
        break;
      case '<|start|>':
        // Start of a new message — wait for `<|channel|>` to set
        // routing. Finalize a dangling tool call first (malformed
        // boundary) so it isn't lost. State stays 'pre' until then.
        this.finalizePendingTool();
        this.state = 'pre';
        this.channel = 'unknown';
        this.headerBuffer = '';
        break;
      case '<|constrain|>':
        // `<|constrain|>json` appears in the header before
        // `<|message|>` — swallow the constraint value so it doesn't
        // corrupt the tool name (the decode implies json).
        this.headerSwallow = true;
        break;
    }
  }

  /** Parse a completed Harmony header into channel + optional tool
   *  target, and prime tool-call buffering when a `to=functions.X`
   *  target is present. */
  private applyParsedHeader(header: string): void {
    const { channel, toolName } = parseHarmonyHeader(header);
    this.channel = channel;
    this.pendingToolName = toolName;
    this.toolArgsBuffer = '';
    this.headerSwallow = false;
  }

  /** Emit the in-flight Harmony tool call (if any) into the completed
   *  queue and reset the buffers. No-op when no tool call is pending. */
  private finalizePendingTool(): void {
    if (this.pendingToolName === null) return;
    this.completedToolCalls.push({
      name: this.pendingToolName,
      argsJson: this.toolArgsBuffer,
    });
    this.pendingToolName = null;
    this.toolArgsBuffer = '';
  }

  /** Build the output object, draining any completed tool calls. */
  private drain(textOut: string, reasoningOut: string): HarmonyFilterOutput {
    const out: HarmonyFilterOutput = { textDelta: textOut, reasoningDelta: reasoningOut };
    if (this.completedToolCalls.length > 0) {
      out.toolCalls = this.completedToolCalls;
      this.completedToolCalls = [];
    }
    return out;
  }
}

function parseHarmonyHeader(header: string): { channel: HarmonyChannel; toolName: string | null } {
  // Header shape: `final` · `analysis` · `commentary` ·
  // `commentary to=functions.X` · `final to=user`. The channel is the
  // first whitespace-delimited token; a `to=functions.NAME` (or bare
  // `to=NAME`) marks a tool call. `to=user`/`to=assistant` are message
  // routing, not tool calls.
  const trimmed = header.trim();
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  const channel: HarmonyChannel =
    first === 'final' ? 'final'
      : first === 'analysis' ? 'analysis'
        : first === 'thought' ? 'thought'
          : first === 'commentary' ? 'commentary'
            : 'unknown';
  const m = trimmed.match(/to=(?:functions\.)?([A-Za-z0-9_.\-]+)/i);
  const raw = m ? m[1]! : null;
  const rawLower = raw?.toLowerCase();
  const toolName = raw && rawLower !== 'user' && rawLower !== 'assistant' ? raw : null;
  return { channel, toolName };
}
