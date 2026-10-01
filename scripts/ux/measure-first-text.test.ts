import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureFirstText, run } from './measure-first-text.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function questionFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'first-text-'));
  tempDirs.push(dir);
  const path = join(dir, 'questions.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('measures first nonempty text-delta, not headers, turn-begin, feedback or empty delta, across split SSE chunks', async () => {
  let elapsed = 0;
  let request: Request | undefined;
  const encoder = new TextEncoder();
  const chunks = [
    'event: turn-begin\r\ndata: {"sessionId":"s"}\r\n\r\nevent: feedback\r\ndata: {}\r\n\r\n',
    'event: text-delta\r\ndata: {"delta":"","full":""}\r\n\r\nevent: text-del',
    'ta\r\ndata: {"delta":"안녕","full":"안녕"}\r\n',
    '\r\n',
  ];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    elapsed = 12;
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) { controller.close(); return; }
        elapsed = [35, 54, 79, 84][index]!;
        controller.enqueue(encoder.encode(chunks[index++]!));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const result = await measureFirstText('질문?', 'http://localhost:3456/base', { fetch: fetchFake, now: () => elapsed });
  expect(result).toEqual({ question: '질문?', firstTextMs: 84, delta: '안녕' });
  expect(request?.url).toBe('http://localhost:3456/v1/prompt/stream');
  expect(request?.method).toBe('POST');
  expect(await request?.json()).toEqual({ userText: '질문?' });
});

test('question list and --json produce per-question measurements with bearer auth', async () => {
  const path = questionFile(['one?', 'two?']);
  const requests: string[] = [];
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
  try {
    const results = await run(['--questions', path, '--url', 'http://localhost:9000', '--token-stdin', '--json'], {
      stdin: async () => 'secret\n',
      now: () => 10,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.headers.get('authorization')).toBe('Bearer secret');
        expect(request.url).toBe('http://localhost:9000/v1/prompt/stream');
        requests.push((await request.json() as { userText: string }).userText);
        return new Response('event: text-delta\ndata: {"delta":"ok"}\n\n');
      }) as typeof fetch,
    });
    expect(requests).toEqual(['one?', 'two?']);
    expect(results).toEqual([
      { question: 'one?', firstTextMs: 0, delta: 'ok' },
      { question: 'two?', firstTextMs: 0, delta: 'ok' },
    ]);
    expect(JSON.parse(output[0]!)).toEqual(results);
    expect(output).toHaveLength(1);
  } finally { console.log = original; }
});

test('rejects invalid lists and fails rather than reporting time for error, HTTP failure or missing text', async () => {
  const invalid = questionFile(['ok', '']);
  await expect(run(['--questions', invalid])).rejects.toThrow('nonempty JSON array');
  await expect(measureFirstText('q', 'http://localhost', {
    fetch: (async (_input: RequestInfo | URL) => new Response('unauthorized', { status: 401 })) as typeof fetch,
  })).rejects.toThrow('HTTP 401');
  await expect(measureFirstText('q', 'http://localhost', {
    fetch: (async (_input: RequestInfo | URL) => new Response('event: error\ndata: {"error":"turn_failed"}\n\n')) as typeof fetch,
  })).rejects.toThrow('SSE error');
  await expect(measureFirstText('q', 'http://localhost', {
    fetch: (async (_input: RequestInfo | URL) => new Response('event: turn-end\ndata: {}\n\n')) as typeof fetch,
  })).rejects.toThrow('without a text-delta');
});
