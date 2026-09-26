import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ResourceView } from '../control-plane/ledger.js';
import { rankMachines } from './load-balance.js';

const NOW = 1_000_000;

function machine(name: string, options: {
  age?: number; ttlMs?: number; expired?: boolean; capabilities?: string[];
  load?: Record<string, unknown> | null; kind?: ResourceView['kind'];
} = {}): ResourceView {
  const age = options.age ?? 1_000;
  return {
    id: name, kind: options.kind ?? 'machine', machine: name, name, owner: 'owner',
    attrs: {
      capabilities: options.capabilities ?? [],
      ...(options.load === null ? {} : { load: options.load ?? {
        loadAvg: [1], cpuCount: 2, freeMem: 50, totalMem: 100, observedAt: NOW - age,
      } }),
    },
    observedAt: NOW - age, ttlMs: options.ttlMs ?? 600_000, ageMs: age, expired: options.expired ?? false,
  };
}

test('한 기계만 살아 있거나 만료·10분 전 기계가 섞이면 skipped (기계 N대)', () => {
  const one = machine('one');
  for (const machines of [
    [one], [one, machine('old', { age: 600_000 })],
    [one, machine('expired', { expired: true })],
    [one, machine('ttl', { age: 20_000, ttlMs: 10_000 })],
    [one, machine('instance', { kind: 'instance' })],
  ]) {
    expect(rankMachines({ machines, required: [], nowMs: NOW })).toEqual({
      outcome: 'skipped', candidates: [], reasons: ['기계 1대'],
    });
  }
  expect(rankMachines({ machines: [], required: [], nowMs: NOW }).reasons).toEqual(['기계 0대']);
  expect(rankMachines({ machines: [one, machine('two', { age: 200_000 })], required: [], nowMs: NOW, staleMs: 240_000 }).outcome).toBe('ranked');
});

test('두 기계면 loadAvg[0]/cpuCount 오름차순으로 ranked', () => {
  const result = rankMachines({ machines: [
    machine('half', { load: { loadAvg: [2], cpuCount: 4, freeMem: 50, totalMem: 100 } }),
    machine('tenth', { load: { loadAvg: [0.4], cpuCount: 4, freeMem: 25, totalMem: 100 } }),
  ], required: [], nowMs: NOW });
  expect(result.outcome).toBe('ranked');
  expect(result.candidates.map((candidate) => candidate.machine)).toEqual(['tenth', 'half']);
  expect(result.candidates.map((candidate) => candidate.score)).toEqual([0.1, 0.5]);
});

test('required 능력을 모두 못 갖춘 기계는 제외하고 이유에 기계와 누락 능력을 남긴다', () => {
  const result = rankMachines({ machines: [
    machine('without'), machine('with', { capabilities: ['xcode'] }),
  ], required: ['xcode'], nowMs: NOW });
  expect(result.outcome).toBe('ranked');
  expect(result.candidates.map((candidate) => candidate.machine)).toEqual(['with']);
  expect(result.reasons.join(' ')).toContain('without');
  expect(result.reasons.join(' ')).toContain('xcode');
});

test('동점은 메모리 여유 비율 내림차순이고 없는 부하는 0이 아닌 마지막 자리', () => {
  const result = rankMachines({ machines: [
    machine('missing', { load: null }),
    machine('less-memory', { load: { loadAvg: [1], cpuCount: 2, freeMem: 20, totalMem: 100 } }),
    machine('more-memory', { load: { loadAvg: [1], cpuCount: 2, freeMem: 80, totalMem: 100 } }),
  ], required: [], nowMs: NOW });
  expect(result.candidates.map((candidate) => candidate.machine)).toEqual(['more-memory', 'less-memory', 'missing']);
  expect(result.candidates[0]?.freeMemRatio).toBe(0.8);
  expect(result.candidates[2]?.loadPerCpu).toBeNull();
  expect(result.candidates[2]?.score).toBeNull();
});

test('부하가 둘 다 없거나 메모리 비율이 하나만 없을 때도 유효한 메모리를 우선한다', () => {
  const result = rankMachines({ machines: [
    machine('no-load-no-mem', { load: null }),
    machine('no-load-with-mem', { load: { freeMem: 80, totalMem: 100 } }),
    machine('load-no-mem', { load: { loadAvg: [1], cpuCount: 2 } }),
    machine('load-with-mem', { load: { loadAvg: [1], cpuCount: 2, freeMem: 10, totalMem: 100 } }),
  ], required: [], nowMs: NOW });
  expect(result.candidates.map((candidate) => candidate.machine)).toEqual([
    'load-with-mem', 'load-no-mem', 'no-load-with-mem', 'no-load-no-mem',
  ]);
});

test('낡은 부하 관측이나 유효하지 않은 cpuCount도 부하 없음으로 뒤에 둔다', () => {
  const result = rankMachines({ machines: [
    machine('old-load', { load: { loadAvg: [0], cpuCount: 2, observedAt: NOW - 600_000 } }),
    machine('bad-cpu', { load: { loadAvg: [0], cpuCount: 0 } }),
    machine('measured', { load: { loadAvg: [2], cpuCount: 2 } }),
  ], required: [], nowMs: NOW });
  expect(result.candidates[0]?.machine).toBe('measured');
  expect(result.candidates.slice(1).every((candidate) => candidate.score === null)).toBe(true);
});

test('순수 판정은 파일·네트워크·프로세스를 직접 부르지 않는다', () => {
  const source = readFileSync(new URL('./load-balance.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"]node:/);
  expect(source).not.toMatch(/\b(readFileSync|writeFileSync|Bun\.file|Bun\.spawn|fetch|child_process|process\.)\b/);
});
