import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildRecord,
  installSourceArg,
  mapOutcomeToUsefulResult,
  repoRootOf,
  scrubSecrets,
  sha256,
  validateIsolation,
  type RecorderRecord,
} from './first10-gate.js';
import { existsSync, writeFileSync } from 'node:fs';

// Real CLI spawns can exceed Bun's 5 s default under load (K-OP-035).
setDefaultTimeout(120_000);

const REAL_HOME = '/home/real-user';
const ISOLATED_HOME = '/tmp/first10-isolated-home';

// FIRST10-GATE: 격리 경로 검증 — recorder가 HOME/PREFIX/ELANOUS_STATE_DIR 격리를 확인하고
// 운영 기본 경로(${XDG_DATA_HOME:-$HOME/.local/share}/elanous, 운영 ~/.elanous,
// install.sh의 different installation prefix 거부 경로)를 거부한다.
describe('validateIsolation', () => {
  test('accepts an isolated home/prefix/state dir', () => {
    const r = validateIsolation({
      home: ISOLATED_HOME,
      prefix: `${ISOLATED_HOME}/.local/share/elanous`,
      stateDir: `${ISOLATED_HOME}/.elanous`,
      realHome: REAL_HOME,
    });
    expect(r.ok).toBe(true);
  });

  test('refuses the operating default data prefix', () => {
    const r = validateIsolation({
      home: REAL_HOME,
      prefix: `${REAL_HOME}/.local/share/elanous`,
      stateDir: `${ISOLATED_HOME}/.elanous`,
      realHome: REAL_HOME,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('operating default prefix');
  });

  test('refuses XDG_DATA_HOME-based operating default prefix', () => {
    const r = validateIsolation({
      home: ISOLATED_HOME,
      prefix: '/xdg-data/elanous',
      stateDir: `${ISOLATED_HOME}/.elanous`,
      realHome: REAL_HOME,
      xdgDataHome: '/xdg-data',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('operating default prefix');
  });

  test('refuses the operating prod state dir ~/.elanous', () => {
    const r = validateIsolation({
      home: ISOLATED_HOME,
      prefix: `${ISOLATED_HOME}/.local/share/elanous`,
      stateDir: `${REAL_HOME}/.elanous`,
      realHome: REAL_HOME,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('operating state dir');
  });

  test('refuses a prefix outside the isolated home (different installation prefix guard)', () => {
    const r = validateIsolation({
      home: ISOLATED_HOME,
      prefix: '/elsewhere/elanous',
      stateDir: `${ISOLATED_HOME}/.elanous`,
      realHome: REAL_HOME,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('outside the isolated home');
  });

  test('refuses a state dir outside the isolated home', () => {
    const r = validateIsolation({
      home: ISOLATED_HOME,
      prefix: `${ISOLATED_HOME}/.local/share/elanous`,
      stateDir: '/elsewhere/.elanous',
      realHome: REAL_HOME,
    });
    expect(r.ok).toBe(false);
  });
});

// FIRST10-GATE: outcome → usefulResult 매핑 — outcome ≠ ready인 run은 unmeasured/failed,
// 'pass'는 절대 쓰지 않는다.
describe('mapOutcomeToUsefulResult', () => {
  test('needs-llm maps to failed', () => {
    expect(mapOutcomeToUsefulResult({ outcome: 'needs-llm' })).toBe('failed');
  });
  test('cancelled maps to unmeasured', () => {
    expect(mapOutcomeToUsefulResult({ outcome: 'cancelled' })).toBe('unmeasured');
  });
  test('ready without answer evidence maps to unmeasured, not pass', () => {
    expect(mapOutcomeToUsefulResult({ outcome: 'ready' })).toBe('unmeasured');
  });
  test('ready with answer evidence maps to measured', () => {
    expect(mapOutcomeToUsefulResult({ outcome: 'ready', answerEvidence: '첫 답변 한 줄' })).toBe('measured');
  });
  test('unknown outcome maps to unmeasured', () => {
    expect(mapOutcomeToUsefulResult({ outcome: 'unknown' })).toBe('unmeasured');
  });
});

// FIRST10-GATE: secret 위생 — token/secret이 레코드에 남지 않는다(first-run.test.ts 패턴).
describe('scrubSecrets', () => {
  test('removes api keys and tokens from captured output', () => {
    const dirty = 'key sk-abcdef1234567890 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 Bearer abc.def.ghi';
    const clean = scrubSecrets(dirty);
    expect(clean).not.toContain('sk-abcdef1234567890');
    expect(clean).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(clean).not.toContain('abc.def.ghi');
  });
  test('removes key/value style secrets', () => {
    expect(scrubSecrets('{"apiKey": "super-secret-value-123"}')).not.toContain('super-secret-value-123');
  });
});

// FIRST10-GATE: 레코드 스키마 — 한 JSON에 phase rc/stdout/stderr/elapsed, locale, source,
// CLI version, errorCount, 600s 판정, missingFields, usefulResult.
describe('buildRecord', () => {
  const base = {
    locale: 'ko' as const,
    source: { kind: 'checkout' as const, ref: '/repo', tarballSha256: 'deadbeef' },
    cliVersion: '0.2.36',
    phases: {
      install: { rc: 0, stdout: 'installed', stderr: '', elapsedMonotonicMs: 1_000 },
      firstRun: { rc: 2, stdout: '', stderr: 'needs llm', elapsedMonotonicMs: 500 },
    },
    answerEvidence: null,
    createdAt: '2026-10-23T00:00:00Z',
  };

  test('fills every schema field and maps needs-llm to failed', () => {
    const r = buildRecord(base);
    expect(r.schema).toBe('first10-gate/1');
    expect(r.locale).toBe('ko');
    expect(r.source.tarballSha256).toBe('deadbeef');
    expect(r.cliVersion).toBe('0.2.36');
    expect(r.phases.install.rc).toBe(0);
    expect(r.phases.firstRun?.stderr).toBe('needs llm');
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.decision600s).toBe('within');
    expect(r.missingFields).toContain('answerEvidence');
    expect(r.usefulResult).toBe('failed');
    expect((r as unknown as Record<string, unknown>).pass).toBeUndefined();
  });

  test('missing first-run phase yields decision600s null and a missingFields entry', () => {
    const r = buildRecord({ ...base, cliVersion: undefined, phases: { install: base.phases.install }, source: { kind: 'checkout', ref: '/repo' } });
    expect(r.phases.firstRun).toBeUndefined();
    expect(r.decision600s).toBeNull();
    expect(r.missingFields).toContain('cliVersion');
    expect(r.missingFields).toContain('phases.firstRun');
  });

  test('over-600s total maps decision600s to over', () => {
    const r = buildRecord({
      ...base,
      phases: {
        install: { rc: 0, stdout: '', stderr: '', elapsedMonotonicMs: 400_000 },
        firstRun: { rc: 0, stdout: '', stderr: '', elapsedMonotonicMs: 400_000 },
      },
    });
    expect(r.decision600s).toBe('over');
  });

  test('fixture-only record is never a real macOS card claim', () => {
    const r: RecorderRecord = buildRecord(base);
    expect(r.usefulResult).not.toBe('pass');
    expect(r.usefulResult).not.toBe('measured');
  });
});

// FIRST10-GATE: dry 리허설 타이밍(review ta-20261022-e0a4f8 mustFix 2) — dry phase의
// 0ms elapsed는 placeholder이지 측정이 아니므로 600초 긍정 판정("within")을 내면 안 된다.
// source head 777c862749의 buildRecord는 dry도 within으로 판정했다 — 이 단언은 그 head에서 실패한다.
describe('dry rehearsal timing (mustFix 2)', () => {
  const dryPhases = {
    install: { rc: 0, stdout: '[dry-run]', stderr: '', elapsedMonotonicMs: 0 },
    firstRun: { rc: 2, stdout: '[dry-run]', stderr: '[dry-run] first-run not measured', elapsedMonotonicMs: 0 },
  };

  test('buildRecord: dry record has decision600s null plus the missing-timing marker, usefulResult unmeasured', () => {
    const r = buildRecord({
      locale: 'ko',
      source: { kind: 'checkout', ref: '/repo' },
      cliVersion: '0.2.36',
      phases: dryPhases,
      answerEvidence: null,
      createdAt: '2026-10-23T00:00:00Z',
    });
    expect(r.mode).toBe('dry');
    expect(r.decision600s).toBe(null);
    expect(r.missingFields).toContain('decision600s');
    expect(r.usefulResult).toBe('unmeasured');
  });

  test('buildRecord: real measured timing keeps decision600s within/over unchanged', () => {
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
        createdAt: '2026-10-23T00:00:00Z',
      });
    expect(real(100_000, 400_000).decision600s).toBe('within');
    expect(real(300_000, 400_000).decision600s).toBe('over');
  });

  test('installSourceArg: URL verbatim, local resolved (URL --source regression preserved)', () => {
    const url = 'https://example.com/elanous.tgz';
    expect(installSourceArg(url)).toBe(url);
    expect(installSourceArg('fixture.tgz')).toBe(resolve('fixture.tgz'));
  });
});

// FIRST10-GATE: repoRoot 계산 — real(비-dry) 모드 install phase는 저장소 루트의
// scripts/install.sh 를 spawn해야 한다(scripts/scripts/install.sh 가 아니다).
describe('repoRootOf', () => {
  test('resolves the repository root so runInstallPhase finds the real scripts/install.sh', () => {
    const root = repoRootOf();
    expect(root).not.toMatch(/\/scripts\/scripts$/);
    expect(existsSync(join(root, 'scripts/install.sh'))).toBe(true);
  });
});

// FIRST10-GATE: sha256 크로스 플랫폼 — sha256sum → `shasum -a 256` 폴백; 둘 다 없으면
// 빈 값이 빠지지 않고 missingFields(source.tarballSha256)에 기록된다.
describe('sha256 + tarball hash missingFields', () => {
  test.skipIf(process.platform === 'darwin')('computes a sha256 hash on this platform (sha256sum or shasum fallback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'first10-sha-'));
    try {
      const p = join(dir, 'tarball.tgz');
      writeFileSync(p, 'first10-gate sha fixture');
      const h = sha256(p);
      const r = spawnSync('sha256sum', [p], { encoding: 'utf8' });
      if (r.status === 0) expect(h).toBe(r.stdout.trim().split(/\s+/)[0]);
      else expect(h).not.toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a tarball without a hash lands in missingFields, not a silent empty string', () => {
    const r = buildRecord({
      locale: 'ko' as const,
      source: { kind: 'tarball' as const, ref: '/repo/pkg.tgz' },
      cliVersion: '0.2.36',
      phases: {
        install: { rc: 0, stdout: 'installed', stderr: '', elapsedMonotonicMs: 1_000 },
        firstRun: { rc: 2, stdout: '', stderr: 'needs llm', elapsedMonotonicMs: 500 },
      },
      answerEvidence: null,
      createdAt: '2026-10-23T00:00:00Z',
    });
    expect(r.missingFields).toContain('source.tarballSha256');
  });
});

// FIRST10-GATE: XDG_DATA_HOME 배선 — CLI 경로에서 실제 process.env.XDG_DATA_HOME 을
// 읽어 운영 기본 prefix 거부가 동작한다(죽은 FIRST10_GATE_XDG_DATA_HOME 노브가 아니다).
describe('XDG_DATA_HOME wiring', () => {
  test.skipIf(process.platform === 'darwin')('refuses the XDG_DATA_HOME-based operating default prefix from the real env', () => {
    const home = mkdtempSync(join(tmpdir(), 'first10-xdg-'));
    try {
      const out = join(home, 'record.json');
      const r = spawnSync(
        'bun',
        [join(process.cwd(), 'scripts/first10-gate.ts'), '--record', out, '--home', home, '--prefix', '/xdg-data/elanous', '--state-dir', join(home, '.elanous'), '--dry'],
        { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: '/xdg-data', FIRST10_GATE_REAL_HOME: REAL_HOME } },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('⛔');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// FIRST10-GATE: recorder CLI --help 실측 — 실물 CLI spawn 시험(한도 명시 · darwin은 PTY 사정이 아니어도 스킵 패턴 유지).
describe('first10-gate --help', () => {
  test.skipIf(process.platform === 'darwin')('prints usage and exits 0', () => {
    const r = spawnSync('bun', [join(process.cwd(), 'scripts/first10-gate.ts'), '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--record');
    expect(r.stdout).toContain('--prefix');
    expect(r.stdout).toContain('--lang');
  });

  // Every required CLI argument (incl. an isolated --home) is supplied so parseArgs succeeds
  // and the rejection comes from validateIsolation's operating-default-prefix boundary itself —
  // not from an earlier `--home is required` parse error that would pass for the wrong reason.
  test.skipIf(process.platform === 'darwin')('refuses operating default prefix at validateIsolation with rc 2 and no record', () => {
    const home = mkdtempSync(join(tmpdir(), 'first10-gate-refuse-'));
    try {
      const out = join(home, 'record.json');
      const r = spawnSync('bun', [join(process.cwd(), 'scripts/first10-gate.ts'), '--record', out, '--home', home, '--prefix', `${REAL_HOME}/.local/share/elanous`, '--state-dir', join(home, '.elanous'), '--dry'], {
        encoding: 'utf8', env: { ...process.env, FIRST10_GATE_REAL_HOME: REAL_HOME },
      });
      expect(r.stderr).not.toContain('is required');
      expect(r.stderr).not.toContain('Usage:');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`⛔ refusing the operating default prefix ${REAL_HOME}/.local/share/elanous — pass an isolated --prefix`);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'darwin')('dry rehearsal writes one record with usefulResult unmeasured', () => {
    const home = mkdtempSync(join(tmpdir(), 'first10-home-'));
    try {
      const out = join(home, 'record.json');
      const r = spawnSync('bun', [
        join(process.cwd(), 'scripts/first10-gate.ts'),
        '--record', out,
        '--home', home,
        '--prefix', join(home, '.local/share/elanous'),
        '--state-dir', join(home, '.elanous'),
        '--lang', 'ko',
        '--dry',
      ], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      const rec = JSON.parse(readFileSync(out, 'utf8')) as RecorderRecord;
      expect(rec.schema).toBe('first10-gate/1');
      expect(rec.mode).toBe('dry');
      expect(rec.usefulResult).toBe('unmeasured');
      expect(rec.decision600s).toBe(null);
      expect(rec.missingFields).toContain('decision600s');
      expect(rec.phases.install.elapsedMonotonicMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(rec)).not.toContain('"pass"');
      expect(r.stdout).toContain('usefulResult=unmeasured');
      expect(r.stdout).toContain('decision600s=n/a');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});