// ELS-CODEX-SEAT-MAIL-WAKE 완수선 시험 — 칸 원문: «테스트 우주 codex 자리에 우편 1통 → 60초 안 턴 시작».
// fake core(seatBindings·status·sendVerified·onOutput) + 주입 뱃지/이벤트 소스로 노크→'turn started'까지 직접 단언하고,
// 원장 이벤트 구동·버스트 병합 · busy→idle 전환 같은 watcher 재확인 · 시작 회차 pending 후속 회차 ·
// 주입 없는 기본 runtime 판별(실제 자리 레지스트리 파일) · 에피소드 원칙 · 읽기 실패 생존을 함께 잠근다.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { defaultLedgerPath, MAIL_WAKE_LINE, MAIL_WAKE_WITHIN_MS, startMailWakeWatcher, type MailWakeCore, type MailWakeDeps } from './mail-wake-watcher.js';

interface SendCall { pane: string; text: string; requireEmpty: boolean }

function fakeCore(
  rows: ReadonlyArray<{ pane: string; seat: string }>,
  opts: { idle?: boolean; started?: boolean; deferStatusMs?: number } = {},
): {
  core: MailWakeCore; sends: SendCall[]; statusCalls: number;
  outputListeners: Map<string, Array<(data: string) => void>>;
  disposed: string[];
  setIdle: (idle: boolean) => void;
  emitOutput: (pane: string, data: string) => void;
} {
  const sends: SendCall[] = [];
  let statusCalls = 0;
  let idleNow = opts.idle !== false;
  const outputListeners = new Map<string, Array<(data: string) => void>>();
  const disposed: string[] = [];
  const core: MailWakeCore = {
    seatBindings: () => rows.map(row => ({ pane: row.pane, seat: row.seat, pid: 1, generation: 'g1', start: 's1' })),
    status: async () => {
      statusCalls += 1;
      const snapshot = idleNow;   // 판정 시점 스냅숏 — 실제 core status 는 화면을 그려 반환하므로 await 사이 상태가 바뀌어도 이 회차는 옛 판정(JUD-B #39648 must ① 경합 재현)
      if (opts.deferStatusMs) await new Promise<void>(resolve => setTimeout(resolve, opts.deferStatusMs));
      return { exitCode: 0, message: JSON.stringify({ state: snapshot ? 'idle' : 'working', inputEmpty: snapshot ? true : 'unknown' }) };
    },
    sendVerified: async (pane: string, text: string, requireEmpty: boolean) => {
      sends.push({ pane, text, requireEmpty });
      return opts.started === false
        ? { exitCode: 1, message: `els send: ${pane} is already running, not sent` }
        : { exitCode: 0, message: 'els send: turn started' };
    },
    onOutput: (pane: string, cb: (data: string) => void) => {
      const list = outputListeners.get(pane) ?? [];
      list.push(cb);
      outputListeners.set(pane, list);
      return { dispose: () => { disposed.push(pane); outputListeners.set(pane, (outputListeners.get(pane) ?? []).filter(x => x !== cb)); } };
    },
  };
  return {
    core, sends,
    get statusCalls() { return statusCalls; },   // 스냅숏이 아니라 라이브 카운터 — 회차 수 단얩(시작+후속)이 0 오판하지 않게
    outputListeners, disposed,
    setIdle: (idle: boolean) => { idleNow = idle; },
    emitOutput: (pane: string, data: string) => { for (const cb of [...(outputListeners.get(pane) ?? [])]) cb(data); },
  };
}

function depsWith(unread: () => number, extra: Partial<MailWakeDeps> = {}): MailWakeDeps {
  const receiptsDir = mkdtempSync(join(tmpdir(), 'mailwake-'));
  return {
    now: () => 1_700_000_000_000,
    unreadBadge: () => ({ count: unread() }),
    runtimeOf: () => 'codex',
    receiptsPath: join(receiptsDir, 'mail-wake.jsonl'),
    subscribeLedger: () => () => {},   // 시험 우주 — 실 fs.watch 없이 관찰자만 세운다
    ...extra,
  };
}

describe('ELS-CODEX-SEAT-MAIL-WAKE', () => {
  test('완수선: 안 읽은 우편 1통 → idle codex 자리에 «우편 확인» 노크 → turn started(60초 안)', async () => {
    let unread = 0;
    const { core, sends } = fakeCore([{ pane: 'wJUD:p1', seat: 'JUD' }]);
    const watcher = startMailWakeWatcher(core, depsWith(() => unread));
    expect(watcher.watching).toBe(true);
    await watcher.check();                  // 시작 직후 회차(서버가 꺼져 있던 사이 온 우편 문턱 포함)
    expect(sends.length).toBe(0);           // 안 읽은 우편 0 → 노크 없음
    unread = 1;                             // 우편 1통 도착
    const at = Date.now();
    await watcher.check();
    expect(sends.length).toBe(1);
    expect(sends[0]!.pane).toBe('wJUD:p1');
    expect(sends[0]!.text).toBe(MAIL_WAKE_LINE);
    expect(sends[0]!.requireEmpty).toBe(true);
    expect(Date.now() - at).toBeLessThan(MAIL_WAKE_WITHIN_MS);   // 노크→턴 시작 60초 안(동기 시험 우주)
    watcher.stop();
  });

  test('원장 기록 이벤트가 확인 회차를 연다 — 버스트 3건은 한 회차로 묶인다(주기 폴링 아님)', async () => {
    let unread = 0;
    let badgeCalls = 0;
    const { core, sends } = fakeCore([{ pane: 'wREL:p6', seat: 'REL' }]);
    let onChange: (() => void) | undefined;
    const watcher = startMailWakeWatcher(core, {
      ...depsWith(() => { badgeCalls += 1; return unread; }),
      subscribeLedger: (cb) => { onChange = cb; return () => {}; },
    });
    expect(sends.length).toBe(0);           // 시작 회차(생성자가 이미 돌림) — badgeCalls 1, 노크 없음
    unread = 1;                             // 우편 도착 → 원장 기록 이벤트 버스트 3건
    const at = Date.now();
    onChange!(); onChange!(); onChange!();
    const deadline = Date.now() + 3_000;
    while (sends.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(sends.length).toBe(1);           // 노크 → turn started
    expect(Date.now() - at).toBeLessThan(MAIL_WAKE_WITHIN_MS);   // 이벤트→턴 시작 60초 안
    await new Promise(resolve => setTimeout(resolve, 1_300));    // 디바운스 꼬리 지나 정착
    expect(badgeCalls).toBe(2);             // 시작 1 + 버스트 3건→회차 1 — 두 번 다시 돌지 않는다
    watcher.stop();
  });

  test('턴 중이면 대기: busy 자리는 노크하지 않고, idle 전환(턴 종료 출력) 이벤트에 같은 watcher 로 다시 노크한다', async () => {
    let unread = 1;
    const f = fakeCore([{ pane: 'wREL:p2', seat: 'REL' }]);
    f.setIdle(false);                                              // 턴 중 — 시작 회차는 busy 로 지나간다
    const watcher = startMailWakeWatcher(f.core, depsWith(() => unread));
    await new Promise<void>(resolve => setTimeout(resolve, 150));  // 시작 회차의 busy 판정이 끝나게
    expect(f.sends.length).toBe(0);                                // busy — 이 회차에서는 그냥 넘어간다
    expect([...f.outputListeners.keys()]).toContain('wREL:p2');    // idle 전환 감시 구독이 서 있다
    f.setIdle(true);                                               // 턴 종료 — idle 로 돌아온다
    f.emitOutput('wREL:p2', '✻ Worked for 12 seconds');            // 턴 종료 출력 = idle 전환 이벤트
    const deadline = Date.now() + 3_000;
    while (f.sends.length < 1 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(f.sends.length).toBe(1);                                // 같은 watcher(중지·재생성 없음)가 다시 노크 — 여기서 턴이 시작된다
    expect(f.disposed).toContain('wREL:p2');                       // 노크 뒤 idle 감시 구독은 해지된다
    expect(watcher.watching).toBe(true);
    watcher.stop();
  });

  test('경합 회귀(JUD-B #39648 must ①): 턴 종료 출력이 status 반환보다 먼저 지나가도 구독이 잡아 후속 회차로 노크한다', async () => {
    let unread = 1;
    const f = fakeCore([{ pane: 'wJUD:p2', seat: 'JUD' }], { deferStatusMs: 120, idle: false });   // 시작 회차: status await(120ms) 중 busy
    const watcher = startMailWakeWatcher(f.core, depsWith(() => unread));
    await new Promise<void>(resolve => setTimeout(resolve, 40));    // status 아직 await 중 — 구독은 status 앞에서 이미 서 있다
    expect([...f.outputListeners.keys()]).toContain('wJUD:p2');
    f.setIdle(true);                                                // 턴이 끝나 idle 로 전환 — 이 회차의 status 는 옛 busy 스냅숏을 반환한다
    f.emitOutput('wJUD:p2', '✻ Worked for 8 seconds');              // 턴 종료 출력이 status 반환보다 먼저 지나간다(구 순서=구독이 status 뒤면 이 이벤트는 영영 놓친다)
    const deadline = Date.now() + 5_000;
    while (f.sends.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.sends.length).toBe(1);                                 // status 앞 구독이 잡은 이벤트 → 후속 회차 → 미읽음 재확인 → 노크
    watcher.stop();
  });

  test('시작 회차 실행 중 온 원장 이벤트는 소실되지 않고 후속 회차로 이어진다(busy 판정 중 버스트도 회차를 하나 더 연다)', async () => {
    let unread = 1;
    const f = fakeCore([{ pane: 'wJUD:p6', seat: 'JUD' }], { deferStatusMs: 120, idle: false });   // 시작 회차 status await 중 · busy(노크 안 함 — episodes 가드가 후속 회차의 status 를 막지 않게)
    let onChange: (() => void) | undefined;
    const watcher = startMailWakeWatcher(f.core, { ...depsWith(() => unread), subscribeLedger: (cb) => { onChange = cb; return () => {}; } });
    onChange!();                                                     // 시작 회차(checking) 중 도착한 원장 이벤트 버스트
    const deadline = Date.now() + 3_000;
    while (f.statusCalls < 2 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(f.statusCalls).toBeGreaterThanOrEqual(2);                 // pending 이 후속 회차를 열었다 — 이벤트가 소실되지 않는다
    watcher.stop();
  });

  test('에피소드 원칙: 노크 뒤 우편이 더 와도 두 번 노크하지 않고, 0을 거쳐야 다시 노크한다', async () => {
    let unread = 1;
    const { core, sends } = fakeCore([{ pane: 'wRES:p3', seat: 'RES-INFRA' }]);
    const watcher = startMailWakeWatcher(core, depsWith(() => unread));
    await watcher.check();                  // 시작 회차에서 노크 1
    expect(sends.length).toBe(1);
    unread = 2;                            // 같은 에피소드 — 이미 노크함
    await watcher.check();
    expect(sends.length).toBe(1);
    unread = 0;                            // 자리가 읽음 — 에피소드 끝
    await watcher.check();
    unread = 1;                            // 새 에피소드
    await watcher.check();
    expect(sends.length).toBe(2);
    watcher.stop();
  });

  test('runtime=eln 자리는 자기 큐를 스스로 비운다 — 노크 0', async () => {
    const { core, sends } = fakeCore([{ pane: 'wOP:p9', seat: 'MOB-1' }]);
    const watcher = startMailWakeWatcher(core, depsWith(() => 5, { runtimeOf: () => 'eln' }));
    await watcher.check();
    expect(sends.length).toBe(0);
    watcher.stop();
  });

  test('주입 없는 기본 runtime 판별: 실제 자리 레지스트리 파일을 읽는다 — eln 은 노크 0, external-cli(codex 몸) 자리는 노크한다(JUD-B #39648 must ①)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mailwake-registry-'));
    writeFileSync(join(root, 'seat-registry.json'), JSON.stringify({
      version: 2,
      seats: [
        { address: 'MOB-1', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'none', optIn: true },
        { address: 'RES-INFRA', host: 'local', runtime: 'external-cli', delivery: 'queue', replyBody: 'none', optIn: true },
      ],
    }));
    const f = fakeCore([{ pane: 'wMOB:p8', seat: 'MOB-1' }, { pane: 'wRES:p7', seat: 'RES-INFRA' }]);
    const receiptsDir = mkdtempSync(join(tmpdir(), 'mailwake-'));
    const watcher = startMailWakeWatcher(f.core, {
      now: () => 1_700_000_000_000,
      unreadBadge: () => ({ count: 1 }),
      receiptsPath: join(receiptsDir, 'mail-wake.jsonl'),
      subscribeLedger: () => () => {},     // 시험 우주 — 실 fs.watch 없이 관찰자만 세운다
      seatStateRoot: root,                 // runtimeOf 주입 없음 — 기본 판별(msg-wake seatDeliveryView)이 이 레지스트리를 읽는다
    });
    const deadline = Date.now() + 3_000;
    while (f.sends.filter(s => s.pane === 'wRES:p7').length < 1 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(f.sends.filter(s => s.pane === 'wRES:p7').length).toBe(1);   // external-cli(codex 몸) 자리는 노크
    expect(f.sends.filter(s => s.pane === 'wMOB:p8').length).toBe(0);   // runtime=eln 자리는 노크하지 않는다 — 중복 턴 금지 #87012
    watcher.stop();
  });

  test('원장 읽기 실패로 회차가 죽지 않는다 — 다음 회차에서 노크한다', async () => {
    let unread: number | null = null;      // null = 뱃지 불가(원장 잠금 등)
    const { core, sends } = fakeCore([{ pane: 'wJUD:p4', seat: 'JUD' }]);
    const watcher = startMailWakeWatcher(core, {
      ...depsWith(() => 0),
      unreadBadge: () => { if (unread === null) throw new Error('database is locked'); return { count: unread! }; },
    });
    await watcher.check();                  // 읽기 실패 — 감시자는 살아 있다
    expect(sends.length).toBe(0);
    unread = 1;
    await watcher.check();
    expect(sends.length).toBe(1);
    watcher.stop();
  });

  test('기본 원장 경로는 격리 우주를 본다(OP #132628 isolation-gate 수리) — homedir 하드코딩 폴백 금지', () => {
    const saved = process.env.ELANOUS_STATE_DIR;
    try {
      resetEffectiveInstanceRoot();
      // 격리 시험 우주(ELANOUS_STATE_DIR)를 가리키면 기본 원장 경로도 그 우주로 간다 —
      // 폴백 포함 어느 경로도 homedir()+'.elanous' 운영 원장을 직접 조립하지 않는다.
      process.env.ELANOUS_STATE_DIR = '/x/isolated/mailwake';
      resetEffectiveInstanceRoot();
      const p = defaultLedgerPath();
      expect(p.startsWith('/x/isolated/mailwake')).toBe(true);
      expect(p.endsWith(join('msg', 'messages.db'))).toBe(true);
      expect(p.startsWith(join(homedir(), '.elanous'))).toBe(false);   // 운영 원장 직접 조립 금지
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = saved;
      resetEffectiveInstanceRoot();
    }
  });

  test('노크 영수: turn-started 한 줄이 mail-wake.jsonl 에 남는다', async () => {
    let unread = 1;
    const { core } = fakeCore([{ pane: 'wJUD:p5', seat: 'JUD' }]);
    const deps = depsWith(() => unread);
    const watcher = startMailWakeWatcher(core, deps);
    await watcher.check();                  // 회차가 이미 돌고 있으면(checking) 즉시 반환된다 — 시작 회차의 완결은 아래에서 기다린다
    // 시작 회차는 core.status·sendVerified await로 마이크로태스크 한 틱씩 늦어진다 — 영수가 남을 때까지 짧게 기다린다(선회 조건, 시간초과 단언 아님).
    for (let i = 0; i < 50 && !existsSync(deps.receiptsPath!); i += 1) await new Promise<void>(resolve => setTimeout(resolve, 1));
    const line = JSON.parse(readFileSync(deps.receiptsPath!, 'utf8').trim()) as { pane?: string; seat?: string; result?: string; unread?: number };
    expect(line.pane).toBe('wJUD:p5');
    expect(line.seat).toBe('JUD');
    expect(line.result).toBe('turn-started');
    expect(line.unread).toBe(1);
    watcher.stop();
  });
});
