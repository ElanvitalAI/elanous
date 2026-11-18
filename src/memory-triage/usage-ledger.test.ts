// MEMORY-TRIAGE-NO-LLM 문 ③ 생산자(PR-a) — 쓰임 원장 «덧붙임»만. 무결성은 보장하지 않는다(OP 5라운드 판정).
// 가짜 시계·임시 폴더만(실제 기억 뿌리·네트워크 0). 기대값은 제품 상수·함수로 만들지 않은 독립 리터럴이다(규칙 11):
//   원장 폴더 이름 '.triage-usage' · 참조 해시는 FNV-1a 두 seed 를 따로 계산한 값(예: 'a' → m:e40c292c85030ff6).
import { afterEach, describe, expect, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildMemoryInjection, memoryRoot, rebuildIndex, recordMemoryTurnUsage } from '../memory.js';
import { recallSeatMemoriesForTurn, resetSeatMemoryRecallForTest } from '../seat-memory/seat-memory.js';
import { dispatchSeatMemoryTool } from '../seat-memory/seat-memory-tools.js';
import { registerMemoryCommands } from '../cli/memory-cli.js';
import { runLinearSecretaryRequest } from '../intake-plane/linear-secretary-runtime.js';
import { recordMemoryUsage, type MemoryUsageFs } from './usage-ledger.js';

const dirs: string[] = [];
afterEach(() => {
  resetSeatMemoryRecallForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tc-mlg-usage-')); dirs.push(d); return d; };
const LEDGER = '.triage-usage';
const lines = (root: string): Array<Record<string, unknown>> => {
  const dir = join(root, LEDGER);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()
    .flatMap(n => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>));
};
const rawLedger = (root: string): string => {
  const dir = join(root, LEDGER);
  return existsSync(dir) ? readdirSync(dir).map(n => readFileSync(join(dir, n), 'utf8')).join('\n') : '';
};

// 독립 리터럴 — 정규화(소문자·공백 접기) 뒤 FNV-1a(seed 0x811c9dc5) ⊕ FNV-1a(seed 0x01000193) 를 8 hex 씩.
const REF = {
  landingRule: 'm:024e82980cb62046', // 'landing-rule.md'
  prLandOnly: 'm:5620e0f363b76a99', // 'pr-land-only.md'
  g1: 'm:d123dc233e2253a9', // '11111111-1111-4111-8111-111111111111'
  g2: 'm:773010a1e0b1c817', // '22222222-2222-4222-8222-222222222222'
  g3: 'm:ca72ec6bd798a4c1', // '33333333-3333-4333-8333-333333333333'
  a: 'm:e40c292c85030ff6', // 'a'
};

function globalMemory(root: string, id: string, name: string, body: string, pinned = false): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${id}-${name}.md`), ['---', `name: ${name}`, `description: ${name} 설명`, 'type: feedback',
    'created: 2026-10-01T00:00:00.000Z', 'updated: 2026-10-01T00:00:00.000Z', ...(pinned ? ['pinned: true'] : []), '---', '', body, ''].join('\n'));
}

describe('덧붙임 — 시도마다 한 줄 · 문면 0', () => {
  test('시도 한 번 = 한 줄(빈 시도 포함) · 하루 파일은 UTC 날짜 이름 · 참조만 남고 id·이름·본문은 없다', () => {
    const root = tmp();
    expect(recordMemoryUsage({ store: 'seat', seat: 'tc', via: 'turn', usedIds: ['landing-rule.md'] }, root, { now: new Date('2026-11-03T15:00:00.000Z') })).toBe(true);
    expect(recordMemoryUsage({ store: 'seat', seat: 'TC', via: 'search' }, root, { now: new Date('2026-11-16T09:00:00.000Z') })).toBe(true);
    expect(readdirSync(join(root, LEDGER)).sort()).toEqual(['2026-11-03.jsonl', '2026-11-16.jsonl']);
    expect(lines(root)).toEqual([
      { v: 1, at: '2026-11-03T15:00:00.000Z', store: 'seat', seat: 'TC', via: 'turn', injected: [], used: [REF.landingRule] },
      { v: 1, at: '2026-11-16T09:00:00.000Z', store: 'seat', seat: 'TC', via: 'search', injected: [], used: [] },
    ]);
    expect(rawLedger(root)).not.toContain('landing');
  });

  test('전역 · 고정 주입(injected)과 쓰임(used) — 같은 id 가 둘 다면 used 만', () => {
    const root = tmp();
    recordMemoryUsage({ store: 'global', seat: 'TC', via: 'turn', injectedIds: ['a', '11111111-1111-4111-8111-111111111111'], usedIds: ['a'] }, root,
      { now: new Date('2026-11-16T09:00:00.000Z') });
    expect(lines(root)).toEqual([{ v: 1, at: '2026-11-16T09:00:00.000Z', store: 'global', seat: null, via: 'turn', injected: [REF.g1], used: [REF.a] }]);
  });

  test('자리 id 가 틀리면 거부 사건 · 덧붙임 0', () => {
    const root = tmp();
    const events: string[] = [];
    expect(recordMemoryUsage({ store: 'seat', seat: '../x', via: 'turn' }, root, { log: (_c, e) => { events.push(e); } })).toBe(false);
    expect(events).toEqual(['usage-record-refused']);
    expect(existsSync(join(root, LEDGER))).toBe(false);
  });

  test('덧붙이기 실패는 던지지 않는다 — false ⊕ usage-record-failed 사건(본문 0)', () => {
    const root = tmp();
    const events: Array<[string, string, Record<string, unknown>]> = [];
    const fs: MemoryUsageFs = { ...nodeFs, appendFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
    let result: boolean | undefined;
    expect(() => { result = recordMemoryUsage({ store: 'global', via: 'turn', usedIds: ['secret-id'] }, root,
      { now: new Date('2026-11-16T09:00:00.000Z'), fs, log: (c, e, d) => { events.push([c, e, d]); } }); }).not.toThrow();
    expect(result).toBe(false);
    expect(events).toEqual([['memory.lifetime', 'usage-record-failed', { store: 'global', seat: null, via: 'turn', day: '2026-11-16', cause: 'ENOSPC' }]]);
    expect(lines(root)).toEqual([]);
  });
});

describe('운영 호출부마다 덧붙인다', () => {
  test('전역 턴 주입(recordMemoryTurnUsage): 글과 맞은 줄 ⊕ 맞은 고정 줄 = used · 안 맞은 고정 줄 = injected', () => {
    const root = tmp();
    globalMemory(root, '11111111-1111-4111-8111-111111111111', 'deploy-pinned', '배포 전에는 deploy 체크리스트를 본다', true);
    globalMemory(root, '22222222-2222-4222-8222-222222222222', 'quiet-pinned', '조용한 고정 기억', true);
    globalMemory(root, '33333333-3333-4333-8333-333333333333', 'deploy-checklist', 'deploy checklist 순서');
    rebuildIndex(root);
    const text = 'deploy checklist 어떻게 해?';
    recordMemoryTurnUsage(text, buildMemoryInjection(text, {}, root), root);
    const got = lines(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ store: 'global', seat: null, via: 'turn', injected: [REF.g2] });
    expect((got[0]!.used as string[]).sort()).toEqual([REF.g1, REF.g3].sort());
    expect(rawLedger(root)).not.toContain('deploy');
  });

  test('전역 턴 주입이 비어도(기억 0) 한 줄', () => {
    const root = tmp();
    recordMemoryTurnUsage('아무 글', { block: '', tokens: 0, injectedIds: [] }, root);
    expect(lines(root)).toMatchObject([{ store: 'global', via: 'turn', injected: [], used: [] }]);
  });

  test('자리 턴 회상 · memory_search 도구 — 자리 원장(기억 뿌리)에 · 빈 회상도 한 줄', async () => {
    const root = tmp();
    const dir = join(root, 'seats', 'TC');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pr-land-only.md'), '---\nname: pr-land-only\ndescription: 착지는 pr land 하나로\ntype: feedback\n---\n\n착지는 pr land 하나로만 한다\n');
    recallSeatMemoriesForTurn({ seat: 'TC', dir, text: '착지 pr land 어떻게 하지' });
    recallSeatMemoriesForTurn({ seat: 'TC', dir, text: '전혀 상관없는 날씨 이야기' });
    await dispatchSeatMemoryTool('memory_search', { query: 'pr land 착지' }, { seat: 'TC', dir });
    const got = lines(root);
    expect(got.map(l => [l.store, l.seat, l.via, l.used])).toEqual([
      ['seat', 'TC', 'turn', [REF.prLandOnly]],
      ['seat', 'TC', 'turn', []],
      ['seat', 'TC', 'search', [REF.prLandOnly]],
    ]);
    expect(rawLedger(root)).not.toContain('착지');
  });

  test('`elanous memory search` CLI — 기억 뿌리(격리 우주)에 search 한 줄', async () => {
    const before = lines(memoryRoot()).filter(l => l.via === 'search' && l.store === 'global').length;
    const program = new Command();
    program.exitOverride();
    registerMemoryCommands(program);
    const log = console.log;
    console.log = () => {};
    try { await program.parseAsync(['node', 'elanous', 'memory', 'search', 'zzq-nothing-matches']); }
    finally { console.log = log; }
    const after = lines(memoryRoot()).filter(l => l.via === 'search' && l.store === 'global');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ used: [], injected: [] });
  });

  test('Linear 비서 근거 수집 — 기억 검색 시도마다 search 한 줄(근거 0 이면 등록은 보류되지만 시도는 남는다)', async () => {
    const repo = tmp();
    // 저장소 근거 검색(rg … src docs)이 도는 빈 저장소 — 폴더가 없으면 rg 가 실패한다.
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'docs'));
    const before = lines(memoryRoot()).filter(l => l.via === 'search' && l.store === 'global').length;
    await expect(runLinearSecretaryRequest('zzq-nothing-matches 2026-12-01 까지', {
      getApiKey: async () => 'test-key',
      getProject: () => 'test project',
      repositoryRoot: repo,
      fetch: Object.assign(async () => { throw new Error('Linear network access should not run'); }, { preconnect: globalThis.fetch.preconnect }),
    })).rejects.toThrow('근거가 없어');
    const after = lines(memoryRoot()).filter(l => l.via === 'search' && l.store === 'global');
    expect(after.length).toBe(before + 1);
  });
});
