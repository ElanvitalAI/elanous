// INVEST-PANEL-NL (대표 11-26 14:1x) — «삼성전자 2027 전망 전문가 패널로 분석해줘» in eln → the Invest Research Board runs
// LIVE (real sources, one els tab per child agent, tabs closed at the end) and its 최종 결론 comes back in chat.
// The orchestration planner/tool picks this preset before any orchestration/v1 template: the board is its own graph
// (graphs/demo/invest-orch), so the preset is a small plan file (`*.invest.json`) and the run is `eln demo invest board`.
// Pure parse + argv here; the tool (tool.ts) spawns and reads the pin for the conclusion.
import { readFileSync } from 'node:fs';

export const INVEST_PANEL_PRESET = 'invest-panel';
export const INVEST_PLAN_SUFFIX = '.invest.json';

/** Korean / English company names → KRX tickers (Yahoo-style `.KS`, what `demo invest board --ticker` takes). */
export const KRX_TICKERS: ReadonlyArray<{ readonly names: readonly string[]; readonly ticker: string }> = [
  { names: ['삼성전자', '삼성', 'samsung electronics', 'samsung'], ticker: '005930.KS' },
  { names: ['sk하이닉스', '에스케이하이닉스', '하이닉스', 'sk hynix', 'skhynix', 'hynix'], ticker: '000660.KS' },
  { names: ['현대차', '현대자동차', 'hyundai motor', 'hyundai'], ticker: '005380.KS' },
  { names: ['naver', '네이버'], ticker: '035420.KS' },
  { names: ['카카오', 'kakao'], ticker: '035720.KS' },
];

export interface InvestPanelGoal {
  readonly ticker: string;
  /** The company as the person said it (or the ticker when only a ticker was given). */
  readonly company: string;
  readonly year?: string;
  /** The research question shown on the board — the person's own words. */
  readonly question: string;
}

/** The cue: an expert panel asked about an outlook/analysis («전문가 패널로 분석», «패널 전망», «expert panel»). */
const PANEL_CUE = /전문가\s*패널|투자\s*패널|패널(로|이|에게)?\s*(분석|전망|토론|평가)|expert\s+panel|invest(ment)?\s+panel/iu;
const SLASH = /^\/(?:orch|invest)\b\s*/iu;
const TICKER = /\b(\d{6})(?:\.(KS|KO|KQ))?\b|\b([A-Z]{1,5}(?:\.[A-Z]{2})?)\b/u;

/** «<회사/티커> <연도> 전망 전문가 패널로 분석해줘» → ticker + question, or undefined when it is not that request.
 *  Known names map to KRX tickers; an unknown company or ticker passes through as given. `/invest` needs no cue. */
export function parseInvestPanelGoal(text: string): InvestPanelGoal | undefined {
  const raw = text.trim();
  const explicit = /^\/invest\b/iu.test(raw);
  const body = raw.replace(SLASH, '').trim();
  if (!body || (!explicit && !PANEL_CUE.test(body))) return undefined;
  const year = /\b(20\d{2})\s*년?/u.exec(body)?.[1];
  const lower = body.toLowerCase().replace(/\s+/gu, ' ');
  const squashed = lower.replace(/\s+/gu, '');
  let best: { ticker: string; name: string; at: number } | undefined;
  for (const entry of KRX_TICKERS) {
    for (const name of entry.names) {
      const at = name.includes(' ') ? lower.indexOf(name) : squashed.indexOf(name.replace(/\s+/gu, ''));
      // Earliest mention wins; at the same spot the longer name («SK하이닉스» over «하이닉스»).
      if (at >= 0 && (!best || at < best.at || (at === best.at && name.length > best.name.length))) best = { ticker: entry.ticker, name, at };
    }
  }
  if (best) return { ticker: best.ticker, company: companyAsSaid(body, best.name), ...(year ? { year } : {}), question: body };
  const t = TICKER.exec(body);
  if (t) {
    const ticker = t[1] ? `${t[1]}.${t[2] === 'KQ' ? 'KQ' : 'KS'}` : t[3]!;
    return { ticker, company: ticker, ...(year ? { year } : {}), question: body };
  }
  // Unknown company: the first word before the year/«전망»/the cue, passed through as given.
  const head = body.split(/\s+/u)[0]?.replace(/[의은는이가을를]$/u, '');
  if (!head || /^20\d{2}/u.test(head) || PANEL_CUE.test(head)) return undefined;
  return { ticker: head, company: head, ...(year ? { year } : {}), question: body };
}

function companyAsSaid(body: string, name: string): string {
  const at = body.toLowerCase().indexOf(name);
  return at >= 0 ? body.slice(at, at + name.length) : name;
}

/** argv after the eln binary: the live board with its child tabs, closed at the end, recorded as a pin. */
export function investBoardArgv(goal: InvestPanelGoal, record: string): string[] {
  return ['demo', 'invest', 'board', '--ticker', goal.ticker, '--question', goal.question, '--els', '--close-tabs', '--record', record];
}

/** The plan as the person reads it before confirming (English, product text). */
export function describeInvestPlan(goal: InvestPanelGoal): string {
  return [
    `Goal: ${goal.question}`,
    `Preset: ${INVEST_PANEL_PRESET}  (Invest Research Board, live)`,
    `Company: ${goal.company} → ${goal.ticker}${goal.year ? ` · ${goal.year}` : ''}`,
    'Runs: news · X · filings/DART · price/flows → factsheet → expert panel (eln · codex · claude) → consensus → judge → 최종 결론',
    'Tabs: one els tab per child agent in workspace «invest-demo», closed when the run ends. Takes about 3–4 minutes.',
  ].join('\n');
}

interface PinEvent { readonly kind: string; readonly phase?: string; readonly status?: string; readonly result?: { action?: string; thesis?: string; confidence?: number; consensus?: { action?: string; score?: number; confidencePct?: number; answered?: number; of?: number }; bull?: string[]; bear?: string[]; sources?: Array<{ label: string; url: string }> } }

/** The board's 최종 결론 from a recorded pin: action · thesis · consensus · reasons · sources. Undefined until the run ends. */
export function investConclusion(pinText: string): { status: string; text: string } | undefined {
  let pin: { events?: PinEvent[] };
  try { pin = JSON.parse(pinText) as typeof pin; } catch { return undefined; }
  const events = pin.events ?? [];
  const end = [...events].reverse().find((e) => e.kind === 'run' && e.phase === 'end');
  if (!end) return undefined;
  const r = [...events].reverse().find((e) => e.kind === 'result')?.result;
  if (!r) return { status: end.status ?? 'failed', text: 'The run ended without a conclusion (no report).' };
  const c = r.consensus;
  const lines = [
    `최종 결론: ${r.action ?? '?'}${typeof r.confidence === 'number' ? ` · confidence ${Math.round(r.confidence * 100)}%` : ''}`,
    ...(r.thesis ? [r.thesis] : []),
    ...(c ? [`Panel consensus: ${c.action ?? '?'} (score ${c.score ?? '?'} · ${c.answered ?? '?'}/${c.of ?? '?'} answered${c.confidencePct !== undefined ? ` · ${c.confidencePct}%` : ''})`] : []),
    ...(r.bull ?? []).slice(0, 3).map((b) => `+ ${b}`),
    ...(r.bear ?? []).slice(0, 3).map((b) => `− ${b}`),
    ...((r.sources ?? []).length ? [`출처: ${(r.sources ?? []).slice(0, 5).map((s) => `${s.label} ${s.url}`).join(' · ')}`] : []),
    'Research demo. Not investment advice. No order is placed.',
  ];
  return { status: end.status ?? 'done', text: lines.join('\n') };
}

export function readInvestConclusion(pinPath: string): { status: string; text: string } | undefined {
  try { return investConclusion(readFileSync(pinPath, 'utf8')); } catch { return undefined; }
}
