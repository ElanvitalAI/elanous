// 호출 범위 codex 계정 override 시험 — 겹친 호출 격리 · 명시 env 우선 · 범위 밖 불변 · 예외 경로 잔존 0.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentCodexAccountOverride, effectiveCodexAccountName, withCodexAccountOverride } from './codex-account-override.js';
import { resolveCodexAccountForRun } from './codex-account-store.js';

const dir = mkdtempSync(join(tmpdir(), 'codex-override-'));
const storePath = join(dir, 'auth.json');
const counterPath = join(dir, 'counter.json');
const baseEnv = { ELANOUS_CODEX_ACCOUNT_HOME: join(dir, 'team-home'), CODEX_HOME: join(dir, 'default-home') } as NodeJS.ProcessEnv;
const resolve = (env: NodeJS.ProcessEnv = baseEnv) => resolveCodexAccountForRun(env, { storePath, counterPath });

describe('withCodexAccountOverride', () => {
  test('범위 밖에서는 보이지 않고 process.env 를 바꾸지 않는다', () => {
    const before = process.env.ELANOUS_CODEX_ACCOUNT;
    withCodexAccountOverride('team', () => { expect(currentCodexAccountOverride()).toBe('team'); expect(process.env.ELANOUS_CODEX_ACCOUNT).toBe(before); });
    expect(currentCodexAccountOverride()).toBeUndefined();
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBe(before);
  });
  test('겹친 비동기 호출 A(team)·B(default) 가 서로 섞이지 않는다 — resolveCodexAccountForRun 이 각자 계정을 돌려준다', async () => {
    let releaseA!: () => void;
    const hold = new Promise<void>((r) => { releaseA = r; });
    const a = withCodexAccountOverride('team', async () => { const first = resolve().name; await hold; return [first, resolve().name]; });
    const b = await withCodexAccountOverride('default', async () => { await Promise.resolve(); return resolve().name; });
    releaseA();
    expect(await a).toEqual(['team', 'team']);
    expect(b).toBe('default');
    expect(resolve().name).toBe('default'); // 범위 밖 = 원래 해석
  });
  test('명시 env(ELANOUS_CODEX_ACCOUNT) 가 있으면 관문 override 보다 먼저 이긴다(우선순위: 명시 env > 관문 선택)', () => {
    const env = { ...baseEnv, ELANOUS_CODEX_ACCOUNT: 'default' } as NodeJS.ProcessEnv;
    withCodexAccountOverride('team', () => {
      expect(resolve(env).name).toBe('default');
      expect(effectiveCodexAccountName(env)).toBe('default');
    });
  });
  test('예외가 나도 범위가 새지 않는다', async () => {
    await expect(withCodexAccountOverride('team', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(currentCodexAccountOverride()).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
