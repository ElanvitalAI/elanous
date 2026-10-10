// 텔레그램 러너 운영 전환 준비(2026-09-25) — 늦은 잠금 획득 · 서비스 설치 · 야간 갱신의 러너 재시작.
import { describe, expect, test } from 'bun:test';
import { retryingAcquire } from './telegram-run.js';
import { installTelegramService, renderTelegramServiceFile } from './telegram-service.js';
import { updateTelegramRunner } from './cli/self-update.js';

describe('retryingAcquire — a refused bot is retried until the lock frees', () => {
  test('keeps trying and returns the first success', async () => {
    let n = 0;
    const r = await retryingAcquire(async () => ({ ok: ++n >= 3 }), { sleep: async () => {}, isStopping: () => false });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });
  test('stops trying once the runner is stopping', async () => {
    let n = 0; let stop = false;
    const r = await retryingAcquire(async () => { n++; stop = true; return { ok: false }; }, { sleep: async () => {}, isStopping: () => stop });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });
});

describe('installTelegramService', () => {
  const file = renderTelegramServiceFile({ platform: 'darwin', home: '/h', logDir: '/h/.elanous/logs', command: ['/b/bun', '/m/elanous.mjs', 'telegram', 'run'], uid: 501 })!;
  const fakeFs = (initial: Record<string, string> = {}) => {
    const files = { ...initial }; const ran: string[] = [];
    return { files, ran, deps: {
      exists: (p: string) => p in files, readFile: (p: string) => files[p]!, writeFile: (p: string, t: string) => { files[p] = t; },
      mkdir: () => {}, chmod: () => {}, rename: (a: string, b: string) => { files[b] = files[a]!; delete files[a]; },
      run: (c: string, a: string[]) => { ran.push(`${c} ${a.join(' ')}`); return { status: 0, stderr: '' }; },
    } };
  };
  test('refuses unless the operating config already says poller=standalone', () => {
    const f = fakeFs();
    const r = installTelegramService(file, undefined, 501, f.deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('telegram.poller');
    expect(f.ran).toEqual([]);
    expect(Object.keys(f.files)).toEqual([]);
  });
  test('writes the plist and (re)bootstraps it on macOS', () => {
    const f = fakeFs();
    const r = installTelegramService(file, 'standalone', 501, f.deps);
    expect(r.ok).toBe(true);
    expect(f.files[file.path]).toBe(file.content);
    expect(f.ran).toEqual([`launchctl bootout gui/501/com.elanous.telegram`, `launchctl bootstrap gui/501 ${file.path}`]);
  });
  test('a different existing file is backed up, not overwritten in place', () => {
    const f = fakeFs({ [file.path]: 'old' });
    const r = installTelegramService(file, 'standalone', 501, f.deps);
    expect(r.backup).toBeDefined();
    expect(f.files[r.backup!]).toBe('old');
    expect(f.files[file.path]).toBe(file.content);
  });
});

describe('updateTelegramRunner (self-update)', () => {
  const ran: string[] = [];
  const run = (c: string, a: string[]) => { ran.push(`${c} ${a.join(' ')}`); return { status: 0, stderr: '' }; };
  const decision = { exitCode: 11, verdict: 'restart', from: 'aaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' } as never;
  test('not installed → skipped, nothing run', () => {
    ran.length = 0;
    expect(updateTelegramRunner(decision, true, { telegramRunnerInstalled: () => false, os: 'darwin' }, run, '/c').verdict).toBe('skipped');
    expect(ran).toEqual([]);
  });
  test('same commit → unchanged', () => {
    expect(updateTelegramRunner({ ...(decision as object), to: 'aaaaaaaaaaaa1234' } as never, true, { telegramRunnerInstalled: () => true, os: 'darwin' }, run, '/c').verdict).toBe('unchanged');
  });
  test('new commit on macOS → launchctl kickstart -k the runner label', () => {
    ran.length = 0;
    const r = updateTelegramRunner(decision, true, { telegramRunnerInstalled: () => true, os: 'darwin', uid: 501 }, run, '/c');
    expect(r.verdict).toBe('restarted');
    expect(ran).toEqual(['launchctl kickstart -k gui/501/com.elanous.telegram']);
  });
  test('unknown daemon commit → no restart', () => {
    expect(updateTelegramRunner({ exitCode: 2 } as never, true, { telegramRunnerInstalled: () => true, os: 'linux' }, run, '/c').verdict).toBe('unknown');
  });
});
