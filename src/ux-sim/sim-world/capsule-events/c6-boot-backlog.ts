// Product stage C6, real boot race: the seat restarts with mail already in the ledger (the boot
// backlog notices), the person types and presses Enter first, and the backlog mail is held until
// the person's turn completes — then delivered into later turns. Real TUI boot (bin/elanous.mjs
// --tui next on a PTY), real Enter, real mail ledger; only the external model is faked.
// Green conditions: the person's prompt goes first in the capture order, both backlog notices
// are delivered into later turns (none lost), and the TUI exits cleanly.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsgStore } from '../../../msg/msg-store.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

const c6: SimWorldScenario = {
  id: 'C6',
  title: 'the first Enter goes before the boot backlog notices',
  async run(ctx) {
    const seat = 'SIMSEAT';
    const root = join(ctx.universeRoot, 'seats', seat);
    const home = join(ctx.universeRoot, 'home');
    const capture = join(root, 'requests.jsonl');
    const db = join(root, 'msg', 'messages.db');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
    mkdirSync(join(root, 'msg'), { recursive: true });
    // 출처: 2026-11-19 main 재병합 뒤 실측 — debug/log.ts resolveLogDir 이 getSessionProjectRoot
    // (PROJECT_MARKERS ['.elanous','.git',…] 최근접 조상 · tmpdir/home 은 경계) 기준으로 바뀌어,
    // 마커 없는 임시 좌석의 원장이 SWD 쪽 .elanous/debug 로 흘러 시나리오 판독과 어긋났다(0행).
    // 실제 좌석과 같은 모양(seats/<SEAT>/.elanous)으로 좌석 디렉터리에 마커를 두면 프로젝트 루트=
    // 좌석 디렉터리로 핀 고정 → 원장이 아래 ledgerDir(join(root,'.elanous','debug')) 에 온다.
    mkdirSync(join(root, '.elanous'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // Boot backlog: two notices are already in the ledger before the seat boots.
    const store = new MsgStore(db);
    try {
      store.post({ from: 'OP', to: seat, body: 'C6 boot backlog mail 1', intent: 'request' });
      store.post({ from: 'OP', to: seat, body: 'C6 boot backlog mail 2', intent: 'request' });
    } finally { store.close(); }
    const captureLines = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { messages?: unknown }) : [];
    const captureIndexOf = (needle: string) => {
      const lines = captureLines();
      const index = lines.findIndex(row => JSON.stringify(row.messages).includes(needle));
      return { found: index >= 0, index };
    };
    // Turn boundary source for the overlap judgment (JUD 20261119-0934 must ⓐ): the seat's own
    // turn-life rows in its debug ledger, read in chronological file order. Captured inboxes
    // always carry earlier turns as conversation history, so they cannot prove turn overlap.
    // 출처: main 디버그 원장 직렬화 변경 — turn-life 행의 data 필드가 문자열이 아니라 구조화 객체로
    // 저장된다(병합 뒤 실측). 두 형태를 모두 읽는다(fail-open).
    const turnLifeRows = (dir: string): Array<{ event: string; data: unknown }> => !existsSync(dir) ? []
      : readdirSync(dir).filter(name => (name.startsWith('debug-') || name.startsWith('chat-')) && name.endsWith('.log')).sort()
        .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
        .flatMap(line => {
          try {
            const row = JSON.parse(line) as { category?: string; event?: string; data?: unknown };
            return row.category === 'turn-life' && row.event ? [{ event: row.event, data: row.data ?? '' }] : [];
          } catch { return []; }
        });
    const rowField = (data: unknown, key: string): unknown => {
      if (data !== null && typeof data === 'object') return (data as Record<string, unknown>)[key];
      if (typeof data === 'string') {
        try { return (JSON.parse(data) as Record<string, unknown>)[key]; } catch { return undefined; }
      }
      return undefined;
    };
    let backlogWindowEnd = 0; // set when the backlog window actually opens (after the person's turn)
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: { HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TURN_CAPSULE_STAGES: process.env.ELANOUS_TURN_CAPSULE_STAGES ?? '',
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C6_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          // The person's first Enter opens the first turn while the backlog is still held.
          { label: 'person first Enter', text: 'c6-person-first', until: () => captureIndexOf('c6-person-first').found, timeoutMs: 30_000 },
          // Bounded observation window: if the boot wires the backlog, it lands at the first
          // turn-end boundary (the queue opens its own turn). The window resolves on delivery
          // OR on the deadline — the verdict below reports what the real path actually did.
          { label: 'backlog window', timeoutMs: 45_000, until: () => {
            if (backlogWindowEnd === 0) backlogWindowEnd = Date.now() + 15_000;
            return (captureIndexOf('C6 boot backlog mail 1').found && captureIndexOf('C6 boot backlog mail 2').found)
              || Date.now() >= backlogWindowEnd;
          } },
        ],
      });
      const person = captureIndexOf('c6-person-first');
      const mail1 = captureIndexOf('C6 boot backlog mail 1');
      const mail2 = captureIndexOf('C6 boot backlog mail 2');
      const backlogDelivered = mail1.found && mail2.found ? 2 : (mail1.found || mail2.found ? 1 : 0);
      // Turn-overlap correlation (JUD 20261119-0934 must ⓐ): judge on the real turn timeline.
      // A mail request's inbox mentions the person's prompt even in perfectly sequential turns
      // (history contamination → false red), and requiring BOTH mails to overlap hides a
      // single-mail overlap (false green). Instead: the person's human turn must END before
      // any other turn opens — one turn-start inside the person's turn window is red (OR).
      // 출처: 2026-11-19 병합 뒤 실측 — 자식 TUI 종료 직후 디버그 원장 플러시가 늦을 수 있다(판독 시점
      // 0행 → 수 초 뒤 35행). 판정은 원문 그대로: 최대 2초까지 100ms 간격으로 행이 보일 때까지 기다린다.
      const ledgerDir = join(root, '.elanous', 'debug');
      let ledger = turnLifeRows(ledgerDir);
      for (let waitedMs = 0; ledger.length === 0 && waitedMs < 2_000; waitedMs += 100) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 출처: 위 실측 — 플러시 유예
        ledger = turnLifeRows(ledgerDir);
      }
      const personStart = ledger.findIndex(row => row.event === 'turn-life:turn-start' && rowField(row.data, 'door') === 'human');
      const personEnd = personStart >= 0
        ? ledger.findIndex((row, i) => i > personStart && row.event === 'turn-life:turn-end') : -1;
      const overlap = mail1.found && mail2.found && personStart >= 0 && personEnd >= 0
        && ledger.some((row, i) => i > personStart && i < personEnd && row.event === 'turn-life:turn-start');
      const judgmentReadable = !(mail1.found && mail2.found) || (personStart >= 0 && personEnd >= 0);
      const personFirst = person.found && mail1.found && mail2.found && person.index < mail1.index && person.index < mail2.index && !overlap;
      ctx.recorder.event('c6-boot-race', { personTurnOpened: person.found, personFirst, backlogDelivered, overlap, exitCode: run.exitCode });
      if (run.exitCode !== 0)
        return { ok: false, reason: 'C6 TUI did not exit cleanly', diff: `exit ${run.exitCode}` };
      if (!person.found)
        return { ok: false, reason: 'the person\'s first Enter never opened a turn', diff: 'capture has no c6-person-first request' };
      // Fail-closed (JUD ⓐ): when both mails were delivered we must be able to read the
      // person's turn window from the ledger — an unreadable judgment is itself a red.
      if (!judgmentReadable)
        return { ok: false, reason: 'turn timeline unreadable — cannot judge overlap',
          diff: `personStart ${personStart}, personEnd ${personEnd}, ledger rows ${ledger.length} — no human turn-start/turn-end pair in the debug ledger` };
      if (backlogDelivered !== 2)
        // Regression lock (the honest red the scenario opened with, before the boot wiring landed
        // on main): if the boot ever stops queueing the pre-existing unread mail again, this red
        // re-opens — a seat that restarts with pending mail must never silently miss it.
        return { ok: false, reason: 'boot backlog notice lost',
          diff: `delivered ${backlogDelivered} of 2 — the boot never enqueues the pre-existing unread mail (silent loss)` };
      if (overlap)
        return { ok: false, reason: 'backlog turn overlapped the person\'s turn', diff: 'a turn-life turn-start row appears inside the person\'s turn window (turn-start … turn-end) — the backlog turn opened before the person\'s turn ended' };
      if (!personFirst)
        return { ok: false, reason: 'boot notice turn opened before the person\'s first Enter', diff: `person ${person.index}, mail1 ${mail1.index}, mail2 ${mail2.index}` };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const mail1 = captureIndexOf('C6 boot backlog mail 1');
      const mail2 = captureIndexOf('C6 boot backlog mail 2');
      ctx.recorder.event('c6-boot-race', { personTurnOpened: false, personFirst: false,
        backlogDelivered: (mail1.found ? 1 : 0) + (mail2.found ? 1 : 0), exitCode: null });
      return { ok: false, reason: 'C6 boot race failed', diff: message };
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c6];