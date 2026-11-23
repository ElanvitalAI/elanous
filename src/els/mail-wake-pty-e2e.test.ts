// ELS-CODEX-SEAT-MAIL-WAKE — 시험 우주 종단 1개 (JUD-C HOLD 필수 1 · OP #132782):
// 실 els 서버(실 PTY spawn) + 실 우편 원장(MsgStore) + 실 watcher(server 가 :1477 에 배선) —
// sendVerified 고정 반환 금지: 진짜 core.sendVerified 가 진짜 PTY 에 쓴다.
//
// 장치(#39666 PTY 종단과 같은 결): 실 PTY 팬 하나에 가짜 codex 자식(프롬프트 ❯ · bracketed paste
// DECSET 2004 켬 · 입력이 오면 «turn started · Working (esc to interrupt)» 를 찍는 작은 스크립트)을
// 띄우고, 실 우편 원장에 msg post → 실 fs.watch 원장 구독 → 실 watcher 확인 회차 → 노크 →
// 자식 화면에서 턴 시작을 sendVerified 바깥에서도 독립 관측한다. 완수선: 노크 뒤
// MAIL_WAKE_WITHIN_MS(60 s) 안에 턴 시작. 실 codex CLI 실측은 -LIVE(이 가짜가 칸이 정한 대리).
//
// 홀더 간접 우회 주입(게이트 r1/r2 RED 수리): 제품 holderPty(src/els/holder.ts)는
// Bun.spawn([process.execPath, holder-main.ts …]) 로 홀더를 뜨는데, 게이트(hq-find-guard)
// 중호기 bun 래퍼의 안전 경로는 `/usr/bin/env -i` + 임시 HOME 로 돌아가 — 래퍼 자신의
// `$HOME/.bun/bin/bun` 해석(래퍼 첫머리)이 임시 홈을 보고 실패해 홀더가 exit 127 로 즉사한다
// (빈 화면·state=exited — PREGATE-RED 39676 r1/r2 원문 그대로; 재현: 같은 HEAD·같은 node-b
// 에서 일반 bun 1 pass, 중호기 bun 0 pass 1 fail). 홀더 간접(D1a)은 이 칸(OP #132782)의
// 관찰 대상이 아니므로 서버의 공식 spawn 의존 주입(src/els/server.ts ElsServerOptions.spawn)
// 으로 실 startPty(실 node-pty PTY)를 팬에 붙인다 — 칸이 요구한 실 요소(PTY·원장·
// watcher·노크·자식 화면)는 전부 그대로, 제품 변경 0.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_WAKE_LINE, MAIL_WAKE_WITHIN_MS } from './mail-wake-watcher.js';
import { MsgStore } from '../msg/msg-store.js';
import { startElsServer } from './server.js';
import { startPty } from '../pty-shell/registry.js';
import type { ElsPty } from './core.js';
import { processStartStamp } from './peer-seat.js';

// A Unix socket path holds at most 103 bytes (macOS) — same rule as the neighbouring els tests.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const SEAT = 'CX1';

/** 실 PTY 팬 — 서버의 공식 spawn 주입 계약(src/els/server.ts ElsServerOptions.spawn)을
 *  실 startPty(실 node-pty PTY)로 이행한다. 홀더 간접(D1a)만 우회(위 주석), 나머지 전부 실물. */
const spawnRealPty = (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>): ElsPty => {
  const handle = startPty({
    cmd: command[0]!, args: command.slice(1), kind: 'shell', nickname: title,
    workdir: cwd, purpose: 'els-pane-test', env: { ...env },
  });
  // seatBindings()(core)은 pty.processBinding({pid,generation,start})이 있는 팬만 노출한다 — 홀더 팬은
  // 홀더 프로세스 신원을 묶고(holder.ts:812 {pid, generation=PTY id, start}), 이 서버 주입 팬의 홀더는
  // 서버 프로세스 자신이므로 같은 계약을 묶는다. 4차 수리(3차 e2f3b49 RED 원인): processIdentity 는 제어
  // tty·session·플래그 조건(peer-seat.ts:47)을 요구하는데 ssh 로 돈 bun test 서버 프로세스는 데몬이라
  // (제어 tty 없음 → tty=NODEV) 항상 undefined → processBinding 미배선 → seatBindings=빈 → 노크 0회·
  // 로그 0줄·영수 0행(node-b e2f3b49 0 pass 1 fail [62.42s] · receiptLine undefined). 제품의 데몬 시작시각
  // 원천(OP #129232 보안 HOLD 수리) processStartStamp — tty·session 조건 없는 proc_pidinfo sec:usec —
  // 로 start 를 묶는다. 홀더가 정확히 이것으로 묶는다(holder.ts:42). generation = 레지스트리 PTY id.
  const start = processStartStamp(process.pid);
  return {
    id: handle.id,
    isAlive: () => handle.isAlive(),
    write: (text: string) => handle.write(text),
    writeAll: (text: string) => handle.writeAll(text),
    bracketedPasteEnabled: () => handle.bracketedPasteEnabled(),
    renderScreen: (options?: { readonly ansi?: boolean; readonly scrollBack?: number }) => handle.renderScreen(options),
    onExit: (cb: () => void) => { void handle.onExit(cb); },
    kill: () => handle.kill(),
    resize: (cols: number, rows: number) => handle.resize(cols, rows),
    lastOutputAt: () => handle.lastOutputAt,
    ...(start !== undefined ? { processBinding: { pid: process.pid, generation: handle.id, start } } : {}),
  };
};

test('mail wake on a real PTY: a real ledger post knocks the codex seat and the child screen shows the turn start', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'mailwake-pty-'));
  let closeServer: (() => Promise<void>) | undefined;
  try {
    // (1) 실 우편 원장 — 이 격리 루트에 MsgStore 가 만들고 post 한다.
    const ledgerPath = join(root, 'msg', 'messages.db');
    mkdirSync(join(root, 'msg'), { recursive: true });
    const store = new MsgStore(ledgerPath);
    // (2) codex runtime 자리 레지스트리 v2 — 실 readSeatRegistryV2 가 읽는 형태 그대로.
    writeFileSync(join(root, 'seat-registry.json'), JSON.stringify({
      version: 2, seats: [{ address: SEAT, runtime: 'codex', label: 'fake codex seat' }],
    }));
    // (3) 가짜 codex 자식: 프롬프트 + bracketed paste(DECSET 2004)를 켜고(실 PTY 의
    //     term.modes.bracketedPasteMode 가 이 출력을 추적 — registry.ts bracketedPasteEnabled),
    //     입력이 오면 «turn started» 와 working 마커(esc to interrupt)를 찍는다.
    //     sendVerified 의 실 확인 루프가 이 화면에서 턴 시작을 본다(core.ts turnStarted).
    const child = join(root, 'fake-codex.sh');
    writeFileSync(child, [
      '#!/bin/sh',
      // /bin/sh 스크립트 — 게이트 r1 RED(게이트 중호기 bun 실행파일 자식이 화면 30초 공백) 수리:
      // 실행파일 의존을 없애고 셸 표준출력만으로 프롬프트·DECSET 2004·턴 시작을 그린다.
      "printf 'fake codex seat\\n'",
      "printf '\\033[?2004h'",
      "printf '❯ '",
      'IFS= read -r _line',
      "printf '\\r\\nturn started · Working (esc to interrupt)\\r\\n❯ '",
      'while IFS= read -r _line; do :; done',
      '',
    ].join('\n'));
    // (4) 실 서버 — spawn 주입: 실 startPty PTY 팬(위 spawnRealPty 주석 · 게이트 중호기
    //     홀더 exit 127 우회). mailWake deps 로 격리 원장/레지스트리 루트/영수 경로만.
    const receiptsPath = join(root, 'els', 'mail-wake.jsonl');
    const started = await startElsServer({
      stateRoot: join(root, 'els'),
      spawn: spawnRealPty,
      mailWake: { ledgerPath, seatStateRoot: root, receiptsPath },
    });
    if ('exitCode' in started) throw new Error(`server did not start: ${started.message}`);
    closeServer = started.close;
    // (5) 실 PTY 팬 — ownerSeat 로 자리에 묶는다(seatBindings 이 이것을 돌려준다).
    const made = started.core.newPane({ ws: 'w', cwd: root, command: ['/bin/sh', child], ownerSeat: SEAT });
    if (made.exitCode !== 0) throw new Error(`newPane: ${made.message}`);
    const pane = (JSON.parse(made.message) as { pane: string }).pane;
    // (6) 부팅 대기 — 실 read 로 프롬프트가 뜰 때까지 본다(30 s 상한).
    const bootDeadline = Date.now() + 30_000;
    let screen = '';
    while (Date.now() < bootDeadline) {
      const read = await started.core.read(pane);
      if (read.exitCode === 0) screen = read.message;
      if (screen.includes('❯')) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (!screen.includes('❯')) {
      const st = await started.core.status(pane);
      throw new Error(`fake codex prompt not visible in 30 s — status=${st.message} screen=${JSON.stringify(screen.slice(0, 400))}`);
    }
    expect(screen).toContain('❯');
    expect(JSON.parse((await started.core.status(pane)).message)).toMatchObject({ state: 'idle', inputEmpty: true });
    // (7) 실 msg post — 원장 기록 변화 → 실 fs.watch → 실 watcher 확인 회차 → 노크.
    const postedAt = Date.now();
    const message = store.post({ from: 'OP', to: SEAT, body: 'mail wake e2e — 실 원장 우편 1통' });
    expect(message.id).toBeGreaterThan(0);
    // (8) 완수선 — 노크 뒤 MAIL_WAKE_WITHIN_MS(60 s) 안에: 실 watcher 영수(turn-started)와
    //     자식 화면의 턴 시작을 독립 관측한다(sendVerified 반환값 아닌 화면·영수 원문).
    let receiptLine: Record<string, unknown> | undefined;
    const deadline = postedAt + MAIL_WAKE_WITHIN_MS;
    while (Date.now() < deadline) {
      if (existsSync(receiptsPath)) {
        const lines = readFileSync(receiptsPath, 'utf8').trim().split('\n').filter((line) => line !== '');
        receiptLine = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((line) => line.seat === SEAT && line.result === 'turn-started');
        if (receiptLine !== undefined) break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    expect(receiptLine).toBeDefined();
    if (receiptLine === undefined) throw new Error('no turn-started receipt within MAIL_WAKE_WITHIN_MS');
    expect(receiptLine.pane).toBe(pane);
    expect(receiptLine.line).toBe(MAIL_WAKE_LINE);
    const observedAt = Date.now();
    expect(observedAt - postedAt).toBeLessThanOrEqual(MAIL_WAKE_WITHIN_MS);
    // 독립 관측: 자식 화면(실 renderScreen)에 턴 시작이 찍혀 있다.
    const after = await started.core.read(pane);
    expect(after.exitCode).toBe(0);
    expect(after.message).toContain('turn started');
    // (9) 같은 우편은 두 번 노크하지 않는다(에피소드 원칙 1회) — 영수는 이 테스트에서 정확히 1줄.
    const allLines = existsSync(receiptsPath)
      ? readFileSync(receiptsPath, 'utf8').trim().split('\n').filter((line) => line !== '')
      : [];
    expect(allLines.filter((line) => (JSON.parse(line) as Record<string, unknown>).result === 'turn-started')).toHaveLength(1);
  } finally {
    await closeServer?.();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);