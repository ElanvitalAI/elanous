// JUD-C HOLD judb-39558-73dd8d11f3ed(OP #129161) — 200토큰 초과 단일 결정 행·OPS 규칙 줄 «내용 보존 분할» 회귀.
// ① 상한 초과 단일 행·줄도 문자 클립·«첫 줄 무조건 수용» 없이 조각마다 기억 1개(래퍼 포함 ≤200토큰 · 출처 줄·순번 표기).
// ② 조각을 이어 붙이면 원문 복원(내용 소실 0). ③ 분할 조각 전체가 기본 턴 회상 예산(1500토큰) 안에 실린다(스킵 0).
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { estimateTokens } from '../tokens.js';
import {
  listSeatMemories, recallSeatMemoriesForTurn, resetSeatMemoryRecallForTest,
} from './seat-memory.js';
import { applyOpMemorySeed, planOpMemorySeed } from './op-memory-seed.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), `op-frag-${prefix}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

beforeEach(() => {
  resetSeatMemoryRecallForTest();
  spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
});

/** OPS 분할 조각 줄 표지 — `… 〔출처 줄 5 · 조각 2/3〕`. */
const OPS_FRAG_MARK = / 〔출처 줄 (\d+) · 조각 (\d+)\/(\d+)〕$/;

/** 결정 조각 기억 본문 → 출처 줄·순번·원문 조각(마커 없으면 null — 미분할 행). */
const decisionPiece = (body: string): { no: number; i: number; n: number; text: string } | null => {
  const head = /^사실: OP 결정 원장 (?:최신 )?행 원문 — 출처 줄 (\d+) · 조각 (\d+)\/(\d+)\./m.exec(body);
  const piece = /\n\n- ([\s\S]*?)\n\n출처: seat-state\/OP\/DECISIONS-OP\.tsv/.exec(body);
  if (!head || !piece) return null;
  return { no: Number(head[1]), i: Number(head[2]), n: Number(head[3]), text: piece[1]! };
};

const seedDecisionsOnly = (root: string, row: string): string => {
  const decisions = join(root, 'DECISIONS-OP.tsv');
  writeFileSync(decisions, `${row}\n`);
  const to = join(root, 'seats', 'OP');
  applyOpMemorySeed(planOpMemorySeed({
    claudeDir: join(root, '없는-claude'), opsRulesPath: join(root, '없는-OPS-RULES.md'),
    decisionsPath: decisions, allowedSourceRoots: [root], to, seat: 'OP',
  }));
  return to;
};

describe('JUD-C judb-39558-73dd8d11f3ed — 상한 초과 단일 결정 행 내용 보존 분할', () => {
  test('A. 900자+ 단일 결정 행 → 조각마다 기억 1개(래퍼 포함 ≤200토큰) · 순번 연속 · 이어 붙이면 원문 복원 · 문자 클립 0', () => {
    const root = temp('dec');
    const row = `2026-11-22T23:59+0900\tOP\tFRAGMARK 결정 — 상한 초과 단일 행 원문 보존 회귀 ${'보'.repeat(900)}`;
    const to = seedDecisionsOnly(root, row);
    const entries = listSeatMemories(to).filter(e => e.name.startsWith('op-decision-'));
    // (1) 분할 조각 기억이 3개 이상(단일 통짜 기억 아님) — 전 조각 출처 줄·순번 마커 보유
    const pieces = entries.filter(e => e.name !== 'op-decision-latest')
      .map(e => ({ name: e.name, body: e.body, m: decisionPiece(e.body) }));
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) expect(p.m).not.toBeNull();
    // (2) 순번 1..n 연속 · n 일치 · 전 기억 래퍼 포함 상한(200토큰) · 문자 클립 마커 0
    const n = pieces[0]!.m!.n;
    const sorted = [...pieces].sort((a, b) => a.m!.i - b.m!.i);
    expect(sorted.map(p => p.m!.i)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
    for (const p of sorted) {
      expect(p.m!.n).toBe(n);
      expect(p.m!.no).toBe(1); // 출처 줄 = 원장 1줄
      expect(estimateTokens(p.body)).toBeLessThanOrEqual(200);
      expect(p.body).not.toContain('문자 클립');
    }
    // (3) 조각을 이어 붙이면 원문 복원(내용 소실 0)
    expect(sorted.map(p => p.m!.text).join('')).toBe(row);
    // (4) 최신 고정 기억도 상한 이하 · 조각 표기
    const latest = entries.find(e => e.name === 'op-decision-latest')!;
    expect(estimateTokens(latest.body)).toBeLessThanOrEqual(200);
    expect(latest.body).toContain('조각 1/');
  });

  test('C-1. 분할 결정 조각 전체가 관련 질의에 기본 예산(1500토큰) 턴 회상에 모두 실린다(스킵 0)', () => {
    const root = temp('dec-recall');
    const row = `2026-11-22T23:59+0900\tOP\tFRAGMARK 결정 — 상한 초과 단일 행 원문 보존 회귀 ${'보'.repeat(900)}`;
    const to = seedDecisionsOnly(root, row);
    const entries = listSeatMemories(to).filter(e => e.name.startsWith('op-decision-'));
    const fragEntries = entries.filter(e => e.name !== 'op-decision-latest' && decisionPiece(e.body) !== null);
    expect(fragEntries.length).toBeGreaterThanOrEqual(3); // 현재 결함: 문자 클립으로 마커 조각 0
    const sorted = [...fragEntries].sort((a, b) => decisionPiece(a.body)!.i - decisionPiece(b.body)!.i);
    const tail = decisionPiece(sorted[sorted.length - 1]!.body)!.text;
    const recall = recallSeatMemoriesForTurn({ seat: 'OP', dir: to, text: 'FRAGMARK 결정 원문 조각 회상해 줘', sessionKey: 'frag-c1' })!;
    // 분할 조각 전부(n개)가 회상 명단에 — used+tok>maxTokens 통째로 스킵 0
    for (const e of sorted) expect(recall.names).toContain(e.name);
    // 마지막 조각(=원문 꼬리)이 블록에 실제 포함 + 조각 순번 표기 + 블록 전체가 기본 예산 이하
    expect(recall.block).toContain(tail.slice(0, 12));
    expect(recall.block).toContain(`조각 ${sorted.length}/${sorted.length}`);
    expect(estimateTokens(recall.block)).toBeLessThanOrEqual(1500);
  });
});

describe('JUD-C judb-39558-73dd8d11f3ed — 상한 초과 단일 OPS 규칙 줄 내용 보존 분할', () => {
  const longLine = (fill: string): string => `- OPSFRAG 규칙 — 상한 초과 단일 규칙 줄 원문 보존 회귀 ${fill}`;

  const seedOpsOnly = (root: string, line: string): string => {
    const opsRules = join(root, 'OPS-RULES.md');
    writeFileSync(opsRules, ['# 본부 운영 지침', '', '## 긴 규칙 섹션', '', line, ''].join('\n'));
    const to = join(root, 'seats', 'OP');
    applyOpMemorySeed(planOpMemorySeed({
      claudeDir: join(root, '없는-claude'), opsRulesPath: opsRules,
      decisionsPath: join(root, '없는-DECISIONS-OP.tsv'), allowedSourceRoots: [root], to, seat: 'OP',
    }));
    return to;
  };

  test('B. 600자+ 단일 OPS 규칙 줄 → 조각마다 기억 1개 · 출처 줄(원본 5줄)·순번 표기 · 원문 복원 · 상한 보장', () => {
    const root = temp('ops');
    const line = longLine('규'.repeat(600));
    const to = seedOpsOnly(root, line);
    const entries = listSeatMemories(to).filter(e => e.name.startsWith('ops-rule-'));
    expect(entries.length).toBeGreaterThanOrEqual(2); // 단일 통짜 기억이 아니다
    const frags: Array<{ no: number; i: number; n: number; text: string; body: string }> = [];
    for (const e of entries) {
      expect(estimateTokens(e.body)).toBeLessThanOrEqual(200); // 래퍼 포함 상한
      expect(e.body).not.toContain('문자 클립');
      for (const bodyLine of e.body.split('\n')) {
        const m = OPS_FRAG_MARK.exec(bodyLine);
        if (m) frags.push({ no: Number(m[1]), i: Number(m[2]), n: Number(m[3]), text: bodyLine.replace(OPS_FRAG_MARK, ''), body: e.body });
      }
    }
    expect(frags.length).toBeGreaterThanOrEqual(2);
    const n = frags[0]!.n;
    const sorted = [...frags].sort((a, b) => a.i - b.i);
    expect(sorted.map(f => f.i)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
    for (const f of sorted) { expect(f.no).toBe(5); expect(f.n).toBe(n); } // 출처 줄 = OPS-RULES.md 5번 줄
    expect(sorted.map(f => f.text).join('')).toBe(line); // 이어 붙이면 원문 복원
    for (const f of sorted) expect(f.body).toContain('긴 규칙 섹션'); // 섹션 제목 표기
  });

  test('C-2. 분할 OPS 조각 전체가 관련 질의에 기본 예산(1500토큰) 턴 회상에 모두 실린다(스킵 0)', () => {
    const root = temp('ops-recall');
    const line = longLine('규'.repeat(600));
    const to = seedOpsOnly(root, line);
    const entries = listSeatMemories(to).filter(e => e.name.startsWith('ops-rule-'));
    const fragEntries = entries.filter(e => e.body.split('\n').some(l => OPS_FRAG_MARK.test(l)));
    expect(fragEntries.length).toBeGreaterThanOrEqual(2); // 현재 결함: 통짜 기억이라 마커 조각 0
    const lastFrag = fragEntries.map(e => ({ e, m: Number(OPS_FRAG_MARK.exec(e.body.split('\n').find(l => OPS_FRAG_MARK.test(l))!)![2]) }))
      .sort((a, b) => b.m - a.m)[0]!;
    const recall = recallSeatMemoriesForTurn({ seat: 'OP', dir: to, text: 'OPSFRAG 규칙 원문 조각 회상해 줘', sessionKey: 'frag-c2' })!;
    for (const e of fragEntries) expect(recall.names).toContain(e.name);
    expect(recall.block).toContain(`조각 ${lastFrag.m}/${lastFrag.m}`);
    expect(recall.block).toContain('OPSFRAG');
    expect(estimateTokens(recall.block)).toBeLessThanOrEqual(1500);
  });
});
