import { describe, expect, test } from 'bun:test';
import { chmod, exists, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSchedulesDb } from '../src/domains/schedule-registry.js';

const REPOSITORY_ROOT = join(import.meta.dir, '..');
const WRAPPER = join(REPOSITORY_ROOT, 'scripts', 'cron-run.ts');
const CRON_RUN = new URL('./cron-run.ts', import.meta.url).pathname;

async function runCron(
  observabilityBody: string | null,
  options: { targetBody?: string; preloadBody?: string; registryMock?: string; shell?: boolean; scheduleId?: string; targetArgs?: string[]; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; home: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'cron-run-test-'));
  const home = await mkdtemp(join(tmpdir(), 'cron-run-home-'));
  const target = join(directory, options.shell ? 'target.sh' : 'target.ts');
  const module = join(directory, 'observability.ts');
  const preload = join(directory, 'preload.ts');
  await writeFile(target, options.targetBody ?? (options.shell ? 'exit 7\n' : 'process.exit(7);\n'));
  if (observabilityBody !== null) await writeFile(module, observabilityBody);
  if (options.preloadBody || options.registryMock) await writeFile(preload, `${options.preloadBody ?? ''}${options.registryMock ?? ''}`);
  try {
    const startedAt = Date.now();
    const child = Bun.spawn({
      cmd: [process.execPath, ...(options.preloadBody || options.registryMock ? ['--preload', preload] : []), WRAPPER, ...(options.scheduleId ? ['--schedule-id', options.scheduleId] : []), ...(options.shell ? ['--shell', '/bin/sh'] : []), target, ...(options.targetArgs ?? [])],
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        HOME: home,
        CRON_RUN_OBSERVABILITY_MODULE: observabilityBody === null ? join(directory, 'missing.ts') : module,
        ...options.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      home,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

describe('cron-run observation diagnostics', () => {
  test('is reached by dispatchScheduleManage wrap through its generated crontab line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cron-run-crontab-'));
    const crontab = join(directory, 'crontab');
    const crontabState = join(directory, 'crontab.txt');
    await writeFile(crontabState, '*/15 * * * * cd /repo && bun scripts/example.ts >> /tmp/example.log 2>&1\n');
    await writeFile(crontab, `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${crontabState}"; else cat > "${crontabState}"; fi\n`);
    await chmod(crontab, 0o755);
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, '--eval', "import('./src/domains/schedule-manage-tool.js').then(({ dispatchScheduleManage }) => dispatchScheduleManage({ action: 'wrap', yes: true }))"],
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).toBe(0);
      expect(await readFile(crontabState, 'utf8')).toMatch(/bun scripts\/cron-run\.ts --schedule-id [0-9a-f]+ scripts\/example\.ts/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reports one import failure line and preserves the child exit code', async () => {
    const result = await runCron(null);
    expect(result.exitCode).toBe(7);
    expect(result.stderr.split('\n').filter((line) => line.startsWith('cron-run observation import failed:'))).toHaveLength(1);
    expect(result.stderr).not.toContain('cron-run observation record failed:');
  });

  test('reports one record rejection line and preserves the child exit code', async () => {
    const result = await runCron("export function recordScheduledExecution(): Promise<void> { return Promise.reject(new Error('record rejected')); }\n");
    expect(result.exitCode).toBe(7);
    expect(result.stderr.split('\n').filter((line) => line === 'cron-run observation record failed: record rejected')).toHaveLength(1);
    expect(result.stderr).not.toContain('cron-run observation import failed:');
  });

  test('waits for a delayed diagnostic write before preserving the child exit code', async () => {
    const result = await runCron(
      "export function recordScheduledExecution(): Promise<void> { return Promise.reject(new Error('record rejected')); }\n",
      {
        preloadBody: "const write = process.stderr.write.bind(process.stderr);\nprocess.stderr.write = ((chunk: string, callback?: () => void) => { setTimeout(() => { write(chunk); callback?.(); }, 100); return true; }) as typeof process.stderr.write;\n",
      },
    );
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('cron-run observation record failed: record rejected\n');
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });

  test('reports prerequisite acquisition failure and preserves the child exit code', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron('export function recordScheduledExecution(): void {}\n', {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: (name: string) => name, openSchedulesDb: () => { throw new Error('registry unavailable'); } }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr.split('\n').filter((line) => line === 'cron-run observation prerequisite failed: registry unavailable')).toHaveLength(1);
  });

  test('reports a falsy prerequisite acquisition failure and preserves the child exit code', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron('export function recordScheduledExecution(): void {}\n', {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: (name: string) => name, openSchedulesDb: () => { throw ''; } }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr.split('\n').filter((line) => line === 'cron-run observation prerequisite failed:')).toHaveLength(1);
  });

  test('reports a distinct skipped record diagnostic when no schedule row exists', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron('export function recordScheduledExecution(): void {}\n', {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: (name: string) => name, openSchedulesDb: () => ({ close() {} }), inventoryCrontab() {}, listSchedules: () => [] }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr.split('\n').filter((line) => line.startsWith('cron-run observation registry record skipped: schedule row not found for '))).toHaveLength(1);
    expect(result.stderr).not.toContain('cron-run observation prerequisite failed:');
  });

  test('records only the explicit schedule id when another enabled row has the same name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cron-run-schedule-id-'));
    const crontab = join(directory, 'crontab');
    await writeFile(crontab, '#!/bin/sh\nexit 1\n');
    await chmod(crontab, 0o755);
    const db = openSchedulesDb(join(directory, 'schedules.db'));
    try {
      for (const [id, lastStatus] of [['first-id', 'ok'], ['selected-id', 'error']] as const) {
        db.run(`INSERT INTO schedule_registry (id, name, source, category, enabled, last_status, last_exit)
          VALUES (?, 'target', 'crontab', 'maintenance', 1, ?, 99)`, [id, lastStatus]);
      }
      const result = await runCron(`export { recordScheduledExecution } from ${JSON.stringify(join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-observability.ts'))};\n`, {
        scheduleId: 'selected-id',
        shell: true,
        targetBody: 'printf "arg=%s\\n" "$1"\nexit 7\n',
        targetArgs: ['--payload'],
        env: { ELANOUS_STATE_DIR: directory, ELANOUS_CONFIG_DIR: directory, PATH: `${directory}:${process.env.PATH}` },
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe('arg=--payload\n');
      expect(result.stderr).not.toContain('registry selection ambiguous');
      const rows = db.query(`SELECT id, last_status, last_exit, last_run, last_via FROM schedule_registry ORDER BY id`).all() as Array<{
        id: string; last_status: string | null; last_exit: number | null; last_run: string | null; last_via: string | null;
      }>;
      expect(rows[0]).toEqual({ id: 'first-id', last_status: 'ok', last_exit: 99, last_run: null, last_via: null });
      expect(rows[1]).toMatchObject({ id: 'selected-id', last_status: 'error', last_exit: 7, last_via: 'crontab' });
      expect(rows[1]?.last_run).not.toBeNull();
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not fall back to name matching when the explicit id is absent', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron("export function recordScheduledExecution(_name: string, _record: unknown, options: { id?: string }): void { process.stderr.write(`selected=${options.id ?? 'none'}\\n`); }\n", {
      scheduleId: 'missing-id',
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: () => 'target', openSchedulesDb: () => ({ close() {}, query: () => ({ get: () => undefined }) }), inventoryCrontab() {}, listSchedules: () => { throw new Error('name matching must not run'); } }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('selected=none');
    expect(result.stderr).toContain('cron-run observation registry record skipped:');
    expect(result.stderr).not.toContain('name matching must not run');
  });

  test('records the first enabled duplicate instead of an earlier disabled row', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron("export function recordScheduledExecution(_name: string, _record: unknown, options: { id?: string }): void { process.stderr.write(`selected=${options.id}\\n`); }\n", {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: () => 'target.ts', openSchedulesDb: () => ({ close() {} }), inventoryCrontab() {}, listSchedules: () => [{ id: 'disabled-id', name: 'target.ts', enabled: false, last_status: 'error' }, { id: 'enabled-id', name: 'target.ts', enabled: true, last_status: null }] }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('selected=enabled-id');
    expect(result.stderr).not.toContain('cron-run observation');
  });

  test('records the first enabled duplicate and reports ambiguous enabled rows', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron("export function recordScheduledExecution(_name: string, _record: unknown, options: { id?: string }): void { process.stderr.write(`selected=${options.id}\\n`); }\n", {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: () => 'target.ts', openSchedulesDb: () => ({ close() {} }), inventoryCrontab() {}, listSchedules: () => [{ id: 'enabled-first-id', name: 'target.ts', enabled: true, last_status: null }, { id: 'enabled-second-id', name: 'target.ts', enabled: true, last_status: 'error' }] }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('cron-run observation registry selection ambiguous: multiple enabled schedule rows for target.ts; recording enabled-first-id');
    expect(result.stderr).toContain('selected=enabled-first-id');
  });

  test('emits no per-fire observation diagnostic after successful recording of a unique row', async () => {
    const registry = join(REPOSITORY_ROOT, 'src', 'domains', 'schedule-registry.js');
    const result = await runCron('export function recordScheduledExecution(): void {}\n', {
      registryMock: `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(registry)}, () => ({ scriptName: () => 'target.ts', openSchedulesDb: () => ({ close() {} }), inventoryCrontab() {}, listSchedules: () => [{ id: 'schedule-id', name: 'target.ts', enabled: true, last_status: null }] }));\n`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).not.toContain('cron-run observation');
  });

  test('removes the isolated HOME directory after each wrapper run', async () => {
    const result = await runCron('export function recordScheduledExecution(): void {}\n');
    expect(await exists(result.home)).toBeFalse();
  });
});

describe('cron-run observation wrapper', () => {
  test('--shell invokes the interpreter with target and arguments while recording the target, stderr tail, and exit code', async () => {
    const result = await runCron(
      'export function recordScheduledExecution(name: string, record: unknown): void { process.stderr.write(`record=${JSON.stringify({ name, record })}\\n`); }\n',
      {
        shell: true,
        targetBody: 'printf "out=%s|%s|%s\\n" "$1" "$2" "$CRON_RUN_TEST_VALUE"\nprintf "first\\nsecond\\n" >&2\nexit 23\n',
        targetArgs: ['one two', '--literal=$HOME'],
        env: { CRON_RUN_TEST_VALUE: 'inherited' },
      },
    );
    expect(result.exitCode).toBe(23);
    expect(result.stdout).toBe('out=one two|--literal=$HOME|inherited\n');
    expect(result.stderr).toContain('first\nsecond\n');
    const recorded = result.stderr.match(/^record=(.*)$/m);
    expect(recorded).not.toBeNull();
    const { name, record } = JSON.parse(recorded![1]!) as {
      name: string;
      record: { status: string; exit: number; via: string; error: string };
    };
    // 레지스트리가 `<해석기> <경로>.sh` 줄에 붙이는 이름과 같아야 행을 찾는다.
    expect(name).toBe('target');
    expect(record).toMatchObject({ status: 'error', exit: 23, via: 'crontab', error: 'first\nsecond' });
  });

  test('rejects --schedule-id without an id before starting a child', async () => {
    const proc = Bun.spawn([process.execPath, CRON_RUN, '--schedule-id', '--shell', '/bin/sh'], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('cron-run: --schedule-id 인자 필수');
  });

  test.each(['missing interpreter', 'missing target'])('rejects an incomplete --shell invocation: %s', async (caseName) => {
    const args = caseName === 'missing interpreter' ? ['--shell'] : ['--shell', '/bin/sh'];
    const proc = Bun.spawn([process.execPath, CRON_RUN, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('cron-run: target script 인자 필수');
  });

  test('target 없이 실행하면 자식을 띄우지 않고 사용 오류로 종료한다', async () => {
    const proc = Bun.spawn([process.execPath, CRON_RUN], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('cron-run: target script 인자 필수');
  });
});
