import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const SCRIPT = join(process.cwd(), 'scripts/ab-verify.sh');
const dirs: string[] = [];

function makeExecutable(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function makeCommandBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'ab-verify-bin-'));
  dirs.push(bin);
  makeExecutable(bin, 'rg', `
if [ "$1" = "--no-config" ]; then shift; fi
if [ "$1" = "-o" ]; then pattern="$2"; shift 2; fi
if [ "$1" = "-c" ]; then
  [ "$2" = "dev-pipeline-ts-src-self-de" ] || exit 9
  echo 1
  exit 0
fi
[ "$1" = "--" ] && shift
case "$pattern" in
  'base=[^ ]*|NON-DEFAULT') sed -n '/base=/p;/NON-DEFAULT/p' "$1" | head -1 ;;
  'self-impl-[a-z0-9-]*') sed -n '/self-impl-/p' "$1" | head -1 ;;
esac`);
  makeExecutable(bin, 'bun', `
printf 'bun:%s\\n' "$*" >> "$AB_VERIFY_CALLS"
printf '{"data":{"runId":"abcdefghijklmno","childLlm":"codex","escalateTier":"R2"}}\\n'`);
  makeExecutable(bin, 'jq', 'printf \'abcdefghijklmn  childLlm="codex"  tier="R2"\\n\'');
  makeExecutable(bin, 'git', `
[ "$1" = "-C" ] && shift 2
[ "$1" = "worktree" ] && [ "$2" = "list" ] || exit 8
printf 'worktree dev-pipeline-ts-src-self-de\\n'`);
  return bin;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: tmpdir(),
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('scripts/ab-verify.sh', () => {
  test('requires exactly two log paths', () => {
    for (const args of [[], ['only.log'], ['a.log', 'b.log', 'extra']]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Usage:');
      expect(result.stderr).toContain('<log-a> <log-b>');
    }
  });

  test('reports four ordered checks for two log paths without making a verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-verify-logs-'));
    dirs.push(dir);
    const logA = join(dir, 'ab3-A-codex.log');
    const logB = join(dir, 'ab3-B-gemma.log');
    const calls = join(dir, 'calls.log');
    writeFileSync(logA, 'base=left\nself-impl-left-worktree\n');
    writeFileSync(logB, 'NON-DEFAULT\nself-impl-right-worktree\n');
    const bin = makeCommandBin();

    const result = run([logA, logB], { PATH: `${bin}:${process.env.PATH}`, AB_VERIFY_CALLS: calls });

    expect(result.status).toBe(0);
    const headings = ['=== 1 base ===', '=== 2 worktree ===', '=== 3 child brain ===', '=== 4 orphan ==='];
    let index = -1;
    for (const heading of headings) {
      const next = result.stdout.indexOf(heading);
      expect(next).toBeGreaterThan(index);
      index = next;
    }
    expect(result.stdout).toContain('ab3-A-codex');
    expect(result.stdout).toContain('ab3-B-gemma');
    expect(result.stdout).toContain('base=left');
    expect(result.stdout).toContain('NON-DEFAULT');
    expect(result.stdout).toContain('self-impl-left-worktree');
    expect(result.stdout).toContain('self-impl-right-worktree');
    expect(result.stdout).toContain('   위 둘이 같으면 그 실험은 이미 무효다');
    expect(result.stdout).toContain('childLlm="codex"');
    expect(result.stdout).toContain('tier="R2"');
    expect(result.stdout).toContain('\n1\n');
    expect(result.stdout).not.toContain('PASS');
    expect(result.stdout).not.toContain('FAIL');
    expect(result.stderr).toBe('');
    expect(readFileSync(calls, 'utf8')).toContain('bun:');
  });
});
