#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { debug, redactSecrets } from '../src/debug/log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { DecisionLedger } from '../src/decisions/decision-ledger.js';
import { effectiveInstanceRoot, prodInstanceRoot, releaseLedgerRoot } from '../src/instance/resolve.js';
import { listMemories } from '../src/memory.js';
import { listSchedules, getSchedule } from '../src/release-loop/release-schedule.js';
import { listChecklist, summarizeChecklist } from '../src/release-loop/checklist.js';
import { getUserConfig } from '../src/user-config.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';

export type ProbeKind = 'cut' | 'green' | 'open';
export type ProbeVerdict = 'match' | 'mismatch' | 'pending' | 'unmeasured';
export interface ProbeRow {
  ts: string;
  question: string;
  verdict: ProbeVerdict;
  botValue: string | number | null;
  ledgerValue: string | number | null;
  opsNowUpdatedAt: string | null;
  reason: string | null;
  botReply: string | null;
}
export const STANDARD_QUESTIONS: ReadonlyArray<{ kind: ProbeKind; ask: (version: string) => string }> = [
  { kind: 'cut', ask: (version) => `${version} 컷 언제야?` },
  { kind: 'green', ask: (version) => `${version} 체크리스트 초록 몇 개야?` },
  { kind: 'open', ask: () => '지금 미결 결정 몇 개야?' },
];

export interface ProbeDeps {
  schedules?: () => Promise<Array<{ version: string; cutAt: string }>> | Array<{ version: string; cutAt: string }>;
  published?: (version: string) => Promise<boolean> | boolean;
  cut?: (version: string) => Promise<string | null> | string | null;
  green?: (version: string) => Promise<number> | number;
  open?: () => Promise<number> | number;
  ask?: (question: string, model?: string) => Promise<string>;
  send?: typeof sendOutbound;
  memoryUpdatedAt?: () => string | null;
  model?: () => string | undefined;
  root?: string;
  now?: () => Date;
  print?: (line: string) => void;
  observe?: (question: string, verdict: ProbeVerdict, reason: string | null) => void;
}
export interface ProbeOptions { version?: string; dryRun?: boolean; json?: boolean }

function kstDate(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

const CUT_ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})(?!\d)/g;
const CUT_LOCAL = /(?:(\d{4})\s*[년./-]\s*)?(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*(?:일)?(?:\s*\([^)]*\))?(?:\s*(?:오전|오후|AM|PM))?\s*(\d{1,2})\s*(?:시\s*(\d{1,2})\s*분?|:\s*(\d{2}))(?!\d)\s*(?:KST|한국시간)?/gi;

function cutValue(text: string): string | null {
  const iso = new RegExp(CUT_ISO.source).exec(text)?.[0];
  if (iso && Number.isFinite(Date.parse(iso))) return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16);
  const match = new RegExp(CUT_LOCAL.source, 'i').exec(text);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : null;
  const month = Number(match[2]), day = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5] ?? match[6]);
  if (/오후|PM/i.test(match[0]) && hour < 12) hour += 12;
  if (/오전|AM/i.test(match[0]) && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return `${year ?? '????'}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizedCut(value: string, reference?: string): string | null {
  const parsed = cutValue(value);
  if (!parsed) return null;
  if (parsed.startsWith('????-') && reference) return `${reference.slice(0, 4)}${parsed.slice(4)}`;
  return parsed;
}

function ledgerCutValue(value: string): string | null {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis + 9 * 3_600_000).toISOString().slice(0, 16);
}

type ParsedValue<T> = { value: T | null; ambiguous: boolean };
type Candidate<T> = { start: number; end: number; value: T };

function selectClaim<T>(reply: string, candidates: Candidate<T>[]): ParsedValue<T> {
  if (candidates.length === 1) {
    const after = reply.slice(candidates[0]!.end);
    if (/^\s*(?:개|건|KST|한국시간)?\s*(?:가|이|은|는)?\s*(?:아닙니다|아니다|아니에요|아님|아닌|말고)/i.test(after)) {
      return { value: null, ambiguous: true };
    }
    return { value: candidates[0]!.value, ambiguous: false };
  }
  if (candidates.length === 2) {
    const between = reply.slice(candidates[0]!.end, candidates[1]!.start);
    // «57개가 아니라 50개» · «3개, 아니 4개» — the later value is the asserted one.
    if (/^(?:\s*(?:개|건|KST|한국시간))?\s*(?:가|이|은|는)?\s*(?:아니라|아닌|말고|[,，]?\s*아니(?:요|고)?\s*[,，]?)\s*$/i.test(between)) {
      return { value: candidates[1]!.value, ambiguous: false };
    }
  }
  return { value: null, ambiguous: candidates.length > 1 };
}

const NEGATED_AFTER = /^\s*(?:개|건)?\s*(?:가|이|은|는)?\s*(?:아닙니다|아니다|아니에요|아님|아닌|말고)/i;
// A number counts as the metric only when it carries a unit (개·건) or sits right after the label («초록은 57»).
// Anything else (a version «0.2.10판», a date) is not a claim about the count — unmeasured, never a false drift.
const DIRECT_AFTER_LABEL = /^\s*(?:은|는|이|가|도|:|=)?\s*(?:총|현재|지금|모두|전부)?\s*$/;

function countValue(reply: string, kind: 'green' | 'open'): ParsedValue<number> {
  const label = kind === 'green' ? /(?:초록|녹색|green|🟢)/i : /(?:미결\s*결정|열린\s*결정|open\s*decisions?|미결)/i;
  const found = label.exec(reply);
  if (!found) {
    const bare = /^\s*(\d[\d,]*)\s*(?:개|건)?[.。!\s]*$/.exec(reply);
    if (!bare) return { value: null, ambiguous: false };
    const value = Number(bare[1]!.replaceAll(',', ''));
    return Number.isSafeInteger(value) && value >= 0 ? { value, ambiguous: false } : { value: null, ambiguous: false };
  }
  const answer = reply.slice(found.index + found[0].length);
  const candidates: Candidate<number>[] = [];
  for (const match of answer.matchAll(/(?<![\d.])\d[\d,]*(?![\d.])/g)) {
    const value = Number(match[0].replaceAll(',', ''));
    if (!Number.isSafeInteger(value) || value < 0) continue;
    const end = match.index + match[0].length;
    const unit = /^\s*(?:개|건)/.test(answer.slice(end));
    const direct = DIRECT_AFTER_LABEL.test(answer.slice(0, match.index));
    if (unit || direct) candidates.push({ start: match.index, end, value });
  }
  if (candidates.length) return selectClaim(answer, candidates);
  // Number before the label («57개가 초록», «57개 초록이 아닙니다») — keep the negation that follows the label.
  const reverse = new RegExp(`(?<![\\d.])(\\d[\\d,]*)(?![\\d.])\\s*(?:개|건)?\\s*(?:가|이|의)?\\s*${label.source}`, 'i').exec(reply);
  if (!reverse) return { value: null, ambiguous: false };
  const tail = reply.slice(reverse.index + reverse[0].length);
  if (NEGATED_AFTER.test(tail)) return { value: null, ambiguous: true };
  const value = Number(reverse[1]!.replaceAll(',', ''));
  return Number.isSafeInteger(value) && value >= 0 ? { value, ambiguous: false } : { value: null, ambiguous: false };
}

function replyValue(kind: ProbeKind, reply: string, ledger: string | number): ParsedValue<string | number> {
  if (kind !== 'cut') return countValue(reply, kind);
  const candidates: Candidate<string>[] = [];
  for (const match of reply.matchAll(CUT_ISO)) {
    const value = normalizedCut(match[0], String(ledger));
    if (value) candidates.push({ start: match.index, end: match.index + match[0].length, value });
  }
  for (const match of reply.matchAll(CUT_LOCAL)) {
    if (candidates.some((candidate) => match.index < candidate.end && match.index + match[0].length > candidate.start)) continue;
    let value = normalizedCut(match[0], String(ledger));
    const zone = /^\s*(UTC|GMT|Z\b|[A-Z]{2,4}T\b|[+-]\d{1,2}(?::?\d{2})?\b)\s*([+-]\d{1,2}(?::?\d{2})?)?/i.exec(reply.slice(match.index + match[0].length));
    if (value && zone && !/KST/i.test(match[0])) {
      // A written zone other than KST: UTC/GMT converts (+9h); any other zone or offset is not guessed — unmeasured.
      if (/^(?:UTC|GMT|Z)$/i.test(zone[1]!) && !zone[2] && !value.startsWith('????')) {
        const millis = Date.parse(`${value}:00Z`);
        value = Number.isFinite(millis) ? new Date(millis + 9 * 3_600_000).toISOString().slice(0, 16) : null;
      } else value = null;
    }
    if (value) candidates.push({ start: match.index, end: match.index + match[0].length + (zone && !/KST/i.test(match[0]) ? zone[0].length : 0), value });
  }
  candidates.sort((a, b) => a.start - b.start);
  const valid = candidates.filter(({ value: parsed }) => {
    const millis = Date.parse(`${parsed}:00Z`);
    return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 16) === parsed;
  });
  return selectClaim(reply, valid);
}

function askBot(question: string, model?: string): Promise<string> {
  const root = effectiveInstanceRoot();
  return new Promise((resolve, reject) => {
    const args = ['bin/elanous.mjs', ...(root === prodInstanceRoot() ? [] : [`--test=${root}`]), 'ask', question, '--json'];
    const child = spawn('bun', args, {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, ...(model ? { ELANOUS_LLM_MODEL: model } : {}) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let tooLong = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error('timeout')); }, 90_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 1024 * 1024) { tooLong = true; child.kill(); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('timeout'));
      if (tooLong) return reject(new Error('bot-output-too-large'));
      if (code !== 0) return reject(new Error('bot-error'));
      try {
        const result = JSON.parse(out) as { reply?: unknown; error?: unknown };
        if (typeof result.reply !== 'string') throw new Error('bot-no-reply');
        resolve(result.reply);
      } catch { reject(new Error('bot-no-reply')); }
    });
  });
}

function isPublished(version: string, releaseRoot: string): boolean {
  try {
    const record = JSON.parse(readFileSync(join(releaseRoot, 'release', version, 'release.json'), 'utf8')) as { publishedAt?: unknown; version?: unknown };
    return record.version === version && typeof record.publishedAt === 'string';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ledgerOpen(): number { return new DecisionLedger().list({ status: 'open' }).length; }
function memoryUpdatedAt(): string | null { return listMemories().find((entry) => entry.name === 'ops-now')?.updatedAt ?? null; }
function probeModel(): string | undefined {
  const config = getUserConfig().raw.opsNowProbe;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const model = (config as Record<string, unknown>).model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

export async function runOpsNowProbe(options: ProbeOptions = {}, deps: ProbeDeps = {}): Promise<{ rows: ProbeRow[]; exitCode: number; alert: string | null }> {
  const now = (deps.now ?? (() => new Date()))();
  const root = deps.root ?? effectiveInstanceRoot();
  const releaseRoot = releaseLedgerRoot();
  let version = options.version;
  if (!version) {
    try {
      if (!deps.schedules && !existsSync(join(releaseRoot, 'release', 'features.sqlite'))) throw new Error('ledger-unreadable');
      const schedules = await (deps.schedules ?? (() => listSchedules(releaseRoot)))();
      const ordered = schedules.filter((row) => Number.isFinite(Date.parse(row.cutAt)))
        .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
      for (const row of ordered) {
        if (!await (deps.published ?? ((v) => isPublished(v, releaseRoot)))(row.version)) {
          version = row.version;
          break;
        }
      }
    } catch { /* A missing version makes the two release questions unmeasured. */ }
  }
  const updatedAt = (() => { try { return (deps.memoryUpdatedAt ?? memoryUpdatedAt)(); } catch { return null; } })();
  let model: string | undefined;
  try { model = deps.model ? deps.model() : probeModel(); } catch { /* Use the ask path's configured model. */ }
  const rows: ProbeRow[] = [];
  for (const item of STANDARD_QUESTIONS) {
    const question = item.ask(version ?? '(판 미상)');
    let ledgerValue: string | number | null = null;
    let reason: string | null = null;
    try {
      if (item.kind !== 'open' && !version) throw new Error('ledger-unreadable');
      if (item.kind === 'green' && !deps.green && !existsSync(join(releaseRoot, 'release', 'features.sqlite')) && !existsSync(join(releaseRoot, 'release', version!, 'checklist.json'))) throw new Error('ledger-unreadable');
      if (item.kind === 'open' && !deps.open && !existsSync(new DecisionLedger().path)) throw new Error('ledger-unreadable');
      const value = item.kind === 'cut' ? await (deps.cut ?? ((v) => getSchedule(v, releaseRoot)?.cutAt ?? null))(version!)
        : item.kind === 'green' ? await (deps.green ?? ((v) => summarizeChecklist(listChecklist(v)).green))(version!) : await (deps.open ?? ledgerOpen)();
      if (item.kind === 'cut') ledgerValue = typeof value === 'string' ? ledgerCutValue(value) : null;
      else ledgerValue = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      if (ledgerValue === null) reason = 'ledger-unreadable';
    } catch { reason = 'ledger-unreadable'; }
    let reply: string | null = null;
    let botValue: string | number | null = null;
    try { reply = await (deps.ask ?? askBot)(question, model); }
    catch (error) { if (!reason) reason = (error as Error).message === 'timeout' ? 'timeout' : 'bot-unresponsive'; }
    let verdict: ProbeVerdict = 'unmeasured';
    if (!reason) {
      if (!reply?.trim()) reason = 'bot-unresponsive';
      else if (/확인\s*(?:중|해\s*보겠|해\s*볼게|해\s*보도록|이\s*필요)|조회\s*중|살펴\s*보겠/.test(reply)) { verdict = 'pending'; reason = 'bot-pending'; }
      else {
        const parsed = replyValue(item.kind, reply, ledgerValue!);
        botValue = parsed.value;
        if (botValue === null) reason = parsed.ambiguous ? 'value-ambiguous' : 'value-unparseable';
        else verdict = botValue === ledgerValue ? 'match' : 'mismatch';
      }
    }
    const row: ProbeRow = { ts: now.toISOString(), question, verdict, botValue, ledgerValue, opsNowUpdatedAt: updatedAt,
      reason, botReply: reply === null ? null : redactSecrets({ reply }).reply.slice(0, 200) };
    rows.push(row);
    debug.log('ops-now.probe', 'verdict', { question, verdict, reason });
    deps.observe?.(question, verdict, reason);
  }
  const path = join(root, 'ops-now-probe', `${kstDate(now)}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const mismatches = rows.filter((row) => row.verdict === 'mismatch');
  const alert = mismatches.length ? `🚨 ops-now 봇 답 불일치 — ${mismatches.map((row) => `${row.question} 봇 ${row.botValue} / 원장 ${row.ledgerValue}`).join(' · ')} · ops-now updatedAt ${updatedAt ?? '미상'}` : null;
  let alertDelivery: 'sent' | 'failed' | 'dry-run' | null = alert ? (options.dryRun ? 'dry-run' : 'failed') : null;
  if (alert && !options.dryRun) {
    try {
      if (await (deps.send ?? sendOutbound)(alert, 'ops-alert')) alertDelivery = 'sent';
    } catch {
      // A throwing sender has the same undelivered outcome as a false return.
    }
    if (alertDelivery === 'failed') debug.log('ops-now.probe', 'alert-failed', { kind: 'ops-alert' });
  }
  const print = deps.print ?? console.log;
  const warning = [
    ...(rows.some((row) => row.verdict === 'unmeasured') ? ['⚠ 측정하지 못한 질문이 있습니다.'] : []),
    ...(alertDelivery === 'failed' ? ['⚠ ops-alert 전송 실패'] : []),
  ].join(' ') || null;
  if (options.json) print(JSON.stringify({ version: version ?? null, rows, alert, alertDelivery, warning, wouldSend: Boolean(alert && options.dryRun), exitCode: mismatches.length ? 1 : 0 }));
  else {
    for (const row of rows) print(`${row.verdict} · ${row.question} · 봇 ${row.botValue ?? '-'} · 원장 ${row.ledgerValue ?? '-'}${row.reason ? ` · ${row.reason}` : ''}`);
    if (warning) print(warning);
    if (alert) {
      if (alertDelivery === 'dry-run') print(`보냈을 것: ${alert}`);
      else if (alertDelivery === 'sent') print(alert);
    }
  }
  return { rows, exitCode: mismatches.length ? 1 : 0, alert };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  let version: string | undefined;
  let dryRun = false, json = false, once = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once') once = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--version' && args[i + 1] && !args[i + 1]!.startsWith('--')) version = args[++i];
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!once) throw new Error('--once 필요');
  await registerStandaloneLogSink('ops-now-probe');
  return (await runOpsNowProbe({ version, dryRun, json })).exitCode;
}

if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`ops-now-probe: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
