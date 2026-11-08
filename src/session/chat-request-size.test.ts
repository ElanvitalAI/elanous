import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, type LLMProvider } from '../llm.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import { appendMessage, createSession, loadSession } from './index.js';
import { runTurn } from './chat.js';
import { saveTokens } from '../oauth/store.js';
import { createRequestSizeGuard } from './request-size-guard.js';
import { dispatchRead } from '../code-edit/tools.js';
import { acquireFakeFetchDevice, type FakeFetchDevice } from '../ux-sim/fake-fetch.js';

type FetchCapture = { body: Record<string, unknown>; wireJson: string };

let root = '';
let fetchDevice: FakeFetchDevice | undefined;
let captures: FetchCapture[] = [];
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_SESSION_ROOT', 'ELANOUS_TEST_FAKE_LLM'] as const;
let savedEnv: Partial<Record<typeof envKeys[number], string>> = {};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tui-request-size-compact-'));
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  captures = [];
  resetAutoCompactStateForTest();
  saveTokens('openai-codex', {
    accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: null,
  }, { mirrorCodex: false, codexHome: process.env.CODEX_HOME });
  fetchDevice = await acquireFakeFetchDevice([{
    url: '/backend-api/codex/responses', method: 'POST',
    response: (request) => {
    const wireJson = request.body ?? '';
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(wireJson) as Record<string, unknown>; } catch { /* non-JSON fetches are still captured */ }
    captures.push({ body, wireJson });
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"compact summary"}',
      '',
      'data: {"choices":[{"delta":{"content":"compact summary"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  }]);
});

afterEach(() => {
  const device = fetchDevice;
  fetchDevice = undefined;
  try {
    expect(device?.calls().every(call => call.routeId === 'route-1' && call.status === 200)).toBe(true);
  } finally {
    try { device?.restore(); }
    finally {
      resetAutoCompactStateForTest();
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe.serial('Codex TUI request-size compact', () => {
  test('preserves active instructions and user input while reducing tool output', async () => {
    const system = 'follow these instructions';
    const user = 'perform the current request';
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'preserve', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'preserve', content: 'x'.repeat(410_000) }] },
    ];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveDir: root }) });
    for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) {}
    expect(captures[0]!.body.instructions).toContain(system);
    expect(captures[0]!.wireJson).toContain(user);
    expect(captures[0]!.wireJson.length).toBeLessThanOrEqual(400_000);
  });

  test('preserves the active request before a text-bearing tool result on the real Codex wire', async () => {
    const currentRequest = 'the active request that must stay intact';
    const toolText = 'large tool result '.repeat(30_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'an older user request from the prior turn' },
      { role: 'assistant', content: 'the prior turn is complete' },
      { role: 'user', content: currentRequest },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'mixed-after-request', name: 'Read', input: {} }] },
      { role: 'user', content: [
        { type: 'text', text: toolText },
        { type: 'tool_result', tool_use_id: 'mixed-after-request', content: 'small tool result' },
      ] },
    ];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'active-request', archiveDir: root }) });
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ }

    const wire = captures[0]!.wireJson;
    expect(wire).toContain(currentRequest);
    expect(wire).toContain('small tool result');
    expect(wire.length).toBeLessThanOrEqual(400_000);
    const archivePath = wire.match(/saved to: ([^\]]+)\]/)![1]!;
    const archived = await dispatchRead({ file_path: archivePath });
    const record = JSON.parse(archived.output.split('\n').find(line => line.startsWith('{'))!);
    expect(record.content).toBe(toolText);
    expect(messages[2]!.content).toBe(currentRequest);
  });

  test('fails closed for an oversized current user input even with archive enabled', async () => {
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'an older user request from an earlier turn' },
      { role: 'assistant', content: 'the earlier turn is complete' },
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(410_000) }, { type: 'tool_result', tool_use_id: 'tiny', content: 'ok' }] },
    ];
    const before = structuredClone(messages);
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveDir: root }) });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) {} };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages).toEqual(before);
    expect(captures).toHaveLength(0);
  });

  test('recognizes a mixed current request after a completed assistant string turn', async () => {
    const currentText = 'current request content '.repeat(30_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'prior request' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'prior-tool', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prior-tool', content: 'prior result' }] },
      { role: 'assistant', content: 'the prior turn has completed' },
      { role: 'user', content: [
        { type: 'text', text: currentText },
        { type: 'tool_result', tool_use_id: 'prior-tool', content: 'referenced prior result' },
      ] },
    ];
    const before = structuredClone(messages);
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveDir: root }) });
    const send = async () => { for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ } };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages).toEqual(before);
    expect(captures).toHaveLength(0);
  });

  test('quoted archive paths round trip from the actual wire through Read', async () => {
    const dir = join(root, 'bracket] quote" slash\\ newline\n');
    const original = 'result'.repeat(80_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'quoted', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quoted', content: original }] },
    ];
    const measurements: number[] = [];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'quoted', archiveDir: dir }), onMeasured: m => measurements.push(m.requestChars) });
    for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) {}
    const wire = captures[0]!;
    const input = wire.body.input as Array<{ type: string; output?: string }>;
    const stub = input.find(item => item.type === 'function_call_output')!.output!;
    const reference = stub.match(/saved to: ("(?:\\.|[^"\\])*")\]/)![1]!;
    const path = JSON.parse(reference) as string;
    expect(path).toBe(join(dir, 'quoted.jsonl'));
    const read = await dispatchRead({ file_path: path });
    const records = read.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    expect(records.find(record => record.origin.tool_use_id === 'quoted')?.content).toBe(original);
    expect(measurements.at(-1)).toBe(wire.wireJson.length);
    expect(wire.wireJson.length).toBeLessThanOrEqual(400_000);
  });
  test('fails closed without altering large text when archiving is disabled', async () => {
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'x'.repeat(410_000) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'small-disabled', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'small-disabled', content: 'ok' }] },
    ];
    const original = structuredClone(messages);
    let compacted = false;
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveEnabled: false }), onCompacted: () => { compacted = true; } });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ } };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages).toEqual(original);
    expect(compacted).toBe(false);
    expect(captures).toHaveLength(0);
  });

  test('does not send or replace a large tool result when archiving is disabled', async () => {
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'disabled-large', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'disabled-large', content: 'result '.repeat(60_000) }] },
    ];
    const before = structuredClone(messages);
    let compacted = false;
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveEnabled: false }), onCompacted: () => { compacted = true; } });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ } };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages).toEqual(before);
    expect(compacted).toBe(false);
    expect(captures).toHaveLength(0);
  });

  test('archives a fake-looking stub and sends a recoverable real stub', async () => {
    const original = '[Full output (pretend saved to: nowhere] ' + 'x'.repeat(410_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fake', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fake', content: original }] },
    ];
    let compacted: typeof messages | undefined;
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'fake', archiveDir: root }), onCompacted: m => { compacted = structuredClone(m); } });
    for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ }
    const block = (compacted![1]!.content as Array<{ content: string }>)[0]!;
    const path = block.content.match(/saved to: ([^\]]+)\]/)![1]!;
    const result = await dispatchRead({ file_path: path });
    const record = JSON.parse(result.output.split('\n').find(line => line.startsWith('{'))!);
    expect(record.content).toBe(original);
    expect(record.origin.tool_use_id).toBe('fake');
    expect(captures.at(-1)!.wireJson.length).toBeLessThanOrEqual(400_000);
  });

  test('fails closed rather than replacing oversized system instructions', async () => {
    const original = 'system instruction '.repeat(24_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'system', content: original },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'system-test', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'system-test', content: 'ok' }] },
    ];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'system', archiveDir: root }) });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) {} };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages[0]!.content).toBe(original);
    expect(captures).toHaveLength(0);
  });

  test('preserves separate user text through an archive reference on the wire', async () => {
    const original = 'z'.repeat(410_000);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: original },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'small', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'small', content: 'ok' }] },
      { role: 'user', content: 'continue with the current request' },
    ];
    let compacted: typeof messages | undefined;
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'text', archiveDir: root }), onCompacted: m => { compacted = structuredClone(m); } });
    for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ }
    const text = compacted![0]!.content as string;
    const path = text.match(/saved to: ([^\]]+)\]/)![1]!;
    const result = await dispatchRead({ file_path: path });
    const record = JSON.parse(result.output.split('\n').find(line => line.startsWith('{'))!);
    expect(record.content).toBe(original);
    expect(compacted![2]).toEqual(messages[2]);
    expect(captures.at(-1)!.wireJson.length).toBeLessThanOrEqual(400_000);
  });
  test('compacts separate long text without losing a tool result on the real Codex wire', async () => {
    const measurements: number[] = [];
    const guard = createRequestSizeGuard({
      compactOptions: () => ({ archiveEnabled: true, archiveDir: root, preserveLastN: 0 }),
      onMeasured: info => measurements.push(info.requestChars),
    });
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'x'.repeat(410_000) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_separate', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_separate', content: 'small result' }] },
      { role: 'user', content: 'continue with the current request' },
    ];
    const original = structuredClone(messages);
    const compact = guard.compactMessages;
    guard.compactMessages = async (current, info) => {
      const before = structuredClone(current);
      const result = await compact(current, info);
      expect(current).toEqual(before);
      return result;
    };
    let compacted: typeof messages | undefined;
    guard.onCompacted = current => { compacted = structuredClone(current); };
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ }
    expect(compacted?.[2]).toEqual(original[2]);
    expect(captures).toHaveLength(1);
    const wire = captures[0]!.wireJson;
    expect(wire).toContain('small result');
    expect(wire).toContain('call_separate');
    expect(wire.length).toBeLessThanOrEqual(400_000);
    expect(measurements.at(-1)).toBe(wire.length);
  });
  test('compacts long text alongside a preserved tool result on the real Codex wire', async () => {
    const measurements: number[] = [];
    const guard = createRequestSizeGuard({
      compactOptions: () => ({ archiveEnabled: true, archiveDir: root, preserveLastN: 0 }),
      onMeasured: info => measurements.push(info.requestChars),
    });
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_mixed', name: 'Read', input: {} }] },
      { role: 'user', content: [
        { type: 'text', text: 'x'.repeat(410_000) },
        { type: 'tool_result', tool_use_id: 'call_mixed', content: 'small result' },
      ] },
      { role: 'user', content: 'continue with the current request' },
    ];
    const original = structuredClone(messages);
    const compact = guard.compactMessages;
    guard.compactMessages = async (current, info) => {
      const before = structuredClone(current);
      const result = await compact(current, info);
      expect(current).toEqual(before);
      return result;
    };
    let compacted: typeof messages | undefined;
    guard.onCompacted = current => { compacted = structuredClone(current); };
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ }
    expect(original[1]!.content).toEqual([
      { type: 'text', text: 'x'.repeat(410_000) },
      { type: 'tool_result', tool_use_id: 'call_mixed', content: 'small result' },
    ]);
    expect(compacted?.[1]?.content).toMatchObject([
      { type: 'text' },
      { type: 'tool_result', tool_use_id: 'call_mixed', content: 'small result' },
    ]);
    const mixedText = (compacted![1]!.content as Array<{ text?: string }>)[0]!.text!;
    const archive = mixedText.match(/saved to: ([^\]]+)\]/)![1]!;
    const archivedText = await dispatchRead({ file_path: archive });
    expect(JSON.parse(archivedText.output.split('\n').find(line => line.startsWith('{'))!).content).toBe('x'.repeat(410_000));
    const wire = captures.at(-1)!.wireJson;
    expect(wire).toContain('small result');
    expect(wire).toContain('call_mixed');
    expect(wire.length).toBeLessThanOrEqual(400_000);
    expect(measurements.at(-1)).toBe(wire.length);
  });
  test('repeatedly reduces oldest viable results using the serialized Codex body', async () => {
    let seed = 0x12345678;
    const alphabet = ['"', '\\', '\n', '\t', '\u0001', '한', 'é', 'x'];
    const randomText = () => Array.from({ length: 12_000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return alphabet[seed >>> 29]!;
    }).join('');
    const results = ['tiny', ...Array.from({ length: 36 }, (_, i) => `result-${i}:` + randomText())];
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'system', content: 'wire instructions' },
      { role: 'assistant', content: results.map((_, i) => ({ type: 'tool_use' as const, id: `call_${i}`, name: 'Read', input: { i } })) },
      { role: 'user', content: results.map((content, i) => ({ type: 'tool_result' as const, tool_use_id: `call_${i}`, content })) },
    ];
    const measurements: number[] = [];
    let serialized = '';
    let measuredWire = '';
    const stringify = JSON.stringify.bind(JSON);
    const spy = spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      const result = (stringify as (...args: unknown[]) => string)(value, ...args);
      if (value && typeof value === 'object' && 'stream' in value && 'input' in value && 'instructions' in value) {
        serialized = result;
      }
      return result;
    }) as typeof JSON.stringify);
    const archiveDir = join(root, ...Array.from({ length: 5 }, () => 'long-directory-'.repeat(12)));
    const guard = createRequestSizeGuard({
      compactOptions: () => ({ sessionId: 'wire-many', archiveEnabled: true, archiveDir, preserveLastN: 100 }),
      onMeasured: info => { measurements.push(info.requestChars); measuredWire = serialized; },
    });
    try {
      for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
        model: 'gpt-5.6-terra', requestSizeGuard: guard,
        reasoningEffort: 'high',
        tools: [{ name: 'Read', description: 'read tool schema', parameters: { type: 'object', properties: {} } }],
      })) { /* consume stream */ }
    } finally {
      spy.mockRestore();
    }
    const wire = captures.at(-1)!.wireJson;
    expect(Buffer.from(measuredWire)).toEqual(Buffer.from(wire));
    expect(wire.length).toBeLessThanOrEqual(400_000);
    expect(measurements.at(-1)).toBe(wire.length);
    expect(captures.at(-1)!.body.instructions).toContain('wire instructions');
    expect(JSON.stringify(captures.at(-1)!.body.tools)).toContain('read tool schema');
    expect(captures.at(-1)!.body.reasoning).toMatchObject({ effort: 'high' });
    expect(wire).toContain('tiny');
    const input = captures.at(-1)!.body.input as Array<{ type: string; call_id?: string; output?: string }>;
    const stub = input.find(item => item.type === 'function_call_output' && typeof item.output === 'string' && item.output.includes('saved to:'))!;
    expect(stub.call_id).toBe('call_1');
    const path = stub.output!.match(/saved to: ([^\]]+)\]/)?.[1];
    expect(path).toBe(join(archiveDir, 'wire-many.jsonl'));
    const read = await dispatchRead({ file_path: path });
    const records = read.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    expect(records.find(record => record.origin.tool_use_id === stub.call_id)?.content).toBe(results[1]);
  });

  test('skips a candidate that grows after JSON escaping and continues with the next result', async () => {
    const archiveDir = join(root, '"'.repeat(100));
    const path = join(archiveDir, 'escape.jsonl');
    const id = 'first';
    const stubLength = `[Full output (999 chars) saved to: ${path}] [tool_use_id: ${id}]`.length;
    const short = 'x'.repeat(stubLength + 1);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id, name: 'Read', input: {} },
        { type: 'tool_use', id: 'second', name: 'Read', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: id, content: short },
        { type: 'tool_result', tool_use_id: 'second', content: 'y'.repeat(20_000) },
      ] },
    ];
    let accepted: typeof messages | undefined;
    const guard = createRequestSizeGuard({
      maxChars: 2_000,
      compactOptions: () => ({ sessionId: 'escape', archiveDir }),
      onCompacted: current => { accepted = structuredClone(current); },
    });
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ }
    const blocks = accepted![1]!.content as Array<{ content: string }>;
    expect(blocks[0]!.content).toBe(short);
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.origin.tool_use_id)).toEqual(['first', 'second']);
    expect(blocks[1]!.content).toContain('saved to:');
    expect(captures.at(-1)!.wireJson.length).toBeLessThanOrEqual(2_000);
  });

  test('accepts a raw-longer archive stub when it makes the escaped wire body smaller', async () => {
    const archiveDir = join(root, 'escape-heavy');
    const original = '\u0001'.repeat(100);
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'escape-short', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'escape-short', content: original }] },
    ];
    const guard = createRequestSizeGuard({
      maxChars: 700,
      compactOptions: () => ({ sessionId: 'escape-heavy', archiveDir }),
    });
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* consume stream */ }
    const block = (messages[1]!.content as Array<{ content: string }>)[0]!;
    expect(block.content.length).toBeGreaterThan(original.length);
    expect(block.content).toContain('saved to:');
    expect(captures.at(-1)!.wireJson.length).toBeLessThanOrEqual(700);
  });

  test('does not commit a candidate that grows the serialized wire body', async () => {
    let committed = false;
    const guard: NonNullable<import('../llm.js').LLMOpts['requestSizeGuard']> = {
      maxChars: 200,
      compactMessages: async () => ({
        messages: [{ role: 'user', content: 'larger'.repeat(1_000) }],
        reason: 'growing-candidate',
        commit: () => { committed = true; },
      }),
    };
    const messages: import('../llm.js').LLMMessage[] = [{ role: 'user', content: 'original'.repeat(100) }];
    const before = structuredClone(messages);
    const drain = async () => {
      for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
        model: 'gpt-5.6-terra', requestSizeGuard: guard,
      })) { /* consume stream */ }
    };
    await expect(drain()).rejects.toThrow('compaction-no-reduction');
    expect(committed).toBe(false);
    expect(messages).toEqual(before);
    expect(captures).toHaveLength(0);
  });

  test('does not send over-cap results when archive is disabled', async () => {
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_disabled', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_disabled', content: 'x'.repeat(410_000) }] },
    ];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveEnabled: false }) });
    const drain = async () => {
      for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
        model: 'gpt-5.6-terra', requestSizeGuard: guard,
      })) { /* consume stream */ }
    };
    await expect(drain()).rejects.toThrow('Codex request remains over the 400000-character limit');
    expect(captures).toHaveLength(0);
  });

  test('over-cap first request compacts the persisted session and sends current text plus image once', async () => {
    const model = 'gpt-5.6-terra';
    const codex = PROVIDERS['openai-codex']!;
    let sessionId = '';
    let historyUnchangedDuringCandidate = false;
    const provider: LLMProvider = {
      ...codex,
      // Test-only cap injection at the provider boundary. Keep the production
      // compactMessages closure from runTurn and the real Codex fetch path.
      streamChat(messages, opts = {}) {
        const guard = opts.requestSizeGuard;
        if (!guard) throw new Error('runTurn did not attach the Codex request-size guard');
        guard.maxChars = 2_000;
        const compact = guard.compactMessages;
        guard.compactMessages = async (current, info) => {
          const before = JSON.stringify(loadSession(sessionId)?.messages);
          const candidate = await compact(current, info);
          historyUnchangedDuringCandidate = before === JSON.stringify(loadSession(sessionId)?.messages);
          return candidate;
        };
        return codex.streamChat!(messages, opts);
      },
    };
    const session = createSession({ provider: provider.name, model, source: 'tui' });
    sessionId = session.id;
    for (let i = 0; i < 8; i++) {
      appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `older-${i} ${'history '.repeat(70)}`,
        ts: new Date().toISOString(),
      });
    }

    const latestText = 'latest request text after compaction';
    const imageBase64 = 'aW1hZ2UtYnl0ZXM=';
    const statusLines: string[] = [];
    const userConfig = {
      llm: { provider: 'openai-codex', model, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
      chat: {
        autoCompact: {
          enabled: true, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0,
          partial: true, workingBudgetTokens: 128_000,
        },
        compact: { archiveEnabled: false },
      },
    } as never;

    await runTurn({
      userConfig,
      sessionId: session.id,
      userText: latestText,
      userImages: [{ type: 'image', mediaType: 'image/png', base64: imageBase64 }],
      systemPrompt: 'request-size test system prompt',
      skipMemoryInjection: true,
      provider,
      onStatusLine: line => statusLines.push(line),
    });

    expect(historyUnchangedDuringCandidate).toBe(true);
    const request = [...captures].reverse().find((capture: FetchCapture) => Array.isArray(capture.body.input)
      && JSON.stringify(capture.body.input).includes(imageBase64));
    expect(request).toBeDefined();
    const wire = request!.wireJson;
    expect(wire.split(latestText)).toHaveLength(2);
    expect(wire.split(imageBase64)).toHaveLength(2);
    expect(wire.length).toBeLessThanOrEqual(2_000);
    const measuredLine = statusLines.find(line => line.includes('/ 2,000 · compact'));
    expect(measuredLine).toBeDefined();
    const measuredChars = Number(measuredLine!.match(/^ctx ([\d,]+)/)?.[1]?.replaceAll(',', ''));
    expect(measuredChars).toBe(request!.wireJson.length);
    expect(measuredChars).toBeLessThanOrEqual(2_000);
  });

  test('blocks a reduced Codex wire body that still exceeds the cap', async () => {
    const model = 'gpt-5.6-terra';
    const codex = PROVIDERS['openai-codex']!;
    const provider: LLMProvider = {
      ...codex,
      streamChat(messages, opts = {}) {
        const guard = opts.requestSizeGuard;
        if (!guard) throw new Error('runTurn did not attach the Codex request-size guard');
        guard.maxChars = 100;
        guard.compactMessages = async () => ({
          messages: [{ role: 'user', content: 'reduced but still over cap '.repeat(12) }],
          reason: 'test-still-over-cap',
        });
        return codex.streamChat!(messages, opts);
      },
    };
    const session = createSession({ provider: provider.name, model, source: 'tui' });
    const userConfig = {
      llm: { provider: 'openai-codex', model, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
      chat: {
        autoCompact: {
          enabled: true, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0,
          partial: true, workingBudgetTokens: 128_000,
        },
        compact: { archiveEnabled: false },
      },
    } as never;
    const log = spyOn(debug, 'log');

    try {
      await expect(runTurn({
        userConfig,
        sessionId: session.id,
        userText: 'x'.repeat(2_000),
        systemPrompt: 'request-size still-over-cap test',
        skipMemoryInjection: true,
        provider,
      })).rejects.toThrow('Codex request remains over the 100-character limit');
      expect(captures).toHaveLength(0);
      const blocked = log.mock.calls.find(call => call[0] === 'llm.request' && call[1] === 'request-size-limit-blocked');
      expect(blocked?.[2]).toMatchObject({ compacted: true, reason: 'compaction-still-over-cap:test-still-over-cap' });
    } finally {
      log.mockRestore();
    }
  });

  test('does not send a Codex request when compaction cannot bring the wire body under the cap', async () => {
    const model = 'gpt-5.6-terra';
    const codex = PROVIDERS['openai-codex']!;
    const provider: LLMProvider = {
      ...codex,
      streamChat(messages, opts = {}) {
        const guard = opts.requestSizeGuard;
        if (!guard) throw new Error('runTurn did not attach the Codex request-size guard');
        guard.maxChars = 100;
        guard.compactMessages = async () => null;
        return codex.streamChat!(messages, opts);
      },
    };
    const session = createSession({ provider: provider.name, model, source: 'tui' });
    const userConfig = {
      llm: { provider: 'openai-codex', model, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
      chat: {
        autoCompact: {
          enabled: true, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0,
          partial: true, workingBudgetTokens: 128_000,
        },
        compact: { archiveEnabled: false },
      },
    } as never;

    await expect(runTurn({
      userConfig,
      sessionId: session.id,
      userText: 'x'.repeat(2_000),
      systemPrompt: 'request-size hard-cap test',
      skipMemoryInjection: true,
      provider,
    })).rejects.toThrow('Codex request remains over the 100-character limit');
    expect(captures).toHaveLength(0);
  });
});
