import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboardingStep, scriptedIO, type GrokOnboardingDeps } from '../onboarding.js';
import { loginWithCodex, CODEX_DEVICE_LOGIN_URL, type CodexLoginProgress } from '../oauth/codex.js';

const code = 'ABCD-1234';
const completeUrl = 'https://auth.openai.com/codex/device?user_code=ABCD-1234';

async function codexStep(deps: GrokOnboardingDeps, inputs = ['1', '1', '']): Promise<{ output: string; commands: Array<[string, string[], string | undefined]> }> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-onboarding-'));
  const io = scriptedIO(inputs);
  const commands: Array<[string, string[], string | undefined]> = [];
  try {
    const cfg = await runOnboardingStep('llm', {
      io,
      path: join(dir, 'config.json'),
      grokDeps: {
        detectProviders: async () => [],
        hasCodexCliLogin: () => false,
        loadCodexTokens: () => null,
        // OB5b — own PKCE browser login runs first; unavailable by default so each test picks its path.
        loginWithCodexBrowser: async () => { throw new Error('unavailable'); },
        // W3 asks «SSH · no display» from this env — default to a local desktop so the browser path stays under test.
        codexEnv: { DISPLAY: ':0' },
        ...deps,
        runAuthCommand: (cmd, args, input) => {
          commands.push([cmd, args, input]);
          return deps.runAuthCommand?.(cmd, args, input) ?? true;
        },
      },
    });
    expect(cfg.llm.provider).toBe('openai-codex');
    expect(cfg.llm.apiKey).toBeUndefined();
    return { output: io.outputs.join('\n'), commands };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deviceLogin(record: CodexLoginProgress[]) {
  return (async (opts: { onProgress?: (p: CodexLoginProgress) => void }) => {
    const progress: CodexLoginProgress = { type: 'user_code', userCode: code, loginUrl: completeUrl };
    record.push(progress);
    opts.onProgress?.(progress);
    opts.onProgress?.({ type: 'saved' });
    return {} as Awaited<ReturnType<NonNullable<GrokOnboardingDeps['loginWithCodex']>>>;
  }) as NonNullable<GrokOnboardingDeps['loginWithCodex']>;
}

const browserOK: Awaited<ReturnType<NonNullable<GrokOnboardingDeps['spawnCodexLogin']>>> = {
  ok: true, mode: 'browser', exitCode: 0, output: '',
};

describe('onboarding Codex OAuth browser-first', () => {
  test('local GUI calls browser login and never requests a device code on success', async () => {
    const called: string[] = [];
    const requests: CodexLoginProgress[] = [];
    const { output, commands } = await codexStep({
      codexEnv: { DISPLAY: ':1' },
      isHeadless: env => !env.DISPLAY,
      loginWithCodexBrowser: async () => { called.push('browser'); return {} as never; },
      spawnCodexLogin: async () => { called.push('path-codex'); return browserOK; },
      loginWithCodex: deviceLogin(requests),
    });
    expect(called).toEqual(['browser']);
    expect(requests).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(output).toContain('브라우저에서 로그인을 마치세요 — 끝나면 자동으로 이어집니다');
    expect(output).toContain('→ ChatGPT/Codex 로그인을 씁니다.');
  });

  test('browser spawn failure falls back to visible device code, auto-open and clipboard', async () => {
    const requests: CodexLoginProgress[] = [];
    const { output, commands } = await codexStep({
      isHeadless: () => false,
      authPlatform: 'linux',
      spawnCodexLogin: async () => { throw new Error('binary missing'); },
      loginWithCodex: deviceLogin(requests),
    });
    expect(requests).toHaveLength(1);
    expect(commands).toEqual([
      ['xdg-open', [completeUrl], undefined],
      ['wl-copy', [], code],
      ['notify-send', ['Elanous', `인증 코드 ${code} — 클립보드에 복사됨 · 붙여넣기만`], undefined],
    ]);
    expect(output).toContain(`아무 브라우저에서 열기: ${completeUrl}`);
    expect(output).toContain(`코드 입력:             ${code}`);
    expect(output).toContain('코드를 복사했습니다');
    expect(output).toContain('로그인을 기다리는 중');
    expect(output).toContain('로그인했습니다. 저장했습니다.');
  });

  test('macOS local fallback uses open and pbcopy', async () => {
    const { commands } = await codexStep({
      isHeadless: () => false,
      authPlatform: 'darwin',
      spawnCodexLogin: async () => ({ ...browserOK, ok: false, exitCode: null }),
      loginWithCodex: deviceLogin([]),
    });
    expect(commands).toEqual([
      ['open', [completeUrl], undefined],
      ['pbcopy', [], code],
      ['osascript', ['-e', `display notification "인증 코드 ${code} — 클립보드에 복사됨 · 붙여넣기만" with title "Elanous"`], undefined],
    ]);
  });

  test('headless skips browser login and starts device code immediately', async () => {
    const requests: CodexLoginProgress[] = [];
    let browserCalls = 0;
    const { output, commands } = await codexStep({
      codexEnv: {},
      isHeadless: env => !env.DISPLAY,
      authPlatform: 'darwin',
      spawnCodexLogin: async () => { browserCalls++; return browserOK; },
      loginWithCodex: deviceLogin(requests),
    });
    expect(browserCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(commands).toEqual([['pbcopy', [], code]]);
    expect(output).toContain(`코드 입력:             ${code}`);
  });

  test('clipboard and browser command failures do not interrupt polling or hide URL/code', async () => {
    const requests: CodexLoginProgress[] = [];
    const { output, commands } = await codexStep({
      isHeadless: () => false,
      authPlatform: 'linux',
      spawnCodexLogin: async () => ({ ...browserOK, ok: false, exitCode: null }),
      loginWithCodex: deviceLogin(requests),
      runAuthCommand: () => { throw new Error('unavailable'); },
      writeAuthTerminal: () => false,
    });
    expect(requests).toHaveLength(1);
    expect(commands.map(([cmd]) => cmd)).toEqual(['xdg-open', 'wl-copy', 'xclip', 'notify-send']);
    expect(output).toContain(`아무 브라우저에서 열기: ${completeUrl}`);
    expect(output).toContain(`코드 입력:             ${code}`);
    expect(output).not.toContain('코드를 복사했습니다');
    expect(output).toContain('로그인했습니다. 저장했습니다.');
  });

  test('OSC52 copies code when clipboard utilities are unavailable', async () => {
    const writes: string[] = [];
    const { output } = await codexStep({
      isHeadless: () => true,
      authPlatform: 'linux',
      loginWithCodex: deviceLogin([]),
      runAuthCommand: () => false,
      writeAuthTerminal: data => { writes.push(data); return true; },
    });
    expect(writes).toEqual([`\x1b]52;c;${Buffer.from(code).toString('base64')}\x07`]);
    expect(output).toContain('코드를 복사했습니다');
  });

  test('device authorization response prefers complete URI, preserving plain URL when absent', async () => {
    for (const [responseUrl, expected] of [[completeUrl, completeUrl], [undefined, CODEX_DEVICE_LOGIN_URL]] as const) {
      const progress: CodexLoginProgress[] = [];
      const fetchImpl = (async (url: string) => {
        if (url.endsWith('/usercode')) return {
          status: 200,
          json: async () => ({ user_code: code, device_auth_id: 'device-id',
            ...(responseUrl ? { verification_uri_complete: responseUrl } : {}) }),
        };
        return { status: 403, json: async () => ({}) };
      }) as unknown as typeof fetch;
      await expect(loginWithCodex({
        fetchImpl,
        sleepImpl: async () => {},
        maxWaitMs: -1,
        onProgress: p => progress.push(p),
      })).rejects.toThrow('timed out');
      expect(progress[0]).toEqual({ type: 'user_code', userCode: code, loginUrl: expected });
    }
  });

  test('existing login stays on oauth-keep without spawning any login', async () => {
    const { output, commands } = await codexStep({
      hasCodexCliLogin: () => true,
      spawnCodexLogin: async () => { throw new Error('must not spawn'); },
      loginWithCodex: async () => { throw new Error('must not request code'); },
    }, ['1', 'y', '']);
    expect(commands).toHaveLength(0);
    expect(output).toContain('→ using your existing ChatGPT/Codex login.');
  });
});

test('OB5d — a headless onboarding prints why there is no browser before the device code', async () => {
  const { output } = await codexStep({
    codexEnv: { SSH_CLIENT: '10.0.0.2 51000 22' },
    isHeadless: () => true,
    authPlatform: 'linux',
    loginWithCodex: deviceLogin([]),
  });
  expect(output).toContain('원격(ssh) 접속이고 화면이 없어 브라우저를 열 수 없습니다');
  expect(output.indexOf('원격(ssh) 접속이고')).toBeLessThan(output.indexOf('코드 입력:'));
});
