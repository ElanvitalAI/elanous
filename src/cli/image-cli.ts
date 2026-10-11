import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import {
  appendImageLedgerEvent, baselinePinEvent, foldImageLedger, imageLedgerPath, readImageLedger, readRegistryTags,
  type ImageLedgerRow, type RegistryRead,
} from '../images/image-ledger.js';
import { isPodImageCommit, podImageRegistry } from '../task-orchestrator/surfaces/pod-image-source.js';

const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/u;

export interface ImageLsDeps {
  readonly ledgerPath?: string;
  readonly readRegistry?: (opts: { port: string; sshHost?: string }) => RegistryRead;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export interface ImageLsResult {
  readonly ledger: { readonly path: string; readonly exists: boolean; readonly events: number; readonly unreadableLines: number };
  readonly registry: { readonly read: boolean; readonly where: string; readonly tags: number | null; readonly reason?: string };
  readonly rows: readonly ImageLedgerRow[];
  readonly counts: { readonly baseline: number; readonly transient: number | null; readonly ledgered: number };
}

/** `image ls` — read only: ledger rows ⊕ registry tags without a ledger row (= transient). */
export function imageLs(opts: { json?: boolean; ssh?: string; registry?: boolean }, deps: ImageLsDeps = {}): ImageLsResult {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (opts.ssh !== undefined && !SSH_HOST.test(opts.ssh)) throw new Error(`invalid --ssh host: ${opts.ssh}`);
  const ledger = readImageLedger(deps.ledgerPath ?? imageLedgerPath());
  const registryAddr = podImageRegistry(deps.env ?? process.env);
  const port = registryAddr.slice(registryAddr.lastIndexOf(':') + 1);
  const where = `${opts.ssh ?? 'this machine'} localhost:${port}`;
  let registry: RegistryRead | null = null;
  if (opts.registry !== false) {
    registry = /^[1-9][0-9]{0,4}$/u.test(port) && Number(port) <= 65535
      ? (deps.readRegistry ?? readRegistryTags)({ port, ...(opts.ssh ? { sshHost: opts.ssh } : {}) })
      : { ok: false, reason: `invalid registry port: ${registryAddr}` };
  }
  const tags = registry?.ok ? registry.tags : null;
  const rows = foldImageLedger(ledger.events, tags);
  const result: ImageLsResult = {
    ledger: { path: ledger.path, exists: ledger.exists, events: ledger.events.length, unreadableLines: ledger.unreadableLines },
    registry: registry === null
      ? { read: false, where, tags: null, reason: 'skipped (--no-registry)' }
      : registry.ok ? { read: true, where, tags: registry.tags.length } : { read: false, where, tags: null, reason: registry.reason },
    rows,
    counts: {
      baseline: rows.filter((r) => r.current).length,
      transient: tags === null ? null : rows.filter((r) => r.unledgered).length,
      ledgered: rows.filter((r) => !r.unledgered).length,
    },
  };
  try { debug.log('image.ledger', 'ls', { ledgerEvents: result.ledger.events, unreadableLines: result.ledger.unreadableLines, registryRead: result.registry.read, registryTags: result.registry.tags, transient: result.counts.transient }); } catch { /* log sink optional */ }
  if (opts.json) { out(JSON.stringify(result, null, 2)); return result; }
  out(`image ledger · ${ledger.path}${ledger.exists ? '' : ' (no ledger yet)'} · events ${ledger.events.length}${ledger.unreadableLines ? ` · ⚠️ unreadable lines ${ledger.unreadableLines}` : ''}`);
  out(result.registry.read
    ? `registry · ${where} · tags ${result.registry.tags}`
    : `registry · ${where} · ⚠️ not read — ${result.registry.reason} (transient count unknown, not 0)`);
  for (const r of rows.filter((x) => !x.unledgered)) {
    const reg = r.inRegistry === null ? '?' : r.inRegistry ? 'reg' : '⚠️ not-in-registry';
    out(`  ${r.tag}  ${r.role}${r.role === 'baseline' ? (r.current ? '*' : ' (previous)') : ''}  keep=${r.keep}  ${r.origin ? `${r.origin.reason}@${r.origin.host}` : '-'}  ${r.lastTs}  ${reg}`);
  }
  const transient = rows.filter((x) => x.unledgered);
  if (transient.length > 0) out(`  transient (registry tags without a ledger row) · ${transient.length} · ${transient.slice(0, 8).map((r) => r.tag).join(' ')}${transient.length > 8 ? ' …' : ''}`);
  out(`baseline ${result.counts.baseline} · ledgered ${result.counts.ledgered} · transient ${result.counts.transient ?? 'unknown'}`);
  return result;
}

/**
 * Recording site: `config set harness.imageCommit <commit>` (the rail pins the baseline through it).
 * Appends a `baseline ⊕ pin` event (none when that tag is already the current baseline). A failed ledger write never fails the config write; it warns
 * and leaves an observation.
 */
export function recordImagePinFromConfigSet(path: string, value: unknown, deps: { ledgerPath?: string; warn?: (msg: string) => void; now?: () => Date; host?: string } = {}): 'recorded' | 'unchanged' | 'skipped' | 'failed' {
  if (path !== 'harness.imageCommit' || !isPodImageCommit(value)) return 'skipped';
  const ledgerPath = deps.ledgerPath ?? imageLedgerPath();
  try {
    // The rail re-pins the same commit on quiet cycles — one event per baseline change, not per call.
    const current = foldImageLedger(readImageLedger(ledgerPath).events, null).find((r) => r.current);
    if (current && current.tag === value.trim().toLowerCase().slice(0, 12)) return 'unchanged';
    const event = baselinePinEvent(value, { ...(deps.now ? { now: deps.now } : {}), ...(deps.host ? { host: deps.host } : {}) });
    appendImageLedgerEvent(event, ledgerPath);
    try { debug.log('image.ledger', 'baseline-pinned', { tag: event.tag, commit: event.commit, reason: event.origin.reason, host: event.origin.host, ledgerPath }); } catch { /* */ }
    return 'recorded';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try { debug.log('image.ledger', 'baseline-pin-record-failed', { error: message, ledgerPath }); } catch { /* */ }
    (deps.warn ?? ((m: string) => console.error(m)))(`⚠️ image ledger: baseline pin was set in config but not recorded in ${ledgerPath} — ${message}`);
    return 'failed';
  }
}

export function registerImageCommands(program: Command): void {
  const image = program.command('image').description('하니스 이미지 원장 — 신분 표지(역할·보존·출신) · 원장 없는 레지스트리 태그 = transient');
  image.command('ls')
    .description('원장 행 ⊕ 레지스트리 태그(원장에 없으면 transient) — 읽기 전용')
    .option('--json', 'JSON 출력')
    .option('--ssh <host>', '레지스트리가 있는 노드(그 노드의 localhost 포트로 조회)')
    .option('--no-registry', '레지스트리를 읽지 않는다(원장만)')
    .action((opts: { json?: boolean; ssh?: string; registry?: boolean }) => { imageLs(opts); });
}
