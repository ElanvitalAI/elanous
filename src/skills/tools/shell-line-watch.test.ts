// ── ELN-OP-SEAT-FEATURES ① (PR-1a): shell-line-watch 시험 — 시뮬 먼저, 그 다음 실제 bg 경로 ──
// 시뮬 ① 매치→enqueue→wake 계약(agent-wake 가 구독하는 공용 큐 onEnqueue + drain 성형)
// 시뮬 ② 비매치 침묵 회로. 그 다음 실제 RunShell bg 경로(dispatchRunShell mode:'bg' 실 프로세스).
// agent-wake 쪽 onEnqueue→startTurnIfIdle 회로는 agent-wake.test.ts 가 증명(회귀 실행).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHELL_LINE_WATCH_LINE_CAP,
  SHELL_LINE_WATCH_MAX_NOTICES,
  SHELL_LINE_WATCH_PENDING_CAP,
  createLineWatchCore,
  shellLineWatchSpecFromArgs,
  startShellLineWatch,
  type ShellLineWatchHit,
} from './shell-line-watch.js';
import { TaskNotificationQueue, globalTaskNotificationQueue, type PendingTaskNotification } from '../../agent/task-notification.js';
import { dispatchRunShell } from './shell.js';
import { setShellRunnerDeps, resetShellRunnerDeps } from '../../shell-runner/dispatch.js';
import { createShellRegistry } from '../../shell-runner/registry.js';
import { createFileCaptureEngine } from '../../shell-runner/file-engine.js';
import type { ShellHandle, OutputChunk } from '../../shell-runner/types.js';

function newQueue(): TaskNotificationQueue {
  return new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'shell-line-watch-')), 1_000_000, '');
}

function fakeHandle(id: string) {
  const subs = new Set<(c: OutputChunk) => void>();
  let settleResult: () => void = () => {};
  const result = new Promise<void>((resolve) => {
    settleResult = resolve;
  });
  return {
    id,
    onChunk(cb: (c: OutputChunk) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    result,
    emit(text: string) {
      const chunk: OutputChunk = { stream: 'stdout', bytes: text, ts: Date.now() };
      for (const cb of subs) cb(chunk);
    },
    settle() {
      settleResult();
    },
  } as unknown as ShellHandle & { emit(text: string): void; settle(): void };
}

describe('shell-line-watch spec parsing', () => {
  test('watchPattern/watchMinLines 파싱 · 부재 null · 잘못된 정규식 throw', () => {
    expect(shellLineWatchSpecFromArgs({ watchPattern: 'FAILED', watchMinLines: 3 })).toEqual({ pattern: 'FAILED', minLines: 3 }); // 출처: R-TST36
    expect(shellLineWatchSpecFromArgs({ description: 'x' })).toBeNull();
    expect(shellLineWatchSpecFromArgs({ watchPattern: '   ' })).toBeNull();
    expect(() => shellLineWatchSpecFromArgs({ watchPattern: '([' })).toThrow('watchPattern');
  });
});

describe('createLineWatchCore — 시뮬 (가짜 줄 스트림)', () => {
  test('① 매치 회로: 정규식에 걸리는 줄마다 hit', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'FAILED' }, onHit: (hit) => hits.push(hit) });
    core.push('building ok\nBUILD FAILED at foo.c\nstill running\nlink FAILED\n');
    expect(hits.map((h) => h.kind)).toEqual(['match', 'match']);
    expect(hits.map((h) => h.lineIndex)).toEqual([2, 4]);
    expect(hits[0].line).toBe('BUILD FAILED at foo.c');
  });

  test('② 비매치 침묵 회로: 매치 없는 줄은 hit 0', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'FAILED' }, onHit: (hit) => hits.push(hit) });
    core.push('a\nb\nc\n');
    core.flush();
    expect(hits).toHaveLength(0);
    expect(core.lineCount()).toBe(3);
  });

  test('청크 경계에 걸친 줄은 한 줄로 조립', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'WAKE' }, onHit: (hit) => hits.push(hit) });
    core.push('foo ba');
    core.push('r W');
    core.push('AKE!\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe('foo bar WAKE!');
  });

  test('minLines 임계: 도달 순간 1회만', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { minLines: 2 }, onHit: (hit) => hits.push(hit) }); // 출처: R-TST36
    core.push('one\ntwo\nthree\nfour\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'lines', lineIndex: 2, line: 'two' });
  });

  test('꼬리줄(줄바꿈 없음)은 flush() 에서 발화', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'END' }, onHit: (hit) => hits.push(hit) });
    core.push('waiting...\nfinal END');
    core.flush();
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe('final END');
  });

  test('폭주 매치는 상한(SHELL_LINE_WATCH_MAX_NOTICES)에서 정지', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'x' }, onHit: (hit) => hits.push(hit) });
    for (let i = 0; i < 200; i += 1) core.push(`x line ${i}\n`);
    core.push('x after cap\n');
    expect(hits).toHaveLength(SHELL_LINE_WATCH_MAX_NOTICES);
  });

  test('긴 줄의 payload 는 캡 길이 · truncated=true 전파 — terra mustFix 2(JUD #38537 must ⓑ 방어 유지)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'long' }, onHit: (hit) => hits.push(hit) });
    core.push(`long ${'a'.repeat(500)}\n`); // 출처: R-TST36 — terra 예시 그대로: 500자 줄이 앞 240 절두로 잘려도 payload 는 잘림을 알린다
    expect(hits).toHaveLength(1);
    expect(hits[0].truncated).toBe(true); // 원줄 505 > 캡 240 — 거짓 완결 표시 금지(terra mustFix 2)
    expect(Array.from(hits[0].line).length).toBe(SHELL_LINE_WATCH_LINE_CAP);
  });

  test('캡-후-매칭 회귀 ①: 앞 240 밖 «뒤쪽» 키워드도 누락되지 않는다 — 앞240+뒤240 유한 창(terra mustFix 1)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'DEEPKEY' }, onHit: (hit) => hits.push(hit) });
    core.push(`${'a'.repeat(SHELL_LINE_WATCH_LINE_CAP)} DEEPKEY\n`); // 출처: R-TST36 — 키워드가 앞 240 창 밖·줄 뒤쪽(뒤 240 창 안)에 있는 경우
    expect(hits).toHaveLength(1); // 이전 코드는 앞 240 만 보고 조용히 누락 — 회귀 시험
    expect(hits[0].truncated).toBe(true); // 248 > 240 — 창 payload 도 잘림을 알린다
    expect(hits[0].line.endsWith('DEEPKEY')).toBe(true); // 매치를 실은 것은 «뒤 240 창» — 에코가 키워드를 담는다
    expect(core.lineCount()).toBe(1);
    core.push(`DEEPKEY ${'a'.repeat(SHELL_LINE_WATCH_LINE_CAP)}\n`);
    expect(hits).toHaveLength(2); // 앞 창 매치는 여전히 hit — head/tail 최대 1회 'match' (줄당 중복 발화 없음)
    expect(hits[1].line.startsWith('DEEPKEY')).toBe(true); // 앞 창 매치의 payload 는 앞 240 창
  });

  test('캡-후-매칭 회귀 ②: 두 창 모두 밖(중간)은 문서화된 대가 — ReDoS 방어는 유지(terra mustFix 1)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'MIDKEY' }, onHit: (hit) => hits.push(hit) });
    // 앞 창(0..239)도 · 뒤 창(마지막 240)도 아닌 중간(300번대)에만 키워드 — 유한 창 계약의 문서화된 한계.
    core.push(`${'a'.repeat(SHELL_LINE_WATCH_LINE_CAP + 60)}MIDKEY${'b'.repeat(SHELL_LINE_WATCH_LINE_CAP + 60)}\n`); // 출처: R-TST36 — 두 창 사이 중간 배치: 240+60+5+240+60=605 코드포인트
    expect(hits).toHaveLength(0); // 정규식 입력은 항상 ≤240 코드포인트 — ReDoS 방어(JUD #38537 must ⓑ)는 그대로
  });

  test('truncated=false 완결 줄 — terra mustFix 2(온줄은 온줄로)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'FAILED' }, onHit: (hit) => hits.push(hit) });
    core.push('BUILD FAILED at foo.c\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].truncated).toBe(false); // 캡 이하 원줄 — 완결
    expect(hits[0].line).toBe('BUILD FAILED at foo.c');
    core.push(`${'c'.repeat(SHELL_LINE_WATCH_LINE_CAP)}\nFAILED\n`); // 출처: R-TST36 — 정확히 캡(240) 길이 노이즈 줄 뒤 온전한 짧은 매치 줄
    const short = hits.filter((h) => h.line === 'FAILED');
    expect(short).toHaveLength(1);
    expect(short[0].truncated).toBe(false); // 경계: 캡 «이하» 는 잘리지 않는다
  });

  test('개행 없는 폭주 출력은 pending 이 상한에 묶인다 — 캡 도달 후 개행이 오면 정확히 1개의 완결 줄(JUD #38537 must ①)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { minLines: 1 }, onHit: (hit) => hits.push(hit) }); // 출처: R-TST36 — JUD #38537 must ① 임계 1: 캡 뒤 TAIL 개행 1개로 완결 1줄 기대
    // 캡의 10배를 개행 없이 push — pending 은 무한 증가하지 않고 상한(꼬리 유지)에 묶인다.
    for (let i = 0; i < 10; i += 1) core.push('x'.repeat(SHELL_LINE_WATCH_PENDING_CAP));
    expect(core.pendingLength()).toBe(SHELL_LINE_WATCH_PENDING_CAP); // 초과분(머리)은 버려짐
    core.push('x'.repeat(SHELL_LINE_WATCH_PENDING_CAP * 5)); // 더 밀어도 상한 그대로
    expect(core.pendingLength()).toBe(SHELL_LINE_WATCH_PENDING_CAP);
    expect(core.lineCount()).toBe(0); // 아직 완결 줄 0
    core.push('TAIL\n'); // 캡 뒤에 온 개행 — 폭증 없이 정확히 1개의 완결 줄
    expect(core.lineCount()).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'lines', lineIndex: 1 });
    expect(core.pendingLength()).toBe(0);
  });

  test('임계 줄 자체가 매치여도 lines 는 누락되지 않는다 — match·lines 독립 발화(JUD #38537 must ②)', () => {
    const hits: ShellLineWatchHit[] = [];
    const core = createLineWatchCore({ spec: { pattern: 'FAILED', minLines: 3 }, onHit: (hit) => hits.push(hit) }); // 출처: R-TST36
    core.push('a\nb\nBUILD FAILED\n');
    expect(hits).toHaveLength(2); // 임계 줄이 매치이기도 하면 'match'+'lines' 둘 다
    expect(hits[0]).toMatchObject({ kind: 'match', lineIndex: 3, line: 'BUILD FAILED' });
    expect(hits[1]).toMatchObject({ kind: 'lines', lineIndex: 3, line: 'BUILD FAILED' });
  });

  test('stdout/stderr 부분 줄은 교차 결합되지 않는다 — 스트림별 pending 조립(JUD #38537 must ③)', () => {
    const lines: string[] = [];
    const core = createLineWatchCore({ spec: { pattern: '.*' }, onHit: (hit) => lines.push(hit.line) });
    core.push('par', 'stdout');
    core.push('err\n', 'stderr');
    core.push('tial\n', 'stdout');
    expect(lines).toEqual(['err', 'partial']); // "parr…" 식 엉킀 없음 — 각 스트림이 자기 줄로 완결
    expect(core.lineCount()).toBe(2);
    core.flush();
    expect(core.lineCount()).toBe(2); // flush 는 스트림별 — 남은 꼬리 없음
  });
});

describe('startShellLineWatch — 실제 부착 (가짜 핸들 + 진짜 큐)', () => {
  test('시뮬 ① wake 계약(진행 알림): 비매치 줄 침묵 → 매치 줄 → 공용 큐 onEnqueue 발화(state running) + drain 성형', async () => {
    globalTaskNotificationQueue.clear();
    const wakeSeen: PendingTaskNotification[] = [];
    const dispose = globalTaskNotificationQueue.onEnqueue((n) => wakeSeen.push(n));
    const handle = fakeHandle('handle-wake');
    startShellLineWatch({ handle, spec: { pattern: 'WAKE' }, label: 'nightly build' });
    handle.emit('plain line\n');
    handle.emit('please WAKE up\n');
    handle.settle();
    await Promise.resolve();
    expect(wakeSeen.filter((n) => n.taskId.startsWith('shell-watch:'))).toHaveLength(1);
    const watch = globalTaskNotificationQueue.drain().find((n) => n.taskId.startsWith('shell-watch:'));
    if (!watch) throw new Error('shell-watch 알림이 큐에 없다');
    expect(watch).toBeDefined();
    expect(watch.taskId).toBe('shell-watch:handle-wake:1');
    expect(watch.agentName).toBe('RunShell');
    expect(watch.label).toBe('nightly build');
    expect(watch.state).toBe('running'); // JUD #38537 must ⓑ — 중간 줄은 진행 · 완료(shell:)는 state done
    expect(watch.output).toContain('line-watch handle=handle-wake match');
    expect(watch.output).toContain('please WAKE up');
    dispose();
    globalTaskNotificationQueue.clear();
  });

  test('완료 settle 시 꼬리줄 flush 후 정지 (매치 1건만)', async () => {
    const queue = newQueue();
    const handle = fakeHandle('handle-C');
    startShellLineWatch({ handle, spec: { pattern: 'DONE' }, queue });
    handle.emit('working\nfinal DONE');
    handle.settle();
    await Promise.resolve();
    await Promise.resolve();
    const items = queue.drain();
    expect(items.filter((n) => n.taskId.startsWith('shell-watch:')).length).toBe(1);
    expect(items[0].output).toContain('final DONE');
  });
});

describe('RunShell bg 통합 — 실제 배경 경로', () => {
  test('실제 bg 실행의 매치 줄이 공용 큐에 shell-watch: 로 도착 (완료 알림 shell: 도 회귀)', async () => {
    const registry = createShellRegistry();
    setShellRunnerDeps({ registry, fileEngine: createFileCaptureEngine() });
    try {
      globalTaskNotificationQueue.clear();
      const result = await dispatchRunShell(
        { command: ['bash', '-c', 'printf "step-1\\nBUILD FAILED at foo.c\\nstep-3\\n"'], mode: 'bg', watchPattern: 'FAILED' },
        {},
      );
      expect(result.outcome).toBe('started');
      const watchIds: string[] = [];
      const completionIds: string[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        for (const n of globalTaskNotificationQueue.drain()) {
          if (n.taskId.startsWith('shell-watch:')) watchIds.push(n.taskId);
          if (n.taskId.startsWith('shell:')) completionIds.push(n.taskId);
        }
        if (watchIds.length > 0 && completionIds.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(watchIds.length).toBeGreaterThanOrEqual(1); // 출처: R-TST36
      expect(completionIds.length).toBe(1);
    } finally {
      resetShellRunnerDeps();
      globalTaskNotificationQueue.clear();
    }
  }, 20_000);
});
