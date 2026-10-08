#!/usr/bin/env bun
/**
 * RETRO-DAILY 그림자 대조 — 매일 회고 그래프를 «정답지»(RFC §0 다섯 반복 문제) 위에서 돌려 맞혔는지 본다.
 *
 *   bun scripts/retro/shadow-compare.ts [--facts <facts.json>] [--key <answer-key.json>] [--json]
 *
 * 기본 입력 = test/fixtures/retro/ 의 10-07 사실 ⊕ 정답지. 그래프는 임시 우주(mkdtemp)에서 shadow 로만 돈다 —
 * 운영 회고 파일·체크리스트·메시지 어느 것도 건드리지 않는다. 놓친 주제가 있으면 exit 1.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import { retroDayFile } from '../../src/retro/daily.js';

const repo = resolve(import.meta.dir, '..', '..');
export const RETRO_DAILY_GRAPH = join(repo, 'graphs', 'retro', 'daily.yaml');
export const DEFAULT_FACTS = join(repo, 'test', 'fixtures', 'retro', 'rfc0-2026-10-07-facts.json');
export const DEFAULT_KEY = join(repo, 'test', 'fixtures', 'retro', 'rfc0-answer-key.json');

type Theme = { theme: string; title: string; recurring: boolean; reBrokeAfterGreen: boolean; rank: number };
type Key = { day: string; greenCells?: unknown[]; expected: { theme: string; title: string; reBrokeAfterGreen?: boolean }[]; notRecurring?: string[] };
export type ShadowComparison = {
  ok: boolean; status: string; day: string; detected: string[]; missed: string[]; falsePositives: string[];
  reBrokeMismatch: string[]; firstRank: string | null; actions: number; summary: string[]; wroteChecklist: boolean; mode: string;
};

export function compareWithKey(dayFile: { themes: Theme[]; actions: unknown[]; summary: string[]; mode: string }, key: Key, status = 'done'): Omit<ShadowComparison, 'wroteChecklist'> {
  const recurring = dayFile.themes.filter(t => t.recurring);
  const detected = recurring.map(t => t.theme);
  const missed = key.expected.filter(e => !detected.includes(e.theme)).map(e => e.theme);
  // 정답지 밖의 반복 주제는 전부 오탐이다(목록에 적은 것만 보지 않는다).
  const expected = new Set(key.expected.map(e => e.theme));
  const falsePositives = [...new Set([...detected.filter(t => !expected.has(t)), ...(key.notRecurring ?? []).filter(t => detected.includes(t))])];
  const reBrokeMismatch = key.expected.filter(e => e.reBrokeAfterGreen !== undefined
    && recurring.find(t => t.theme === e.theme)?.reBrokeAfterGreen !== e.reBrokeAfterGreen).map(e => e.theme);
  const firstRank = recurring.sort((a, b) => a.rank - b.rank)[0]?.theme ?? null;
  // «초록 뒤 재발»이 정답지에 있으면 그것이 1순위여야 한다(RFC §1 recur).
  const mustLead = key.expected.find(e => e.reBrokeAfterGreen)?.theme;
  const ok = status === 'done' && !missed.length && !falsePositives.length && !reBrokeMismatch.length
    && (!mustLead || firstRank === mustLead) && dayFile.actions.length <= 3 && dayFile.summary.length === 3;
  return { ok, status, day: key.day, detected, missed, falsePositives, reBrokeMismatch, firstRank, actions: dayFile.actions.length, summary: dayFile.summary, mode: dayFile.mode };
}

export async function runShadowComparison(factsFile = DEFAULT_FACTS, keyFile = DEFAULT_KEY): Promise<ShadowComparison> {
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as Key;
  const root = mkdtempSync(join(tmpdir(), 'retro-shadow-'));
  try {
    const run = await runGraph(RETRO_DAILY_GRAPH, { input: { factsFile: resolve(factsFile), day: key.day, greenCells: key.greenCells ?? [], mode: 'shadow' }, deps: { root } });
    if (run.status !== 'done') return { ok: false, status: run.status, day: key.day, detected: [], missed: key.expected.map(e => e.theme), falsePositives: [], reBrokeMismatch: [], firstRank: null, actions: 0, summary: [], wroteChecklist: false, mode: 'shadow' };
    const dayFile = JSON.parse(readFileSync(retroDayFile(root, key.day), 'utf8'));
    const act = run.nodes.find(n => n.nodeId === 'act');
    const wroteChecklist = typeof act?.output === 'string' && /"wroteChecklist":true/.test(act.output);
    const result = compareWithKey(dayFile, key, run.status);
    return { ...result, ok: result.ok && !wroteChecklist && dayFile.mode === 'shadow', wroteChecklist };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const result = await runShadowComparison(flag('--facts'), flag('--key'));
  console.log(args.includes('--json') ? JSON.stringify(result) : [
    `retro-daily 그림자 대조 ${result.ok ? 'OK' : 'MISS'} · ${result.day} · status=${result.status} · mode=${result.mode}`,
    `잡음: ${result.detected.join(', ') || '없음'}`,
    `놓침: ${result.missed.join(', ') || '없음'} · 오탐: ${result.falsePositives.join(', ') || '없음'} · 초록뒤재발 불일치: ${result.reBrokeMismatch.join(', ') || '없음'}`,
    `1순위: ${result.firstRank ?? '없음'} · 조치 초안 ${result.actions} · 체크리스트 쓰기 ${result.wroteChecklist}`,
    ...result.summary.map(line => `  ${line}`),
  ].join('\n'));
  if (!result.ok) process.exitCode = 1;
}
