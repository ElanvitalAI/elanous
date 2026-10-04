import type { Command } from 'commander';
import { ClaimsInputError, ClaimsLedger, type ClaimsLedgerOptions, type ClaimRow, type ClaimDetail } from '../claims/claims-ledger.js';
import { renderClaims, queueStaleRechecks, type ClaimSurface } from '../claims/claims-render.js';

function actor(explicit?: string): string {
  const by = explicit?.trim() || process.env.AI_AGENT?.trim();
  if (!by) throw new ClaimsInputError('--by or AI_AGENT is required');
  return by;
}

function validUntil(raw: string, now: Date): string {
  const days = /^\+(\d+)d$/.exec(raw);
  const parsed = days ? new Date(now.getTime() + Number(days[1]) * 86400000) : new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || (!days && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw))) throw new ClaimsInputError(`invalid --valid-until: ${raw}`);
  return parsed.toISOString();
}

function handle<Args extends unknown[]>(command: string, action: (...args: Args) => void): (...args: Args) => void {
  return (...args) => {
    try { action(...args); }
    catch (error) {
      if (!(error instanceof ClaimsInputError)) throw error;
      const message = error.message.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      process.stderr.write(`claims ${command}: ${message}\n`);
      process.exitCode = 1;
    }
  };
}

function format(row: ClaimRow): string {
  return `${row.id} · ${row.status} · ${row.claim} · ${row.audience} · ${row.owner}`;
}
function detail(row: ClaimDetail): string {
  return [format(row), ...(row.contrast ? [`대비: ${row.contrast}`] : []),
    '근거:', ...row.evidence.map(e => `  ${e.value} · ${e.command} · 측정 ${e.measured_at} · 유효 ${e.valid_until}${e.source ? ` · ${e.source}` : ''}`),
    '연결:', ...row.links.map(l => `  ${l.cell}${l.version ? ` · ${l.version}` : ''}`),
    '이력:', ...row.history.map(h => `  ${h.at} · ${h.event} · ${h.by} · ${h.detail}`)].join('\n');
}

export function registerClaimsCommands(program: Command, options: ClaimsLedgerOptions & { instanceRoot?: string } = {}, out: Pick<Console, 'log'> = console): void {
  const root = program.command('claims').description('소구점 · 실측 근거 원장');
  const ledger = () => new ClaimsLedger(options);
  const emit = (value: unknown, json: boolean | undefined, text: string) => out.log(json ? JSON.stringify(value) : text);
  root.command('add <id>').requiredOption('--claim <text>').requiredOption('--audience <list>').requiredOption('--owner <seat>')
    .option('--contrast <text>').action(handle('add', (id: string, o: { claim: string; audience: string; owner: string; contrast?: string }) => {
      const row = ledger().add({ id, claim: o.claim, audience: o.audience, owner: o.owner, ...(o.contrast ? { contrast: o.contrast } : {}) });
      emit(row, false, format(row));
    }));
  root.command('verify <id>').requiredOption('--value <value>').requiredOption('--command <command>')
    .requiredOption('--valid-until <ISO|+Nd>').option('--source <url>').option('--by <name>')
    .action(handle('verify', (id: string, o: { value: string; command: string; validUntil: string; source?: string; by?: string }) => {
      const by = actor(o.by);
      const now = options.now?.() ?? new Date();
      const row = ledger().verify(id, { value: o.value, command: o.command, measuredAt: now.toISOString(), validUntil: validUntil(o.validUntil, now), by, ...(o.source ? { source: o.source } : {}) });
      emit(row, false, format(row));
    }));
  root.command('publish <id>').option('--by <name>').action(handle('publish', (id: string, o: { by?: string }) => {
    const row = ledger().publish(id, actor(o.by));
    emit(row, false, format(row));
  }));
  root.command('link <id>').requiredOption('--cell <cell>').option('--version <version>')
    .action(handle('link', (id: string, o: { cell: string; version?: string }) => {
      const row = ledger().link(id, { cell: o.cell, ...(o.version ? { version: o.version } : {}) });
      emit(row, false, format(row));
    }));
  root.command('retract <id>').requiredOption('--reason <text>').option('--by <name>')
    .action(handle('retract', (id: string, o: { reason: string; by?: string }) => {
      const row = ledger().retract(id, { reason: o.reason, by: actor(o.by) });
      emit(row, false, format(row));
    }));
  root.command('list').option('--status <status>').option('--audience <audience>').option('--json')
    .action(handle('list', (o: { status?: ClaimRow['status']; audience?: string; json?: boolean }) => {
      const rows = ledger().list({ status: o.status, audience: o.audience });
      emit(rows, o.json, rows.length ? rows.map(format).join('\n') : '소구점 0건');
    }));
  root.command('show <id>').option('--json').action(handle('show', (id: string, o: { json?: boolean }) => {
    const row = ledger().get(id);
    emit(row, o.json, detail(row));
  }));
  root.command('render').requiredOption('--surface <surface>', 'deck | site | notice')
    .option('--audience <audience>').option('--json')
    .action(handle('render', (o: { surface: ClaimSurface; audience?: string; json?: boolean }) => {
      const result = renderClaims(ledger(), { surface: o.surface, ...(o.audience ? { audience: o.audience } : {}) });
      // Review follow-up: rendering is where stale claims surface — queue their re-measurement in the same act.
      const rechecks = result.excluded.some(item => item.reason === 'stale')
        ? queueStaleRechecks(ledger(), { root: options.instanceRoot, now: options.now?.() }) : 0;
      emit({ ...result, rechecks }, o.json, rechecks ? `${result.markdown}\n<!-- 재측 요청 ${rechecks}건 -->` : result.markdown);
    }));
  root.command('recheck').option('--json').action(handle('recheck', (o: { json?: boolean }) => {
    const count = queueStaleRechecks(ledger(), { root: options.instanceRoot, now: options.now?.() });
    emit({ count }, o.json, `재측 요청 ${count}건`);
  }));
}
