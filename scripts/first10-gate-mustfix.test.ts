// Must-fix regression tests for PR #30536 (repair head 777c862749b4a08d8067f582b0a407b55a423bfd,
// review ta-20261022-e0a4f8):
//  1. --source URL passes through to install.sh verbatim; only local files are resolve()d.
//  2. buildRecord scrubs each string field, never the serialized JSON (stderr `token=abc"`
//     used to leave a bare quote and break JSON.parse).
//  3. A dry rehearsal's 0 ms phases are placeholders, never measurements — the record must
//     not publish a positive 600 s decision ("within") from them (mustFix 2).
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildRecord,
  installSourceArg,
  runInstallPhase,
  type CliArgs,
  type RecorderRecord,
} from './first10-gate.js';

// Real CLI spawns can exceed Bun's 5 s default under load (K-OP-035).
setDefaultTimeout(60_000);

const baseArgs = (source?: string): CliArgs => ({
  record: '/dev/null',
  home: '/tmp/first10-mustfix-home',
  prefix: '/tmp/first10-mustfix-prefix',
  stateDir: '/tmp/first10-mustfix-state',
  ...(source !== undefined ? { source } : {}),
  lang: 'en',
  dry: false,
  help: false,
});

describe('runInstallPhase --source', () => {
  const echoInstallerRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'first10-mustfix-'));
    mkdirSync(join(repo, 'scripts'));
    const installer = join(repo, 'scripts', 'install.sh');
    writeFileSync(installer, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n');
    chmodSync(installer, 0o755);
    return repo;
  };

  test('passes an https:// source URL through verbatim — never a resolved local path', () => {
    const url = 'https://example.com/elanous.tgz';
    const phase = runInstallPhase(baseArgs(url), echoInstallerRepo());
    expect(phase.stdout).toContain(url);
    expect(phase.stdout).not.toContain(resolve(url));
    expect(phase.stdout).not.toContain('https:/example.com');
  });

  test('resolves a local --source file to an absolute path', () => {
    const cwd = process.cwd();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'first10-mustfix-src-'));
      process.chdir(dir);
      writeFileSync('fixture.tgz', 'tarball-bytes');
      const phase = runInstallPhase(baseArgs('fixture.tgz'), echoInstallerRepo());
      expect(existsSync(resolve('fixture.tgz'))).toBe(true);
      expect(resolve('fixture.tgz')).not.toBe('fixture.tgz');
      expect(phase.stdout).toContain(resolve('fixture.tgz'));
      expect(phase.stdout).not.toContain(' fixture.tgz');
    } finally {
      process.chdir(cwd);
    }
  });

  test('installSourceArg: URL verbatim, local resolved', () => {
    const url = 'https://example.com/elanous.tgz';
    expect(installSourceArg(url)).toBe(url);
    expect(installSourceArg('fixture.tgz')).toBe(resolve('fixture.tgz'));
  });
});

describe('buildRecord scrub regression', () => {
  test('stderr with an escaped-quote secret (token=abc") does not throw and is scrubbed per-field', () => {
    const input = {
      locale: 'en' as const,
      source: { kind: 'tarball' as const, ref: 'ghp_ABCDEFGHIJKLMNOP1234.tgz' },
      phases: {
        install: {
          rc: 0,
          stdout: 'installed sk-abcdef1234567890 ok',
          stderr: 'token=abc"',
          elapsedMonotonicMs: 123,
        },
        firstRun: {
          rc: 0,
          stdout: 'ready api_key=supersecret123',
          stderr: 'fine',
          elapsedMonotonicMs: 456,
        },
      },
      answerEvidence: 'Bearer abcdef123456.789xyz',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    let record!: ReturnType<typeof buildRecord>;
    expect(() => {
      record = buildRecord(input);
    }).not.toThrow();
    expect(JSON.parse(JSON.stringify(record))).toBeDefined();
    expect(record.phases.install.stderr).not.toContain('abc"');
    expect(record.phases.install.stderr).toContain('[REDACTED]');
    expect(record.phases.install.stdout).toContain('[REDACTED]');
    expect(record.phases.install.stdout).not.toContain('sk-abcdef1234567890');
    expect((record.phases.firstRun?.stdout) ?? '').not.toContain('supersecret123');
    expect(record.answerEvidence ?? '').not.toContain('Bearer abcdef123456.789xyz');
    expect(record.source.ref).not.toContain('ghp_ABCDEFGHIJKLMNOP1234');
    expect(record.missingFields).toContain('source.tarballSha256');
  });
});

// mustFix 2 (review ta-20261022-e0a4f8): a dry rehearsal's phase timings are 0 ms placeholders,
// not measurements — the record must never publish a positive 600 s decision ("within") from
// them. Source head 777c862749b4 evaluated the placeholders against the threshold and recorded
// decision600s "within" on Mac dry ko/en runs.
describe('dry rehearsal never publishes a 600 s timing decision (mustFix 2)', () => {
  const dryPhases = {
    install: { rc: 0, stdout: '[dry-run]', stderr: '', elapsedMonotonicMs: 0 },
    firstRun: { rc: 2, stdout: '[dry-run]', stderr: '[dry-run] first-run not measured', elapsedMonotonicMs: 0 },
  };

  test('buildRecord: dry record has decision600s null plus the missing-timing marker, usefulResult unmeasured', () => {
    const record = buildRecord({
      locale: 'ko',
      source: { kind: 'checkout', ref: '/repo' },
      cliVersion: '0.2.36',
      phases: dryPhases,
      answerEvidence: null,
      createdAt: '2026-10-22T00:00:00.000Z',
    });
    expect(record.mode).toBe('dry');
    expect(record.decision600s).toBe(null);
    expect(record.missingFields).toContain('decision600s');
    expect(record.usefulResult).toBe('unmeasured');
  });

  test('buildRecord: real measured timing keeps the existing 600 s decision (within/over), unchanged', () => {
    const real = (installMs: number, firstRunMs: number) =>
      buildRecord({
        locale: 'en',
        source: { kind: 'checkout', ref: '/repo' },
        cliVersion: '0.2.36',
        phases: {
          install: { rc: 0, stdout: 'installed', stderr: '', elapsedMonotonicMs: installMs },
          firstRun: { rc: 0, stdout: 'ready', stderr: '', elapsedMonotonicMs: firstRunMs },
        },
        answerEvidence: 'first useful answer line',
        createdAt: '2026-10-22T00:00:00.000Z',
      });
    const within = real(100_000, 400_000);
    const over = real(300_000, 400_000);
    expect(within.decision600s).toBe('within');
    expect(within.missingFields).not.toContain('decision600s');
    expect(over.decision600s).toBe('over');
    expect(over.missingFields).not.toContain('decision600s');
  });

  test.skipIf(process.platform === 'darwin')('CLI: a real --dry ko run records decision600s null (stdout n/a), never "within"', () => {
    const home = mkdtempSync(join(tmpdir(), 'first10-mustfix-dry-'));
    try {
      const out = join(home, 'record.json');
      const r = spawnSync('bun', [
        join(import.meta.dir, 'first10-gate.ts'),
        '--record', out,
        '--home', home,
        '--prefix', join(home, '.local/share/elanous'),
        '--state-dir', join(home, '.elanous'),
        '--lang', 'ko',
        '--dry',
      ], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      const raw = readFileSync(out, 'utf8');
      const rec = JSON.parse(raw) as RecorderRecord;
      expect(rec.mode).toBe('dry');
      expect(rec.usefulResult).toBe('unmeasured');
      expect(rec.decision600s).toBe(null);
      expect(raw).toContain('"decision600s": null');
      expect(rec.missingFields).toContain('decision600s');
      expect(raw).not.toContain('"within"');
      expect(r.stdout).toContain('usefulResult=unmeasured');
      expect(r.stdout).toContain('decision600s=n/a');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});