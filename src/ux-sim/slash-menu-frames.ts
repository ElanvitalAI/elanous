// ── 슬래시 메뉴 프레임 시뮬레이터 — 「«/» 뒤 타이핑·↑↓ 가 터미널에 무엇을 쓰나」 ──────
//
// ⛔⭐⭐⭐ 흉내 내지 않는다(MANUAL-ux-simulation-devices §2): 진짜 `textInput` 이 진짜
//   `DisplayCoordinator` 를 modalSink·cursorSink 로 받고, 그 조율자의 onRender 가 진짜
//   `tui.render()` 를 부른다 — 대시보드 `drawNow` 가 하는 일(바탕 줄 ⊕ 모달 오버레이를 한 번에
//   flush, `request.force` 를 그대로 전달)과 같은 배선이다. 바깥에서 바꾸는 것은 «키 공급»과
//   «stdout 포획»뿐이다.
//
// 재는 것: 키 하나마다 화면 «전체»를 지우는 바이트(`\x1b[1;1H\x1b[J` · `\x1b[2J`)가 나갔나,
//   그리고 줄 몇 개를 다시 썼나. 전체 지움 ⇒ 사람 눈에는 화면 전체가 깜빡인다
//   (TUI-SLASH-FLICKER · 2026-10-09).
//
// ⛔ 이 장치는 「그 배선이 실제 대시보드 실행 경로에 있나」는 못 답한다 — 그건 라이브의 몫.

import { textInput, type SlashCommand } from '../chat/index.js';
import { DisplayCoordinator } from '../display/coordinator.js';
import { renderModalStack } from '../display/modal-stack.js';
import { ansi, invalidateRenderCacheRow, render, resetRenderCache, splitKeys, type Key } from '../tui.js';

export interface SlashMenuSimSpec {
  /** «/» 뒤에 칠 글자들(«/» 자체는 장치가 먼저 친다). */
  typed: string;
  /** 타이핑 «뒤»에 누를 화살표. */
  arrows?: ReadonlyArray<'up' | 'down'>;
  /** 슬래시 카탈로그 — 생략하면 textInput 기본 카탈로그. */
  commands?: SlashCommand[];
  /** 마지막 키. 기본 `escape`(취소). `enter` 면 고른 줄이 제출되는지 본다. */
  finish?: 'escape' | 'enter';
}

export interface SlashMenuSimFrame {
  /** 이 프레임을 낳은 키(사람 표기). */
  key: string;
  /** 이 키 이후 다음 키 전까지 stdout 으로 나간 바이트. */
  bytes: string;
  /** 화면 전체 지움 횟수. */
  fullClears: number;
  /** 바탕 프레임이 다시 쓴 줄 수(`CSI r;1H` ⊕ `CSI 2K`). */
  rowsRewritten: number;
}

export interface SlashMenuSimResult {
  frames: SlashMenuSimFrame[];
  /** 전 프레임 합. ⭐ 0 이어야 한다. */
  fullClears: number;
  /** 입력이 끝났을 때의 결과. */
  finalText: string;
  submitted: boolean;
}

const SIM_ROWS = 24;
const SIM_COLS = 80;

/** 화면 «전체»를 지우는 두 형태. tui.render(force) 는 앞의 것을 낸다. */
export function countFullScreenClears(bytes: string): number {
  const homeEraseDown = ansi.moveTo(1, 1) + ansi.eraseDown;
  return bytes.split(homeEraseDown).length - 1 + (bytes.split('\x1b[2J').length - 1);
}

function countRowRewrites(bytes: string): number {
  // tui.render 는 바뀐 줄마다 `CSI r;1H` + `CSI 2K` 를 쓴다.
  return (bytes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length;
}

function keyOf(raw: string): Key {
  const [key] = splitKeys(raw);
  if (!key) throw new Error(`slash-menu sim: cannot parse key ${JSON.stringify(raw)}`);
  return key;
}

export async function simSlashMenuFrames(spec: SlashMenuSimSpec): Promise<SlashMenuSimResult> {
  const rows = SIM_ROWS;
  const cols = SIM_COLS;
  const inputRow = rows - 1;
  const base = Array.from({ length: rows }, (_, i) => `log line ${i + 1}`.padEnd(cols, ' '));

  const pending: Array<() => void> = [];
  const repaintHandle: { repaint: () => void } = { repaint: () => {} };
  const display = new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn) => { pending.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
    termSize: () => ({ rows, cols }),
    invalidateRow: (row0) => invalidateRenderCacheRow(row0),
    // 대시보드 drawNow 와 같은 모양: 바탕 줄 ⊕ 조율자 모달 오버레이를 한 번에, force 는 그대로.
    onRender: (request, snapshot) => {
      render(base, {
        force: request.force,
        overlay: renderModalStack({ surfaces: snapshot.surfaces, focusStack: snapshot.focus.stack }),
      });
    },
    hooks: { afterRender: () => { repaintHandle.repaint(); } },
    writeOverlay: (s) => { process.stdout.write(s); },
    writeCursor: (s) => { process.stdout.write(s); },
  });

  const script: Array<{ label: string; raw: string }> = [
    { label: '/', raw: '/' },
    ...[...spec.typed].map((ch) => ({ label: ch, raw: ch })),
    ...(spec.arrows ?? []).map((a) => ({ label: a === 'down' ? '↓' : '↑', raw: a === 'down' ? '\x1b[B' : '\x1b[A' })),
    spec.finish === 'enter' ? { label: 'enter', raw: '\r' } : { label: 'esc', raw: '\x1b' },
  ];

  const frames: SlashMenuSimFrame[] = [];
  let chunks: string[] = [];
  let currentLabel: string | null = null;
  const realWrite = process.stdout.write.bind(process.stdout);
  const drain = (): void => {
    // 조율자 프레임은 다음 키 전에 전부 흘린다(16ms 배치가 키 사이에 도는 실제와 같다).
    for (let guard = 0; pending.length > 0 && guard < 50; guard++) pending.shift()!();
  };
  const closeFrame = (): void => {
    drain();
    if (currentLabel !== null) {
      const bytes = chunks.join('');
      frames.push({
        key: currentLabel,
        bytes,
        fullClears: countFullScreenClears(bytes),
        rowsRewritten: countRowRewrites(bytes),
      });
    }
    chunks = [];
  };

  resetRenderCache();
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  let finalText = '';
  let submitted = false;
  try {
    // 첫 화면(캐시가 비어 있으니 전체 그리기가 정상) — 측정 밖.
    render(base);
    chunks = [];
    const result = await textInput({
      row: inputRow,
      col: 1,
      width: cols,
      ...(spec.commands ? { commands: spec.commands } : {}),
      modalSink: display,
      cursorSink: display,
      controlOut: repaintHandle,
      readKey: async () => {
        closeFrame();
        const next = script.shift();
        if (!next) {
          currentLabel = null;
          return keyOf('\x1b');
        }
        currentLabel = next.label;
        return keyOf(next.raw);
      },
    });
    closeFrame();
    finalText = result.text;
    submitted = result.submitted;
  } finally {
    process.stdout.write = realWrite as typeof process.stdout.write;
    resetRenderCache();
  }
  return {
    frames,
    fullClears: frames.reduce((n, f) => n + f.fullClears, 0),
    finalText,
    submitted,
  };
}
