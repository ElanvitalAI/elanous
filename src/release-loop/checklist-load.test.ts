import { describe, expect, test } from 'bun:test';
import { buildChecklistLoad, renderChecklistLoad } from './checklist-load.js';
import type { Checklist, ChecklistItem } from './checklist.js';

const now = Date.parse('2026-11-24T12:00:00Z');
const item = (id: string, owner: string | undefined, path: string, priority: 'P0' | 'P1' | 'P2' = 'P0'): ChecklistItem => ({ id, owner, title: `대상 경로: ${path}`, status: 'yellow', priority, updatedAt: '2026-11-24T11:30:00Z', updatedBy: 'TC' });
const snapshot = (items: ChecklistItem[]): Checklist => ({ version: '0.3.35', released: '', dev: '', history: [], items });
const observed = { complete: true, panes: [{ seat: 'TC-H-CX-1', state: 'working', model: 'm1' }, { seat: 'TC-H-CX-2', state: 'idle', model: 'm2' }] };

describe('checklist load board', () => {
  test('counts P0/P1, 2h updates, ELS/model and makes a read-only suggestion', () => {
    const old = { ...item('B', 'TC-H-CX-1', 'src/b', 'P1'), updatedAt: '2026-11-24T09:00:00Z' };
    const board = buildChecklistLoad(snapshot([item('A', 'TC-H-CX-1', 'src/a'), old, item('C', 'TC-H-CX-3', 'src/c', 'P2')]), observed, now);
    expect(board.rows.find(r => r.seat === 'TC-H-CX-1')).toMatchObject({ p0: 1, p1: 1, states: ['WORKING'], models: ['m1'], updated2h: [{ id: 'A' }] });
    expect(board.proposals).toEqual([
      { id: 'A', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/a'] },
      { id: 'B', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/b'] },
    ]);
    expect(renderChecklistLoad(board)).toContain('자동 apply 미구현');
  });
  test('never proposes with unknown paths, glob, ambiguous owner or partial ELS', () => {
    const good = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/b')];
    expect(buildChecklistLoad(snapshot(good), { ...observed, complete: false }, now).proposals).toEqual([]);
    for (const bad of [item('C', 'TC-H-CX-3', 'src/*'), item('C', 'TC-H-CX-3', '../src'), item('C', 'TC-*', 'src/c')])
      expect(buildChecklistLoad(snapshot([...good, bad]), observed, now).proposals).toEqual([]);
  });
  test('blocks ancestor path collisions and a recipient with any yellow work', () => {
    const items = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/a/child'), item('C', 'TC-H-CX-2', 'other', 'P2')];
    expect(buildChecklistLoad(snapshot(items), observed, now).proposals).toEqual([]);
    expect(buildChecklistLoad(snapshot(items.slice(0, 2)), observed, now).proposals).toEqual([]);
  });
  test('distributes multiple disjoint candidates from one overloaded hand to distinct idle hands', () => {
    const panes = [...observed.panes, { seat: 'TC-H-CX-3', state: 'idle', model: 'm3' }];
    const items = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/b'), item('C', 'TC-H-CX-1', 'src/c')];
    expect(buildChecklistLoad(snapshot(items), { complete: true, panes }, now).proposals).toEqual([
      { id: 'A', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/a'] },
      { id: 'B', from: 'TC-H-CX-1', to: 'TC-H-CX-3', paths: ['src/b'] },
      { id: 'C', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/c'] },
    ]);
  });
  test('renders three separate queued proposals for overloaded and closed hands', () => {
    const panes = [...observed.panes, { seat: 'TC-H-CX-3', state: 'idle', model: 'm3' }, { seat: 'TC-H-CX-4', state: 'exited', model: 'm4' }];
    const items = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/b'), item('C', 'TC-H-CX-4', 'src/c')];
    const board = buildChecklistLoad(snapshot(items), { complete: true, panes }, now);
    expect(board.proposals.map(p => [p.id, p.to])).toEqual([['A', 'TC-H-CX-2'], ['B', 'TC-H-CX-3'], ['C', 'TC-H-CX-2']]);
    expect(renderChecklistLoad(board).split('\n').filter(line => line.startsWith('배분 제안: '))).toHaveLength(3);
  });
  test('proposes a closed hand’s single task to an idle hand', () => {
    const panes = [{ seat: 'TC-H-CX-1', state: 'exited', model: 'm1' }, { seat: 'TC-H-CX-2', state: 'idle', model: 'm2' }];
    const board = buildChecklistLoad(snapshot([item('A', 'TC-H-CX-1', 'src/a')]), { complete: true, panes }, now);
    expect(board.proposals).toEqual([{ id: 'A', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/a'] }]);
  });
  test('does not use generic pools or leadership as recipients', () => {
    const panes = [...observed.panes, ...['POOL-4', 'OP', 'TC'].map(seat => ({ seat, state: 'idle', model: 'm' }))];
    const items = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/b')];
    expect(buildChecklistLoad(snapshot(items), { complete: true, panes }, now).proposals.map(p => p.to)).toEqual(['TC-H-CX-2', 'TC-H-CX-2']);
  });
  test('ambiguous P2 ownership blocks allocation and overlapping candidates are skipped', () => {
    const items = [item('A', 'TC-H-CX-1', 'src/a'), item('B', 'TC-H-CX-1', 'src/a/child'), item('C', 'TC-H-CX-1', 'src/c')];
    expect(buildChecklistLoad(snapshot([...items, item('D', 'POOL-4', 'src/d', 'P2')]), observed, now).proposals).toEqual([]);
    expect(buildChecklistLoad(snapshot(items), observed, now).proposals).toEqual([{ id: 'C', from: 'TC-H-CX-1', to: 'TC-H-CX-2', paths: ['src/c'] }]);
  });
  test('surfaces unknown owners and unobserved seats without claiming they are idle', () => {
    const board = buildChecklistLoad(snapshot([item('A', undefined, 'src/a'), item('B', 'TC-H-CX-9', 'src/b')]), observed, now);
    expect(board.ambiguousOwners).toEqual([{ id: 'A', owner: null }]);
    expect(board.rows.find(r => r.seat === 'TC-H-CX-9')?.ownerStatus).toBe('closed-or-unobserved');
  });
});
