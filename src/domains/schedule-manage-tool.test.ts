import { test, expect, describe } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEDULE_MANAGE_SPEC, compactSchedule, dispatchScheduleManage } from './schedule-manage-tool.js';
import { cronEntryId, openSchedulesDb, parseCronLine, repoRoot, schedulesDbPath, unwrapCronCommand } from './schedule-registry.js';

const schedule = (command: string, extra: Record<string, unknown> = {}) => ({
  id: 'weekly-alpha', name: 'weekly-alpha', cron: '0 7 * * 1', interval_ms: null,
  category: 'report', source: 'crontab', enabled: 1, run_via: 'crontab', last_run: null,
  command, note: null, raw: `0 7 * * 1 ${command}`, last_seen: '2026-09-05T00:00:00.000Z', domain: null,
  last_status: null, last_exit: null, last_duration_ms: null, last_error: null,
  ...extra,
}) as any;

describe('dispatchScheduleManage wrap — explicit shell jobs', () => {
  test('dry-run lists shell and Bun jobs, counts interpreter-free .sh, and --yes backs up and preserves ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schedule-wrap-shell-'));
    const bin = join(root, 'crontab');
    const state = join(root, 'crontab.txt');
    const lines = [
      '0 7 * * * zsh $HOME/s/intake-cron.sh',
      '20 4 * * * bash /x/backup.sh --source cron >> /tmp/b.log 2>&1',
      '0 6 * * 1 cd /r && /bin/bash scripts/verify.sh',
      '0 */6 * * * cd /r && scripts/m.sh gcpvm',
      '15 8 * * * ./scripts/x.sh',
      '10 8 * * * cd /r && bun scripts/report.ts --runner bash /x/backup.sh',
      '0 11 * * * zsh /x/intake.sh --runner bun scripts/report.ts',
      '0 12 * * * FOO=bar bun scripts/report.ts',
      '0 13 * * * env bun scripts/report.ts',
    ];
    writeFileSync(state, `${lines.join('\n')}\n`);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${state}"; else cat > "${state}"; fi\n`);
    chmodSync(bin, 0o755);
    const previous = { state: process.env.ELANOUS_STATE_DIR, config: process.env.ELANOUS_CONFIG_DIR, path: process.env.PATH };
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.PATH = `${root}:${previous.path ?? ''}`;
    try {
      const dry = await dispatchScheduleManage({ action: 'wrap' }) as { dryRun: boolean; count: number; jobs: string[]; skippedShell: number };
      expect(dry).toMatchObject({ dryRun: true, count: 7, skippedShell: 2 });
      expect(dry.jobs).toEqual(['intake-cron', 'backup', 'verify', 'report', 'intake', 'report', 'report']);
      expect(readFileSync(state, 'utf8')).toBe(`${lines.join('\n')}\n`);
      const result = await dispatchScheduleManage({ action: 'wrap', yes: true }) as { wrapped: number; backup: string; jobs: string[]; skippedShell: number };
      expect(result.wrapped).toBe(7);
      expect(result.skippedShell).toBe(2);
      expect(result.jobs).toEqual(dry.jobs);
      expect(readFileSync(result.backup, 'utf8')).toBe(`${lines.join('\n')}\n`);
      const applied = readFileSync(state, 'utf8').trimEnd().split('\n');
      expect(applied[0]).toContain(`${process.execPath} ${join(repoRoot(), 'scripts', 'cron-run.ts')} --shell zsh `);
      expect(applied[1]).toContain('cron-run.ts --shell bash /x/backup.sh --source cron >> /tmp/b.log 2>&1');
      expect(applied[2]).toContain('cron-run.ts --shell /bin/bash scripts/verify.sh');
      expect(applied.slice(3, 5)).toEqual(lines.slice(3, 5));
      expect(applied[5]).toContain('bun scripts/cron-run.ts scripts/report.ts');
      expect(applied[6]).toContain('cron-run.ts --shell zsh /x/intake.sh --runner bun scripts/report.ts');
      expect(applied[7]).toContain('FOO=bar bun scripts/cron-run.ts scripts/report.ts');
      expect(applied[8]).toContain('env bun scripts/cron-run.ts scripts/report.ts');
      for (const i of [0, 1, 2, 5, 6, 7, 8]) {
        const original = parseCronLine(lines[i]!)!;
        const wrapped = parseCronLine(applied[i]!)!;
        expect(cronEntryId(wrapped.cron, unwrapCronCommand(wrapped.command)))
          .toBe(cronEntryId(original.cron, unwrapCronCommand(original.command)));
      }
      const again = await dispatchScheduleManage({ action: 'wrap' }) as { wrapped: number; skippedShell: number };
      expect(again).toMatchObject({ wrapped: 0, skippedShell: 2 });
      const undo = await dispatchScheduleManage({ action: 'unwrap', yes: true }) as { unwrapped: number; backup: string };
      expect(undo.unwrapped).toBe(7);
      expect(readFileSync(undo.backup, 'utf8')).toBe(`${applied.join('\n')}\n`);
      expect(readFileSync(state, 'utf8')).toBe(`${lines.join('\n')}\n`);
      writeFileSync(state, `${lines[0]}\n${lines[3]}\n`);
      const oneSkipped = await dispatchScheduleManage({ action: 'wrap' }) as { dryRun: boolean; jobs: string[]; skippedShell: number };
      expect(oneSkipped).toMatchObject({ dryRun: true, jobs: ['intake-cron'], skippedShell: 1 });
      expect(readFileSync(state, 'utf8')).toBe(`${lines[0]}\n${lines[3]}\n`);
    } finally {
      for (const [key, value] of Object.entries({ ELANOUS_STATE_DIR: previous.state, ELANOUS_CONFIG_DIR: previous.config, PATH: previous.path })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('compactSchedule — command truncation observability', () => {
  test('marks commands longer than 120 characters while retaining the 120-character command prefix', () => {
    const command = 'x'.repeat(121);
    const result = compactSchedule(schedule(command));

    expect(result.command).toBe(command.slice(0, 120));
    expect(result.command).toHaveLength(120);
    expect(result.command_truncated).toBe(true);
  });

  test.each([119, 120])('preserves the exact legacy output for a %i-character command', (length) => {
    const command = 'x'.repeat(length);
    const result = compactSchedule(schedule(command));

    expect(result).toEqual(expect.objectContaining({
      id: 'weekly-alpha', name: 'weekly-alpha', cron: '0 7 * * 1', interval_ms: null,
      category: 'report', source: 'crontab', enabled: true, run_via: 'crontab', last_run: null,
      command, note: null, execution_history_available: false,
    }));
    expect(result).not.toHaveProperty('command_truncated');
  });

  test('marks only unwrapped crontab schedules as unable to record execution history', () => {
    const unwrapped = schedule('bun scripts/tree-sync-apply.ts');
    const wrapped = schedule('bun scripts/cron-run.ts tree-sync-apply bun scripts/tree-sync-apply.ts');
    const internal = { ...unwrapped, source: 'workflow-runtime', raw: null };

    expect(compactSchedule(unwrapped)).toEqual(expect.objectContaining({ execution_history_available: false }));
    expect(compactSchedule(wrapped)).not.toHaveProperty('execution_history_available');
    expect(compactSchedule(internal)).not.toHaveProperty('execution_history_available');
  });

  test('dispatchScheduleManage list returns the truncation marker for a stored 121-character command', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'schedule-manage-list-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const command = 'x'.repeat(121);
    process.env.ELANOUS_STATE_DIR = stateDir;
    const db = openSchedulesDb(schedulesDbPath());
    try {
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab')`,
        ['list-long-command', 'list-long-command', '0 7 * * 1', command, `0 7 * * 1 ${command}`],
      );
      const result = await dispatchScheduleManage({ action: 'list' }) as {
        schedules: Array<{ id: string; command: string; command_truncated?: boolean }>;
      };
      const listed = result.schedules.find((item) => item.id === 'list-long-command');

      expect(listed).toEqual(expect.objectContaining({
        command: command.slice(0, 120),
        command_truncated: true,
      }));
      expect(listed?.command).toHaveLength(120);
    } finally {
      db.close();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('list and inspect expose unavailable execution history while preserving legacy fields', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'schedule-manage-history-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const command = 'bun scripts/tree-sync-apply.ts';
    const raw = `0 7 * * 1 ${command}`;
    const lastRun = '2026-09-03T00:42:00.000Z';
    process.env.ELANOUS_STATE_DIR = stateDir;
    const db = openSchedulesDb(schedulesDbPath());
    try {
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via, last_run)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab', ?)`,
        ['unwrapped-crontab', 'unwrapped-crontab', '0 7 * * 1', command, raw, lastRun],
      );
      const list = await dispatchScheduleManage({ action: 'list' }) as {
        schedules: Array<{ id: string; command: string; last_run: string | null; execution_history_available?: boolean }>;
      };
      const inspect = await dispatchScheduleManage({ action: 'inspect', id: 'unwrapped-crontab' }) as {
        schedule: { command: string; last_run: string | null; raw: string; execution_history_available?: boolean };
      };
      const listed = list.schedules.find((item) => item.id === 'unwrapped-crontab');

      expect(listed).toEqual(expect.objectContaining({
        command,
        last_run: lastRun,
        execution_history_available: false,
      }));
      expect(inspect.schedule).toEqual(expect.objectContaining({
        command,
        last_run: lastRun,
        raw,
        execution_history_available: false,
      }));
    } finally {
      db.close();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('inspect dispatch preserves the full raw command while compacting command with its truncation marker', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'schedule-manage-inspect-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const command = 'x'.repeat(121);
    const raw = `0 7 * * 1 ${command}`;
    process.env.ELANOUS_STATE_DIR = stateDir;
    const db = openSchedulesDb(schedulesDbPath());
    try {
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab')`,
        ['inspect-long-command', 'inspect-long-command', '0 7 * * 1', command, raw],
      );
      const result = await dispatchScheduleManage({ action: 'inspect', id: 'inspect-long-command' }) as {
        schedule: { command: string; command_truncated?: boolean; raw: string };
      };

      expect(result.schedule.command).toBe(command.slice(0, 120));
      expect(result.schedule.command).toHaveLength(120);
      expect(result.schedule.command_truncated).toBe(true);
      expect(result.schedule.raw).toBe(raw);
    } finally {
      db.close();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('compactSchedule — last-run result projection', () => {
  test('projects last_status, last_exit, last_duration_ms, and last_error from the ledger', () => {
    const result = compactSchedule(schedule('bun scripts/cron-run.ts weekly-alpha bun scripts/weekly-alpha.ts', {
      last_status: 'error',
      last_exit: 1,
      last_duration_ms: 4200,
      last_error: 'boom',
    }));

    expect(result).toEqual(expect.objectContaining({
      last_status: 'error',
      last_exit: 1,
      last_duration_ms: 4200,
      last_error: 'boom',
    }));
    expect(result).not.toHaveProperty('last_error_truncated');
  });

  test('keeps unknown (never-run) distinct from failure', () => {
    const neverRun = compactSchedule(schedule('bun scripts/cron-run.ts weekly-alpha bun scripts/weekly-alpha.ts'));
    const failed = compactSchedule(schedule('bun scripts/cron-run.ts weekly-alpha bun scripts/weekly-alpha.ts', {
      last_status: 'error',
      last_exit: 1,
      last_duration_ms: 12,
      last_error: 'exit 1',
    }));

    expect(neverRun.last_status).toBeNull();
    expect(neverRun.last_exit).toBeNull();
    expect(neverRun.last_duration_ms).toBeNull();
    expect(neverRun.last_error).toBeNull();
    expect(failed.last_status).toBe('error');
    expect(failed.last_exit).toBe(1);
    expect(failed.last_error).toBe('exit 1');
    expect(neverRun.last_status).not.toBe(failed.last_status);
    expect(neverRun.last_exit).not.toBe(failed.last_exit);
    expect(neverRun.last_error).not.toBe(failed.last_error);
  });

  test('truncates last_error with the same 120-character discipline as command', () => {
    const lastError = 'e'.repeat(121);
    const result = compactSchedule(schedule('bun scripts/cron-run.ts weekly-alpha bun scripts/weekly-alpha.ts', {
      last_status: 'error',
      last_exit: 2,
      last_duration_ms: 9,
      last_error: lastError,
    }));

    expect(result.last_error).toBe(lastError.slice(0, 120));
    expect(result.last_error).toHaveLength(120);
    expect(result.last_error_truncated).toBe(true);
  });

  test.each([119, 120])('does not mark last_error_truncated for a %i-character error', (length) => {
    const lastError = 'e'.repeat(length);
    const result = compactSchedule(schedule('bun scripts/cron-run.ts weekly-alpha bun scripts/weekly-alpha.ts', {
      last_status: 'error',
      last_exit: 1,
      last_error: lastError,
    }));

    expect(result.last_error).toBe(lastError);
    expect(result).not.toHaveProperty('last_error_truncated');
  });

  test('unavailable execution history is unreadability, not absence of result fields', () => {
    const result = compactSchedule(schedule('bun scripts/tree-sync-apply.ts', {
      last_status: 'error',
      last_exit: 1,
      last_duration_ms: 88,
      last_error: 'boom',
    }));

    expect(result).toEqual(expect.objectContaining({
      execution_history_available: false,
      last_status: 'error',
      last_exit: 1,
      last_duration_ms: 88,
      last_error: 'boom',
    }));
  });

  test('list and inspect propagate last-run result fields including unknown-vs-failure', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'schedule-manage-result-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    const db = openSchedulesDb(schedulesDbPath());
    try {
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via,
            last_run, last_status, last_exit, last_duration_ms, last_error)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab',
                 ?, ?, ?, ?, ?)`,
        [
          'failed-job', 'failed-job', '0 7 * * 1',
          'bun scripts/cron-run.ts failed-job bun scripts/failed-job.ts',
          '0 7 * * 1 bun scripts/cron-run.ts failed-job bun scripts/failed-job.ts',
          '2026-09-18T13:17:33.490Z', 'error', 1, 4200, 'boom',
        ],
      );
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab')`,
        [
          'never-run', 'never-run', '0 8 * * 1',
          'bun scripts/cron-run.ts never-run bun scripts/never-run.ts',
          '0 8 * * 1 bun scripts/cron-run.ts never-run bun scripts/never-run.ts',
        ],
      );
      const longError = 'e'.repeat(121);
      db.run(
        `INSERT INTO schedule_registry
           (id, name, source, cron, interval_ms, command, category, enabled, managed_by, raw, run_via,
            last_run, last_status, last_exit, last_duration_ms, last_error)
         VALUES (?, ?, 'crontab', ?, NULL, ?, 'report', 1, 'manual', ?, 'crontab',
                 ?, ?, ?, ?, ?)`,
        [
          'long-error', 'long-error', '0 9 * * 1',
          'bun scripts/cron-run.ts long-error bun scripts/long-error.ts',
          '0 9 * * 1 bun scripts/cron-run.ts long-error bun scripts/long-error.ts',
          '2026-09-18T13:17:33.490Z', 'error', 2, 9, longError,
        ],
      );

      const list = await dispatchScheduleManage({ action: 'list' }) as {
        schedules: Array<{
          id: string;
          last_status: string | null;
          last_exit: number | null;
          last_duration_ms: number | null;
          last_error: string | null;
          last_error_truncated?: boolean;
        }>;
      };
      const failedInspect = await dispatchScheduleManage({ action: 'inspect', id: 'failed-job' }) as {
        schedule: {
          last_status: string | null;
          last_exit: number | null;
          last_duration_ms: number | null;
          last_error: string | null;
        };
      };
      const neverInspect = await dispatchScheduleManage({ action: 'inspect', id: 'never-run' }) as {
        schedule: {
          last_status: string | null;
          last_exit: number | null;
          last_duration_ms: number | null;
          last_error: string | null;
        };
      };
      const longInspect = await dispatchScheduleManage({ action: 'inspect', id: 'long-error' }) as {
        schedule: { last_error: string | null; last_error_truncated?: boolean };
      };

      const listedFailed = list.schedules.find((item) => item.id === 'failed-job');
      const listedNever = list.schedules.find((item) => item.id === 'never-run');
      const listedLong = list.schedules.find((item) => item.id === 'long-error');

      expect(listedFailed).toEqual(expect.objectContaining({
        last_status: 'error', last_exit: 1, last_duration_ms: 4200, last_error: 'boom',
      }));
      expect(listedNever).toEqual(expect.objectContaining({
        last_status: null, last_exit: null, last_duration_ms: null, last_error: null,
      }));
      expect(listedFailed?.last_status).not.toBe(listedNever?.last_status);
      expect(failedInspect.schedule).toEqual(expect.objectContaining({
        last_status: 'error', last_exit: 1, last_duration_ms: 4200, last_error: 'boom',
      }));
      expect(neverInspect.schedule).toEqual(expect.objectContaining({
        last_status: null, last_exit: null, last_duration_ms: null, last_error: null,
      }));
      expect(listedLong?.last_error).toBe(longError.slice(0, 120));
      expect(listedLong?.last_error_truncated).toBe(true);
      expect(longInspect.schedule.last_error).toBe(longError.slice(0, 120));
      expect(longInspect.schedule.last_error_truncated).toBe(true);
    } finally {
      db.close();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('SCHEDULE_MANAGE_SPEC — 공유 spec', () => {
  test('이름/파라미터 형태', () => {
    expect(SCHEDULE_MANAGE_SPEC.name).toBe('schedule_manage');
    const props = (SCHEDULE_MANAGE_SPEC.parameters as any).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['action', 'id', 'cron', 'command', 'category']));
  });
  test('dispatchScheduleManage는 함수', () => {
    expect(typeof dispatchScheduleManage).toBe('function');
  });
  test('migrate 액션(fabric Schedule Trigger 이관·B안) 노출·배선', () => {
    const props = (SCHEDULE_MANAGE_SPEC.parameters as any).properties;
    expect(props.action.description).toContain('migrate');
    const src = readFileSync(join(import.meta.dir, 'schedule-manage-tool.ts'), 'utf-8');
    expect(src).toContain("action === 'migrate'");
    expect(src).toContain('migrateJobToTrigger');
    // raw 부재 가드보다 앞(elanous 러너 잡도 이관) — 소스 순서 가드
    expect(src.indexOf("action === 'migrate'")).toBeLessThan(src.indexOf('원문 부재(수정 불가)'));
  });
});

// ── 전 표면 배선 가드 (대표 지시 — telegram/PWA/CLI 전 표면 상속) ──
describe('전 표면 배선 가드 (L2 코어 도구 — 단일 출처 상속)', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf-8');

  // schedule_manage 는 이제 L2 코어 앱 도구(core-tools.ts)로 단일 등록되고, 전 서피스는
  // buildCoreTools() 로 상속한다(finance 팩·표면별 개별 배선 제거·대표 지시 2026-07-08).
  test('L2 core-tools 가 schedule_manage 를 SCHEDULE_MANAGE_SPEC 로 등록', () => {
    const src = read('core-tools.ts');
    expect(src).toContain("from './schedule-manage-tool.js'");
    expect(src).toContain('SCHEDULE_MANAGE_SPEC');
    expect(src).toContain('schedule_manage: dispatchScheduleManage');
  });
  // ★ turn 조립기 통일 Phase 0(#5083) 이후 — CLI/daemon 은 core 를 buildSharedAppTools(core+finance
  //   gated) 단일 헬퍼로 상속(buildCoreTools 는 그 안에서 호출). core-tools.test 갱신본과 정합.
  //   (이 복제 가드는 #5083 에서 갱신 누락 → false-failing 이던 것을 Phase 2 에서 수복 — 제1원칙.)
  test('데몬 toolSurface(PWA/iOS/discord/TUI): buildSharedAppTools 상속', () => {
    const src = read('../boot/daemon-tools/index.ts');
    expect(src).toContain('buildSharedAppTools(financeCfg)');
    expect(src).toContain('shared.names.has(name)');
  });
  test('CLI buildCliAgentTools: buildSharedAppTools 상속', () => {
    const src = read('../index.ts');
    expect(src).toContain('buildSharedAppTools(cfg)');
  });
  test('continuation(telegram·자율루프): buildCoreTools 조립', () => {
    const src = read('../dispatch/continuation-turn-runner.ts');
    expect(src).toContain('buildCoreTools()');
  });
  test('finance 팩은 schedule_manage 를 더 이상 품지 않는다(강결합 해소)', () => {
    const src = read('finance-tools.ts');
    expect(src).not.toContain('SCHEDULE_MANAGE_SPEC');
  });
});
