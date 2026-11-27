// GOAL-ORCHESTRATION-VOICE — the voice node with a mocked TTS: speech text bound, key sources in order, the mp3 lands
// next to the receipt and reaches publish as $ORCH_VOICE_FILE, and every voice failure is «voice skipped» (run still met).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandScript, simBackend } from './backends.js';
import { runOrchestration } from './runner.js';
import { validateSpec, type OrchestrationSpec } from './spec.js';
import { templateFor } from './templates.js';
import { DEFAULT_MODEL_ID, DEFAULT_VOICE_ID, goalLanguage, hangulRatio, resolveElevenLabsKey, runVoice, speechText, VOICE_MAX_CHARS, type Tts } from './voice.js';

const loopSpec = (over: Record<string, unknown> = {}): OrchestrationSpec => {
  const r = validateSpec({ ...templateFor('loop-until', 'voice goal', []), reduce: { method: 'last', success: 'all-ok' }, ...over });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec!;
};
const tmp = (): string => mkdtempSync(join(tmpdir(), 'orch-voice-'));

describe('speechText', () => {
  test('strips markdown and keeps sentences', () => {
    expect(speechText('# 내일 시장\n\n- **코스피** 강세\n- [뉴스](http://x) 요약\n\n---\n`code`')).toBe('내일 시장. 코스피 강세. 뉴스 요약. code.');
  });
  test('bounded near 1,500 characters at a sentence end', () => {
    const long = Array.from({ length: 200 }, (_, i) => `- 문장 ${i} 입니다`).join('\n');
    const t = speechText(long);
    expect(VOICE_MAX_CHARS).toBe(1500);
    expect(t.length).toBeLessThanOrEqual(1500);
    expect(t.length).toBeGreaterThan(900);
    expect(t.endsWith('.')).toBe(true);
  });
});

describe('resolveElevenLabsKey — product sources only, in order', () => {
  test('env first', async () => {
    expect(await resolveElevenLabsKey({ ELEVENLABS_API_KEY: ' env-k ' }, { cacheDir: '/nonexistent', getSecret: async () => 'store-k' })).toBe('env-k');
  });
  test('then the service-key cache file', async () => {
    const d = tmp();
    writeFileSync(join(d, 'elevenlabs_api_key'), 'cache-k\n');
    expect(await resolveElevenLabsKey({}, { cacheDir: d, getSecret: async () => 'store-k' })).toBe('cache-k');
    rmSync(d, { recursive: true, force: true });
  });
  test('then the secret store elevenlabs.apiKey', async () => {
    const asked: string[] = [];
    expect(await resolveElevenLabsKey({}, { cacheDir: '/nonexistent', getSecret: async (id) => { asked.push(id); return 'store-k'; } })).toBe('store-k');
    expect(asked).toEqual(['elevenlabs.apiKey']);
  });
  test('none → undefined; a broken store is not a crash', async () => {
    expect(await resolveElevenLabsKey({}, { cacheDir: '/nonexistent', getSecret: async () => { throw new Error('store down'); } })).toBeUndefined();
  });
});

describe('runVoice', () => {
  test('mocked TTS → mp3 written, text bounded', async () => {
    const d = tmp();
    const seen: string[] = [];
    const tts: Tts = async (text) => { seen.push(text); return new Uint8Array([0x49, 0x44, 0x33, 1, 2]); };
    const r = await runVoice('# 브리핑\n' + '가'.repeat(5000), join(d, 'brief.mp3'), tts);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(d, 'brief.mp3')).byteLength).toBe(5);
    expect(seen[0]!.length).toBeLessThanOrEqual(1500);
    rmSync(d, { recursive: true, force: true });
  });
  test('no key → skipped with a reason, no file', async () => {
    const d = tmp();
    const r = await runVoice('brief', join(d, 'brief.mp3'), undefined);
    expect(r).toMatchObject({ ok: false, why: 'no ElevenLabs key configured' });
    expect(existsSync(join(d, 'brief.mp3'))).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
  test('TTS error → skipped, never throws', async () => {
    const r = await runVoice('brief', join(tmp(), 'brief.mp3'), async () => { throw new Error('TTS provider answered 401'); });
    expect(r).toMatchObject({ ok: false, why: 'TTS provider answered 401' });
  });
});

describe('voice node in the run', () => {
  test('Voice ✓: phase between check and publish, mp3 path reaches publish, receipt shows Voice ✓', async () => {
    const events: Record<string, unknown>[] = [];
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const lines: string[] = [];
    const backend = { ...simBackend({ seed: 1, strong: true }), runCommand: async (_j: unknown, _c: string, _r: string, _s: AbortSignal, extraEnv?: Readonly<Record<string, string>>) => { envs.push(extraEnv); return { ok: true, text: 'PDF ✓\nTelegram ✓ audio 9' }; } };
    const r = await runOrchestration(loopSpec({ voice: true, publish: { command: 'echo publish' } }), {
      backend, feed: (e) => events.push(e), log: (l) => lines.push(l),
      voice: async () => ({ ok: true, file: '/run/brief.mp3', chars: 42, bytes: 1000 }),
    });
    expect(r.status).toBe('met');
    const phases = events.map((e) => e.phase);
    expect(phases.indexOf('voice')).toBeGreaterThan(phases.indexOf('check'));
    expect(phases.indexOf('publish')).toBeGreaterThan(phases.indexOf('voice'));
    expect(events[0]!.nodes).toEqual(['plan', 'spawn', 'work', 'reduce', 'check', 'voice', 'publish', 'done']);
    expect(envs).toEqual([{ ORCH_VOICE_FILE: '/run/brief.mp3' }]);
    expect(String(events.at(-1)!.receipt)).toEndWith(' · Voice ✓');
    expect(lines).toContain('Voice ✓ /run/brief.mp3 (42 chars)');
  });
  for (const [name, voice] of [
    ['missing key', async () => ({ ok: false, chars: 10, why: 'no ElevenLabs key configured' })],
    ['TTS throws', async () => { throw new Error('boom'); }],
    ['no voice dep', undefined],
  ] as const) {
    test(`${name} → dim «voice skipped», publish still runs without the mp3, run met`, async () => {
      const events: Record<string, unknown>[] = [];
      const envs: unknown[] = [];
      const lines: string[] = [];
      const backend = { ...simBackend({ seed: 2, strong: true }), runCommand: async (_j: unknown, _c: string, _r: string, _s: AbortSignal, extraEnv?: unknown) => { envs.push(extraEnv); return { ok: true, text: 'PDF ✓' }; } };
      const r = await runOrchestration(loopSpec({ voice: true, publish: { command: 'echo publish' } }), { backend, feed: (e) => events.push(e), log: (l) => lines.push(l), ...(voice ? { voice } : {}) });
      expect(r.status).toBe('met');
      expect(envs).toEqual([{}]);
      expect(String(events.at(-1)!.receipt)).toEndWith(' · voice skipped');
      expect(lines.some((l) => l.startsWith('\x1b[2mvoice skipped — '))).toBe(true);
      expect(r.notes.some((n) => n.startsWith('voice skipped: '))).toBe(true);
    });
  }
  test('no voice in the spec → no voice phase, receipt unchanged', async () => {
    const events: Record<string, unknown>[] = [];
    let called = 0;
    await runOrchestration(loopSpec(), { backend: simBackend({ seed: 3, strong: true }), feed: (e) => events.push(e), voice: async () => { called++; return { ok: true, chars: 1 }; } });
    expect(called).toBe(0);
    expect(events.map((e) => e.phase)).not.toContain('voice');
    expect(String(events.at(-1)!.receipt)).not.toContain('oice');
  });
  test('voice: must be a boolean', () => {
    expect(validateSpec({ ...templateFor('loop-until', 'g', []), voice: 'yes' }).errors).toContain('voice must be true or false');
  });
  test('publish script exports ORCH_VOICE_FILE (only ORCH_* names)', () => {
    const d = tmp();
    const { script } = commandScript({ id: 'publish', title: 'ORCH·publish' }, 'echo hi', 'r', d, { PATH: '/bin', HOME: '/h' }, { ORCH_VOICE_FILE: '/run/brief.mp3', EVIL: 'x' });
    const s = readFileSync(script, 'utf8');
    expect(s).toContain("export ORCH_VOICE_FILE='/run/brief.mp3'");
    expect(s).not.toContain('EVIL');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('reduce prompt with a voice node', () => {
  test('tells the aggregator a voice step follows (no «I can\'t play audio»), in the goal\'s language', async () => {
    const prompts: string[] = [];
    const llm = async (p: string) => { prompts.push(p); return '브리핑 결과입니다.'; };
    const { reduce } = await import('./runner.js');
    const outcomes = [{ jobId: 'j', workerId: 'w', kind: 'eln' as const, ok: true, text: 'data', durationMs: 1, costUsd: 0 }];
    await reduce(loopSpec({ voice: true, reduce: { method: 'llm-summary', success: 'all-ok' } }), outcomes, llm);
    await reduce(loopSpec({ reduce: { method: 'llm-summary', success: 'all-ok' } }), outcomes, llm);
    expect(prompts[0]).toContain('never say you cannot produce or play audio');
    expect(prompts[0]).toContain("Write in the goal's language.");
    expect(prompts[1]).not.toContain('audio');
  });
});

describe('Korean end to end (CEO 11-26)', () => {
  test('Korean goal → Korean language; English goal → none', () => {
    expect(goalLanguage('내일 아침 시장 브리핑 만들어서 음성으로 들려줘')).toBe('Korean');
    expect(goalLanguage('make a market brief')).toBeUndefined();
    expect(hangulRatio('코스피 KOSPI')).toBeCloseTo(3 / 8, 5);
  });
  test('Korean voice and Korean-capable model by default', () => {
    expect(DEFAULT_VOICE_ID).toBe('ksaI0TCD9BstzEzlxj4q');
    expect(DEFAULT_MODEL_ID).toBe('eleven_multilingual_v2');
  });
  test('reduce for a Korean goal demands Korean for the whole result', async () => {
    const prompts: string[] = [];
    const { reduce } = await import('./runner.js');
    const outcomes = [{ jobId: 'j', workerId: 'w', kind: 'eln' as const, ok: true, text: 'English data', durationMs: 1, costUsd: 0 }];
    await reduce(loopSpec({ goal: '내일 아침 시장 브리핑 만들어서 음성으로 들려줘', voice: true, reduce: { method: 'llm-summary', success: 'all-ok' } }), outcomes, async (p) => { prompts.push(p); return '요약'; });
    expect(prompts[0]).toContain('Write the whole result in natural Korean (한국어)');
  });
  test('Korean goal + English brief → voice skipped (no English narration), TTS never called', async () => {
    let called = 0;
    const r = await runVoice('Stay cautious ahead of the open. KOSPI fell.', join(tmp(), 'brief.mp3'), async () => { called++; return new Uint8Array([1]); }, undefined, { language: 'Korean' });
    expect(r).toMatchObject({ ok: false, why: 'brief is not in Korean' });
    expect(called).toBe(0);
  });
  test('Korean brief with inline (https://…) URLs and an English «## 출처» list → spoken in Korean, no URL', async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `${i + 1}. Firecrawl search — Global markets rally as investors weigh central bank outlook and earnings season ${i} · https://news.example.com/markets/article-${i}?utm_source=feed · 2026-11-26T03:00:00.000Z`).join('\n');
    const brief = `# 내일 아침 시장 브리핑\n\n- 코스피는 외국인 매도로 하락했습니다 (https://finance.example.com/quote/KS11?range=1d&interval=5m).\n- 원달러 환율은 상승했습니다 (https://www.example.org/markets/currencies/usd-krw-exchange-rate-today).\n- 미국 증시는 기술주 중심으로 올랐습니다 https://www.reuters.example/markets/us/stocks-rally-tech-earnings-2026-11-25/\n\n## 출처\n${titles}\n\n### 출처 없음\n- x-pulse (via Grok search): 출처 확보 실패`;
    expect(hangulRatio(brief)).toBeLessThan(0.5);
    const text = speechText(brief);
    expect(text).not.toMatch(/https?:|www\.|\(\s*\)/u);
    expect(text).not.toContain('Firecrawl');
    expect(text).not.toMatch(/ {2}/u);
    expect(hangulRatio(text)).toBeGreaterThanOrEqual(0.5);
    expect(text).toBe('내일 아침 시장 브리핑. 코스피는 외국인 매도로 하락했습니다. 원달러 환율은 상승했습니다. 미국 증시는 기술주 중심으로 올랐습니다.');
    const seen: string[] = [];
    const r = await runVoice(brief, join(tmp(), 'brief.mp3'), async (t) => { seen.push(t); return new Uint8Array([1]); }, undefined, { language: 'Korean' });
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe(text);
  });
  test('the source list is cut from any-level «출처» / «Sources» / «References» heading', () => {
    expect(speechText('코스피 하락.\n### Sources\n- Reuters — Stocks fall')).toBe('코스피 하락.');
    expect(speechText('코스피 하락.\n# References:\n1. Bloomberg')).toBe('코스피 하락.');
    expect(speechText('코스피 하락.\n**출처**\n1. Bloomberg')).toBe('코스피 하락.');
    expect(speechText('## 출처와 방법론 개요\n코스피 하락.')).toBe('출처와 방법론 개요. 코스피 하락.');
  });
  test('a genuinely English brief with URLs is still skipped for a Korean goal', async () => {
    let called = 0;
    const r = await runVoice('# Market brief\n- KOSPI fell on foreign selling (https://x.example/a).\n- The won weakened.\n\n## Sources\n1. Reuters', join(tmp(), 'brief.mp3'), async () => { called++; return new Uint8Array([1]); }, undefined, { language: 'Korean' });
    expect(r).toMatchObject({ ok: false, why: 'brief is not in Korean' });
    expect(called).toBe(0);
  });
  test('Korean brief → spoken, source notes dropped from speech', async () => {
    const seen: string[] = [];
    const r = await runVoice('**코스피는 하락했습니다.** *(출처: KS11 실시간 시세)*\n- 환율은 올랐습니다.', join(tmp(), 'brief.mp3'), async (t) => { seen.push(t); return new Uint8Array([1]); }, undefined, { language: 'Korean' });
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe('코스피는 하락했습니다. 환율은 올랐습니다.');
  });
});
