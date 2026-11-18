import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { searchGrok } from '../../skills/omni-crawl/src/grok-search.js';
import { generateMermaidDiagram } from '../../skills/omni-digest/src/diagram.js';
import { summarizeGeneric } from '../../skills/omni-digest/src/summarize.js';
import { describeImages } from '../../skills/omni-digest/src/visual.js';
import { summarize } from '../../skills/youtube-master/src/summarize.js';
import { transcribeChunks } from '../../skills/youtube-master/src/stt.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SKILL-LITE1: the skills vendored `llmNetworkFetch` (skills/*/src/llm-network-fetch.ts)
// and emit their ledger rows through this host hook instead of importing the repo debug
// facade — standalone (public pack / lite Pod) the hook is absent and telemetry is skipped.
(globalThis as { __elanousDebugLog?: (category: string, event: string, data?: unknown) => void }).__elanousDebugLog =
  (category, event, data) => { debug.log(category, event, data as Record<string, unknown>); };

const originalFetch = globalThis.fetch;
const keys = ['XAI_API_KEY', 'GROK_MODEL', 'GROK_VISION_MODEL', 'OPENAI_API_KEY', 'OPENAI_SUMMARY_MODEL', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'YOUTUBE_SUMMARY2_STT', 'ELANOUS_KEEP_ENV_KEYS'] as const;
const originalEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const secret = 'not-for-telemetry';
const calls: Array<{ url: string; init: RequestInit }> = [];
let responses: Response[] = [];
let work: string | undefined;
function attempts() { return debug.events(500).filter(e => e.category === 'llm.call' && e.event === 'attempt'); }
function mock(...items: Response[]) {
  responses = items;
  calls.length = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const response = responses.shift();
    if (!response) throw new Error('unexpected network request');
    return response;
  }) as typeof fetch;
}
function output(text: string) {
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
}
function assertLedger(before: number, expected: Array<{ provider: string; model: string; host: string; requestedBy: string }>) {
  const rows = attempts().slice(before);
  expect(rows).toHaveLength(expected.length);
  for (const [i, fields] of expected.entries()) {
    expect(rows[i]?.data).toMatchObject({ ...fields, role: 'aux' });
    expect(JSON.stringify(rows[i])).not.toContain(secret);
    expect(JSON.stringify(rows[i])).not.toContain('/v1/');
    expect(JSON.stringify(rows[i])).not.toContain('?key=');
  }
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of keys) {
    const value = originalEnv[k];
    if (value === undefined) delete process.env[k]; else process.env[k] = value;
  }
  if (work) { rmSync(work, { recursive: true, force: true }); work = undefined; }
});

describe('skills LLM generation gateway', () => {
  test('omni-crawl Grok search retains request and parsed citations', async () => {
    process.env.XAI_API_KEY = secret;
    mock(Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'found', annotations: [{ url: 'https://example.org' }] }] }] }));
    const before = attempts().length;
    const result = await searchGrok({ query: 'needle', mode: 'web', model: 'light' });
    expect(result.rawText).toBe('found');
    expect(result.annotations).toEqual(['https://example.org']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ model: 'grok-4-1-fast-non-reasoning', tools: [{ type: 'web_search' }] });
    assertLedger(before, [{ provider: 'grok', model: 'grok-4-1-fast-non-reasoning', host: 'api.x.ai', requestedBy: 'omni-crawl' }]);
  });

  test('omni-digest diagram, summary and vision preserve payloads and output', async () => {
    process.env.XAI_API_KEY = secret;
    process.env.GROK_MODEL = 'grok-test';
    process.env.GROK_VISION_MODEL = 'grok-vision-test';
    mock(output('```mermaid\ngraph TD\n```'), output('summary'), output('image description'));
    const before = attempts().length;
    expect(await generateMermaidDiagram('content')).toContain('graph TD');
    expect(await summarizeGeneric('content', 'title', 'web', undefined, 'essential')).toBe('summary');
    expect(await describeImages(['https://example.org/image.png'], 'describe')).toBe('image description');
    expect(calls.map(c => JSON.parse(c.init.body as string).model)).toEqual(['grok-test', 'grok-test', 'grok-vision-test']);
    expect(JSON.parse(calls[2]!.init.body as string).input[0].content[1].image_url).toBe('https://example.org/image.png');
    assertLedger(before, ['grok-test', 'grok-test', 'grok-vision-test'].map(model => ({ provider: 'grok', model, host: 'api.x.ai', requestedBy: 'omni-digest' })));
  });

  test('youtube summary Grok failure falls back to OpenAI, logging both attempts', async () => {
    process.env.XAI_API_KEY = secret;
    process.env.OPENAI_API_KEY = secret;
    process.env.GROK_MODEL = 'grok-test';
    process.env.OPENAI_SUMMARY_MODEL = 'gpt-test';
    mock(new Response('unavailable', { status: 503 }), output('fallback summary'));
    const before = attempts().length;
    expect(await summarize({ transcript: 'some words', meta: { title: 'title', channel: 'channel', videoUrl: 'https://youtube.com/watch?v=1' }, format: 'brief' })).toBe('fallback summary');
    expect(calls.map(c => c.url)).toEqual(['https://api.x.ai/v1/responses', 'https://api.openai.com/v1/responses']);
    assertLedger(before, [
      { provider: 'grok', model: 'grok-test', host: 'api.x.ai', requestedBy: 'youtube-master' },
      { provider: 'openai', model: 'gpt-test', host: 'api.openai.com', requestedBy: 'youtube-master' },
    ]);
  });

  test('youtube OpenAI and ElevenLabs STT retain multipart payload and model attribution', async () => {
    work = mkdtempSync(join(tmpdir(), 'skill-llm-stt-'));
    const chunk = join(work, 'chunk.mp3');
    writeFileSync(chunk, 'fake audio');
    process.env.OPENAI_API_KEY = secret;
    process.env.YOUTUBE_SUMMARY2_STT = 'openai';
    mock(new Response('openai transcript'));
    let before = attempts().length;
    expect((await transcribeChunks([chunk])).transcript).toBe('openai transcript');
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect((calls[0]?.init.body as FormData).get('model')).toBe('gpt-4o-mini-transcribe');
    assertLedger(before, [{ provider: 'openai', model: 'gpt-4o-mini-transcribe', host: 'api.openai.com', requestedBy: 'youtube-master' }]);

    process.env.ELEVENLABS_API_KEY = secret;
    process.env.YOUTUBE_SUMMARY2_STT = 'elevenlabs';
    mock(Response.json({ text: 'elevenlabs transcript' }));
    before = attempts().length;
    expect((await transcribeChunks([chunk])).transcript).toBe('elevenlabs transcript');
    expect(calls[0]?.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((calls[0]?.init.body as FormData).get('model_id')).toBe('scribe_v2');
    assertLedger(before, [{ provider: 'elevenlabs', model: 'scribe_v2', host: 'api.elevenlabs.io', requestedBy: 'youtube-master' }]);
  });

  test('youtube Gemini STT counts inference only, not file upload/delete', async () => {
    process.env.YOUTUBE_SUMMARY2_STT = 'gemini';
    process.env.GEMINI_API_KEY = secret;
    work = mkdtempSync(join(tmpdir(), 'skill-llm-stt-'));
    const chunk = join(work, 'chunk.mp3');
    writeFileSync(chunk, 'fake audio');
    mock(new Response('{}', { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/session' } }),
      Response.json({ file: { uri: 'files/test', name: 'files/test' } }),
      Response.json({ candidates: [{ content: { parts: [{ text: 'transcribed' }] } }] }),
      Response.json({}));
    const before = attempts().length;
    expect((await transcribeChunks([chunk])).transcript).toBe('transcribed');
    expect(calls).toHaveLength(4);
    expect(calls[2]?.url).toContain(':generateContent?key=');
    assertLedger(before, [{ provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', host: 'generativelanguage.googleapis.com', requestedBy: 'youtube-master' }]);
  });
});
