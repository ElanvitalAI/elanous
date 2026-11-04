import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';

const runner = resolve(import.meta.dir, 'zero-sim-world.sh');

function runWithStubs(input: {
  readonly existing?: string;
  readonly createRc?: number;
  readonly firstRunRc?: number;
  readonly firstRunTeeRc?: number;
  readonly logsRc?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), 'zero-sim-world-test-'));
  const tools = join(root, 'tools');
  const bin = join(root, 'bin');
  const evidence = join(root, 'evidence');
  const calls = join(root, 'calls.txt');
  const deleted = join(root, 'deleted.txt');
  mkdirSync(tools);
  mkdirSync(bin);
  const vm = join(tools, 'zero-vm.sh');
  const rail = join(tools, 'zero-rail.sh');
  writeFileSync(vm, `#!/bin/zsh
set -u
cmd=$1; shift
printf '%s %s\\n' "$cmd" "$*" >> "$ZERO_SIM_CALLS"
case "$cmd" in
  list) [[ -n "${'${FAKE_EXISTING_VM:-}'}" ]] && print -r -- "$FAKE_EXISTING_VM running"; return 0 ;;
  create) print "created"; exit "${'${FAKE_CREATE_RC:-0}'}" ;;
  sh) print "first-run stub output"; exit "${'${FAKE_FIRST_RUN_RC:-0}'}" ;;
  logs) print "log-store stub output"; exit "${'${FAKE_LOGS_RC:-0}'}" ;;
  delete) print deleted > "$FAKE_VM_DELETED" ;;
  *) exit 90 ;;
esac
`);
  writeFileSync(rail, '#!/bin/zsh\nprint rail-installed\n');
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "S2 fake test command\\n"\n');
  writeFileSync(join(bin, 'tee'), `#!/bin/zsh
set -u
append=0
if [[ "\${1:-}" == -a ]]; then append=1; shift; fi
if (( append )); then cat >> "$1"; else cat > "$1"; fi
if [[ "$1" == *-first-run.log ]]; then exit "\${FAKE_FIRST_RUN_TEE_RC:-0}"; fi
exit 0
`);
  chmodSync(vm, 0o755);
  chmodSync(rail, 0o755);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'tee'), 0o755);

  const safeEnv = { ...process.env };
  for (const key of Object.keys(safeEnv)) {
    if (/(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CLIENT_SECRET|_OAUTH_TOKEN)$/.test(key)) delete safeEnv[key];
  }
  const result = spawnSync('zsh', [runner, 'zero-test-world', 'main', 'pr:123'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...safeEnv,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: root,
      ZERO_TOOLS_DIR: tools,
      ZERO_SIM_EVIDENCE_DIR: evidence,
      ZERO_SIM_CALLS: calls,
      FAKE_VM_DELETED: deleted,
      FAKE_EXISTING_VM: input.existing ?? '',
      FAKE_CREATE_RC: String(input.createRc ?? 0),
      FAKE_FIRST_RUN_RC: String(input.firstRunRc ?? 0),
      FAKE_FIRST_RUN_TEE_RC: String(input.firstRunTeeRc ?? 0),
      FAKE_LOGS_RC: String(input.logsRc ?? 0),
    },
  });
  const callsText = readFileSync(calls, 'utf8');
  const deletedVm = (() => { try { readFileSync(deleted, 'utf8'); return true; } catch { return false; } })();
  const evidenceText = (name: string) => {
    try { return readFileSync(join(evidence, name), 'utf8'); } catch { return ''; }
  };
  return {
    root,
    result,
    callsText,
    deletedVm,
    firstRunLog: evidenceText('zero-sim-zero-test-world-first-run.log'),
    logsLog: evidenceText('zero-sim-zero-test-world-elanous-logs.log'),
  };
}

test('zero sim runner creates, installs, runs headless once, gathers logs, and deletes its VM', () => {
  const run = runWithStubs({});
  try {
    expect(run.result.status).toBe(0);
    expect(run.callsText).toMatch(/list[\s\S]*create[\s\S]*sh[\s\S]*logs[\s\S]*delete/);
    expect(run.deletedVm).toBe(true);
    expect(run.firstRunLog).toContain('first-run stub output');
    expect(run.logsLog).toContain('log-store stub output');
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});

test('first-run failure still collects logs, records missing store, and preserves its rc when tee also fails', () => {
  const run = runWithStubs({ firstRunRc: 17, firstRunTeeRc: 31, logsRc: 9 });
  try {
    expect(run.result.status).toBe(17);
    expect(run.callsText).toMatch(/sh[\s\S]*logs[\s\S]*delete/);
    expect(run.deletedVm).toBe(true);
    expect(run.logsLog).toContain('log-store stub output');
    expect(run.logsLog).toContain('log collection unavailable rc=9');
    expect(run.result.stdout).toContain('first run failed rc=17; logs rc=9');
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});

test('failed VM creation never deletes a same-name VM that appeared after the list check', () => {
  const run = runWithStubs({ createRc: 23 });
  try {
    expect(run.result.status).toBe(23);
    expect(run.callsText).toMatch(/list[\s\S]*create/);
    expect(run.callsText).not.toContain('delete');
    expect(run.deletedVm).toBe(false);
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});

test('existing VM is refused and left intact', () => {
  const run = runWithStubs({ existing: 'zero-test-world' });
  try {
    expect(run.result.status).toBe(2);
    expect(run.callsText).toContain('list');
    expect(run.callsText).not.toContain('create');
    expect(run.deletedVm).toBe(false);
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});
