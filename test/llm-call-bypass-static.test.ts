import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
// All known LLM request entry points; no opt-out for these paths. The gateway
// alone owns the raw fetch, and even there only the fetch transport may call it.
const knownSenders = [
  'src/llm.ts',
  'src/session-runtime/retry-api.ts',
  'src/llm/bedrock-provider.ts',
  'src/llm/hq-proxy-provider.ts',
  'src/model-tier/preset-suggest-llm.ts',
  'src/showroom/role-judge/local-judge.ts',
  'src/background-reasoning/patcher-llm-resolver.ts',
  'src/domains/knowledge.ts',
  'src/llm/local-manager/benchmark/runner.ts',
  'src/nexus/apps/app-actions.ts',
  'src/voice/stt-providers/openai-whisper.ts',
  'src/voice/vision-providers/gemini-vision.ts',
  'src/grok/agent-search.ts',
  'skills/omni-crawl/src/grok-search.ts',
  'skills/omni-digest/src/diagram.ts',
  'skills/omni-digest/src/summarize.ts',
  // visual.ts also downloads X media; its Grok generation must use the gateway.
  'skills/youtube-master/src/summarize.ts',
] as const;

/** Also catches bare `return fetch(...)`, `const p = fetch(...)` and globalThis.fetch. */
function directFetches(source: string): string[] {
  const code = source.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
    return line.split(/\s\/\//, 1)[0]!;
  }).join('\n');
  // Include multiline calls (`fetch\n(url)`), returned calls and callbacks.
  return [...code.matchAll(/\b(?:globalThis\s*\.\s*)?fetch\s*\(/g)]
    .map(match => String(code.slice(0, match.index).split('\n').length));
}

describe('LLM fetch boundary static audit', () => {
  test('scanner detects bare and global fetch irrespective of await, without matching comments', () => {
    expect(directFetches('// fetch("ignored")\nconst p = fetch(url);\nreturn globalThis.fetch(url);\nfetch\n(url);')).toEqual(['2', '3', '4']);
  });
  test('no known LLM sender directly invokes fetch', () => {
    for (const path of knownSenders) {
      expect(directFetches(readFileSync(resolve(root, path), 'utf8'))).toEqual([]);
    }
  });
  test('skills with non-generation downloads/uploads retain only those direct fetches', () => {
    const visual = readFileSync(resolve(root, 'skills/omni-digest/src/visual.ts'), 'utf8');
    expect(directFetches(visual)).toHaveLength(1); // X media download; Grok vision uses gateway
    expect(visual).toMatch(/llmNetworkFetch\('https:\/\/api\.x\.ai\/v1\/responses'/);
    const stt = readFileSync(resolve(root, 'skills/youtube-master/src/stt.ts'), 'utf8');
    expect(directFetches(stt)).toHaveLength(3); // Gemini file start/upload/delete, not inference
    expect(stt).toMatch(/llmNetworkFetch\([\s\S]*?:generateContent\?key=/);
    expect(stt).toMatch(/return llmNetworkFetch\(url, \{ method: 'POST'/);
  });
  test('domain LLM generation cannot bypass the gateway; model discovery remains a non-generation fetch', () => {
    const buzz = readFileSync(resolve(root, 'src/domains/community-buzz/local-llm.ts'), 'utf8');
    const dedup = readFileSync(resolve(root, 'src/domains/signal-dedup.ts'), 'utf8');
    expect(directFetches(buzz)).toHaveLength(2); // model resolution + availability probe
    expect(directFetches(dedup)).toHaveLength(1); // model resolution on fallback
    expect(buzz).toContain('llmNetworkFetch(`${base}/v1/chat/completions`');
    expect(dedup).toContain("llmNetworkFetch('https://api.x.ai/v1/chat/completions'");
    expect(dedup).toContain('llmNetworkFetch(`${base}/chat/completions`');
  });
  test('local compatibility generation and injected Gemini vision are observed, model discovery is not', () => {
    const local = readFileSync(resolve(root, 'src/local-llm-test.ts'), 'utf8');
    const vision = readFileSync(resolve(root, 'src/voice/vision-providers/gemini-vision.ts'), 'utf8');
    expect(directFetches(local)).toHaveLength(1); // GET /models only
    expect(local).toMatch(/init\.method !== 'POST'\) return await fetch\(url, request\)/);
    expect(local).toContain('return await llmNetworkFetch(url, request,');
    expect(vision).toContain('() => fetchFn(url, init)');
    expect(vision).toContain('response = await llmNetworkSend(url, init,');
  });
  test('gateway raw-fetch allowlist is only its own fetch transport, not injected send or SDK', () => {
    const gateway = readFileSync(resolve(root, 'src/session-runtime/llm-call-gateway.ts'), 'utf8');
    expect(directFetches(gateway)).toHaveLength(1);
    expect(gateway).toMatch(/llmNetworkSend\(url, init, fields, \(\) => fetch\(url, init\)\)/);
    expect(gateway).toMatch(/export function llmObserveSend<T>[\s\S]*?return send\(\);/);
    const llm = readFileSync(resolve(root, 'src/llm.ts'), 'utf8');
    expect(llm).toMatch(/llmObserveSend\('https:\/\/generativelanguage\.googleapis\.com'[\s\S]*?\(\) => client\.models\.generateContentStream\(/);
  });
});
