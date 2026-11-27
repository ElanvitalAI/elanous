// #126458 P0 SIM-WORLD-REGISTRY-NO-SHARED-EDIT — 발견식 조각 로더 시험.
// 실패 먼저: 로더가 없는 pre-fix 트리에서는 이 파일의 import 자체가 죽는다(RED).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSimWorldExpectTable } from './expect-load.js';

const realWorlds = join(import.meta.dir, '../worlds');
const redRow = { expect: 'red', reason: 'r', redReason: 'x' } as const;

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'expect-load-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('#126458 실제 worlds 조각 발견 · 전 접두사 커버(행 수 고정 없음 — 11-27 충돌 원천 제거)(els-remote·member-journey·machine-infra·fed-org·supervisors·llm-route 포함)', () => {
  const table = readSimWorldExpectTable(join(realWorlds, 'sim-world-expect.json'));
  for (const prefix of ['alloc-budget', 'capsule-events', 'els', 'els-remote', 'fed-org', 'graph', 'llm-route', 'machine-infra', 'member-journey', 'memory', 'op-channel', 'router-cost', 'seat-mail-roundtrip', 'smart-merge', 'supervisors', 'toolbatch', 'worker']) {
    expect(Object.keys(table.entries).some((key) => key.startsWith(`${prefix}/`))).toBe(true);
  }
});

test('#126458 두 조각이 같은 키를 주장 → 로드 실패(공용 키 중복이 러드로 잡힌다)', () => {
  const root = scratch();
  mkdirSync(join(root, 'expect'));
  writeFileSync(join(root, 'expect', 'memory.json'), JSON.stringify({ schema: 1, entries: { 'memory/D01': redRow } }));
  writeFileSync(join(root, 'expect', 'worker.json'), JSON.stringify({ schema: 1, entries: { 'memory/D01': redRow } }));
  expect(() => readSimWorldExpectTable(join(root, 'sim-world-expect.json'))).toThrow(/duplicated/u);
});

test('#126458 조각 파일명 ≠ 내부 접두사 → 로드 실패(월드별 조각 규약)', () => {
  const root = scratch();
  mkdirSync(join(root, 'expect'));
  writeFileSync(join(root, 'expect', 'a.json'), JSON.stringify({ schema: 1, entries: { 'graph/SB1': redRow } }));
  expect(() => readSimWorldExpectTable(join(root, 'sim-world-expect.json'))).toThrow(/foreign/u);
});

test('#126458 레거시 단일 파일 잔존 시 그 파일이 원천(kernel.test fixture 호환)', () => {
  const root = scratch();
  writeFileSync(join(root, 'sim-world-expect.json'), JSON.stringify({ schema: 1, entries: { 'memory/K01': redRow } }));
  expect(readSimWorldExpectTable(join(root, 'sim-world-expect.json')).entries['memory/K01']).toEqual(redRow);
});

test('#126458 테이블 부재(파일도 조각도 없음) → 러드 실패, 조용한 빈표 아님', () => {
  const root = scratch();
  expect(() => readSimWorldExpectTable(join(root, 'sim-world-expect.json'))).toThrow(/not found/u);
});
