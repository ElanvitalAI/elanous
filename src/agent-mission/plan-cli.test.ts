import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { chooseRung } from './tool-ladder.js';
import type { EnvProfile } from './env-profile.js';

const root = join(import.meta.dir, '../..');
const cli = join(root, 'bin/elanous.mjs');
function invoke(...args: string[]) {
  const result = Bun.spawnSync(['bun', cli, '--test', ...args], {
    cwd: root,
    env: { ...process.env, ELANOUS_TEST_INSTANCE: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const profile: EnvProfile = {
  os: 'linux', shell: '/bin/sh', packageManagers: [], tools: [],
  credentials: { github: false, openai: false, anthropic: false }, network: false, disk: null,
};

describe('environment CLI and display-only mission plan', () => {
  test('env profile emits the collected profile as JSON and readable text', () => {
    const json = invoke('env', 'profile', '--json');
    expect(json.code).toBe(0);
    const data = JSON.parse(json.stdout);
    expect(data).toEqual(expect.objectContaining({ os: expect.any(String), tools: expect.any(Array), credentials: expect.any(Object) }));
    expect(invoke('env', 'profile').stdout).toContain('Package managers:');
  }, 30_000);

  test('plan JSON preserves the mission and returns profile plus choice without executing it', () => {
    const mission = '이 CSV 에서 금액 합계를 JSON 으로';
    const result = invoke('agent-mission', 'plan', mission, '--json');
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toEqual(expect.objectContaining({ mission, rung: 1, tool: 'jq', profile: expect.any(Object) }));
    expect(data.profile).toHaveProperty('disk');
    expect(invoke('agent-mission', 'plan', mission).stdout).toContain('Starting rung: 1');
  }, 30_000);

  test('missing tools are only proposed, and existing mission entrypoint remains registered', () => {
    expect(chooseRung('이 영상 앞 10초를 GIF 로', profile)).toEqual(expect.objectContaining({ rung: 1, tool: 'ffmpeg', install: ['ffmpeg'] }));
    expect(chooseRung('열린 PR 중 사흘 넘은 draft 목록', profile).rung).toBe(2);
    expect(chooseRung('결제 모듈에 재시도 추가하고 PR', profile).rung).toBe(4);
    expect(chooseRung('큰 리팩터 · 다른 눈 리뷰까지', profile).rung).toBe(5);
    const help = invoke('agent-mission', '--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('mission|run [options] [text...]');
    expect(invoke('agent-mission', 'mission', '--help').stdout).toContain('Usage: elanous agent-mission mission|run [options] [text...]');
  });
});
