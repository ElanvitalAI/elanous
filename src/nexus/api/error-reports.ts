// ER2 — the Primary side of error reports. The bot VM forwards each accepted report here over the tailnet
// (ingest token). It is stored under <instance>/error-reports/YYYY/MM/DD/<reportId>.json for 30 days, and the
// operator gets one Telegram line per distinct error per hour — never the message, stack or identity.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import type { ReceivedReport } from '../../hooks/error-report.js';
import { validateErrorReport } from '../../hooks/error-report.js';
import { jsonResponse } from './json-response.js';
import { routeOutboundInProcess } from './outbound-report.js';

export const ERROR_REPORT_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ErrorReportIngestDeps {
  root?: () => string;
  now?: () => number;
  /** Operator alert. Default = the daemon's in-process router (never a self-call · OB8). */
  alert?: (text: string, kind: string) => Promise<boolean>;
}

function storeDir(root: string): string { return join(root, 'error-reports'); }

/** Removes day folders older than the keep window. Returns how many days were removed. */
export function pruneErrorReports(root: string, now: number): number {
  const base = storeDir(root);
  if (!existsSync(base)) return 0;
  let removed = 0;
  for (const year of readdirSync(base).filter((n) => /^\d{4}$/.test(n))) {
    for (const month of readdirSync(join(base, year)).filter((n) => /^\d{2}$/.test(n))) {
      for (const day of readdirSync(join(base, year, month)).filter((n) => /^\d{2}$/.test(n))) {
        const at = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
        if (Number.isFinite(at) && now - at > ERROR_REPORT_KEEP_DAYS * DAY_MS + DAY_MS) {
          rmSync(join(base, year, month, day), { recursive: true, force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}

/** One alert per dedupe per hour, remembered on disk so a restart does not repeat it. */
function shouldAlert(root: string, dedupe: string, now: number): boolean {
  const path = join(storeDir(root), 'alerts.json');
  let seen: Record<string, number> = {};
  try { seen = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>; } catch { /* first alert */ }
  for (const [k, t] of Object.entries(seen)) if (now - t > DAY_MS) delete seen[k];
  const last = seen[dedupe];
  if (last !== undefined && now - last < 3600_000) return false;
  seen[dedupe] = now;
  mkdirSync(storeDir(root), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(seen), { mode: 0o600 });
  return true;
}

export function errorReportAlertText(item: ReceivedReport, count24h: number): string {
  const r = item.report;
  return `🧯 오류 보고 ${r.code} · v${r.app.version} · ${r.app.surface} · 같은 오류 24h ${count24h}회 · ${item.reportId}`;
}

/** Same dedupe stored in the last 24 h, counted from the store itself. */
function count24h(root: string, dedupe: string, now: number): number {
  let n = 0;
  for (const offset of [0, 1]) {
    const d = new Date(now - offset * DAY_MS);
    const dir = join(storeDir(root), String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const item = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ReceivedReport;
        if (item.dedupe === dedupe && now - Date.parse(item.receivedAt) < DAY_MS) n++;
      } catch { /* a broken file is not counted */ }
    }
  }
  return n;
}

/** POST /v1/reports/ingest — the caller (router) has already checked the ingest token. */
export async function handleErrorReportIngest(req: Request, deps: ErrorReportIngestDeps = {}): Promise<Response> {
  const root = (deps.root ?? effectiveInstanceRoot)();
  const now = (deps.now ?? Date.now)();
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid', field: 'body' }, 400); }
  const item = body as Partial<ReceivedReport>;
  if (typeof item.reportId !== 'string' || !/^er_[0-9a-z]{26}$/.test(item.reportId)) return jsonResponse({ error: 'invalid', field: 'reportId' }, 400);
  if (typeof item.dedupe !== 'string' || !/^[0-9a-f]{12}$/.test(item.dedupe)) return jsonResponse({ error: 'invalid', field: 'dedupe' }, 400);
  if (typeof item.receivedAt !== 'string' || !Number.isFinite(Date.parse(item.receivedAt))) return jsonResponse({ error: 'invalid', field: 'receivedAt' }, 400);
  const checked = validateErrorReport(item.report);
  if (!checked.ok) return jsonResponse({ error: 'invalid', field: `report.${checked.field}` }, 400);
  const stored: ReceivedReport = { reportId: item.reportId, dedupe: item.dedupe, receivedAt: item.receivedAt, report: checked.report };
  const at = new Date(Date.parse(stored.receivedAt));
  const dir = join(storeDir(root), String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${stored.reportId}.json`), JSON.stringify(stored), { mode: 0o600 });
  let pruned = 0;
  try { pruned = pruneErrorReports(root, now); } catch { /* pruning never blocks a receipt */ }
  const count = count24h(root, stored.dedupe, now);
  const alerted = shouldAlert(root, stored.dedupe, now);
  debug.log('error-report.ingest', 'stored', { code: stored.report.code, surface: stored.report.app.surface, count24h: count, alerted, pruned });
  if (alerted) {
    const alert = deps.alert ?? routeOutboundInProcess;
    void Promise.resolve().then(() => alert(errorReportAlertText(stored, count), 'alert'))
      .catch((error: unknown) => debug.log('error-report.ingest', 'alert-failed', { reason: error instanceof Error ? error.message : String(error) }));
  }
  return jsonResponse({ stored: true, reportId: stored.reportId, count }, 202);
}
