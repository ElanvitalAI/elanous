import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { addItem, checklistHistory, listChecklist, setItem } from './checklist.js';
import { exportJson } from './feature-store.js';
import { placeCell, seatMove } from './placement.js';
import { setSchedule } from './release-schedule.js';

let dir = '';
const now = new Date('2026-10-04T00:00:00Z');
const v = '0.2.15';
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'ceo-load-'));
  setElanousConfigDir(dir);
  setSchedule(v, { cutAt: '2026-10-05T02:00:00Z', landBy: '2026-10-05T02:00:00Z' }, 'OP');
  setSchedule('0.2.16', { cutAt: '2026-10-06T02:00:00Z', landBy: '2026-10-06T02:00:00Z' }, 'OP');
}
afterEach(() => { resetElanousConfigDir(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const input = (id: string, ceoMinutes: number, ceoDate?: string) => ({ id, title: id, owner: 'MK', priority: 'P1' as const, deadlineVersion: v, predecessors: [], ceoMinutes, ...(ceoDate ? { ceoDate } : {}) });
const deps = { now, merged24h: 20 };

test('SNS 10 + EMBA 30 + YouTube 10 on an October KST day refuses before writing, proposes three adjustments; at cap passes', () => {
  setup();
  addItem(v, { id: 'EMBA', title: 'EMBA', owner: 'OP', ceoMinutes: 30, ceoDate: '2026-10-05' });
  const before = listChecklist(v);
  const sns = input('SNS', 10);
  expect(() => placeCell(sns, deps)).toThrow('대표 손 과부하 2026-10-05 KST: EMBA 30분 + SNS 10분 = 40분 > 하루 상한 30분 — 늦추기(다음 날짜/판) · 자리 대행(대표 분량 축소) · 묶기(촬영·승인 합산 분량 축소)를 제안');
  expect(listChecklist(v)).toEqual(before);
  setItem(v, 'EMBA', { ceoMinutes: 10 }, 'OP');
  expect(placeCell(sns, deps).version).toBe(v);
  expect(() => placeCell(input('YouTube', 20), { ...deps, dryRun: true })).toThrow('대표 손 과부하');
  expect(listChecklist(v).items.map((item) => item.id)).toEqual(['EMBA', 'SNS']);
  expect(placeCell(input('YouTube', 10), deps).version).toBe(v);
  expect(listChecklist(v).items.find((item) => item.id === 'YouTube')?.ceoMinutes).toBe(10);
  expect(placeCell(input('YouTube', 10), { ...deps, dryRun: true }).version).toBe(v);
  const beforeIncrease = listChecklist(v);
  expect(() => placeCell(input('YouTube', 11), deps)).toThrow('31분 > 하루 상한 30분');
  expect(listChecklist(v)).toEqual(beforeIncrease);
});

test('different day, configured cap, and another release sharing an explicit date are counted independently of release version', () => {
  setup();
  addItem(v, { id: 'SNS', title: 'SNS', owner: 'MK', ceoMinutes: 10, ceoDate: '2026-10-05' });
  addItem('0.2.16', { id: 'EMBA', title: 'EMBA', owner: 'OP', ceoMinutes: 20, ceoDate: '2026-10-05' });
  expect(() => placeCell(input('YouTube', 10), deps)).toThrow('40분 > 하루 상한 30분');
  expect(placeCell(input('YouTube', 10, '2026-10-06'), deps).version).toBe(v);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ release: { placement: { ceoDailyCap: 15 } } }));
  expect(() => placeCell(input('new', 6), deps)).toThrow('36분 > 하루 상한 15분');
  expect(placeCell(input('small', 5, '2026-10-07'), deps).version).toBe(v);
});

test('legacy checklist JSON import and exported snapshots retain representative minutes and day', () => {
  setup();
  const version = '0.2.17';
  const folder = join(dir, 'release', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify({ version, released: '', dev: 'test', items: [
    { id: 'approval', title: 'approval', status: 'yellow', ceoMinutes: 10, ceoDate: '2026-10-05', updatedAt: '2026-10-04T00:00:00Z', updatedBy: 'OP' },
  ], history: [] }));
  expect(listChecklist(version).items[0]).toMatchObject({ ceoMinutes: 10, ceoDate: '2026-10-05' });
  expect(exportJson(version).items[0]).toMatchObject({ ceoMinutes: 10, ceoDate: '2026-10-05' });
  expect(listChecklist(version).items[0]).toMatchObject({ ceoMinutes: 10, ceoDate: '2026-10-05' });
});

test('a flexible P2 cell chooses the next available landing day when the first day is full', () => {
  setup();
  addItem(v, { id: 'EMBA', title: 'EMBA', ceoMinutes: 30 });
  const decision = placeCell({ id: 'SNS', title: 'SNS', owner: 'MK', priority: 'P2', predecessors: [], ceoMinutes: 10 }, deps);
  expect(decision.version).toBe('0.2.16');
  expect(listChecklist(v).items.map((item) => item.id)).toEqual(['EMBA']);
  expect(listChecklist('0.2.16').items[0]?.ceoMinutes).toBe(10);
});

test('P1 displacement validates the combined post-move daily load before any write', () => {
  setup();
  // Fill the first release's PR capacity so placing P1 must carry the last P2 into the next release.
  const capacity = Math.floor(20 * (Date.parse('2026-10-05T02:00:00Z') - now.getTime()) / 86_400_000 * 0.7);
  for (let i = 0; i < capacity - 1; i++) addItem(v, { id: `ordinary-${i}`, title: `ordinary-${i}`, owner: 'TC' });
  addItem(v, { id: 'YouTube', title: 'YouTube', owner: 'MK', priority: 'P2', ceoMinutes: 20 });
  const beforeFirst = listChecklist(v), beforeNext = listChecklist('0.2.16');
  const conflicting = input('SNS', 20, '2026-10-06');
  expect(() => placeCell(conflicting, deps)).toThrow('대표 손 과부하 2026-10-06 KST: YouTube 20분 + SNS 20분 = 40분 > 하루 상한 30분');
  expect(listChecklist(v)).toEqual(beforeFirst);
  expect(listChecklist('0.2.16')).toEqual(beforeNext);
  expect(checklistHistory('YouTube').some((entry) => entry.field === 'move')).toBe(false);
  const safe = placeCell(input('SNS', 10, '2026-10-06'), deps);
  expect(safe.displaced.map((row) => row.id)).toEqual(['YouTube']);
  expect(listChecklist(v).items.some((item) => item.id === 'SNS')).toBe(true);
  expect(listChecklist('0.2.16').items.find((item) => item.id === 'YouTube')?.ceoMinutes).toBe(20);
});

test('backlog cells with an explicit CEO work date participate in the daily total', () => {
  setup();
  addItem('0.9.0', { id: 'EMBA', title: 'EMBA', ceoMinutes: 30, ceoDate: '2026-10-05' });
  expect(() => placeCell(input('SNS', 10), deps)).toThrow('40분 > 하루 상한 30분');
  expect(listChecklist(v).items).toEqual([]);
});

test('seat move refuses a target-day collision before moving the cell or writing history', () => {
  setup();
  addItem(v, { id: 'SNS', title: 'SNS', owner: 'MK', ceoMinutes: 20, ceoDate: '2026-10-06' });
  addItem('0.2.16', { id: 'YouTube', title: 'YouTube', owner: 'MK', ceoMinutes: 20, ceoDate: '2026-10-06' });
  const before = checklistHistory('SNS');
  expect(() => seatMove('SNS', v, '0.2.16', 'MK', 'delay', deps)).toThrow('대표 손 과부하 2026-10-06 KST');
  expect(checklistHistory('SNS')).toEqual(before);
  expect(listChecklist(v).items.map((item) => item.id)).toEqual(['SNS']);
});

test('a completed task still occupies its recorded representative day', () => {
  setup();
  addItem(v, { id: 'approval', title: 'approval', ceoMinutes: 30 });
  setItem(v, 'approval', { status: 'done' }, 'OP');
  expect(() => placeCell(input('SNS', 10), deps)).toThrow('40분 > 하루 상한 30분');
});

test('existing cells without representative load preserve normal priority and capacity placement', () => {
  setup();
  const normal = { id: 'ordinary', title: 'ordinary', owner: 'TC', priority: 'P0' as const, predecessors: [] };
  expect(placeCell(normal, deps)).toMatchObject({ id: 'ordinary', from: null, version: v, displaced: [] });
  expect(listChecklist(v).items[0]).toMatchObject({ id: 'ordinary', priority: 'P0' });
  expect(listChecklist(v).items[0]?.ceoMinutes).toBeUndefined();
});

test('checklist CLI adds/sets minutes and day with history, rejects invalid values without a ledger write', async () => {
  setup();
  const cmd = new Command(); registerReleaseCommands(cmd);
  const run = (...args: string[]) => cmd.parseAsync(['release', 'checklist', ...args], { from: 'user' });
  await run('add', 'SNS', 'SNS', '--version', v, '--owner', 'MK', '--ceo-minutes', '10', '--ceo-date', '2026-10-05');
  expect(listChecklist(v).items[0]).toMatchObject({ ceoMinutes: 10, ceoDate: '2026-10-05' });
  await run('set', 'SNS', '--version', v, '--ceo-minutes', '20');
  expect(listChecklist(v).items[0]?.ceoMinutes).toBe(20);
  expect(checklistHistory('SNS').at(-1)).toMatchObject({ field: 'ceoMinutes', from: 10, to: 20 });
  const before = listChecklist(v);
  await expect(run('set', 'SNS', '--version', v, '--ceo-minutes', '-1')).rejects.toThrow('대표 손 분량');
  await expect(run('set', 'SNS', '--version', v, '--ceo-date', '2026-02-30')).rejects.toThrow('대표 손 날짜');
  expect(listChecklist(v)).toEqual(before);
});
