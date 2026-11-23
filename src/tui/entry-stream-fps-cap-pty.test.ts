// ⌨️ TUI-NEXT-KEYSTROKE-COST PR-2 — 스트리밍 칠 60fps 프레임 상한 (OP #132091).
// 실패-먼저: fake-llm 이 3자 델타를 2ms 간격(500fps 도착)으로 흘리면 busy 창(제출 칠~종결 칠)
// 사이의 다시 칠(행 재작성 `\x1b[2K` 포함 출력)은 60fps 프레임 창(16.7ms)을 지켜야 한다.
// 상한이 없으면 서로 다른 칠 트리거(델타 미리보기·250ms 턴 타이머·상태줄)가 한 프레임 안에
// 겹친다 — 합성 실측(node-b · /tmp/fps-diag3-out.log): 최소 간격 2.8ms·8ms.
// 경계 단언: 가짜 공급자는 델타 도착률만 조절한다 — 칠 경로는 제품 그대로이고 상한은 실제
// render() 플러시에 적용된다(시험이 운영보다 관대하지 않다).
// 정적 bun:test 임포트(changed-tsc 처방 — 게이트 r1 RED 179120f145 · TS2593/TS2304 4건 · 출처: #132091):
// test/expect 전역은 임포트 없이는 tsc 전 범위 검사에서 미해결 이름이다.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const REPLY = 'FPS-CAP-BURST-' + 'x'.repeat(464) + '-END99'; // 484자 — est 경계 다수 유도 (출처: #132091)
const TAIL = 'END99';
const SAMPLES = 5; // 부팅 표본 5 — 칠 충돌은 위상 의존이므로 표본을 모은다 (출처: #132091)
const FRAME_ASSERT_MS = 11; // 한 프레임(16.7ms=1000/60)에서 청크 도착·타이머 지터 여유 5.7ms를 뺀 하한 (출처: #132091)

type SampleResult = { settled: boolean; gaps: number[] };

async function runOnce(): Promise<SampleResult> {
  const root = mkdtempSync(join(tmpdir(), 'next-stream-fps-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const outputs: { text: string; at: number }[] = [];
    await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20',
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: REPLY,
        ELANOUS_TEST_FAKE_LLM_CHUNK_SIZE: '3', // 델타 3자 — 도착 밀도 상승 (출처: #132091)
        ELANOUS_TEST_FAKE_LLM_CHUNK_DELAY_MS: '2', // 2ms 간격 = 실시간 도착(몰아내기 아님) (출처: #132091)
      },
      onOutput: (chunk: string, atMs: number) => { outputs.push({ text: chunk, at: atMs }); },
      ready: { label: 'boot', until: (screen: string) => screen.includes('❯ ') && screen.includes('Ctrl+Q') },
      steps: [{ label: 'burst settled', text: '스트리밍 칠 상한 측정용 한 줄', until: (s: string) => s.includes(TAIL) }],
    });
    const submitIdx = outputs.findIndex((o) => o.text.includes('\x1b[1m>'));
    const settleIdx = outputs.findIndex((o) => o.text.includes(TAIL));
    if (submitIdx < 0 || settleIdx <= submitIdx) return { settled: false, gaps: [] };
    const repaintAt: number[] = [];
    for (let i = submitIdx + 1; i < settleIdx; i += 1) {
      if (outputs[i]!.text.includes('\x1b[2K')) repaintAt.push(outputs[i]!.at); // 행 재작성 = 다시 칠(커서 점멸 제외)
    }
    const gaps: number[] = [];
    for (let i = 1; i < repaintAt.length; i += 1) gaps.push(repaintAt[i]! - repaintAt[i - 1]!);
    return { settled: true, gaps };
  } finally {
    // 정적 rmSync(interference-ratchet 처방 계열 — 시험 본문 안 동적 import 제거 · 출처: #132091)
    rmSync(root, { recursive: true, force: true });
  }
}

test('next TUI caps streaming repaints at the 60fps frame window while the reply bursts', async () => {
  const gaps: number[] = [];
  for (let s = 0; s < SAMPLES; s += 1) {
    const sample = await runOnce();
    expect(sample.settled).toBe(true); // 종결 칠 관측 — 응답 전문이 온전히 칠해진다
    gaps.push(...sample.gaps);
  }
  expect(gaps.length).toBeGreaterThanOrEqual(SAMPLES); // busy 창 칠이 관측돼야 한다(공허 통과 방지)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FRAME_ASSERT_MS); // 한 프레임에 두 칠 금지 — 60fps 상한
}, 100_000); // 표본 5부팅 × ~4s + 여유 (출처: #132091)
