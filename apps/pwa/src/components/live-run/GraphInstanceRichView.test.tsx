import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphInstanceRichView, type GraphInstanceView } from './GraphInstanceRichView';

// Source: R-SURFACE's shared JSON v1 examples. TUI and PWA consume these exact files.
const fixture = (source: 'graph' | 'harness' | 'release' | 'resource'): GraphInstanceView =>
  JSON.parse(readFileSync(resolve(import.meta.dir, `../../../../../plugins/graph-instance-view/fixtures/${source}.view.json`), 'utf8')) as GraphInstanceView;

for (const source of ['graph', 'harness', 'release', 'resource'] as const) {
  test(`PWA renders the shared ${source} JSON without dropping or duplicating IDs`, () => {
    const view = fixture(source);
    const html = renderToStaticMarkup(<GraphInstanceRichView view={view} />);
    expect(view.instance.source).toBe(source);
    for (const node of view.nodes) expect(html.match(new RegExp(`data-node-id="${node.id}"`, 'g'))).toHaveLength(1);
    for (const edge of view.edges) expect(html.match(new RegExp(`data-edge-id="${edge.id}"`, 'g'))).toHaveLength(1);
    for (const log of view.logs) expect(html.match(new RegExp(`data-log-seq="${log.seq}"`, 'g'))).toHaveLength(1);
    expect(html).toContain(view.statusLine);
    expect(html).toContain(`${view.progress.label ?? '진행'} ${view.progress.completed}/${view.progress.total ?? '?'}`);
    expect(view.logs.map(log => html.indexOf(`data-log-seq="${log.seq}"`))).toEqual(
      [...view.logs.map(log => html.indexOf(`data-log-seq="${log.seq}"`))].sort((a, b) => a - b));
  });
}

test('partial and unavailable reads remain explicit instead of implying complete progress', () => {
  const view = fixture('harness');
  const partial = renderToStaticMarkup(<GraphInstanceRichView view={{ ...view, readState: 'partial' }} />);
  const unavailable = renderToStaticMarkup(<GraphInstanceRichView view={{ ...view, readState: 'unavailable' }} />);
  expect(partial).toContain('원장 읽기 일부만 가능');
  expect(unavailable).toContain('원장 읽기 불가');
  expect(unavailable).toContain('진행 2/?');
});

test('resource JSON shows observed host status, load, memory, tasks and resource log order', () => {
  const view = fixture('resource');
  const html = renderToStaticMarkup(<GraphInstanceRichView view={view} />);
  expect(html).toContain('data-node-id="mbp" data-node-state="on"');
  expect(html).toContain('data-node-id="azure" data-node-state="stopped"');
  expect(html).toContain('aria-label="mbp 부하"');
  expect(html).toContain('aria-label="mbp 메모리"');
  expect(html).toContain('seat · R-SURFACE');
  expect(html).toContain('가동 7/10');
  expect(html.indexOf('data-log-seq="1"')).toBeLessThan(html.indexOf('data-log-seq="3"'));
  expect(view.nodes.find(node => node.id === 'azure')?.resource?.loadavg).toBeUndefined();
});
