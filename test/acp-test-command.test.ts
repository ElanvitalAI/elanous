import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { globalAcpAgentManager } from '../src/acp/agent-manager.js';
import { program } from '../src/index.js';

test('acp test canonicalizes aliases through the agent manager and records the selected transport', async () => {
  const manager = globalAcpAgentManager() as unknown as {
    getAgent: (backend: string, opts: { cwd: string; log: (message: string) => void }) => Promise<unknown>;
  };
  const originalGetAgent = manager.getAgent;
  const calls: Array<{ backend: string; cwd: string }> = [];
  let stopped = 0;
  manager.getAgent = async (backend, opts) => {
    calls.push({ backend, cwd: opts.cwd });
    opts.log('started');
    return {
      newSession: async () => 'session-1',
      prompt: async (_session: string, _blocks: unknown, onUpdate: (update: { sessionUpdate: string; content: { type: string; text?: string } }) => void) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
        return { stopReason: 'end_turn' };
      },
      stop: async () => { stopped++; },
    };
  };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const consoleLog = console.log;
  const output: string[] = [];
  const errors: string[] = [];
  const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
  const debugSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data });
  }) as never);
  process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => { output.push(`${args.join(' ')}\n`); };
  try {
    await program.parseAsync(['node', 'elanous', 'acp', 'test', '--backend', 'codex', '--prompt', 'hello', '--cwd', '/tmp/acp-test-command']);
  } finally {
    manager.getAgent = originalGetAgent;
    debugSpy.mockRestore();
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    console.log = consoleLog;
  }

  expect(calls).toEqual([{ backend: 'codex-app-server', cwd: '/tmp/acp-test-command' }]);
  // 🪞⭐⭐ 2026-08-26 — 옛 단언은 `toContainEqual({… data: {세 필드}})` 로 ***정확 일치***를 요구했다.
  //   📏 실측: payload 에 ***`autoApprovePermissions: false`*** 가 «늘었다» ⇒ 정확 일치가 깨졌다.
  //   🔑 ⇒ ***소스가 «좋아져서» 빨개진*** 판이다(그 필드는 「권한을 자동 승인했나」를 «남긴다»).
  //      이 시험의 «의도»는 「acp-test 가 시작 관측을 «어느 백엔드·전송»으로 남기나」이지
  //      ***「payload 에 필드가 «몇 개»인가」가 아니다.***
  //   🩹 그래서 ***`objectContaining` 으로 계약만 문다*** — payload 가 더 늘어도 안 깨진다.
  //   ⛔ 다만 «느슨하게» 두지 않는다: 세 필드는 ***이름과 값으로 못 박는다***(그게 이 시험의 요점이다).
  expect(logs).toContainEqual(expect.objectContaining({
    category: 'acp-test',
    event: 'start',
    data: expect.objectContaining({
      requestedBackend: 'codex',
      backend: 'codex-app-server',
      transport: 'codex-app-server',
    }),
  }));
  expect(output.join('')).toContain('session: session-1');
  expect(output.join('')).toContain('hello');
  expect(output.join('')).toContain('stop: end_turn');
  expect(errors.join('')).toContain('[acp] started');
  expect(stopped).toBe(1);
});

afterEach(() => {
  process.exitCode = 0;
});
