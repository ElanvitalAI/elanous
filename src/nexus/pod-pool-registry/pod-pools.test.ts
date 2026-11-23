import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePodPool } from '../../task-orchestrator/surfaces/pod-pool.js';
import {
  PodPoolsReadError,
  assignablePodPools,
  podPoolsPath,
  readPodPools,
  readPodPoolsStrict,
  resolvePodPool,
  reusePolicyFor,
  toPodPoolMember,
  toPodPoolSpec,
  writePodPoolsAtomic,
} from './pod-pools.js';
import type { PodPoolsFile } from './types.js';

const FIXTURE = {
  version: 1,
  pools: {
    'node-b-pool': {
      context: 'k3d-elanous-node-b', host: 'node-b', capacity: 12, state: 'available', // 출처: #39743 FIXTURE node-b 풀 상한
      federationRole: 'task', registry: 'k3d-elanous-registry:5051',
      aliases: ['primary'], reuse: { policy: 'warm-worker', maxIdleMs: 3_600_000 }, // 출처: #39743 FIXTURE warm-worker 재사용 상한
    },
    'node-c-pool': { context: 'k3d-elanous-node-c', host: 'node-c', capacity: 2, state: 'available' }, // 출처: #39743 FIXTURE node-c 풀 상한
    'mbp-pool': { context: 'k3d-elanous-mbp', capacity: 0, state: 'available' }, // 출처: #39743 FIXTURE mbp 풀 상한(0 = off 경계)
    'drain-pool': { context: 'k3d-elanous-drain', host: 'node-c', capacity: 4, state: 'draining' }, // 출처: #39743 FIXTURE drain 풀 상한(draining 경계)
  },
} as unknown as PodPoolsFile;

function withTempFile(_body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'podreg-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  const path = join(dir, 'sub', 'pod-pools.json');
  return { dir, path };
}

test('readPodPoolsStrict: 정본 파일 → 풀 맵(파일 등록 순 보존 · null-prototype own key)', () => {
  const { dir, path } = withTempFile('');
  try {
    writeFileSync(path, JSON.stringify(FIXTURE));
    const file = readPodPoolsStrict(path)!;
    expect(file.version).toBe(1);
    expect(Object.keys(file.pools)).toEqual(['node-b-pool', 'node-c-pool', 'mbp-pool', 'drain-pool']); // 출처: #39743 JUD-C judb-39743 필수① 파일 등록 순 보존
    expect(file.pools['node-b-pool']!).toMatchObject({
      context: 'k3d-elanous-node-b', host: 'node-b', capacity: 12, state: 'available', // 출처: #39743 FIXTURE 정본 읽기 회귀(위 FIXTURE와 동일값)
      federationRole: 'task', registry: 'k3d-elanous-registry:5051',
    });
    // null-prototype map: a pool named __proto__ stays an ordinary own key.
    // (Raw JSON: an object-literal `__proto__:` would set the prototype, not an own key.)
    writeFileSync(path, '{"version":1,"pools":{"__proto__":{"context":"k3d-x","capacity":1,"state":"available"}}}')
    const protoFile = readPodPoolsStrict(path)!;
    expect(Object.keys(protoFile.pools)).toEqual(['__proto__']);
    expect(protoFile.pools['__proto__']!.context).toBe('k3d-x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readPodPoolsStrict: 역순 키 등록 → 사전순 아닌 등록 순 그대로 · spec 전파도 등록 순', () => {
  const { dir, path } = withTempFile('');
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      pools: {
        'z-pool': { context: 'k3d-z', capacity: 3, state: 'available' }, // 출처: #39743 JUD-C 필수① 역순 등록 z
        'm-pool': { context: 'k3d-m', capacity: 2, state: 'available' }, // 출처: #39743 JUD-C 필수① 역순 등록 m
        'a-pool': { context: 'k3d-a', capacity: 5, state: 'available' }, // 출처: #39743 JUD-C 필수① 역순 등록 a
      },
    }));
    const file = readPodPoolsStrict(path)!;
    expect(Object.keys(file.pools)).toEqual(['z-pool', 'm-pool', 'a-pool']); // 출처: #39743 JUD-C 필수① 역순 키 회귀
    expect(toPodPoolSpec(file)).toBe('k3d-z:3,k3d-m:2,k3d-a:5'); // 출처: #39743 JUD-C 필수① spec 등록 순 전파
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('부재(ENOENT) → undefined (strict · display)', () => {
  const { dir, path } = withTempFile('');
  try {
    expect(readPodPoolsStrict(path)).toBeUndefined();
    expect(readPodPools(path)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('위반(version · 모양 · 항목 capacity/state) → PodPoolsReadError, 항목 키 명시', () => {
  const { dir, path } = withTempFile('');
  try {
    writeFileSync(path, '{bad');
    expect(() => readPodPoolsStrict(path)).toThrow(PodPoolsReadError);
    writeFileSync(path, JSON.stringify({ version: 2, pools: {} }));
    expect(() => readPodPoolsStrict(path)).toThrow(PodPoolsReadError);
    writeFileSync(path, JSON.stringify({ version: 1, pools: [] }));
    expect(() => readPodPoolsStrict(path)).toThrow(PodPoolsReadError);
    writeFileSync(path, JSON.stringify({
      version: 1,
      pools: { good: { context: 'k3d-a', capacity: 1, state: 'available' }, bad: { context: 'k3d-b', capacity: -1, state: 'available' } }, // 출처: #39743 FIXTURE 항목 위반 경계(capacity -1)
    }));
    expect(() => readPodPoolsStrict(path)).toThrow(/bad/);
    writeFileSync(path, JSON.stringify({
      version: 1,
      pools: { bad: { context: 'k3d-b', capacity: 1, state: 'somewhere' } }, // 출처: #39743 FIXTURE state 위반 경계
    }));
    expect(() => readPodPoolsStrict(path)).toThrow(/bad/);
    // display read: malformed → undefined (never throws to callers).
    expect(readPodPools(path)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolvePodPool: 이름 → 항목 · 별칭 → 항목 · 미등록 → 명시적 throw', () => {
  const { dir, path } = withTempFile('');
  try {
    writeFileSync(path, JSON.stringify(FIXTURE));
    const file = readPodPoolsStrict(path)!;
    expect(resolvePodPool(file, 'node-b-pool')).toBe(file.pools['node-b-pool']!);
    expect(resolvePodPool(file, 'primary')).toBe(file.pools['node-b-pool']!);
    expect(() => resolvePodPool(file, 'nope')).toThrow(PodPoolsReadError);
    expect(() => resolvePodPool(file, 'nope')).toThrow(/nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('toPodPoolMember: 레지스트리 항목 → 기존 PodPoolMember 정합(k3d 파생 · sshHost · role)', () => {
  const poolA = toPodPoolMember('node-b-pool', FIXTURE.pools['node-b-pool']!);
  expect(poolA).toMatchObject({
    context: 'k3d-elanous-node-b', sshHost: 'node-b', capacity: 12, // 출처: #39743 FIXTURE → 기존 PodPoolMember 정합
    k3dCluster: 'elanous-node-b', federationRole: 'task', registry: 'k3d-elanous-registry:5051',
  });
  const mbp = toPodPoolMember('mbp-pool', FIXTURE.pools['mbp-pool']!);
  expect(mbp).toMatchObject({ context: 'k3d-elanous-mbp', capacity: 0, k3dCluster: 'elanous-mbp' }); // 출처: #39743 FIXTURE mbp 파생(capacity 0)
  expect(mbp.sshHost).toBeUndefined();
  expect(mbp.capacityDefaulted).toBeUndefined();
  const defaulted = toPodPoolMember('x', { context: 'plain', capacity: 2, state: 'available', capacityDefaulted: true }); // 출처: #39743 FIXTURE 기본값 파생
  expect(defaulted.k3dCluster).toBe('elanous-pool');
  expect(defaulted.capacityDefaulted).toBe(true);
});

test('toPodPoolSpec → parsePodPool 왕복: live(available) 멤버 수 · context · sshHost · capacity · registry 일치 · draining 제외', () => {
  const spec = toPodPoolSpec(FIXTURE);
  const members = parsePodPool(spec);
  // capacity 0 off + draining excluded: live available members only, in registration order.
  expect(members.map((m) => m.context)).toEqual(['k3d-elanous-node-b', 'k3d-elanous-node-c']);
  expect(members[0]).toMatchObject({ sshHost: 'node-b', capacity: 12, registry: 'k3d-elanous-registry:5051' }); // 출처: #39743 FIXTURE live 멤버(node-b) 정합
  expect(members[1]).toMatchObject({ sshHost: 'node-c', capacity: 2 }); // 출처: #39743 FIXTURE live 멤버(node-c) 정합
  expect(members.every((m) => m.context !== 'k3d-elanous-drain')).toBe(true); // 출처: #39743 JUD-C 필수② draining spec 제외
  expect(members.every((m) => !m.capacityDefaulted)).toBe(true);
});

test('종단(parsePodPool): 정본 파일 → strict 읽기 → spec → parse → draining·off 제외 live 멤버만 등록 순', () => {
  const { dir, path } = withTempFile('');
  try {
    writeFileSync(path, JSON.stringify(FIXTURE));
    const file = readPodPoolsStrict(path)!;
    const members = parsePodPool(toPodPoolSpec(file)); // 출처: #39743 JUD-C 필수② 종단 경로(읽기→변환→해석)
    expect(members.map((m) => m.context)).toEqual(['k3d-elanous-node-b', 'k3d-elanous-node-c']);
    expect(members.map((m) => m.capacity)).toEqual([12, 2]); // 출처: #39743 JUD-C 필수② 종단 live 용량
    expect(assignablePodPools(file)).toEqual(['node-b-pool', 'node-c-pool']); // 출처: #39743 필수⑤ 정합(draining·off 배정 제외)
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assignablePodPools: draining·capacity 0 제외 · kind 선호(lite 최소 / standard 최대) · 등록 순 · skip', () => {
  const file = FIXTURE;
  expect(assignablePodPools(file)).toEqual(['node-b-pool', 'node-c-pool']);
  expect(assignablePodPools(file, { kind: 'lite' })).toEqual(['node-c-pool', 'node-b-pool']);
  expect(assignablePodPools(file, { kind: 'standard' })).toEqual(['node-b-pool', 'node-c-pool']);
  expect(assignablePodPools(file, { skip: new Set(['node-b-pool']) })).toEqual(['node-c-pool']);
  // every candidate skipped → empty (caller decides: wait or error).
  expect(assignablePodPools(file, { skip: new Set(['node-b-pool', 'node-c-pool']) })).toEqual([]);
});

test('reusePolicyFor: warm-worker → 재사용 허용 + maxIdleMs · per-job/미정 → 거부(fail-safe)', () => {
  const file = FIXTURE;
  expect(reusePolicyFor(file, 'node-b-pool')).toEqual({ reuseWarm: true, maxIdleMs: 3_600_000 }); // 출처: #39743 FIXTURE warm-worker maxIdleMs 정합
  expect(reusePolicyFor(file, 'node-c-pool')).toEqual({ reuseWarm: false, maxIdleMs: undefined });
  expect(() => reusePolicyFor(file, 'nope')).toThrow(PodPoolsReadError);
});

test('writePodPoolsAtomic: 쓰기 → 읽기 왕복 일치 · tmp 잔재 없음 · 기본 경로', () => {
  const { dir, path } = withTempFile('');
  try {
    writePodPoolsAtomic(FIXTURE, path);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['pod-pools.json']);
    const round = readPodPoolsStrict(path)!;
    expect(Object.keys(round.pools)).toEqual(['node-b-pool', 'node-c-pool', 'mbp-pool', 'drain-pool']); // 출처: #39743 JUD-C 필수① 쓰기→읽기 등록 순 왕복
    expect(round.pools['node-b-pool']).toEqual(FIXTURE.pools['node-b-pool']);
    expect(podPoolsPath().endsWith('pod-pools.json')).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});