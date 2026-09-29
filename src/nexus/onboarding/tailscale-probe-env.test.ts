import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tailscaleExecEnv } from './tailscale-probe.js';

const APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

describe('tailscale 실행 환경 — launchd 처럼 빈 환경에서도 CLI 로', () => {
  test('TAILSCALE_BE_CLI=1 을 더하고 나머지는 그대로', () => {
    const env = tailscaleExecEnv({ PATH: '/usr/bin', HOME: '/h' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', TAILSCALE_BE_CLI: '1' });
  });

  // 📏 2026-09-27 운영: 앱 번들 바이너리는 TERM 없는 환경에서 «GUI failed to start» 를 rc 0 으로 냈다.
  test.skipIf(process.platform !== 'darwin' || !existsSync(APP))('macOS 앱 번들: 빈 환경 + 이 환경이면 JSON 을 낸다', () => {
    const bare = { HOME: process.env.HOME ?? '/', PATH: '/usr/bin:/bin' };
    const out = spawnSync(APP, ['status', '--json'], { env: tailscaleExecEnv(bare), encoding: 'utf8', timeout: 10_000 });
    expect(out.stdout.trimStart().startsWith('{')).toBe(true);
  });
});
