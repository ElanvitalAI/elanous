import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import { compactLiveMessages, createRequestSizeGuard } from './request-size-guard.js';
import { runCompactPipeline } from '../compact/pipeline.js';
import { dispatchRead } from '../code-edit/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('request-size archive candidates', () => {
  test('direct live compaction writes tool output to the configured archive directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const original = 'output\n'.repeat(10_000);
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'direct', content: original }] }];
    const oldHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const result = await compactLiveMessages(messages, { sessionId: 'direct', archiveDir: join(dir, 'archive'), preserveLastN: 0, runCompactPipeline });
      expect(result).not.toBeNull();
      const record = JSON.parse(readFileSync(join(dir, 'archive', 'direct.jsonl'), 'utf8').trim());
      expect(record.content).toBe(original);
      expect(record.origin.tool_use_id).toBe('direct');
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
  test('generates candidates oldest-first, archives originals, and leaves the input unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'short', content: 'x' },
      { type: 'tool_result', tool_use_id: 'long', content: 'long original '.repeat(100) },
    ] }];
    const before = structuredClone(messages);
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'test', archiveDir: dir }) });
    const first = await guard.compactNext!(messages, 0);
    expect(first?.nextIndex).toBe(1);
    const candidate = await guard.compactNext!(messages, first!.nextIndex);
    expect(messages).toEqual(before);
    expect(candidate?.nextIndex).toBe(2);
    const blocks = candidate!.messages[0]!.content as Array<{ tool_use_id: string; content: string }>;
    expect(blocks[0]!.content).toBe('x');
    expect(blocks[1]!.content).toContain(join(dir, 'test.jsonl'));
    const records = readFileSync(join(dir, 'test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.origin.tool_use_id)).toEqual(['short', 'long']);
    expect(records[1].content).toBe('long original '.repeat(100));
  });

  test('skips only an exact archived replacement for the same tool result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const original = '[Full output (fake saved to: nowhere] ' + 'x'.repeat(410_000);
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fake', content: original }] }];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'test', archiveDir: dir }) });
    const candidate = await guard.compactNext!(messages, 0);
    expect(candidate).not.toBeNull();
    expect(await guard.compactNext!(candidate!.messages, 0)).toBeNull();
    const entry = JSON.parse(readFileSync(join(dir, 'test.jsonl'), 'utf8').trim());
    expect(entry.content).toBe(original);
  });

  test('distinct same-length UTF-16 results with a reused tool id have distinct archive references', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'reused', content: 'value \ud800' },
      { type: 'tool_result', tool_use_id: 'reused', content: 'value \ud801' },
    ] }];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'test', archiveDir: dir }) });
    const first = await guard.compactNext!(messages, 0);
    const second = await guard.compactNext!(first!.messages, first!.nextIndex);
    expect(second).not.toBeNull();
    const blocks = second!.messages[0]!.content as Array<{ content: string }>;
    expect(blocks[0]!.content).not.toBe(blocks[1]!.content);
    const records = readFileSync(join(dir, 'test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.content)).toEqual(['value \ud800', 'value \ud801']);
    expect(records[0].replacement).not.toBe(records[1].replacement);
  });

  test('text archive pointers distinguish long blocks in the same message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const first = 'head'.repeat(500) + 'a'.repeat(20_000) + 'tail'.repeat(2000);
    const second = 'head'.repeat(500) + 'b'.repeat(20_000) + 'tail'.repeat(2000);
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'text', text: first }, { type: 'text', text: second },
      { type: 'tool_result', tool_use_id: 'small', content: 'ok' },
    ] }, { role: 'user', content: 'current request' }];
    const guard = createRequestSizeGuard({ compactOptions: () => ({ sessionId: 'blocks', archiveDir: dir }) });
    const result = await guard.compactMessages(messages, { provider: 'openai-codex', requestChars: 410_000, maxChars: 400_000 });
    const blocks = result!.messages[0]!.content as Array<{ text: string }>;
    expect(blocks[0]!.text).not.toBe(blocks[1]!.text);
    const path = blocks[0]!.text.match(/saved to: ([^\]]+)\]/)![1]!;
    expect(blocks[1]!.text).toContain(path);
    const read = await dispatchRead({ file_path: path });
    const records = read.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    expect(records.find(record => record.replacement === blocks[0]!.text)?.content).toBe(first);
    expect(records.find(record => record.replacement === blocks[1]!.text)?.content).toBe(second);
  });

  test('preserves long system and user text if archive writes fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'file');
    const messages: LLMMessage[] = [
      { role: 'system', content: 'system '.repeat(20_000) },
      { role: 'user', content: 'user '.repeat(20_000) },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'small', content: 'ok' }] },
    ];
    const before = structuredClone(messages);
    const guard = createRequestSizeGuard({ compactOptions: () => ({ archiveDir: file }) });
    const result = await guard.compactMessages(messages, { provider: 'openai-codex', requestChars: 410_000, maxChars: 400_000 });
    expect(result).toBeNull();
    expect(messages).toEqual(before);
  });

  test('never substitutes an unarchived result when persistence fails or is disabled', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'large', content: 'x'.repeat(20_000) },
    ] }];
    const before = structuredClone(messages);
    const disabled = createRequestSizeGuard({ compactOptions: () => ({ archiveEnabled: false }) });
    expect(await disabled.compactNext!(messages, 0)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'request-size-guard-'));
    dirs.push(dir);
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'file');
    const failing = createRequestSizeGuard({ compactOptions: () => ({ archiveDir: file }) });
    expect(await failing.compactNext!(messages, 0)).toBeNull();
    expect(messages).toEqual(before);
  });
});
