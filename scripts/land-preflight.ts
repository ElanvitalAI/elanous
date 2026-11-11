#!/usr/bin/env bun
/** One-command, remote-only composition of the existing pre-enqueue gates. */
import { getUserConfig } from '../src/user-config.js';
import { gateRemoteHostCap, resolveGateRemoteSettings, runOnRemote } from '../src/self-implement/gate-remote.js';

/** Existing repository checks run in order in one gate-remote checkout; no new test/typecheck implementation lives here. */
export function buildLandPreflightScript(): string {
  return String.raw`set -eu
base=$(git merge-base origin/main HEAD)
if rules=$(ELANOUS_GATE_BASE_SHA="$base" bun test test/rules-contract.test.ts 2>&1); then
  rules_result=$(printf '%s\n' "$rules" | grep -E 'Ran [0-9]+ tests? across [0-9]+ files?' | tail -1 || true)
  [ -n "$rules_result" ] || rules_result=$(printf '%s\n' "$rules" | tail -1)
else
  printf '%s\n' "$rules" | tail -20 >&2
  printf '[land-preflight] FAIL rules-contract: %s\n' "$(printf '%s\n' "$rules" | tail -1)"
  exit 1
fi
if changed_paths=$(git diff --name-only --diff-filter=A "$base"...HEAD -- src/ux-sim/); then
  new_sim=$(printf '%s\n' "$changed_paths" | grep -E '^src/ux-sim/.+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' | grep -Ev '(^|/)(__tests__|tests?)/|\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$|\.d\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' || true)
else
  printf '[land-preflight] FAIL changed-paths: git diff could not measure added ux-sim files\n'
  exit 1
fi
catalog_result=skip-no-new-ux-sim-module
if [ -n "$new_sim" ]; then
  if catalog=$(bun test src/ux-sim/mock-scenario-catalog.test.ts 2>&1); then
    catalog_result=$(printf '%s\n' "$catalog" | grep -E 'Ran [0-9]+ tests? across [0-9]+ files?' | tail -1 || true)
    [ -n "$catalog_result" ] || catalog_result=$(printf '%s\n' "$catalog" | tail -1)
  else
    printf '%s\n' "$catalog" | tail -20 >&2
    printf '[land-preflight] FAIL mock-scenario-catalog: %s\n' "$(printf '%s\n' "$catalog" | tail -1)"
    exit 1
  fi
fi
if interference=$(bun test scripts/ratchets/test-interference-patterns.test.ts 2>&1); then
  interference_result=$(printf '%s\n' "$interference" | grep -E 'Ran [0-9]+ tests? across [0-9]+ files?' | tail -1 || true)
  [ -n "$interference_result" ] || interference_result=$(printf '%s\n' "$interference" | tail -1)
else
  printf '%s\n' "$interference" | tail -20 >&2
  printf '[land-preflight] FAIL test-interference-fixtures: %s\n' "$(printf '%s\n' "$interference" | tail -1)"
  exit 1
fi
if contract=$(bun test scripts/land-preflight.test.ts 2>&1); then
  contract_result=$(printf '%s\n' "$contract" | grep -E 'Ran [0-9]+ tests? across [0-9]+ files?' | tail -1 || true)
  [ -n "$contract_result" ] || contract_result=$(printf '%s\n' "$contract" | tail -1)
else
  printf '%s\n' "$contract" | tail -20 >&2
  printf '[land-preflight] FAIL command-contract: %s\n' "$(printf '%s\n' "$contract" | tail -1)"
  exit 1
fi
if tsc=$(bun run scripts/ci-typecheck-changed.ts --local 2>&1); then
  tsc_result=$(printf '%s\n' "$tsc" | grep '\[tsc-gate\] PASS' | tail -1 || true)
  [ -n "$tsc_result" ] || tsc_result=$(printf '%s\n' "$tsc" | tail -1)
else
  printf '%s\n' "$tsc" | tail -20 >&2
  printf '[land-preflight] FAIL changed-tsc: %s\n' "$(printf '%s\n' "$tsc" | tail -1)"
  exit 1
fi
head=$(git rev-parse HEAD)
printf '[land-preflight] PASS head=%s base=%s rules=%s catalog=%s test-interference-fixtures=%s command-contract=%s changed-tsc=%s\n' "$head" "$base" "$rules_result" "$catalog_result" "$interference_result" "$contract_result" "$tsc_result"
`;
}

function parseArgs(args: string[]): { host: string } {
  let host = 'aws2';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: land-enqueue.sh preflight [--remote aws2]');
      console.log('Runs rules-contract, conditional mock-scenario-catalog, existing return fixtures, command contract, and changed-file TSC sequentially on aws2.');
      process.exit(0);
    }
    if (args[i] === '--remote' && args[i + 1]) { host = args[++i]!; continue; }
    throw new Error(`unknown or incomplete argument: ${args[i] ?? ''}`);
  }
  if (host !== 'aws2') throw new Error('land preflight currently allows only --remote aws2');
  return { host };
}

async function main(args: string[]): Promise<number> {
  const { host } = parseArgs(args);
  const repo = (await import('node:child_process')).execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const settings = resolveGateRemoteSettings(getUserConfig().gateRemote);
  const outcome = runOnRemote({
    repo, host, mirror: settings.mirror, hostCap: gateRemoteHostCap(settings, host), stableCheckout: true,
    argv: ['sh', '-c', buildLandPreflightScript()],
  });
  if (outcome.kind === 'ran') {
    const stdout = outcome.stdout.toString('utf8').trimEnd();
    const stderr = outcome.stderr.toString('utf8').trimEnd();
    if (stdout) process.stdout.write(`${stdout}\n`);
    if (stderr) process.stderr.write(`${stderr}\n`);
    return outcome.rc;
  }
  console.error(`[land-preflight] UNMEASURED host=${host} kind=${outcome.kind} reason=${outcome.kind === 'infra' ? outcome.reason : `busy load=${outcome.load1 ?? 'unknown'}`}`);
  return 2;
}

if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`[land-preflight] REFUSE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
