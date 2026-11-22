// TUI-NEXT-KEYSTROKE-COST PR-1(입력줄만 다시 그리기) — 실패-먼저 시험(작성만 · 실행은 본체 minim5).
//
// 관측(계기 · OP #132091 · 0.3.33 칸 완료선): next TUI 는 키 1자마다 render() 로 화면 전체
// 줄 배열을 다시 만든다(src/tui/entry.ts render() — prepareHistory 가 전체 대화를 다시 감산).
// 프로브 실측(elanous logs --grep tui.input-lag): keyToPaintMs 99.8 / 62.8 / 57.4 / 5.9ms —
// idle 표본(busy:false)에서도 완료선 5ms 를 3배以上 넘는다. loopDelayMs.p99 2.2–3.7ms 로
// 루프 자체는 무죄 → 비용은 전신 재구성 쪽. 이 시험은 PR-1 의 완료선을 그대로 단언한다:
//
//   (c) 측정 = 키 1자 TUI 처리 < 5ms  ← 출처: OP #132091 배정 칸 완료선 리터럴(제품 상수 아님)
//
// 기대값은 제품 상수·렌더 함수가 아니라 독립 리터럴/정규식(OP 규칙 11 · 11-18): 5ms 도
// p95 도 이 파일에 적힌 그대로다. PR-1 의 (a) «입력줄만 다시 그리기» 가 착지되면 타이핑
// 키의 칠 비용이 이 선 아래로 내려가 GREEN, 오늘 코드로는 RED 다.
//
// 대용량 세션 심기(2026-11-23): 빈 세션으로 부팅하면 칠이 가벼워 오늘 코드도 GREEN 이
// 된다(실측 1.93s 전체 통과) — 그래서 이 시험은 실사용 크기의 역사를 먼저 심는다.
// 심기는 실제 session API(createSession/appendMessage) 로만 한다 — 손으로 짜낸
// index.json/<id>.jsonl 형식은 계약 밖(포맷이 바뀌면 조용히 빈 세션이 되어 거짓-GREEN).
// 부팅은 루트 `--resume <id>` 로(무지시 부팅은 항상 신규 세션 — entry.ts:336-345 계약).
//
// PTY 패턴 = entry-input-lag-probe.test.ts 와 같은 mock-seat-pty-sequence 우주.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
// 정적 import(interference-ratchet 처방 — 게이트 r1 RED 2026-11-23 05:05 · receipt 7cd9e414c1…):
// 시험 본문 안 동적 import 는 차가운 게이트 Pod 에서 5s 시험 한도를 넘긴다(body-dynamic-import).
import { createSession, appendMessage, loadSession } from '../session/index.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const CATEGORY = 'tui.input-lag';
/** 충분한 표본: 드라이버 스텝 하나 = 붙여넣기 write 하나 → noteInputLagKey(12) → 표본 1줄.
 *  출처: #132091 칸 측정 전제(10키당 1표본) — 12키 스텝 5개 = 표본 ≥ 5줄. */
const STEP_CHARS = '가나다라마바사아자차카';
const STEP_COUNT = 5;
/** 출처: OP #132091 칸 완료선 «측정 = 키 1자 TUI 처리 <5ms» — 독립 리터럴(제품 상수 아님). */
const KEY_TO_PAINT_BUDGET_MS = 5;
// 출처: #132091 p95 판정 최소 표본 수 — 이보다 적으면 측정이 아니라 행운이다.
const MIN_SAMPLES = 3;
/** 심은 역사의 표지 — ready 화면(역사 꼬리)에 이 표지가 안 보이면 --resume 이 조용히
 *  실패한 것이다(거짓-GREEN 방호: 빈 세션 부팅과 RED 를 갈라낸다). */
const SEED_TAG = 'KEYSTK-SEED';
/** 심기 규모 — 출처: #132091 칸(실사용 세션 keyToPaintMs 99.8ms 실측 계기). 실사용
 *  크기(대화 수백 건)를 흉내 낸다: 메시지 300건 × 줄 40개 ≈ 역사 줄 1.2만. */
const SEED_MESSAGES = 300;
const SEED_LINES_PER_MESSAGE = 40;
/** 가짜 LLM 즉답 마커 — 이 문자열이 화면에 오면 시드 턴이 «완결»된 것이다(busy→false ⊕ messages 교체). */
const TURN_REPLY = 'KEYSTK-TURN-REPLY';

function readInputLagLines(root: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // debug.log 는 {root}/log(README 우주) 또는 {root}/.elanous/debug(--config-dir 우주)에 남는다.
  for (const dir of [join(root, 'log'), join(root, '.elanous', 'debug'), root]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^debug-.*\.log$/.test(name)) continue;
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (line.includes(`"${CATEGORY}"`) || line.includes(`'${CATEGORY}'`) || line.includes(CATEGORY)) {
          try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 비-JSON 줄은 계약 밖 — 건너뛴다 */ }
        }
      }
    }
  }
  return out;
}

test('typing a key repaints the input line under the 5ms keystroke budget (p95, idle samples)', async () => {
  const evidence = process.env.ELANOUS_INPUT_LAG_LIVE_OUT?.trim();
  const root = evidence ? join(evidence, 'state') : mkdtempSync(join(tmpdir(), 'next-line-repaint-'));
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      debug: { file: true },
      llm: { memoryJudge: { enabled: false, crossRecall: false } },
    }));
    // ── 대용량 세션 심기(실제 session API) — 무지시 부팅은 항상 신규 세션이므로 --resume 로 붙는다.
    const sessionRoot = join(root, 'sessions');
    mkdirSync(sessionRoot, { recursive: true });
    const seed = createSession({ source: 'tui', title: 'TUI-NEXT-KEYSTROKE-COST seed' }, sessionRoot);
    for (let i = 0; i < SEED_MESSAGES; i++) {
      const body = Array.from({ length: SEED_LINES_PER_MESSAGE }, (_, line) =>
        `${SEED_TAG} ${i}-${line} ${'X'.repeat(56)}`).join('\n');
      appendMessage(seed.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `${SEED_TAG} message ${i}\n${body}`, ts: new Date().toISOString() }, sessionRoot);
    }
    expect(loadSession(seed.id, sessionRoot)?.messages.length).toBe(SEED_MESSAGES); // 심기 직후 원장 확인
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next', '--resume', seed.id],
      root,
      rows: 24,
      cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: sessionRoot,
        // 가짜 LLM(스위치 계약: root-tui-default-pty.test.ts 와 동일) — 시드 턴 1개를 실제 턴으로
        // 완결한다. 턴이 끝나면 messages 배열이 «교체»되어 히스토리 캐시(publicHistoryView·
        // prepareHistory, 참조 비교)가 콜드가 되고, 바로 다음 타이핑이 전신 render() 를 밟는다 —
        // 실사용 keyToPaintMs 99.8ms 표본이 난 바로 그 조건이다(빈 세션·무턴 상태로는 우연 GREEN).
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_LLM_MODE: 'fake',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: `${TURN_REPLY} 시드 턴 완결 — 이후 타이핑이 콜드 렌더를 밟는다`,
      },
      ready: { label: 'ready', timeoutMs: 30_000, until: screen => screen.includes('❯ ') && screen.includes('Ctrl+Q') },
      // 시드 턴 1개(실제 턴 완결) → 타이핑. 12키 스텝 5개 — enter:false 로 붙여넣기 write 만 날린다(드라이버
      // 기본값은 150ms 뒤 \r 제출 — 그러면 스텝마다 턴이 발사돼 측정 우주가 무너진다). 스텝당 write 1개 →
      // 프로브는 «칠을 기다리는 첫 키»만 잡되 keysSinceLine(12키 ≥ sampleEvery 10) 덕에 표본 1줄씩 남는다
      // (input-lag-probe.ts noteKey/notePaint 참조). 표지 «{index}가» 는 스텝마다 고유 — until 이 앞 스텝
      // 화면에서 일찍 성립하지 않는다.
      steps: [
        {
          label: 'seed-turn',
          text: 'seed',
          enter: true,
          timeoutMs: 30_000, // 출처: #132091 시드 턴 상한(ms) — 가짜 LLM 즉답·세션 저장 실측 <5s · 여유분
          // 완결 = 즉답 마커가 보이되 스피너(스트리밍·저장)는 사라진 뒤 — busy:false 표본 조건.
          // (마커만 보고 잡으면 스트리밍 도중에 성립한다 — node-b 실측 02:09 프레임에 ⠙ 잔존.)
          until: screen => screen.includes(TURN_REPLY) && !/Thinking|esc to interrupt/.test(screen),
        },
        ...Array.from({ length: STEP_COUNT }, (_, index) => ({
        label: `typed-echo-${index + 1}`,
        text: `${'ZQ'.repeat(4)}${index}${STEP_CHARS}`,
        enter: false,
        timeoutMs: 10_000, // 출처: #132091 12키 에코 스텝 상한(ms) — 1키 에코 실측 <1s · 여유분
          until: (screen: string) => screen.includes(`${index}${STEP_CHARS.slice(0, 1)}`),
        })),
      ],
      quitKeys: '\x11',
      ...(evidence ? { artifactPath: join(evidence, 'next-line-repaint-minim5.json') } : {}),
    });
    expect(run.frames[0]!.screen).toContain('❯ ');
    // 거짓-GREEN 방호: --resume 이 조용히 실패해 빈 세션으로 부팅했으면 이 표지가 안 보인다.
    expect(run.frames[0]!.screen).toContain(SEED_TAG);
    const seedFrame = run.frames.find(f => f.label === 'seed-turn')!;
    expect(seedFrame.screen).toContain(TURN_REPLY); // 시드 턴 완결 확인(마커·스피너 소실 predicate)
    const echoFrame = run.frames.find(f => f.label === 'typed-echo-1')!;
    expect(echoFrame.screen).toContain(`${0}${STEP_CHARS.slice(0, 1)}`); // 첫 키 에코 — 칠 경로 생존(프로브 배선 전제)
    // 본 단언 — 칸 완료선 (c): idle(busy:false) 타이핑 표본의 p95 가 5ms 아래.
    // 출처: #132091 측정 계약 — 표본은 «타이핑» 에코만. 측정 창은 «첫 에코 스텝 프레임(typed-echo-1)
    // 이후»로 잡는다(2026-11-23 6회 재현 수정 — 이전 «시드 완결 이후» 창은 6회 중 4회 FAIL 실측):
    // 턴 종료 콜드 렌더(메시지 교체 → 전신 재조립)가 루프를 256–319ms 막는 동안 도착한 첫 타이핑
    // 키에 프로브의 «막힘 대기 상한 추정»(input-lag-probe.ts noteKey pendingWaitMs 계약)이 그 막힘을
    // 이관해 busy:false · phase:'keystroke' 오염 표본(keyToPaintMs 256.3–319.2ms)을 남긴다 — 이 ts 가
    // 시드 프레임 at 와 ~1ms 경합이라 «시드 완결 이후» 필터로는 확정 배제가 안 된다. 첫 에코 프레임은
    // 그 오염 표본의 칠을 «관측한» 뒤라 항상 뒤에 있어 확정 배제되고, 스텝 2–5 표본만 남는다(수리 후
    // 실측 0.4–0.9ms · 오늘 전신 경로 코드로는 24–99ms — RED 계약 보존).
    const echo1At = Date.parse(echoFrame.at);
    const measured = readInputLagLines(root)
      .filter(l => typeof l['ts'] === 'string' && Date.parse(String(l['ts'])) > echo1At)
      .map(l => (l['data'] && typeof l['data'] === 'object' ? l['data'] : l) as Record<string, unknown>)
      .filter(d => d['phase'] === 'keystroke' && d['busy'] === false && typeof d['keyToPaintMs'] === 'number');
    expect(measured.length).toBeGreaterThanOrEqual(MIN_SAMPLES); // 표본 부족이면 측정 성립 자체가 실패
    const keyToPaint = measured.map(d => Number(d['keyToPaintMs'])).sort((a, b) => a - b);
    const p95 = keyToPaint[Math.max(0, Math.ceil(keyToPaint.length * 0.95) - 1)]!;
    // 출처: OP #132091 칸 완료선 — p95(keyToPaintMs) < 5ms. 오늘 전신 render() 로는 RED(실측 99.8ms).
    expect(p95).toBeLessThan(KEY_TO_PAINT_BUDGET_MS);
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // 대용량 역사(메시지 300) 부팅 + 56키 타이핑 — 여유 상한