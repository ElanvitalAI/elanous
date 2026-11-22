// ELS-IME-HANGUL-COMPOSE 종단 시험 (출처: OP #129054 결정 · JUD-B #129053 요구 — E1·E4·E5 보강).
// 요구 원문: «시험 우주 els 서버 + 실 PTY + attach 에 «ㅎ ㅏ ㄴ» 분할 바이트·빠른 연타 50자 → 화면 캡처
// 완성 음절·유실 0 · 원문 영수(mbp/node-b)».
// E1(분할 바이트): 완성 음절의 UTF-8 3바이트를 1바이트씩 분할해 주입 — ㅎ(U+315C)=E3 85 9C, ㅏ(U+315F)=E3 85 9F,
//                  ㄴ(U+3134)=E3 84 B4. «한» 전체(U+D55C=ED 95 9C)도 분할해 완성 음절 경로를 함께 통과시킨다.
// E4(빠른 연타): 50자를 gapMs=1(사실상 동시)로 주입 — 흩어짐·유실 0.
// E5(원문 영수): mockSeatPtySequence evidence JSON(화면 프레임 원문)을 evidence/ 디렉터리에 저장.
// ⛔ 장치 전용: TUI 를 재구현하지 않는다 — mockSeatPtySequence 그대로 사용.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const cleanups: (() => Promise<void> | void)[] = [];
/** afterEach 정리 — cleanups 전량 실행(런너 자격 process.env 원복 포함). 이름이 env 원복을 말해
 *  정리 짝으로 인식된다(출처: r12·r13 게이트 interference-ratchet RED · RES/evidence/PREGATE-RED/39576-331ca37b35-*
 *  · JUD-B #130472 red.tar 재확인 — 이 파일 시험 1·2·3 의 자격 변수 조작이 전부 이 afterEach 를 통해
 *  원복된다 · TEST-INTERFERENCE-RATCHET env-without-restore). */
async function runCleanupsAndRestoreEnv(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
afterEach(runCleanupsAndRestoreEnv);

/** UTF-8 바이트를 1바이트씩 분할한 chunk 배열 — Uint8Array 로 전달해야 PTY write 가 바이트를
 *  그대로 흘려보낸다(문자열이면 재인코딩된다). 장치(N03)의 바이트 충실 경로 사용. */
function splitBytes(s: string): Uint8Array[] {
  const bytes = Buffer.from(s, 'utf8');
  return Array.from(bytes, (b) => new Uint8Array([b]));
}

test('e2e: complete-syllable UTF-8 fragment reassembly + 50-char burst through els attach → zero loss, raw evidence (완성 음절 조각 복원+낱타 한정 표기 · OP #130281)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-e2e-hangul-split-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  // 출처: #39561 requestEls paneAuth — 러너(좌석 TUI)의 실제 ELANOUS_ELS_PANE_TOKEN/ELANOUS_ELS_OWNER_TOKEN이
  // 이 시험 우주 서버에 제시되면 강화 auth가 «malformed answer»로 즉사한다(실측 22.84ms). 두 자격 변수를 지우고 끝나면 원복한다.
  const savedPaneToken = process.env.ELANOUS_ELS_PANE_TOKEN;
  const savedOwnerToken = process.env.ELANOUS_ELS_OWNER_TOKEN;
  delete process.env.ELANOUS_ELS_PANE_TOKEN;
  delete process.env.ELANOUS_ELS_OWNER_TOKEN;
  cleanups.push(() => {
    if (savedPaneToken === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = savedPaneToken;
    if (savedOwnerToken === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = savedOwnerToken;
  });
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });

  const burst50 = '가갸거겨고교구규그기나냐너녀노뇨누뉴느니다댜더뎌도됴두듀드라랴러려로료루류르며머며모묘무뮤므바뱌버벼';  // 50자
  if (burst50.length !== 50) throw new Error(`burst fixture must be 50 chars, got ${burst50.length}`);

  const evidenceDir = join(root, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  // E5(원문 영수): root 밖 경로 — afterEach 가 root 를 지워도 화면 프레임 원문이 살아남는다.
  const artifactPath = join(tmpdir(), `els-e2e-hangul-split-${Date.now()}.json`);

  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 220,  // 50자 한글 연타(너비 100) + 셸 프롬프트·에코 여유 — 줄바꿈으로 흩어짐 판정이 흐려지지 않게 충분히 넓게
    artifactPath,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      {
        // E1: «ㅎ ㅏ ㄴ» 자모 + «한» — UTF-8 3바이트를 1바이트씩 분할 주입.
        // latin1 chunk 는 PTY write 가 바이트 그대로 흘려보내므로, 수신측 디코드가 조립해야 한다.
        label: 'byte-split-jamo',
        chunks: [...splitBytes('ㅎ'), ...splitBytes('ㅏ'), ...splitBytes('ㄴ'), ...splitBytes(' '), ...splitBytes('한')],
        gapMs: 1,
        until: (screen) => screen.includes('ㅎㅏㄴ 한'),
        timeoutMs: 15_000, // 출처: #39555 실측 첫 에코 ~2s + 분할 12chunk 여유
      },
      {
        label: 'byte-split-enter',
        chunks: ['\r'],
        // 셸 반응(명령 실행) 원문 — «ㅎㅏㄴ» 을 명령으로 실행한 오류 메시지가 화면에 뜬다.
        until: (screen) => screen.includes('command not found') && screen.includes('ㅎㅏㄴ'),
        timeoutMs: 10_000,
      },
      {
        // E4: 50자 연타 — 50개 «개별 키» chunk 를 gapMs=1 간격으로 주입(출처: OP #129462 — 단일 대량 쓰기가 아니라
        // 대표 분당 500타 실입력 꼴의 낱타). 흩어짐·유실 0.
        label: 'burst-50-enter',
        chunks: [...Array.from(burst50, (c) => c as string), '\r'],
        gapMs: 1,
        until: (screen) => screen.split('\n').some((l) => l.includes(burst50.slice(0, 20)) && l.includes(burst50.slice(-5))),
        timeoutMs: 15_000,
      },
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  // E5: 원문 영수 — evidence JSON 이 실제 기록됐는지(화면 프레임 원문 포함).
  expect(existsSync(artifactPath)).toBe(true);
  const rawEvidence = JSON.parse(readFileSync(artifactPath, 'utf8')) as { frames: { screen: string }[] };
  expect(rawEvidence.frames.length).toBeGreaterThanOrEqual(4); // ready + 3 steps
  const final = run.frames.at(-1)!.screen;
  // (1) 완성 음절(IME 조합 커밋 바이트) 도달 — 분할된 완성 음절 UTF-8 조각이 수신 디코드에서 조립돼
  // 화면에 그대로 도달했다. 한글 «조합 완성»(자모→음절 생성) 자체는 OS IME 의 몫이라 els 는 커밋된
  // 바이트의 조립만 담당 — 이 시험의 완료선은 «완성 음절 UTF-8 조각 복원 + 50 낱타» 로 한정된다
  // (출처: OP #130281 한정 표기 · JUD-C #130275 범위 한정 승인 · composer fixture 시험은 OP #130684 로 이 PR 에서 제거 → FU ELS-PTY-WRITE-BYTES-FU).
  expect(final).toContain('ㅎㅏㄴ 한');
  // (2) 유실 0 — 50자 전부 도달.
  expect(final).toContain(burst50);
  // (3) 붕괴 금지 — U+FFFD 가 화면 어디에도 없어야 한다.
  expect(final).not.toContain(String.fromCharCode(0xFFFD)); // 실제 문자 U+FFFD 검사 (출처: OP #129776 ① · JUD-C #129771) — 이스케이프 해석 여지 원천 차단
  // (4) 흩어짐 금지 — 50자가 한 줄 안에 머리·꼬리 순서 그대로(중간 삽입·뒤섞임 없이) 도달했다.
  const burstLine = final.split('\n').find((l) => l.includes(burst50.slice(0, 20))) ?? '';
  expect(burstLine).toContain(burst50.slice(0, 20));
  expect(burstLine.indexOf(burst50.slice(0, 20))).toBeLessThanOrEqual(burstLine.indexOf(burst50.slice(-5)));
  expect(burstLine.includes(burst50.slice(-5))).toBe(true);
}, 120_000);

// 음성 회귀(출처: OP #129776 ②): 일부러 잘린 UTF-8 바이트(«한» 앞 2바이트 ED 95 뒤 비지속 'B')를 attach 에
// 넣으면 실제 U+FFFD 가 «화면에» 생겨야 한다 — 위 (3) not.toContain(U+FFFD) 금지가 깨진 화면을 실제로 잡는다는
// 검출 방향 증명. 조용히 사라지면(유실) 이 시험도 빨강이다. 첫 시험과 별도 우주(서버·pane)에서 돈다.
test('e2e negative control: deliberately truncated UTF-8 → real U+FFFD visible on attach screen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-e2e-hangul-ufffd-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  // 출처: #39561 requestEls paneAuth — 러너의 실제 자격 변수 제거/원복(첫 시험과 동일 규칙).
  const savedPaneToken = process.env.ELANOUS_ELS_PANE_TOKEN;
  const savedOwnerToken = process.env.ELANOUS_ELS_OWNER_TOKEN;
  delete process.env.ELANOUS_ELS_PANE_TOKEN;
  delete process.env.ELANOUS_ELS_OWNER_TOKEN;
  cleanups.push(() => {
    if (savedPaneToken === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = savedPaneToken;
    if (savedOwnerToken === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = savedOwnerToken;
  });
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });

  const artifactPath = join(tmpdir(), `els-e2e-hangul-ufffd-${Date.now()}.json`);
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 220,
    artifactPath,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      {
        // 잘린 «한» 앞 2바이트(ED 95) 뒤 비지속 바이트 'B'(0x42) — 스트림 디코드가 붕괴를 실제 U+FFFD 로 드러낸다.
        label: 'truncated-utf8',
        chunks: [new Uint8Array([0xed, 0x95]), new Uint8Array([0x42])],
        gapMs: 1,
        until: (screen) => screen.includes(String.fromCharCode(0xFFFD)),
        timeoutMs: 15_000,
      },
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  const final = run.frames.at(-1)!.screen;
  // 실제 U+FFFD 화면 관측 — not.toContain(U+FFFD) 금지가 깨진 화면에서 빨강이 된다는 검출 방향 증명.
  expect(final).toContain(String.fromCharCode(0xFFFD));
  expect(existsSync(artifactPath)).toBe(true); // 원문 영수(화면 프레임 원문) 저장 규칙 동일 적용
}, 120_000);

// composer fixture 종단 시험(자모→생성 «한» · fixtures/hangul-compose-echo.ts 포함)은 OP #130604/#130684
// 계약 변경으로 이 PR 에서 제거 — FU ELS-PTY-WRITE-BYTES-FU 로 이관한다(원문은 git history 보존).
