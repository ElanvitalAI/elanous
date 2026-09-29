// ── nexus ios-bind L2 helper · UserDefaults inject 검증 (2026-05-13) ─────
//
// `bun run dev nexus ios-bind` 가 시뮬레이터 booted device 의 UserDefaults 에
// host/port/bearerToken 을 `xcrun simctl spawn booted defaults write
// com.elanvitalai.elanous.ios <key> ...` 3 회로 inject.
//
// 본 test 는 DI seam (spawnSyncFn · readRuntimeFn · readTokenFn) 으로
// xcrun · 파일시스템 · runtime sidecar 모두 mock — 시뮬레이터 부팅
// 없이 검증.

import { afterEach, describe, test, expect } from 'bun:test';
import { runNexusIosBind } from '../src/cli/nexus-ios-bind';
import { setResolveDaemonEndpointForTest } from '../src/nexus/daemon-endpoint';
import type { NexusRuntimeMeta } from '../src/nexus/runtime';
import type { SpawnSyncReturns } from 'node:child_process';

function makeRuntime(over: Partial<NexusRuntimeMeta> = {}): NexusRuntimeMeta {
  return {
    pid: 99999,
    startedAt: '2026-05-13T00:00:00Z',
    nexusVersion: '0.17.0',
    phase: 'test',
    httpPort: 31415,
    httpHost: '127.0.0.1',
    ...over,
  };
}

function captureSpawn(): {
  fn: (cmd: string, args: readonly string[]) => SpawnSyncReturns<Buffer>;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn = (cmd: string, args: readonly string[]): SpawnSyncReturns<Buffer> => {
    calls.push({ cmd, args });
    return {
      pid: 1,
      output: [],
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      status: 0,
      signal: null,
    };
  };
  return { fn, calls };
}

describe('runNexusIosBind · L2 helper', () => {
  afterEach(() => setResolveDaemonEndpointForTest(null));

  test('runtime sidecar 의 httpHost/httpPort 를 inject', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime({ httpHost: '127.0.0.1', httpPort: 31432 }),
      readTokenFn: () => 'test-token-1234567890',
    });
    expect(result.ok).toBe(true);
    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(31432);
    expect(result.tokenInjected).toBe(true);
    expect(result.tokenLength).toBe(21);
    expect(spawn.calls).toHaveLength(3);
    // 1) host
    expect(spawn.calls[0]!.args).toEqual([
      'simctl', 'spawn', 'booted', 'defaults', 'write',
      'com.elanvitalai.elanous.ios', 'nexusHost', '127.0.0.1',
    ]);
    // 2) port (int)
    expect(spawn.calls[1]!.args).toEqual([
      'simctl', 'spawn', 'booted', 'defaults', 'write',
      'com.elanvitalai.elanous.ios', 'nexusPort', '-int', '31432',
    ]);
    // 3) token
    expect(spawn.calls[2]!.args).toEqual([
      'simctl', 'spawn', 'booted', 'defaults', 'write',
      'com.elanvitalai.elanous.ios', 'bearerToken', 'test-token-1234567890',
    ]);
  });

  test('runtime sidecar 부재 시 해석기 주소의 host/port 를 inject', () => {
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://127.0.0.1:31432',
      healthUrl: 'http://127.0.0.1:31432/v1/health',
      pwaUrl: 'http://127.0.0.1:31432/app/',
      source: 'registry',
    }));
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => null,
      readTokenFn: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(31432);
    expect(spawn.calls).toHaveLength(2);
    expect(spawn.calls[0]!.args).toContain('127.0.0.1');
    expect(spawn.calls[1]!.args).toContain('31432');
  });

  test('runtime 포트와 해석기 모두 부재 시 아무 UserDefaults 도 쓰지 않는다', () => {
    setResolveDaemonEndpointForTest(() => null);
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => null,
      readTokenFn: () => 'secret',
      asciiKeyboard: true,
      seedPrompt: 'hello',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('데몬 주소를 모른다');
    expect(result.message.split('\n')).toHaveLength(1);
    expect(result.tokenInjected).toBe(false);
    expect(spawn.calls).toHaveLength(0);
  });

  test('--no-token 옵션 시 token spawn 호출 안 함', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'should-be-ignored',
      noToken: true,
    });
    expect(result.tokenInjected).toBe(false);
    expect(spawn.calls).toHaveLength(2); // host + port only
    expect(result.message).toContain('--no-token');
  });

  test('token 파일 부재 시 token spawn 호출 안 함 (skip · ok = true)', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.tokenInjected).toBe(false);
    expect(spawn.calls).toHaveLength(2);
    expect(result.message).toContain('absent');
  });

  test('--dry-run 시 spawn 호출 0 회 + 메시지에 cmd 모두 표시', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(spawn.calls).toHaveLength(0);
    expect(result.message).toContain('--dry-run');
    expect(result.message).toContain('nexusHost');
    expect(result.message).toContain('nexusPort');
    expect(result.message).toContain('bearerToken');
  });

  test('--ascii (asciiKeyboard: true) 옵션 시 asciiKeyboard bool true write', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
      asciiKeyboard: true,
    });
    expect(result.ok).toBe(true);
    // 4 spawn calls: nexusHost · nexusPort · bearerToken · asciiKeyboard
    expect(spawn.calls).toHaveLength(4);
    const asciiCall = spawn.calls.find((c) =>
      c.args.some((a) => a === 'asciiKeyboard'),
    );
    expect(asciiCall).toBeDefined();
    expect(asciiCall!.args).toContain('-bool');
    expect(asciiCall!.args).toContain('true');
    expect(result.message).toContain('asciiKeyboard');
  });

  test('--no-ascii (asciiKeyboard: false) 옵션 시 asciiKeyboard bool false write — cleanup path', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
      asciiKeyboard: false,
    });
    expect(result.ok).toBe(true);
    expect(spawn.calls).toHaveLength(4);
    const asciiCall = spawn.calls.find((c) =>
      c.args.some((a) => a === 'asciiKeyboard'),
    );
    expect(asciiCall).toBeDefined();
    expect(asciiCall!.args).toContain('-bool');
    expect(asciiCall!.args).toContain('false');
  });

  test('asciiKeyboard undefined (생략) 시 write 없음 (default skip)', () => {
    const spawn = captureSpawn();
    runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
    });
    // host + port + token only — no asciiKeyboard
    expect(spawn.calls).toHaveLength(3);
    expect(
      spawn.calls.some((c) => c.args.some((a) => a === 'asciiKeyboard')),
    ).toBe(false);
  });

  test('--prompt "<text>" 시 seedPrompt UserDefault 추가 spawn', () => {
    const spawn = captureSpawn();
    const prompt = '조선의 왕 계보 알려줘';
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
      seedPrompt: prompt,
    });
    expect(result.ok).toBe(true);
    // 4 spawn calls: nexusHost · nexusPort · bearerToken · seedPrompt
    expect(spawn.calls).toHaveLength(4);
    const seedCall = spawn.calls.find((c) =>
      c.args.some((a) => a === 'seedPrompt'),
    );
    expect(seedCall).toBeDefined();
    expect(seedCall!.args).toContain(prompt);
    expect(result.message).toContain('seedPrompt');
    // Korean preview 가 message 에 포함 (잘려서)
    expect(result.message).toContain('조선의');
  });

  test('seedPrompt undefined (생략) 시 write 없음 (default skip)', () => {
    const spawn = captureSpawn();
    runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
    });
    expect(
      spawn.calls.some((c) => c.args.some((a) => a === 'seedPrompt')),
    ).toBe(false);
  });

  test('--ascii + --prompt 동시 시 5 spawn (host/port/token/ascii/seed)', () => {
    const spawn = captureSpawn();
    runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'abc',
      asciiKeyboard: true,
      seedPrompt: 'hello',
    });
    expect(spawn.calls).toHaveLength(5);
  });

  test('xcrun exit code 비0 시 ok=false', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const failingSpawn = (cmd: string, args: readonly string[]): SpawnSyncReturns<Buffer> => {
      calls.push({ cmd, args });
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(''),
        stderr: Buffer.from('No booted devices'),
        status: 1,
        signal: null,
      };
    };
    const result = runNexusIosBind({
      spawnSyncFn: failingSpawn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'tok',
    });
    expect(result.ok).toBe(false);
    expect(result.tokenInjected).toBe(false);
    expect(calls).toHaveLength(3); // 시도는 함
  });

  test('daemon httpHost 가 0.0.0.0 이면 simulator 입장 loopback 으로 치환', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime({ httpHost: '0.0.0.0' }),
      readTokenFn: () => null,
    });
    expect(result.host).toBe('localhost'); // default hostFallback
    // spawn arg 도 'localhost' (0.0.0.0 아님)
    expect(spawn.calls[0]!.args).toContain('localhost');
    expect(spawn.calls[0]!.args).not.toContain('0.0.0.0');
  });

  test('daemon httpHost 가 :: (ipv6 all) 도 loopback 으로 치환', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime({ httpHost: '::' }),
      readTokenFn: () => null,
    });
    expect(result.host).toBe('localhost');
  });

  test('custom bundle id 사용 시 spawn args 에 반영', () => {
    const spawn = captureSpawn();
    runNexusIosBind({
      bundleId: 'com.example.testapp',
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 't',
    });
    for (const call of spawn.calls) {
      expect(call.args).toContain('com.example.testapp');
    }
  });

  test('hostOverride / portOverride 가 runtime sidecar 보다 우선', () => {
    setResolveDaemonEndpointForTest(() => null);
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      hostOverride: 'mbp.tail-xxx.ts.net',
      portOverride: 31432,
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime({ httpHost: '127.0.0.1', httpPort: 31415 }),
      readTokenFn: () => null,
    });
    expect(result.host).toBe('mbp.tail-xxx.ts.net');
    expect(result.port).toBe(31432);
  });

  test('portOverride is enough without runtime or resolver', () => {
    setResolveDaemonEndpointForTest(() => null);
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      portOverride: 31432,
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => null,
      readTokenFn: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.host).toBe('localhost');
    expect(result.port).toBe(31432);
    expect(spawn.calls).toHaveLength(2);
  });

  test('token 이 redact 되어 메시지에 노출 안 됨', () => {
    const spawn = captureSpawn();
    const result = runNexusIosBind({
      spawnSyncFn: spawn.fn as never,
      readRuntimeFn: () => makeRuntime(),
      readTokenFn: () => 'super-secret-bearer-token-no-leak',
    });
    expect(result.message).not.toContain('super-secret-bearer-token-no-leak');
    expect(result.message).toContain('redacted');
  });
});
