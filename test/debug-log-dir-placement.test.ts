import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKING_DIR_MODULE = join(REPO_ROOT, 'src/session/working-dir.ts');
const DEBUG_LOG_MODULE = join(REPO_ROOT, 'src/debug/log.ts');
const BIN = join(REPO_ROOT, 'bin/elanous.mjs');
const created: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

function resolveInFreshProcess(sessionCwd: string, home: string): string {
  const probe = `
    import { setSessionCwd } from ${JSON.stringify(WORKING_DIR_MODULE)};
    setSessionCwd(${JSON.stringify(sessionCwd)}, 'tool');
    const { debugLogDir } = await import(${JSON.stringify(DEBUG_LOG_MODULE)});
    console.log(debugLogDir());
  `;
  const result = Bun.spawnSync({
    cmd: ['bun', '--eval', probe],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('debug log directory placement', () => {
  test('keeps source-contained session logs at <SWD>/log', () => {
    const sourceSession = mkdtempSync(join(REPO_ROOT, '.debug-log-placement-source-'));
    created.push(sourceSession);
    const home = temp('debug-log-placement-home-');

    expect(resolveInFreshProcess(sourceSession, home)).toBe(join(sourceSession, 'log'));
    expect(existsSync(join(sourceSession, 'log'))).toBe(true);
  });

  test('keeps a source-contained ..foo path at <SWD>/log', () => {
    const sourceSession = join(REPO_ROOT, `..foo-debug-log-placement-${process.pid}-${Date.now()}`);
    mkdirSync(sourceSession);
    created.push(sourceSession);
    const home = temp('debug-log-placement-home-');

    expect(resolveInFreshProcess(sourceSession, home)).toBe(join(sourceSession, 'log'));
    expect(existsSync(join(sourceSession, 'log'))).toBe(true);
  });

  test('places a nested external project session log under the nearest project marker', () => {
    const project = temp('debug-log-placement-project-root-');
    const session = join(project, 'sub', 'deeper');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    const home = temp('debug-log-placement-home-');

    expect(resolveInFreshProcess(session, home)).toBe(join(project, '.elanous', 'debug'));
    expect(existsSync(join(project, '.elanous', 'debug'))).toBe(true);
    expect(existsSync(join(session, '.elanous', 'debug'))).toBe(false);
  });

  test('puts an external sibling-prefix project under .elanous/debug without creating root log', () => {
    const externalProject = join(
      dirname(REPO_ROOT),
      `${basename(REPO_ROOT)}-external-${process.pid}-${Date.now()}`,
    );
    mkdirSync(externalProject);
    writeFileSync(join(externalProject, 'package.json'), '{}');
    created.push(externalProject);
    const home = temp('debug-log-placement-home-');

    expect(resolveInFreshProcess(externalProject, home)).toBe(join(externalProject, '.elanous', 'debug'));
    expect(existsSync(join(externalProject, '.elanous', 'debug'))).toBe(true);
    expect(existsSync(join(externalProject, 'log'))).toBe(false);
  });

  test('falls back to the existing home debug directory when an internal target cannot be created', () => {
    const sourceSession = mkdtempSync(join(REPO_ROOT, '.debug-log-placement-unwritable-'));
    created.push(sourceSession);
    writeFileSync(join(sourceSession, 'log'), 'not a directory');
    const home = temp('debug-log-placement-home-');

    expect(resolveInFreshProcess(sourceSession, home)).toBe(join(home, '.local', 'share', 'elanous', 'debug'));
    expect(existsSync(join(home, '.local', 'share', 'elanous', 'debug'))).toBe(true);
  });

  test('does not adopt a home marker for an unmarked external session', () => {
    const home = temp('debug-log-placement-home-');
    const session = join(home, 'unmarked', 'sub');
    mkdirSync(join(home, '.elanous'), { recursive: true });
    mkdirSync(session, { recursive: true });

    expect(resolveInFreshProcess(session, home)).toBe(join(session, '.elanous', 'debug'));
    expect(existsSync(join(home, '.elanous', 'debug'))).toBe(false);
  });

  test('the deployed CLI leaves an unrelated project root without log/', () => {
    const fixture = temp('debug-log-placement-isolated-tmp-');
    const isolatedTmpdir = join(fixture, 'tmp');
    mkdirSync(join(isolatedTmpdir, '.elanous'), { recursive: true });
    const project = mkdtempSync(join(isolatedTmpdir, 'project-'));
    const home = join(fixture, 'home');
    const configDir = join(home, '.elanous');
    const stateDir = join(home, 'state');
    const result = Bun.spawnSync({
      cmd: ['bun', BIN, '--config-dir', configDir, '--help'],
      cwd: project,
      env: { ...process.env, TMPDIR: isolatedTmpdir, HOME: home, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, 'log'))).toBe(false);
    expect(existsSync(join(project, '.elanous', 'debug'))).toBe(true);
    expect(existsSync(join(isolatedTmpdir, '.elanous', 'debug'))).toBe(false);
  });
});
