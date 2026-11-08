/** §3.4 (2026-04-30) — provider audio capability map. Caller (turn
 *  assembly / acpPromptToLlmContent) checks this before forwarding an
 *  `audio` ContentBlock to a provider that would 400 on it. Confirmed
 *  via omni-crawl 2026-04-30:
 *
 *  - **OpenAI Chat Completions**: `gpt-4o-audio-preview` +
 *    `gpt-4o-realtime-preview` accept `input_audio` (data + format,
 *    format ∈ {wav, mp3}). Other GPT models 400 on the field.
 *    https://platform.openai.com/docs/api-reference/chat/create
 *  - **Anthropic Claude**: no audio input via Messages API as of
 *    2026-04 — wishlist (anthropic-sdk-python#1198). Caller must
 *    transcribe upstream + send text. Always returns false.
 *  - **xAI Grok**: Chat Completions does NOT accept audio. The
 *    `Voice Agent` API is a separate WebSocket endpoint
 *    (`wss://api.x.ai/v1/realtime`) — out of elanous's Chat Completions
 *    routing scope. Always returns false for Chat path.
 *    https://docs.x.ai/developers/model-capabilities/audio/voice
 *  - **Gemini**: native `inlineData` audio (wav/mp3/aiff/aac/ogg/flac)
 *    via `generateContent`. elanous routes Gemini through the native
 *    `generateContentStream` SDK call (see callGeminiStream below ·
 *    line 2339) — toGeminiContents (line 2080+) builds inline parts
 *    with mimeType + base64 for image/video/**audio** (W8-A 후속 #3 ·
 *    2026-05-14 audio block dispatch land). Returns true for any
 *    Gemini 1.5+ family model.
 *  - **Local (ollama)**: no audio support — false.
 *
 *  Exported so dashboard / acp / channel adapters can pre-filter
 *  audio blocks with a provider-aware decision instead of relying on
 *  a 400 to surface the issue. */
export function providerSupportsAudio(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // OpenAI audio-preview / realtime-preview families.
  if (m.includes('audio-preview')) return true;
  if (m.includes('realtime-preview')) return true;
  // Future-proof: any *-audio-* / *-realtime-* convention.
  if (m.startsWith('gpt-4o-audio')) return true;
  if (m.startsWith('gpt-4o-realtime')) return true;
  // W8-A 후속 #3 (2026-05-14) — Gemini 1.5+ family native audio via
  // generateContentStream inlineData. toGeminiContents audio block
  // dispatch land.
  if (m.startsWith('gemini-')) return true;
  // Anthropic / xAI Grok / Local: no confirmed Chat-Completions audio
  // support as of 2026-04-30.
  return false;
}

/** PR8 (2026-05-14) — provider video capability map. Caller (turn
 *  assembly / acpPromptToLlmContent) checks this before forwarding a
 *  `video` ContentBlock to a provider that would 400 on it. Confirmed
 *  via omni-crawl 2026-05-14:
 *
 *  - **Gemini 1.5+ (native generateContent path)**: native `inlineData`
 *    video (mp4/quicktime/webm/mpeg/x-flv/x-msvideo/3gpp). Inline ≤20MB
 *    via `inlineData`; bigger needs Files API upload (deferred — out of
 *    scope for this PR · resource_link path can replace).
 *    https://ai.google.dev/gemini-api/docs/vision#video
 *  - **Anthropic Claude**: no video input via Messages API as of 2026-05.
 *    Always returns false.
 *  - **OpenAI Chat Completions**: no video input. Realtime Video API is
 *    a separate WebSocket endpoint — out of elanous's Chat Completions
 *    routing scope. Always returns false for Chat path.
 *  - **xAI Grok**: no video input via Chat Completions. Always false.
 *  - **Local (ollama / Qwen 2.5 VL etc.)**: format-specific · provider-
 *    side wire varies. Conservative false until per-model wiring lands.
 *
 *  Exported so dashboard / acp / channel adapters can pre-filter video
 *  blocks with a provider-aware decision instead of relying on a 400. */
export function providerSupportsVideo(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // Gemini 1.5+ all support inlineData video on user role per
  // generateContent spec. elanous currently routes Gemini through the
  // OpenAI-compat endpoint OR a native mapper; both branches honor
  // inlineData when the message carries a 'video' block.
  if (m.startsWith('gemini-')) return true;
  if (m.includes('/gemini')) return true; // local-router prefix variant
  return false;
}

