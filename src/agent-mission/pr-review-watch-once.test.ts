import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent-mission review-watch --once', () => {
  test('목록 조회 실패는 안내를 출력하고 scanned 없이 비정상 종료한다; 진짜 빈 목록은 정상 종료한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-watch-once-'));
    const gh = join(dir, 'gh');
    const run = () => Bun.spawnSync(
      ['bun', 'bin/elanous.mjs', '--test', 'agent-mission', 'review-watch', '--once', '--dry-run'],
      { cwd: process.cwd(), env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      writeFileSync(gh, '#!/bin/sh\necho "HTTP 401: Bad credentials" >&2\nexit 1\n');
      chmodSync(gh, 0o755);
      const failed = run();
      const failedOut = new TextDecoder().decode(failed.stdout) + new TextDecoder().decode(failed.stderr);
      expect(failed.exitCode).toBe(1);
      expect(failedOut).toContain('목록 조회 실패 (auth): gh auth login');
      expect(failedOut).not.toContain('scanned=');

      writeFileSync(gh, '#!/bin/sh\necho "HTTP 404: Not Found" >&2\nexit 1\n');
      const missing = run();
      const missingOut = new TextDecoder().decode(missing.stdout) + new TextDecoder().decode(missing.stderr);
      expect(missing.exitCode).toBe(1);
      expect(missingOut).toContain('목록 조회 실패 (not-found): gh repo view');
      expect(missingOut).not.toContain('scanned=');

      writeFileSync(gh, '#!/bin/sh\necho "[]"\n');
      const empty = run();
      expect(empty.exitCode).toBe(0);
      expect(new TextDecoder().decode(empty.stdout)).toContain('scanned=0 triggered=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
