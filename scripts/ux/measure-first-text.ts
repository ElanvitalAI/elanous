// Usage: bun scripts/ux/measure-first-text.ts --questions questions.json [--url http://127.0.0.1:3456] [--token-stdin] [--json]
// questions.json is a nonempty JSON array of nonempty question strings. Each question starts a fresh session.
import { readFileSync } from 'node:fs';

export interface FirstTextMeasurement {
  question: string;
  firstTextMs: number;
  delta: string;
}

/** Stop the clock on the first complete, nonempty text-delta SSE event, not on response headers or turn-begin. */
export async function measureFirstText(
  question: string,
  url: string,
  options: { token?: string; fetch?: typeof fetch; now?: () => number } = {},
): Promise<FirstTextMeasurement> {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  const started = now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchFn(new URL('/v1/prompt/stream', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ userText: question }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('SSE response has no body');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE separators can straddle arbitrary UTF-8 chunks (including CRLF boundaries).
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = /^event:\s*(.*)$/m.exec(frame)?.[1]?.trim();
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (event === 'text-delta') {
          const payload: unknown = JSON.parse(data);
          const delta = payload && typeof payload === 'object' && 'delta' in payload ? payload.delta : undefined;
          if (typeof delta === 'string' && delta.length > 0) {
            return { question, firstTextMs: now() - started, delta };
          }
        }
        if (event === 'error') throw new Error(`SSE error: ${data}`);
        if (event === 'turn-end') throw new Error('Turn ended without a text-delta');
      }
    }
    throw new Error('SSE stream ended without a text-delta');
  } finally {
    // Do not leave the daemon generating the rest of a turn after the measurement.
    if (reader) await reader.cancel().catch(() => {});
    controller.abort();
  }
}

export async function run(argv: string[], deps: { fetch?: typeof fetch; now?: () => number; stdin?: () => Promise<string> } = {}): Promise<FirstTextMeasurement[]> {
  let url = 'http://127.0.0.1:3456';
  let questionsPath: string | undefined;
  let json = false;
  let tokenStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--token-stdin') tokenStdin = true;
    else if (arg === '--url' || arg === '--questions') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--url') url = value;
      else questionsPath = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!questionsPath) throw new Error('Usage: --questions <JSON file> [--url <base URL>] [--token-stdin] [--json]');
  const questions: unknown = JSON.parse(readFileSync(questionsPath, 'utf8'));
  if (!Array.isArray(questions) || !questions.length || !questions.every((q) => typeof q === 'string' && q.trim().length > 0)) {
    throw new Error('--questions must be a nonempty JSON array of nonempty strings');
  }
  const token = tokenStdin ? (await (deps.stdin ?? (() => Bun.stdin.text()))()).trim() : undefined;
  const results: FirstTextMeasurement[] = [];
  for (const question of questions as string[]) {
    results.push(await measureFirstText(question, url, { token, fetch: deps.fetch, now: deps.now }));
  }
  if (json) console.log(JSON.stringify(results));
  else for (const result of results) console.log(`${result.firstTextMs.toFixed(1)} ms\t${result.question}`);
  return results;
}

if (import.meta.main) {
  try { await run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
