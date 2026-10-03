import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const scriptPath = resolve(import.meta.dir, 'recheck-nl-corpus-live.ts');
const tempDirs: string[] = [];

function createCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl-corpus-fixture-'));
  tempDirs.push(dir);
  const corpusPath = join(dir, 'corpus.json');
  writeFileSync(corpusPath, JSON.stringify({
    description: 'test corpus',
    surface: 'chat',
    items: [{ id: 'T1-01', tier: 'T1', prompt: 'test', accept: ['Read'] }],
  }));
  return corpusPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ⛔ 이 테스트가 세션 계약을 재므로 **상속된 CORPUS_* 를 먼저 지운다**(무인 리뷰 should-fix).
//    `{ ...process.env }` 만 쓰면 호출자 셸에 CORPUS_SESSIONS 나 오염 옵트인이 떠 있을 때
//    같은 테스트가 다른 답을 낸다 — 계약을 재는 테스트가 환경에 흔들리면 그것은 자가 아니다.
const CORPUS_ENV_KEYS = [
  'CORPUS_SESSION', 'CORPUS_SESSIONS', 'CORPUS_LIVE_REPEATS',
  'CORPUS_ALLOW_CONTAMINATED_SESSION_REUSE', 'CORPUS_PROBE_TEXT',
  'CORPUS_STATE_DIR', 'CORPUS_CONFIG_DIR', 'CORPUS_TEST_FAIL_LOGS',
] as const;

function runCli(env: Record<string, string | undefined>) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of CORPUS_ENV_KEYS) delete base[key];
  return Bun.spawnSync({
    cmd: [process.execPath, scriptPath, 'T1-01'],
    cwd: resolve(import.meta.dir, '..'),
    env: { ...base, CORPUS_PTY: 'pty-test', CORPUS_PATH: createCorpus(), CORPUS_SETTLE_MS: '1000', CORPUS_TRUNCATED_TURN_WAIT_MS: '1000', ...env },
    stdout: 'pipe', stderr: 'pipe',
  });
}

function text(stream: Uint8Array | undefined): string {
  return new TextDecoder().decode(stream);
}

function fakeBunPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl-corpus-cli-'));
  tempDirs.push(dir);
  const state = join(dir, 'input-count');
  const executable = join(dir, 'bun');
  writeFileSync(executable, `#!/bin/sh
case "$*" in
  *lifecycle.bridge-attached*) printf '%s\\n' '{"event":"lifecycle.bridge-attached","session_id":"'"$CORPUS_SESSION"'","data":"{\\"ptyId\\":\\"pty-test\\"}"}' ;;
  *pty*text*)
    count=0; [ -f '${state}' ] && count=$(cat '${state}')
    echo $((count + 1)) > '${state}' ;;
  *input.submit*)
    if [ "$CORPUS_TEST_FAIL_LOGS" = '1' ]; then exit 1; fi
    count=0; [ -f '${state}' ] && count=$(cat '${state}')
    if [ "$count" -gt 0 ]; then
      start=$((count * 2 - 1)); end=$((count * 2))
      timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf '{"id":%s,"ts":"%s","event":"execute.begin","session_id":"%s","runId":"r%s"}\\n' "$start" "$timestamp" "$CORPUS_SESSION" "$count"
      printf '{"id":%s,"ts":"%s","event":"execute.ok","session_id":"%s","runId":"r%s"}\\n' "$end" "$timestamp" "$CORPUS_SESSION" "$count"
    fi ;;
  *) : ;;
esac
`);
  chmodSync(executable, 0o755);
  return dir;
}

describe('recheck NL corpus live CLI contract', () => {
  test('requires an external CORPUS_PATH before validating the live session inputs', () => {
    const result = runCli({ CORPUS_PATH: undefined });
    expect(result.exitCode).not.toBe(0);
    expect(text(result.stderr)).toContain('CORPUS_PATH is required; provide the corpus JSON path to measure.');
  });

  test('CORPUS_SESSIONS parses distinct sessions and rejects insufficient or duplicate repeat sessions before live execution', () => {
    const insufficient = runCli({ CORPUS_SESSIONS: 'session-1', CORPUS_LIVE_REPEATS: '2' });
    expect(insufficient.exitCode).not.toBe(0);
    expect(text(insufficient.stderr)).toContain('CORPUS_SESSIONS requires at least 2 distinct sessions');

    const duplicate = runCli({ CORPUS_SESSIONS: 'session-1, session-1', CORPUS_LIVE_REPEATS: '2' });
    expect(duplicate.exitCode).not.toBe(0);
    expect(text(duplicate.stderr)).toContain('CORPUS_SESSIONS must provide a distinct session for every repeat.');
  });

  test('CORPUS_SESSION remains compatible for one repeat and only the opt-in permits stamped multi-repeat contamination', () => {
    const fakeBin = fakeBunPath();
    const baseEnv = { PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`, CORPUS_SESSION: 'single-session', CORPUS_LIVE_REPEATS: '1' };
    const single = runCli(baseEnv);
    expect(single.exitCode).toBe(0);
    expect(text(single.stderr)).toBe('');
    expect(text(single.stdout)).toContain('sessions=single-session');
    expect(text(single.stdout)).toContain('[live] 합계');

    const rejected = runCli({ ...baseEnv, CORPUS_LIVE_REPEATS: '2' });
    expect(rejected.exitCode).not.toBe(0);
    expect(text(rejected.stderr)).toContain('CORPUS_SESSION supports only one repeat.');

    const optedIn = runCli({ ...baseEnv, CORPUS_LIVE_REPEATS: '2', CORPUS_ALLOW_CONTAMINATED_SESSION_REUSE: '1' });
    expect(optedIn.exitCode, `${text(optedIn.stderr)}\n${text(optedIn.stdout)}`).toBe(0);
    expect(text(optedIn.stderr)).toBe('');
    expect(text(optedIn.stdout)).toContain('contaminated-session-reuse');
    expect(text(optedIn.stdout)).toContain('[live] 합계');
    expect(text(optedIn.stdout)).toContain('result contaminated-session-reuse=true');

    const interrupted = runCli({ ...baseEnv, CORPUS_LIVE_REPEATS: '2', CORPUS_ALLOW_CONTAMINATED_SESSION_REUSE: '1', CORPUS_TEST_FAIL_LOGS: '1' });
    expect(interrupted.exitCode).not.toBe(0);
    expect(text(interrupted.stdout)).toContain('contaminated-session-reuse');
    expect(text(interrupted.stdout)).not.toContain('result contaminated-session-reuse=true');
  });
});
