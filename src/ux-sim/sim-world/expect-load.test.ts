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

test('#126458 실제 worlds 조각 12개 발견 — 88행·전 접두사 커버(els-remote·member-journey·machine-infra 포함)', () => {
  const table = readSimWorldExpectTable(join(realWorlds, 'sim-world-expect.json'));
  expect(Object.keys(table.entries).length).toBe(88); // 출처: #39620 재적층 실측 — main 6997545ad38 단일 표 87행(신규 5행: SEAT-CAPSULE-NO-REPEAT·ROUTER-QUALITY-GUARD-95·RUNSHELL-DEFAULT-OP-30M·RUNSHELL-PR2·E-LIVE-CWD-OSC7) · 1124 main-red drift: #39796 ELN-CAPSULE-COMPLETION-SCOPED가 capsule-events/C9-SESSION-SCOPED 1행 추가 → 88
  for (const prefix of ['capsule-events', 'els', 'els-remote', 'graph', 'machine-infra', 'member-journey', 'memory', 'op-channel', 'router-cost', 'seat-mail-roundtrip', 'toolbatch', 'worker']) {
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
