// ── 로그 안전망 — 콘솔 error/warn 브릿지 + 크래시 캡처 (LF5 essential · 2026-07-13) ──
//
// 감사 실측: 데몬(nexus)의 console.error/warn 40건이 어느 트레일에도 안 잡히고,
// uncaughtException/unhandledRejection 핸들러가 **전무**해 데몬이 죽어도 파일
// 트레일/logs.db 에 아무것도 안 남았다. 40곳 수동 편집 대신 프로세스 레벨
// 안전망 — 기존 콘솔 출력은 그대로(supervisor stdout 캡처 불변), debug.log
// 병행만 추가. 미래 call site 도 자동 커버.
//
// 카테고리 설계: `nexus.console.error`/`nexus.console.warn`/`nexus.crash.*` —
// 끝 세그먼트가 severity 라 logs.db 의 level 컬럼이 자동으로 error/warn 물질화
// (deriveLogLevel 은 category 접미사도 본다). `elanous logs --level error` 에 잡힘.
//
// OH10 (2026-07-24): 위 접미사 유도에 더해 **명시 level** 도 함께 실는다
// (`debug.log(…, { level })`). PR-b 에서 접미사 유도가 제거돼도 데몬 크래시가
// debug 로 떨어지지 않도록 원자성 확보 — 지금은 유도+명시 둘 다 error/warn 이라 무해.
//
// 설치 대상: **데몬 상주 프로세스만**(nexus boot). CLI one-shot 은 사용자 대면
// 출력이 로그가 아니므로 설치 금지(PLAN §LF5 판정).
//
// canonical: 내부 문서 `FEATURE-unified-log-fabric-2026-07-13` §0-LF5.

import { flushDiagnostics, logDiagnostic } from './diagnostic-sink.js';

/** console args → 한 줄 요약(캡 500자). 객체는 JSON 시도 후 String 폴백. */
export function formatConsoleArgs(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  });
  const line = parts.join(' ');
  return line.length > 500 ? `${line.slice(0, 500)}…` : line;
}

export interface LogSafetyNetOpts {
  /** category 루트(기본 'nexus') — 다른 상주 프로세스가 재사용 시 자기 표면으로. */
  componentRoot?: string;
  /** 크래시 시 종료 함수(테스트 주입) — 기본 process.exit. */
  exit?: (code: number) => void;
  /** uncaughtException 에서 프로세스를 죽일지(기본 true — 종전 의미론 보존:
   *  핸들러 부재 시에도 죽었으므로, 포렌식만 추가하고 죽음은 유지). */
  exitOnUncaught?: boolean;
}

let installed = false;
let installedComponentRoot: string | null = null;
let activeUninstall: (() => void) | null = null;

export interface LogSafetyNetInstallResult {
  installed: boolean;
  requestedComponentRoot: string;
  installedComponentRoot: string;
  uninstall: () => void;
}

/** Tests only — remove the active process-level safety net and clear its state. */
export function _resetLogSafetyNetForTests(): void {
  activeUninstall?.();
}

/** 콘솔 error/warn 브릿지 + 크래시 캡처 설치(프로세스당 1회 · 중복 거부).
 *  반환은 설치 여부와 해제 함수를 함께 제공한다. */
export function installLogSafetyNet(opts: LogSafetyNetOpts = {}): LogSafetyNetInstallResult {
  const root = opts.componentRoot ?? 'nexus';
  if (installed) {
    const existingRoot = installedComponentRoot ?? 'nexus';
    logDiagnostic('mss.logging.log-safety-net.duplicate.warn', 'duplicate install refused', {
      requestedComponentRoot: root,
      installedComponentRoot: existingRoot,
    }, { level: 'warn' });
    return {
      installed: false,
      requestedComponentRoot: root,
      installedComponentRoot: existingRoot,
      uninstall: () => {},
    };
  }
  installed = true;
  installedComponentRoot = root;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const exitOnUncaught = opts.exitOnUncaught ?? true;

  // ── 콘솔 브릿지 — 원 출력 유지 + debug.log 병행. 재진입 가드(브릿지가
  // 유발한 콘솔 출력이 다시 브릿지를 타는 루프 차단 — 로그 평면 자기참조
  // 금지 불변식의 콘솔판).
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  let inBridge = false;
  const bridge = (kind: 'error' | 'warn', orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      orig(...args);
      if (inBridge) return;
      inBridge = true;
      try { logDiagnostic(`${root}.console.${kind}`, formatConsoleArgs(args), undefined, { level: kind }); }
      catch { /* 안전망이 앱을 못 죽인다 */ }
      finally { inBridge = false; }
    };
  console.error = bridge('error', origError) as typeof console.error;
  console.warn = bridge('warn', origWarn) as typeof console.warn;

  // ── 크래시 캡처 — 죽기 전에 포렌식을 남기고 flush. uncaught 는 종전
  // 의미론(죽음) 보존, unhandledRejection 은 기록만(런타임 기본 비치명).
  const onUncaught = (err: unknown): void => {
    try {
      logDiagnostic(`${root}.crash.uncaught.error`, err instanceof Error ? `${err.name}: ${err.message}` : String(err), {
        stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
      }, { level: 'error' });
      flushDiagnostics();
    } catch { /* noop */ }
    origError('[log-safety-net] uncaughtException:', err);
    if (exitOnUncaught) exit(1);
  };
  const onRejection = (reason: unknown): void => {
    try {
      logDiagnostic(`${root}.crash.unhandled-rejection.error`, reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason), {
        stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
      }, { level: 'error' });
      flushDiagnostics();
    } catch { /* noop */ }
    origError('[log-safety-net] unhandledRejection:', reason);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  let uninstalled = false;
  const uninstall = () => {
    if (uninstalled || activeUninstall !== uninstall) return;
    uninstalled = true;
    console.error = origError as typeof console.error;
    console.warn = origWarn as typeof console.warn;
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    installed = false;
    installedComponentRoot = null;
    activeUninstall = null;
  };
  activeUninstall = uninstall;
  return {
    installed: true,
    requestedComponentRoot: root,
    installedComponentRoot: root,
    uninstall,
  };
}
