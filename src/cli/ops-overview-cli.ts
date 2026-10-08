import { debug } from '../debug/log.js';
import { collectOverview, parseSince } from '../ops/overview-collect.js';
import { computeVerdict, renderOverview, unmeasuredCells, verdictExitCode, VERDICT_LABEL } from '../ops/overview.js';
import { writeStdoutJson } from './stdout-json.js';

export interface OpsOverviewOptions { json?: boolean; watch?: string | boolean; since?: string; owner?: string; version?: string }

/** 한 번 모아서 내고 exit code 를 돌려준다(RFC §A4: flowing·degraded 0 · 그 밖 3 · 수집 실패 1). */
async function once(o: OpsOverviewOptions, previous: string | null): Promise<{ code: number; verdict: string | null }> {
  const started = performance.now();
  let since: { ms: number; label: string };
  try { since = parseSince(o.since); } catch (error) { console.error(String((error as Error).message)); return { code: 1, verdict: null }; }
  try {
    const snapshot = await collectOverview({ sinceMs: since.ms, sinceLabel: since.label, ...(o.owner ? { owner: o.owner } : {}), ...(o.version ? { version: o.version } : {}) });
    const result = computeVerdict(snapshot);
    const elapsedMs = Math.round(performance.now() - started);
    const unmeasured = unmeasuredCells(snapshot);
    debug.log('ops.overview', 'computed', { verdict: result.verdict, elapsedMs, unmeasured });
    debug.flush();
    if (o.json) {
      await writeStdoutJson(JSON.stringify({ verdict: result.verdict, verdictLabel: VERDICT_LABEL[result.verdict], reasons: result.reasons, nextActions: result.nextActions,
        meta: { elapsedMs, source: 'local', unmeasured }, ...snapshot }, null, 2) + '\n');
    } else {
      const text = renderOverview(snapshot, result, { elapsedMs });
      if (previous !== null && previous !== result.verdict) console.log(`🔔 판정 바뀜: ${previous} → ${result.verdict}`);
      console.log(text);
    }
    return { code: verdictExitCode(result.verdict), verdict: result.verdict };
  } catch (error) {
    debug.log('ops.overview', 'failed', { reason: String(error) });
    debug.flush();
    console.error(`ops overview 수집 실패: ${String(error)}`);
    return { code: 1, verdict: null };
  }
}

export async function runOpsOverview(o: OpsOverviewOptions): Promise<number> {
  // 독립 CLI 프로세스는 데몬 StoreSink 를 물려받지 않는다 — 등록 없이는 debug.log 가 logs.db 에 안 닿는다(관측 안 한 것).
  try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli'); } catch { /* fail-open */ }
  if (o.watch === undefined || o.watch === false) return (await once(o, null)).code;
  const seconds = o.watch === true ? 30 : Number(o.watch);
  if (!Number.isFinite(seconds) || seconds < 5) { console.error('--watch 는 5초 이상'); return 1; }
  let previous: string | null = null;
  for (;;) {
    if (!o.json) process.stdout.write('\x1b[2J\x1b[H');
    const r = await once(o, previous);
    previous = r.verdict ?? previous;
    await new Promise((res) => setTimeout(res, seconds * 1000));
  }
}
