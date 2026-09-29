// nexus-ios-bind.ts — L2 daemon helper · 시뮬레이터 booted device 에 host/port/token inject
//
// PLAN: 내부 문서 `PLAN-ios-companion-app-2026-05-08` §2.3 의 Stage A · iOS Companion endpoint
//       adapt 의 L2 layer (FEATURE doc §1.4 + TEST-SCENARIOS §3.4 의 후속 helper)
// 형제: apps/ios/ElanousiOS/ElanousiOS/Shared/NexusEndpoint.swift (L1+L3 land · #2557)
//
// L1 = Settings TextField (@AppStorage)
// L2 = 본 helper · `bun run dev nexus ios-bind` · daemon 현재 host/port 자동 검출 +
//      `xcrun simctl spawn booted defaults write com.elanvitalai.elanous.ios <key> ...`
//      3 회 (nexusHost · nexusPort · bearerToken)
// L3 = NexusDiscovery auto-discovery (in-app · 후보 list 순회)
//
// Stage 의식:
//   ✅ Stage A simulator — 본 helper 의 entire scope
//   ⚠️ Stage B 실 iPhone — `xcrun simctl` 사용 불가 · 사용자가 Settings 에 수동 입력
//
// DI seam · test 용:
//   · spawnSync override (default: node:child_process)
//   · readRuntime override (default: readNexusRuntime)
//   · readToken override (default: file read `~/.elanous/acp-token`)

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { readNexusRuntime, type NexusRuntimeMeta } from '../nexus/runtime.js';

export interface IosBindOpts {
  /** App bundle id 의 UserDefaults 에 write. default = elanous spec. */
  bundleId?: string;
  /** Host 명시 override — runtime sidecar 무시. test/production 동시 실행 또는
   *  stale runtime sidecar 케이스. */
  hostOverride?: string;
  /** Port 명시 override — runtime sidecar 무시. */
  portOverride?: number;
  /** Token inject 비활성. default = false (token 도 inject). */
  noToken?: boolean;
  /** Korean IME bypass — `asciiKeyboard` UserDefault 3-state inject:
   *  · `true`  → write `asciiKeyboard=true` (headless dogfood 진입)
   *  · `false` → write `asciiKeyboard=false` (사용자 IME 복원 · script trap cleanup)
   *  · `undefined` → skip (host/port/token 만 inject · default)
   *  ChatView 가 `@AppStorage("asciiKeyboard")` 읽어서 true 시
   *  `.keyboardType(.asciiCapable)` 강제. */
  asciiKeyboard?: boolean;
  /** Headless dogfood seed prompt — write `seedPrompt` UserDefault as
   *  string. ChatView onAppear 시 input 에 복사 + UserDefault clear
   *  (one-shot). IME 통과 0 (Korean / emoji / multiline 자유). 빈 문자열
   *  은 explicit clear · undefined 는 skip. `idb ui text` 의 IME 충돌
   *  없이 한글 prompt 도 자동 dogfood 가능. */
  seedPrompt?: string;
  /** 실행 대신 명령만 stdout 출력. default = false. */
  dryRun?: boolean;
  /** Test seam — child_process spawn 대체. */
  spawnSyncFn?: typeof defaultSpawnSync;
  /** Test seam — runtime sidecar reader 대체. */
  readRuntimeFn?: () => NexusRuntimeMeta | null;
  /** Test seam — token file reader 대체. */
  readTokenFn?: () => string | null;
  /** Test seam — host fallback (production daily driver 의 default). */
  hostFallback?: string;
}

export interface IosBindResult {
  ok: boolean;
  /** stderr 에 출력될 사람 가독 메시지. */
  message: string;
  /** Inject 된 host (또는 inject 시도 host). */
  host: string;
  /** Inject 된 port. */
  port: number;
  /** Token inject 여부 + 길이 (보안 · 실 token 노출 X). */
  tokenInjected: boolean;
  tokenLength: number;
  /** Inject 대상 bundle id. */
  bundleId: string;
}

const DEFAULT_BUNDLE_ID = 'com.elanvitalai.elanous.ios';
const DEFAULT_HOST_FALLBACK = 'localhost';

/** `~/.elanous/acp-token` 읽기. 부재 시 null. */
function defaultReadToken(): string | null {
  const path = join(homedir(), '.elanous', 'acp-token');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** UserDefaults write 1 회. spawnSync exit code 0 = 성공. */
function defaultsWrite(
  spawnFn: typeof defaultSpawnSync,
  bundleId: string,
  key: string,
  type: 'string' | 'int' | 'bool',
  value: string,
  dryRun: boolean,
): { ok: boolean; cmd: string } {
  const args = [
    'simctl', 'spawn', 'booted',
    'defaults', 'write', bundleId, key,
  ];
  if (type === 'int') args.push('-int');
  else if (type === 'bool') args.push('-bool');
  args.push(value);
  const cmd = `xcrun ${args.join(' ')}`;
  if (dryRun) return { ok: true, cmd };
  const result = spawnFn('xcrun', args, { stdio: 'pipe' });
  return { ok: result.status === 0, cmd };
}

export function runNexusIosBind(opts: IosBindOpts = {}): IosBindResult {
  const bundleId = opts.bundleId ?? DEFAULT_BUNDLE_ID;
  const spawnFn = opts.spawnSyncFn ?? defaultSpawnSync;
  const readRuntime = opts.readRuntimeFn ?? readNexusRuntime;
  const readToken = opts.readTokenFn ?? defaultReadToken;
  const hostFallback = opts.hostFallback ?? DEFAULT_HOST_FALLBACK;
  const dryRun = opts.dryRun ?? false;

  // 1) daemon 현재 host/port — override 가 우선 · 없으면 runtime sidecar ·
  //    port 가 없으면 현재 우주의 daemon endpoint 를 조회한다.
  // daemon httpHost 가 `0.0.0.0` (모든 interface bind) 이면 simulator 입장에서
  // connect 가능한 loopback alias 로 치환. iOS simulator 는 host Mac 의 stack
  // 공유 → `localhost` / `127.0.0.1` 두 alias 모두 OK.
  const runtime = readRuntime();
  const endpoint = opts.portOverride === undefined && runtime?.httpPort === undefined
    ? resolveDaemonEndpoint()
    : null;
  const endpointUrl = endpoint ? new URL(endpoint.baseUrl) : null;
  const resolvedPort = endpointUrl?.port ? Number(endpointUrl.port) : undefined;
  const port = opts.portOverride ?? runtime?.httpPort ?? resolvedPort;
  const rawHost = opts.hostOverride ?? runtime?.httpHost ?? endpointUrl?.hostname ?? hostFallback;
  const host = (rawHost === '0.0.0.0' || rawHost === '::') ? hostFallback : rawHost;
  if (port === undefined) {
    return {
      ok: false,
      message: 'elanous nexus ios-bind: 데몬 주소를 모른다 — 데몬을 먼저 띄워라 (`elanous nexus run`)',
      host,
      port: 0,
      tokenInjected: false,
      tokenLength: 0,
      bundleId,
    };
  }

  // 2) Token (선택)
  const tokenRaw = opts.noToken ? null : readToken();
  const token = tokenRaw ?? '';

  // 3) UserDefaults write 3 회 (host · port · token)
  const lines: string[] = [];
  const hostResult = defaultsWrite(spawnFn, bundleId, 'nexusHost', 'string', host, dryRun);
  lines.push(`  host  ${hostResult.ok ? '✓' : '✗'}  ${hostResult.cmd}`);
  const portResult = defaultsWrite(spawnFn, bundleId, 'nexusPort', 'int', String(port), dryRun);
  lines.push(`  port  ${portResult.ok ? '✓' : '✗'}  ${portResult.cmd}`);

  let tokenInjected = false;
  let tokenLength = 0;
  if (!opts.noToken && token.length > 0) {
    const tokenResult = defaultsWrite(spawnFn, bundleId, 'bearerToken', 'string', token, dryRun);
    tokenInjected = tokenResult.ok;
    tokenLength = token.length;
    lines.push(`  token ${tokenResult.ok ? '✓' : '✗'}  xcrun simctl spawn booted defaults write ${bundleId} bearerToken <${tokenLength}-char redacted>`);
  } else if (opts.noToken) {
    lines.push(`  token —   (skipped · --no-token)`);
  } else {
    lines.push(`  token —   (skipped · ~/.elanous/acp-token absent)`);
  }

  let asciiKeyboardOk = true;
  if (opts.asciiKeyboard !== undefined) {
    const value = opts.asciiKeyboard ? 'true' : 'false';
    const r = defaultsWrite(spawnFn, bundleId, 'asciiKeyboard', 'bool', value, dryRun);
    asciiKeyboardOk = r.ok;
    lines.push(`  ascii ${r.ok ? '✓' : '✗'}  ${r.cmd}`);
  }

  let seedPromptOk = true;
  if (opts.seedPrompt !== undefined) {
    const r = defaultsWrite(spawnFn, bundleId, 'seedPrompt', 'string', opts.seedPrompt, dryRun);
    seedPromptOk = r.ok;
    const preview = opts.seedPrompt.length > 24
      ? opts.seedPrompt.slice(0, 24) + '…'
      : opts.seedPrompt;
    lines.push(`  seed  ${r.ok ? '✓' : '✗'}  xcrun simctl spawn booted defaults write ${bundleId} seedPrompt "${preview}" (${opts.seedPrompt.length} chars)`);
  }

  const allOk = hostResult.ok && portResult.ok
    && (opts.noToken || token.length === 0 || tokenInjected)
    && asciiKeyboardOk && seedPromptOk;
  const header = dryRun
    ? `elanous nexus ios-bind --dry-run · bundle ${bundleId}`
    : `elanous nexus ios-bind · bundle ${bundleId} ${allOk ? '✓' : '✗'}`;
  const message = [header, ...lines].join('\n');

  return {
    ok: allOk,
    message,
    host,
    port,
    tokenInjected,
    tokenLength,
    bundleId,
  };
}
