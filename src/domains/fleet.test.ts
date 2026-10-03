// elanous fleet — 멀티 인스턴스 뷰 + 스토어 경로 도출 테스트.

import { setDefaultTimeout, describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildFleetView, instanceStorePaths, ptyEventLogTargets, ptyManifestTargets } from './fleet.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('fleet CLI displays a remote host without marking it dead and retains JSON identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-remote-'));
  try {
    const home = join(root, 'home');
    const stateDir = join(root, 'remote');
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'remote', stateDir, hostId: '01OTHERHOST', hostname: 'win-box',
      pid: 999_999_999, startedAt: '2026-09-25T00:00:00Z',
    }] }));
    const run = (args: string[]) => spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'fleet', 'list', ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, ELANOUS_HOST_ID: '01THISHOST' }, encoding: 'utf8',
    });
    const text = run([]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('remote@win-box');
    expect(text.stdout.split('\n').find((line) => line.includes('remote@win-box'))).not.toContain('dead');
    const json = run(['--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).find((row: { name: string }) => row.name === 'remote')).toMatchObject({
      hostId: '01OTHERHOST', hostname: 'win-box', liveness: 'remote', alive: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('instanceStorePaths — stateDir → 스토어 정본 경로', () => {
  test('scoped 인스턴스 — surface_events 는 <stateDir>/surface_events.db', () => {
    const p = instanceStorePaths('/tmp/x/.elanous-test');
    expect(p.logs).toBe('/tmp/x/.elanous-test/logs/logs.db');
    expect(p.sessions).toBe('/tmp/x/.elanous-test/sessions/index.json');
    expect(p.tasks).toBe('/tmp/x/.elanous-test/tasks/tasks.db');
    expect(p.memory).toBe('/tmp/x/.elanous-test/surface_events.db');
    expect(p.frame).toBe('/tmp/x/.elanous-test/pty/manifest.db');
    expect(p.events).toBe('/tmp/x/.elanous-test/pty/events.db');
  });
  test('prod(~/.elanous) — memory 는 memory/ 서브(비대칭)', () => {
    const p = instanceStorePaths(join(homedir(), '.elanous'));
    expect(p.memory).toBe(join(homedir(), '.elanous', 'memory', 'surface_events.db'));
  });
  test('opsEvents/schedules/mandate 는 state-dir 평면(elanousStateRoot 직속·서브폴더 없음)', () => {
    const p = instanceStorePaths('/tmp/x/.elanous-test');
    expect(p.opsEvents).toBe('/tmp/x/.elanous-test/ops_events.db');
    expect(p.schedules).toBe('/tmp/x/.elanous-test/schedules.db');
    expect(p.mandate).toBe('/tmp/x/.elanous-test/finance-trade-mandate.json');
  });
  test('opsEvents/schedules/mandate 는 config-dir 무관 — state-dir 스코프(tasks 만 config-dir)', () => {
    const p = instanceStorePaths('/tmp/s/.elanous-test', '/tmp/c/.elanous-test');
    expect(p.opsEvents).toBe('/tmp/s/.elanous-test/ops_events.db');   // state-dir
    expect(p.schedules).toBe('/tmp/s/.elanous-test/schedules.db');    // state-dir
    expect(p.mandate).toBe('/tmp/s/.elanous-test/finance-trade-mandate.json'); // state-dir
    expect(p.tasks).toBe('/tmp/c/.elanous-test/tasks/tasks.db');      // config-dir (대비)
  });
  test('prod opsEvents/schedules/mandate == 기본 경로(무회귀) — state-dir 평면', () => {
    const root = join(homedir(), '.elanous');
    const p = instanceStorePaths(root);
    expect(p.opsEvents).toBe(join(root, 'ops_events.db'));
    expect(p.schedules).toBe(join(root, 'schedules.db'));
    expect(p.mandate).toBe(join(root, 'finance-trade-mandate.json'));
  });
  test('tasks 는 configDir 스코프 — state-dir≠config-dir 이면 config-dir 기반(Class 3 · D1)', () => {
    const p = instanceStorePaths('/tmp/s/.elanous-test', '/tmp/c/.elanous-test');
    expect(p.tasks).toBe('/tmp/c/.elanous-test/tasks/tasks.db');   // config-dir 기반
    expect(p.logs).toBe('/tmp/s/.elanous-test/logs/logs.db');       // state-dir 기반
    // configDir 생략 시 stateDir 폴백(config-dir==state-dir 관례).
    expect(instanceStorePaths('/tmp/x').tasks).toBe('/tmp/x/tasks/tasks.db');
  });
});

describe('buildFleetView — 인스턴스 + 스토어 매트릭스', () => {
  const A = '/tmp/inst-a/.elanous-test';
  const B = '/tmp/inst-b/.elanous-test';
  const instances = [
    { name: 'test:a', stateDir: A, repoPath: '/tmp/inst-a', alive: true, pid: 111, startedAt: '2026-07-24T00:00:00Z' },
    { name: 'test:b', stateDir: B, alive: false, pid: 222, startedAt: '2026-07-24T00:00:00Z' },
  ];
  // A 는 logs+sessions 만, B 는 tasks + ops_events + schedules + mandate 존재하도록.
  const exists = (p: string): boolean =>
    (p.startsWith(A) && (p.includes('/logs/') || p.includes('/sessions/')))
    || (p.startsWith(B) && (p.includes('/tasks/') || p.endsWith('/ops_events.db') || p.endsWith('/schedules.db') || p.endsWith('/finance-trade-mandate.json') || p.endsWith('/pty/manifest.db')));

  test('주입 인스턴스 + prod 자동포함 + 스토어 존재 판정', () => {
    const view = buildFleetView({ instances, exists });
    // prod(~/.elanous) 자동 포함.
    expect(view.some((v) => v.name === 'prod')).toBe(true);
    const a = view.find((v) => v.name === 'test:a')!;
    expect(a.stores.logs).toBe(true);
    expect(a.stores.sessions).toBe(true);
    expect(a.stores.tasks).toBe(false);
    expect(a.stores.frame).toBe(false);
    const b = view.find((v) => v.name === 'test:b')!;
    expect(b.stores.frame).toBe(true);
    expect(b.stores.tasks).toBe(true);
    expect(b.stores.logs).toBe(false);
    // 신규 3키 매트릭스 — B 는 ops/sched/mandate 존재, A 는 부재.
    expect(b.stores.opsEvents).toBe(true);
    expect(b.stores.schedules).toBe(true);
    expect(b.stores.mandate).toBe(true);
    expect(a.stores.opsEvents).toBe(false);
    expect(a.stores.schedules).toBe(false);
    expect(a.stores.mandate).toBe(false);
  });

  test('원격 인스턴스의 hostId·hostname·liveness를 보존한다', () => {
    const view = buildFleetView({ instances: [{
      name: 'remote', stateDir: '/tmp/remote', hostId: '01OTHERHOST', hostname: 'win-box',
      liveness: 'remote', alive: false, pid: 999_999_999, startedAt: '2026-07-24T00:00:00Z',
    }], exists: () => false });
    expect(view.find((v) => v.name === 'remote')).toMatchObject({
      hostId: '01OTHERHOST', hostname: 'win-box', liveness: 'remote', alive: false,
    });
  });

  test('alive 우선 정렬', () => {
    const view = buildFleetView({ instances, exists });
    // test:a(alive) 가 test:b(dead) 보다 앞.
    const ai = view.findIndex((v) => v.name === 'test:a');
    const bi = view.findIndex((v) => v.name === 'test:b');
    expect(ai).toBeLessThan(bi);
  });

  test('kind 유추 — .elanous-test 폴더/test: 이름=test · prod 홈=prod · 병렬 인스턴스=prod (Phase A)', () => {
    const parallel = { name: 'axon', stateDir: '/tmp/axon-state', alive: true, pid: 333, startedAt: '2026-07-24T00:00:00Z' };
    const view = buildFleetView({ instances: [...instances, parallel], exists });
    expect(view.find((v) => v.name === 'test:a')!.kind).toBe('test');
    expect(view.find((v) => v.name === 'prod')!.kind).toBe('prod');
    // 병렬 비-test 인스턴스(.elanous-test 아님·test: prefix 아님)는 prod-kind → 데이터 연합 포함.
    expect(view.find((v) => v.name === 'axon')!.kind).toBe('prod');
  });
});

// ⭐⭐ 연합 조회 대상 열거의 SSOT (2026-07-30 · 리뷰 must-fix) — `fleet screen --all` 과
//    `pty list --all` 이 각자 조립하면 두 창구가 조용히 갈린다. 여기서 계약을 잠근다.
describe('ptyManifestTargets', () => {
  const deps = (present: string[]) => ({
    instances: [
      { name: 'test:wt-docs', stateDir: '/wt/docs' },
      { name: 'pilot', stateDir: '/pilot' },
    ],
    exists: (p: string) => present.includes(p),
    realpath: (p: string) => p,
    isTest: (e: { name: string }) => e.name.startsWith('test:'),
  });

  test('격리 test 는 기본 제외 · --include-test 로만 들어온다', () => {
    const present = ['/wt/docs/pty/manifest.db', '/pilot/pty/manifest.db'];
    expect(ptyManifestTargets({}, deps(present)).map((t) => t.name)).toEqual(['pilot']);
    expect(ptyManifestTargets({ includeTest: true }, deps(present)).map((t) => t.name)).toEqual(['test:wt-docs', 'pilot']);
  });

  test('없는 매니페스트는 담지 않고, 같은 물리 경로는 한 번만 담는다', () => {
    const dup = {
      instances: [
        { name: 'a', stateDir: '/same' },
        { name: 'b', stateDir: '/other' },
      ],
      exists: () => true,
      realpath: () => '/same/pty/manifest.db',   // 둘 다 같은 물리 파일로 해석된다
      isTest: () => false,
    };
    expect(ptyManifestTargets({}, dup).map((t) => t.name)).toEqual(['prod']);
    expect(ptyManifestTargets({}, { ...deps([]), instances: [{ name: 'a', stateDir: '/gone' }] })).toEqual([]);
  });
});

describe('ptyEventLogTargets', () => {
  test('keeps missing ledger roots so lineage can distinguish missing from unreadable', () => {
    const targetDeps = {
      instances: [{ name: 'pilot', stateDir: '/pilot' }, { name: 'test:wt', stateDir: '/test' }],
      realpath: (p: string) => p,
      isTest: (entry: { name: string }) => entry.name.startsWith('test:'),
    };
    expect(ptyEventLogTargets({}, targetDeps)).toEqual([
      { name: 'prod', dbPath: `${join(homedir(), '.elanous')}/pty/events.db` },
      { name: 'pilot', dbPath: '/pilot/pty/events.db' },
    ]);
    expect(ptyEventLogTargets({ includeTest: true }, targetDeps).map((target) => target.name)).toEqual(['prod', 'pilot', 'test:wt']);
  });
});
