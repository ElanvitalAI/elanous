// ★ OBS-T3(2026-07-31) — CLI 가 파이프 본문을 읽을 때 **무한 대기하지 않게** 하는 단일 심.
//
// 결함: `if (!process.stdin.isTTY) { for await (const c of process.stdin) … }` 이 세 CLI 에 복사돼
// 있었다(`memory add` · `self log` · `self utterance`). 비-TTY 는 *"파이프다"* 를 뜻하지 않는다 —
// 하니스·에이전트·백그라운드 실행에서 stdin 은 **닫히지 않는 unix 소켓**이라 EOF 가 영원히 안 온다.
// ⇒ 실측: `elanous self log` 가 **17분 넘게 행**(주 스레드 kevent64 · CPU 0.0 · 네트워크 0), 같은 명령이
// `< /dev/null` 에서는 **0.43초** 완주. ⛔ 에러가 아니라 **행**이라 자기인지 기록이 조용히 유실됐다.
//
// ⚠️ 하필 `self log` 는 *"변경 후 항상 self-log"*(상시지시) 의 그 명령이고, 행이 나는 곳은 **자동화
// 맥락뿐**이다 — 사람이 터미널에서 치면 `isTTY` 라 안 난다. **자동화에서만 조용히 죽는 형태.**
//
// 두 겹으로 막는다:
//   ① FIFO 게이트 — 진짜 파이프(`echo x | elanous …`)만 읽는다. 소켓·tty·`< /dev/null` 은 건너뛴다.
//   ② 유휴 타임아웃 — FIFO 인데 쓰는 쪽이 침묵하면 끊는다. ⭐ **청크가 오면 리셋**하므로 느리지만
//      진행 중인 생산자는 절대 잘리지 않는다(총 시간 상한이 아니라 **침묵 상한**이다).
import { fstatSync } from 'node:fs';
import { debug } from '../debug/log.js';

/** 파이프가 아무것도 안 쓰고 침묵할 때 끊는 상한(ms). ⛔ 총 읽기 시간이 아니라 **유휴** 시간이다.
 *  ⛔ export 하지 않는다 — 밖에 소비자가 없다(죽은 export 는 계약처럼 읽힌다). 호출부가 조절해야 할
 *  근거가 생기면 그때 `idleTimeoutMs` 인자로 주거나 config-first 규율로 뺀다. */
export const PIPED_STDIN_IDLE_TIMEOUT_MS = 2000;

/** 진짜 파이프인가. ⛔ `!isTTY` 로 판정하지 마라 — 소켓·리다이렉션이 전부 여기에 걸린다. */
export function stdinLooksPiped(deps: { isTTY?: boolean; fstat?: (fd: number) => { isFIFO(): boolean } } = {}): boolean {
  const isTTY = deps.isTTY ?? process.stdin.isTTY;
  if (isTTY) return false;
  const stat = deps.fstat ?? ((fd: number) => fstatSync(fd));
  try {
    return stat(0).isFIFO();
  } catch {
    return false;   // 잴 수 없으면 읽지 않는다(행보다 미수신이 낫다)
  }
}

/** ⛔ `destroy` 는 **선택이 아니다** — 유휴 타임아웃이 대기 중인 이터레이터를 놓는 유일한 수단이고,
 *  없으면 *"절대 행 안 난다"* 는 이 모듈의 불변식이 **호출부에 따라 깨진다**(리뷰 2R).
 *  ⚠️ 비동기 제너레이터의 `.return()` 은 진행 중인 `next()` 뒤에 큐잉되므로 **멈춘 읽기를 못 깨운다** —
 *  스트림 자신이 끊어 줘야 한다. `process.stdin` 은 이 계약을 만족한다. */
export interface PipedStdinSource extends AsyncIterable<Buffer | string> {
  destroy: (error?: Error) => void;
}

/**
 * 파이프로 들어온 본문을 읽는다. 파이프가 아니면 **읽지 않고 즉시 `''`**.
 * ⛔ 어떤 경우에도 무한 대기하지 않는다 — 유휴 타임아웃에 걸리면 그때까지 받은 것을 돌려주고
 * 그 사실을 관측에 남긴다(조용한 절단 금지).
 */
export async function readPipedStdin(deps: {
  isPiped?: boolean;
  stream?: PipedStdinSource;
  idleTimeoutMs?: number;
} = {}): Promise<string> {
  const isPiped = deps.isPiped ?? stdinLooksPiped();
  if (!isPiped) return '';

  const stream = deps.stream ?? (process.stdin as unknown as PipedStdinSource);
  const idleTimeoutMs = deps.idleTimeoutMs ?? PIPED_STDIN_IDLE_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let timedOut = false;
  let readError: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    timedOut = true;
    try { stream.destroy(); } catch { /* 이미 닫힘 — 무해 */ }
  };
  const arm = (resolve: () => void): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { stop(); resolve(); }, idleTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  await new Promise<void>((resolve) => {
    arm(resolve);
    void (async () => {
      try {
        for await (const c of stream) {
          if (timedOut) break;
          const buf = Buffer.from(c as Buffer);
          chunks.push(buf);
          receivedBytes += buf.length;
          arm(resolve);           // ⭐ 진행 중이면 상한을 다시 민다
        }
      } catch (error) {
        // ⛔ 전부 삼키지 않는다 — 타임아웃 때의 중단(stop() 의 destroy)만 정상 경로다.
        //    진짜 I/O 오류를 삼키면 **부분 입력이 성공으로 둔갑**한다(리뷰 1R must-fix).
        if (!timedOut) readError = error;
      }
      if (timer) clearTimeout(timer);
      resolve();
    })();
  });
  if (timer) clearTimeout(timer);
  if (readError) throw readError;

  if (timedOut) {
    // ⚠️ `bytes` 는 **수신 바이트**다 — trim 후 문자열 길이(UTF-16 코드유닛)가 아니다(리뷰 1R).
    debug.log('cli.stdin', 'piped-read-idle-timeout', { idleTimeoutMs, bytes: receivedBytes }, { level: 'warn' });
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}
