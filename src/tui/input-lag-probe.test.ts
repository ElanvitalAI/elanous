// TUI-TYPING-LAG-OBS — `tui.input-lag` 관측 계약(UX SCENARIO-MOCK-RIG 와 합의한 칸 모양).
import { describe, expect, test, afterEach } from 'bun:test';
import {
  INPUT_LAG_CATEGORY,
  INPUT_LAG_EVENT,
  createInputLagProbe,
  measureInputLagTurnStart,
  noteInputLagKey,
  noteInputLagPaint,
  setInputLagProbe,
  type InputLagMeasured,
} from './input-lag-probe.js';
import {
  buildDashboardTurnPreamble,
  preambleSyncBlockMs,
  PREAMBLE_SYNC_BLOCK_ENV,
  setPreambleSyncBlockMsForTesting,
} from '../dashboard/turn-preamble.js';
import { prodInstanceRoot, resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { getUserConfig } from '../user-config.js';

interface Rig {
  lines: Array<{ category: string; event: string; data: InputLagMeasured }>;
  clock: { t: number };
  beat: () => void;
  flushTimeouts: () => void;
}

function rig(opts: { sampleEvery?: number; busy?: boolean } = {}) {
  const r: Rig = { lines: [], clock: { t: 1000 }, beat: () => {}, flushTimeouts: () => {} };
  const timeouts: Array<() => void> = [];
  r.flushTimeouts = () => { for (const fn of timeouts.splice(0)) fn(); };
  const probe = createInputLagProbe({
    now: () => r.clock.t,
    isBusy: () => opts.busy ?? false,
    log: (category, event, data) => r.lines.push({ category, event, data }),
    ...(opts.sampleEvery !== undefined ? { sampleEvery: opts.sampleEvery } : {}),
    setIntervalFn: (fn) => { r.beat = fn; return {}; },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => { timeouts.push(fn); return {}; },
  });
  return { probe, r };
}

/** 루프가 막히지 않은 키 하나 — 박동 둘을 제때 친 뒤 키·칠. 첫 박동은 앞 키의 칠까지 걸린 시간을
 *  흡수한다(가짜 시계는 그 사이 박동을 안 치므로 박동 눈에는 막힘이다 · 둘째 박동 뒤면 «방금 끝난 막힘» 이 아니다). */
function typeKey(probe: ReturnType<typeof rig>['probe'], r: Rig, paintAfterMs: number): void {
  r.clock.t += 20; r.beat();
  r.clock.t += 20; r.beat();
  probe.noteKey();
  r.clock.t += paintAfterMs;
  probe.notePaint();
}

afterEach(() => {
  setInputLagProbe(null);
  setPreambleSyncBlockMsForTesting(null);
});

describe('tui.input-lag keystroke', () => {
  test('표본 키 한 줄의 칸 모양이 계약과 같다', () => {
    const { probe, r } = rig({ sampleEvery: 1, busy: true });
    r.clock.t += 20; r.beat();           // 드리프트 0
    r.clock.t += 27; r.beat();           // 드리프트 7
    probe.noteKey();
    r.clock.t += 4; probe.notePaint();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.category).toBe(INPUT_LAG_CATEGORY);
    expect(r.lines[0]!.event).toBe(INPUT_LAG_EVENT);
    expect(r.lines[0]!.data).toEqual({
      phase: 'keystroke',
      keyToPaintMs: 4,
      loopDelayMs: { p99: 7, max: 7 },
      busy: true,
      sampled: 1,
    });
    probe.dispose();
  });

  test('기본 표본 = 10키 중 1 · 빠른 키 9개는 남기지 않는다', () => {
    const { probe, r } = rig();
    for (let i = 0; i < 9; i++) typeKey(probe, r, 2);
    expect(r.lines).toHaveLength(0);
    typeKey(probe, r, 2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.sampled).toBe(0.1);
    probe.dispose();
  });

  test('표본은 측정 횟수가 아니라 실제 키 수로 센다 — 한 청크 10키 · 칠 전 10키 모두 한 줄', () => {
    const { probe, r } = rig();
    r.clock.t += 20; r.beat();
    probe.noteKey(10);                    // 한 stdin 청크가 10키를 낳았다
    r.clock.t += 2; probe.notePaint();
    expect(r.lines).toHaveLength(1);
    r.clock.t += 20; r.beat();
    for (let i = 0; i < 10; i++) probe.noteKey();   // 칠 전에 10키(첫 키만 시각을 쥔다)
    r.clock.t += 2; probe.notePaint();
    expect(r.lines).toHaveLength(2);
    r.clock.t += 20; r.beat();
    probe.noteKey(9);
    r.clock.t += 2; probe.notePaint();
    expect(r.lines).toHaveLength(2);
    probe.dispose();
  });

  test('표본 줄은 넘친 키를 이월한다 — 11키 뒤 9키면 20번째 키에서 다시 한 줄', () => {
    const { probe, r } = rig();
    r.clock.t += 20; r.beat();
    probe.noteKey(11); r.clock.t += 2; probe.notePaint();
    r.clock.t += 20; r.beat();
    probe.noteKey(9); r.clock.t += 2; probe.notePaint();
    expect(r.lines).toHaveLength(2);
    probe.dispose();
  });

  test('50ms↑ 강제 줄은 표본을 소비하지 않는다', () => {
    const { probe, r } = rig();
    for (let i = 0; i < 4; i++) typeKey(probe, r, 2);
    typeKey(probe, r, 90);                // 5번째 키 — 강제 줄(표본은 아직 아니다)
    for (let i = 0; i < 4; i++) typeKey(probe, r, 2);
    typeKey(probe, r, 2);                 // 10번째 키 — 강제 줄이 표본을 안 먹었으니 표본 줄
    expect(r.lines.map((l) => l.data.keyToPaintMs)).toEqual([90, 2]);
    probe.dispose();
  });

  test('강제 줄이 표본 시점과 겹쳐도 표본은 다음 칠로 넘어간다 — 빠른 9 · 느린 10번째 · 빠른 11번째', () => {
    const { probe, r } = rig();
    for (let i = 0; i < 9; i++) typeKey(probe, r, 2);
    typeKey(probe, r, 80);
    typeKey(probe, r, 3);
    expect(r.lines.map((l) => l.data.keyToPaintMs)).toEqual([80, 3]);
    probe.dispose();
  });

  test('50ms 이상은 표본과 무관하게 항상 남긴다', () => {
    const { probe, r } = rig();
    typeKey(probe, r, 2);
    typeKey(probe, r, 50);
    typeKey(probe, r, 120);
    expect(r.lines.map((l) => l.data.keyToPaintMs)).toEqual([50, 120]);
    probe.dispose();
  });

  test('루프가 막힌 동안 온 키는 막힌 시간까지 센다(박동이 막힘을 먼저 끝낸 경우)', () => {
    const { probe, r } = rig({ sampleEvery: 100 });
    r.clock.t += 20; r.beat();
    r.clock.t += 320; r.beat();          // 300ms 막힘이 끝나며 박동이 먼저 돈다
    r.clock.t += 1; probe.noteKey();     // 같은 루프 회전에서 키 배달
    r.clock.t += 3; probe.notePaint();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.keyToPaintMs!).toBeGreaterThanOrEqual(300);
    probe.dispose();
  });

  test('막힘을 끝낸 박동과 키 배달 사이가 2ms 를 넘어도(그 사이 다른 콜백) 막힘을 센다', () => {
    const { probe, r } = rig({ sampleEvery: 100 });
    r.clock.t += 20; r.beat();
    r.clock.t += 320; r.beat();          // 300ms 막힘이 끝나는 박동
    r.clock.t += 15; probe.noteKey();    // 다른 콜백 뒤 15ms 늦게 배달
    r.clock.t += 3; probe.notePaint();
    expect(r.lines[0]!.data.keyToPaintMs!).toBeGreaterThanOrEqual(300);
    probe.dispose();
  });

  test('막힘 뒤 평상 박동이 한 번 돈 다음 온 키엔 막힘을 붙이지 않는다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    r.clock.t += 20; r.beat();
    r.clock.t += 320; r.beat();
    r.clock.t += 20; r.beat();           // 평상 박동
    r.clock.t += 5; probe.noteKey();
    r.clock.t += 3; probe.notePaint();
    expect(r.lines[0]!.data.keyToPaintMs).toBe(3);
    probe.dispose();
  });

  test('루프가 막힌 동안 온 키는 막힌 시간까지 센다(키가 박동보다 먼저 배달된 경우)', () => {
    const { probe, r } = rig({ sampleEvery: 100 });
    r.clock.t += 20; r.beat();
    r.clock.t += 320; probe.noteKey();   // 박동은 아직 · 300ms 밀림
    r.clock.t += 3; probe.notePaint();
    expect(r.lines[0]!.data.keyToPaintMs!).toBeGreaterThanOrEqual(300);
    probe.dispose();
  });

  test('칠 전에 온 둘째 키는 첫 키의 측정을 덮지 않는다 · 키 없는 칠은 줄을 안 낸다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    probe.notePaint();
    expect(r.lines).toHaveLength(0);
    r.clock.t += 20; r.beat();
    probe.noteKey();
    r.clock.t += 10; probe.noteKey();
    r.clock.t += 5; probe.notePaint();
    probe.notePaint();
    expect(r.lines.map((l) => l.data.keyToPaintMs)).toEqual([15]);
    probe.dispose();
  });

  test('루프가 안 막힌 채 1초 넘게 칠이 없던 키는 놓는다 — 뒤늦은 칠에 붙지 않는다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    r.clock.t += 20; r.beat();
    probe.noteKey();
    for (let i = 0; i < 60; i++) { r.clock.t += 20; r.beat(); }
    probe.notePaint();
    expect(r.lines).toHaveLength(0);
    probe.dispose();
  });

  test('막힘 «뒤» 1초는 놓지 않는다 — 막힌 동안 온 키는 막힘이 풀린 뒤의 칠까지 잰다', () => {
    const { probe, r } = rig({ sampleEvery: 100 });
    r.clock.t += 20; r.beat();
    probe.noteKey();
    r.clock.t += 2000; r.beat();          // 2초 막힘이 끝나는 박동
    r.clock.t += 5; probe.notePaint();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.keyToPaintMs!).toBeGreaterThanOrEqual(2000);
    probe.dispose();
  });

  test('p99 는 최근순위 — 표본 [0, 300] 이면 300 · 100표본 중 큰 값 하나는 p99 에서 빠진다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    r.clock.t += 20; r.beat();           // 0
    r.clock.t += 320; r.beat();          // 300
    r.clock.t += 20; r.beat();           // 평상 박동(막힘 귀속 끊기) — 0
    probe.noteKey(); r.clock.t += 1; probe.notePaint();
    expect(r.lines[0]!.data.loopDelayMs).toEqual({ p99: 300, max: 300 });
    for (let i = 0; i < 99; i++) { r.clock.t += 20; r.beat(); }
    r.clock.t += 520; r.beat();          // 500 — 100표본 중 하나
    r.clock.t += 20; r.beat();
    probe.noteKey(); r.clock.t += 1; probe.notePaint();
    expect(r.lines[1]!.data.loopDelayMs.max).toBe(500);
    expect(r.lines[1]!.data.loopDelayMs.p99).toBeLessThan(500);
    probe.dispose();
  });

  test('남긴 뒤 키 창을 비운다 — 다음 줄의 loopDelayMs 는 그 뒤 박동만 본다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    r.clock.t += 20; r.beat();
    r.clock.t += 120; r.beat();          // 드리프트 100
    probe.noteKey(); r.clock.t += 1; probe.notePaint();
    r.clock.t += 20; r.beat();           // 드리프트 1(칠 1ms 만큼 밀림)
    r.clock.t += 20; r.beat();
    probe.noteKey(); r.clock.t += 1; probe.notePaint();
    expect(r.lines.map((l) => l.data.loopDelayMs.max)).toEqual([100, 1]);
    probe.dispose();
  });

  test('dispose 뒤엔 키·칠이 줄을 안 낸다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    probe.dispose();
    probe.noteKey(); r.clock.t += 99; probe.notePaint();
    expect(r.lines).toHaveLength(0);
  });
});

describe('tui.input-lag turn-start', () => {
  test('preamble 창마다 한 줄 · 창 안의 동기 막힘이 loopDelayMs 에 찍힌다', () => {
    const { probe, r } = rig();
    r.clock.t += 20; r.beat();
    const out = probe.measureTurnStart(() => { r.clock.t += 300; return 'built'; }, 'turn-1');
    expect(out).toBe('built');
    r.clock.t += 1; r.beat();            // 막힘이 풀린 첫 박동 — 드리프트 281
    expect(r.lines).toHaveLength(0);     // 막힘은 루프가 풀린 뒤에 찍힌다 — 읽기는 미룬다
    r.flushTimeouts();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data).toEqual({
      phase: 'turn-start',
      loopDelayMs: { p99: 281, max: 281 },
      turnId: 'turn-1',
      busy: false,
      sampled: 1,
    });
    probe.dispose();
  });

  test('busy 는 창이 닫힐 때 값이다 — 미뤄 둔 읽기 사이에 바뀐 상태를 안 붙인다', () => {
    const state = { busy: false };
    const { probe, r } = rig(state);
    probe.measureTurnStart(() => { state.busy = true; return 1; }, 'turn-busy');
    state.busy = false;                  // 창이 닫힌 뒤 ~40ms 안에 턴이 끝난 경우
    r.flushTimeouts();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.busy).toBe(true);
    probe.dispose();
  });

  test('반증 — 창 끝에 한가했으면 뒤에 busy 가 돼도 false', () => {
    const state = { busy: false };
    const { probe, r } = rig(state);
    probe.measureTurnStart(() => 1, 'turn-idle');
    state.busy = true;
    r.flushTimeouts();
    expect(r.lines[0]!.data.busy).toBe(false);
    probe.dispose();
  });

  test('dispose 뒤엔 미뤄 둔 turn-start 읽기가 줄을 안 낸다', () => {
    const { probe, r } = rig();
    probe.measureTurnStart(() => 1, 'turn-x');
    probe.dispose();
    r.flushTimeouts();
    expect(r.lines).toHaveLength(0);
  });

  test('preamble 이 던져도 창을 닫고 줄을 남긴다', () => {
    const { probe, r } = rig();
    expect(() => probe.measureTurnStart(() => { throw new Error('boom'); })).toThrow('boom');
    r.flushTimeouts();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.turnId).toBeUndefined();
    probe.dispose();
  });
});

describe('tui.input-lag 등록 자리 — 반증', () => {
  test('프로브를 빼면 훅을 아무리 불러도 0줄', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    setInputLagProbe(null);
    for (let i = 0; i < 5; i++) { noteInputLagKey(); r.clock.t += 80; noteInputLagPaint(); }
    expect(measureInputLagTurnStart(() => 7)).toBe(7);
    r.flushTimeouts();
    expect(r.lines).toHaveLength(0);
    probe.dispose();
  });

  test('등록하면 같은 훅이 줄을 낸다', () => {
    const { probe, r } = rig({ sampleEvery: 1 });
    setInputLagProbe(probe);
    r.clock.t += 20; r.beat();
    noteInputLagKey(); r.clock.t += 80; noteInputLagPaint();
    measureInputLagTurnStart(() => 7);
    r.flushTimeouts();
    expect(r.lines.map((l) => l.data.phase)).toEqual(['keystroke', 'turn-start']);
    probe.dispose();
  });
});

describe('preambleSyncBlockMs seam', () => {
  const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;
  const build = () => buildDashboardTurnPreamble({
    userText: 'hi',
    cwd: mkdtempSync(join(tmpdir(), 'input-lag-seam-')),
    userConfig: fakeConfig,
    memory: false,
  });

  test('운영 기본 0 — env 가 있어도 test 우주가 아니면 무시한다', () => {
    expect(preambleSyncBlockMs({}, () => '/tmp/test-root')).toBe(0);
    expect(preambleSyncBlockMs({ [PREAMBLE_SYNC_BLOCK_ENV]: '300' }, prodInstanceRoot)).toBe(0);
    expect(preambleSyncBlockMs({ [PREAMBLE_SYNC_BLOCK_ENV]: '300' }, () => '/tmp/test-root')).toBe(300);
    expect(preambleSyncBlockMs({ [PREAMBLE_SYNC_BLOCK_ENV]: 'nope' }, () => '/tmp/test-root')).toBe(0);
  });

  describe('실효 우주로 판정한다(--test 플래그가 아니라)', () => {
    const savedStateDir = process.env.ELANOUS_STATE_DIR;
    const savedConfigDir = getElanousConfigDirOverride();
    const env = { [PREAMBLE_SYNC_BLOCK_ENV]: '300' };
    afterEach(() => {
      if (savedConfigDir === undefined) resetElanousConfigDir();
      else setElanousConfigDir(savedConfigDir);
      if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = savedStateDir;
      resetEffectiveInstanceRoot();
    });

    test('pty-drive 시험 자식 — --config-dir <test 뿌리> 면 켜진다', () => {
      delete process.env.ELANOUS_STATE_DIR;
      setElanousConfigDir(mkdtempSync(join(tmpdir(), 'seam-cfg-')));
      expect(preambleSyncBlockMs(env)).toBe(300);
    });

    test('부모 스탬프 ELANOUS_STATE_DIR <test 뿌리> 면 켜진다', () => {
      process.env.ELANOUS_STATE_DIR = mkdtempSync(join(tmpdir(), 'seam-stamp-'));
      expect(preambleSyncBlockMs(env)).toBe(300);
    });

    test('반증 — 운영 우주(--config-dir ~/.elanous)면 env 가 있어도 무시한다', () => {
      delete process.env.ELANOUS_STATE_DIR;
      setElanousConfigDir(prodInstanceRoot());
      expect(preambleSyncBlockMs(env)).toBe(0);
      setElanousConfigDir(`${prodInstanceRoot()}/`);
      expect(preambleSyncBlockMs(env)).toBe(0);
    });

    test('반증 — 아무 명시·스탬프가 없으면 운영 집이라 무시한다', () => {
      delete process.env.ELANOUS_STATE_DIR;
      resetEffectiveInstanceRoot();
      expect(preambleSyncBlockMs(env)).toBe(0);
    });
  });

  test('seam 0 이면 블록 없음 · seam N 이면 preamble 이 N ms 이상 동기로 막힌다', () => {
    setPreambleSyncBlockMsForTesting(0);
    build(); // 첫 빌드의 모듈 적재 비용을 재기 밖으로
    const t0 = performance.now();
    build();
    const unblocked = performance.now() - t0;
    setPreambleSyncBlockMsForTesting(120);
    const t1 = performance.now();
    build();
    const blocked = performance.now() - t1;
    expect(blocked).toBeGreaterThanOrEqual(120);
    expect(blocked - unblocked).toBeGreaterThanOrEqual(100);
  });

  test('등록된 프로브는 preamble 을 turn-start 창으로 잰다', () => {
    const { probe, r } = rig();
    setInputLagProbe(probe);
    build();
    r.flushTimeouts();
    expect(r.lines.map((l) => l.data.phase)).toEqual(['turn-start']);
    probe.dispose();
  });
});
