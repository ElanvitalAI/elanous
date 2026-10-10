import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { debug } from '../../debug/log.js';
import { recordFailureEvent } from '../../self-implement/heal-intake.js';
import { loadRunLedger, runLedgerDir, runLedgerPath, TRAILING_BOOKKEEPING_EVENTS } from '../../self-implement/run-ledger.js';
import { ledgerLineToLogEvent } from './pod-ledger-events.js';
import { defaultPodReemit } from './pod-ledger-prod-sink.js';

type Ledger = { runId: string; jsonl: string };
type Incomplete = { runId: string; reason: string };
type ParseResult = Ledger[] | { error: Incomplete[]; ledgers: Ledger[] };

const NON_PROGRESS_EVENTS = new Set(['progress-delivery-outcome']);
const REEMIT_EXCLUDED_PREFIX = 'progress-delivery';
type Emit = (category: string, event: string, data: Record<string, unknown>) => void;

/** Reemit only complete ledger records; offsets name the first byte of each line in the Pod ledger. */
function reemitLedgerLines(jsonl: string, runId: string, startOffset: number, emit: Emit): number {
  let offset = startOffset;
  let lines = 0;
  for (const raw of jsonl.split('\n').slice(0, -1)) {
    const podLedgerOffset = offset;
    offset += Buffer.byteLength(raw) + 1;
    try {
      const entry: unknown = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const { category, event, data } = entry as Record<string, unknown>;
      if (typeof event !== 'string' || !event || event.startsWith(REEMIT_EXCLUDED_PREFIX)
        || !data || typeof data !== 'object' || Array.isArray(data)) continue;
      emit(typeof category === 'string' && category ? category : 'self-implement', event,
        { ...data, runId, origin: 'pod', podLedgerOffset });
      lines += 1;
    } catch (error) {
      try { debug.log('self-implement.pod', 'reemit-failed', { runId, reason: error instanceof Error ? error.message : String(error) }); }
      catch { /* Host log failure must not interrupt the ledger append or collection. */ }
    }
  }
  return lines;
}

/** Reassemble only complete, unambiguous transfers; retain good runs when another run is incomplete. */
export function parsePodLedgerChunks(logs: string): ParseResult {
  const groups = new Map<string, { total: number; chunks: Map<number, string>; reason?: string }>();
  for (const line of logs.split(/\r?\n/)) {
    if (!line.startsWith('ELANOUS_RUN_LEDGER ')) continue;
    const match = /^ELANOUS_RUN_LEDGER (\S+) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!match) {
      const runId = /^ELANOUS_RUN_LEDGER (\S+)/.exec(line)?.[1];
      if (runId) {
        const group = groups.get(runId) ?? { total: 0, chunks: new Map<number, string>() };
        group.reason = 'malformed chunk';
        groups.set(runId, group);
      }
      continue;
    }
    const [, runId, partText, totalText, chunk] = match;
    const part = Number(partText);
    const total = Number(totalText);
    const group = groups.get(runId!) ?? { total, chunks: new Map<number, string>() };
    groups.set(runId!, group);
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || part < 1 || total < 1 || part > total || chunk!.length > 8000 || group.total !== total || group.chunks.has(part)) {
      group.reason = 'invalid or duplicate chunk';
    } else {
      group.chunks.set(part, chunk!);
    }
  }
  const ledgers: Ledger[] = [];
  const error: Incomplete[] = [];
  for (const [runId, group] of groups) {
    let reason = group.reason;
    if (!reason && group.chunks.size !== group.total) reason = 'missing chunk';
    if (!reason) {
      for (let i = 1; i <= group.total; i++) {
        if (!group.chunks.has(i)) { reason = 'missing chunk'; break; }
      }
    }
    if (!reason) {
      try {
        runLedgerPath(runId);
        let encoded = '';
        for (let i = 1; i <= group.total; i++) encoded += group.chunks.get(i)!;
        const compressed = Buffer.from(encoded, 'base64');
        if (compressed.toString('base64') !== encoded) throw new Error('invalid base64');
        const raw = gunzipSync(compressed);
        const jsonl = raw.toString('utf8');
        if (!Buffer.from(jsonl, 'utf8').equals(raw)) throw new Error('invalid UTF-8');
        ledgers.push({ runId, jsonl });
      } catch (e) { reason = e instanceof Error ? e.message : String(e); }
    }
    if (reason) error.push({ runId, reason });
  }
  return error.length ? { error, ledgers } : ledgers;
}

function intakeCollectedFailure(runId: string, dir: string, log: Emit): void {
  let ledger: ReturnType<typeof loadRunLedger>;
  try { ledger = loadRunLedger(runId, dir); }
  catch { return; }
  if (!ledger) return;
  let terminalIndex = ledger.length - 1;
  while (terminalIndex >= 0 && ledger[terminalIndex]?.event !== 'run-status') terminalIndex -= 1;
  const terminal = ledger[terminalIndex];
  if (terminal?.data.runStatus !== 'failed' || !terminal.timestamp || !Number.isFinite(Date.parse(terminal.timestamp))
    || ledger.slice(terminalIndex + 1).some(entry => !TRAILING_BOOKKEEPING_EVENTS.includes(entry.event as typeof TRAILING_BOOKKEEPING_EVENTS[number]))) return;
  try {
    recordFailureEvent({ source: 'harness-run', kind: 'pod-run', ref: runId,
      summary: `Pod run ${runId} failed`, at: terminal.timestamp }, dirname(dir));
  } catch (error) {
    log('self-implement.pod', 'heal-intake-failed', { runId, reason: error instanceof Error ? error.message : String(error) });
  }
}

/** Never replace a host ledger, even if another collector races this one —
 *  except a ledger that THIS run's live follower created (`replace`): that one is a partial copy and the final is complete. */
export function collectPodLedgers(
  logs: string,
  { dir = runLedgerDir(), log = defaultPodReemit(), emit = defaultPodReemit(), replace = new Set<string>() }: {
    dir?: string;
    log?: (category: string, event: string, data: Record<string, unknown>) => void;
    emit?: Emit;
    replace?: ReadonlySet<string>;
  } = {},
): void {
  const parsed = parsePodLedgerChunks(logs);
  const ledgers = Array.isArray(parsed) ? parsed : parsed.ledgers;
  for (const { runId, reason } of Array.isArray(parsed) ? [] : parsed.error) {
    log('self-implement.pod', 'ledger-collect-incomplete', { runId, reason });
  }
  for (const { runId, jsonl } of ledgers) {
    try {
      mkdirSync(dir, { recursive: true });
      const path = runLedgerPath(runId, dir);
      const previousBytes = replace.has(runId) && existsSync(path) ? readFileSync(path).length : 0;
      writeFileSync(path, jsonl, { flag: replace.has(runId) ? 'w' : 'wx' });
      const newLines = Buffer.from(jsonl).subarray(previousBytes).toString('utf8');
      reemitLedgerLines(newLines, runId, previousBytes, emit);
      log('self-implement.pod', 'ledger-collected', { runId, lines: jsonl.split('\n').filter(Boolean).length, bytes: Buffer.byteLength(jsonl) });
      intakeCollectedFailure(runId, dir, log);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // A reattached Job may have already delivered this exact complete snapshot.
        // An unrelated host ledger (or a partial copy) must still remain untouched.
        try {
          const existing = readFileSync(runLedgerPath(runId, dir));
          const identical = existing.equals(Buffer.from(jsonl));
          log('self-implement.pod', identical ? 'ledger-collect-already-complete' : 'ledger-collect-skipped', { runId, reason: 'exists' });
          if (identical) intakeCollectedFailure(runId, dir, log);
        } catch (readError) {
          log('self-implement.pod', 'ledger-collect-incomplete', { runId, reason: readError instanceof Error ? readError.message : String(readError) });
        }
      } else log('self-implement.pod', 'ledger-collect-incomplete', { runId, reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** ⭐ 런 «도중» 원장 증분 회수(🅣 요청 2026-09-26 · 힐 루프의 runtime 성형이 Pod 판에서 성립하는 전제).
 *  호스트 폴링(15초)마다 Pod 안 `run-ledger/<runId>.jsonl` 의 «새 바이트»만 가져와 «완성된 줄»만 호스트 원장에 잇는다.
 *  ⛔ 원장 줄만 — 값·비밀·화면은 안 가져온다. ⛔ 호스트에 «남이 만든» 같은 원장이 있으면 손대지 않는다(종료 회수의 wx 규칙과 같은 뜻).
 *  ⭐ 이 추종기가 만든 파일은 종료 때 완본으로 교체된다(`owned` → collectPodLedgers 의 replace). */
export function createPodLedgerFollower(opts: {
  runId: string;
  /** Pod 안에서 셸 한 줄을 실행해 stdout 을 돌려준다(kubectl exec). */
  exec: (script: string) => { status: number | null; stdout: string; stderr: string };
  dir?: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  emit?: Emit;
  stallMinutes?: number;
  now?: () => number;
  onStall?: (message: string) => void;
}): { poll(): void; readonly owned: boolean } {
  const dir = opts.dir ?? runLedgerDir();
  const log = opts.log ?? defaultPodReemit();
  const emit: Emit = opts.emit ?? defaultPodReemit();
  const now = opts.now ?? Date.now;
  const stallMinutes = opts.stallMinutes ?? 30;
  if (!Number.isFinite(stallMinutes) || stallMinutes <= 0) throw new RangeError('stallMinutes must be positive');
  const onStall = opts.onStall ?? ((message: string) => console.error(message));
  const path = runLedgerPath(opts.runId, dir);   // runId 검증(경로·셸에 안전한 문자만)도 여기서 된다
  let offset = 0;
  let pending = '';
  let owned = false;
  let disabled = false;
  let lastProgressAt = now();
  let visibleProgressEvent: string | null = null;
  let lastActivityMeasuredAt = lastProgressAt;
  let lastActivityLogAt = -Infinity;
  let nextStallMinute = stallMinutes;
  let stalled = false;
  function checkStall(ledgerRead: boolean, activityMeasured: boolean) {
    const idleMinutes = Math.max(0, (now() - lastProgressAt) / 60_000);
    if (idleMinutes >= nextStallMinute) {
      log('self-implement.pod', 'stalled', { runId: opts.runId, lastProgressEvent: visibleProgressEvent, idleMinutes });
      const observation = ledgerRead
        ? (activityMeasured ? '원장·작업 트리 모두 조용함' : '원장 조용함')
        : '원장 못 잼';
      onStall(`[pod] 진행 없음 ${Math.floor(idleMinutes)}분 — ${observation} · 마지막 진행 ${visibleProgressEvent ?? '없음'}${activityMeasured ? '' : ' (작업 트리 못 잼)'}`);
      stalled = true;
      nextStallMinute = (Math.floor(idleMinutes / stallMinutes) + 1) * stallMinutes;
    }
  }
  return {
    get owned() { return owned; },
    poll() {
      if (disabled) return;
      if (!owned && existsSync(path)) {
        disabled = true;
        log('self-implement.pod', 'ledger-live-skipped', { runId: opts.runId, reason: 'host-ledger-exists' });
        return;
      }
      const since = `${Math.floor(lastActivityMeasuredAt / 1000)}.${String(lastActivityMeasuredAt % 1000).padStart(3, '0')}`;
      const measurementStartedAt = now();
      const until = `${Math.floor(measurementStartedAt / 1000)}.${String(measurementStartedAt % 1000).padStart(3, '0')}`;
      const r = opts.exec(`s="\${ELANOUS_STATE_DIR:-$HOME/.elanous}"; f="$s/run-ledger/${opts.runId}.jsonl"; w="$s/worktrees"; if [ -f "$f" ]; then tail -c +${offset + 1} "$f" || exit 1; fi; target=''; matches=0; for tree in "$w"/*/*.worktrees/*; do [ -e "$tree/.git" ] || continue; owner=$(git -C "$tree" config --worktree --get elanous.harness.owner 2>/dev/null) || continue; [ "$owner" = 'dev:${opts.runId}' ] || continue; target="$tree"; matches=$((matches + 1)); done; if [ "$matches" -eq 1 ]; then activity=$(find "$target" -type d \\( -name .git -o -name node_modules \\) -prune -o -type f -newermt '@${since}' ! -newermt '@${until}' -printf . 2>/dev/null) && printf '\\nELANOUS_ACTIVITY %s\\n' "\${#activity}" || printf '\\nELANOUS_ACTIVITY_ERROR\\n'; else printf '\\nELANOUS_ACTIVITY_ERROR\\n'; fi`);
      if (r.status !== 0) { log('self-implement.pod', 'ledger-live-unavailable', { runId: opts.runId, status: r.status, stderr: r.stderr.trim().slice(0, 200) }); checkStall(false, false); return; }
      const marker = r.stdout.lastIndexOf('\nELANOUS_ACTIVITY');
      const activityLine = marker < 0 ? '' : r.stdout.slice(marker + 1);
      const activityMatch = /^ELANOUS_ACTIVITY (0|[1-9]\d*)\n$/.exec(activityLine);
      const activityMeasured = !!activityMatch && Number.isSafeInteger(Number(activityMatch[1]));
      // A missing measurement trailer is still a usable ledger response unless it contains activity protocol bytes.
      const ledgerBytes = marker < 0 ? (r.stdout.includes('ELANOUS_ACTIVITY') ? '' : r.stdout) : r.stdout.slice(0, marker);
      if (activityMeasured) {
        lastActivityMeasuredAt = measurementStartedAt;
        const files = Number(activityMatch![1]);
        if (files > 0) {
          const idleMinutes = Math.max(0, (now() - lastProgressAt) / 60_000);
          if (stalled) log('self-implement.pod', 'stall-cleared', { runId: opts.runId, idleMinutes });
          stalled = false;
          lastProgressAt = now();
          visibleProgressEvent = 'worktree-activity';
          nextStallMinute = stallMinutes;
          if (now() - lastActivityLogAt >= 5 * 60_000) {
            log('self-implement.pod', 'worktree-activity', { runId: opts.runId, files });
            lastActivityLogAt = now();
          }
        }
      }
      if (!ledgerBytes) { checkStall(true, activityMeasured); return; }
      offset += Buffer.byteLength(ledgerBytes);
      const text = pending + ledgerBytes;
      const cut = text.lastIndexOf('\n');
      if (cut < 0) { pending = text; checkStall(true, activityMeasured); return; }
      const complete = text.slice(0, cut + 1);
      pending = text.slice(cut + 1);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path, complete);
      owned = true;
      const reemitted = reemitLedgerLines(complete, opts.runId, offset - Buffer.byteLength(text), emit);
      if (reemitted) {
        try { debug.log('self-implement.pod', 'reemitted', { runId: opts.runId, lines: reemitted }); }
        catch { /* The observation cannot interrupt following. */ }
      }
      log('self-implement.pod', 'ledger-live-appended', { runId: opts.runId, lines: complete.split('\n').filter(Boolean).length, bytes: Buffer.byteLength(complete), offset });
      for (const line of complete.split('\n')) {
        if (!line) continue;
        let logEvent: ReturnType<typeof ledgerLineToLogEvent>;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        const event = (entry && typeof entry === 'object' && 'event' in entry) ? entry.event : undefined;
        try {
          if (typeof event === 'string' && !event.startsWith(REEMIT_EXCLUDED_PREFIX)) {
            logEvent = ledgerLineToLogEvent(line, opts.runId);
            if (logEvent && opts.log) log(logEvent.category, logEvent.event, logEvent.data);
          }
        } catch { /* A failed host log write must not interrupt ledger following or stall accounting. */ }
        if (typeof event !== 'string' || !event || NON_PROGRESS_EVENTS.has(event)) continue;
        const idleMinutes = Math.max(0, (now() - lastProgressAt) / 60_000);
        if (stalled) log('self-implement.pod', 'stall-cleared', { runId: opts.runId, idleMinutes });
        stalled = false;
        lastProgressAt = now();
        visibleProgressEvent = logEvent?.event ?? '[redacted]';
        nextStallMinute = stallMinutes;
      }
      checkStall(true, activityMeasured);
    },
  };
}
