// ── ⓑ 수호자 «설치 sha 보다 옛 판으로 logs.db 를 연 프로세스» 단위 시험 (LOGS-RETENTION-46MIN) ──
//
// log-store-retention-floor.test.ts 패턴(파일 백킹 임시 DB + debug.registerSink 관측
// 캡처)을 «옛 판 오프너 경보»로 확장한다. 사고(10-12): 하한 이전 판 크론 프로세스가
// 6시간마다 «오래된 행 50%» 삭제를 겹쳐 돌려 보존 창 46분 붕괴 — 재발 시 수호자가
// 경보 관측(log-store.retention/stale-opener-alert)으로 남겨야 조용한 반복이 막힌다.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import {
  alertStaleLogDbOpeners,
  resolveInstalledRevisionMarker,
  resolveInstalledSha,
  scanLogDbOpeners,
  staleOpenerReason,
  type LogDbOpenerInfo,
  type StaleOpenerAlert,
} from './log-store.js';

type CapturedAlert = { category: string; event: string; data: Record<string, unknown> };
// scanner reads Linux /proc. macOS has no /proc, so only the two live fd tests
// are Linux-specific; the marker, classification and alert tests run everywhere.
const procfsTest = process.platform === 'linux' ? test : test.skip;

function captureStaleOpenerAlerts(sinkName: string): { rows: CapturedAlert[]; off: () => void } {
  const rows: CapturedAlert[] = [];
  const off = debug.registerSink({
    name: sinkName,
    emit: (rec) => {
      if (rec.category === 'log-store.retention' && rec.event === 'stale-opener-alert') {
        rows.push({ category: rec.category, event: rec.event, data: (rec.data ?? {}) as Record<string, unknown> });
      }
    },
  });
  return { rows, off };
}

describe('log-store ⓑ 수호자: 설치 sha 보다 옛 판으로 logs.db 를 연 프로세스', () => {
  test('시뮬레이트된 옛 판 오프너가 경보 관측에 잡힌다', () => {
    const { rows, off } = captureStaleOpenerAlerts('stale-opener-test');
    try {
      const installedAt = Date.now();
      const oldOpener: LogDbOpenerInfo = {
        pid: 424242,
        start: '99999',
        startedAtMs: installedAt - 86_400_000, // 설치판보다 하루 먼저 기동 = 옛 판
        cmdline: ['bun', '/old-tree/scripts/cron-run.ts', 'target.ts'],
        cwd: '/old-tree',
      };
      const freshOpener: LogDbOpenerInfo = {
        pid: process.pid,
        start: '1',
        startedAtMs: installedAt + 60_000, // 설치판 뒤 기동 = 현행 판
        cmdline: [],
        cwd: null,
      };
      const alerts: StaleOpenerAlert[] = alertStaleLogDbOpeners('/tmp/stale-opener-test/logs.db', {
        installedAtMs: installedAt,
        openers: () => [oldOpener, freshOpener],
      });
      expect(alerts.map((a) => a.pid)).toEqual([424242]);
      expect(alerts[0]!.startedAt).toBe(new Date(installedAt - 86_400_000).toISOString());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.pid).toBe(424242);
      expect(rows[0]!.data.start).toBe('99999');
      expect(rows[0]!.data.via).toBe('procfs-fd+stat');
      expect(String(rows[0]!.data.reason)).toContain('before installed');
      expect(rows[0]!.data.db).toBe('/tmp/stale-opener-test/logs.db');
      expect('installedSha' in rows[0]!.data).toBeTrue();
      expect('installedAtMs' in rows[0]!.data).toBeTrue();
      expect(typeof rows[0]!.data.marker).toBe('string');
    } finally {
      off();
    }
  });

  test('현행 판 오프너만 있으면 경보가 없다', () => {
    const { rows, off } = captureStaleOpenerAlerts('stale-opener-quiet-test');
    try {
      const now = Date.now();
      const alerts = alertStaleLogDbOpeners('/tmp/stale-opener-test/logs.db', {
        installedAtMs: now,
        openers: () => [{ pid: 111, start: '5', startedAtMs: now + 1000, cmdline: [], cwd: null }],
      });
      expect(alerts).toEqual([]);
      expect(rows).toHaveLength(0);
    } finally {
      off();
    }
  });

  procfsTest('lsof 상당 스캔이 열어둔 임시 logs.db 를 이 프로세스에서 잡는다(lstart 상당 포함)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'stale-opener-scan-'));
    try {
      const dbPath = join(directory, 'logs.db');
      const db = new Database(dbPath); // fd 를 쥔 채 스캔한다
      try {
        db.run('CREATE TABLE IF NOT EXISTS opener_probe (x)');
        const openers = scanLogDbOpeners(dbPath, { selfPid: -1 });
        const me = openers.find((o) => o.pid === process.pid);
        expect(me).toBeDefined();
        expect(me!.start).not.toBeNull(); // /proc/<pid>/stat starttime — lstart 상당
        expect(me!.startedAtMs).toBeGreaterThan(0);
        expect(me!.startedAtMs!).toBeLessThanOrEqual(Date.now());
        expect(me!.cmdline!.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('staleOpenerReason — 측정 결측·자기 자신은 경보하지 않는다(fail-safe)', () => {
    const check = { selfPid: process.pid, installedAtMs: Date.now() };
    expect(staleOpenerReason({ pid: process.pid, start: null, startedAtMs: 1, cmdline: null, cwd: null }, check)).toBeNull();
    expect(staleOpenerReason({ pid: 7, start: null, startedAtMs: null, cmdline: null, cwd: null }, check)).toBeNull();
    expect(staleOpenerReason({ pid: 7, start: '1', startedAtMs: 1, cmdline: null, cwd: null }, { selfPid: process.pid, installedAtMs: null })).toBeNull();
    expect(staleOpenerReason({ pid: 7, start: '1', startedAtMs: check.installedAtMs! - 1, cmdline: null, cwd: null }, check)).toContain('before installed');
  });

  test('설치 후 옛 체크아웃에서 새로 시작한 오프너도 SHA 차이로 경보한다', () => {
    const now = Date.now();
    const reason = staleOpenerReason(
      { pid: 70, start: '1', startedAtMs: now + 1000, cmdline: null, cwd: '/old', revisionSha: 'a'.repeat(40) },
      { selfPid: process.pid, installedAtMs: now, installedSha: 'b'.repeat(40), revisionRelation: 'older' },
    );
    expect(reason).toContain(`checkout revision ${'a'.repeat(40)} precedes`);
    expect(staleOpenerReason(
      { pid: 71, start: '1', startedAtMs: now - 1000, cmdline: null, cwd: '/new', revisionSha: 'c'.repeat(40) },
      { selfPid: process.pid, installedAtMs: now, installedSha: 'b'.repeat(40), revisionRelation: 'newer' },
    )).toBeNull();
  });

  procfsTest('옛 스크립트·새 cwd의 실제 DB 오프너를 스캔해 수호자 경보까지 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stale-opener-old-script-'));
    const oldRoot = join(root, 'old');
    const newRoot = join(root, 'new');
    mkdirSync(join(oldRoot, '.git'), { recursive: true });
    mkdirSync(join(newRoot, '.git'), { recursive: true });
    const repo = join(import.meta.dir, '../../..');
    const gitOut = (ref: string): string => {
      const result = Bun.spawnSync(['git', 'rev-parse', ref], { cwd: repo });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    const oldSha = gitOut('HEAD^');
    const installedSha = gitOut('HEAD');
    writeFileSync(join(oldRoot, '.git', 'HEAD'), `${oldSha}\n`);
    writeFileSync(join(newRoot, '.git', 'HEAD'), `${installedSha}\n`);
    const script = join(oldRoot, 'hold-db.ts');
    const dbPath = join(root, 'logs.db');
    writeFileSync(script, `import { Database } from 'bun:sqlite';\nconst db = new Database(process.env.TEST_DB!);\ndb.run('CREATE TABLE IF NOT EXISTS hold (x)');\nsetInterval(() => void db, 1000);\n`);
    const { rows, off } = captureStaleOpenerAlerts('stale-opener-old-script-cwd-test');
    const child = Bun.spawn([process.execPath, script], {
      cwd: newRoot, env: { ...process.env, TEST_DB: dbPath }, stdout: 'ignore', stderr: 'pipe',
    });
    try {
      let opener: LogDbOpenerInfo | undefined;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        opener = scanLogDbOpeners(dbPath).find((candidate) => candidate.pid === child.pid);
        if (opener) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(opener).toBeDefined();
      expect(opener!.cwd).toBe(newRoot);
      expect(opener!.revisionSha).toBe(oldSha);
      const alerts = alertStaleLogDbOpeners(dbPath, {
        openers: () => scanLogDbOpeners(dbPath), installedAtMs: Date.now() - 10_000,
      });
      expect(alerts.some((alert) => alert.pid === child.pid)).toBeTrue();
      expect(rows.some((row) => row.data.pid === child.pid && row.data.openerSha === oldSha)).toBeTrue();
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('마커는 모듈 mtime 이 아니라 «설치 시점»이다 — 같은 파일이 그대로인 채 새 판이 설치돼도 옛 판 오프너를 놓치지 않는다(must-fix)', () => {
    // 사고 시나리오: log-store.ts 는 변경되지 않은 채 다른 파일을 고친 새 판을 지금 설치했다.
    // 오프너는 «모듈 mtime(옛) 뒤·설치 시점(새) 앞»에 기동 — 옛 코드를 쥔 채 살아 있다.
    // 모듈 mtime 기준이면 잡히지 않고, 설치 시점 기준이면 잡혀야 한다.
    const installedAt = Date.now();
    const openerStartedAtMs = installedAt - 3_600_000;
    const installedSha = '0123456789abcdef0123456789abcdef01234567';
    const reason = staleOpenerReason(
      { pid: 9, start: '1', startedAtMs: openerStartedAtMs, cmdline: null, cwd: null },
      { selfPid: process.pid, installedAtMs: installedAt, installedSha },
    );
    expect(reason).toContain('before installed');
    expect(reason).toContain(installedSha);
    expect(reason).toContain(new Date(installedAt).toISOString());
  });

  test('resolveInstalledRevisionMarker — 설치 sha 와 «설치 시점»(ref/HEAD mtime)을 함께 돌린다', () => {
    const marker = resolveInstalledRevisionMarker();
    expect(marker.sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(marker.installedAtMs).not.toBeNull();
    expect(marker.installedAtMs!).toBeGreaterThan(0);
    expect(marker.installedAtMs!).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(typeof marker.marker).toBe('string');
    expect(existsSync(marker.marker!)).toBeTrue();
  });

  test('활성 ref가 packed-refs에만 있는 체크아웃에서도 설치 판을 찾는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'stale-opener-packed-'));
    try {
      const gitDir = join(root, '.git');
      mkdirSync(gitDir);
      const sha = '0123456789abcdef0123456789abcdef01234567';
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${sha} refs/heads/main\n`);
      const checkoutAt = new Date(Date.now() - 86_400_000);
      utimesSync(join(gitDir, 'HEAD'), checkoutAt, checkoutAt);
      // SHA가 그대로인 채 재패킹돼도 설치 시각이 바뀌어서는 안 된다.
      const repackedAt = new Date(Date.now() - 1000);
      utimesSync(join(gitDir, 'packed-refs'), repackedAt, repackedAt);
      const marker = resolveInstalledRevisionMarker(root);
      expect(marker.sha).toBe(sha);
      expect(marker.marker).toBe(join(gitDir, 'packed-refs'));
      expect(Math.abs(marker.installedAtMs! - checkoutAt.getTime())).toBeLessThan(1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolveInstalledSha — 이 체크아웃의 HEAD 를 hex sha 로 돌린다', () => {
    const sha = resolveInstalledSha();
    expect(sha).not.toBeNull();
    expect(sha!).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
