// ER1 — 액티브 덤퍼 «보내는 쪽». 사용자 기기에서 오류가 나면 운영이 알게 한다(대표 10-01 22:0x).
// 계약 v1 = TC 10-01 22:16(채널 #20798 · ER2): POST https://hooks.elanous.ai/v1/reports · ≤64KiB · consent:true 필수 ·
// installId = 무작위 UUID · email/telegramUser 는 «신원도 함께» 동의 때만 · nexus.instance 는 해시 12자 · dedupe 는 수신기가 만든다.
// 규칙: 비밀·홈 경로를 지운 뒤에만 보낸다 · 실패하면 한 부만 남겨 다음 시작 때 한 번(하루 최대 한 번) · 절대 던지지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { codeRevision, packageVersion } from '../version/code-revision.js';
import { getUserConfig } from '../user-config.js';

export const ERROR_REPORT_URL = 'https://hooks.elanous.ai/v1/reports';
const MAX_BYTES = 64 * 1024;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const SEND_TIMEOUT_MS = 5_000;
const RETRY_GAP_MS = 24 * 60 * 60_000;
const SAME_ERROR_GAP_MS = 60 * 60_000;

export type ReportSurface = 'tui' | 'pwa' | 'cli' | 'daemon';

export interface ErrorReportInput { code: string; message: string; stack?: string; surface: ReportSurface }

export interface ErrorReport {
  kind: 'error-report'; v: 1; code: string; message: string; stack?: string;
  app: { version: string; sha: string; surface: ReportSurface; os: string; arch: string };
  nexus: { alive: boolean; version?: string; instance?: string };
  who: { installId: string; email?: string; telegramUser?: string };
  at: string; consent: true;
}

export interface ErrorReportSettings { enabled: boolean; identity: boolean; email?: string; telegramUser?: string }

export interface ErrorReportDeps {
  configDir?: () => string;
  settings?: () => ErrorReportSettings;
  nexusMeta?: () => Promise<ErrorReport['nexus']>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests and the isolated test universe never reach the network. */
  enabledByEnvironment?: () => boolean;
}

/** Secrets and the home directory out, before anything leaves the machine. */
export function scrubText(text: string, home = homedir()): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home).join('~');
  return out
    .replace(/\/(Users|home)\/[^/\s'"`]+/g, '/$1/~')
    .replace(/\b(?:elt|els|ghp|gho|ghs|github_pat|xox[abpr]|sk(?:-proj|-ant)?)[-_][A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|token|apiKey|api_key|password|secret)\b(\s*[:=]\s*|\s+)["']?[^\s"',;]{6,}/gi, '$1$2[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[redacted]') // telegram bot token shape
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}

/** Frames keep only `file:line:col` — never the directory. */
export function stripStackPaths(stack: string): string {
  return stack.split('\n').map((line) => line.replace(/\(?((?:file:\/\/)?\/?[^\s()]*[/\\])([^/\\\s()]+:\d+(?::\d+)?)\)?/g, (_m, _dir: string, tail: string) => `(${tail})`)).join('\n');
}

/** One random id per install (never derived from the machine or account). */
export function installId(configDir: string): string {
  const file = join(configDir, 'install-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch { /* first time */ }
  const id = randomUUID();
  try { mkdirSync(configDir, { recursive: true }); writeFileSync(file, `${id}\n`, { mode: 0o600 }); } catch { /* id still usable this run */ }
  return id;
}

export function hash12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function cut(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

export function buildErrorReport(input: ErrorReportInput, ctx: { installId: string; settings: ErrorReportSettings; nexus: ErrorReport['nexus']; at: string }): ErrorReport {
  const code = input.code.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64) || 'unknown';
  const report: ErrorReport = {
    kind: 'error-report', v: 1, code,
    message: cut(scrubText(input.message), MAX_MESSAGE),
    ...(input.stack ? { stack: cut(scrubText(stripStackPaths(input.stack)), MAX_STACK) } : {}),
    app: { version: packageVersion(), sha: codeRevision() ?? 'unknown', surface: input.surface, os: platform(), arch: arch() },
    nexus: ctx.nexus,
    who: {
      installId: ctx.installId,
      ...(ctx.settings.identity && ctx.settings.email ? { email: ctx.settings.email } : {}),
      ...(ctx.settings.identity && ctx.settings.telegramUser ? { telegramUser: ctx.settings.telegramUser } : {}),
    },
    at: ctx.at,
    consent: true,
  };
  // Hard cap: drop the stack first, then shorten the message.
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_BYTES) delete report.stack;
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_BYTES) report.message = cut(report.message, 500);
  return report;
}

function defaultSettings(): ErrorReportSettings {
  try {
    const er = getUserConfig().errorReports;
    return { enabled: er?.enabled !== false, identity: er?.identity === true, ...(er?.email ? { email: er.email } : {}), ...(er?.telegramUser ? { telegramUser: er.telegramUser } : {}) };
  } catch { return { enabled: false, identity: false }; }
}

async function defaultNexusMeta(): Promise<ErrorReport['nexus']> {
  try {
    const { resolveDaemonEndpoint } = await import('../nexus/daemon-endpoint.js');
    const base = resolveDaemonEndpoint({ purpose: 'watch' })?.baseUrl;
    const instance = hash12(getElanousConfigDir());
    if (!base) return { alive: false, instance };
    const response = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    const body = await response.json().catch(() => ({})) as { version?: unknown };
    return { alive: response.ok, ...(typeof body.version === 'string' ? { version: body.version } : {}), instance };
  } catch { return { alive: false }; }
}

/** Never from `bun test`, and never from the isolated test universe (its config dir lives under a test root). */
function defaultEnabledByEnvironment(): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST) return false;
  try { return !/[/\\](?:test|\.elanous-test)[/\\]?/.test(getElanousConfigDir()); } catch { return false; }
}

const lastSent = new Map<string, number>();

export type ReportOutcome = { sent: true; reportId?: string } | { sent: false; reason: string };

/** Send one report — never throws, never blocks the caller beyond the send timeout. */
export async function reportError(input: ErrorReportInput, deps: ErrorReportDeps = {}): Promise<ReportOutcome> {
  try {
    if (!(deps.enabledByEnvironment ?? defaultEnabledByEnvironment)()) return { sent: false, reason: 'environment' };
    const settings = (deps.settings ?? defaultSettings)();
    if (!settings.enabled) return { sent: false, reason: 'disabled' };
    const now = (deps.now ?? Date.now)();
    const key = `${input.code}\u0000${input.message.slice(0, 200)}`;
    const previous = lastSent.get(key);
    if (previous !== undefined && now - previous < SAME_ERROR_GAP_MS) return { sent: false, reason: 'recently-sent' };
    lastSent.set(key, now);
    const configDir = (deps.configDir ?? getElanousConfigDir)();
    const report = buildErrorReport(input, {
      installId: installId(configDir), settings, nexus: await (deps.nexusMeta ?? defaultNexusMeta)(), at: new Date(now).toISOString(),
    });
    return await post(report, configDir, deps);
  } catch (error) {
    debug.log('error-report', 'failed', { reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return { sent: false, reason: 'internal' };
  }
}

async function post(report: ErrorReport, configDir: string, deps: ErrorReportDeps): Promise<ReportOutcome> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(ERROR_REPORT_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 300) {
      const body = await response.json().catch(() => ({})) as { reportId?: unknown };
      const reportId = typeof body.reportId === 'string' ? body.reportId : undefined;
      debug.log('error-report', 'sent', { code: report.code, surface: report.app.surface, ...(reportId ? { reportId } : {}) });
      return { sent: true, ...(reportId ? { reportId } : {}) };
    }
    keepPending(report, configDir, deps);
    debug.log('error-report', 'not-sent', { code: report.code, status: response.status });
    return { sent: false, reason: `http-${response.status}` };
  } catch (error) {
    keepPending(report, configDir, deps);
    debug.log('error-report', 'not-sent', { code: report.code, reason: error instanceof Error ? error.name : 'network' });
    return { sent: false, reason: 'network' };
  }
}

function pendingFile(configDir: string): string { return join(configDir, 'error-reports', 'pending.json'); }

/** Keep exactly one unsent report (the newest) for a later retry. */
function keepPending(report: ErrorReport, configDir: string, deps: ErrorReportDeps): void {
  try {
    mkdirSync(join(configDir, 'error-reports'), { recursive: true, mode: 0o700 });
    writeFileSync(pendingFile(configDir), JSON.stringify({ report, lastTry: (deps.now ?? Date.now)() }), { mode: 0o600 });
  } catch { /* nothing else to do */ }
}

/** At start-up: retry the one kept report, at most once a day. */
export async function retryPendingErrorReport(deps: ErrorReportDeps = {}): Promise<ReportOutcome> {
  try {
    if (!(deps.enabledByEnvironment ?? defaultEnabledByEnvironment)()) return { sent: false, reason: 'environment' };
    if (!(deps.settings ?? defaultSettings)().enabled) return { sent: false, reason: 'disabled' };
    const configDir = (deps.configDir ?? getElanousConfigDir)();
    const file = pendingFile(configDir);
    if (!existsSync(file)) return { sent: false, reason: 'none' };
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { report: ErrorReport; lastTry: number };
    if ((deps.now ?? Date.now)() - kept.lastTry < RETRY_GAP_MS) return { sent: false, reason: 'too-soon' };
    const outcome = await post(kept.report, configDir, deps);
    if (outcome.sent) rmSync(file, { force: true });
    return outcome;
  } catch { return { sent: false, reason: 'internal' }; }
}

