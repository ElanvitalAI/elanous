// P0b — nexus/webterm registry 어댑터 테스트. createRegistryBackend 가 공유 registry
//   버스(startPty/onPtyEvent)를 PtyBackend 인터페이스로 정확히 어댑트하는지 검증:
//   ①startPty 에 kind=webterm·accessMode=write 전달 ②onData=매칭 id+output 만 ③exit signal
//   number→name 변환 ④resize 인자 순서 swap(gotcha). registry 는 **주입 seam** 으로 스텁
//   (mock.module 은 프로세스 전역 오염 → 타 테스트 getPty 파괴하므로 금지).
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebtermTabSpec } from '../kinds/webterm.js';
import { ProjectStore } from '../../project/project-store.js';
import { createSession } from '../../session/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import {
  resolveWebtermCwd,
  createRegistryBackend, signalNumberToName, terminatePty,
  type PtyBackend, type RegistryBackendDeps,
} from './pty.js';

/** 스텁 registry + 이벤트 방출 훅. deps 로 주입 → 전역 오염 없음. */
function stubRegistry() {
  const listeners: Array<(ev: unknown) => void> = [];
  const handle = {
    id: 'webterm_abc',
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    kills: [] as Array<string | undefined>,
    write(s: string) { this.writes.push(s); },
    resize(cols: number, rows: number) { this.resizes.push([cols, rows]); },
    kill(sig?: NodeJS.Signals) { this.kills.push(sig); },
  };
  let lastStartOpts: Record<string, unknown> = {};
  const deps = {
    startPty: (opts: unknown) => { lastStartOpts = opts as Record<string, unknown>; return handle; },
    onPtyEvent: (cb: (ev: unknown) => void) => { listeners.push(cb); return () => {}; },
  } as unknown as RegistryBackendDeps;
  const emitLast = (ev: unknown) => listeners[listeners.length - 1]!(ev);
  return { deps, handle, listeners, emitLast, getStartOpts: () => lastStartOpts };
}

describe('signalNumberToName (순수)', () => {
  test('공통 시그널 번호→이름', () => {
    expect(signalNumberToName(9)).toBe('SIGKILL');
    expect(signalNumberToName(15)).toBe('SIGTERM');
    expect(signalNumberToName(2)).toBe('SIGINT');
    expect(signalNumberToName(undefined)).toBeUndefined();
    expect(signalNumberToName(999)).toBeUndefined();
  });
});

function terminationBackend(options: {
  throwOnKill?: boolean;
  exitDuringRegistration?: boolean;
  exitDuringSignal?: NodeJS.Signals;
} = {}) {
  let exit: ((info: { exitCode: number | null; signal?: NodeJS.Signals }) => void) | undefined;
  let unsubscribeCount = 0;
  const kills: NodeJS.Signals[] = [];
  const backend: PtyBackend = {
    onData: () => () => {},
    onExit(cb) {
      exit = cb;
      if (options.exitDuringRegistration) cb({ exitCode: 0 });
      return () => { unsubscribeCount += 1; exit = undefined; };
    },
    write: () => {},
    kill(signal) {
      const actualSignal = signal ?? 'SIGTERM';
      kills.push(actualSignal);
      if (options.exitDuringSignal === actualSignal) exit?.({ exitCode: 0, signal: actualSignal });
      if (options.throwOnKill) throw new Error('kill-failed');
    },
  };
  return {
    backend,
    kills,
    emitExit: () => exit?.({ exitCode: 0 }),
    getUnsubscribeCount: () => unsubscribeCount,
  };
}

describe('terminatePty', () => {
  test('observes an immediate cooperative exit without waiting for grace', async () => {
    const fake = terminationBackend();
    const done = terminatePty(fake.backend, { graceMs: 30, killWaitMs: 30 });
    fake.emitExit();
    await expect(done).resolves.toBe('exited');
    expect(fake.kills).toEqual(['SIGTERM']);
    expect(fake.getUnsubscribeCount()).toBe(1);
  });

  test('escalates a TERM-ignoring child to SIGKILL and observes its exit', async () => {
    const fake = terminationBackend();
    const done = terminatePty(fake.backend, { graceMs: 5, killWaitMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);
    fake.emitExit();
    await expect(done).resolves.toBe('exited');
    expect(fake.getUnsubscribeCount()).toBe(1);
  });

  test('handles signal failure and a missing exit as a bounded timeout', async () => {
    const fake = terminationBackend({ throwOnKill: true });
    await expect(terminatePty(fake.backend, { graceMs: 5, killWaitMs: 5 })).resolves.toBe('timeout');
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fake.getUnsubscribeCount()).toBe(1);
  });

  test('cleans a subscription when onExit synchronously reports an already-exited child', async () => {
    const fake = terminationBackend({ exitDuringRegistration: true });
    await expect(terminatePty(fake.backend, { graceMs: 5, killWaitMs: 5 })).resolves.toBe('exited');
    expect(fake.kills).toEqual([]);
    expect(fake.getUnsubscribeCount()).toBe(1);
  });

  test('does not leave a grace timer when SIGTERM synchronously reports exit', async () => {
    const fake = terminationBackend({ exitDuringSignal: 'SIGTERM' });
    await expect(terminatePty(fake.backend, { graceMs: 5, killWaitMs: 5 })).resolves.toBe('exited');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(fake.kills).toEqual(['SIGTERM']);
    expect(fake.getUnsubscribeCount()).toBe(1);
  });

  test('does not leave a kill-wait timer when SIGKILL synchronously reports exit', async () => {
    const fake = terminationBackend({ exitDuringSignal: 'SIGKILL' });
    await expect(terminatePty(fake.backend, { graceMs: 5, killWaitMs: 30 })).resolves.toBe('exited');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fake.getUnsubscribeCount()).toBe(1);
  });
});

describe('createRegistryBackend — 공유 registry 버스 어댑트 (P0b)', () => {
  test('startPty 에 kind=webterm·accessMode=write·workdir 전달', () => {
    const s = stubRegistry();
    createRegistryBackend({ env: {}, cwd: '/tmp/x' }, s.deps);
    const opts = s.getStartOpts();
    expect(opts.kind).toBe('webterm');
    expect(opts.accessMode).toBe('write');
    expect(opts.workdir).toBe('/tmp/x');
  });

  test('onData 는 매칭 id + output 이벤트만 통과(다른 id/타입 무시)', () => {
    const s = stubRegistry();
    const b = createRegistryBackend({ env: {} }, s.deps);
    const got: string[] = [];
    b.onData((c) => got.push(c));
    s.emitLast({ type: 'output', id: 'webterm_abc', chunk: 'hello' }); // 통과
    s.emitLast({ type: 'output', id: 'other_xyz', chunk: 'nope' });    // 다른 id
    s.emitLast({ type: 'exit', id: 'webterm_abc', exitCode: 0 });      // 다른 타입
    expect(got).toEqual(['hello']);
  });

  test('onExit 은 매칭 id 이고 signal number→name 변환', () => {
    const s = stubRegistry();
    const b = createRegistryBackend({ env: {} }, s.deps);
    const infos: Array<{ exitCode: number | null; signal?: NodeJS.Signals }> = [];
    b.onExit((i) => { infos.push(i); });
    s.emitLast({ type: 'exit', id: 'other', exitCode: 1 });            // 다른 id 무시
    s.emitLast({ type: 'exit', id: 'webterm_abc', exitCode: 137, signal: 9 });
    expect(infos).toEqual([{ exitCode: 137, signal: 'SIGKILL' }]);
  });

  test('resize 인자 순서 swap: PtyBackend(rows,cols) → PtyHandle.resize(cols,rows)', () => {
    const s = stubRegistry();
    const b = createRegistryBackend({ env: {} }, s.deps);
    b.resize?.(24, 80); // rows=24, cols=80
    expect(s.handle.resizes).toEqual([[80, 24]]); // handle.resize(cols=80, rows=24)
  });

  test('write/kill 은 handle 로 위임', () => {
    const s = stubRegistry();
    const b = createRegistryBackend({ env: {} }, s.deps);
    b.write('ls\n');
    b.kill('SIGTERM');
    expect(s.handle.writes).toEqual(['ls\n']);
    expect(s.handle.kills).toEqual(['SIGTERM']);
  });
});

describe('resolveWebtermCwd — 격리 웹 터미널이 사람 트리에서 열리지 않는다', () => {
  const prod = { kind: 'prod' as const, root: '/home/u/.elanous' };
  const iso = { kind: 'test' as const, root: '/iso/root' };
  test('webterm 생성이 대화 sessionId 를 보존하고 기존 cwd 메타는 그대로 둔다', () => {
    expect(createWebtermTabSpec({ sessionId: 'chat-1' }).meta).toEqual({ sessionId: 'chat-1' });
    expect(createWebtermTabSpec({ sessionId: 'chat-1', cwd: '/explicit' }).meta)
      .toEqual({ sessionId: 'chat-1', cwd: '/explicit' });
    expect(createWebtermTabSpec().meta).toBeUndefined();
  });
  test('프로젝트 대화의 새 터미널은 프로젝트 폴더, 명시적 탭 cwd 는 우선', () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-project-'));
    const previous = process.env.ELANOUS_SESSION_ROOT;
    try {
      setElanousConfigDir(join(root, 'config'));
      process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
      const folder = join(root, 'project');
      mkdirSync(folder);
      const project = new ProjectStore(join(root, 'config')).create({ name: 'sample', primaryFolder: folder });
      const assigned = createSession({ projectId: project.id });
      const plain = createSession();
      const tab = createWebtermTabSpec({ sessionId: assigned.id });
      expect(resolveWebtermCwd({ sessionId: (tab.meta as { sessionId: string }).sessionId, toolCwd: '/tool', instance: iso, processCwd: '/human' }))
        .toEqual({ cwd: folder, source: 'project' });
      expect(resolveWebtermCwd({ sessionId: assigned.id, tabCwd: '/tab', instance: iso, processCwd: '/human' }))
        .toEqual({ cwd: '/tab', source: 'tab' });
      expect(resolveWebtermCwd({ sessionId: plain.id, toolCwd: '/tool', instance: iso, processCwd: '/human' }))
        .toEqual({ cwd: '/tool', source: 'tool-cwd' });
    } finally {
      resetElanousConfigDir();
      if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('탭 cwd 가 이긴다', () => {
    expect(resolveWebtermCwd({ tabCwd: '/tab', toolCwd: '/tool', instance: iso, processCwd: '/human' })).toEqual({ cwd: '/tab', source: 'tab' });
  });
  test('탭 cwd 가 없으면 데몬의 tool cwd', () => {
    expect(resolveWebtermCwd({ toolCwd: '/tool', instance: iso, processCwd: '/human' })).toEqual({ cwd: '/tool', source: 'tool-cwd' });
  });
  test('격리 우주에서 tool cwd 도 없으면 우주 뿌리 — 사람 트리(process.cwd)가 아니다', () => {
    const r = resolveWebtermCwd({ instance: iso, processCwd: '/human' });
    expect(r.cwd).not.toBe('/human');
    expect(r).toEqual({ cwd: '/iso/root', source: 'isolated-root' });
  });
  test('대조군: 운영 우주에서 아무것도 없으면 종전대로 process.cwd', () => {
    expect(resolveWebtermCwd({ instance: prod, processCwd: '/human' })).toEqual({ cwd: '/human', source: 'process-cwd' });
  });
});
