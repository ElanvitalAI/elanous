// KEYSTROKE-COST ⑧ — next TUI input-lag 프로브 등록 배선의 실패-먼저 시험(작성만 · 실행은 본체 minim5).
//
// 관측(계기): minim5 원격 `--tui next` 에서 한글 200키 타이핑에도 `tui.input-lag` 줄 0건 —
// src/tui/entry.ts 에 setInputLagProbe 등록이 없어 noteInputLagKey/noteInputLagPaint 가 전부 noop.
// 이 시험은 등록 배선이 끊기면(회귀되면) RED 가 된다. PTY 패턴은 entry-now-latency-pty.test.ts 와
// 같은 mock-seat-pty-sequence 우주다.
//
// 기대값은 제품 상수가 아니라 독립 리터럴 — 계약(src/tui/input-lag-probe.ts 머리말)이 어긋나면
// 여기 값과 어긋나므로 시험이 알려준다.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const CATEGORY = 'tui.input-lag';
const EVENT = 'measured';
/** 표본 비율(기본 10키 중 1)과 무관하게 최소 1줄이 나오도록 넉넉히 친다. */
const TYPED = '가나다라마바사아자차카타파하';

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

test('next TUI leaves at least one tui.input-lag measured line after typing in a real PTY', async () => {
  const evidence = process.env.ELANOUS_INPUT_LAG_LIVE_OUT?.trim();
  const root = evidence ? join(evidence, 'state') : mkdtempSync(join(tmpdir(), 'next-input-lag-'));
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      debug: { file: true },
      llm: { memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      rows: 24,
      cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions') },
      ready: { label: 'ready', timeoutMs: 30_000, until: screen => screen.includes('❯ ') && screen.includes('Ctrl+Q') }, // 출처: #39583 부트 마커 대기 상한(ms) — node-b/minim5 실측 부팅 ~1s, 여유분
      steps: [{
        label: 'typed-echo',
        text: TYPED,
        timeoutMs: 5_000, // 출처: #39583 10키 전문 에코 스텝 상한(ms) — 1키 에코 관측 실측 <1s
        // '가' 한 글자만 기다리면 첫 키 에코에서 스텝이 끝나 1키만 친다 — 표본 분모(10키)에
        // 못 미쳐 줄이 0건이 된다(실측: 드라이버 200키→정확히 20줄). 전문이 에코될 때까지 쳐서
        // 최소 1표본을 보장한다.
        until: screen => screen.includes(TYPED),
      }],
      quitKeys: '\x11',
      ...(evidence ? { artifactPath: join(evidence, 'next-input-lag-minim5.json') } : {}),
    });
    expect(run.frames[0]!.screen).toContain('❯ '); // 부트는 next TUI 프롬프트여야 한다.
    expect(run.frames[1]!.screen).toContain('가'); // 첫 키 에코가 화면에 칠혔다 = 칠 경로가 살아 있다.
    // 본 단언 — 등록 배선이 살아 있으면 격리 로그에 측정 줄이 남는다(0건이면 등록이 끊긴 것).
    const lines = readInputLagLines(root);
    expect(lines.length).toBeGreaterThanOrEqual(1); // 출처: #39583 최소 표본 단언(등록 배선 생존 검사) — 0이면 등록이 끊긴 것
    // 로그 줄 계약: 측정 필드는 "data" 안에 중첩된다({"event":"measured","data":{"phase":…}}).
    const keystroke = lines
      .map(l => (l['data'] && typeof l['data'] === 'object' ? l['data'] : l) as Record<string, unknown>)
      .find(d => d['phase'] === 'keystroke');
    expect(keystroke).toBeDefined();
    expect(typeof keystroke!['keyToPaintMs']).toBe('number');
    expect(keystroke!['loopDelayMs']).toMatchObject({ p99: expect.any(Number), max: expect.any(Number) });
    expect(typeof keystroke!['busy']).toBe('boolean');
    expect(typeof keystroke!['sampled']).toBe('number');
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 45_000); // entry-now-latency-pty.test.ts 와 같은 라이브 PTY 시험 상한.
