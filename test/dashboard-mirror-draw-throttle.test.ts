import { describe, expect, test } from 'bun:test';
import {
  createMirrorDrawThrottle,
  MIRROR_DRAW_MIN_INTERVAL_MS,
  MIRROR_DRAW_OBSERVE_SUPPRESSED_THRESHOLD,
} from '../src/dashboard/mirror-draw-throttle.js';
import { tuiSourceFileWith, tuiSourceText } from './helpers/dashboard-source.js';

/** 시간을 «인자»로 준다 — 실제 타이머를 기다리지 않는다. */
function harness() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  let draws = 0;
  const observed: Array<{ suppressed: number; drawn: number }> = [];
  const throttle = createMirrorDrawThrottle({
    draw: () => { draws += 1; },
    now: () => now,
    schedule: (fn, ms) => { timers.push({ at: now + ms, fn }); return undefined; },
    observe: (payload) => { observed.push({ suppressed: payload.suppressed, drawn: payload.drawn }); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0, timers.length)) {
      if (t.at <= now) t.fn();
      else timers.push(t);
    }
  };
  return { throttle, advance, draws: () => draws, observed: () => observed, setNow: (v: number) => { now = v; } };
}

describe('로그 미러가 부르는 그리기 — 시간으로 묶는다', () => {
  test('첫 요청은 «즉시» 그린다 — 미루지 않는다', () => {
    const h = harness();
    h.throttle.request();
    expect(h.draws()).toBe(1);
  });

  test('폭주(요청 500회)에도 그리기는 «한 번»이고, 나머지는 미뤄진다', () => {
    const h = harness();
    for (let i = 0; i < 500; i += 1) h.throttle.request();
    // ⛔ 이것이 이 판의 핵심이다 — 500회 요청이 500회 그리기가 되면 8초에 50MB 가 된다.
    expect(h.draws()).toBe(1);
    expect(h.throttle.stats().suppressed).toBe(499);
  });

  test('⛔ 미룬 것을 «버리지» 않는다 — 창이 지나면 한 번 그린다(마지막 상태가 화면에 온다)', () => {
    const h = harness();
    h.throttle.request();          // 즉시 1회
    h.throttle.request();          // 미룸
    expect(h.draws()).toBe(1);
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);
    expect(h.draws()).toBe(2);
  });

  test('창이 지난 뒤의 요청은 다시 «즉시» 그린다 — 평상시 지연이 없다', () => {
    const h = harness();
    h.throttle.request();
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS + 1);
    h.throttle.request();
    expect(h.draws()).toBe(2);
  });

  test('평상시엔 관측을 «한 줄도» 안 낸다 — 관측이 곧 로그이고 로그가 이 되먹임의 입력이다', () => {
    const h = harness();
    h.throttle.request();
    h.throttle.request();          // 미룬 것 1건뿐 — 문턱 미만
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);
    expect(h.observed()).toEqual([]);
  });

  // ⛔ 리뷰가 잡은 경쟁 조건 — 예약이 «늦는» 사이에 즉시 그리기가 나면 간격이 깨진다.
  test('예약이 늦는 사이 즉시 그리기가 나도 «최소 간격»을 지킨다', () => {
    const h = harness();
    h.throttle.request();                                   // t=0 · 즉시 (1)
    h.throttle.request();                                   // 미룸 → t=120 예약
    h.setNow(MIRROR_DRAW_MIN_INTERVAL_MS + 10);             // 시계가 «지나쳐» 있다(타이머가 늦었다)
    h.throttle.request();                                   // 즉시 (2) — lastDrawAt 갱신
    expect(h.draws()).toBe(2);
    h.advance(1);                                           // 늦은 타이머가 이제 깬다
    // ⛔ 여기서 그리면 «간격 위반»이다 — 타이머는 다시 재어 잠들어야 한다.
    expect(h.draws()).toBe(2);
    // 그리고 즉시 그리기가 미룬 것을 비웠으므로, «새 요청»이 와야 다음 그리기가 생긴다.
    h.throttle.request();                                   // 창 안이라 미뤄진다
    expect(h.draws()).toBe(2);
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);                 // 창이 지난 뒤에야 그린다
    expect(h.draws()).toBe(3);
  });

  test('미룬 것이 «없으면» 타이머가 깨어도 괜한 그리기를 안 한다', () => {
    const h = harness();
    h.throttle.request();                                   // 즉시 (1)
    h.throttle.request();                                   // 미룸 1건
    h.setNow(MIRROR_DRAW_MIN_INTERVAL_MS + 10);
    h.throttle.request();                                   // 즉시 (2) · 미룬 것 0으로 리셋
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS + 10);
    expect(h.draws()).toBe(2);
  });

  test('관측은 «냉각» 안에서 두 번 안 나온다', () => {
    const h = harness();
    const storm = () => { for (let i = 0; i < MIRROR_DRAW_OBSERVE_SUPPRESSED_THRESHOLD + 2; i += 1) h.throttle.request(); };
    storm(); h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);
    expect(h.observed()).toHaveLength(1);
    storm(); h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);         // 냉각(5초) 안 — 또 내면 안 된다
    expect(h.observed()).toHaveLength(1);
  });

  // ⛔ 이 판이 «막으려는 것» 그 자체 — 그리기가 다시 요청을 부르는 비동기 되먹임.
  test('그리기가 «다시 요청»을 불러도 초당 그리기가 상한 안에 있다', () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    let draws = 0;
    const throttle = createMirrorDrawThrottle({
      // 그리기가 로그를 내고, 그 로그가 다시 요청을 부른다(실물의 고리).
      draw: () => { draws += 1; queueBack(); },
      now: () => now,
      schedule: (fn, ms) => { timers.push({ at: now + ms, fn }); return undefined; },
    });
    const queueBack = () => { pendingFeedback += 1; };
    let pendingFeedback = 0;
    throttle.request();
    // 1초를 10ms 씩 굴린다 — 매 틱마다 되먹임 요청을 흘려 넣는다.
    for (let t = 0; t < 100; t += 1) {
      now += 10;
      while (pendingFeedback > 0) { pendingFeedback -= 1; throttle.request(); }
      for (const timer of timers.splice(0, timers.length)) {
        if (timer.at <= now) timer.fn(); else timers.push(timer);
      }
    }
    // 1초 · 최소 간격 120ms ⇒ 상한은 약 9회. 폭주(수백~수천 회)와는 «자릿수»가 다르다.
    expect(draws).toBeLessThanOrEqual(10);
    // ⛔ 상한만 재면 「한 번 그리고 «영영 멈춤»」도 통과한다(리뷰 지적) —
    //    되먹임이 계속되는 동안 «간격마다 계속» 그려야 한다. 1초면 최소 5회는 나와야 한다.
    expect(draws).toBeGreaterThanOrEqual(5);
  });

  test('진짜 폭주일 때만 «이름을 대고» 말한다 — 미룬 수를 값으로 낸다', () => {
    const h = harness();
    h.throttle.request();          // 즉시
    for (let i = 0; i < MIRROR_DRAW_OBSERVE_SUPPRESSED_THRESHOLD + 5; i += 1) h.throttle.request();
    h.advance(MIRROR_DRAW_MIN_INTERVAL_MS);
    expect(h.observed()).toHaveLength(1);
    expect(h.observed()[0]!.suppressed).toBe(MIRROR_DRAW_OBSERVE_SUPPRESSED_THRESHOLD + 5);
  });
});

// ⛔⭐ 위 시험들은 스로틀 «단위»만 문다 — 누가 TUI 진입(대시보드 index) 에서 «배선»을 빼도 전부 초록이다.
//   📏 이것이 이 저장소가 반복해 밟은 계급이다: 「그 파일이 초록」은 「그 축이 닫혔다」가 아니다.
//   ⇒ 그래서 «배선 자체»를 문다 — 미러 훅이 스로틀을 거치지 않고 draw() 를 «직접» 부르면 빨강.
describe('미러 훅의 «배선» — 단위가 아니라 그 자리를 문다', () => {
  const dashboardSource = () => tuiSourceText();

  test('미러 훅이 스로틀을 «거친다» — draw() 를 직접 부르지 않는다', () => {
    // 훅을 «거는» 줄로 닻을 내린다 — mirror-draw-throttle.ts 머리 주석에도 같은 글자가 있어 첫 출현으로는 못 집는다.
    const hookCall = /^\s*debug\.setMirrorHook\(/m;
    const { text: source } = tuiSourceFileWith(hookCall);
    const hookStart = source.search(hookCall);
    expect(hookStart).toBeGreaterThan(-1);
    const hookBody = source.slice(hookStart, source.indexOf('});', hookStart));
    // ⛔ 되먹임을 다시 만드는 «그 한 줄»이 돌아오면 빨강이 된다.
    expect(hookBody).not.toContain('draw()');
    expect(hookBody).toContain('mirrorDrawThrottle.request()');
  });

  test('스로틀이 «만들어져» 있고 draw 를 받는다', () => {
    const source = dashboardSource();
    expect(source).toContain('createMirrorDrawThrottle({');
  });
});
