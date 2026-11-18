import { expect, test } from 'bun:test';
import { isInterruptibleTool, pushNowToolDecision } from './tool-interrupt-class.js';

test('only read and search tools are interruptible; names match exactly, ignoring case', () => {
  for (const name of ['Read', 'read_file', 'Grep', 'Glob', 'ListDir', 'WebSearch', 'webfetch']) expect(isInterruptibleTool(name)).toBe(true);
  for (const name of ['Write', 'Edit', 'Bash', 'RunShell', 'Agent', 'NextSidetab', 'ReadWriteAll', 'Reader', '']) expect(isInterruptibleTool(name)).toBe(false);
});

test('receipt of a new utterance is not an interrupt: the decision depends on what is running', () => {
  expect(pushNowToolDecision([])).toBe('interrupt');
  expect(pushNowToolDecision(['Read', 'Grep'])).toBe('interrupt');
  expect(pushNowToolDecision(['Read', 'Edit'])).toBe('deferred');
  expect(pushNowToolDecision(['Bash'])).toBe('deferred');
});
