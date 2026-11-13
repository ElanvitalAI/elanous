import { expect, test } from 'bun:test';
import type { SidetabRow } from '../../sidetab-core/model.js';
import { formatSidetabSectionFrame, groupSidetabSections, normalizeSidetabSectionOrder, reorderSidetabSections, sidetabSectionTargetAt } from './sections.js';

const row = (id: string, overrides: Partial<SidetabRow> = {}): SidetabRow => ({
  id, label: id, kind: 'tui', badge: 'idle', ...overrides,
});

test('five live section headings and mouse targets survive selection scrolling', () => {
  const rows = [row('session-a'), row('run-a', { runId: 'run-a' }), row('pod-a', { kind: 'pod' }),
    row('herdr-a', { kind: 'herdr' }), row('remote-a', { remoteHost: 'minim5' })];
  const full = formatSidetabSectionFrame(rows, 0, 28, 20);
  expect(full.lines.filter((line) => /Sessions|Harness runs|Pods|Herdr|Remote/.test(line))).toHaveLength(5);
  expect(sidetabSectionTargetAt(full, 3, 1, 28)).toEqual({ kind: 'section', id: 'sessions' });
  expect(sidetabSectionTargetAt(full, 4, 1, 28)).toEqual({ kind: 'row', index: 0 });
  expect(sidetabSectionTargetAt(full, 4, 29, 28)).toBeUndefined();
  const short = formatSidetabSectionFrame(rows, 4, 28, 7);
  const remoteRow = [...short.targets].find(([, target]) => target.kind === 'row' && target.index === 4);
  expect(remoteRow?.[0]).toBeGreaterThanOrEqual(3); // Source: #37153 section header occupies the first side tab line
  expect(short.lines).toHaveLength(7);
});

test('stored section order rejects unknown and duplicate ids before drag', () => {
  const order = normalizeSidetabSectionOrder(['remote', 'remote', 'malformed', 'sessions']);
  expect(order).toEqual(['remote', 'sessions', 'harness', 'pods', 'herdr']);
  expect(reorderSidetabSections(order, 'pods', 'remote')).toEqual(['pods', 'remote', 'sessions', 'harness', 'herdr']);
  expect(reorderSidetabSections(order, 'remote', 'end')).toEqual(['sessions', 'harness', 'pods', 'herdr', 'remote']);
});

test('manual viewport reaches empty headings beyond a long session list and exposes the end drop', () => {
  const rows = Array.from({ length: 30 }, (_, index) => row(`session-${index}`)); // 출처: #37153 긴 목록 반례 fixture
  const first = formatSidetabSectionFrame(rows, 0, 28, 10);
  expect([...first.targets.values()]).not.toContainEqual({ kind: 'section', id: 'remote' });
  const last = formatSidetabSectionFrame(rows, 0, 28, 10, undefined, 999);
  expect(last.lines.join('\n')).toContain('Remote · 0');
  expect([...last.targets.values()]).toContainEqual({ kind: 'section', id: 'remote' });
  expect([...last.targets.values()]).toContainEqual({ kind: 'end' });
});

test('a running TUI session stays in sessions even when it carries a graph run id', () => {
  const rows = [row('tui:1', { kind: 'tui', sessionId: 'session-1', runId: 'run-1' }),
    row('run:1', { kind: 'harness', runId: 'run-2' })];
  expect(groupSidetabSections(rows).map(({ id, rows }) => [id, rows.map(({ id }) => id)]))
    .toEqual([['sessions', ['tui:1']], ['harness', ['run:1']]]);
});

test('side tab sections preserve row order and let a drag reorder only sections', () => {
  const rows = [row('session-a'), row('remote', { remoteHost: 'minim5' }),
    row('run-a', { runId: 'r1' }), row('session-b'), row('pod-a', { kind: 'pod' }),
    row('herdr-a', { kind: 'herdr' }), row('run-b', { runId: 'r2' })];
  const sections = groupSidetabSections(rows);
  expect(sections.map((section) => section.id)).toEqual(['sessions', 'harness', 'pods', 'herdr', 'remote']);
  expect(sections.find((section) => section.id === 'sessions')?.rows.map((item) => item.id)).toEqual(['session-a', 'session-b']);
  expect(sections.find((section) => section.id === 'harness')?.rows.map((item) => item.id)).toEqual(['run-a', 'run-b']);
  const order = reorderSidetabSections(sections.map((section) => section.id), 'remote', 'sessions');
  expect(groupSidetabSections(rows, order).map((section) => section.id)).toEqual(['remote', 'sessions', 'harness', 'pods', 'herdr']);
  expect(order).toHaveLength(5);
});
