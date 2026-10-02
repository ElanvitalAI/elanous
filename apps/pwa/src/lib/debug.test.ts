/**
 * PWA DebugForwarder — 배치/재시도/레벨 프리필터 계약 (LF2 · 2026-07-13).
 * fetch 주입 — 네트워크 미접촉. (Node 환경이라 debugLog 자체의 자동 포워딩은
 * window 가드로 비활성 — 포워더 클래스를 직접 검증한다.)
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { DebugForwarder, deriveForwardLevel, setDebugForwardFallback } from './debug';

function rec(category: string): { ts: string; category: string; event: string; source: { platform: 'pwa' } } {
  return {
    ts: new Date().toISOString(),
    category,
    event: category.slice(category.lastIndexOf('.') + 1),
    source: { platform: 'pwa' },
  };
}

describe('deriveForwardLevel — 서버 규칙과 동일한 접미사 유도', () => {
  it('suffix 매핑', () => {
    expect(deriveForwardLevel('webterm.tabs.error')).toBe('error');
    expect(deriveForwardLevel('voice.ws.timeout')).toBe('warn');
    expect(deriveForwardLevel('webterm.attach.ok')).toBe('info');
    expect(deriveForwardLevel('webterm.xterm.onData')).toBe('debug');
  });
});

describe('DebugForwarder', () => {
  it('100ms 배치 — 성공 시 큐 비움', async () => {
    const bodies: string[] = [];
    const f = new DebugForwarder(async (b) => { bodies.push(b); return true; });
    f.push(rec('webterm.tabs.list'));
    f.push(rec('webterm.tabs.add'));
    expect(f.pending).toBe(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(bodies.length).toBe(1);
    const parsed = JSON.parse(bodies[0]!) as { records: Array<{ category: string; source: { platform: string } }> };
    expect(parsed.records.length).toBe(2);
    expect(parsed.records[0]!.source.platform).toBe('pwa');
    expect(f.pending).toBe(0);
  });

  it('전송 실패 시 큐 유지 → 재시도가 이어진다', async () => {
    // ⛔⭐ 19차: 자기재시도(백오프 타이머)가 붙으면서 이 자가 «타이머와 경쟁»해
    //   같은 코드로 통과·실패를 오갔다(4회 중 1회 실패 실측).
    //   ⇒ 슬립 대신 `flush()` 를 직접 몬다 — 재는 계약은 그대로다.
    let fail = true;
    const f = new DebugForwarder(async () => !fail);
    f.push(rec('a.b'));
    await f.flush();
    expect(f.pending).toBe(1); // 실패 — 유지(유실 없음)
    fail = false;
    f.push(rec('a.c'));
    await f.flush();
    // ⭐ 실패 «뒤» 첫 성공은 회복 레코드를 한 건 큐에 넣는다 — 조용히 돌아오면
    //   「그동안 아무 일 없었다」로 읽히기 때문이다. 그래서 한 사이클 더 돌려야 완전히 빈다.
    expect(f.pending).toBe(1);
    await f.flush();
    expect(f.pending).toBe(0); // 재시도 성공 ⊕ 회복 레코드까지 나갔다
  });

  it('minLevel 프리필터 — warn 설정 시 debug/info 미전송', async () => {
    const f = new DebugForwarder(async () => true, 'warn');
    f.push(rec('webterm.xterm.onData')); // debug
    f.push(rec('webterm.attach.ok'));    // info
    f.push(rec('voice.ws.timeout'));     // warn
    expect(f.pending).toBe(1);
  });

  it('큐 캡 500 — 오프라인 폭주 시 오래된 것부터 드롭', () => {
    const f = new DebugForwarder(async () => false);
    for (let i = 0; i < 600; i++) f.push(rec(`x.y${i}`));
    expect(f.pending).toBeLessThanOrEqual(500);
  });

  /** ⛔⭐⭐⭐ 「끝나지 않는 전송」이 포워더를 «영영» 잠그지 않는다 — 17차 `[F]` 실측 결함.
   *
   *  📏 2026-08-22: 데몬을 재시작하자 ***PWA 로그가 통째로 끊겼다.*** 그 사이 채팅 턴은
   *  «정상으로 돌았고»(답이 왔다) 관측만 15분 넘게 0건이었으며, ***리로드하면 회복됐다.***
   *  ⇒ 기전: `flush()` 는 `inFlight` 면 즉시 return 하는데 `await fetchFn(...)` 이 영영 pending 이면
   *    `finally` 도 안 돌아 ***`inFlight` 가 영영 true*** 로 남는다.
   *  🔑 ***그리고 그것은 조용하다*** — 콘솔에도 서버에도 화면에도 흔적이 없다. 그래서 못 봤다. */
  it('⛔ 「끝나지 않는 전송」 뒤에도 다음 배치가 나간다 — 포워더가 잠기지 않는다', async () => {
    let calls = 0;
    let secondResolved = false;
    const f = new DebugForwarder(
      async () => {
        calls += 1;
        if (calls === 1) return new Promise<boolean>(() => { /* ⛔ 영영 pending */ });
        secondResolved = true;
        return true;
      },
      'debug',
      30, // 시험용 상한 — 실제 기본은 10초
    );

    f.push(rec('a.b'));
    await new Promise((r) => setTimeout(r, 120));   // 1차: 타임아웃으로 «풀려야» 한다
    expect(calls).toBe(1);
    expect(f.pending).toBe(1);                      // ⭐ 실패했으므로 큐는 «유지»된다(유실 없음)

    f.push(rec('a.c'));                             // 다음 push 가 flush 를 다시 건다
    await new Promise((r) => setTimeout(r, 120));
    // ⭐ 여기가 이 시험의 전부다 — 잠겨 있었다면 2차 호출이 «영영» 없다.
    expect(secondResolved).toBe(true);
    // ⭐ 19차: 회복 레코드 한 건이 남는다(위 시험의 주석 참조) — 한 사이클 더 돌면 빈다.
    await new Promise((r) => setTimeout(r, 120));
    expect(f.pending).toBe(0);
  });
});

/** ⛔⭐⭐⭐⭐ **「관측이 막혔다」를 스스로 말하는가** — 19차 `[F]`.
 *
 *  📏 2026-08-22 실측: SSE 가 브라우저의 HTTP/1.1 커넥션 한도(6)를 먹어 ***모든 HTTP 가
 *  영영 큐에 섰다.*** PWA 로그 8분간 0건 · 탭 리로드조차 불가. 그런데 ***채팅은 계속 돌았다***
 *  — WebSocket 은 그 풀을 안 쓴다.
 *
 *  🔑 이 저장소 제1원칙: ***판정 결과가 흐르는 채널은 그 판정의 대상이 쓸 수 없어야 한다.***
 *  포워더가 자기 고장을 「고장 난 그 통로」로만 보고하면 영영 못 듣는다.
 *
 *  ⇒ 이 자가 무는 것 셋:
 *    ⓐ 실패가 이어지면 «살아 있는» 대체 통로로 나가는가
 *    ⓑ 그때 「왜 이 통로로 왔는지」를 같이 싣는가
 *    ⓒ 회복하면 「그동안 무엇을 잃었나」를 말하는가 — ⛔ 조용히 돌아오면 아무도 못 묻는다 */
describe('관측이 막혔을 때 — 대체 통로와 자기 건강', () => {
  const rec2 = (category: string): Parameters<DebugForwarder['push']>[0] => ({
    ts: new Date().toISOString(),
    category,
    event: category.slice(category.lastIndexOf('.') + 1),
    source: { platform: 'pwa' as const },
  });

  afterEach(() => { setDebugForwardFallback(null); });

  it('⛔ 캡을 넘겨 «버린» 수를 센다 — 예전엔 조용히 splice 만 했다', () => {
    const f = new DebugForwarder(async () => false);
    for (let i = 0; i < 600; i += 1) f.push(rec2(`x.y${i}`));
    expect(f.pending).toBeLessThanOrEqual(500);
    // 🔑 100건을 잃었다는 «사실»이 남아야 한다.
    expect(f.health().droppedByCap).toBe(100);
  });

  it('⭐ 실패가 이어지면 대체 통로로 나간다 — 1회 실패로는 «안» 쓴다', async () => {
    const sent: string[] = [];
    setDebugForwardFallback(async (b) => { sent.push(b); return true; });
    const f = new DebugForwarder(async () => false);

    // ⛔⭐ 타이머를 «기다리지» 않고 flush 를 직접 몬다 — 백오프 스케줄에 걸리면
    //   같은 코드가 통과·실패를 오간다(19차에 실제로 그랬다). 계약만 결정적으로 잰다.
    f.push(rec2('a.b'));
    await f.flush();
    expect(sent).toHaveLength(0);            // ⭐ 1회는 흔한 일 — 참는다
    expect(f.health().consecutiveFailures).toBe(1);

    await f.flush();
    expect(sent).toHaveLength(1);            // ⛔ 2회째부터 «살아 있는» 통로로
    expect(f.health().fallbackBatches).toBe(1);
  });

  it('⛔ 폴백 배치는 「왜 이 통로로 왔는지」를 같이 싣는다', async () => {
    const sent: string[] = [];
    setDebugForwardFallback(async (b) => { sent.push(b); return true; });
    const f = new DebugForwarder(async () => false);
    f.push(rec2('a.b'));
    await f.flush();
    await f.flush();

    const parsed = JSON.parse(sent[0]!) as { records: Array<{ category: string; data?: Record<string, unknown> }> };
    const notice = parsed.records.find((r) => r.category === 'pwa.debug-forwarder.http-blocked');
    expect(notice).toBeDefined();
    expect(notice!.data).toMatchObject({ via: 'acp-fallback' });
    // ⭐ 원래 레코드도 «같이» 간다 — 통지만 보내면 그 사이 관측은 여전히 잃는다.
    expect(parsed.records.some((r) => r.category === 'a.b')).toBe(true);
  });

  it('⛔ 폴백이 성공해도 큐를 비우지 «않는다» — HTTP 회복 시 정상 경로로 다시 올린다', async () => {
    setDebugForwardFallback(async () => true);
    const f = new DebugForwarder(async () => false);
    f.push(rec2('a.b'));
    f.push(rec2('a.c'));
    await f.flush();
    await f.flush();
    expect(f.pending).toBe(2);
  });

  it('⭐⭐ 회복하면 「그동안 무엇을 잃었나」를 말한다', async () => {
    const bodies: string[] = [];
    let fail = true;
    const f = new DebugForwarder(async (b) => { bodies.push(b); return !fail; });
    f.push(rec2('a.b'));
    await f.flush();                 // 실패
    fail = false;
    await f.flush();                 // 성공 — 회복 레코드가 «큐에» 들어간다
    await f.flush();                 // 그 레코드가 나간다

    const all = bodies.flatMap((b) => (JSON.parse(b) as { records: Array<{ category: string; data?: Record<string, unknown> }> }).records);
    const recovered = all.find((r) => r.category === 'pwa.debug-forwarder.recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.data).toMatchObject({ consecutiveFailures: 1 });
    // ⭐ 「언제부터 눈이 멀었나」를 답하려면 «직전 성공 시각»이 있어야 한다(리뷰 must-fix #11391).
    expect(recovered!.data).toHaveProperty('previousOkAt');
    // 🔑 그리고 «한 번만» 말한다 — 매 배치마다 떠들면 그것도 잡음이다.
    expect(all.filter((r) => r.category === 'pwa.debug-forwarder.recovered')).toHaveLength(1);
  });

  it('⛔ 폴백이 «없으면» 동작은 이 수리 이전과 같다 — 새 실패 모드를 만들지 않는다', async () => {
    setDebugForwardFallback(null);
    const f = new DebugForwarder(async () => false);
    f.push(rec2('a.b'));
    f.push(rec2('a.c'));
    await f.flush();
    await f.flush();
    expect(f.pending).toBe(2);
    expect(f.health().fallbackBatches).toBe(0);
  });
});

/** ⛔⭐⭐⭐⭐ **「앱이 조용해도 스스로 재시도하는가」** — 19차 `[F]` · 라이브가 잡은 결함.
 *
 *  📏 라이브 실측: HTTP 를 굶긴 채 턴을 보냈는데 ***폴백이 끝내 안 떴다.***
 *  ⇒ 기전: 옛 정책은 재시도를 «다음 push» 에만 맡겼다. 앱이 조용해지면 push 가 없고,
 *    flush 도 없고, ***연속 실패가 1에서 멈춰 폴백 문턱(2)에 영영 못 간다.***
 *  🔑 ***막혔을 때 스스로 못 움직이는 복구 장치는 복구 장치가 아니다.***
 *
 *  ⛔⭐ 그리고 ***앞선 시험들이 이걸 못 잡았다*** — 전부 두 번씩 push 했기 때문이다.
 *    (자가 자기 편한 입력만 준 것 · 이 트랙 문법 #2.) 그래서 이 자는 ***한 번만 push 한다.*** */
describe('막힌 포워더가 «스스로» 움직인다', () => {
  const rec3 = (category: string): Parameters<DebugForwarder['push']>[0] => ({
    ts: new Date().toISOString(),
    category,
    event: category.slice(category.lastIndexOf('.') + 1),
    source: { platform: 'pwa' as const },
  });

  afterEach(() => { setDebugForwardFallback(null); });

  it('⛔ push 를 «한 번»만 해도 재시도가 이어져 폴백까지 간다', async () => {
    const sent: string[] = [];
    setDebugForwardFallback(async (b) => { sent.push(b); return true; });
    let calls = 0;
    const f = new DebugForwarder(async () => { calls += 1; return false; });

    f.push(rec3('a.b'));                              // ⭐ 단 한 번
    await new Promise((r) => setTimeout(r, 900));     // 100 → 200 → 400ms 백오프로 3회 이상

    expect(calls).toBeGreaterThanOrEqual(2);          // 스스로 다시 두드렸다
    expect(sent.length).toBeGreaterThanOrEqual(1);    // ⇒ 폴백 문턱에 «도달했다»
    expect(f.health().consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  it('⭐ 큐가 비면 재시도를 «걸지 않는다» — 빈 탭이 영원히 두드리면 안 된다', async () => {
    let calls = 0;
    const f = new DebugForwarder(async () => { calls += 1; return true; });
    f.push(rec3('a.b'));
    await new Promise((r) => setTimeout(r, 150));
    const afterFirst = calls;
    await new Promise((r) => setTimeout(r, 400));
    // 회복 레코드 한 건이 나가는 것 외에는 늘지 않는다.
    expect(calls - afterFirst).toBeLessThanOrEqual(1);
  });
});

/** ⛔⭐⭐⭐ **무인 리뷰 must-fix 를 «재는» 자** — PR #11391 · 19차 `[F]`.
 *
 *  리뷰 주장: *"자동 재시도가 미완료 POST 를 누적시켜 ***바로 줄이려던 커넥션 슬롯 고갈을
 *  재발·악화시킨다***."*
 *
 *  📏 코드를 읽으면 그렇지 않다 — ⓐ `flush()` 는 `inFlight` 면 즉시 return 하고
 *  ⓑ 재시도는 `inFlight=false` 가 «된 뒤에만» 걸린다. ⇒ 동시 전송은 원리상 «최대 1».
 *  (그리고 실전송 `defaultPost` 는 `AbortSignal.timeout` 으로 소켓까지 끊는다.)
 *
 *  🔑 ***그러나 「코드를 읽으면」은 이 저장소가 인정하는 증거가 아니다*** — 그래서 «잰다».
 *  ⛔ 이 자가 없으면 나중에 누가 `inFlight` 가드를 지워도 아무도 모른다. */
describe('재시도가 «겹치지» 않는다 — 슬롯을 더 먹지 않는다', () => {
  afterEach(() => { setDebugForwardFallback(null); });

  it('⛔ 굶은 채 오래 돌려도 동시 전송은 «최대 1»이다', async () => {
    let inFlightNow = 0;
    let maxConcurrent = 0;
    let attempts = 0;
    const f = new DebugForwarder(
      async () => {
        attempts += 1;
        inFlightNow += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightNow);
        // 굶은 HTTP 를 흉내 — 상한(아래 30ms)에 걸려 실패로 처리된다.
        await new Promise((r) => setTimeout(r, 200));
        inFlightNow -= 1;
        return false;
      },
      'debug',
      30, // 시험용 상한
    );
    f.push({
      ts: new Date().toISOString(), category: 'a.b', event: 'b', source: { platform: 'pwa' as const },
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(attempts).toBeGreaterThanOrEqual(2);   // 스스로 여러 번 시도했고
    expect(maxConcurrent).toBe(1);                // ⭐ 그래도 «겹치지» 않았다
  });
});

// TERM1 · 10-02 — typing in the terminal must not send one POST per key: the production forwarder batches 1.5 s,
// and a full batch still goes at once.
it('a slow-flush forwarder sends one batch for a burst of keys, and flushes a full batch immediately', async () => {
  const bodies: string[] = [];
  const f = new DebugForwarder(async (b) => { bodies.push(b); return true; }, 'debug', 1_000, 300);
  for (let i = 0; i < 7; i++) f.push({ category: 'webterm.ws.frame.in', ts: Date.now(), snapshot: { i } } as never);
  await new Promise((r) => setTimeout(r, 120));
  expect(bodies).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 260));
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0]!).records).toHaveLength(7);
  for (let i = 0; i < 100; i++) f.push({ category: 'webterm.ws.frame.in', ts: Date.now(), snapshot: { i } } as never);
  await new Promise((r) => setTimeout(r, 10));
  expect(bodies).toHaveLength(2);
});
