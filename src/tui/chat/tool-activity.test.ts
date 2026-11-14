import { expect, test } from 'bun:test';
import { safeToolTarget, toolActivityTarget, toolActivityLines, updateToolActivity } from './tool-activity.js';

test('Write activity shows a basename and elapsed time before completion without exposing contents', () => {
  const target = toolActivityTarget('Write', { file_path: '/tmp/demo/ticketing.html', content: 'PRIVATE-document-body' });
  let rows = updateToolActivity([], { phase: 'start', id: 'write', name: 'Write', target }, 1000);
  expect(toolActivityLines(rows, 9500)).toEqual(['활동 · Write · ticketing.html · 실행 중 · 8초']);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'write', name: 'Write' }, 10000);
  expect(toolActivityLines(rows, 20000)).toEqual(['활동 · Write · ticketing.html · 완료 · 9초']);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-document-body');
  expect(JSON.stringify(rows)).not.toContain('/tmp/demo');
});

test('private targets, unknown internal tool names and shell arguments stay hidden', () => {
  expect(safeToolTarget('/private/secrets.json')).toBe('(비공개 파일)');
  expect(toolActivityTarget('Bash', { command: 'PRIVATE-command', path: '/tmp/anything' })).toBeUndefined();
  const rows = updateToolActivity([], { phase: 'start', id: 'private', name: 'PRIVATE-tool-diagnostic', target: 'PRIVATE-file' }, 0);
  expect(toolActivityLines(rows, 1000)).toEqual(['활동 · 도구 · 실행 중 · 1초']);
  expect(safeToolTarget('C:\\demo\\ticketing.html')).toBe('ticketing.html');
});

test('snapshot preserves running-call elapsed time and removes stale calls', () => {
  const started = updateToolActivity([], { phase: 'start', id: 'read', name: 'Read', target: 'guide.md' }, 1000);
  const snapshot = updateToolActivity(started, { phase: 'snapshot', calls: [{ id: 'read', name: 'Read', target: 'guide.md' }] }, 4000);
  expect(toolActivityLines(snapshot, 6000)).toEqual(['활동 · Read · guide.md · 실행 중 · 5초']);
  expect(updateToolActivity(snapshot, { phase: 'snapshot', calls: [] }, 7000)).toEqual([]);
});
