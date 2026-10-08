import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { CanvasNodeCard } from './GraphCanvasEditor';

const card = (runStatus?: string) => renderToStaticMarkup(
  <ReactFlowProvider>
    <CanvasNodeCard {...({ id: 'build', data: { id: 'build', kind: 'agent', recipe: 'cmd:build', entry: false, terminal: false, issueCount: 0, flow: 'horizontal', ...(runStatus ? { runStatus } : {}) }, selected: false } as unknown as NodeProps)} />
  </ReactFlowProvider>);

describe('CGE-RUN canvas node run state', () => {
  test('a finished node keeps its state as colour and a word (the shared CSS only flashes «done» once)', () => {
    const done = card('done');
    expect(done).toContain('data-run-status="done"');
    expect(done).toContain('✓ 끝');
    expect(done).toContain('box-shadow:0 0 0 2px #10b981');
    expect(card('running')).toContain('● 도는 중');
    expect(card('failed')).toContain('✗ 실패');
  });
  test('no run → no state mark (editing looks as before)', () => {
    const idle = card();
    expect(idle).not.toContain('data-run-status');
    expect(idle).not.toContain('box-shadow');
    for (const word of ['도는 중', '✓ 끝', '실패']) expect(idle).not.toContain(word);
  });
});
