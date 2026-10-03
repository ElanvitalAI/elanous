// ── ⭐ ACP 서버 logs.db 싱크 배선 (관측 갭 수리 · 2026-07-26) ─────────────────
//
// ACP 서버는 nexus 데몬의 StoreSink 를 **상속하지 않는 별도 프로세스**다. 등록이 없으면
// 이 프로세스의 `debug.log`(capability.resolve · tool-hydrated · daemon-tools.self-implement
// 등)가 파일 트레일에만 남고 logs.db 에 안 닿아 `elanous logs` 로 **조회 불가** = 관측 안 한
// 것(제1원칙). `elanous agent` 가 #5441 로 고친 것과 같은 계열이고, 여기가 마지막 사각이었다.
//
// seam 은 **배선돼야** 의미가 있으므로 실제 `bootAcpServer` 를 태운다. 소켓 수명은 이
// 테스트의 관심사가 아니라 **사전-abort 신호**로 즉시 내린다(싱크 초기화는 boot 최선두라
// abort 여부와 무관하게 실행된다 — 그 순서 자체도 아래에서 단언).

import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootAcpServer } from '../src/boot/acp-server.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let tmp: string;
let sockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'elanous-acp-logsink-'));
  sockPath = join(tmp, 'elanous.sock');
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** 사전-abort 로 즉시 내려오는 boot. 반환 = 부팅이 끝까지 갔다는 뜻. */
function bootOnce(initializeLogSink?: () => Promise<void>): Promise<void> {
  const ctrl = new AbortController();
  ctrl.abort();   // 소켓을 붙잡지 않는다 — 관심사는 싱크 배선.
  return bootAcpServer(
    { transport: 'unix-socket', socketPath: sockPath },
    {
      shutdownSignal: ctrl.signal,
      stderr: { write: () => {} },
      ...(initializeLogSink ? { initializeLogSink } : {}),
    },
  );
}

describe('bootAcpServer — logs.db 싱크', () => {
  test('⭐ 부팅 시 싱크 초기화를 **실제로 호출**한다', async () => {
    let calls = 0;
    await bootOnce(async () => { calls++; });
    expect(calls).toBe(1);
  });

  test('싱크가 배너보다 **먼저** 등록된다(부팅 초기 로그도 logs.db 에 담기게)', async () => {
    const order: string[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    await bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: ctrl.signal,
        stderr: { write: () => { order.push('banner'); } },
        initializeLogSink: async () => { order.push('sink'); },
      },
    );
    // 배너가 사라져도 통과하던 구멍(리뷰 should-fix) — 존재와 상대순서를 함께 단언.
    expect(order).toContain('sink');
    expect(order).toContain('banner');
    expect(order.indexOf('sink')).toBeLessThan(order.indexOf('banner'));
  });

  test('★ fail-open — 싱크 등록이 실패해도 부팅이 깨지지 않는다', async () => {
    // 관측 등록 실패가 서버를 막으면 안 된다(파일 트레일이 진실원).
    await expect(bootOnce(async () => { throw new Error('logs.db 잠김'); })).resolves.toBeUndefined();
  });

  // should-fix(리뷰 #5464): fail-open 이 **조용하면** "왜 logs 가 비나"를 못 밝힌다 —
  // 관측 수리 안의 관측 갭. logs.db 가 바로 실패 대상이므로 파일 트레일로 남긴다.
  test('싱크 등록 실패 사유가 트레일에 남는다(조용한 삼킴 금지)', async () => {
    const { debug } = await import('../src/debug/log.js');
    const seen: { category: string; event: string; data?: unknown }[] = [];
    // LogSink 계약 = { name, emit } 객체(함수 아님).
    const off = debug.registerSink({
      name: 'test-capture',
      emit: (rec) => { seen.push({ category: rec.category, event: rec.event, data: rec.data }); },
    });
    const wasEnabled = debug.enabled;
    if (!wasEnabled) (debug as { setEnabled?: (on: boolean) => void }).setEnabled?.(true);
    try {
      await bootOnce(async () => { throw new Error('logs.db 잠김'); });
    } finally {
      off?.();
      if (!wasEnabled) (debug as { setEnabled?: (on: boolean) => void }).setEnabled?.(false);
    }
    const hit = seen.find((r) => r.category === 'acp.boot' && r.event === 'log-sink-failed');
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit?.data ?? {})).toContain('logs.db 잠김');
  });

  // should-fix(리뷰 #5464): 실 싱크는 **프로세스 전역**으로 등록돼(process 'exit' 에만 해제)
  // 이 테스트 프로세스의 후속 로그·DB 상태를 오염시킨다 → 서브프로세스로 격리한다.
  test('seam 미주입(프로덕션 경로) — 실 registerStandaloneLogSink 를 태워도 깨지지 않는다', () => {
    // ⚠️ must-fix(재리뷰 #5464): BOOT_OK 만 보면 **fail-open 이 전부 삼켜** import 실패·
    //   시그니처 오배선에도 통과한다(무의미한 단언). 그래서 실 모듈을 **직접 해석**해
    //   경로·export·시그니처를 따로 못박고, 그 위에 boot 완주를 확인한다.
    const probe = `
      const m = await import(${JSON.stringify(`${import.meta.dir}/../src/domains/standalone-log-sink.ts`)});
      if (typeof m.registerStandaloneLogSink !== 'function') throw new Error('export 시그니처 불일치');
      if (m.registerStandaloneLogSink.length !== 1) throw new Error('인자 수 불일치(surface 1개)');
      console.log('SINK_MODULE_OK');
      const { bootAcpServer } = await import(${JSON.stringify(`${import.meta.dir}/../src/boot/acp-server.ts`)});
      const c = new AbortController(); c.abort();
      await bootAcpServer(
        { transport: 'unix-socket', socketPath: process.argv[2] },
        { shutdownSignal: c.signal, stderr: { write: () => {} } },   // ← seam 미주입 = 실 경로
      );
      console.log('BOOT_OK');
    `;
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', probe, join(tmp, 'prod.sock')],
      env: { ...process.env, ELANOUS_STATE_DIR: tmp },   // logs.db 도 tmp 로 격리
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = proc.stdout.toString();
    // 실 모듈이 해석되고 시그니처가 맞는지 — fail-open 에 가려지지 않는 단언.
    expect(out).toContain('SINK_MODULE_OK');
    // 그 위에서 실 경로 boot 가 완주하는지.
    expect(out).toContain('BOOT_OK');
  });

  // should-fix(리뷰 #5464): 중앙 배선은 `bootAcpServer` 를 전제한다 — **우회 진입점이 생기면
  // 그 프로세스는 싱크 없이 뜬다**(같은 갭 재발). 하위 진입점 `runAcpServer` 를 직접 부르는
  // 프로덕션 코드를 열거하고, **각각이 자기 싱크를 갖는 이유**를 명시한 allowlist 와 대조한다.
  // 새 호출자가 생기면 여기서 깨지고, 저자는 "이 프로세스의 로그는 어디로 가나"를 답해야 한다.
  test('★ runAcpServer 직접 호출자는 전부 자기 logs.db 싱크가 있다(우회 차단)', () => {
    const repoRoot = join(import.meta.dir, '..');
    /** 호출자 → 그 프로세스의 싱크 근거. */
    const COVERED: Record<string, string> = {
      'src/boot/acp-server.ts': '이 PR — registerStandaloneLogSink("acp")',
      'src/nexus/index.ts': 'nexus 데몬이 자체 StoreSink 등록(registerLogStoreSink · 레퍼런스 구현)',
      'src/tui-client/dashboard-session.ts': 'TUI 프로세스 싱크 — logs.db 에 surface=[tui] 로 실제 적재됨(실측)',
    };
    const grep = Bun.spawnSync({
      cmd: ['git', 'grep', '-l', 'runAcpServer(', '--', 'src/'],
      cwd: repoRoot,
      stdout: 'pipe',
    });
    const files = grep.stdout.toString().trim().split('\n').filter((f) => f && !f.endsWith('.test.ts'));
    // 정의처·주석 참조는 제외 — **실제 호출문**이 있는 파일만 의무를 진다.
    const callers = files.filter((f) => {
      if (f === 'src/acp/server.ts') return false;   // runAcpServer 정의처
      const src = readFileSync(join(repoRoot, f), 'utf8');
      return /(?<!\*\s)(?:await\s+|void\s+|=\s*)runAcpServer\(/.test(src);
    });
    const uncovered = callers.filter((f) => !(f in COVERED));
    expect(uncovered).toEqual([]);
  });
});
