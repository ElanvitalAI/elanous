import { describe, expect, test } from 'bun:test';
import { loadPullPolicy, recentDeclaredPr } from './index.js';
import { parsePrs } from '../../steward/space/sources.js';

const now = Date.parse('2026-11-28T12:00:00Z');
const policy = loadPullPolicy();
const raw = (ageMs: number, body = '칸: WORK-1', draft = true) => ({ number: 1, headRefOid: 'abc', headRefName: 'branch', title: 'WORK-1', body, isDraft: draft, updatedAt: new Date(now - ageMs).toISOString() });
const protects = (pr: ReturnType<typeof raw>, cell = 'WORK-1') => recentDeclaredPr(cell, parsePrs([pr]), now, policy);
describe('open PR declaration protects independently of checklist writer', () => {
  test('draft and ready open PRs at lease boundary protect', () => {
    expect(protects(raw(0))).toBe(true);
    expect(protects(raw(45 * 60_000, '칸: WORK-1', false))).toBe(true);
  });
  test('expired, other cell, title only, malformed and future do not protect', () => {
    expect(protects(raw(45 * 60_000 + 1))).toBe(false);
    expect(protects(raw(0), 'WORK-12')).toBe(false);
    expect(protects(raw(0, 'title WORK-1'))).toBe(false);
    expect(protects(raw(0, '칸: WORK-12'))).toBe(false);
    expect(protects(raw(-1))).toBe(false);
    expect(recentDeclaredPr('WORK-1', [], now, policy)).toBe(false);
  });
  test('policy controls PR signal', () => {
    expect(recentDeclaredPr('WORK-1', parsePrs([raw(0)]), now, { ...policy, progress: ['claim'] })).toBe(false);
  });
});
