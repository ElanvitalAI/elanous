import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { createVoiceCostTracker, setGlobalVoiceCostTrackerForTesting } from '../src/voice/cost-tracker.js';
import { OpenAITTSProvider } from '../src/voice/tts/tts-providers/openai-tts.js';
import { ElevenLabsTTSProvider } from '../src/voice/tts/tts-providers/elevenlabs-tts.js';

const originalFetch = globalThis.fetch;
const SECRET = 'TTS_SECRET_KEY';
const SPOKEN = 'SPOKEN_TEXT_BODY';
const restoreTracker = setGlobalVoiceCostTrackerForTesting(createVoiceCostTracker({ disablePersist: true }));
afterAll(() => { restoreTracker(); });
afterEach(() => { globalThis.fetch = originalFetch; });
const attempts = () => debug.events(100).filter(e => e.category === 'llm.call' && e.event === 'attempt');

describe('TTS sends are rows in the LLM call ledger', () => {
  test('OpenAI and ElevenLabs batch synthesis each leave one attempt row, without key or text', async () => {
    debug.clear();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response(new Uint8Array(Buffer.from('pcm'))); }) as typeof fetch;
    await new OpenAITTSProvider({ id: 'openai-tts', apiKey: SECRET, baseUrl: 'https://tts.openai.example.test' }).synthesizeBatch(SPOKEN);
    await new ElevenLabsTTSProvider({ id: 'elevenlabs-tts', apiKey: SECRET, modelId: 'eleven-actual' }).synthesizeBatch(SPOKEN);
    const rows = attempts();
    expect(rows).toHaveLength(calls.length);
    expect(rows.map(row => row.data)).toEqual([
      expect.objectContaining({ provider: 'openai', host: 'tts.openai.example.test', role: 'aux', requestedBy: 'voice-tts', billing: 'apikey' }),
      expect.objectContaining({ provider: 'elevenlabs', model: 'eleven-actual', role: 'aux', requestedBy: 'voice-tts', billing: 'apikey' }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SPOKEN);
  });

  test('a refused send is still one attempt row and the provider error is unchanged', async () => {
    debug.clear();
    globalThis.fetch = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    await expect(new OpenAITTSProvider({ id: 'openai-tts', apiKey: SECRET }).synthesizeBatch(SPOKEN)).rejects.toThrow(/OpenAI TTS API error/);
    expect(attempts().map(row => row.data)).toEqual([expect.objectContaining({ provider: 'openai', requestedBy: 'voice-tts' })]);
  });
});
