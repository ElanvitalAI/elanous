import { expect, test } from 'bun:test';
import { applyChunk, composeStream, createCompositorState } from './stream-compositor.js';

test('replace operation resets only the current stream text before later deltas append', () => {
  const state = createCompositorState();
  applyChunk(state, { delta: 'provisional answer' });
  applyChunk(state, { delta: 'grounded answer', textOperation: 'replace' });

  expect(state.text).toBe('grounded answer');
  expect(composeStream(state, 'partial')).toBe('grounded answer');

  applyChunk(state, { delta: ' with sources' });
  expect(state.text).toBe('grounded answer with sources');
});

test('ordinary stream chunks keep append semantics', () => {
  const state = createCompositorState();
  applyChunk(state, { delta: 'first ' });
  applyChunk(state, { delta: 'second' });
  expect(state.text).toBe('first second');
});
