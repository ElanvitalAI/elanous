import { expect, test } from 'bun:test';
import { testFakeLlmProvider } from './fake-llm.js';

test('fake active stream emits progress then its final answer', async () => {
  const names = ['ELANOUS_TEST_FAKE_LLM_HEARTBEAT_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_WHEN'];
  const before = names.map(name => process.env[name]);
  try {
    process.env.ELANOUS_TEST_FAKE_LLM_HEARTBEAT_MS = '5';
    process.env.ELANOUS_TEST_FAKE_LLM_DELAY_MS = '30';
    process.env.ELANOUS_TEST_FAKE_LLM_DELAY_WHEN = 'child';
    const events = await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user', content: 'child' }]));
    expect(events.filter(event => event.type === 'text' && event.delta === '.').length).toBeGreaterThan(1); // 출처: #91958 at least two progress events avoid a silent delay.
    expect(events.at(-1)).toEqual({ type: 'text', delta: '[test-fake-llm] OK' });
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
  }
});

test('abort while the consumer holds a heartbeat ends the stream', async () => {
  const names = ['ELANOUS_TEST_FAKE_LLM_HEARTBEAT_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_WHEN'];
  const before = names.map(name => process.env[name]);
  try {
    process.env.ELANOUS_TEST_FAKE_LLM_HEARTBEAT_MS = '60000';
    process.env.ELANOUS_TEST_FAKE_LLM_DELAY_MS = '60000';
    delete process.env.ELANOUS_TEST_FAKE_LLM_DELAY_WHEN;
    const controller = new AbortController();
    const stream = testFakeLlmProvider.streamChat!([{ role: 'user', content: 'child' }], { signal: controller.signal });
    expect(await stream.next()).toEqual({ value: { type: 'text', delta: '.' }, done: false });
    controller.abort();
    expect(await stream.next()).toEqual({ value: undefined, done: true });
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
  }
});
