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
import { installCodexOwnerTestWorld } from '../../test/fixtures/codex-owner-test-world.js';
import { createRequestSizeGuard } from './request-size-guard.js';
import { dispatchRead } from '../code-edit/tools.js';
import { acquireFakeFetchDevice, type FakeFetchDevice } from '../ux-sim/fake-fetch.js';

type FetchCapture = { body: Record<string, unknown>; wireJson: string };

let root = '';
let fetchDevice: FakeFetchDevice | undefined;
let captures: FetchCapture[] = [];
/** TURN-REQUEST-SIZE-LOSS sims — per-call SSE override (call index → SSE text); undefined = the default success stream. */
let sseFor: ((call: number) => string | undefined) | undefined;
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_SESSION_ROOT', 'ELANOUS_TEST_FAKE_LLM'] as const;
let savedEnv: Partial<Record<typeof envKeys[number], string>> = {};
let restoreCodexWorld: (() => void) | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tui-request-size-compact-'));
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  restoreCodexWorld = installCodexOwnerTestWorld(root);
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
    const sse = sseFor?.(captures.length - 1) ?? [
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
      sseFor = undefined;
      restoreCodexWorld?.();
      restoreCodexWorld = undefined;
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

  test('structured tool output above production cap is archived before actual Codex wire send', async () => {
    const original = [{ type: 'text' as const, text: 'synthetic-result '.repeat(40_000) }];
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'system', content: 'protected instruction' },
      { role: 'user', content: 'build the ticketing site' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'structured-wire', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'structured-wire', content: original }] },
    ];
    const archiveDir = join(root, 'structured-wire');
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'structured-wire', archiveDir }) });
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* actual provider serialization with fake fetch only */ }
    expect(captures).toHaveLength(1);
    expect(captures[0]!.wireJson.length).toBeLessThanOrEqual(guard.maxChars);
    expect(captures[0]!.wireJson).toContain('protected instruction');
    expect(captures[0]!.wireJson).toContain('build the ticketing site');
    expect(captures[0]!.wireJson).toContain('saved to:');
    const entry = JSON.parse(readFileSync(join(archiveDir, 'structured-wire.jsonl'), 'utf8').trim());
    expect(JSON.parse(entry.content)).toEqual(original);
  });

  test('compacts oldest results proactively at eighty-five percent without raising the hard cap', async () => {
    const messages: import('../llm.js').LLMMessage[] = [
      { role: 'user', content: 'protected active request' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'oldest', name: 'Read', input: {} },
        { type: 'tool_use', id: 'newest', name: 'Read', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'oldest', content: 'a'.repeat(180_000) },
        { type: 'tool_result', tool_use_id: 'newest', content: 'b'.repeat(180_000) },
      ] },
    ];
    const archiveDir = join(root, 'proactive');
    const measurements: Array<{ compacted: boolean; previousChars?: number }> = [];
    const guard = createRequestSizeGuard({
      compactOptions: () => ({ sessionId: 'proactive', archiveDir }),
      onMeasured: info => measurements.push(info),
    });
    for await (const _event of PROVIDERS['openai-codex']!.streamChat!(messages, {
      model: 'gpt-5.6-terra', requestSizeGuard: guard,
    })) { /* fake fetch, actual serializer */ }
    expect(guard.maxChars).toBe(400_000);
    expect(measurements[0]?.compacted).toBe(true);
    expect(measurements[0]?.previousChars).toBeLessThan(guard.maxChars);
    expect(captures[0]!.wireJson.length).toBeLessThanOrEqual(guard.compactAtChars!);
    const records = readFileSync(join(archiveDir, 'proactive.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records[0].origin.tool_use_id).toBe('oldest');
    expect(records).toHaveLength(1);
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
      llm: { provider: 'openai-codex', model, memoryJudge: { enabled: false, crossRecall: false } },
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
      llm: { provider: 'openai-codex', model, memoryJudge: { enabled: false, crossRecall: false } },
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
      llm: { provider: 'openai-codex', model, memoryJudge: { enabled: false, crossRecall: false } },
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

// ── TURN-REQUEST-SIZE-LOSS (0.3.38 P0 · 11-27 15:27) — sims, seeds 1–5 ──────────────────────────────────────────────────
// Measured: OP 7 · TC-H-POOL-3 4 · CC-1 3 · POOL-1 3 · POOL-2 3 · CX-6 2 · TUI-D 1 · CC-2 1 turns lost in 60 m to
// `llm.request request-size-limit-blocked` (401–406k chars vs 400k · reason compaction-no-op / still-over-cap:archive-tool-
// result). The wire was hundreds of small messages: no rung could take anything off. Expect: the oldest whole messages go
// (archived, pair-safe), the request is sent under the cap, and a provider size refusal is retried once after a trim.

function simRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A seat record: mail notices, short replies and small tool pairs (outputs under the floor's 600-char minimum). */
function seatRecord(seed: number, targetChars: number): import('../llm.js').LLMMessage[] {
  const r = simRng(seed);
  const out: import('../llm.js').LLMMessage[] = [{ role: 'system', content: 'SIM seat instructions' }];
  let i = 0;
  while (JSON.stringify(out).length < targetChars) {
    const k = i % 5;
    if (k === 0 || k === 2) out.push({ role: 'user', content: `[seat-mail m${seed}-${i} from TC] 우편 ${i} ${'mail body '.repeat(30 + Math.floor(r() * 120))}` });
    else if (k === 1 || k === 3) out.push({ role: 'assistant', content: `reply ${i} ${'ok '.repeat(30 + Math.floor(r() * 200))}` });
    else {
      out.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call_${seed}_${i}`, name: 'Bash', input: { command: `eln msg list ${i}` } }] });
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${seed}_${i}`, content: `row ${i} `.repeat(20 + Math.floor(r() * 40)) }] });
    }
    i++;
  }
  return out;
}

function assertPairsWhole(input: Array<{ type?: string; call_id?: string }>): void {
  const calls = new Set(input.filter(item => item.type === 'function_call').map(item => item.call_id));
  const outputs = new Set(input.filter(item => item.type === 'function_call_output').map(item => item.call_id));
  for (const id of outputs) expect(calls.has(id)).toBe(true);
  for (const id of calls) expect(outputs.has(id)).toBe(true);
}

const contextWindowError = [
  'data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","param":"input","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}',
  '',
  '',
].join('\n');

describe.serial('SIM TURN-REQUEST-SIZE-LOSS — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: a record of many small messages 1–3 % over the cap — oldest trimmed, request sent, turn kept`, async () => {
      const messages = seatRecord(seed, 404_000 + Math.floor(simRng(seed * 7)() * 8_000));
      messages.push({ role: 'user', content: `current turn ${seed} — answer this` });
      const archiveDir = join(root, 'archive');
      const log = spyOn(debug, 'log');
      let persisted: number | undefined;
      const guard = createRequestSizeGuard({
        compactOptions: () => ({ sessionId: `trim-${seed}`, archiveEnabled: true, archiveDir }),
        onCompacted: (compacted) => { persisted = compacted.length; },
      });
      try {
        for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ }
        expect(captures).toHaveLength(1);
        const wire = captures[0]!.wireJson;
        expect(wire.length).toBeLessThanOrEqual(280_000); // maxChars 400 000 × trimTargetRatio 0.7
        expect(wire).toContain(`current turn ${seed} — answer this`);
        expect(String(captures[0]!.body.instructions)).toContain('SIM seat instructions');
        expect(wire).toContain('[Earlier conversation held back — over the request size cap · ');
        assertPairsWhole(captures[0]!.body.input as Array<{ type?: string; call_id?: string }>);
        expect(persisted).toBe(messages.length); // the trimmed list went back to the caller (persisted history)
        const trim = log.mock.calls.find(call => call[0] === 'llm.request' && call[1] === 'request-size-trim-oldest');
        expect(trim).toBeDefined();
        expect(log.mock.calls.some(call => call[0] === 'llm.request' && call[1] === 'request-size-limit-blocked')).toBe(false);
        // Recoverable: the dropped messages are in the archive the marker names.
        const record = JSON.parse(readFileSync(join(archiveDir, `trim-${seed}.jsonl`), 'utf8').trim().split('\n').at(-1)!);
        expect(record.content).toContain(`[seat-mail m${seed}-0 from TC]`);
      } finally {
        log.mockRestore();
      }
    });

    test(`seed ${seed}: one oversized tool output in the current turn — archived stub, request sent`, async () => {
      const r = simRng(seed);
      const size = 410_000 + Math.floor(r() * 40_000);
      const messages: import('../llm.js').LLMMessage[] = [
        { role: 'system', content: 'SIM seat instructions' },
        { role: 'user', content: `read the log ${seed}` },
        { role: 'assistant', content: [{ type: 'tool_use', id: `big_${seed}`, name: 'Bash', input: { command: 'cat big.log' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `big_${seed}`, content: `line ${seed}\n${'log '.repeat(size / 4)}` }] },
      ];
      const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: `big-${seed}`, archiveEnabled: true, archiveDir: join(root, 'archive') }) });
      for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ }
      expect(captures).toHaveLength(1);
      expect(captures[0]!.wireJson.length).toBeLessThanOrEqual(400_000);
      expect(captures[0]!.wireJson).toContain(`read the log ${seed}`);
      assertPairsWhole(captures[0]!.body.input as Array<{ type?: string; call_id?: string }>);
    });

    test(`seed ${seed}: a provider size refusal before any output — trimmed below what was refused and sent once more`, async () => {
      // Under our cap (no pre-send trim), but the provider refuses it.
      const messages = seatRecord(seed, 270_000 + Math.floor(simRng(seed * 11)() * 20_000));
      messages.push({ role: 'user', content: `retry turn ${seed}` });
      sseFor = (call) => (call === 0 ? contextWindowError : undefined);
      const log = spyOn(debug, 'log');
      const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: `retry-${seed}`, archiveEnabled: true, archiveDir: join(root, 'archive') }) });
      try {
        for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ }
        expect(captures).toHaveLength(2);
        expect(captures[1]!.wireJson.length).toBeLessThan(captures[0]!.wireJson.length);
        expect(captures[1]!.wireJson.length).toBeLessThanOrEqual(Math.floor(captures[0]!.wireJson.length * 0.7)); // × trimTargetRatio
        expect(captures[1]!.wireJson).toContain(`retry turn ${seed}`);
        assertPairsWhole(captures[1]!.body.input as Array<{ type?: string; call_id?: string }>);
        const retry = log.mock.calls.find(call => call[0] === 'llm.request' && call[1] === 'request-size-retry');
        expect(retry?.[2]).toMatchObject({ retried: true });
      } finally {
        log.mockRestore();
      }
    });
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: root — a TUI seat session of many small rows is windowed to the CHAR budget, not just tokens`, async () => {
      // 11-27: the token window kept ~190k tokens of mostly-ASCII rows = 401–406k chars on the wire. Now the window
      // measures the stricter of tokens and chars (maxChars × trimTargetRatio), so the guard never has to fire.
      const model = 'gpt-5.6-terra';
      const session = createSession({ provider: 'openai-codex', model, source: 'tui' });
      const r = simRng(seed);
      let chars = 0;
      for (let i = 0; chars < 600_000 + r() * 60_000; i++) {
        const content = i % 2 === 0
          ? `[seat-mail m${seed}-${i} from TC] ${'mail body '.repeat(40 + Math.floor(r() * 120))}`
          : `reply ${i} ${'ok '.repeat(40 + Math.floor(r() * 200))}`;
        chars += content.length;
        appendMessage(session.id, { role: i % 2 === 0 ? 'user' : 'assistant', content, ts: new Date().toISOString() });
      }
      const log = spyOn(debug, 'log');
      try {
        await runTurn({
          userConfig: {
            llm: { provider: 'openai-codex', model, memoryJudge: { enabled: false, crossRecall: false } },
            chat: {
              autoCompact: { enabled: false, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0, partial: true, workingBudgetTokens: 256_000 },
              compact: { archiveEnabled: true },
            },
          } as never,
          sessionId: session.id,
          userText: `seat turn ${seed}`,
          systemPrompt: 'SIM seat system prompt',
          skipMemoryInjection: true,
          provider: PROVIDERS['openai-codex']!,
        });
        expect(captures).toHaveLength(1); // no summarizer call, no retry: the window alone was enough
        expect(captures[0]!.wireJson.length).toBeLessThanOrEqual(400_000 * 0.85);
        expect(captures[0]!.wireJson).toContain(`seat turn ${seed}`);
        expect(log.mock.calls.some(call => call[0] === 'llm.request' && call[1] === 'request-size-limit-blocked')).toBe(false);
        expect(log.mock.calls.some(call => call[0] === 'session.trim' && call[1] === 'dropped')).toBe(true);
      } finally {
        log.mockRestore();
      }
    });
  }

  test('a second size refusal is not retried again — one retry, then the error surfaces', async () => {
    const messages = seatRecord(9, 280_000);
    messages.push({ role: 'user', content: 'still refused' });
    sseFor = () => contextWindowError;
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'retry-twice', archiveEnabled: true, archiveDir: join(root, 'archive') }) });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ } };
    await expect(send()).rejects.toThrow('exceeds the context window');
    expect(captures).toHaveLength(2);
  });

  test('archive disabled — nothing is dropped, the request fails closed as before', async () => {
    const messages = seatRecord(3, 410_000);
    messages.push({ role: 'user', content: 'no archive' });
    const before = structuredClone(messages);
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'no-archive', archiveEnabled: false }) });
    const send = async () => { for await (const _ of PROVIDERS['openai-codex']!.streamChat!(messages, { model: 'gpt-5.6-terra', requestSizeGuard: guard })) { /* consume */ } };
    await expect(send()).rejects.toThrow('Codex request remains over');
    expect(messages).toEqual(before);
    expect(captures).toHaveLength(0);
  });
});
