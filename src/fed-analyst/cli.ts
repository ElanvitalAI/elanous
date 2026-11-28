// `eln fed analyze` — the fed-analyst body's arithmetic on demand (and on a recorded chat-log window for the A/B check).
import { analyze, renderAnalysis } from './analyze.js';
import { analystNumbers, gatherInputs, loadLists, loadNumbers, syncCases, writeAnalysis, type AnalystRow } from './live.js';
import { liveProseLlm, proseLines } from './prose.js';

export async function runFedAnalyzeCli(o: { at?: string; window?: string; mail?: string; panes?: string; prose?: boolean; write?: boolean; json?: boolean }): Promise<number> {
  const at = o.at ? new Date(o.at) : new Date();
  if (!Number.isFinite(at.getTime())) { console.error(`fed analyze: bad --at ${o.at}`); return 2; }
  const numbers = loadNumbers();
  const windowMin = Number(o.window ?? numbers.window_min);
  if (!Number.isFinite(windowMin) || windowMin <= 0) { console.error(`fed analyze: bad --window ${o.window}`); return 2; }
  const lists = loadLists();
  const { inputs, unread } = await gatherInputs({ at, windowMin, ...(o.mail ? { mailFile: o.mail } : {}), ...(o.panes ? { panesFile: o.panes } : {}), lists });
  const a = analyze(inputs, { ...numbers, window_min: windowMin }, lists);
  const p = o.prose ? await proseLines(a, liveProseLlm()) : { prose: {}, model: null, used: false, why: 'not asked (--prose)' };
  const lines = renderAnalysis(a, p.prose);
  const row: AnalystRow = { at: new Date().toISOString(), windowStart: a.windowStart, windowEnd: a.windowEnd, passed: a.passed, bottleneck: a.bottleneck,
    numbers: analystNumbers(a), findings: a.findings, lines, prose: { model: p.model, used: p.used, why: p.why }, unread };
  let cases: { opened: string[]; resolved: string[] } | null = null;
  if (o.write) {
    const { effectiveInstanceRoot } = await import('../instance/resolve.js');
    const root = effectiveInstanceRoot();
    if (!writeAnalysis(root, row)) console.error('fed analyze: ledger/NOW write failed (fail-soft)');
    try { cases = syncCases(root, a, new Date(), numbers.recheck_min); } catch (e) { console.error(`fed analyze: cases skipped (${e instanceof Error ? e.message : String(e)})`); }
  }
  if (o.json) console.log(JSON.stringify({ ...row, topology: a.topology, pass: a.pass, cases }, null, 1));
  else console.log([...lines, ...(unread.length ? [`- unread (shown as ?): ${unread.join(', ')}`] : [])].join('\n'));
  return 0;
}
