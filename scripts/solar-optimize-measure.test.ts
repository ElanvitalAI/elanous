import { expect, test } from 'bun:test';
import type { LLMStreamEvent } from '../src/llm.js';
import { solarMeasureWireViolations, validateSolarMeasureResult } from './solar-optimize-measure.js';

test('response contract rejects extra JSON fields and tool arguments', () => {
  const text = (delta: string): LLMStreamEvent => ({ type: 'text', delta });
  expect(validateSolarMeasureResult('json', [text('{"ok":true}')])).toBe(true);
  expect(validateSolarMeasureResult('json', [text('{"ok":true,"extra":1}')])).toBe(false);
  expect(validateSolarMeasureResult('json', [text('{"ok":"true"}')])).toBe(false);
  const tool = (args: Record<string, unknown>): LLMStreamEvent => ({ type: 'tool_call', id: 'call_lookup', name: 'lookup', args });
  expect(validateSolarMeasureResult('tool', [tool({ key: 'solar' })])).toBe(true);
  expect(validateSolarMeasureResult('tool', [tool({ key: 'solar', extra: true })])).toBe(false);
  expect(validateSolarMeasureResult('tool', [tool({ key: 'solar' }), tool({ key: 'solar' })])).toBe(false);
  expect(validateSolarMeasureResult('korean', [text('안녕하세요.')])).toBe(true);
  expect(validateSolarMeasureResult('korean', [text('안녕하세요！')])).toBe(true);
  expect(validateSolarMeasureResult('korean', [text('안녕하세요. 다른 말')])).toBe(false);
});

test('captured wire rejects lost budget, prompt, schema and tool contract', () => {
  const body: Record<string, unknown> = {
    model: 'upstage/solar-pro4',
    messages: [{ role: 'system', content: 'wrong' }, { role: 'user', content: '[tool] Call lookup with key solar.' }],
    provider: { require_parameters: true },
    max_tokens: 256, // Source: .rules/30-harness/testing-gates.md; caller-selected benchmark fixture budget.
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up a fact', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } } }],
  };
  expect(solarMeasureWireViolations(body, 'optimized', 'tool')).toEqual(['messages/prompt']);
  body.messages = [{ role: 'system', content: 'wrong' }, { role: 'user', content: '[tool] Call lookup with key solar.' }];
  delete body.max_tokens;
  expect(solarMeasureWireViolations(body, 'optimized', 'tool')).toContain('budget');
  body.tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];
  expect(solarMeasureWireViolations(body, 'optimized', 'tool')).toContain('tools');
  body.response_format = { type: 'json_object' };
  expect(solarMeasureWireViolations(body, 'optimized', 'tool')).toContain('response_format');
});
