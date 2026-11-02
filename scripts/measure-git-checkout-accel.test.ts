import { describe, expect, test, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CHECKOUT_CANDIDATES,
  CHECKOUT_CONDITIONS,
  CHECKOUT_ROUTES,
  formatCheckoutMeasurementTable,
  main,
  measureCheckoutAcceleration,
  type CheckoutProbe,
} from './measure-git-checkout-accel.ts';

const CUT = 'a'.repeat(40);

function fixtureObservations() {
  return CHECKOUT_ROUTES.flatMap((route) => CHECKOUT_CANDIDATES.flatMap((candidate) => CHECKOUT_CONDITIONS.map((condition) => ({
    route, candidate, condition,
    durationMs: condition === 'cold' ? 17 : 5,
    bytesWritten: route.length * 100 + candidate.length * 10 + condition.length,
    fileCount: route.length + candidate.length,
    usesAlternates: candidate === 'reference' || candidate === 'partial',
    alternatesGcSafe: candidate === 'reference',
    sparseCheckoutEnabled: candidate === 'sparse',
    sparseDependenciesMet: false,
  }))));
}

describe('git checkout acceleration measurement contract', () => {
  test('fake git/clock/disk probes emit every same-cut cold/warm row and preserve independent safety facts', async () => {
    let now = 0;
    const gitRequests: string[] = [];
    const probe: CheckoutProbe = {
      async measure(input) {
        gitRequests.push(`${input.route}:${input.candidate}:${input.condition}:${input.cutSha}`);
        now += input.condition === 'cold' ? 17 : 5;
        return {
          bytesWritten: input.route.length * 100 + input.candidate.length * 10 + input.condition.length,
          fileCount: input.route.length + input.candidate.length,
          usesAlternates: input.candidate === 'reference' || input.candidate === 'partial',
          alternatesGcSafe: input.candidate === 'reference',
          sparseCheckoutEnabled: input.candidate === 'sparse',
          sparseDependenciesMet: false,
        };
      },
    };
    const rows = await measureCheckoutAcceleration({ cutSha: CUT, probe, clock: { now: () => now } });
    expect(rows).toHaveLength(18);
    expect(gitRequests).toHaveLength(18);
    expect(new Set(gitRequests.map((request) => request.split(':').at(-1))).size).toBe(1);
    expect(rows.filter((row) => row.condition === 'cold').every((row) => row.durationMs === 17)).toBe(true);
    expect(rows.filter((row) => row.condition === 'warm').every((row) => row.durationMs === 5)).toBe(true);
    expect(rows.find((row) => row.candidate === 'reference')).toMatchObject({ usable: true, usesAlternates: true, alternatesGcSafe: true });
    expect(rows.find((row) => row.candidate === 'partial')).toMatchObject({ usable: false, usesAlternates: true, alternatesGcSafe: false, unusableReasons: ['alternates-gc-safety-unproven'] });
    expect(rows.find((row) => row.candidate === 'sparse')).toMatchObject({ usable: false, sparseCheckoutEnabled: true, sparseDependenciesMet: false, unusableReasons: ['sparse-dependencies-unmet'] });
    expect(rows.every((row) => row.bytesWritten !== null && row.fileCount !== null && row.cutSha === CUT)).toBe(true);
  });

  test('an unavailable measurement remains a reasoned matrix row instead of disappearing', async () => {
    const rows = await measureCheckoutAcceleration({ cutSha: CUT, probe: {
      async measure({ route, candidate, condition }) {
        if (route === 'pod-source-image' && candidate === 'partial' && condition === 'warm') return { unavailableReason: 'candidate-not-supported' };
        return { bytesWritten: 2, fileCount: 1, usesAlternates: false, sparseCheckoutEnabled: candidate === 'sparse', sparseDependenciesMet: true };
      },
    }, clock: { now: (() => { let value = 0; return () => value++; })() } });
    expect(rows).toHaveLength(18);
    expect(rows.find((row) => row.unusableReasons.includes('candidate-not-supported'))).toMatchObject({
      measurementStatus: 'unavailable', durationMs: null, bytesWritten: null, fileCount: null, usable: false,
    });
  });

  test('CLI parses a complete probe fixture, calls the measurement contract, and emits JSON or a table', async () => {
    const fixture = { cutSha: CUT, observations: fixtureObservations() };
    const dir = mkdtempSync(join(tmpdir(), 'checkout-accel-fixture-'));
    const path = join(dir, 'fixture.json');
    writeFileSync(path, JSON.stringify(fixture));
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--input', path])).toBe(0);
      const jsonRows = JSON.parse(String(write.mock.calls[0]?.[0])) as Array<Record<string, unknown>>;
      expect(jsonRows).toHaveLength(18);
      expect(jsonRows[0]).toMatchObject({ route: 'worktree-add', candidate: 'reference', condition: 'cold', durationMs: 17 });
      write.mockClear();
      expect(await main(['--input', path, '--table'])).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('| route');
      expect(String(write.mock.calls[0]?.[0])).toContain('alternates-gc-safety-unproven');
      for (const fact of ['usesAlternates', 'alternatesGcSafe', 'sparseCheckoutEnabled', 'sparseDependenciesMet']) {
        expect(String(write.mock.calls[0]?.[0])).toContain(fact);
      }
      const executable = spawnSync(resolve('scripts/measure-git-checkout-accel.ts'), ['--input', path], { encoding: 'utf8' });
      expect(executable.status).toBe(0);
      expect(JSON.parse(executable.stdout)).toHaveLength(18);
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI rejects a fixture with missing route/candidate/condition combinations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'checkout-accel-incomplete-'));
    const path = join(dir, 'fixture.json');
    writeFileSync(path, JSON.stringify({ cutSha: CUT, observations: fixtureObservations().slice(1) }));
    const error = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--input', path])).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('fixture missing 1 matrix observation');
      expect(output).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      output.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fixture safety facts must be booleans even on unavailable rows', async () => {
    const observations = fixtureObservations() as Array<Record<string, unknown>>;
    observations[0]!.usesAlternates = 'true';
    observations[0]!.unavailableReason = 'probe-unavailable';
    const dir = mkdtempSync(join(tmpdir(), 'checkout-accel-invalid-fact-'));
    const path = join(dir, 'fixture.json');
    writeFileSync(path, JSON.stringify({ cutSha: CUT, observations }));
    const error = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--input', path])).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('invalid safety fact');
    } finally {
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fixture clock keeps each duration exact after a very large measurement', async () => {
    const observations = fixtureObservations();
    observations[0]!.durationMs = 1e16;
    observations[1]!.durationMs = 1;
    const dir = mkdtempSync(join(tmpdir(), 'checkout-accel-clock-'));
    const path = join(dir, 'fixture.json');
    writeFileSync(path, JSON.stringify({ cutSha: CUT, observations }));
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--input', path])).toBe(0);
      const rows = JSON.parse(String(write.mock.calls[0]?.[0])) as Array<{ durationMs: number }>;
      expect(rows[0]!.durationMs).toBe(1e16);
      expect(rows[1]!.durationMs).toBe(1);
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('table formatting includes null cost cells for unavailable measurements', () => {
    const formatted = formatCheckoutMeasurementTable([{
      route: 'worktree-add', candidate: 'sparse', condition: 'cold', cutSha: CUT, measurementStatus: 'unavailable',
      durationMs: null, bytesWritten: null, fileCount: null, usesAlternates: null, alternatesGcSafe: null,
      sparseCheckoutEnabled: null, sparseDependenciesMet: null, usable: false, unusableReasons: ['no-probe'],
    }]);
    expect(formatted).toContain('no-probe');
    expect(formatted).toContain('unavailable');
  });
});
