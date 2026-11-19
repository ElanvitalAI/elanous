/**
 * S7 시뮬 팩 — seat-mail-roundtrip 세계: 두 자리(A·B) 우편 왕복 (갭 S-C — SIM-HOOKS.md).
 * OP SIM-DEVICES-FIRST-1119: 장치 우선 — 시나리오는 D-RT 장치를 통해서만 세계를 본다.
 * «두 개 고립 ledger»: A→B 우편은 B의 MsgStore(=B 우체국 원장)에, B→A 답신은 A의 원장에 기록된다.
 * 시나리오 리터럴만 사용(운영 원장 쓰기 0) · 빨강 행은 결함 확정 아님(탐색 관측).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../../../msg/msg-store.js';
import { registerMsgListCommand } from '../../../cli/msg-list-cli.js';
import { createNextTuiQueue } from '../../../tui/core/queue.js';
import { createSeatMailArrivalWatcher } from '../../../tui/seat-mail-arrival.js';
import { readSeatMailMessages, createLedgerReceiptWriter } from '../../../tui/seat-message-receipts.js';
import { wakeRecipient } from '../../../loops/msg-wake.js';
import { createFakeHerdr } from '../../fake-herdr.js';
import { updateSeatPaneDirectory } from '../../../loops/seat-pane-directory.js';
import { getReceipt as receiptClockOf } from '../../../hq/msg-receipt-clocks.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

const SEAT_A = 'seat-A';
const SEAT_B = 'seat-B';

interface Station {
  side: 'A' | 'B';
  home: string;
  cwd: string;
  msgPath: string;
  queue: { items: Array<Record<string, unknown>>; dequeue(): unknown; close(): void };
  store: MsgStore;
  watcher: { poll(): unknown; stop(): void; noteTurnFinished(ok: boolean): void };
}

interface SendResult { ok: boolean; ids: number[]; note: string; deduped?: true; repeatCount?: number; repeatReason?: string }

interface PendingMail { mail: PostInput; dueMs: number }

interface PostInput { body: string; intent?: string; expiresAt?: string }

interface MailMessage { id: number }

export interface RoundtripKnobs {
  pause: boolean;
  kill: boolean;
  delayMs: number;
  duplicate: boolean;
  flood: number;
  approvalWait: boolean;
  disconnect: boolean;
}

/** D-RT: 두 자리 우편 왕복 장치. 주입 손잡이 7종(pause·kill·delay·duplicate·flood·approval-wait·disconnect). */
export interface RoundtripDevice {
  readonly knobs: RoundtripKnobs;
  readonly pending: readonly PendingMail[];
  send(from: 'A' | 'B', mail: PostInput, opts?: { dedupe?: boolean }): SendResult;
  poll(side: 'A' | 'B'): { polls: string[] };
  dequeue(side: 'A' | 'B'): unknown;
  queueItems(side: 'A' | 'B'): Array<Record<string, unknown>>;
  queueIds(side: 'A' | 'B'): (number | undefined)[];
  noticeCount(side: 'A' | 'B'): number;
  recordReceipt(side: 'A' | 'B', messageId: number, state: 'seen' | 'accepted' | 'rejected' | 'done' | 'expired', extra?: { evidence?: string; queueItemId?: string }): void;
  receiptStates(side: 'A' | 'B', messageId: number): string[];
  receiptClocks(side: 'A' | 'B', messageId: number): unknown;
  registerPane(side: 'A' | 'B', targetSeat: string, pane: string): void;
  wake(side: 'A' | 'B', messageId: number): { result: unknown; reason?: string };
  noteTurnFinished(side: 'A' | 'B', ok: boolean): void;
  postCount(side: 'A' | 'B'): number;
  addressBook(side: 'A' | 'B'): string | null;
  listOutput(side: 'A' | 'B'): string;
  release(): number;
  approve(): number;
  tick(): number;
  dispose(): void;
}

interface DeviceImpl extends RoundtripDevice {
  stations: Record<'A' | 'B', Station>;
  wakeups: string[];
}

function buildStation(side: 'A' | 'B', universeRoot: string): Station {
  // 자리 신원은 cwd 디렉터리 이름(seats/<seat>)에서 나온다 — 템플릿(seat-mail)과 동일한 관례.
  const home = join(universeRoot, 'home', side);
  const cwd = join(universeRoot, 'seats', `seat-${side}`);
  mkdirSync(join(home, 'elanous-hq', 'seat-state', `seat-${side}`), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const msgPath = join(cwd, 'messages.db');
  const queue = createNextTuiQueue({ log: () => {} });
  const store = new MsgStore(msgPath);
  // [#14 실측 수리 11-19] receipts 는 SeatMessageSource(messages) 안쪽 계약이다 — 바깥에 두면 자동 delivered/started/seen이 전부 기록되지 않는다.
  const watcher = createSeatMailArrivalWatcher(cwd, queue, {
    messages: {
      read: (c: string, afterId: number) => readSeatMailMessages(c, afterId, { home, msgPath, env: { NODE_ENV: 'test' } }),
      receipts: createLedgerReceiptWriter(msgPath),
    },
  } as unknown as never) as unknown as Station['watcher'];
  return { side, home, cwd, msgPath, queue: queue as unknown as Station['queue'], store, watcher };
}

const deviceDef: SimWorldDeviceDef<RoundtripDevice> = {
  id: 'D-RT',
  title: '두 자리 우편 왕복 — 고립 ledger 2개(A·B) + 주입 손잡이 7종',
  create(ctx): RoundtripDevice {
    const stations: Record<'A' | 'B', Station> = { A: buildStation('A', ctx.universeRoot), B: buildStation('B', ctx.universeRoot) };
    const pending: PendingMail[] = [];
    const wakeups: string[] = [];
    const knobs: RoundtripKnobs = { pause: false, kill: false, delayMs: 0, duplicate: false, flood: 0, approvalWait: false, disconnect: false };
    const impl: DeviceImpl = {
      stations,
      wakeups,
      knobs,
      pending,
      send(from, mail, opts: { dedupe?: boolean } = {}) {
        if (knobs.disconnect) return { ok: false, ids: [], note: 'knob:disconnect' };
        if (knobs.pause || knobs.approvalWait || knobs.delayMs > 0) {
          pending.push({ mail, dueMs: knobs.delayMs });
          return { ok: true, ids: [], note: 'knob:held' };
        }
        const to = from === 'A' ? 'B' : 'A';
        const store = stations[to].store;
        if (knobs.kill) return { ok: false, ids: [], note: 'knob:kill' };
        const count = knobs.flood > 0 ? knobs.flood : (knobs.duplicate ? 2 : 1);
        const ids: number[] = [];
        let last: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          // [#16] dedupe는 송신 입구 옵션(`msg post` ↔ post(input, {dedupe:true})) — 프로그램 생산자는 기본 미적용(#38958 계약).
          const row = store.post({ from: `seat-${from}`, to: `seat-${to}`, body: mail.body, ...(mail.intent ? { intent: mail.intent } : {}), ...(mail.expiresAt ? { expiresAt: mail.expiresAt } : {}) } as Parameters<MsgStore['post']>[0], { dedupe: opts?.dedupe === true }) as unknown as MailMessage;
          ids.push(row.id);
          last = row as unknown as Record<string, unknown>;
        }
        return { ok: true, ids, note: `posted:${count}`, ...(last.deduped === true ? { deduped: true, repeatCount: last.repeatCount as number, repeatReason: String(last.repeatReason ?? '') } : {}) };
      },
      poll(side) {
        const kinds: string[] = [];
        for (let i = 0; i < 2; i++) {
          const outcome = stations[side].watcher.poll() as { kind: string };
          kinds.push(outcome?.kind ?? 'none');
        }
        return { polls: kinds };
      },
      dequeue(side) { return stations[side].queue.dequeue(); },
      queueItems(side) { return stations[side].queue.items.slice(); },
      queueIds(side) { return stations[side].queue.items.map((item) => (item.msgId ?? item.messageId) as number | undefined); },
      noticeCount(side) { return stations[side].queue.items.length; },
      recordReceipt(side, messageId, state, extra) {
        // [#38869 API] 원장 recordReceipt 직접 호출 — done은 evidence 필수(msg-receipts.ts «done needs evidence»).
        stations[side].store.recordReceipt({ messageId, recipient: `seat-${side}`, state, source: 'tui-queue', ...(extra?.queueItemId ? { queueItemId: extra.queueItemId } : {}), ...(extra?.evidence ? { evidence: extra.evidence } : {}) } as never);
      },
      receiptStates(side, messageId) { return stations[side].store.listReceipts({ messageId }).map((r: { state: string }) => r.state); },
      receiptClocks(side, messageId) {
        // [#14] started 계기는 clock 전용 표(msg_receipt_clocks) — listReceipts(msg_receipts)에는 보이지 않는다.
        return receiptClockOf(stations[side].store.db, messageId, `seat-${side}`);
      },
      registerPane(side, targetSeat, pane) {
        // [#22 · #38900] msg-wake.ts:517-524 관례 — 깨운 대상의 살아있는 pane을 깨운 자리 주소록(OP/tools/seat-panes.tsv)에 갱신.
        const dir = join(stations[side].home, 'elanous-hq', 'seat-state', 'OP', 'tools');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'seat-panes.tsv');
        const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
        writeFileSync(path, updateSeatPaneDirectory(prev, targetSeat, pane));
      },
      wake(side, messageId) {
        const st = stations[side];
        const herdr = createFakeHerdr({ panes: [], onRun: (run: { text: string }) => { wakeups.push(run.text); } });
        const stateRoot = join(ctx.universeRoot, 'state');
        return wakeRecipient(`seat-${side}`, messageId, { from: `seat-${side === 'A' ? 'B' : 'A'}` }, {
          stateRoot,
          seatStateRoot: join(stateRoot, 'seats', `seat-${side}`),
          live: true,
          now: () => Date.now(),
          // [11-19 실측 수리] readRegistry는 함수다(msg-wake.ts:226 deps.readRegistry()) — 객체 주입은 runner 전체 TypeError exit 1.
          readRegistry: (() => ({ status: 'ready', registry: { version: 1, seats: [{ address: `seat-${side}`, host: 'local', target: 'wSimWake:p1', wake: 'herdr', replyBody: 'ack', optIn: true }] } })) as unknown as never,
          listHerdrPanes: () => [],
          listPtys: () => [],
          readPane: () => null,
          hasOptIn: () => true,
          herdrRun: ((opts: unknown) => (herdr as unknown as { run: (o: unknown) => unknown }).run(opts)) as never,
          warn: () => {},
        }) as unknown as { result: unknown; reason?: string };
      },
      noteTurnFinished(side, ok) { stations[side].watcher.noteTurnFinished(ok); },
      postCount(side) { return stations[side].store.list(`seat-${side}`, 0, 1000).length; },
      addressBook(side) {
        // [seat-mail #22] 주소록 정본 자리: <home>/elanous-hq/seat-state/OP/tools/seat-panes.tsv (msg-wake.ts 관례)
        const path = join(stations[side].home, 'elanous-hq', 'seat-state', 'OP', 'tools', 'seat-panes.tsv');
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      },
      listOutput(side) {
        // [seat-mail #29] 실제 CLI 표면(registerMsgListCommand)로 --to <seat> 목록을 뽑는다(주입 store · 캐시 off)
        const st = stations[side];
        const lines: string[] = [];
        const msg = new Command('msg');
        registerMsgListCommand(msg, {
          openStore: () => new MsgStore(st.msgPath),
          cacheReads: false,
          out: { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')), error: (...a: unknown[]) => lines.push(a.map(String).join(' ')) } as unknown as Pick<Console, 'log' | 'error'>,
        } as never);
        msg.parse(['list', '--to', `seat-${side}`], { from: 'user' });
        return lines.join('\n');
      },
      release() { const n = pending.length; pending.length = 0; return n; },
      approve() { return this.release(); },
      tick() { const now = Date.now(); const due = pending.filter((m) => m.dueMs > 0 && m.dueMs <= now); if (due.length) { pending.length = 0; } return due.length; },
      dispose() { stations.A.watcher.stop(); stations.B.watcher.stop(); stations.A.store.close(); stations.B.store.close(); },
    };
    return impl;
  },
  dispose(device) { (device as DeviceImpl).dispose(); },
};

const scenarios: SimWorldScenario[] = [
  {
    id: 'R1-urgent-band',
    title: '긴급 띠 — urgent 우편이 보통 우편을 큐에서 앞선다',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const normal = dev.send('A', { body: 'R1 normal', intent: 'info' });
      const urgent = dev.send('A', { body: 'R1 urgent', intent: 'alert' });
      if (!normal.ids[0] || !urgent.ids[0]) return { ok: false, diff: `send failed normal=${JSON.stringify(normal)} urgent=${JSON.stringify(urgent)}`, reason: 'R1-send-failed' };
      dev.poll('B');
      const items = dev.queueItems('B');
      const first = dev.dequeue('B');
      const second = dev.dequeue('B');
      const text = (x: unknown) => String((x as { text?: string } | null)?.text ?? (x as { input?: string } | null)?.input ?? '');
      const drained = [text(first), text(second)];
      const queueOrder = items.map((item) => `${String(item.msgId ?? item.messageId ?? '?')}:${String(item.text ?? item.input ?? '').slice(0, 24)}`);
      const observed = `queue:${queueOrder.join('|')} drain0:${drained[0].slice(0, 24)} drain1:${drained[1].slice(0, 24)}`;
      const ok = drained[0].includes('alert') && drained[0].includes('urgent');
      return ok
        ? { ok: true }
        : { ok: false, diff: `urgent (alert) mail should drain first; observed ${observed}`, reason: `R1-urgent-not-first:${observed}` };
    },
  },
  {
    id: 'R2-receipt-stages',
    title: '영수증 3단 — seen → accepted → done 순서로 기록된다',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const sent = dev.send('A', { body: 'R2 stage mail', intent: 'info' });
      if (!sent.ids[0]) return { ok: false, diff: `send failed ${JSON.stringify(sent)}`, reason: 'R2-send-failed' };
      const id = sent.ids[0];
      dev.poll('B');
      dev.recordReceipt('B', id, 'seen', { queueItemId: 'sim-r2-seen' });
      dev.recordReceipt('B', id, 'accepted', { queueItemId: 'sim-r2-accepted' });
      dev.recordReceipt('B', id, 'done', { queueItemId: 'sim-r2-done', evidence: 'sim: turn complete' });
      const states = dev.receiptStates('B', id);
      const at = (state: string) => states.indexOf(state);
      const okStages = at('seen') >= 0 && at('accepted') > at('seen') && at('done') > at('accepted');
      const observed = `states:${states.join('>')}`;
      return okStages
        ? { ok: true }
        : { ok: false, diff: `expected receipt stages seen>accepted>done (subsequence) but observed ${observed}`, reason: `R2-receipt-stages:${observed}` };
    },
  },
  {
    id: 'R3-repoll-dedupe',
    title: '반복 억제 — 같은 우편 재폴링해도 알림은 1회',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const sent = dev.send('A', { body: 'R3 dedupe mail', intent: 'info' });
      if (!sent.ids[0]) return { ok: false, diff: `send failed ${JSON.stringify(sent)}`, reason: 'R3-send-failed' };
      const id = sent.ids[0];
      const first = dev.poll('B');
      const items1 = dev.queueItems('B');
      const wake = dev.wake('B', id);
      dev.recordReceipt('B', id, 'seen');
      const second = dev.poll('B');
      const items2 = dev.queueItems('B');
      const count1 = items1.filter((item) => (item.msgId ?? item.messageId) === id).length;
      const count2 = items2.filter((item) => (item.msgId ?? item.messageId) === id).length;
      const observed = `polls:${first.polls.join(',')}+${second.polls.join(',')} notices-for-msg:${count1}+${count2} total:${items2.length} wake:${String((wake as { result?: unknown }).result)}`;
      return count1 === 1 && count2 === 1
        ? { ok: true }
        : { ok: false, diff: `same mail re-polled should notify exactly once; observed ${observed}`, reason: `R3-dedupe-failed:${observed}` };
    },
  },
  {
    id: 'R4-expired-mail',
    title: '만료 — 만료 우편은 깨움을 일으키지 않는다',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const expiredAt = new Date(Date.now() - 86_400_000).toISOString();
      const sent = dev.send('A', { body: 'R4 expired', intent: 'info', expiresAt: expiredAt });
      if (!sent.ids[0]) return { ok: false, diff: `send failed ${JSON.stringify(sent)}`, reason: 'R4-send-failed' };
      dev.poll('B');
      const notices = dev.noticeCount('B');
      const observed = `notices:${notices}`;
      return notices === 0
        ? { ok: true }
        : { ok: false, diff: `expired mail should not raise a wake notice; observed ${observed}`, reason: `R4-expired-mail:${observed}` };
    },
  },
  {
    id: 'R5-auto-receipts',
    title: '#14 자동 영수증 — poll(큐 진입)·턴 인계·턴 끝에 delivered·started(clock)·seen이 자동 기록된다(#38881 배선)',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const sent = dev.send('A', { body: 'R5 auto receipt mail', intent: 'info' });
      if (!sent.ids[0]) return { ok: false, diff: `send failed ${JSON.stringify(sent)}`, reason: 'R5-send-failed' };
      const id = sent.ids[0];
      dev.poll('B'); // 큐 진입 → delivered 자동(msg_receipts)
      dev.dequeue('B'); // 큐→턴 인계 전이 → started 자동(msg_receipt_clocks · eventId=큐 항목 id)
      dev.noteTurnFinished('B', true); // 턴 끝 → seen 자동(msg_receipts ⊕ clock seen)
      const states = dev.receiptStates('B', id);
      const clocks = dev.receiptClocks('B', id) as { startedAt?: unknown; startedEventId?: unknown; seenAt?: unknown } | null;
      const at = (s: string) => states.indexOf(s);
      const observed = `states:${states.join('>')} clocks:${JSON.stringify(clocks)}`;
      return at('delivered') >= 0 && at('seen') > at('delivered') && clocks !== null && clocks.startedAt != null && clocks.startedEventId != null && clocks.seenAt != null
        ? { ok: true }
        : { ok: false, diff: `poll/turn-handoff/turn-finish should auto-record delivered>seen plus started clock; observed ${observed}`, reason: `R5-auto-receipts:${observed}` };
    },
  },
  {
    id: 'R6-send-dedupe',
    title: '#16 반복 억제 — 송신 입구(post {dedupe:true} = `msg post`)에서 같은 받는이·본문 재송신은 첫 행으로 접는다(#38958)',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      const first = dev.send('A', { body: 'R6 dedupe body', intent: 'info' }, { dedupe: true });
      const second = dev.send('A', { body: 'R6 dedupe body', intent: 'info' }, { dedupe: true });
      const delivered = dev.postCount('B');
      const observed = `first:${JSON.stringify(first)} second:${JSON.stringify(second)} delivered:${delivered}`;
      return delivered === 1 && second.deduped === true && second.ids[0] === first.ids[0]
        ? { ok: true }
        : { ok: false, diff: `same recipient+body resend through the sender entrance should collapse to the first row (deduped, same id); observed ${observed}`, reason: `R6-send-dedupe:${observed}` };
    },
  },
  {
    id: 'R7-address-book',
    title: '#22 주소록 — 깨운 자리의 살아있는 pane을 seat-panes.tsv에 한 줄로 등록·갱신한다(#38900 updateSeatPaneDirectory)',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      dev.registerPane('A', 'SIM-B', 'wSimB:p1');
      dev.registerPane('A', 'SIM-B', 'wSimB:p2'); // 재등록 — 같은 자리 행 갱신(중복 행 없음)
      dev.registerPane('B', 'SIM-A', 'wSimA:p1');
      const bookA = dev.addressBook('A');
      const bookB = dev.addressBook('B');
      const rowsA = bookA === null ? [] : bookA.split('\n').filter((line) => line.startsWith('SIM-B\t'));
      const observed = `bookA:${bookA === null ? 'missing' : String(bookA).replace(/\n/g, '|')} bookB:${bookB === null ? 'missing' : String(bookB).replace(/\n/g, '|')}`;
      return bookA !== null && bookB !== null && bookA.includes('SIM-B') && rowsA.length === 1 && rowsA[0]!.includes('wSimB:p2') && bookB.includes('SIM-A')
        ? { ok: true }
        : { ok: false, diff: `wake should register/update the target seat's live pane in the waker's seat-panes.tsv (one row per seat); observed ${observed}`, reason: `R7-address-book:${observed}` };
    },
  },
  {
    id: 'R8-list-cut',
    title: '#29 100건 자르기 — 안 읽은 140건이면 100행 뒤 «+40 더 · --after <id>» 꼬리가 붙는다',
    devices: ['D-RT'],
    async run(ctx) {
      const dev = ctx.device<RoundtripDevice>('D-RT');
      for (let i = 0; i < 140; i++) dev.send('A', { body: `R8 flood ${i}`, intent: 'info' });
      const out = dev.listOutput('B');
      const rows = out.split('\n').filter((line) => line.startsWith('#')).length;
      const tail = out.split('\n').filter((line) => line.includes('더 · --after')).join('|');
      const observed = `rows:${rows} tail:${tail || '(none)'}`;
      return rows === 100 && /\+40 더 · --after \d+/.test(out)
        ? { ok: true }
        : { ok: false, diff: `140 unread should cut at 100 rows + «+40 더 · --after <id>» tail; observed ${observed}`, reason: `R8-list-cut:${observed}` };
    },
  },
];

export const simWorldDevices = [deviceDef];
export const simWorldScenarios = scenarios;
