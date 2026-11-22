// ELS-IME-HANGUL-COMPOSE — 조합 바이트 조각 보존 (출처: seat-state/OP/PLAN-OP-TYPING-1122.md 행 9 · OP 증상 «한글 자모 흩어짐»).
// E2E 증명: real els server + real /bin/sh pane + real `els attach` client 아래, OP 측정법 그대로(«120ms 간격» 낱자 소거 입력)가
// 화면에 조합·순서 그대로 도달해야 한다 — 자모 흩어짐·U+FFFD·순서 뒤섞임 금지. 낱 chunk 는 IME commit 단위(완성 음절)다.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 한 글자(=IME commit 단위: 완성 음절 또는 ascii 1자)씩 120ms 간격으로 — OP 측정 방법 고정(PLAN-OP-TYPING-1122.md 마지막 줄). */
function keystrokes(text: string): string[] {
  return Array.from(text).map((ch) => ch);
}

test('real terminal: Hangul typed keystroke-by-keystroke (120ms) through els attach arrives composed, ordered, no U+FFFD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 80,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      {
        // 23개 낱타(500타/분 상당): 목숨 있는 경로 전부(attach stdin → StringDecoder → prefix → 소켓 input → core.input → pty.write
        // → 셸 행규칙 에코 → 에뮬레이터 stream decode → 화면 diff → attach 뷰 재구성)를 한 번에 통과시킨다.
        label: 'hangul-composed',
        chunks: [...keystrokes('echo 한글조각$((20+22))보존'), '\r'],
        gapMs: 120,
        until: (screen) => screen.split('\n').some((line) => line.startsWith('한글조각42보존')),
        timeoutMs: 20_000, // 출처: #39555 낱타 23×120ms ≈ 2.8s + 셸 eval 여유 — 합동 실측 5.05s, 적재 호스트 대비 상한
      },
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  const final = run.frames.at(-1)!.screen;
  // (1) 셸 출력: 조합 음절 그대로·순서 그대로
  expect(final).toContain('한글조각42보존');
  // (2) 붕괴 금지: 조각·경계 흔적(U+FFFD)이 화면 어디에도 없어야 한다
  expect(final).not.toContain('\uFFFD');
  // (3) 흩어짐 금지: 입력 줄 자체도 조합 상태로 에코됐다(낱자모 뿌려짐이 아니라)
  expect(final).toContain('echo 한글조각$((20+22))보존');
}, 90_000);
