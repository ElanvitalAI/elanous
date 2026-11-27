import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist, setItem } from '../release-loop/checklist.js';
import { authorizeChecklistGreenSigner, registerReleaseChecklistSetCommand, resolveChecklistWriter } from './release-checklist-set-cli.js';
import { registerHoldCommands } from '../hold-ledger/hold-cli.js';

// CHECKLIST-GREEN-SIGNER-GUARD (OP #133987 · 정정 #134130 · 수리 #134310 ①·②): 체크리스트 칸의 green 전환은
// 판정자 자리(JUD-*·REVIEW-*)·OP 만 — ①(#134310) 서명자 자리는 인증된 출처(els 서버가 패널 자격 — 패널 토큰
// auth — 로 확인한 자리)만 인정한다: ELANOUS_TRACK 환경값은 누구나 export 할 수 있어 권한이 아니고(스푸핑은
// 무시), 확인 실패(els 문맥 없음 · 서버 거부)는 fail-closed 로 green 을 거부한다. ②(#134310) 같은 검사를 원장
// 공통 전환 문(setItemGuarded)에 걸어 다른 명령 경로(ops-ledger ChecklistSet)·직접 호출도 받게 한다.
// 기대값은 칸 계약 원문 리터럴이지 제품 상수로 빚은 값이 아니다(test-expect-independent).

let dir = '';
let oldTrack: string | undefined;
let lines: string[] = [];
let output: ReturnType<typeof spyOn>;
let elsRoot = '';
let elsServer: ReturnType<typeof createServer> | null = null;
const savedEls: Record<string, string | undefined> = {
  ELANOUS_SEAT: undefined,
  ELANOUS_ELS_WS: undefined,
  ELANOUS_ELS_PANE: undefined,
  ELANOUS_ELS_SOCKET: undefined,
  ELANOUS_ELS_PANE_TOKEN: undefined,
  ELANOUS_ELS_OWNER_TOKEN: undefined,
  ELANOUS_ELS_RUNTIME_TOKEN_FILE: undefined,
};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-green-signer-'));
  setElanousConfigDir(dir);
  oldTrack = process.env.ELANOUS_TRACK;
  delete process.env.ELANOUS_TRACK;
  for (const key of Object.keys(savedEls)) {
    savedEls[key] = process.env[key];
    delete process.env[key];
  }
  lines = [];
  output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
});

afterEach(async () => {
  output.mockRestore();
  resetElanousConfigDir();
  if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
  for (const [key, value] of Object.entries(savedEls)) setEnv(key, value);
  if (elsServer !== null) {
    await new Promise<void>((resolve) => elsServer!.close(() => resolve()));
    elsServer = null;
  }
  if (elsRoot !== '') rmSync(elsRoot, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const cmd = new Command();
  cmd.exitOverride();
  registerReleaseChecklistSetCommand(cmd);
  await cmd.parseAsync(['release', 'checklist', 'set', ...args], { from: 'user' });
}

/** ① 의 가짜 els 서버 — 패널 자격 auth 를 받고 ls 답에 내 pane 의 확인 자리를 싣는다(서버가 자리를 확인하는
 *  경로 — requestEls ls — 를 흉내). refuseLs 면 서버가 확인을 거부한다(fail-closed 경로). */
async function serveConfirmedSeat(seat: string | null, refuseLs = false): Promise<void> {
  if (elsServer !== null) {
    await new Promise<void>((resolve) => elsServer!.close(() => resolve()));
    elsServer = null;
  }
  if (elsRoot !== '') rmSync(elsRoot, { recursive: true, force: true });
  elsRoot = mkdtempSync(join(tmpdir(), 'els-green-signer-'));
  const socketPath = join(elsRoot, 'sock');
  elsServer = createServer((peer) => {
    let pending = '';
    peer.on('data', (data: Buffer) => {
      pending += data.toString();
      const parts = pending.split('\n');
      pending = parts.pop()!;
      for (const line of parts) {
        const frame = JSON.parse(line) as { op: string };
        if (frame.op === 'auth') peer.write(`${JSON.stringify({ exitCode: 0, message: 'auth: fixture' })}\n`);
        else if (refuseLs) peer.end(`${JSON.stringify({ exitCode: 1, message: 'fixture: seat unconfirmed' })}\n`);
        else
          peer.end(
            `${JSON.stringify({
              exitCode: 0,
              message: JSON.stringify({ workspaces: [], tabs: [], panes: [{ pane: 'p-fixture', workspace: 'ws-fixture', seat }] }),
            })}\n`,
          );
      }
    });
  });
  await new Promise<void>((resolve) => elsServer!.listen(socketPath, resolve));
  process.env.ELANOUS_ELS_WS = 'ws-fixture';
  process.env.ELANOUS_ELS_PANE = 'p-fixture';
  process.env.ELANOUS_ELS_SOCKET = socketPath;
  process.env.ELANOUS_ELS_PANE_TOKEN = 'fixture-pane-token';
}

/** legacy checklist.json 을 첫 읽기 때 반입시킨다 — release-checklist-bulk-move.test.ts 의 골조 그대로. */
function seed(version: string, ids: string[]): void {
  const folder = join(dir, 'release', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify({ version, released: '0.2.6', dev: '0.2.10-dev.1',
    items: ids.map((id) => ({ id, title: `cell ${id}`, status: 'yellow', owner: 'OP', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' })),
    history: [] }));
  listChecklist(version);
}

const statusOf = (version: string, id: string) => listChecklist(version).items.find((item) => item.id === id)?.status;
const updatedByOf = (version: string, id: string) => listChecklist(version).items.find((item) => item.id === id)?.updatedBy;

test('(a) 판별부 계약: 손 자리·미확인 green 은 영어 문구 거부 · 판정자·OP·비-green 은 허용', () => {
  const refused = authorizeChecklistGreenSigner({ status: 'green', seat: 'HAND-TUI-D' });
  expect(refused.allowed).toBe(false);
  expect(refused.seat).toBe('HAND-TUI-D');
  expect(refused.refuse).toContain('judge-only');
  expect(authorizeChecklistGreenSigner({ status: 'green', seat: 'TA-1' }).allowed).toBe(false);
  expect(authorizeChecklistGreenSigner({ status: 'green', seat: 'JUD-3' }).allowed).toBe(true);
  expect(authorizeChecklistGreenSigner({ status: 'green', seat: 'REVIEW-2' }).allowed).toBe(true);
  expect(authorizeChecklistGreenSigner({ status: 'green', seat: 'OP' }).allowed).toBe(true);
  const unset = authorizeChecklistGreenSigner({ status: 'green', seat: undefined });
  expect(unset.allowed).toBe(false);
  expect(unset.refuse).toBe(
    'green needs a judge seat (JUD*/REVIEW*) or OP — no seat identity found (els pane seat · ELANOUS_TRACK · ELANOUS_SEAT · seats/<SEAT> folder)',
  );
  expect(authorizeChecklistGreenSigner({ status: 'yellow', seat: 'HAND-TUI-D' }).allowed).toBe(true);
});

test('(b) ① 서버 확인 자리가 손이면 env 스푸핑(JUD-3)도 green 거부 — 칸 상태·갱신 주체는 그대로', async () => {
  await serveConfirmedSeat('HAND-TUI-D');
  seed('0.2.9', ['G1', 'OTHER']);
  process.env.ELANOUS_TRACK = 'JUD-3'; // 스푸핑 — 환경값은 권한이 아니다(#134310 ①)
  await expect(run('G1', '--status', 'green', '--version', '0.2.9')).rejects.toThrow('judge-only');
  expect(statusOf('0.2.9', 'G1')).toBe('yellow');
  expect(updatedByOf('0.2.9', 'G1')).toBe('OP');
  expect(lines).toEqual([]);
});

test('(c) ① 서버 확인 판정자(JUD-*·REVIEW-*)·OP 는 종전대로 green 전환 — 확인 자리가 서명자가 된다', async () => {
  seed('0.2.9', ['G1', 'G2', 'G3']);
  await serveConfirmedSeat('JUD-3');
  await run('G1', '--status', 'green', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'G1')).toBe('green');
  expect(updatedByOf('0.2.9', 'G1')).toBe('JUD-3');
  await serveConfirmedSeat('REVIEW-2');
  await run('G2', '--status', 'green', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'G2')).toBe('green');
  await serveConfirmedSeat('OP');
  await run('G3', '--status', 'green', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'G3')).toBe('green');
  expect(lines).toEqual(['✅ G1 갱신', '✅ G2 갱신', '✅ G3 갱신']);
});

test('(d) 손 자리의 비-green 갱신은 종전 동작 — 가드는 green 전환에만 건다', async () => {
  seed('0.2.9', ['Y1']);
  process.env.ELANOUS_TRACK = 'HAND-TUI-D';
  await run('Y1', '--status', 'red', '--evidence', 'measured', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'Y1')).toBe('red');
  expect(lines).toEqual(['✅ Y1 갱신']);
});

test('(e) ① 확인 불가(els 문맥 없음)는 fail-closed 로 green 거부 · 비-green 갱신은 종전 동작', async () => {
  seed('0.2.9', ['A1', 'A2']);
  await expect(run('A1', '--status', 'green', '--version', '0.2.9')).rejects.toThrow('no seat identity found');
  expect(statusOf('0.2.9', 'A1')).toBe('yellow');
  expect(updatedByOf('0.2.9', 'A1')).toBe('OP');
  expect(lines).toEqual([]);
  await run('A2', '--status', 'red', '--evidence', 'measured', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'A2')).toBe('red');
  expect(updatedByOf('0.2.9', 'A2')).toBe('cli');
});

test('(h) CEO 11-23 relaxation: when els cannot confirm, the judge seat in ELANOUS_TRACK may sign green; a hand seat still may not', async () => {
  seed('0.2.9', ['R1', 'R2']);
  await serveConfirmedSeat(null, true);
  process.env.ELANOUS_TRACK = 'JUD-3';
  await run('R1', '--status', 'green', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'R1')).toBe('green');
  process.env.ELANOUS_TRACK = 'HAND-TUI-D';
  await expect(run('R2', '--status', 'green', '--version', '0.2.9')).rejects.toThrow('judge-only');
  expect(statusOf('0.2.9', 'R2')).toBe('yellow');
});

// ── #134310 수리(JUD-2 보안 HOLD 필수 ②): 가드는 CLI 가 아니라 원장 공통 문(setItemGuarded)에 둔다 —
// 다른 명령 경로(skills/tools/ops-ledger ChecklistSet)·직접 호출도 같은 검사를 받는다.
// 허용 집합은 종전 정책의 합집합: 판정자 JUD*·REVIEW*(CLI 가드 #133987) ⊕ OP·OPC(release-cli:1126 판정국 [GREEN-REQ]).
// 기대값은 칸 계약 원문 리터럴이지 제품 상수로 빚은 값이 아니다(test-expect-independent).
test('(f) store 가드(#134310): 손 자리·미설정(cli 폴백) by 의 green 직접 전환은 원장에서 거부 — ops-ledger 경로 폐쇄', () => {
  seed('0.2.9', ['S1', 'S2']);
  expect(() => setItem('0.2.9', 'S1', { status: 'green' }, 'HAND-TUI-D')).toThrow('judge-only');
  expect(statusOf('0.2.9', 'S1')).toBe('yellow');
  expect(updatedByOf('0.2.9', 'S1')).toBe('OP');
  expect(() => setItem('0.2.9', 'S2', { status: 'green' }, 'cli')).toThrow('judge-only');
  expect(statusOf('0.2.9', 'S2')).toBe('yellow');
  expect(lines).toEqual([]);
});

test('(g) store 가드(#134310): 판정자(JUD*·REVIEW*)·OP·OPC by 는 green 허용 · 손 자리 비-green 은 무변동', () => {
  seed('0.2.9', ['S3', 'S4', 'S5', 'S6', 'S7']);
  setItem('0.2.9', 'S3', { status: 'green' }, 'JUD-3');
  expect(statusOf('0.2.9', 'S3')).toBe('green');
  setItem('0.2.9', 'S4', { status: 'green' }, 'REVIEW-2');
  expect(statusOf('0.2.9', 'S4')).toBe('green');
  setItem('0.2.9', 'S5', { status: 'green' }, 'OP');
  expect(statusOf('0.2.9', 'S5')).toBe('green');
  setItem('0.2.9', 'S6', { status: 'green' }, 'OPC');
  expect(statusOf('0.2.9', 'S6')).toBe('green');
  setItem('0.2.9', 'S7', { status: 'red', evidence: 'measured' }, 'HAND-TUI-D');
  expect(statusOf('0.2.9', 'S7')).toBe('red');
});
test('light set leaf: --done / --body / --source write the cell (11-26 22:4x «unknown option --done»)', async () => {
  seed('9.1.1', ['DW-1']);
  process.env.ELANOUS_TRACK = 'OP';
  await run('DW-1', '--done', 'bun test x passes', '--body', 'why it exists', '--source', '#185411', '--version', '9.1.1');
  const item = listChecklist('9.1.1').items.find((i) => i.id === 'DW-1')!;
  expect(item.doneCriterion).toBe('bun test x passes');
  expect(item.body).toBe('why it exists');
  expect(item.source).toBe('#185411');
  await run('DW-1', '--done', '', '--version', '9.1.1');
  expect(listChecklist('9.1.1').items.find((i) => i.id === 'DW-1')!.doneCriterion).toBe(undefined);
});

// JUD-GREEN-CREDENTIAL (#187277 «server-confirmed pane credential 필요 오류로 거부») — the JUD seat runs in seats/JUD with no
// ELANOUS_TRACK and no els pane seat. Its normal seat identity (the one `eln msg post` uses) writes green · yellow (veto) · HOLD,
// and the ledger row says by=JUD. No server identity is required (JUDGE-LOAD-REDUCTION §0c). Literals from the cell text.
test('(i) JUD-GREEN-CREDENTIAL: no els seat, no ELANOUS_TRACK — the seats/JUD folder (or ELANOUS_SEAT) is the writer', async () => {
  const none = async () => undefined;
  const jud = await resolveChecklistWriter('green', { env: {}, cwd: '/Users/x/elanous-hq/seats/JUD', confirm: none });
  expect(jud.verdict.allowed).toBe(true);
  expect(jud.by).toBe('JUD');
  expect((await resolveChecklistWriter('yellow', { env: {}, cwd: '/Users/x/elanous-hq/seats/JUD', confirm: none })).by).toBe('JUD');
  expect((await resolveChecklistWriter('green', { env: { ELANOUS_SEAT: 'JUD-B' }, cwd: '/tmp', confirm: none })).by).toBe('JUD-B');
  // a hand seat folder still may not sign; no identity at all → refused, non-green stays «cli»
  const hand = await resolveChecklistWriter('green', { env: {}, cwd: '/Users/x/elanous-hq/seats/TC-H-POOL-2', confirm: none });
  expect(hand.verdict.allowed).toBe(false);
  expect(hand.verdict.refuse).toContain('judge-only');
  expect((await resolveChecklistWriter('green', { env: {}, cwd: '/tmp', confirm: none })).verdict.allowed).toBe(false);
  expect((await resolveChecklistWriter('red', { env: {}, cwd: '/tmp', confirm: none })).by).toBe('cli');
  // a server-confirmed seat still wins when there is one (unchanged · (b))
  expect((await resolveChecklistWriter('green', { env: {}, cwd: '/Users/x/elanous-hq/seats/JUD', confirm: async () => 'HAND-TUI-D' })).verdict.allowed).toBe(false);
  // an els lookup that throws is «not confirmed», never a crash
  expect((await resolveChecklistWriter('green', { env: {}, cwd: '/Users/x/elanous-hq/seats/JUD', confirm: async () => { throw new Error('socket gone'); } })).by).toBe('JUD');
});

test('(j) JUD-GREEN-CREDENTIAL: through the CLI, ELANOUS_SEAT=JUD writes green and a yellow veto as by=JUD; HOLD add defaults to JUD', async () => {
  seed('0.2.9', ['J1', 'J2']);
  process.env.ELANOUS_SEAT = 'JUD';
  await run('J1', '--status', 'green', '--evidence', '#40445 same-head receipt · focused 51/0', '--version', '0.2.9');
  expect(statusOf('0.2.9', 'J1')).toBe('green');
  expect(updatedByOf('0.2.9', 'J1')).toBe('JUD');
  await run('J2', '--status', 'yellow', '--evidence', 'JUD: parent focused ≠ E4 완료선', '--version', '0.2.9');
  expect(updatedByOf('0.2.9', 'J2')).toBe('JUD');
  const audit = listChecklist('0.2.9').history.filter((h) => h.id === 'J1' && h.field === 'status');
  expect(audit.map((h) => [h.by, h.to])).toEqual([['JUD', 'green']]);
  const holdRoot = mkdtempSync(join(tmpdir(), 'jud-hold-'));
  const out: string[] = []; const err: string[] = []; const facts: string[] = [];
  const program = new Command(); program.exitOverride();
  registerHoldCommands(program, { stateRoot: () => holdRoot, print: (l) => out.push(l), error: (l) => err.push(l), fact: (e) => facts.push(`${e.op}:${e.by}`) });
  await program.parseAsync(['hold', 'add', '--cells', 'J2', '--reason', 'E4 child only', '--unlock', 'JUD lifts'], { from: 'user' });
  expect(err).toEqual([]);
  expect(facts).toEqual(['add:JUD']);
  rmSync(holdRoot, { recursive: true, force: true });
});
