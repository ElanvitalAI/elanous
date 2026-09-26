import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir';
import { ANSWER_PRIORITY_CHOICES } from '../../onboarding';
import { resetUserConfig } from '../../user-config';
import { createNexusState } from '../state/state';
import { TabRegistry } from '../state/tab-registry';
import { NexusEventBus } from './event-bus';
import { startNexusHttpServer } from './http-server';
import { handleAnswerPriorityGet, handleAnswerPrioritySet } from './setup-answer-priority';

let root: string;
const originalXdg = process.env.XDG_CONFIG_HOME;
const configPath = () => join(root, 'config.json');
const post = (body: unknown) => new Request('http://localhost/v1/setup/answer-priority', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-answer-priority-'));
  delete process.env.XDG_CONFIG_HOME;
  setElanousConfigDir(root);
  resetUserConfig();
  writeFileSync(configPath(), '{}\n');
});

afterEach(() => {
  resetElanousConfigDir();
  resetUserConfig();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(root, { recursive: true, force: true });
});

test('POST quality changes only llm.answerPriority bytes, preserving surrounding config', async () => {
  const before = '{\n  "other": { "notice": "keep \\"answerPriority\\"" },\n  "llm": { "model" : "abc", "answerPriority" : "cost", "nested": {"answerPriority":"untouched"} },\n  "tail": [1, 2]\n}\n';
  writeFileSync(configPath(), before);
  resetUserConfig();
  const res = await handleAnswerPrioritySet(post({ value: 'quality' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ value: 'quality' });
  const after = readFileSync(configPath(), 'utf8');
  expect(after).toBe(before.replace('"answerPriority" : "cost"', '"answerPriority" : "quality"'));
  expect(JSON.parse(after).llm.answerPriority).toBe('quality');
  expect(await handleAnswerPriorityGet().json()).toMatchObject({ value: 'quality', effective: 'quality' });
});

test('POST quality inserts llm when absent without reserializing other top-level bytes', async () => {
  const before = '{\n  "other": {"answerPriority":"keep"}, "tail" : [1, 2]\n}\n';
  writeFileSync(configPath(), before);
  const res = await handleAnswerPrioritySet(post({ value: 'quality' }));
  expect(res.status).toBe(200);
  expect(readFileSync(configPath(), 'utf8')).toBe(before.slice(0, -2) + ',"llm":{"answerPriority":"quality"}}\n');
});

test('POST quality creates only the missing member while preserving existing bytes', async () => {
  const before = '{\n  "other": 1, "llm": { "model": "abc" }\n}\n';
  writeFileSync(configPath(), before);
  const res = await handleAnswerPrioritySet(post({ value: 'quality' }));
  expect(res.status).toBe(200);
  expect(readFileSync(configPath(), 'utf8')).toBe(before.replace('"model": "abc" }', '"model": "abc" ,"answerPriority":"quality"}'));
});

test('duplicate root llm keys are rejected rather than reporting a save to the shadowed key', async () => {
  const before = '{"llm":{"answerPriority":"cost"},"untouched":{"x":1},"llm":{"answerPriority":"balanced","model":"keep"}}\n';
  writeFileSync(configPath(), before);
  const res = await handleAnswerPrioritySet(post({ value: 'quality' }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('duplicate-config-key');
  expect(readFileSync(configPath(), 'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(configPath(), 'utf8')).llm.answerPriority).toBe('balanced');
});

test('duplicate answerPriority keys in llm are rejected without changing other settings', async () => {
  const before = '{"other":{"x":1},"llm":{"answerPriority":"cost","model":"keep","answerPriority":"balanced"}}\n';
  writeFileSync(configPath(), before);
  const res = await handleAnswerPrioritySet(post({ value: 'quality' }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('duplicate-config-key');
  expect(readFileSync(configPath(), 'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(configPath(), 'utf8')).llm.answerPriority).toBe('balanced');
});

test('invalid value and unknown fields return 400 without writing', async () => {
  const before = readFileSync(configPath(), 'utf8');
  const invalid = await handleAnswerPrioritySet(post({ value: 'turbo' }));
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error).toBe('invalid-answer-priority');
  const unknown = await handleAnswerPrioritySet(post({ value: 'quality', extra: true }));
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe('unknown-fields');
  expect(readFileSync(configPath(), 'utf8')).toBe(before);
});

test('HTTP route serves GET and authenticated POST with the same preflight as child-llm', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, eventBus, registry: new TabRegistry(state),
    startPort: 43000 + Math.floor(Math.random() * 2000),
    metaApi: { bearerToken: 'auth', noAuth: false },
  });
  try {
    const headers = { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' };
    const options = await fetch(`${server.url}/v1/setup/answer-priority`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toContain('POST');
    const unauthorized = await fetch(`${server.url}/v1/setup/answer-priority`, {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    const saved = await fetch(`${server.url}/v1/setup/answer-priority`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"value":"quality"}',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ value: 'quality' });
    const get = await fetch(`${server.url}/v1/setup/answer-priority`, { headers });
    expect(get.status).toBe(200);
    expect((await get.json() as { effective: string }).effective).toBe('quality');
  } finally {
    server.stop();
  }
});

test('GET without a configured value returns null, balanced and the onboarding choices', async () => {
  expect(await handleAnswerPriorityGet().json()).toEqual({
    value: null, effective: 'balanced',
    choices: ANSWER_PRIORITY_CHOICES.map(({ value, label, description }) => ({ value, label, description })),
  });
  expect(ANSWER_PRIORITY_CHOICES).toHaveLength(4);
});
