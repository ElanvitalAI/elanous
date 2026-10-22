// ── Ops-ledger native tools — 우편(msg) · 판(release checklist) ──
//
// OP TUI turns previously drove `elanous msg list/post/ack` and
// `elanous release checklist list/move/set/add` through RunShell:
// 1.3–2s of CLI startup per call, 30+ spawns per turn, and the CLI's
// human-oriented stdout amplifying TUI screen defects. These
// tools reuse the SAME durable services in-process —
//
//   • msg tools → src/msg/msg-store.ts (the SQLite ledger `elanous msg`
//     reads/writes; same acknowledgement cursors, same ALL-broadcast rule)
//   • checklist tools → src/release-loop/checklist.ts + feature-store.ts
//     (the same per-version ledger, claim history, seat/OP move rules)
//
// MsgAsk joins this family through msg-ask.ts; the other dispatchers live here.
// The permission and audit contract is preserved 1:1:
//   • writes record the actor from ELANOUS_TRACK (seat identity),
//   • ChecklistMove keeps the CLI routing — anonymous (no ELANOUS_TRACK)
//     moves unchecked, a non-OP seat goes through seatMove (own cell ·
//     next version · capacity), only OP moves unrestricted,
//   • checklist writes pass the same HQ lease fence as the CLI
//     (`hqFenceDecision('ledger-cli', …)` — identical observation,
//     minus the CLI-only process.exitCode side effect),
//   • results are structured data, mirroring the CLI `--json` shapes.
//
// Budget: every call stays a local ledger read/write — no process
// spawn, no network, no running-runs sweep — so a call completes well
// under 300ms and a TUI OP turn needs zero RunShell round-trips.
//
// Output cap: a version's claim history is the bulk of the CLI `--json`
// (0.2.29: 1006 entries ≈ 630KB of ≈ 920KB). ChecklistList therefore omits
// it unless `historyLimit` asks for the newest N entries, and writes return
// only the touched cell ⊕ the summary — never the whole snapshot.
//
// Filled arguments: some models fill EVERY schema property (live 10-14,
// gpt-6-sol on ChecklistSet: disposition block · kind postpub · priority P2
// · ceoDate "" — the cell was clobbered). So the write schemas stay narrow
// (ChecklistSet = status/evidence/refs · ChecklistAdd = id/title/owner/…),
// metadata goes through ChecklistEdit one named field per call, and filled
// "" / null / [] / 0 read as absent.
//
// Observation: runtimes go through `observeLedgerCall`, which writes one
// `ops-ledger` `call` line per call (tool · ms · ok · actor · ids — never
// message bodies or evidence text), the native-call timing and audit line.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../../llm.js';
import { canonicalSeatId, openMsgStore, validateMessageEnvelope, type Message, type MsgStore } from '../../msg/msg-store.js';
import {
  addItem,
  devVersion,
  listChecklist,
  ownerMatches,
  parityGap,
  parseOwner,
  setItem,
  summarizeChecklist,
  type Checklist,
  type ChecklistItem,
  type ChecklistStatus,
  type ChecklistSummary,
} from '../../release-loop/checklist.js';
import * as checklistFeatures from '../../release-loop/feature-store.js';
import { seatMove, type PlacementPriority } from '../../release-loop/placement.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { getElanousConfigDirOverride } from '../../elanous-config-dir.js';
import { getUserConfig, userConfigPath } from '../../user-config.js';
import { hqFenceDecision, type HqDeps } from '../../hq/hq.js';
import { fileLeaseStore } from '../../hq/lease.js';
import { isIsolatedLedgerWriteRoot } from '../../hq/ledger-write-target.js';
import { debug } from '../../debug/log.js';

// ── shared helpers ──────────────────────────────────────────────────────────

/** Same release-version shape as `src/cli/release-cli.ts` (SEMVER). */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;

function requiredString(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`'${name}' must be a nonempty string`);
  return raw;
}

/** Optional string that tolerates «filled» absence. Models that fill every
 *  schema property send "" (or null) for fields they do not mean to set —
 *  live 10-14 gpt-6-sol: `owner: ""`, `ceoDate: ""`. Those read as absent. */
function filledString(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return undefined;
  return requiredString(raw, name);
}

/** Optional string array; a filled `[]` reads as absent (never «clear»). */
function filledArray(raw: unknown, name: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const values = stringArray(raw, name);
  return values.length ? values : undefined;
}

function stringArray(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error(`'${name}' must be an array of strings`);
  }
  return raw;
}

function integerArg(raw: unknown, name: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`'${name}' must be an integer between ${min} and ${max}`);
  }
  return raw;
}

/** Codename table from the active instance config — same source as the CLI. */
function checklistCodenames(): Record<string, string> {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { codenames?: Record<string, string> } };
  return raw.release?.codenames ?? {};
}

/** Resolve a version or codename alias — mirrors the CLI `checklistVersion`
 *  (default: package.json dev version with the -dev.N suffix stripped). */
function resolveChecklistVersion(input: string | undefined): string {
  const v = input ?? devVersion().replace(/-dev\.\d+$/, '');
  const resolved = RELEASE_VERSION.test(v)
    ? v
    : Object.entries(checklistCodenames()).find(([, name]) => name === v)?.[0] ?? v;
  if (!RELEASE_VERSION.test(resolved)) {
    throw new Error(`체크리스트 판 또는 별칭이 아니다: ${v} (x.y.z 또는 config release.codenames 별칭)`);
  }
  return resolved;
}

/** Seat identity recorded on ledger writes — same source as the CLI. */
function ledgerActor(): string {
  return process.env.ELANOUS_TRACK || 'cli';
}

/** Lease-store wiring for an explicitly overridden instance — mirrors the
 *  CLI `ledgerFenceDeps()` (no injected store, arbiter opt-out respected). */
function ledgerFenceDeps(): HqDeps {
  if (getElanousConfigDirOverride() && !getUserConfig().hq?.arbiter) {
    const root = effectiveInstanceRoot();
    return {
      store: fileLeaseStore(join(root, 'hq', 'lease.json')),
      seenPath: join(root, 'hq', 'seen-generation'),
      localPath: join(root, 'hq', 'local.json'),
    };
  }
  return {};
}

/** The HQ lease fence the CLI applies to `release checklist` writes.
 *  `hqFenceDecision` records the same observation (and retires the
 *  heartbeat cache) as `hqCliWriteAllowed`; the tool returns a structured
 *  refusal instead of the CLI's process.exitCode side effect.
 *  Returns null when the write may proceed. */
function ledgerWriteDenial(command: string, ledgerRoot: string): string | null {
  if (isIsolatedLedgerWriteRoot(ledgerRoot)) {
    try { debug.log('hq.fence', 'skipped-isolated', { root: ledgerRoot, command }); } catch { /* observation is fail-soft */ }
    return null;
  }
  const decision = hqFenceDecision('ledger-cli', ledgerFenceDeps());
  if (decision.run || decision.reason === 'no-lease') return null;
  return `원장 쓰기 거부 — 본부는 ${decision.holder ?? 'unknown'} gen ${decision.generation ?? 'unknown'} (${decision.reason}); 쓰기는 본부 자리로 보내라`;
}

/** Wrap one native ledger call with its timing/audit observation:
 *  `debug.log('ops-ledger', 'call', { tool, ms, ok, actor, … })`. `pick`
 *  chooses identifying fields from the args/result — ids only, no bodies. */
export async function observeLedgerCall<T extends Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<T>,
  pick: (args: Record<string, unknown>, result?: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const startedAt = performance.now();
  const actor = process.env.ELANOUS_TRACK || 'cli';
  try {
    const result = await run();
    try {
      debug.log('ops-ledger', 'call', {
        tool, ms: Math.round(performance.now() - startedAt), ok: result.ok !== false, actor,
        ...pick(args, result),
        ...(typeof result.error === 'string' ? { error: result.error } : {}),
      });
    } catch { /* observation is fail-soft */ }
    return result;
  } catch (error) {
    try {
      debug.log('ops-ledger', 'call', {
        tool, ms: Math.round(performance.now() - startedAt), ok: false, actor,
        ...pick(args), error: error instanceof Error ? error.message : String(error),
      });
    } catch { /* observation is fail-soft */ }
    throw error;
  }
}

export interface MsgLedgerDeps {
  /** Message-ledger opener; overridden by tests with a temp path. */
  openStore?: () => MsgStore;
}

export interface ChecklistLedgerDeps {
  /** HQ fence override for tests — returns the denial message or null. */
  fence?: (command: string, ledgerRoot: string) => string | null;
}

// ── MsgList ─────────────────────────────────────────────────────────────────

export function buildMsgListTool(): LLMToolSpec {
  return {
    name: 'MsgList',
    description:
      'List durable seat-addressed messages for one recipient WITHOUT acknowledging them — the same SQLite ledger as `elanous msg list`, in-process (no CLI startup). ' +
      'Reading never advances the acknowledgement cursor; pass an explicit `after` to page beyond it. `ALL` recipients also see broadcast messages. ' +
      'Pair with MsgPost to reply and MsgAck to advance the cursor.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient seat: OP · MK · TC · UX · ALL or another canonical seat id.' },
        after: { type: 'integer', description: 'Exclusive message ID to page beyond; leave out (or 0) to start at the recipient’s acknowledged cursor.' },
        includeAcknowledged: { type: 'boolean', description: 'true = start from the first message, including ones already acknowledged.' },
        limit: { type: 'integer', description: 'Maximum messages to return, 1–1000 (default 100).' },
      },
      required: ['to'],
      additionalProperties: false,
    },
  };
}

export interface MsgListResult extends Record<string, unknown> {
  output: string;
  ok: true;
  recipient: string;
  after: number;
  count: number;
  messages: Message[];
}

export async function dispatchMsgList(rawArgs: Record<string, unknown>, deps: MsgLedgerDeps = {}): Promise<MsgListResult> {
  const to = canonicalSeatId(requiredString(rawArgs.to, 'to'));
  const limit = rawArgs.limit === undefined || rawArgs.limit === null || rawArgs.limit === 0 ? 100 : integerArg(rawArgs.limit, 'limit', 1, 1000);
  // A filled `after: 0` means «not set» (the model fills every property);
  // reading acknowledged history is the explicit includeAcknowledged flag.
  const after = rawArgs.after === undefined || rawArgs.after === null || rawArgs.after === 0
    ? undefined
    : integerArg(rawArgs.after, 'after', 1, Number.MAX_SAFE_INTEGER);
  const store = deps.openStore?.() ?? openMsgStore();
  try {
    const start = after ?? (rawArgs.includeAcknowledged === true ? 0 : store.getCursor(to));
    const messages = store.list(to, start, limit);
    return {
      output: `MsgList ${to}: ${messages.length} message(s) after #${start}`,
      ok: true,
      recipient: to,
      after: start,
      count: messages.length,
      messages,
    };
  } finally {
    store.close();
  }
}

// ── MsgPost ─────────────────────────────────────────────────────────────────

export function buildMsgPostTool(): LLMToolSpec {
  return {
    name: 'MsgPost',
    description:
      'Post a durable seat-addressed message — the same SQLite ledger as `elanous msg post`, in-process (no CLI startup). ' +
      'The recipient sees it on their next MsgList/watch. ALL may receive but never send; `kind` tags the message; `replyTo` points a reply at a question message ID.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender seat (ALL cannot send).' },
        to: { type: 'string', description: 'Recipient seat: OP · MK · TC · UX · ALL or another canonical seat id.' },
        body: { type: 'string', description: 'Message body (nonempty).' },
        kind: { type: 'string', description: 'Optional lowercase tag (letters, digits, -, _).' },
        replyTo: { type: 'integer', description: 'Question message ID this reply points at.' },
      },
      required: ['from', 'to', 'body'],
      additionalProperties: false,
    },
  };
}

export interface MsgPostResult extends Record<string, unknown> {
  output: string;
  ok: true;
  message: Message;
}

export async function dispatchMsgPost(rawArgs: Record<string, unknown>, deps: MsgLedgerDeps = {}): Promise<MsgPostResult> {
  const envelope = validateMessageEnvelope({
    from: requiredString(rawArgs.from, 'from'),
    to: requiredString(rawArgs.to, 'to'),
    body: requiredString(rawArgs.body, 'body'),
    ...(filledString(rawArgs.kind, 'kind') === undefined ? {} : { kind: requiredString(rawArgs.kind, 'kind') }),
    ...(rawArgs.replyTo === undefined || rawArgs.replyTo === null || rawArgs.replyTo === 0
      ? {} : { replyTo: integerArg(rawArgs.replyTo, 'replyTo', 1, Number.MAX_SAFE_INTEGER) }),
  });
  const store = deps.openStore?.() ?? openMsgStore();
  try {
    const posted = store.post(envelope);
    return {
      output: `MsgPost #${posted.id} ${posted.from} → ${posted.to}`,
      ok: true,
      message: posted,
    };
  } finally {
    store.close();
  }
}

// ── MsgAck ──────────────────────────────────────────────────────────────────

export function buildMsgAckTool(): LLMToolSpec {
  return {
    name: 'MsgAck',
    description:
      'Acknowledge durable messages for one recipient through an ID — the same SQLite ledger as `elanous msg ack`, in-process. ' +
      'The recipient’s cursor advances so later MsgList calls start after the acknowledged messages.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient seat whose cursor advances.' },
        id: { type: 'integer', description: 'Acknowledge every message through this ID.' },
      },
      required: ['to', 'id'],
      additionalProperties: false,
    },
  };
}

export interface MsgAckResult extends Record<string, unknown> {
  output: string;
  ok: true;
  recipient: string;
  cursor: number;
}

export async function dispatchMsgAck(rawArgs: Record<string, unknown>, deps: MsgLedgerDeps = {}): Promise<MsgAckResult> {
  const to = canonicalSeatId(requiredString(rawArgs.to, 'to'));
  const cursor = integerArg(rawArgs.id, 'id', 0, Number.MAX_SAFE_INTEGER);
  const store = deps.openStore?.() ?? openMsgStore();
  try {
    const acknowledged = store.ack(to, cursor);
    return {
      output: `MsgAck ${to} acknowledged through #${acknowledged}`,
      ok: true,
      recipient: to,
      cursor: acknowledged,
    };
  } finally {
    store.close();
  }
}

// ── ChecklistList ───────────────────────────────────────────────────────────

export function buildChecklistListTool(): LLMToolSpec {
  return {
    name: 'ChecklistList',
    description:
      'List the release-checklist cells for one version — the same ledger as `elanous release checklist list --json`, in-process (no CLI startup). ' +
      'Returns the cells with the per-status summary, blocked cells, per-owner counts, and screen-parity warnings. Claim history is omitted unless historyLimit asks for the newest entries. Reading never mutates the ledger.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Release version or codename (default: dev version with -dev.N stripped).' },
        owner: { type: 'string', description: 'Filter cells by seat or sub-seat owner (e.g. OP · TC · MK/graphics).' },
        id: { type: 'string', description: 'Return only this cell (and, with historyLimit, only its history).' },
        historyLimit: { type: 'integer', description: 'Include the newest N claim-history entries, 0–200 (default 0 — history is omitted; it is most of the ledger’s size).' },
      },
      additionalProperties: false,
    },
  };
}

export interface ChecklistListResult extends Record<string, unknown> {
  output: string;
  ok: true;
  version: string;
  codename: string;
  released: Checklist['released'];
  dev: string;
  items: Checklist['items'];
  /** Newest `historyLimit` entries (oldest first); empty when not asked. */
  history: Checklist['history'];
  /** History entries in scope before the limit — tells the caller what was left out. */
  historyTotal: number;
  summary: ChecklistSummary;
  parity: Array<{ id: string; why: string }>;
}

export async function dispatchChecklistList(rawArgs: Record<string, unknown>): Promise<ChecklistListResult> {
  const version = resolveChecklistVersion(filledString(rawArgs.version, 'version'));
  const owner = filledString(rawArgs.owner, 'owner');
  if (owner !== undefined) parseOwner(owner);
  const id = filledString(rawArgs.id, 'id');
  const historyLimit = rawArgs.historyLimit === undefined ? 0 : integerArg(rawArgs.historyLimit, 'historyLimit', 0, 200);
  const ledgerRoot = releaseLedgerRoot();
  const snapshot = listChecklist(version, ledgerRoot);
  const data = {
    ...snapshot,
    items: snapshot.items.filter((item) => (owner === undefined || ownerMatches(item.owner, owner)) && (id === undefined || item.id === id)),
  };
  const scopedHistory = id === undefined ? snapshot.history : snapshot.history.filter((entry) => entry.id === id);
  const history = historyLimit === 0 ? [] : scopedHistory.slice(-historyLimit);
  const summary = summarizeChecklist(data);
  const parity = data.items.flatMap((item) => {
    const why = item.kind === 'screen' ? parityGap(item.evidence) : null;
    return why ? [{ id: item.id, why }] : [];
  });
  for (const { id, why } of parity) debug.log('release.checklist', 'parity-warning', { version, id, why });
  const codename = checklistCodenames()[version] ?? '';
  return {
    output: `ChecklistList ${version}${codename ? ` (${codename})` : ''}: 🟢${summary.green} · 🟡${summary.yellow} · 🔴${summary.red} · ✅${summary.done} · 칸 ${data.items.length}`,
    ok: true,
    version,
    codename,
    released: data.released,
    dev: data.dev,
    items: data.items,
    history,
    historyTotal: scopedHistory.length,
    summary,
    parity,
  };
}

// ── ChecklistAdd ───────────────────────────────────────────────────────────

export function buildChecklistAddTool(): LLMToolSpec {
  return {
    name: 'ChecklistAdd',
    description:
      'Add one cell to a release checklist — the same ledger as `elanous release checklist add`, in-process. ' +
      'HQ lease fence and claim-history audit are identical to the CLI. Only id and title are needed; leave every other field out unless the user named it. ' +
      'Kind (screen/postpub), dispatch kind, CEO load and the accelerator tier are set afterwards with ChecklistEdit. ' +
      'The CLI’s target-path warnings (git/gh probes) are omitted: they would break the sub-300ms in-process budget and are advisory only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cell id (e.g. T-1234).' },
        title: { type: 'string', description: 'Cell title.' },
        version: { type: 'string', description: 'Release version or codename (default: dev version with -dev.N stripped).' },
        owner: { type: 'string', description: 'Owner seat or sub-seat (e.g. TC · MK/graphics) — only when the user named one.' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'Only when the user named a priority.' },
        deadlineVersion: { type: 'string', description: 'Deadline version — only when the user named one.' },
        predecessors: { type: 'array', items: { type: 'string' }, description: 'Predecessor cell ids.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Evidence doc refs — repo-relative path[#section].' },
        allowDuplicateId: { type: 'boolean', description: 'Allow the same id in another version (CLI --allow-duplicate-id).' },
      },
      required: ['id', 'title'],
      additionalProperties: false,
    },
  };
}

/** Write results carry the touched cell and the version summary — never the
 *  whole snapshot (its history alone is hundreds of KB per version). */
export interface ChecklistWriteView {
  item?: ChecklistItem;
  summary?: ChecklistSummary;
}

function writeView(snapshot: Checklist, id: string): ChecklistWriteView {
  const item = snapshot.items.find((entry) => entry.id === id);
  const summary = summarizeChecklist(snapshot);
  return item ? { item, summary } : { summary };
}

export interface ChecklistAddResult extends Record<string, unknown>, ChecklistWriteView {
  output: string;
  ok: boolean;
  error?: string;
  version: string;
}

export async function dispatchChecklistAdd(rawArgs: Record<string, unknown>, deps: ChecklistLedgerDeps = {}): Promise<ChecklistAddResult> {
  const id = requiredString(rawArgs.id, 'id');
  const title = requiredString(rawArgs.title, 'title');
  const version = resolveChecklistVersion(filledString(rawArgs.version, 'version'));
  const owner = filledString(rawArgs.owner, 'owner');
  const priority = filledString(rawArgs.priority, 'priority');
  const deadlineVersion = filledString(rawArgs.deadlineVersion, 'deadlineVersion');
  const predecessors = filledArray(rawArgs.predecessors, 'predecessors');
  const refs = filledArray(rawArgs.refs, 'refs');
  const ledgerRoot = releaseLedgerRoot();
  const denial = (deps.fence ?? ledgerWriteDenial)('release checklist add', ledgerRoot);
  if (denial) return { output: `ChecklistAdd ${id} 거부`, ok: false, error: denial, version };
  const snapshot = addItem(version, {
    id,
    title,
    ...(refs !== undefined ? { refs } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(priority !== undefined ? { priority: priority as PlacementPriority } : {}),
    ...(deadlineVersion !== undefined ? { deadlineVersion } : {}),
    ...(predecessors !== undefined ? { predecessors } : {}),
  }, { allowDuplicateId: rawArgs.allowDuplicateId === true });
  return { output: `ChecklistAdd ${id} 추가 — ${version} ${snapshot.items.length}칸`, ok: true, version, ...writeView(snapshot, id) };
}

// ── ChecklistSet ───────────────────────────────────────────────────────────
//
// Status ⊕ evidence (⊕ additive refs) only. Live 10-14 (node-c, gpt-6-sol):
// the model filled EVERY optional property of the former wide patch schema
// (disposition block · kind postpub · priority P2 · ceoMinutes 0 …) and
// clobbered the cell. Metadata therefore goes through ChecklistEdit, which
// changes exactly one named field per call.

export function buildChecklistSetTool(): LLMToolSpec {
  return {
    name: 'ChecklistSet',
    description:
      'Set one release-checklist cell’s status and/or evidence line — the same ledger as `elanous release checklist set --status/--evidence`, in-process (no CLI startup). ' +
      'Pass only what changes. Invalid status transitions, the HQ lease fence and the actor audit behave exactly like the CLI. ' +
      'A screen cell turning green without the five-screen «짝:» evidence line surfaces a parityWarning. ' +
      'To change owner, priority, disposition, kind, dispatch kind, deadline, predecessors, CEO load or the accelerator tier use ChecklistEdit.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cell id.' },
        version: { type: 'string', description: 'Release version or codename (default: dev version with -dev.N stripped).' },
        status: { type: 'string', enum: ['green', 'yellow', 'red', 'done'], description: 'New status — leave out to keep the current one.' },
        evidence: { type: 'string', description: '근거 한 줄 — PR #·커밋·실측. REPLACES the current evidence (screen 칸이 green 이면 «짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 …» 줄 필요). Leave out to keep it.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Evidence doc refs to add (deduped; never removes).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export interface ChecklistSetResult extends Record<string, unknown>, ChecklistWriteView {
  output: string;
  ok: boolean;
  error?: string;
  version: string;
  parityWarning?: string;
}

export async function dispatchChecklistSet(rawArgs: Record<string, unknown>, deps: ChecklistLedgerDeps = {}): Promise<ChecklistSetResult> {
  const id = requiredString(rawArgs.id, 'id');
  const version = resolveChecklistVersion(filledString(rawArgs.version, 'version'));
  const status = filledString(rawArgs.status, 'status');
  if (status !== undefined && !['green', 'yellow', 'red', 'done'].includes(status)) throw new Error(`잘못된 상태: ${status} (green|yellow|red|done)`);
  const evidence = filledString(rawArgs.evidence, 'evidence');
  const refs = filledArray(rawArgs.refs, 'refs');
  const patch = {
    ...(refs !== undefined ? { refs } : {}),
    ...(status !== undefined ? { status: status as ChecklistStatus } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error('갱신할 칸을 지정하라 (status · evidence · refs 중 하나 — 다른 칸은 ChecklistEdit)');
  }
  const ledgerRoot = releaseLedgerRoot();
  const denial = (deps.fence ?? ledgerWriteDenial)('release checklist set', ledgerRoot);
  if (denial) return { output: `ChecklistSet ${id} 거부`, ok: false, error: denial, version };
  const snapshot = setItem(version, id, patch, ledgerActor());
  const item = snapshot.items.find((entry) => entry.id === id);
  const parityWarning = item?.kind === 'screen' && item.status === 'green' ? parityGap(item.evidence) : null;
  if (parityWarning) debug.log('release.checklist', 'parity-warning', { version, id, why: parityWarning });
  return {
    output: `ChecklistSet ${id} 갱신${parityWarning ? ` — ⚠ 짝: ${parityWarning}` : ''}`,
    ok: true,
    version,
    ...writeView(snapshot, id),
    ...(parityWarning ? { parityWarning } : {}),
  };
}

// ── ChecklistEdit ──────────────────────────────────────────────────────────

const CHECKLIST_EDIT_FIELDS = [
  'owner', 'priority', 'disposition', 'kind', 'dispatchKind', 'deadlineVersion',
  'predecessors', 'ceoMinutes', 'ceoDate', 'accelerator',
] as const;
type ChecklistEditField = typeof CHECKLIST_EDIT_FIELDS[number];

export function buildChecklistEditTool(): LLMToolSpec {
  return {
    name: 'ChecklistEdit',
    description:
      'Change exactly ONE metadata field of a release-checklist cell — the same ledger, HQ lease fence and actor audit as `elanous release checklist set --<field>`, in-process. ' +
      'Call once per field the user asked to change; status/evidence go through ChecklistSet. ' +
      'value encoding: priority P0|P1|P2 · disposition move|known-issue|block · kind screen|postpub · dispatchKind code|ops|measure|decision|umbrella · ' +
      'predecessors comma-separated ids ("" clears) · ceoMinutes integer ≥ 0 · ceoDate YYYY-MM-DD · accelerator true|false.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cell id.' },
        version: { type: 'string', description: 'Release version or codename (default: dev version with -dev.N stripped).' },
        field: { type: 'string', enum: [...CHECKLIST_EDIT_FIELDS], description: 'The one field to change.' },
        value: { type: 'string', description: 'New value, encoded as listed in the tool description.' },
      },
      required: ['id', 'field', 'value'],
      additionalProperties: false,
    },
  };
}

/** One-field patch for ChecklistEdit — `setItem` validates the value itself. */
function checklistEditPatch(field: ChecklistEditField, value: string): Record<string, unknown> {
  switch (field) {
    case 'predecessors':
      return { predecessors: value.split(/[\s,]+/).filter(Boolean) };
    case 'ceoMinutes': {
      if (!/^(0|[1-9]\d*)$/.test(value.trim())) throw new Error("'ceoMinutes' value must be an integer ≥ 0");
      return { ceoMinutes: Number(value.trim()) };
    }
    case 'accelerator':
      if (value !== 'true' && value !== 'false') throw new Error("'accelerator' value must be true or false");
      return { accelerator: value === 'true' ? true : null };
    default:
      if (!value.trim()) throw new Error(`'${field}' value must be nonempty`);
      return { [field]: value.trim() };
  }
}

export interface ChecklistEditResult extends Record<string, unknown>, ChecklistWriteView {
  output: string;
  ok: boolean;
  error?: string;
  version: string;
  field: string;
}

export async function dispatchChecklistEdit(rawArgs: Record<string, unknown>, deps: ChecklistLedgerDeps = {}): Promise<ChecklistEditResult> {
  const id = requiredString(rawArgs.id, 'id');
  const version = resolveChecklistVersion(filledString(rawArgs.version, 'version'));
  const field = requiredString(rawArgs.field, 'field');
  if (!(CHECKLIST_EDIT_FIELDS as readonly string[]).includes(field)) throw new Error(`고칠 수 없는 칸: ${field} (${CHECKLIST_EDIT_FIELDS.join('|')})`);
  if (typeof rawArgs.value !== 'string') throw new Error("'value' must be a string");
  const patch = checklistEditPatch(field as ChecklistEditField, rawArgs.value);
  const ledgerRoot = releaseLedgerRoot();
  const denial = (deps.fence ?? ledgerWriteDenial)('release checklist set', ledgerRoot);
  if (denial) return { output: `ChecklistEdit ${id} 거부`, ok: false, error: denial, version, field };
  const snapshot = setItem(version, id, patch as Parameters<typeof setItem>[2], ledgerActor());
  return { output: `ChecklistEdit ${id} ${field} 갱신`, ok: true, version, field, ...writeView(snapshot, id) };
}

// ── ChecklistMove ──────────────────────────────────────────────────────────

export function buildChecklistMoveTool(): LLMToolSpec {
  return {
    name: 'ChecklistMove',
    description:
      'Move one checklist cell to another release version in a single transaction — the same ledger and permission routing as `elanous release checklist move`, in-process. ' +
      'A seat (ELANOUS_TRACK) may move only its own cell into the next version (capacity-checked); the OP seat moves unrestricted; without ELANOUS_TRACK the move runs unchecked and is recorded as anonymous. Seat-rule violations throw.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cell id.' },
        from: { type: 'string', description: 'Current version (or codename).' },
        to: { type: 'string', description: 'Target version (or codename).' },
        reason: { type: 'string', description: 'Why the cell moves — required, recorded in the claim history.' },
      },
      required: ['id', 'from', 'to', 'reason'],
      additionalProperties: false,
    },
  };
}

export interface ChecklistMoveResult extends Record<string, unknown>, ChecklistWriteView {
  output: string;
  ok: boolean;
  error?: string;
  id: string;
  from: string;
  to: string;
  actor: string;
}

export async function dispatchChecklistMove(rawArgs: Record<string, unknown>, deps: ChecklistLedgerDeps = {}): Promise<ChecklistMoveResult> {
  const id = requiredString(rawArgs.id, 'id');
  const from = resolveChecklistVersion(requiredString(rawArgs.from, 'from'));
  const to = resolveChecklistVersion(requiredString(rawArgs.to, 'to'));
  const reason = filledString(rawArgs.reason, 'reason');
  if (!reason?.trim()) throw new Error('이동 이유가 필요하다');
  const ledgerRoot = releaseLedgerRoot();
  const denial = (deps.fence ?? ledgerWriteDenial)('release checklist move', ledgerRoot);
  if (denial) return { output: `ChecklistMove ${id} 거부`, ok: false, error: denial, id, from, to, actor: ledgerActor() };
  const actor = ledgerActor();
  if (actor === 'cli') {
    debug.log('release.placement', 'anonymous-move', { id, from, to });
    checklistFeatures.move(id, from, to, actor, undefined, undefined, reason);
  } else if (actor !== 'OP') {
    seatMove(id, from, to, actor, reason, { schedules: listSchedules(ledgerRoot) });
  } else {
    checklistFeatures.move(id, from, to, actor, undefined, undefined, reason);
  }
  const snapshot = listChecklist(to, ledgerRoot);
  return {
    output: `ChecklistMove ${id} ${from} → ${to}${actor === 'cli' ? ' (⚠ 자리 신원 없음 — 자리 규칙 검사 없이 옮김)' : ''}`,
    ok: true,
    id,
    from,
    to,
    actor,
    ...writeView(snapshot, id),
  };
}
