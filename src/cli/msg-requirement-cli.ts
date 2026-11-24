// `eln msg req list|close|next|wait` (OP-REQUIREMENT-LOOP) — the structured write path for the requirement ledger.
// The ledger closes only through `close` with evidence; `wait` records «I asked X» as a wait, never as closure.
import type { Command } from 'commander';

export interface MsgRequirementCliDeps {
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
  stateRoot?: () => string;
  now?: () => Date;
  writeJson?: (text: string) => Promise<void> | void;
}

async function defaultWriteJson(text: string): Promise<void> {
  const { writeStdoutJson } = await import('./stdout-json.js');
  await writeStdoutJson(text);
}

export function parseEvidenceFlags(opts: { pr?: string; checklist?: string; measured?: string; unit?: string }): unknown {
  if (opts.pr !== undefined) return { kind: 'pr', number: Number(opts.pr.replace(/^#/, '')) };
  if (opts.checklist !== undefined) {
    const at = opts.checklist.lastIndexOf(':');
    return { kind: 'checklist', cellId: at > 0 ? opts.checklist.slice(0, at) : opts.checklist, status: at > 0 ? opts.checklist.slice(at + 1) : undefined };
  }
  if (opts.measured !== undefined) {
    const at = opts.measured.indexOf('=');
    const raw = at > 0 ? opts.measured.slice(at + 1).trim() : '';
    return { kind: 'measured', metric: at > 0 ? opts.measured.slice(0, at).trim() : '', value: raw === '' ? Number.NaN : Number(raw), ...(opts.unit ? { unit: opts.unit } : {}) };
  }
  return null;
}

export function registerMsgRequirementCommands(msg: Command, deps: MsgRequirementCliDeps = {}): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const now = deps.now ?? (() => new Date());
  const open = async (seat: string) => {
    const mod = await import('../op-requirements/requirement-loop.js');
    const root = deps.stateRoot ? deps.stateRoot() : (await import('../autopilot/state-paths.js')).elanousStateRoot();
    const path = mod.requirementStorePath(root, seat);
    return { mod, path, store: mod.readStore(path) };
  };
  const run = <A extends unknown[]>(name: string, action: (...args: A) => Promise<void>) => async (...args: A) => {
    try { await action(...args); } catch (error) { out.error(`msg req ${name}: ${error instanceof Error ? error.message : String(error)}`); setExitCode(1); }
  };
  const req = msg.command('req').description('OP requirement ledger: open requirements close only with evidence');

  req.command('list').option('--seat <seat>', 'seat', 'OP').option('--all', 'include closed · expired · superseded').option('--json')
    .action(run('list', async (opts: { seat: string; all?: boolean; json?: boolean }) => {
      const { mod, store } = await open(opts.seat);
      const counts = mod.countByState(store);
      const rows = store.requirements.filter((r) => opts.all || r.status === 'open' || r.status === 'blocked');
      if (opts.json) { await (deps.writeJson ?? defaultWriteJson)(`${JSON.stringify({ counts, requirements: rows, bulletin: store.bulletin.slice(-20) })}\n`); return; }
      out.log(`open ${counts.open} · blocked ${counts.blocked} · expired ${counts.expired} · superseded ${counts.superseded} · closed ${counts.closed}${opts.all ? '' : ' (closed · expired · superseded hidden — --all shows them)'}`);
      for (const r of rows) out.log(`${r.status.padEnd(7)} ${r.id} r${r.revision}${r.waitFor ? ` · waits ${r.waitFor.condition} until ${r.waitFor.deadlineAt}` : ''}${r.escalatedAt ? ` · escalated ${r.escalatedAt}` : ''}${r.supersededBy ? ` · superseded by ${r.supersededBy}` : ''} · next: ${r.next}`);
      for (const b of store.bulletin.slice(-5)) out.log(b.line);
    }));

  req.command('close <id>').option('--seat <seat>', 'seat', 'OP')
    .option('--pr <number>', 'PR number').option('--checklist <cell:status>', 'checklist cell and status (green|done)')
    .option('--measured <metric=value>', 'measured number').option('--unit <unit>')
    .option('--superseded-by <newer-id>', 'close this CEO item as superseded by a newer CEO item')
    .option('--supersedes <older-ids...>', 'after closing this CEO item, mark older CEO items it replaces as superseded')
    .action(run('close', async (id: string, opts: { seat: string; pr?: string; checklist?: string; measured?: string; unit?: string; supersededBy?: string; supersedes?: string[] }) => {
      const { mod, path, store } = await open(opts.seat);
      const at = now().toISOString();
      if (opts.supersededBy !== undefined) {
        mod.supersedeRequirement(store, id, opts.supersededBy, at);
        mod.writeStore(path, store);
        out.log(`superseded ${id} by ${opts.supersededBy}`);
        return;
      }
      const result = mod.closeRequirement(store, id, parseEvidenceFlags(opts), at);
      if (!result.closed) { out.error(`msg req close refused: ${id} stays open (${result.reason})`); setExitCode(2); return; }
      for (const older of opts.supersedes ?? []) mod.supersedeRequirement(store, older, id, at);
      mod.writeStore(path, store);
      out.log(`closed ${id}${opts.supersedes?.length ? ` · superseded ${opts.supersedes.join(' ')}` : ''}`);
    }));

  req.command('next <id> <step>').option('--seat <seat>', 'seat', 'OP')
    .action(run('next', async (id: string, step: string, opts: { seat: string }) => {
      const { mod, path, store } = await open(opts.seat);
      const r = mod.setNext(store, id, step, now().toISOString());
      mod.writeStore(path, store);
      out.log(`${id} r${r.revision} next: ${r.next}`);
    }));

  req.command('wait <id>').option('--seat <seat>', 'seat', 'OP')
    .requiredOption('--commitment <id>').requiredOption('--condition <cond>').requiredOption('--deadline <iso>')
    .action(run('wait', async (id: string, opts: { seat: string; commitment: string; condition: string; deadline: string }) => {
      const { mod, path, store } = await open(opts.seat);
      const r = mod.attachWait(store, id, { commitmentId: opts.commitment, condition: opts.condition, deadlineAt: opts.deadline }, now().toISOString());
      mod.writeStore(path, store);
      out.log(`${id} r${r.revision} waits ${opts.condition} until ${opts.deadline} (still open)`);
    }));
}
