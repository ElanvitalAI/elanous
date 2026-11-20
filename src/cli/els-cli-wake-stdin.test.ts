// [ELS-WAKE-PIPED-STDIN] OP #107316 — `els _wake-request` stdin 읽기: Bun.stdin.text() (취소 불가·fd0 영구 블록) → readPipedStdin (piped-stdin.ts FIFO 게이트 + 유휴 상한 PIPED_STDIN_IDLE_TIMEOUT_MS=2000, 비파이프는 즉시 빈 입력).
// 리터럴 ① 열린 파이프(EOF 없음) → 유휴 상한 뒤 빈 입력 폴백으로 완주(fd0 반납) ② 비파이프(TTY·ignore) → 즉시 빈 입력 → 완주 ③ 닫힌 정상 파이프 JSON → 기존 처리 보존.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIPED_STDIN_IDLE_TIMEOUT_MS } from './piped-stdin.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* 이미 정리됨 */ } });

const script = `import { Command } from 'commander'; import { registerElsCommands } from './src/cli/els-cli.ts'; const cli = new Command(); registerElsCommands(cli); await cli.parseAsync(process.argv.slice(1), { from: 'user' });`;

// ① 열린 stdin(EOF 없음 · Bun 의 pipe 는 소켓쌍이라 FIFO 게이트가 비파이프로 판정) — 즉시 빈 입력 폴백으로 **완주**해야 한다(예전 Bun.stdin.text() 는 fd0 을 붙잡아 영구 블록).
test('els _wake-request child exits well within the margin with an unclosed stdin (fd0 released, no permanent block)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-wake-fd0-')); dirs.push(dir);
  const child = Bun.spawn(['bun', '-e', script, 'els', '_wake-request'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const started = Date.now();
  const stderrText = new Response(child.stderr).text();
  try {
    const code = await child.exited; // stdin 을 끝내지 않은 채 대기 — 폴백 없으면 영구 블록
    expect(code, await stderrText).toBe(1); // 빈 입력 → JSON.parse throw → catch exitCode 1 경로 — 그러나 완주
    expect(Date.now() - started).toBeLessThan(8_000); // 출처: #106365 OP JUD-B must 1 — readPipedStdin 유휴 상한(HOOK_STDIN_READ_LIMIT_MS 3000)+5s 여유 안에 fd0 반납·완주
  } finally { try { child.stdin.end(); } catch { /* 자식 종료 뒤 정리 */ } }
});

// ② 비파이프 stdin — 즉시 빈 입력으로 완주 (TTY·ignore fd0 도 영구 블록이 아니어야 한다).
test('els _wake-request child completes immediately with a non-piped stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-wake-fd0-')); dirs.push(dir);
  const started = Date.now();
  const child = Bun.spawn(['bun', '-e', script, 'els', '_wake-request'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const code = await child.exited;
  expect(code).toBe(1); // 비파이프 → 즉시 빈 입력 → JSON.parse('') throw → exitCode 1 — 블록 없이 즉시 완주
  expect(Date.now() - started).toBeLessThan(PIPED_STDIN_IDLE_TIMEOUT_MS); // 유휴 상한을 기다리지 않는다
});

// ③ 닫힌 정상 파이프 JSON — 기존 처리 보존 (파이프가 닫히면 JSON 이 즉시 읽힌다 — 65536 상한·소켓 없음 catch 경로 포함).
test('els _wake-request child still reads a properly closed piped JSON stdin (existing behavior preserved)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-wake-fd0-')); dirs.push(dir);
  const child = Bun.spawn(['bun', '-e', script, 'els', '_wake-request'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ wake: { messageId: 1, recipient: 'MK', from: 'OP' } }));
  child.stdin.end();
  const code = await child.exited;
  expect(code).toBe(1); // requestEls 소켓 없음 → catch exitCode 1 — 그러나 파이프 정상 경로도 블록 없이 완주
});