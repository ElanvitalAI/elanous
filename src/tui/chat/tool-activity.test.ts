import { expect, test } from 'bun:test';
import { safeToolTarget, toolActivityTarget, toolActivityLines, updateToolActivity, safeCommandSummary } from './tool-activity.js';

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
  expect(toolActivityTarget('Bash', { command: 'PRIVATE-command', path: '/tmp/anything' })).toBe('(비공개 명령)');
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

test('actual native and capability names remain detailed while shell values and home paths are hidden', () => {
  expect(toolActivityTarget('write_file', { path: '/Users/synthetic/demo/page.html' })).toBe('page.html');
  const command = safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts --token=fixture-sensitive');
  expect(command).toBe('(비공개 명령)');
  expect(safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts')).toBe('bun test demo.test.ts');
  expect(safeCommandSummary('echo "fixture-sensitive"')).toBe('echo [인자]');
  expect(safeCommandSummary('cd /Users/synthetic')).not.toContain('synthetic');
  expect(safeToolTarget('/home/synthetic')).toBe('~');
  expect(safeCommandSummary('curl https://example.test/path')).not.toContain('example.test');
  const rows = updateToolActivity([], { phase: 'start', id: 'publish', name: 'app.publish@1' }, 0);
  expect(toolActivityLines(rows, 1000)[0]).toContain('app.publish@1');
});

test('completion keeps start order and snapshots preserve completed log rows within the bounded tail', () => {
  let rows = updateToolActivity([], { phase: 'start', id: 'a', name: 'read_file', target: 'a.md' }, 0);
  rows = updateToolActivity(rows, { phase: 'start', id: 'b', name: 'Bash', target: 'bun test' }, 1000);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'a', name: 'read_file' }, 2000);
  expect(rows.map(row => row.id)).toEqual(['a', 'b']);
  rows = updateToolActivity(rows, { phase: 'snapshot', calls: [{ id: 'b', name: 'Bash' }] }, 3000);
  expect(toolActivityLines(rows, 4000)).toEqual([
    '활동 · read_file · a.md · 완료 · 2초',
    '활동 · Bash · bun test · 실행 중 · 3초',
  ]);
  // Source: OP47767 recent twelve-line log bound.
  for (let i = 0; i < 20; i++) rows = updateToolActivity(rows, { phase: 'start', id: 'extra-' + i, name: 'Read' }, i);
  expect(rows).toHaveLength(12);
  expect(rows[0]?.id).toBe('extra-8');
});
