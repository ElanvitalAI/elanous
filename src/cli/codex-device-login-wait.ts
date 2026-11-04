import type { ProviderAuthState } from '../oauth/store.js';
import type { CodexLoginOpts } from '../oauth/codex.js';

export interface CodexDeviceLoginWaitIO {
  print(message: string): void;
  updateLine?(message: string): void;
  finishLine?(): void;
  onInterrupt?(handler: () => void): () => void;
}

export type CodexDeviceLoginWaitResult =
  | { kind: 'complete'; state: ProviderAuthState }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown };

export function formatCodexDeviceLoginFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Codex 로그인 실패: ${detail}`;
}

/** Run device-code login with one stable wait line and cooperative Ctrl-C cancellation. */
export async function runCodexDeviceLoginWait(
  login: (options: CodexLoginOpts) => Promise<ProviderAuthState>,
  io: CodexDeviceLoginWaitIO,
  options: { headless: boolean; introMessage?: string },
): Promise<CodexDeviceLoginWaitResult> {
  const controller = new AbortController();
  let startedAt: number | undefined;
  let lineStarted = false;
  let waitingLinePrinted = false;
  let lastPlainProgressSecond = -10;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeInterrupt: (() => void) | undefined;
  let resolveInterrupt!: () => void;
  const interrupt = new Promise<'cancel'>(resolve => { resolveInterrupt = () => resolve('cancel'); });
  const elapsedSeconds = () => Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000);
  const updateWaitLine = () => {
    if (!options.headless || startedAt === undefined || controller.signal.aborted) return;
    const line = `Codex 로그인 대기 중… ${elapsedSeconds()}초 · Ctrl-C 취소`;
    if (io.updateLine) {
      lineStarted = true;
      io.updateLine(line);
    } else if (elapsedSeconds() - lastPlainProgressSecond >= 10) {
      // Without a terminal line editor, keep occasional progress readable without dots.
      io.print(line);
      lastPlainProgressSecond = elapsedSeconds();
    }
  };

  removeInterrupt = io.onInterrupt?.(() => {
    controller.abort();
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    resolveInterrupt();
  });
  const loginResult = Promise.resolve().then(() => login({
    signal: controller.signal,
    onProgress: event => {
      if (controller.signal.aborted) return;
      if (event.type === 'user_code') {
        io.print(options.introMessage ?? (options.headless
          ? '헤드리스 Codex 로그인 · 브라우저에서 아래 주소를 열고 코드를 입력하세요'
          : 'Codex 로그인: 브라우저에서 아래 주소를 열고 코드를 입력하세요'));
        io.print(`주소: ${event.loginUrl ?? 'https://auth.openai.com/codex/device'}`);
        io.print(`코드: ${event.userCode ?? '(없음)'}`);
        startedAt = Date.now();
        updateWaitLine();
        if (options.headless) timer = setInterval(updateWaitLine, 1_000);
      } else if (event.type === 'polling') {
        if (options.headless) updateWaitLine();
        else if (!waitingLinePrinted) {
          io.print('Codex 로그인을 기다리는 중… · Ctrl-C 취소');
          waitingLinePrinted = true;
        }
      } else if (event.type === 'exchanging') {
        if (timer !== undefined) { clearInterval(timer); timer = undefined; }
        if (options.headless) {
          io.updateLine?.(`Codex 로그인 확인 중… ${elapsedSeconds()}초`);
          lineStarted ||= io.updateLine !== undefined;
        } else io.print('Codex 로그인을 확인하는 중…');
      }
    },
  })).then(
    state => ({ kind: 'complete' as const, state }),
    error => ({ kind: 'failed' as const, error }),
  );

  try {
    const outcome = await Promise.race([loginResult, interrupt]);
    if (outcome === 'cancel') {
      // The login implementation must observe AbortSignal and settle before
      // cancellation is reported, so no in-flight auth work survives the UI.
      const settled = await loginResult;
      if (lineStarted) io.finishLine?.();
      if (settled.kind === 'complete') return settled;
      return { kind: 'cancelled' };
    }
    if (lineStarted) io.finishLine?.();
    return outcome;
  } finally {
    if (timer !== undefined) clearInterval(timer);
    removeInterrupt?.();
  }
}
