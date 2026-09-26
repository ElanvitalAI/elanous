import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { NexusApiError, type AnswerPriorityResponse, type AnswerPriorityValue } from '../../nexus/client';
import { AnswerDepthCard, type AnswerDepthClient } from './AnswerDepthCard';

const snapshot: AnswerPriorityResponse = {
  value: 'quality', effective: 'quality',
  choices: [
    { value: 'cost', label: '비용', description: '도구를 적게 사용' },
    { value: 'balanced', label: '균형', description: '균형 잡힌 답변' },
    { value: 'quality', label: '품질', description: '자세한 답변' },
    { value: 'exhaustive', label: '최대', description: '깊게 탐색' },
  ],
};

test('server choices and current value render as radios; selecting cost saves cost', async () => {
  const calls: AnswerPriorityValue[] = [];
  const client: AnswerDepthClient = {
    getAnswerPriority: async () => snapshot,
    setAnswerPriority: async (value) => { calls.push(value); return { value }; },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(AnswerDepthCard as (props: { client: AnswerDepthClient }) => ReturnType<typeof AnswerDepthCard>, { client })); });
  const radios = tree!.root.findAllByType('input');
  expect(radios.map((radio) => radio.props.value)).toEqual(snapshot.choices.map((choice) => choice.value));
  expect(radios.find((radio) => radio.props.value === 'quality')?.props.checked).toBe(true);
  expect(tree!.root.findAllByType('legend')[0]?.children.join('')).toContain('품질');
  await act(async () => { radios[0]!.props.onChange(); });
  expect(tree!.root.findAllByType('input')[0]?.props.checked).toBe(true);
  await act(async () => { tree!.root.findByProps({ type: 'button' }).props.onClick(); });
  expect(calls).toEqual(['cost']);
  expect(tree!.root.findAllByType('legend')[0]?.children.join('')).toContain('비용');
  await act(async () => { tree!.unmount(); });
});

test('server reason is displayed when saving fails', async () => {
  const client: AnswerDepthClient = {
    getAnswerPriority: async () => snapshot,
    setAnswerPriority: async () => { throw new NexusApiError(400, '/v1/setup/answer-priority', { reason: '서버 거부' }); },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(AnswerDepthCard as (props: { client: AnswerDepthClient }) => ReturnType<typeof AnswerDepthCard>, { client })); });
  await act(async () => { tree!.root.findByProps({ type: 'button' }).props.onClick(); });
  expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toBe('서버 거부');
  await act(async () => { tree!.unmount(); });
});

test('prerender without daemon client does not throw or request', () => {
  expect(renderToStaticMarkup(createElement(AnswerDepthCard))).toContain('answer-depth-card');
});
