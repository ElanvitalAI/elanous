// `els import herdr` (ELS-HERDR-IMPORT): bring the herdr layout of this machine into els once — read herdr's workspaces,
// tabs and panes (label · cwd · agent), print the plan, ask the person, then open the missing panes in els only.
//
// - herdr is only read: one `herdr api snapshot` call, nothing is typed, closed or renamed there.
// - els panes are made through the owner's `new` request — the same path `els new` takes (no PTY spawned here).
// - A herdr pane counts as «already in els» when els has a pane with the same workspace name, tab label and cwd. The match
//   is counted (two herdr panes with the same three need two els panes), so a second run creates nothing.
// - els `new` opens one tab per pane: the tab carries the herdr tab label, so the layout reads the same in both lists.
// - The receipt has one line per herdr pane: created · skipped · failed, then the totals.
// - One import at a time: a lock folder next to the journal (mkdir is the atomic step). A lock left by a dead process is
//   taken over; a live holder refuses the second run without touching anything.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asRecord } from '../primitives/guards.js';
import type { HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

// 출처: same bound as the herdr host rows (herdr-host.ts SNAPSHOT_TIMEOUT_MS): a local herdr answers in well under 2 s.
const SNAPSHOT_TIMEOUT_MS = 2_000;

/** One herdr pane as els will see it. `workspace` / `tab` are the person-facing names, never herdr's `w1` / `w1:t2` ids. */
export interface HerdrImportRow {
  readonly herdrPane: string;
  readonly workspace: string;
  readonly tab: string;
  readonly cwd: string;
  /** What herdr says runs there (`claude`, `codex` …) or '' — shown in the plan; the els pane opens the person's shell. */
  readonly agent: string;
}

export interface HerdrImportPlan {
  readonly create: readonly HerdrImportRow[];
  readonly skip: readonly HerdrImportRow[];
  /** herdr panes that cannot be placed (no cwd, or an id that does not belong to its workspace): failed, with the reason. */
  readonly unusable: readonly { readonly herdrPane: string; readonly reason: string }[];
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** `w1:t2` of workspace `w1` → `t2`; an id from another workspace is not this workspace's. */
const localPart = (id: string, workspace: string): string | undefined =>
  id.startsWith(`${workspace}:`) && id.length > workspace.length + 1 ? id.slice(workspace.length + 1) : undefined;

/** `herdr api snapshot` JSON → rows to import. Undefined when the answer has no panes array (not a herdr snapshot). */
export function herdrImportRows(json: unknown): { rows: HerdrImportRow[]; unusable: { herdrPane: string; reason: string }[] } | undefined {
  const result = asRecord(asRecord(json, { fallback: 'undefined' })?.result, { fallback: 'undefined' });
  const snapshot = asRecord(result?.snapshot, { fallback: 'undefined' }) ?? result;
  if (!snapshot || !Array.isArray(snapshot.panes)) return undefined;
  const workspaceLabel = new Map<string, string>();
  for (const row of list(snapshot.workspaces)) {
    const ws = asRecord(row, { fallback: 'undefined' });
    if (ws && text(ws.workspace_id)) workspaceLabel.set(text(ws.workspace_id), text(ws.label).trim());
  }
  const tabLabel = new Map<string, string>();
  for (const row of list(snapshot.tabs)) {
    const tab = asRecord(row, { fallback: 'undefined' });
    if (tab && text(tab.tab_id)) tabLabel.set(text(tab.tab_id), text(tab.label).trim());
  }
  const rows: HerdrImportRow[] = [];
  const unusable: { herdrPane: string; reason: string }[] = [];
  for (const raw of snapshot.panes) {
    const pane = asRecord(raw, { fallback: 'undefined' });
    const herdrPane = text(pane?.pane_id) || '(no pane id)';
    const workspace = text(pane?.workspace_id);
    const tabId = text(pane?.tab_id);
    const tabLocal = localPart(tabId, workspace);
    if (!pane || !workspace || !localPart(herdrPane, workspace) || !tabLocal) { unusable.push({ herdrPane, reason: 'pane/tab id does not belong to its workspace' }); continue; }
    const cwd = text(pane.cwd).trim();
    if (!cwd) { unusable.push({ herdrPane, reason: 'herdr reports no cwd' }); continue; }
    rows.push({ herdrPane, workspace: workspaceLabel.get(workspace) || workspace, tab: tabLabel.get(tabId) || tabLocal, cwd,
      agent: text(pane.display_agent) || text(pane.agent) });
  }
  return { rows, unusable };
}

/** The els side as `ls` answers it: which (workspace name, tab label, cwd) already have a pane, and how many. */
function elsCounts(listed: unknown): Map<string, number> | string {
  const body = asRecord(listed, { fallback: 'undefined' });
  if (!body || !Array.isArray(body.panes)) return 'els ls answer has no panes array';
  const tabLabel = new Map<string, string>();
  for (const row of list(body.tabs)) {
    const tab = asRecord(row, { fallback: 'undefined' });
    if (tab && text(tab.id)) tabLabel.set(text(tab.id), text(tab.label));
  }
  const counts = new Map<string, number>();
  for (const row of body.panes) {
    const pane = asRecord(row, { fallback: 'undefined' });
    if (!pane) continue;
    const key = keyOf(text(pane.workspace), tabLabel.get(text(pane.tab)) ?? text(pane.title), text(pane.cwd));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const keyOf = (workspace: string, tab: string, cwd: string): string => JSON.stringify([workspace, tab, cwd]);

/** Split herdr rows into create / skip against what els already has (counted match: one els pane covers one herdr pane). */
export function planHerdrImport(rows: readonly HerdrImportRow[], unusable: HerdrImportPlan['unusable'], existing: Map<string, number>): HerdrImportPlan {
  const left = new Map(existing);
  const create: HerdrImportRow[] = [];
  const skip: HerdrImportRow[] = [];
  for (const row of rows) {
    const key = keyOf(row.workspace, row.tab, row.cwd);
    const have = left.get(key) ?? 0;
    if (have > 0) { left.set(key, have - 1); skip.push(row); } else create.push(row);
  }
  return { create, skip, unusable };
}

const where = (row: HerdrImportRow): string => `${row.workspace}/${row.tab}  ${row.cwd}  (herdr ${row.herdrPane}${row.agent ? ` · ${row.agent}` : ''})`;

/** The plan as the person reads it before saying yes. */
export function formatHerdrImportPlan(plan: HerdrImportPlan, shell: string): string {
  const lines = [`els import herdr: plan — create ${plan.create.length} · skip ${plan.skip.length} (already in els) · cannot place ${plan.unusable.length}`];
  for (const row of plan.create) lines.push(`  + create  ${where(row)}`);
  for (const row of plan.skip) lines.push(`  = skip    ${where(row)}`);
  for (const row of plan.unusable) lines.push(`  ! cannot  herdr ${row.herdrPane}: ${row.reason}`);
  if (plan.create.length > 0) lines.push(`  new els panes open ${shell} in that cwd (herdr is not changed)`);
  return lines.join('\n');
}

export interface HerdrImportDeps {
  /** herdr CLI (read only: `api snapshot`). */
  readonly run: HerdrCliRunner;
  /** The els owner: `ls` and `new` — the same requests `els ls` / `els new` send. */
  readonly request: (request: ElsRequest) => Promise<ElsResult>;
  /** The person's answer to the plan (askHitlOnTerminal in the CLI): only 'approve' creates anything. */
  readonly confirm: (question: string) => Promise<'approve' | 'deny' | 'timeout'>;
  /** Command for the new panes (the CLI passes $SHELL, else /bin/sh). */
  readonly shell: string;
  /** Lock folder for «one import at a time». */
  readonly lockDir: string;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Take the import lock: undefined = taken (call the returned release), string = why not. */
function takeLock(dir: string, pid: number, isAlive: (pid: number) => boolean): { release: () => void } | string {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      try { writeFileSync(join(dir, 'pid'), String(pid)); } catch { /* the folder alone is the lock */ }
      return { release: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leftover lock is taken over next time */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return `cannot take the import lock ${dir}: ${error instanceof Error ? error.message : String(error)}`;
      let holder: number | undefined;
      try { holder = Number.parseInt(readFileSync(join(dir, 'pid'), 'utf-8'), 10); } catch { holder = undefined; }
      if (holder !== undefined && Number.isInteger(holder) && holder > 0 && isAlive(holder)) return `another els import herdr is running (pid ${holder}); nothing was created`;
      if (attempt === 0) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* retried below */ } }
    }
  }
  return `cannot take the import lock ${dir}; nothing was created`;
}

/** Read herdr → plan → ask → create the missing panes in els → receipt. herdr is never written to. */
export async function importHerdr(deps: HerdrImportDeps): Promise<ElsResult> {
  const lock = takeLock(deps.lockDir, deps.pid ?? process.pid, deps.isAlive ?? processAlive);
  if (typeof lock === 'string') return { exitCode: 1, message: `els import herdr: ${lock}` };
  try {
    const answer = await deps.run(['api', 'snapshot'], SNAPSHOT_TIMEOUT_MS);
    if (answer.code !== 0) {
      const why = answer.stderr.trim().slice(0, 160) || `herdr exited with rc=${answer.code ?? 'unknown'}`;
      return { exitCode: 1, message: `els import herdr: cannot read herdr (${why}); nothing was created` };
    }
    let parsed: ReturnType<typeof herdrImportRows>;
    try { parsed = herdrImportRows(JSON.parse(answer.stdout)); }
    catch { return { exitCode: 1, message: 'els import herdr: herdr snapshot is not JSON; nothing was created' }; }
    if (!parsed) return { exitCode: 1, message: 'els import herdr: herdr snapshot has no panes array; nothing was created' };

    const listed = await deps.request({ op: 'ls' });
    if (listed.exitCode !== 0) return { exitCode: 1, message: `els import herdr: cannot list els (${listed.message}); nothing was created` };
    let counts: Map<string, number> | string;
    try { counts = elsCounts(JSON.parse(listed.message)); }
    catch { counts = 'els ls answer is not JSON'; }
    if (typeof counts === 'string') return { exitCode: 1, message: `els import herdr: ${counts}; nothing was created` };

    const plan = planHerdrImport(parsed.rows, parsed.unusable, counts);
    const planText = formatHerdrImportPlan(plan, deps.shell);
    const receipt: string[] = [];
    let created = 0;
    let failed = plan.unusable.length;
    if (plan.create.length > 0) {
      const said = await deps.confirm(`${planText}\ncreate ${plan.create.length} els pane(s)? [y/N] `);
      if (said !== 'approve') {
        return { exitCode: 1, message: `${planText}\nels import herdr: not confirmed (${said}); nothing was created` };
      }
      for (const row of plan.create) {
        const made = await deps.request({ op: 'new', ws: row.workspace, cwd: row.cwd, command: [deps.shell], title: row.tab });
        if (made.exitCode === 0) {
          let address = '';
          try { address = text(asRecord(JSON.parse(made.message), { fallback: 'undefined' })?.address); } catch { address = ''; }
          receipt.push(`created  ${where(row)} → els ${address || '(address not reported)'}`);
          created++;
        } else {
          receipt.push(`failed   ${where(row)}: ${made.message.trim().slice(0, 160)}`);
          failed++;
        }
      }
    }
    for (const row of plan.skip) receipt.push(`skipped  ${where(row)}: already in els`);
    for (const row of plan.unusable) receipt.push(`failed   herdr ${row.herdrPane}: ${row.reason}`);
    receipt.push(`els import herdr: created ${created} · skipped ${plan.skip.length} · failed ${failed}`);
    return { exitCode: failed > 0 ? 1 : 0, message: `${planText}\n${receipt.join('\n')}` };
  } finally {
    lock.release();
  }
}
