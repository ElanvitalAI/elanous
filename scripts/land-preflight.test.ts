import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLandPreflightScript } from './land-preflight.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Fixture = { kind: string; gate: string; diagnostic: string; catalog: boolean };
const returnedFailureFixtures: Fixture[] = [
  { kind: 'NUMGUARD', gate: 'rules-contract', diagnostic: 'NUMGUARD: source comment missing', catalog: false },
  { kind: 'missing-rule-rereview-line', gate: 'rules-contract', diagnostic: 'rules-contract: changed canonical not reviewed', catalog: false },
  { kind: 'missing-sim-catalog-registration', gate: 'mock-scenario-catalog', diagnostic: 'mock-scenario-catalog: module absent', catalog: true },
  { kind: 'body-dynamic-import', gate: 'test-interference-fixtures', diagnostic: 'body-dynamic-import: fixture found', catalog: false },
  { kind: 'environment-restoration', gate: 'test-interference-fixtures', diagnostic: 'env-without-restore: fixture found', catalog: false },
];
const orchestrationFailureFixtures: Fixture[] = [
  { kind: 'command-contract', gate: 'command-contract', diagnostic: 'command-contract: fixture failure', catalog: false },
  { kind: 'changed-tsc', gate: 'changed-tsc', diagnostic: '[tsc-gate] FAIL — fixture type error', catalog: false },
];

function runPreflight(options: { fail?: string; simModule?: string; diffFail?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'land-preflight-cli-boundary-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const callsPath = join(root, 'calls');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$1" in
  merge-base) echo fixture-base ;;
  rev-parse) echo fixture-head ;;
  diff)
    if [ "$PREFLIGHT_DIFF_FAIL" = true ]; then exit 17; fi
    if [ -n "$PREFLIGHT_SIM_MODULE" ]; then printf '%s\\n' "$PREFLIGHT_SIM_MODULE"; fi ;;
esac
`);
  writeFileSync(join(bin, 'bun'), `#!/bin/sh
args="$*"
printf '%s\\n' "$args" >> "$PREFLIGHT_CALLS"
fail() { printf '%s\\n' "$2" >&2; exit 1; }
case "$args" in
  'test test/rules-contract.test.ts')
    case "$PREFLIGHT_FAIL" in
      NUMGUARD) fail rules-contract 'NUMGUARD: source comment missing' ;;
      missing-rule-rereview-line) fail rules-contract 'rules-contract: changed canonical not reviewed' ;;
    esac
    echo 'Ran 136 tests across 1 file.' ;;
  'test src/ux-sim/mock-scenario-catalog.test.ts')
    [ "$PREFLIGHT_FAIL" != missing-sim-catalog-registration ] || fail catalog 'mock-scenario-catalog: module absent'
    echo 'Ran 1 test across 1 file.' ;;
  'test scripts/ratchets/test-interference-patterns.test.ts')
    case "$PREFLIGHT_FAIL" in
      body-dynamic-import) fail interference 'body-dynamic-import: fixture found' ;;
      environment-restoration) fail interference 'env-without-restore: fixture found' ;;
    esac
    echo 'Ran 16 tests across 1 file.' ;;
  'test scripts/land-preflight.test.ts')
    [ "$PREFLIGHT_FAIL" != command-contract ] || fail contract 'command-contract: fixture failure'
    echo 'Ran 10 tests across 1 file.' ;;
  'run scripts/ci-typecheck-changed.ts --local')
    [ "$PREFLIGHT_FAIL" != changed-tsc ] || fail tsc '[tsc-gate] FAIL — fixture type error'
    echo '[tsc-gate] PASS — fixture' ;;
  *) echo "unexpected invocation: $args" >&2; exit 2 ;;
esac
`);
  // Source: .rules/30-harness/testing-gates.md
  chmodSync(join(bin, 'git'), 0o755);
  // Source: .rules/30-harness/testing-gates.md
  chmodSync(join(bin, 'bun'), 0o755);
  const result = spawnSync('sh', ['-c', buildLandPreflightScript()], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PREFLIGHT_FAIL: options.fail ?? '',
      PREFLIGHT_SIM_MODULE: options.simModule ?? '',
      PREFLIGHT_DIFF_FAIL: options.diffFail ? 'true' : '',
      PREFLIGHT_CALLS: callsPath,
    },
  });
  return { result, calls: readFileSync(callsPath, 'utf8').trim().split('\n') };
}

describe('LAND-PREFLIGHT-ONE', () => {
  test('runs the real command sequence and skips catalog for no new ux-sim source module', () => {
    const { result, calls } = runPreflight();
    // Source: .rules/30-harness/testing-gates.md
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'test test/rules-contract.test.ts',
      'test scripts/ratchets/test-interference-patterns.test.ts',
      'test scripts/land-preflight.test.ts',
      'run scripts/ci-typecheck-changed.ts --local',
    ]);
    expect(result.stdout).toContain('catalog=skip-no-new-ux-sim-module');
    expect(result.stdout).toContain('head=fixture-head base=fixture-base');
  });

  test('runs catalog for an added source module but excludes tests and declarations', () => {
    const source = runPreflight({ simModule: 'src/ux-sim/new-device.ts' });
    expect(source.calls).toContain('test src/ux-sim/mock-scenario-catalog.test.ts');
    expect(source.result.stdout).toContain('catalog=Ran 1 test across 1 file.');
    for (const path of [
      'src/ux-sim/new-device.test.ts', 'src/ux-sim/new-device.spec.ts', 'src/ux-sim/new-device.d.ts',
      'src/ux-sim/tests/helper.ts', 'src/ux-sim/__tests__/helper.ts',
    ]) {
      const excluded = runPreflight({ simModule: path });
      expect(excluded.calls).not.toContain('test src/ux-sim/mock-scenario-catalog.test.ts');
    }
  });

  for (const fixture of returnedFailureFixtures) {
    test(`fails closed for ${fixture.kind} at ${fixture.gate}`, () => {
      const { result, calls } = runPreflight({ fail: fixture.kind, ...(fixture.catalog ? { simModule: 'src/ux-sim/new-device.ts' } : {}) });
      const output = `${result.stdout}${result.stderr}`;
      // Source: .rules/30-harness/testing-gates.md
      expect(result.status).toBe(1);
      expect(output).toContain(`[land-preflight] FAIL ${fixture.gate}`);
      expect(output).toContain(fixture.diagnostic);
      expect(calls).not.toContain('run scripts/ci-typecheck-changed.ts --local');
      if (fixture.catalog) expect(calls).toContain('test src/ux-sim/mock-scenario-catalog.test.ts');
    });
  }

  for (const fixture of orchestrationFailureFixtures) {
    test(`propagates ${fixture.gate} failure diagnostic and nonzero status`, () => {
      const { result, calls } = runPreflight({ fail: fixture.kind });
      const output = `${result.stdout}${result.stderr}`;
      // Source: .rules/30-harness/testing-gates.md
      expect(result.status).toBe(1);
      expect(output).toContain(`[land-preflight] FAIL ${fixture.gate}`);
      expect(output).toContain(fixture.diagnostic);
      if (fixture.kind === 'command-contract') expect(calls).not.toContain('run scripts/ci-typecheck-changed.ts --local');
    });
  }

  test('fails closed when changed source paths cannot be measured', () => {
    const { result } = runPreflight({ diffFail: true });
    const output = `${result.stdout}${result.stderr}`;
    // Source: .rules/30-harness/testing-gates.md
    expect(result.status).toBe(1);
    expect(output).toContain('[land-preflight] FAIL changed-paths');
    expect(output).not.toContain('[land-preflight] PASS');
  });
});
