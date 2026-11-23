import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/** Hosts and paths that mean «this file talks to a model». A file naming one and also calling fetch directly must be listed below with the reason. */
const LLM_ENDPOINT = /api\.openai\.com|api\.anthropic\.com|api\.x\.ai|generativelanguage\.googleapis|openrouter\.ai|chatgpt\.com\/backend-api|bedrock-runtime|api\.groq|api\.mistral|api\.z\.ai|open\.bigmodel|cli-chat-proxy\.grok|api\.elevenlabs|\/chat\/completions|\/v1\/messages|\/v1\/responses|\/v1\/audio\/(?:speech|transcriptions)/;
type ExemptKind = 'telegram-send' | 'model-listing' | 'file-download' | 'gemini-file-api';
interface ExemptCall { readonly kind: ExemptKind; readonly arg: string }
/** Only these kinds may carry a POST; everything else exempt is a plain read. */
const POST_KINDS: readonly ExemptKind[] = ['telegram-send', 'gemini-file-api'];
const telegram = '`https://api.telegram.org/bot${token}/sendMessage`';
const geminiFile = (arg: string): ExemptCall => ({ kind: 'gemini-file-api', arg });
const listing = (arg: string): ExemptCall => ({ kind: 'model-listing', arg });
/**
 * Exemption is per CALL, not per file: each direct fetch in a file that names a model endpoint must (1) be listed here with its exact
 * first-argument text, (2) carry the in-source marker `llm-ledger-exempt: <kind>` on its line or the two above, and (3) be a plain read unless
 * its kind is a POST kind. A new inference fetch in an exempt file is an unlisted call, so it fails.
 */
const exemptCalls: Readonly<Record<string, readonly ExemptCall[]>> = {
  'src/index.ts': [{ kind: 'telegram-send', arg: telegram }, listing('models'), listing('models'), { kind: 'file-download', arg: 'httpUrl' }],
  'src/local-llm-test.ts': [listing('url')],
  'src/nexus/api/llm-hosts.ts': [listing('url'), listing('url'), listing('url')],
  'src/domains/signal-dedup.ts': [listing('`${base}/models`')],
  'src/domains/community-buzz/local-llm.ts': [listing('`${base}/v1/models`'), listing('`${e}/v1/models`')],
  'skills/omni-digest/src/visual.ts': [{ kind: 'file-download', arg: 'url' }],
  'skills/youtube-master/src/stt.ts': [
    geminiFile('`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`'), geminiFile('uploadUrl'),
    geminiFile('`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`'),
  ],
};

interface FetchCall { readonly line: number; readonly arg: string; readonly text: string }
/** Every direct fetch call with its first-argument text and full call text. Skips comments and method definitions (`async fetch(): …`). */
function directFetchCalls(source: string): FetchCall[] {
  const code = source.split('\n').map(line => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') ? ''.padEnd(line.length) : line.split(/\s\/\//, 1)[0]!;
  }).join('\n');
  return [...code.matchAll(/(?<![.\w])(?:globalThis\s*\.\s*)?fetch\s*\(/g)].flatMap(match => {
    if (/\b(?:async|function)$/.test(code.slice(0, match.index).trimEnd())) return [];
    const start = match.index! + match[0].length;
    let depth = 1;
    let firstEnd = -1;
    let at = start;
    for (; at < code.length && depth > 0; at++) {
      const char = code[at]!;
      if (char === '(' || char === '{' || char === '[') depth++;
      else if (char === ')' || char === '}' || char === ']') depth--;
      else if (char === ',' && depth === 1 && firstEnd < 0) firstEnd = at;
    }
    return [{ line: code.slice(0, match.index).split('\n').length, arg: code.slice(start, firstEnd < 0 ? at - 1 : firstEnd).replace(/\s+/g, ' ').trim(), text: code.slice(start, at) }];
  });
}

/** What is wrong with the direct fetches of one file, given the calls it is allowed to keep. Empty = clean. */
function exemptionViolations(path: string, source: string, allowed: readonly ExemptCall[]): string[] {
  const lines = source.split('\n');
  const unused = [...allowed];
  const problems: string[] = [];
  for (const call of directFetchCalls(source)) {
    const index = unused.findIndex(entry => entry.arg === call.arg);
    if (index < 0) { problems.push(`${path}:${call.line} unlisted direct fetch (${call.arg})`); continue; }
    const [entry] = unused.splice(index, 1);
    const near = lines.slice(Math.max(0, call.line - 3), call.line).join('\n');
    if (!near.includes(`llm-ledger-exempt: ${entry!.kind}`)) problems.push(`${path}:${call.line} missing marker llm-ledger-exempt: ${entry!.kind}`);
    if (/method:\s*['"]POST/.test(call.text) && !POST_KINDS.includes(entry!.kind)) problems.push(`${path}:${call.line} POST in a ${entry!.kind} exemption`);
  }
  return [...problems, ...unused.map(entry => `${path} stale exemption (${entry.arg})`)];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [rel] : [];
  });
}

describe('LLM fetch boundary: whole-tree audit', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('skills')];
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const senders = files.filter(path => {
    const source = read(path);
    return LLM_ENDPOINT.test(source) && directFetchCalls(source).length > 0;
  });
  test('every direct fetch in a file that names a model endpoint is an exempt call (listed, marked, plain read) or the file is a gateway sender', () => {
    const problems = senders.filter(path => !(knownSenders as readonly string[]).includes(path))
      .flatMap(path => exemptionViolations(path, read(path), exemptCalls[path] ?? []));
    expect(problems).toEqual([]);
  });
  test('an inference fetch added to an exempt file fails, however the file is already exempt', () => {
    const [path] = Object.keys(exemptCalls);
    const original = read(path!);
    expect(exemptionViolations(path!, original, exemptCalls[path!]!)).toEqual([]);
    const added = `${original}\nasync function leak(url: string, key: string) {\n  return fetch(url, { method: 'POST', headers: { Authorization: key }, body: '{}' });\n}\n`;
    expect(exemptionViolations(path!, added, exemptCalls[path!]!).join('\n')).toContain('unlisted direct fetch (url)');
    const reused = `${original}\n// llm-ledger-exempt: model-listing\nasync function leak2() { return fetch(models, { method: 'POST', body: '{}' }); }\n`;
    expect(exemptionViolations(path!, reused, exemptCalls[path!]!).join('\n')).toContain('unlisted direct fetch (models)');
  });
  test('a listed call that loses its marker, or turns into a POST, fails', () => {
    const lines = read('src/local-llm-test.ts').split('\n');
    const stripped = lines.filter(line => !line.includes('llm-ledger-exempt')).join('\n');
    expect(exemptionViolations('src/local-llm-test.ts', stripped, exemptCalls['src/local-llm-test.ts']!).join('\n')).toContain('missing marker');
    const post = 'async function a() {\n  // llm-ledger-exempt: model-listing\n  return fetch(url, { method: \'POST\' });\n}\n';
    expect(exemptionViolations('x.ts', post, [listing('url')]).join('\n')).toContain('POST in a model-listing exemption');
  });
  test('the exemption table holds no stale file', () => {
    expect(Object.keys(exemptCalls).filter(path => !senders.includes(path))).toEqual([]);
  });
  test('every TTS sender sends through the gateway', () => {
    for (const path of ['src/voice/tts/tts-providers/openai-tts.ts', 'src/voice/tts/tts-providers/elevenlabs-tts.ts']) {
      const source = readFileSync(resolve(root, path), 'utf8');
      expect(directFetches(source)).toEqual([]);
      expect(source).toMatch(/requestedBy: '(?:voice-tts|explainer-vo)'/);
    }
  });
});
