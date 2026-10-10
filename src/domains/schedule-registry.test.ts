import { setDefaultTimeout, test, expect, describe, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { TaskStore } from '../task-orchestrator/store.js';
import { createTask } from '../task-orchestrator/types.js';
import { migrateJobToTrigger, registerScheduledToxTasks, scheduledRunViaById } from './schedule-migrate.js';
import { debug } from '../debug/log.js';
import { addSource, removeSource } from '../intake-plane/intake-sources.js';
import {
  openSchedulesDb, parseCronLine, scriptName, inferCategory, unwrapCronCommand, wrapCronLine, wrapShellCronLine, unwrapCronLine, sharesCrontabLine,
  inventoryCrontab, inventoryInternalSchedules, listSchedules, driftedSchedules,
  buildCronLine, addLineToCrontab, removeLineFromCrontab, setLineEnabled,
  deleteScheduleRow, setRunVia, markResult, scheduleHealth, setScheduleMission,
  parseDisabledCronLine, cronEntryId, markRun,
} from './schedule-registry.js';

const db = () => openSchedulesDb(':memory:');

function withTempDb(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-registry-'));
  try { run(join(dir, 'schedules.db')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function withExclusiveLock(path: string, holdMs: number, run: () => void): Promise<void> {
  const holder = spawn(process.execPath, ['-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1]);
    db.run('BEGIN EXCLUSIVE');
    process.stdout.write('locked\\n');
    setTimeout(() => { db.run('COMMIT'); db.close(); }, Number(process.argv[2]));
  `, path, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString() === 'locked\n') {
        holder.stdout?.off('data', onData);
        resolve();
      }
    };
    holder.once('error', reject);
    holder.stdout?.on('data', onData);
    holder.once('exit', (code) => {
      if (code !== 0) reject(new Error(`exclusive lock holder exited: ${code}`));
    });
  });
  try { run(); } finally { await new Promise<void>((resolve) => holder.once('exit', () => resolve())); }
}

describe('openSchedulesDb schema initialization', () => {
  test('새 파일 DB는 테이블과 인덱스를 만들고 기록 동작을 유지한다', () => {
    withTempDb((path) => {
      const d = openSchedulesDb(path);
      const objects = d.prepare(`SELECT type, name FROM sqlite_master WHERE name IN ('schedule_registry', 'idx_sched_cat') ORDER BY type`).all();
      expect(objects).toEqual([{ type: 'index', name: 'idx_sched_cat' }, { type: 'table', name: 'schedule_registry' }]);
      inventoryCrontab(d, { crontab: '0 8 * * * cd /r && bun scripts/file-backed.ts', now: '2026-09-04T08:05:00Z' });
      expect(listSchedules(d).map(({ name }) => name)).toEqual(['file-backed']);
      d.close();
    });
  });

  test('legacy manually disabled trigger without provenance stays off after opening and inventory', () => {
    withTempDb(path => {
      const legacy = new Database(path);
      legacy.run(`CREATE TABLE schedule_registry (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, cron TEXT,
        command TEXT, category TEXT NOT NULL, domain TEXT, enabled INT, last_seen TEXT,
        managed_by TEXT, raw TEXT, run_via TEXT, last_via TEXT
      )`);
      legacy.run(`INSERT INTO schedule_registry (id, name, source, category, enabled, run_via, last_via)
        VALUES ('old', 'old', 'crontab', 'maintenance', 0, 'trigger', 'trigger')`);
      expect((legacy.query(`PRAGMA table_info(schedule_registry)`).all() as Array<{ name: string }>).some(c => c.name === 'disabled_reason')).toBe(false);
      legacy.close();
      const d = openSchedulesDb(path);
      try {
        expect(d.query(`SELECT disabled_reason FROM schedule_registry WHERE id = 'old'`).get()).toEqual({ disabled_reason: null });
        inventoryCrontab(d, { crontab: '0 10 * * * echo keep' });
        expect(d.query(`SELECT source, enabled FROM schedule_registry WHERE id = 'old'`).get()).toEqual({ source: 'crontab', enabled: 0 });
        const store = new TaskStore({ path: ':memory:', noWal: true });
        try {
          store.saveTask(createTask({
            title: 'old', surface: { kind: 'terminal-pane', spec: { command: 'echo old' } },
            scheduleText: '0 8 * * *', schedulerJobId: 'old',
          }, { id: 'task:old', now: 1 }));
          const byId = scheduledRunViaById(listSchedules(d));
          const registered: string[] = [];
          const result = registerScheduledToxTasks(store, entry => registered.push(entry.definition.name), id => byId.get(id) ?? null);
          expect(result).toMatchObject({ registered: 0, skippedNotTrigger: 1 });
          expect(registered).toEqual([]);
        } finally { store.close(); }
      } finally { d.close(); }
    });
  });

  test(':memory: DB는 스키마를 만들고 조회한다', () => {
    const d = openSchedulesDb(':memory:');
    expect(d.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_registry'`).get()).toEqual({ name: 'schedule_registry' });
    expect(listSchedules(d)).toEqual([]);
    d.close();
  });

  test('모든 연결에 스키마 검사 전 busy_timeout 2000ms를 설정한다', () => {
    const d = openSchedulesDb(':memory:');
    expect(d.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 2000 });
    d.close();
  });

  test('짧은 EXCLUSIVE 잠금이 풀리면 busy_timeout 연결의 읽기는 기다린 뒤 성공한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-registry-lock-'));
    const path = join(dir, 'schedules.db');
    try {
      const setup = openSchedulesDb(path);
      const journalMode = setup.query('PRAGMA journal_mode').get();
      setup.close();
      await withExclusiveLock(path, 100, () => {
        const startedAt = Date.now();
        const reader = openSchedulesDb(path);
        expect(reader.query('SELECT COUNT(*) AS count FROM schedule_registry').get()).toEqual({ count: 0 });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
        expect(reader.query('PRAGMA journal_mode').get()).toEqual(journalMode);
        reader.close();
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('busy_timeout=0이면 같은 EXCLUSIVE 잠금 아래 읽기는 즉시 실패한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-registry-lock-'));
    const path = join(dir, 'schedules.db');
    try {
      openSchedulesDb(path).close();
      await withExclusiveLock(path, 100, () => {
        const reader = new Database(path);
        reader.run('PRAGMA busy_timeout = 0');
        const startedAt = Date.now();
        expect(() => reader.query('SELECT COUNT(*) AS count FROM schedule_registry').get()).toThrow('database is locked');
        expect(Date.now() - startedAt).toBeLessThan(50);
        reader.close();
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('기존 스키마를 다시 열면 CREATE TABLE과 CREATE INDEX를 실행하지 않는다', () => {
    withTempDb((path) => {
      openSchedulesDb(path).close();
      const originalRun = Database.prototype.run;
      const ddl: string[] = [];
      Database.prototype.run = function (this: Database, ...args: Parameters<Database['run']>) {
        const [sql] = args;
        if (/^CREATE (?:TABLE|INDEX)/.test(sql.trim())) ddl.push(sql);
        return originalRun.call(this, ...args);
      };
      try {
        const d = openSchedulesDb(path);
        expect(listSchedules(d)).toEqual([]);
        d.close();
      } finally {
        Database.prototype.run = originalRun;
      }
      expect(ddl).toEqual([]);
    });
  });
});

// 합성 crontab (실 crontab 미사용 — 결정론)
const SAMPLE = [
  '# comment line',
  'FOO=bar',
  '',
  '50 4 * * * /Users/x/repo/scripts/collect-market-backbone.sh',
  '0 8,12,15,19 * * * bun scripts/breaking-digest.ts --period batch >> /tmp/x.log 2>&1',
  '*/15 * * * * bun /Users/x/repo/scripts/x-breaking-alert.ts >> /tmp/x.log 2>&1',
  '30 8 * * 1-5 cd /Users/x/repo && bun scripts/capstone-alert.ts >> /tmp/x.log 2>&1',
  '*/10 9-15 * * 1-5 cd /Users/x/repo && bun scripts/samsung-koru-watch.ts >> /tmp/x.log 2>&1',
  '*/10 22-23 * * 1-5 cd /Users/x/repo && bun scripts/samsung-koru-watch.ts >> /tmp/x.log 2>&1',
  '31 6 * * * cd /Users/x/repo && bun scripts/outbound-flush.ts >> /tmp/x.log 2>&1',
].join('\n');

describe('parseCronLine', () => {
  test('유효 라인 → cron + command 분리', () => {
    const p = parseCronLine('*/10 9-15 * * 1-5 cd /r && bun scripts/x.ts');
    expect(p?.cron).toBe('*/10 9-15 * * 1-5');
    expect(p?.command).toContain('bun scripts/x.ts');
  });
  test('주석/빈줄/env줄 → null', () => {
    expect(parseCronLine('# hi')).toBeNull();
    expect(parseCronLine('')).toBeNull();
    expect(parseCronLine('FOO=bar')).toBeNull();
  });
});

describe('scriptName', () => {
  test('.sh / .ts / cd&& prefix', () => {
    expect(scriptName('/r/scripts/collect-market-backbone.sh')).toBe('collect-market-backbone');
    expect(scriptName('cd /r && bun scripts/samsung-koru-watch.ts >> /tmp/x')).toBe('samsung-koru-watch');
  });
  test('a wrapped shell target outside scripts/ keeps the registry name (cron-run passes interpreter and target)', () => {
    expect(scriptName('/opt/homebrew/bin/bash /x/backup.sh')).toBe('backup');
    expect(scriptName('bash /x/backup.sh --source cron')).toBe('backup');
  });

  test('shell interpreter in Bun arguments is not mistaken for the executable', () => {
    const command = 'bun scripts/report.ts --runner bash /x/backup.sh';
    expect(scriptName(command)).toBe('report');
    const d = db();
    try {
      inventoryCrontab(d, { crontab: `0 7 * * * ${command}` });
      expect(listSchedules(d)[0]!.name).toBe('report');
    } finally { d.close(); }
  });
});

describe('unwrapCronCommand + 래퍼 id 안정성 (RFC-scheduler-execution-observability·2026-07-15)', () => {
  test('unwrapCronCommand — cron-run.ts 토큰만 제거·비래핑 멱등', () => {
    expect(unwrapCronCommand('cd /r && bun scripts/cron-run.ts scripts/x-breaking-alert.ts --a')).toBe('cd /r && bun scripts/x-breaking-alert.ts --a');
    expect(unwrapCronCommand('cd /r && bun scripts/x-breaking-alert.ts --a')).toBe('cd /r && bun scripts/x-breaking-alert.ts --a');
  });
  test('scriptName — 래핑돼도 안쪽 target 명', () => {
    expect(scriptName('cd /r && bun scripts/cron-run.ts scripts/community-buzz-cycle.ts --collect-only')).toBe('community-buzz-cycle');
  });
  test('wrapCronLine — bun .ts 잡만 감싸고 원래 id 전달·멱등·round-trip', () => {
    const plain = '*/10 8-20 * * 1-5 cd /r && /Users/j/.bun/bin/bun scripts/community-buzz-cycle.ts --collect-only >> /tmp/x.log 2>&1';
    const before = parseCronLine(plain)!;
    const id = cronEntryId(before.cron, before.command);
    const wrapped = wrapCronLine(plain);
    expect(wrapped).toContain(`bun scripts/cron-run.ts --schedule-id ${id} scripts/community-buzz-cycle.ts --collect-only`);
    expect(wrapCronLine(wrapped)).toBe(wrapped);          // 멱등(이미 래핑)
    expect(unwrapCronLine(wrapped)).toBe(plain);          // round-trip
    const after = parseCronLine(wrapped)!;
    expect(unwrapCronCommand(after.command)).toBe(before.command);
    expect(cronEntryId(after.cron, unwrapCronCommand(after.command))).toBe(id);
    const other = wrapCronLine(plain.replace('*/10', '*/15'));
    expect(other).toContain(`--schedule-id ${cronEntryId('*/15 8-20 * * 1-5', before.command)}`);
    expect(other).not.toContain(`--schedule-id ${id}`);
  });
  test('wrapCronLine — .sh 잡·비대상은 그대로', () => {
    const sh = '50 4 * * * /r/scripts/collect-market-backbone.sh';
    expect(wrapCronLine(sh)).toBe(sh); // bun .ts 아님 → 미변경
  });
  test('★ sharesCrontabLine — 팬텀/실잡이 같은 raw 공유 감지(삭제 가드·axon 사고 예방)', () => {
    const RAW = '*/15 * * * * cd /r && bun scripts/cron-run.ts scripts/signal-pool-cycle.ts';
    const rows = [
      { id: 'real_id', raw: RAW },          // 실잡(unwrap id)
      { id: 'phantom_id', raw: RAW },       // 팬텀(cron-run·wrap id·같은 raw)
      { id: 'other', raw: '0 7 * * * cd /r && bun scripts/x.ts' },
    ];
    // 팬텀 삭제 시 → 실잡이 같은 라인 공유 → true(=crontab 무접촉·registry 행만)
    expect(sharesCrontabLine(rows, 'phantom_id', RAW)).toBe(true);
    // 유일 라인(other) 삭제 → 공유 없음 → false(=crontab 라인 제거 정상)
    expect(sharesCrontabLine(rows, 'other', '0 7 * * * cd /r && bun scripts/x.ts')).toBe(false);
    // raw 빈값 → false
    expect(sharesCrontabLine(rows, 'real_id', null)).toBe(false);
  });
  test('★ id 안정 — 래핑 전후 동일 id·name·category(마이그레이션 0)', () => {
    const cron = '*/10 8-20 * * 1-5';
    const plain = `${cron} cd /r && bun scripts/community-buzz-cycle.ts --collect-only >> /tmp/x.log 2>&1`;
    const wrapped = `${cron} cd /r && bun scripts/cron-run.ts scripts/community-buzz-cycle.ts --collect-only >> /tmp/x.log 2>&1`;
    const dP = db(); inventoryCrontab(dP, { crontab: plain, now: '2026-07-15T00:00:00Z' });
    const dW = db(); inventoryCrontab(dW, { crontab: wrapped, now: '2026-07-15T00:00:00Z' });
    const rP = listSchedules(dP)[0]!, rW = listSchedules(dW)[0]!;
    expect(rW.id).toBe(rP.id);            // 래핑해도 id 불변
    expect(rW.name).toBe('community-buzz-cycle');
    expect(rW.category).toBe(rP.category); // unwrap 후 카테고리 추론(동일)
  });
  test('★ 계보 승계 — markResult 후 래핑 재인벤토리해도 같은 행·last_status 보존', () => {
    const cron = '10 * * * *';
    const plain = `${cron} cd /r && bun scripts/x-breaking-alert.ts >> /tmp/x.log 2>&1`;
    const wrapped = `${cron} cd /r && bun scripts/cron-run.ts scripts/x-breaking-alert.ts >> /tmp/x.log 2>&1`;
    const d = db();
    inventoryCrontab(d, { crontab: plain, now: '2026-07-15T00:00:00Z' });
    const id = listSchedules(d)[0]!.id;
    markResult(d, id, { status: 'ok', exit: 0, durationMs: 1200, via: 'crontab' });
    inventoryCrontab(d, { crontab: wrapped, now: '2026-07-15T01:00:00Z' }); // 래핑 라인 재인벤토리
    const rows = listSchedules(d);
    expect(rows.length).toBe(1);          // 새 행 안 생김(같은 id UPSERT)
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.last_status).toBe('ok'); // 계보 보존
  });
});

describe('hq-fence schedule identity', () => {
  const cron = '*/10 * * * *';
  const price = 'cd /r && /b/bun scripts/cron-run.ts scripts/price-guard-cycle.ts >> /tmp/price-guard-cycle.log 2>&1';
  const posture = `cd /r && /b/bun scripts/cron-run.ts scripts/market-posture-cycle.ts --note 'open' >> /tmp/market-posture-cycle.log 2>&1`;
  const plain = 'cd /r && /b/bun scripts/cron-run.ts scripts/ordinary-cycle.ts >> /tmp/ordinary-cycle.log 2>&1';
  const fixtures = [
    { installed: `${cron} /home/u/.elanous/bin/hq-fence conatus '${price}' >> /tmp/elanous-hq-fence.log 2>&1`, before: `${cron} ${price}` },
    { installed: `${cron} hq-fence --role cron -- '${posture.replaceAll("'", `'"'"'`)}'`, before: `${cron} ${posture}` },
    { installed: `${cron} ${plain}`, before: `${cron} ${plain}` },
  ];

  test('parse → unwrap → id preserves unfenced identity, drops only outer redirects and is idempotent', () => {
    for (const { installed, before } of fixtures) {
      const actual = parseCronLine(installed)!;
      const original = parseCronLine(before)!;
      const effective = unwrapCronCommand(actual.command);
      expect(effective).toBe(unwrapCronCommand(original.command));
      expect(unwrapCronCommand(effective)).toBe(effective);
      expect(cronEntryId(actual.cron, effective)).toBe(cronEntryId(original.cron, unwrapCronCommand(original.command)));
      expect(effective).not.toContain('hq-fence');
      expect(effective).not.toContain('/tmp/elanous-hq-fence.log');
    }
    expect(unwrapCronCommand(plain)).toBe('cd /r && /b/bun scripts/ordinary-cycle.ts >> /tmp/ordinary-cycle.log 2>&1');
    expect(unwrapCronCommand(`hq-fence --role cron '${price}'`)).toBe(unwrapCronCommand(price));
    expect(unwrapCronCommand(`hq-fence cron '${price}'`)).toBe(unwrapCronCommand(price));
    expect(unwrapCronCommand('  echo hq-fence cron \'not a wrapper\'  ')).toBe('  echo hq-fence cron \'not a wrapper\'  ');
  });

  test('installed shapes: trailing # comment is kept, shell-style \'\\\'\' quoting is decoded', () => {
    const commented = parseCronLine(`${cron} /h/.elanous/bin/hq-fence cron '/h/bin/test-diet.sh' >> /tmp/x.log 2>&1 # TD3 note`)!;
    expect(unwrapCronCommand(commented.command)).toBe('/h/bin/test-diet.sh # TD3 note');
    const json = `cd /r && /b/bun bin/elanous.mjs graph run g.yaml --input '{"mode":"live"}' >> /tmp/d.log 2>&1`;
    const shellQuoted = parseCronLine(`${cron} /h/.elanous/bin/hq-fence cron '${json.replaceAll("'", `'\\''`)}'  # OP note`)!;
    const effective = unwrapCronCommand(shellQuoted.command);
    expect(effective).toBe(`${json} # OP note`);
    expect(unwrapCronCommand(effective)).toBe(effective);
  });

  test('re-inventory of fenced line keeps one enabled row and the earlier fire', () => {
    const d = db();
    try {
      inventoryCrontab(d, { crontab: fixtures[0]!.before, now: '2026-10-09T02:00:00Z' });
      const id = listSchedules(d)[0]!.id;
      markRun(d, id, '2026-10-09T03:00:00Z');
      expect(inventoryCrontab(d, { crontab: fixtures[0]!.installed, now: '2026-10-09T03:05:00Z' }))
        .toMatchObject({ total: 1, added: 0, vanished: 0 });
      expect(listSchedules(d)).toHaveLength(1);
      expect(listSchedules(d)[0]).toMatchObject({ id, enabled: 1, disabled_reason: null,
        name: 'price-guard-cycle', last_run: '2026-10-09T03:00:00Z' });
    } finally { d.close(); }
  });
});

describe('explicit shell cron wrapping', () => {
  const opts = { bun: '/b/bun', cronRun: '/r/scripts/cron-run.ts' };
  const lines = [
    ['0 7 * * * zsh $HOME/s/intake-cron.sh', 'zsh', 'intake-cron'],
    ['20 4 * * * bash /x/backup.sh --source cron >> /tmp/b.log 2>&1', 'bash', 'backup'],
    ['0 6 * * 1 cd /r && /bin/bash scripts/verify.sh', '/bin/bash', 'verify'],
    ['0 9 * * * /usr/bin/sh /x/daily.sh', '/usr/bin/sh', 'daily'],
    ['0 10 * * * zsh $HOME/.claude/skills/yt-vault/scripts/intake-cron.sh', 'zsh', 'intake-cron'],
    ['0 8 * * * /opt/homebrew/bin/bash /x/backup.sh --source cron', '/opt/homebrew/bin/bash', 'backup'],
  ] as const;

  test.each(lines)('preserves shell line, interpreter, id and execution history: %s', (plain, interpreter, name) => {
    const before = parseCronLine(plain)!;
    const id = cronEntryId(before.cron, before.command);
    const wrapped = wrapShellCronLine(plain, opts);
    expect(wrapped).toContain(`${opts.bun} ${opts.cronRun} --schedule-id ${id} --shell ${interpreter} `);
    expect(wrapShellCronLine(wrapped, opts)).toBe(wrapped);
    expect(unwrapCronLine(wrapped)).toBe(plain);
    const after = parseCronLine(wrapped)!;
    expect(unwrapCronCommand(after.command)).toBe(before.command);
    expect(cronEntryId(after.cron, unwrapCronCommand(after.command))).toBe(id);
    const d = db();
    try {
      inventoryCrontab(d, { crontab: plain });
      const id = listSchedules(d)[0]!.id;
      expect(listSchedules(d)[0]!.name).toBe(name);
      markResult(d, id, { status: 'ok', exit: 0, via: 'crontab' });
      inventoryCrontab(d, { crontab: wrapped });
      expect(listSchedules(d)).toHaveLength(1);
      expect(listSchedules(d)[0]).toMatchObject({ id, name, last_status: 'ok', last_exit: 0 });
    } finally { d.close(); }
  });

  test('interpreter-free shell and already wrapped jobs remain unchanged', () => {
    const plain = '0 */6 * * * cd /r && scripts/m.sh gcpvm';
    expect(wrapShellCronLine(plain, opts)).toBe(plain);
    expect(unwrapCronLine(plain)).toBe(plain);
    const wrapped = wrapShellCronLine(lines[0][0], opts);
    expect(wrapShellCronLine(wrapped, opts)).toBe(wrapped);
    const argument = '0 7 * * * echo "zsh /x/intake-cron.sh"';
    expect(wrapShellCronLine(argument, opts)).toBe(argument);
  });
});

describe('inferCategory', () => {
  test('도메인무관 카테고리 매핑', () => {
    expect(inferCategory('scripts/collect-market-backbone.sh')).toBe('ingest');
    expect(inferCategory('scripts/breaking-digest.ts --period batch')).toBe('digest');
    expect(inferCategory('scripts/x-breaking-alert.ts')).toBe('monitor');
    expect(inferCategory('scripts/samsung-koru-watch.ts')).toBe('monitor');
    expect(inferCategory('scripts/capstone-alert.ts')).toBe('alert');
    expect(inferCategory('scripts/us-pulse.ts --close')).toBe('report');
    expect(inferCategory('scripts/outbound-flush.ts')).toBe('maintenance');
    expect(inferCategory('scripts/kr-investor-ingest.ts')).toBe('ingest');
  });
});

describe('inventoryCrontab', () => {
  test('crontab 인벤토리 + 카테고리 태깅', () => {
    const d = db();
    const r = inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    expect(r.total).toBe(7);  // 주석/빈줄/env 제외 7 크론
    expect(r.added).toBe(7);
    const rows = listSchedules(d);
    expect(rows.length).toBe(7);
    expect(rows.every(x => x.source === 'crontab')).toBe(true);
    expect(rows.find(x => x.name === 'breaking-digest')?.category).toBe('digest');
  });

  test('시간대 다른 같은 스크립트 = 별 행(cron 해시 구분)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    const koru = listSchedules(d).filter(x => x.name === 'samsung-koru-watch');
    expect(koru.length).toBe(2);  // 9-15, 22-23 두 창
    expect(koru[0]!.id).not.toBe(koru[1]!.id);
  });

  test('재인벤토리 멱등 (added 0)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    const r2 = inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:10:00Z' });
    expect(r2.added).toBe(0);
    expect(r2.total).toBe(7);
    expect(listSchedules(d).length).toBe(7);
  });

  test('deleteScheduleRow — registry 정합(crontab delete 반영·내부 기억 정리)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    const target = listSchedules(d).find(x => x.name === 'outbound-flush')!;
    expect(target).toBeTruthy();
    deleteScheduleRow(d, target.id);
    expect(listSchedules(d).length).toBe(6);                         // 7 → 6
    expect(listSchedules(d).find(x => x.id === target.id)).toBeUndefined();
    // 스캔미러 재인벤토리 — crontab 에 없으면 되살아나지 않음(정합 유지).
    const withoutFlush = SAMPLE.split('\n').filter(l => !l.includes('outbound-flush')).join('\n');
    inventoryCrontab(d, { crontab: withoutFlush, now: '2026-07-07T10:20:00Z' });
    expect(listSchedules(d).length).toBe(6);
  });

  test('adopt(setRunVia elanous) 은 registry 유지 — delete 와 구분', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    const target = listSchedules(d).find(x => x.name === 'capstone-alert')!;
    setRunVia(d, target.id, 'elanous');   // adopt = crontab 제거하되 registry 유지(데몬 실행)
    const after = listSchedules(d).find(x => x.id === target.id);
    expect(after?.run_via).toBe('elanous');
    expect(listSchedules(d).length).toBe(7);   // 삭제 아님 — 유지
  });

  test('필터 (category/source)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    expect(listSchedules(d, { category: 'monitor' }).length).toBe(3); // x-breaking + koru x2
    expect(listSchedules(d, { category: 'ingest' }).length).toBe(1);
  });
});

describe('driftedSchedules — crontab에서 사라진 잡 감지', () => {
  test('재인벤토리에 없는 행 = 드리프트', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    // 한 잡(outbound-flush)이 빠진 crontab으로 재인벤토리
    const reduced = SAMPLE.split('\n').filter(l => !l.includes('outbound-flush')).join('\n');
    inventoryCrontab(d, { crontab: reduced, now: '2026-07-07T10:10:00Z' });
    // last_seen이 2차 인벤토리(10:10) 이전인 crontab 행 = 사라진 것
    const drift = driftedSchedules(d, '2026-07-07T10:10:00Z');
    expect(drift.length).toBe(1);
    expect(drift[0]!.name).toBe('outbound-flush');
  });
});

test('watch default inventory adds only daemon jobs with a user source and reconciles opt-out without touching crontab', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-schedules-'));
  const d = db();
  try {
    inventoryCrontab(d, { crontab: SAMPLE });
    const original = listSchedules(d, { source: 'crontab' });
    const opts = { watchRoot: root, workflowSchedules: [], discoveryIntervalMs: 0 };
    inventoryInternalSchedules(d, opts);
    expect(listSchedules(d, { source: 'watch-default' })).toEqual([]);
    addSource({ id: 'my-topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    addSource({ id: 'other-topic', seat: 'MK', kind: 'github-query', spec: 'tools', every: '1d' }, root);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      inventoryInternalSchedules(d, opts);
      expect(log).toHaveBeenCalledWith('watch.default', 'scheduled', { topics: 1, items: 0, sent: false });
    } finally { log.mockRestore(); }
    expect(listSchedules(d, { source: 'watch-default' }).map(({ name, cron, command, run_via }) => ({ name, cron, command, run_via }))).toEqual([
      { name: 'watch-brief', cron: '30 8 * * *', command: 'intake digest --seat user --telegram', run_via: 'daemon' },
      { name: 'watch-collect', cron: '0 7 * * *', command: 'intake source run-due --seat user', run_via: 'daemon' },
    ]);
    inventoryInternalSchedules(d, opts);
    expect(listSchedules(d, { source: 'watch-default' })).toHaveLength(2);
    removeSource('my-topic', root);
    inventoryInternalSchedules(d, opts);
    expect(listSchedules(d, { source: 'watch-default' })).toEqual([]);
    addSource({ id: 'my-topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    inventoryInternalSchedules(d, opts);
    inventoryInternalSchedules(d, { ...opts, watchEnabled: false });
    expect(listSchedules(d, { source: 'watch-default' })).toEqual([]);
    expect(listSchedules(d, { source: 'crontab' })).toEqual(original);
    expect(listSchedules(d, { source: 'daily-reflection' })).toHaveLength(1);
  } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
});

describe('inventoryInternalSchedules — 내부 스케줄 통합 뷰 (B2)', () => {
  test('daily-reflection 등록 · run_via=daemon(러너 오발화 방지)', () => {
    const d = db();
    inventoryInternalSchedules(d, { reflectionHour: 21, now: '2026-07-07T10:00:00Z' });
    const dr = listSchedules(d, { source: 'daily-reflection' })[0]!;
    expect(dr.cron).toBe('0 21 * * *');
    expect(dr.run_via).toBe('daemon'); // 내 러너(run_via='elanous')와 구분
    expect(dr.category).toBe('report');
  });
  test('discovery는 interval 설정 시에만', () => {
    const d = db();
    inventoryInternalSchedules(d, { now: '2026-07-07T10:00:00Z' }); // env 미설정
    expect(listSchedules(d, { source: 'discovery' }).length).toBe(0);
    inventoryInternalSchedules(d, { discoveryIntervalMs: 60000, now: '2026-07-07T10:01:00Z' });
    expect(listSchedules(d, { source: 'discovery' }).length).toBe(1);
  });
  test('workflow-runtime schedule 트리거 편입(seam)', () => {
    const d = db();
    inventoryInternalSchedules(d, {
      now: '2026-07-07T10:00:00Z',
      workflowSchedules: [{ workflowName: 'daily-brief', nodeId: 'trig1', cron: '0 6 * * *' }],
    });
    const wf = listSchedules(d, { source: 'workflow-runtime' });
    expect(wf.length).toBe(1);
    expect(wf[0]!.name).toBe('daily-brief');
    expect(wf[0]!.cron).toBe('0 6 * * *');
    expect(wf[0]!.run_via).toBe('daemon');
  });
  test('crontab + 내부 통합 뷰 · 멱등', () => {
    const d = db();
    inventoryCrontab(d, { crontab: SAMPLE, now: '2026-07-07T10:00:00Z' });
    inventoryInternalSchedules(d, { now: '2026-07-07T10:00:00Z' });
    const all = listSchedules(d);
    expect(all.some(r => r.source === 'crontab')).toBe(true);
    expect(all.some(r => r.source === 'daily-reflection')).toBe(true);
    const before = listSchedules(d).length;
    inventoryInternalSchedules(d, { now: '2026-07-07T10:05:00Z' }); // 멱등
    expect(listSchedules(d).length).toBe(before);
  });
});

describe('crontab 쓰기 순수 변환 (S1)', () => {
  test('buildCronLine — elanous .ts는 cd+bun+로그 강제', () => {
    const line = buildCronLine('0 7 * * *', 'scripts/foo-report.ts --x', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('0 7 * * * cd /r && /b/bun scripts/foo-report.ts --x >> /tmp/foo-report.log 2>&1');
  });
  test('buildCronLine — 저장소 상대 .sh는 인터프리터와 무관하게 cd만 강제', () => {
    for (const command of ['zsh scripts/foo.sh', 'bash scripts/foo.sh', 'scripts/foo.sh']) {
      const line = buildCronLine('50 4 * * *', command, { repo: '/r', bun: '/b/bun' });
      expect(line).toBe(`50 4 * * * cd /r && ${command} >> /tmp/foo.log 2>&1`);
      expect(line).not.toContain('/b/bun');
    }
  });
  test('buildCronLine — 중첩 저장소 스크립트는 깊이와 확장자별 규칙을 따른다', () => {
    const nestedTypeScript = buildCronLine('0 0 1 1 *', 'scripts/botlab/heartbeat-emit.ts probe --print', { repo: '/r', bun: '/b/bun' });
    expect(nestedTypeScript).toBe('0 0 1 1 * cd /r && /b/bun scripts/botlab/heartbeat-emit.ts probe --print >> /tmp/heartbeat-emit.ts.log 2>&1');

    const multiLevelJavaScript = buildCronLine('0 0 1 1 *', 'scripts/a/b/c.js', { repo: '/r', bun: '/b/bun' });
    expect(multiLevelJavaScript).toBe('0 0 1 1 * cd /r && /b/bun scripts/a/b/c.js >> /tmp/c.js.log 2>&1');

    const nestedShell = buildCronLine('0 0 1 1 *', 'scripts/botlab/foo.sh', { repo: '/r', bun: '/b/bun' });
    expect(nestedShell).toBe('0 0 1 1 * cd /r && scripts/botlab/foo.sh >> /tmp/foo.sh.log 2>&1');
    expect(nestedShell).not.toContain('/b/bun');
  });
  test('buildCronLine — parent traversal scripts는 저장소 상대 스크립트로 취급하지 않는다', () => {
    const line = buildCronLine('0 0 1 1 *', 'scripts/../outside/x.ts', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('0 0 1 1 * scripts/../outside/x.ts >> /tmp/x.ts.log 2>&1');
    expect(line).not.toContain('cd /r &&');
    expect(line).not.toContain('/b/bun');
  });
  test('buildCronLine — 이미 완성형(.sh 절대경로)은 로그만 보강', () => {
    const line = buildCronLine('50 4 * * *', '/r/scripts/collect.sh');
    expect(line).toBe('50 4 * * * /r/scripts/collect.sh >> /tmp/collect.log 2>&1');
  });
  test('buildCronLine — 절대 선두 명령의 중첩 scripts 인수는 repo 래핑하지 않는다', () => {
    const line = buildCronLine('0 0 1 1 *', '/usr/bin/tool scripts/a/b.ts', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('0 0 1 1 * /usr/bin/tool scripts/a/b.ts >> /tmp/tool.log 2>&1');
    expect(line).not.toContain('cd /r &&');
    expect(line).not.toContain('/b/bun');
  });
  test('buildCronLine — 이미 cd 로 시작한 .sh는 이중 래핑하지 않는다', () => {
    const line = buildCronLine('50 4 * * *', 'cd /x && zsh scripts/foo.sh', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('50 4 * * * cd /x && zsh scripts/foo.sh >> /tmp/foo.log 2>&1');
  });
  test('buildCronLine — 전역 elanous CLI도 cd 강제(무음실패 근본수정·bun 프리픽스 없음)', () => {
    const line = buildCronLine('*/15 * * * *', 'elanous codex review-watch --once --auto-merge', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('*/15 * * * * cd /r && /b/bun bin/elanous.mjs codex review-watch --once --auto-merge >> /tmp/elanous.log 2>&1');
    expect(line).not.toMatch(/&& elanous(?:\s|$)/);
  });
  test('buildCronLine — bun bin/elanous.mjs도 cd 강제(이미 bun 있으면 그대로)', () => {
    const line = buildCronLine('0 3 * * *', 'bun bin/elanous.mjs autopilot list', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('0 3 * * * cd /r && /b/bun bin/elanous.mjs autopilot list >> /tmp/elanous.mjs.log 2>&1');
  });
  test('buildCronLine — 이미 cd 로 시작해도 후속 elanous를 절대 Bun 진입점으로 변환', () => {
    const line = buildCronLine('0 3 * * *', 'cd /r && elanous codex review-watch --once', { repo: '/other', bun: '/b/bun' });
    expect(line).toBe('0 3 * * * cd /r && /b/bun bin/elanous.mjs codex review-watch --once >> /tmp/elanous.log 2>&1');
    expect(line).not.toContain('cd /other');
    expect(line).not.toMatch(/(^|[;&]\s*)elanous(?=\s|$)/);
  });
  // 리뷰 블로커 반영 — 임의 절대 bun 경로(/usr/local/bin/bun 등)도 대상 Bun 진입점으로 정규화한다
  //   (종전 정규식은 bare `bun`·`*.bun/bin/bun` 만 인식해 다른 bun 설치 경로를 놓쳤다).
  test('buildCronLine — 임의 절대 bun 경로도 대상 Bun 으로 정규화(edge-case)', () => {
    const line = buildCronLine('*/15 * * * *', '/usr/local/bin/bun bin/elanous.mjs codex review-watch --once', { repo: '/r', bun: '/b/bun' });
    expect(line).toBe('*/15 * * * * cd /r && /b/bun bin/elanous.mjs codex review-watch --once >> /tmp/elanous.mjs.log 2>&1');
    expect(line).not.toContain('/usr/local/bin/bun');
  });
  // 리뷰 #5342 실버그 반영 — 인용 문자열 내부의 `; elanous`/`&& elanous` 는 셸 경계가 아니므로 변조 금지
  //   (선두 진입점에만 앵커). 후속 인자의 elanous 부분문자열도 무접촉.
  test('buildCronLine — 인용 문자열 내부 "; elanous" 는 변조하지 않는다(선두 앵커)', () => {
    const line = buildCronLine('0 5 * * *', 'scripts/foo.ts --msg "step; elanous done"', { repo: '/r', bun: '/b/bun' });
    expect(line).toContain('"step; elanous done"');   // 인용 내부 그대로
    expect(line).toBe('0 5 * * * cd /r && /b/bun scripts/foo.ts --msg "step; elanous done" >> /tmp/foo.log 2>&1');
  });
  test('addLineToCrontab — 추가 + 정확중복 방지', () => {
    const c0 = '0 4 * * * a\n';
    const c1 = addLineToCrontab(c0, '0 7 * * * b');
    expect(c1).toContain('0 7 * * * b');
    expect(addLineToCrontab(c1, '0 7 * * * b')).toBe(c1); // 중복 무시
  });
  test('removeLineFromCrontab — 활성/주석 변형 모두 제거', () => {
    expect(removeLineFromCrontab('x\n0 7 * * * b\ny\n', '0 7 * * * b')).toBe('x\ny\n');
    expect(removeLineFromCrontab('x\n# 0 7 * * * b\n', '0 7 * * * b')).toBe('x\n');
  });
  test('setLineEnabled — 주석 토글', () => {
    expect(setLineEnabled('0 7 * * * b\n', '0 7 * * * b', false)).toBe('# 0 7 * * * b\n');
    expect(setLineEnabled('# 0 7 * * * b\n', '0 7 * * * b', true)).toBe('0 7 * * * b\n');
  });
});

// wire 가드 — 실 crontab 파싱 스모크(현재 27잡이 파싱되는지, 오염 없이)
describe('실 crontab 스모크', () => {
  test('parseCronLine이 실 crontab 다수 라인을 파싱', () => {
    // readCrontab은 실 crontab을 읽으므로 여기선 파서 견고성만(합성).
    const lines = SAMPLE.split('\n').map(parseCronLine).filter(Boolean);
    expect(lines.length).toBe(7);
  });
});

describe('scheduleHealth(P2) — 밀린/실패 판정', () => {
  function seedElanous(cronLine: string) {
    const d = openSchedulesDb(':memory:');
    inventoryCrontab(d, { crontab: cronLine, now: '2026-07-07T00:00:00Z' });
    for (const r of listSchedules(d)) setRunVia(d, r.id, 'elanous');
    return d;
  }
  const now = new Date(2026, 6, 9, 10, 0, 0); // 목 10:00 로컬

  test('일간 잡 미실행 → stale', () => {
    const d = seedElanous('45 7 * * * cd /r && bun scripts/morning.ts >> /tmp/x.log 2>&1');
    const h = scheduleHealth(listSchedules(d), { now });
    expect(h.elanousTotal).toBe(1);
    expect(h.stale.length).toBe(1);
    expect(h.stale[0]!.name).toBe('morning');
    expect(h.stale[0]!.overdueMs).toBeGreaterThan(0);
  });

  test('직전 예정 이후 실행됨 → stale 아님', () => {
    const d = seedElanous('45 7 * * * cd /r && bun scripts/morning.ts >> /tmp/x.log 2>&1');
    const id = listSchedules(d)[0]!.id;
    markResult(d, id, { at: '2026-07-09T08:00:00Z', status: 'ok', via: 'tick' }); // 07:45 KST 이후
    const h = scheduleHealth(listSchedules(d), { now });
    expect(h.stale.length).toBe(0);
  });

  test('last_status=error → errored', () => {
    const d = seedElanous('45 7 * * * cd /r && bun scripts/morning.ts >> /tmp/x.log 2>&1');
    const id = listSchedules(d)[0]!.id;
    markResult(d, id, { at: '2026-07-09T08:00:00Z', status: 'error', exit: 1, via: 'tick' });
    const h = scheduleHealth(listSchedules(d), { now });
    expect(h.errored.length).toBe(1);
    expect(h.stale.length).toBe(0); // 실행은 됨(실패했을 뿐)
  });

  test('래핑된 crontab 잡은 실행 이력 없이도 모집단에 들어가 stale 이 된다', () => {
    const d = openSchedulesDb(':memory:');
    inventoryCrontab(d, { crontab: '45 7 * * * cd /r && bun scripts/cron-run.ts scripts/never-run.ts', now: '2026-07-07T00:00:00Z' });
    const h = scheduleHealth(listSchedules(d), { now });
    expect(h.elanousTotal).toBe(1);
    expect(h.excludedUnwrappedCrontab).toBe(0);
    expect(h.stale.map(job => job.name)).toEqual(['never-run']);
  });

  test('래핑 crontab의 실행 결과는 기존 stale·errored 판정을 유지한다', () => {
    const d = openSchedulesDb(':memory:');
    inventoryCrontab(d, { crontab: '45 7 * * * cd /r && bun scripts/cron-run.ts scripts/wrapped.ts', now: '2026-07-07T00:00:00Z' });
    const [row] = listSchedules(d);
    markResult(d, row!.id, { at: '2026-07-09T08:00:00Z', status: 'error', exit: 1, via: 'crontab' });
    const h = scheduleHealth(listSchedules(d), { now });
    expect(h.elanousTotal).toBe(1);
    expect(h.stale).toEqual([]);
    expect(h.errored.map(job => job.name)).toEqual(['wrapped']);
  });

  test('raw 줄을 buildCronLine 정규형과 비교해 정규형·비정규형·측정 불가를 구별한다', () => {
    const cron = '5 8 * * *';
    const repo = '/Users/example/source/demo/monad-agent';
    const bun = '/Users/example/.bun/bin/bun';
    const redirected = `${bun} scripts/cron-run.ts scripts/mission-request-judge.ts --root ${repo} --tick >> /tmp/mission-request-judge.log 2>&1`;
    const canonical = buildCronLine(cron, redirected, { repo, bun });
    const absoluteZsh = 'zsh /Users/example/source/demo/monad-agent/scripts/collect-market-backbone.sh >> /tmp/collect-market-backbone.log 2>&1';
    const relativeZsh = 'zsh scripts/collect-market-daily.sh >> /tmp/collect-market-daily.log 2>&1';
    const d = seedElanous([
      `${cron} ${redirected}`,
      canonical,
      `${cron} ${absoluteZsh}`,
      `${cron} ${relativeZsh}`,
    ].join('\n'));
    const h = scheduleHealth(listSchedules(d), { now, repo, bun });
    expect(h.noncanonical.map(j => j.name)).toEqual(['collect-market-daily', 'mission-request-judge']);
    expect(h.unmeasured).toEqual([]);

    const nestedCanonical = buildCronLine(cron, 'scripts/botlab/heartbeat-emit.ts probe --print', { repo, bun });
    const nested = seedElanous(nestedCanonical);
    expect(scheduleHealth(listSchedules(nested), { now, repo, bun }).noncanonical).toEqual([]);

    const withoutInputs = scheduleHealth(listSchedules(d), { now });
    expect(withoutInputs.noncanonical).toEqual([]);
    expect(withoutInputs.unmeasured).toHaveLength(4);
  });

  test('제외 사유별 계수는 모집단을 바꾸지 않고 상호배타적으로 구별한다', () => {
    const d = seedElanous('0 * * * * cd /r && bun scripts/managed.ts');
    const [managed] = listSchedules(d);
    const rows = [
      managed!,
      { ...managed!, id: 'unwrapped-crontab', run_via: 'crontab' },
      { ...managed!, id: 'mentions-wrapper', run_via: 'crontab', command: 'bun scripts/job.ts --note scripts/cron-run.ts' },
      { ...managed!, id: 'disabled', enabled: 0 },
      { ...managed!, id: 'missing-cron', cron: '' },
      { ...managed!, id: 'overlap', run_via: 'crontab', enabled: 0, cron: '' },
      { ...managed!, id: 'other-run-via', run_via: 'daemon' },
    ];
    const h = scheduleHealth(rows, { now });
    expect(h.elanousTotal).toBe(1);
    expect(h.excludedRunVia).toBe(1);
    expect(h.excludedUnwrappedCrontab).toBe(3);
    expect(h.excludedDisabled).toBe(1);
    expect(h.excludedMissingCron).toBe(1);
    expect(h.stale).toHaveLength(1);
    expect(h.errored).toEqual([]);
  });

  test('빈 레지스트리와 래퍼 없는 crontab만 있는 0-모집단은 제외 계수로 구별된다', () => {
    const empty = scheduleHealth([], { now });
    const d = seedElanous('0 * * * * cd /r && bun scripts/managed.ts');
    const [managed] = listSchedules(d);
    const crontabOnly = scheduleHealth([{ ...managed!, run_via: 'crontab' }], { now });
    expect(empty.elanousTotal).toBe(0);
    expect(empty.excludedRunVia).toBe(0);
    expect(empty.excludedUnwrappedCrontab).toBe(0);
    expect(empty.excludedDisabled).toBe(0);
    expect(empty.excludedMissingCron).toBe(0);
    expect(crontabOnly.elanousTotal).toBe(0);
    expect(crontabOnly.excludedRunVia).toBe(0);
    expect(crontabOnly.excludedUnwrappedCrontab).toBe(1);
    expect(crontabOnly.excludedDisabled).toBe(0);
    expect(crontabOnly.excludedMissingCron).toBe(0);
  });

  test('정규형과 앞뒤 공백만 달라도 비정규형으로 판정한다', () => {
    const cron = '5 8 * * *';
    const repo = '/repo';
    const bun = '/bun';
    const command = 'zsh /repo/scripts/collect-market-backbone.sh >> /tmp/collect-market-backbone.log 2>&1';
    const canonical = buildCronLine(cron, command, { repo, bun });
    const d = seedElanous(canonical);
    const [row] = listSchedules(d);
    const h = scheduleHealth([{ ...row!, raw: ` ${row!.raw}` }], { now, repo, bun });
    expect(h.noncanonical.map(j => j.name)).toEqual(['collect-market-backbone']);
  });
});

describe('setScheduleMission(AL2) — 오토파일럿 계보 태깅', () => {
  const CRON = '0 8 * * * cd /r && bun scripts/x.ts >> /tmp/x.log 2>&1';
  test('스탬프 후 조회 + 재인벤토리에도 보존', () => {
    const d = openSchedulesDb(':memory:');
    inventoryCrontab(d, { crontab: CRON, now: '2026-07-09T00:00:00Z' });
    const id = listSchedules(d)[0]!.id;
    setScheduleMission(d, id, 'apm_202607090830_test_abcdef');
    expect(listSchedules(d)[0]!.autopilot_id).toBe('apm_202607090830_test_abcdef');
    // 재스캔(ON CONFLICT) — autopilot_id 보존(note 정책과 동일)
    inventoryCrontab(d, { crontab: CRON, now: '2026-07-09T01:00:00Z' });
    expect(listSchedules(d)[0]!.autopilot_id).toBe('apm_202607090830_test_abcdef');
  });
});

// wire 가드 — schedule_manage 공유 모듈 + finance 위임 (S1·전 표면 리팩터)
describe('schedule_manage 배선 가드', () => {
  test('공유 모듈 schedule-manage-tool.ts에 spec+dispatch 구현', () => {
    const src = readFileSync(join(import.meta.dir, 'schedule-manage-tool.ts'), 'utf-8');
    expect(src).toContain("name: 'schedule_manage'");
    expect(src).toContain('export async function dispatchScheduleManage');
    expect(src).toContain('inventoryCrontab(sdb)');
    expect(src).toContain('applyCrontab(');
  });
  test('create 가 autopilotId 계보 스탬프(AL2)', () => {
    const src = readFileSync(join(import.meta.dir, 'schedule-manage-tool.ts'), 'utf-8');
    expect(src).toContain('args.autopilotId');
    expect(src).toContain('setScheduleMission(sdb');
  });
  test('L2 core-tools.ts가 공유 모듈(schedule-manage-tool)로 위임', () => {
    const src = readFileSync(join(import.meta.dir, 'core-tools.ts'), 'utf-8');
    expect(src).toContain('SCHEDULE_MANAGE_SPEC');
    expect(src).toContain('schedule_manage: dispatchScheduleManage');
  });
});


// ⭐⭐ 2026-08-19 — 「꺼둔 잡」이 목록에 «켜져 있다»고 뜨던 결함(F1·F2)의 회귀 방어.
//   ⛔ 뿌리: upsert 는 항상 enabled=1 로 덮는데, 주석 줄은 parseCronLine 이 null 을 내
//     아예 안 봤다 ⇒ enabled 를 «내리는 경로»가 코드에 존재하지 않았다.
//     실측(운영 crontab): 사람이 꺼둔 셋이 전부 enabled=true 로 「도는 중」처럼 보였고,
//     그중 하나는 살아 있는 동명 잡의 실행을 last_run 으로 «가져가» 더 그럴듯했다.
describe('꺼둔(주석) 잡 — enabled 를 내리는 경로', () => {
  const ACTIVE = '*/30 8-22 * * * cd /r && bun scripts/ops-health-check.ts >> /tmp/o.log 2>&1';

  test('활성 등록 뒤 주석 처리되면 enabled 가 0 으로 «내려간다» (행·id 는 남는다)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-08-19T00:00:00Z' });
    const before = listSchedules(d);
    expect(before.length).toBe(1);
    expect(before[0]!.enabled).toBe(1);

    const r = inventoryCrontab(d, { crontab: `# ${ACTIVE}`, now: '2026-08-19T01:00:00Z' });
    expect(r.total).toBe(0);      // 활성 줄 0
    expect(r.disabled).toBe(1);   // 「꺼진 것」으로 세었다
    const after = listSchedules(d);
    expect(after.length).toBe(1); // ⛔ 지우지 않는다 — 이력(last_run·note) 보존
    expect(after[0]!.enabled).toBe(0);
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  test('등록된 적 «없는» 주석 잡은 추가하지 않는다 (목록이 불어나지 않는다)', () => {
    const d = db();
    const r = inventoryCrontab(d, { crontab: `# ${ACTIVE}`, now: '2026-08-19T00:00:00Z' });
    expect(r.added).toBe(0);
    expect(r.disabled).toBe(0);
    expect(listSchedules(d).length).toBe(0);
  });

  test('다시 켜면 enabled 가 1 로 돌아온다 (가역)', () => {
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-08-19T00:00:00Z' });
    inventoryCrontab(d, { crontab: `# ${ACTIVE}`, now: '2026-08-19T01:00:00Z' });
    expect(listSchedules(d)[0]!.enabled).toBe(0);
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-08-19T02:00:00Z' });
    expect(listSchedules(d)[0]!.enabled).toBe(1);
  });

  test('관측성 래퍼로 감싼 줄을 주석 처리해도 «같은 id» 로 내려간다', () => {
    const wrapped = '*/30 8-22 * * * cd /r && bun scripts/cron-run.ts scripts/ops-health-check.ts >> /tmp/o.log 2>&1';
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-08-19T00:00:00Z' });
    const id = listSchedules(d)[0]!.id;
    const r = inventoryCrontab(d, { crontab: `# ${wrapped}`, now: '2026-08-19T01:00:00Z' });
    expect(r.disabled).toBe(1);
    const rows = listSchedules(d);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.enabled).toBe(0);
  });

  test('parseDisabledCronLine — 설명 주석·활성 줄은 null, 주석 cron 줄만 문다', () => {
    expect(parseDisabledCronLine('# 조율 채널 감시')).toBeNull();
    expect(parseDisabledCronLine('#')).toBeNull();
    expect(parseDisabledCronLine(ACTIVE)).toBeNull(); // 활성 줄은 이 파서 소관이 아니다
    expect(parseDisabledCronLine(`# ${ACTIVE}`)?.cron).toBe('*/30 8-22 * * *');
    expect(parseDisabledCronLine(`## ${ACTIVE}`)?.cron).toBe('*/30 8-22 * * *');
  });

  test('cronEntryId — 활성 줄과 그 줄의 주석판이 같은 id (켜고 끄는 동안 이력이 이어진다)', () => {
    const a = parseCronLine(ACTIVE)!;
    const b = parseDisabledCronLine(`# ${ACTIVE}`)!;
    expect(cronEntryId(a.cron, unwrapCronCommand(a.command)))
      .toBe(cronEntryId(b.cron, unwrapCronCommand(b.command)));
  });

  // ── F2: 「했다」고 말하는데 값이 안 변하는 것을 막는다 ──
  test('setLineEnabled 는 이미 그 상태면 «무변경»을 낸다 — F2 판정의 근거값', () => {
    const off = '# 0 7 * * * b\n';
    expect(setLineEnabled(off, '0 7 * * * b', false)).toBe(off);
    const on = '0 7 * * * b\n';
    expect(setLineEnabled(on, '0 7 * * * b', true)).toBe(on);
  });

  test('F2 — enable/disable 이 changed 를 산출에 담는다(거짓 성공 금지)', () => {
    const src = readFileSync(join(import.meta.dir, 'schedule-manage-tool.ts'), 'utf-8');
    expect(src).toContain('if (next === current)');
    expect(src).toContain('changed: false');
    expect(src).toContain('changed: true');
  });
});

// ⭐⭐ 2026-09-18 — crontab 에서 «지워진» 줄이 영영 enabled=1 로 남아 관측이 죽은 행에 적히던 결함.
//   주석 갈래만 있었고 통째 삭제 갈래가 없었다. prune 하지 않고 끄기만 한다.
describe('지워진 crontab 줄 — enabled 를 내리는 경로', () => {
  const ACTIVE = '*/30 8-22 * * * cd /r && bun scripts/ops-health-check.ts >> /tmp/o.log 2>&1';
  const OTHER = '0 7 * * * cd /r && bun scripts/morning.ts >> /tmp/m.log 2>&1';

  test('활성 등록 뒤 줄이 통째로 없으면 enabled 가 0 으로 내려가고 행은 남는다', () => {
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-09-18T00:00:00Z' });
    const before = listSchedules(d);
    expect(before.length).toBe(1);
    expect(before[0]!.enabled).toBe(1);

    const r = inventoryCrontab(d, { crontab: OTHER, now: '2026-09-18T01:00:00Z' });
    expect(r.total).toBe(1);
    expect(r.added).toBe(1);
    expect(r.disabled).toBe(0);   // 주석이 아니라 사라짐
    expect(r.vanished).toBe(1);
    const after = listSchedules(d);
    expect(after.length).toBe(2); // ⛔ 지우지 않는다 — prune 계약
    const gone = after.find(x => x.id === before[0]!.id)!;
    expect(gone.enabled).toBe(0);
    expect(after.find(x => x.name === 'morning')!.enabled).toBe(1);
  });

  test('내부 스케줄 행은 crontab 에 없어도 꺼지지 않는다', () => {
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-09-18T00:00:00Z' });
    inventoryInternalSchedules(d, { reflectionHour: 21, now: '2026-09-18T00:00:00Z' });
    const internal = listSchedules(d, { source: 'daily-reflection' })[0]!;
    expect(internal.enabled).toBe(1);

    const r = inventoryCrontab(d, { crontab: OTHER, now: '2026-09-18T01:00:00Z' });
    expect(r.vanished).toBe(1); // crontab-origin 한 줄만
    const still = listSchedules(d, { source: 'daily-reflection' })[0]!;
    expect(still.id).toBe(internal.id);
    expect(still.enabled).toBe(1);
  });

  test('빈 문자열 crontab 은 읽기 실패와 같아 아무 행도 끄지 않는다', () => {
    const d = db();
    inventoryCrontab(d, { crontab: ACTIVE, now: '2026-09-18T00:00:00Z' });
    expect(listSchedules(d)[0]!.enabled).toBe(1);

    const r = inventoryCrontab(d, { crontab: '', now: '2026-09-18T01:00:00Z' });
    expect(r.total).toBe(0);
    expect(r.disabled).toBe(0);
    expect(r.vanished).toBe(0);
    const after = listSchedules(d);
    expect(after.length).toBe(1);
    expect(after[0]!.enabled).toBe(1);
  });

  test('주석으로 끈 수와 사라져서 끈 수는 다른 칸이다', () => {
    const d = db();
    inventoryCrontab(d, { crontab: `${ACTIVE}\n${OTHER}`, now: '2026-09-18T00:00:00Z' });
    const r = inventoryCrontab(d, { crontab: `# ${ACTIVE}`, now: '2026-09-18T01:00:00Z' });
    expect(r.total).toBe(0);
    expect(r.disabled).toBe(1);  // 주석
    expect(r.vanished).toBe(1);  // OTHER 가 본문에 없음
    const rows = listSchedules(d);
    expect(rows.length).toBe(2);
    expect(rows.every(x => x.enabled === 0)).toBe(true);
  });

  test('cron-run 실제 진입이 삭제된 crontab 행을 enabled=0 으로 보존하고 관측에서 제외한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schedule-registry-cron-run-'));
    const stateDir = join(root, 'state');
    const homeDir = join(root, 'home');
    const binDir = join(root, 'bin');
    const workDir = join(root, 'work');
    mkdirSync(stateDir);
    mkdirSync(homeDir);
    mkdirSync(binDir);
    mkdirSync(join(workDir, 'scripts'), { recursive: true });

    const OLD_LINE = '0 8 * * * cd /r && bun scripts/cron-run.ts scripts/ops-health-check.ts >> /tmp/o.log 2>&1';
    const NEW_LINE = '0 9 * * * cd /r && bun scripts/cron-run.ts scripts/ops-health-check.ts >> /tmp/o.log 2>&1';
    const crontabState = join(root, 'crontab.txt');
    writeFileSync(crontabState, `${NEW_LINE}\n`);
    writeFileSync(join(binDir, 'crontab'), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${crontabState}"; exit 0; fi\nexit 0\n`);
    chmodSync(join(binDir, 'crontab'), 0o755);

    const target = join(workDir, 'scripts', 'ops-health-check.ts');
    writeFileSync(target, 'process.exit(0);\n');

    const dbPath = join(stateDir, 'schedules.db');
    let oldId = '';
    const setup = openSchedulesDb(dbPath);
    try {
      inventoryCrontab(setup, { crontab: OLD_LINE, now: '2026-09-18T00:00:00Z' });
      const before = listSchedules(setup);
      expect(before.length).toBe(1);
      expect(before[0]!.enabled).toBe(1);
      expect(before[0]!.name).toBe('ops-health-check');
      oldId = before[0]!.id;
      markResult(setup, oldId, { status: 'error', exit: 1, via: 'crontab' });
    } finally {
      setup.close();
    }

    try {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, '../../scripts/cron-run.ts'), target],
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...process.env,
          HOME: homeDir,
          ELANOUS_STATE_DIR: stateDir,
          ELANOUS_CONFIG_DIR: stateDir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('registry selection ambiguous');

      const afterDb = openSchedulesDb(dbPath);
      try {
        const after = listSchedules(afterDb);
        const oldRow = after.find(r => r.id === oldId)!;
        const liveRow = after.find(r => r.id !== oldId && r.name === 'ops-health-check')!;
        expect(after.length).toBe(2);
        expect(oldRow.enabled).toBe(0);
        expect(oldRow.last_status).toBe('error');
        expect(liveRow.enabled).toBe(1);
        expect(liveRow.last_status).toBe('ok');
      } finally {
        afterDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('trigger migration inventory reconciliation', () => {
  const migrated = '0 8 * * * cd /r && bun scripts/migrate-watch.ts';
  const unchanged = '0 9 * * * cd /r && bun scripts/ordinary.ts';

  test('live migration keeps trigger enabled after its crontab line disappears; ordinary vanished row is disabled', () => {
    const d = db();
    const store = new TaskStore({ path: ':memory:' });
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      const id = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      const entries: unknown[] = [];
      const result = migrateJobToTrigger({
        scheduleDb: d, store, registerWorkflow: entry => { entries.push(entry); },
        removeCrontabLine: raw => { expect(raw).toBe(migrated); },
      }, id);
      expect(result.registered).toBe(true);
      expect(result.crontabRemoved).toBe(true);
      expect(entries).toHaveLength(1);
      expect(inventoryCrontab(d, { crontab: '0 10 * * * echo keep' }).vanished).toBe(1);
      const migratedRow = listSchedules(d).find(r => r.id === id)!;
      expect(migratedRow).toMatchObject({ source: 'trigger', enabled: 1, run_via: 'trigger' });
      expect(scheduleHealth([migratedRow]).elanousTotal).toBe(1);
      expect(listSchedules(d).find(r => r.name === 'ordinary')).toMatchObject({ source: 'crontab', enabled: 0 });
    } finally { store.close(); d.close(); }
  });

  test('a remaining active crontab line cannot re-enable a disabled trigger without provenance', () => {
    const d = db();
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      const id = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      d.run(`UPDATE schedule_registry SET run_via = 'trigger', enabled = 0, last_via = 'trigger' WHERE id = ?`, [id]);
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      expect(listSchedules(d).find(r => r.id === id)).toMatchObject({ run_via: 'trigger', enabled: 0, disabled_reason: null });
    } finally { d.close(); }
  });

  test('a commented former crontab line does not mark a live migrated trigger as disabled', () => {
    const d = db();
    const store = new TaskStore({ path: ':memory:' });
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      const id = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      migrateJobToTrigger({ scheduleDb: d, store, registerWorkflow: () => {} }, id);
      inventoryCrontab(d, { crontab: `# ${migrated}\n${unchanged}` });
      expect(listSchedules(d).find(r => r.id === id)).toMatchObject({ source: 'trigger', enabled: 1, run_via: 'trigger' });
    } finally { store.close(); d.close(); }
  });

  test('legacy crontab-origin trigger that has not fired stays enabled when its line vanishes', () => {
    const d = db();
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      const first = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      setRunVia(d, first, 'trigger');
      const result = inventoryCrontab(d, { crontab: unchanged });
      expect(result.vanished).toBe(0);
      expect(listSchedules(d).find(r => r.id === first)).toMatchObject({ source: 'crontab', run_via: 'trigger', enabled: 1 });
    } finally { d.close(); }
  });

  test('legacy crontab-origin trigger stays enabled when its old line is commented; ordinary commented row turns off', () => {
    const d = db();
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}` });
      const id = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      setRunVia(d, id, 'trigger');
      const result = inventoryCrontab(d, { crontab: `# ${migrated}\n# ${unchanged}` });
      expect(result).toMatchObject({ disabled: 1, vanished: 0 });
      expect(listSchedules(d).find(r => r.id === id)).toMatchObject({ source: 'crontab', run_via: 'trigger', enabled: 1, disabled_reason: null });
      expect(listSchedules(d).find(r => r.name === 'ordinary')).toMatchObject({ source: 'crontab', run_via: 'crontab', enabled: 0 });
    } finally { d.close(); }
  });

  test('unknown disable provenance cannot repair a previously fired trigger', () => {
    const d = db();
    try {
      inventoryCrontab(d, { crontab: migrated });
      const id = listSchedules(d)[0]!.id;
      d.run(`UPDATE schedule_registry SET source = 'crontab', run_via = 'trigger', enabled = 0,
        last_via = 'trigger', disabled_reason = NULL WHERE id = ?`, [id]);
      inventoryCrontab(d, { crontab: '0 10 * * * echo keep' });
      expect(listSchedules(d).find(row => row.id === id)).toMatchObject({
        source: 'crontab', enabled: 0, run_via: 'trigger', last_via: 'trigger', disabled_reason: null,
      });
    } finally { d.close(); }
  });

  test('inventory-vanished fired triggers are repaired; manual and unproven disabled rows stay off', () => {
    const d = db();
    const originalLog = debug.log;
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const manual = '0 11 * * * cd /r && bun scripts/manual.ts';
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (event === 'trigger-row-repaired') events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      inventoryCrontab(d, { crontab: `${migrated}\n${unchanged}\n${manual}` });
      const first = listSchedules(d).find(r => r.name === 'migrate-watch')!.id;
      const second = listSchedules(d).find(r => r.name === 'ordinary')!.id;
      const third = listSchedules(d).find(r => r.name === 'manual')!.id;
      inventoryCrontab(d, { crontab: `${unchanged}\n${manual}` });
      expect(listSchedules(d).find(r => r.id === first)).toMatchObject({ enabled: 0, disabled_reason: 'vanished' });
      d.run(`UPDATE schedule_registry SET run_via = 'trigger', last_via = 'trigger' WHERE id = ?`, [first]);
      // A disabled row that has never fired through the trigger stays off.
      d.run(`UPDATE schedule_registry SET run_via = 'trigger', enabled = 0, last_via = NULL WHERE id = ?`, [second]);
      d.run(`UPDATE schedule_registry SET run_via = 'trigger', last_via = 'trigger', enabled = 0, disabled_reason = 'manual' WHERE id = ?`, [third]);
      inventoryCrontab(d, { crontab: `${unchanged}\n# ${manual}` });
      expect(listSchedules(d).find(r => r.id === third)).toMatchObject({ enabled: 0, disabled_reason: 'manual' });
      d.run(`UPDATE schedule_registry SET enabled = 0, disabled_reason = NULL WHERE id = ?`, [second]);
      inventoryCrontab(d, { crontab: '0 10 * * * echo keep' });
      expect(listSchedules(d).find(r => r.id === first)).toMatchObject({ source: 'trigger', enabled: 1, disabled_reason: null, run_via: 'trigger' });
      expect(listSchedules(d).find(r => r.id === second)).toMatchObject({ source: 'crontab', enabled: 0, disabled_reason: null });
      expect(listSchedules(d).find(r => r.id === third)).toMatchObject({ source: 'crontab', enabled: 0, disabled_reason: 'manual' });
      expect(events).toEqual([{ category: 'schedule.registry', event: 'trigger-row-repaired', data: { id: first } }]);
      inventoryCrontab(d, { crontab: '0 10 * * * echo keep' });
      expect(events).toHaveLength(1);
    } finally { debug.log = originalLog; d.close(); }
  });
});

// 🆕 2026-09-24 — 설치본에서 만든 크론이 곧 지워질 판 폴더로 cd 하지 않는다.
import { cronRepoRoot } from './schedule-registry.js';
describe('cronRepoRoot', () => {
  const installed = '/home/u/.local/share/elanous/versions/1.0.0-abc/node_modules/elanous';
  const noGit = (p: string) => !p.endsWith('.git') || false;
  test('installed copy reads ops.cronRepoRoot from a loaded config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-config-'));
    const { getUserConfig } = require('../user-config.js') as typeof import('../user-config.js');
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ ops: { cronRepoRoot: '/configured/root' } }));
      expect(getUserConfig(path).ops?.cronRepoRoot).toBe('/configured/root');
      expect(cronRepoRoot(installed, { exists: () => false, configuredRoot: () => getUserConfig(path).ops?.cronRepoRoot })).toBe('/configured/root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('installed copy uses configured ops.cronRepoRoot when set', () => {
    expect(cronRepoRoot(installed, { exists: () => false, configuredRoot: () => '/src/pilot' })).toBe('/src/pilot');
  });
  test('installed copy without configuration uses the stable current path, never the version dir', () => {
    expect(cronRepoRoot(installed, { exists: () => false, configuredRoot: () => undefined })).toBe('/home/u/.local/share/elanous/current/node_modules/elanous');
    expect(cronRepoRoot(installed, { exists: () => false, configuredRoot: () => '   ' })).toBe('/home/u/.local/share/elanous/current/node_modules/elanous');
  });
  test('a checkout is returned unchanged', () => {
    expect(cronRepoRoot('/src/pilot', { exists: noGit, configuredRoot: () => '/elsewhere' })).toBe('/src/pilot');
    expect(cronRepoRoot('/src/app/versions/x/node_modules/elanous', { exists: (p) => p === '/src/app/.git', configuredRoot: () => undefined })).toBe('/src/app/versions/x/node_modules/elanous');
  });
});

// 🆕 2026-09-24 R3 — 설치본 current 로 cd 하는 줄도 정규.
import { installedCronRoot, scheduleHealth as scheduleHealthR3, buildCronLine as buildCronLineR3 } from './schedule-registry.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

describe('schedule health — installed current path is canonical too', () => {
  const now = new Date('2026-09-24T08:00:00Z');
  const row = (raw: string) => ({ id: 'a', name: 'a', cron: '*/5 * * * *', command: 'scripts/x.ts', raw, run_via: 'elanous', enabled: 1, last_run: now.toISOString(), last_status: 'ok' }) as never;
  const inst = '/home/u/.local/share/elanous/current/node_modules/elanous';
  test('a line cd-ing to the installed root is canonical only when that root is passed', () => {
    const raw = buildCronLineR3('*/5 * * * *', 'scripts/x.ts', { repo: inst, bun: '/b/bun' });
    expect(scheduleHealthR3([row(raw)], { now, repo: '/src/pilot', bun: '/b/bun' }).noncanonical.length).toBe(1);
    expect(scheduleHealthR3([row(raw)], { now, repo: '/src/pilot', bun: '/b/bun', alsoCanonicalRepos: [inst] }).noncanonical.length).toBe(0);
  });
  test('installedCronRoot honors ELANOUS_INSTALL_PREFIX, XDG_DATA_HOME, and existence', () => {
    expect(installedCronRoot({ ELANOUS_INSTALL_PREFIX: '/p' }, () => true, '/home/u')).toBe('/p/current/node_modules/elanous');
    expect(installedCronRoot({ XDG_DATA_HOME: '/x' }, () => true, '/home/u')).toBe('/x/elanous/current/node_modules/elanous');
    expect(installedCronRoot({}, () => true, '/home/u')).toBe(inst);
    expect(installedCronRoot({}, () => false, '/home/u')).toBeNull();
  });
});
