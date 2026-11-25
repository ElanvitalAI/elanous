// `eln org` — show / move / set-role / add-space / remove-space over the declarative org map (src/org/org-map.ts).
import type { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import {
  applyOrgChange, appendOrgAudit, DEFAULT_ORG, loadOrgMap, orgParentOf, orgStatusRow, orgTreeLines, writeOrgChange,
  type OrgChange, type OrgMap,
} from '../org/org-map.js';

export interface OrgCliDeps {
  readonly cwd?: () => string;
  readonly home?: () => string;
  readonly stateRoot?: () => string;
  /** Mail one info line (old+new owner); returns the id. Default = the live msg store. */
  readonly post?: (to: string, body: string, refs: string[]) => number | undefined;
  /** Open (unacked) duty-tagged mail of a seat — forwarded on a move so no card / ✋ is lost. */
  readonly openDutyMail?: (seat: string, duty: string) => { id: number; body: string }[];
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly now?: () => Date;
}

const liveStore = () => {
  const { openMsgStore, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  return openMsgStore(defaultMsgStorePath());
};

export function orgJson(org: OrgMap) {
  return { ...org, parents: Object.fromEntries(Object.keys(org.seats).map(s => [s, orgParentOf(org, s)])), status: orgStatusRow(org) };
}

export function registerOrgCommands(program: Command, deps: OrgCliDeps = {}): void {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const exit = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const cwd = () => deps.cwd?.() ?? process.cwd();
  const home = () => deps.home?.() ?? homedir();
  const stateRoot = () => deps.stateRoot?.() ?? (require('../autopilot/state-paths.js') as typeof import('../autopilot/state-paths.js')).elanousStateRoot();
  const by = (process.env.ELANOUS_TRACK ?? 'OP').toUpperCase();
  const post = deps.post ?? ((to: string, body: string, refs: string[]) => { const s = liveStore(); try { return s.post({ from: by, to, body, kind: 'info', refs }, { dedupe: false }).id; } finally { (s as { close?: () => void }).close?.(); } });
  const openDutyMail = deps.openDutyMail ?? ((seat: string, duty: string) => {
    const s = liveStore();
    try { return s.list(seat, 0, 500).filter(m => (m.refs ?? []).includes(`duty:${duty}`)).map(m => ({ id: m.id, body: m.body })); }
    finally { (s as { close?: () => void }).close?.(); }
  });

  const org = program.command('org').description('Declarative organization: seats · roles · spaces · duties (federation.yaml org:)');

  org.command('show').description('Org tree ⊕ duty table').option('--json', 'JSON').option('--status-row', 'one status-board row')
    .action((o: { json?: boolean; statusRow?: boolean }) => {
      const loaded = loadOrgMap({ cwd: cwd(), home: home() });
      if (o.json) { out(JSON.stringify({ path: loaded.path ?? null, declared: loaded.declared, errors: loaded.errors, ...orgJson(loaded.org) }, null, 2)); return; }
      if (o.statusRow) { out(orgStatusRow(loaded.org)); return; }
      for (const l of orgTreeLines(loaded.org)) out(l);
      out('');
      out('duty                     seat   ' );
      for (const [d, s] of Object.entries(loaded.org.duties)) out(`${d.padEnd(24)} ${s}${DEFAULT_ORG.duties[d] !== s ? `   (default ${DEFAULT_ORG.duties[d]})` : ''}`);
      out('');
      out(`source: ${loaded.path ?? '(defaults — no federation.yaml)'}${loaded.errors.length ? ` · ⚠ ${loaded.errors.join('; ')}` : ''}`);
    });

  /** One writer at a time: mkdir lock beside the declaration; the map is re-read and re-validated under the lock. */
  const withLock = <T>(path: string, fn: () => T): T | undefined => {
    const lock = `${path}.org-lock`;
    const { mkdirSync, rmSync, statSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(require('node:path').dirname(path), { recursive: true });
    for (let i = 0; i < 2; i++) {
      try { mkdirSync(lock); } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
        err(`refused: another org change holds ${lock} — retry`); exit(1); return undefined;
      }
      try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
    }
    err(`refused: lock ${lock} unavailable`); exit(1); return undefined;
  };

  const inverse = (org: OrgMap, change: OrgChange, from?: string): OrgChange => {
    if (change.op === 'move') return { op: 'move', duty: change.duty, to: from ?? 'OP' };
    if (change.op === 'set-role') return { op: 'set-role', seat: change.seat, role: org.seats[change.seat.toUpperCase()]?.role ?? 'hand' };
    if (change.op === 'add-space') return { op: 'remove-space', space: change.space };
    const sp = org.spaces[change.space]!;
    return { op: 'add-space', space: change.space, leader: sp.leader, ...(sp.advisor ? { advisor: sp.advisor } : {}), ...(sp.steward ? { steward: sp.steward } : {}) };
  };

  const run = (change: OrgChange, dryRun: boolean | undefined, note: Record<string, unknown> = {}) => {
    const first = loadOrgMap({ cwd: cwd(), home: home() });
    const path = first.path ?? join(getElanousConfigDir(), 'federation.yaml');
    const go = () => {
      const loaded = loadOrgMap({ cwd: cwd(), home: home() });
      if (loaded.errors.length) { err(`org: declaration invalid — ${loaded.errors.join('; ')}`); exit(1); return; }
      const { next, errors, from } = applyOrgChange(loaded.org, change);
      if (errors.length) { for (const e of errors) err(`refused: ${e}`); exit(1); return; }
      const summary = change.op === 'move' ? `${change.duty}: ${from} → ${change.to.toUpperCase()}` : JSON.stringify(change);
      if (dryRun) { out(`dry-run OK · ${summary}`); return; }
      const undo = inverse(loaded.org, change, from);
      writeOrgChange(path, change, next);
      const forwarded: number[] = [];
      if (change.op === 'move' && from) {
        // Migrate open duty cards / ✋: forward each unacked duty-tagged mail to the new owner (reply-linked).
        const to = change.to.toUpperCase();
        for (const m of openDutyMail(from, change.duty)) {
          const id = post(to, `[org · 이관 #${m.id}] ${m.body}`.slice(0, 2000), [`duty:${change.duty}`, `forwarded:${m.id}`]);
          if (id !== undefined) forwarded.push(m.id);
        }
        for (const seat of new Set([from, to])) post(seat, `[org · 정보 · 회신 불필요] 직무 ${change.duty} ${from} → ${to} · 열린 카드 ${forwarded.length} 이관`, [`duty:${change.duty}`]);
      }
      const audit = appendOrgAudit(stateRoot(), { at: (deps.now?.() ?? new Date()).toISOString(), by, change, undo, from: from ?? null, forwarded, path, ...note });
      out(`OK · ${summary} · written ${path} · audit ${audit}${forwarded.length ? ` · forwarded ${forwarded.join(',')}` : ''}`);
    };
    if (dryRun) go(); else withLock(path, go);
  };

  org.command('rollback').description('Undo the last org change (from the audit log)').option('--dry-run')
    .action((o: { dryRun?: boolean }) => {
      const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
      const file = join(stateRoot(), 'org', 'audit.jsonl');
      const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { undo?: OrgChange; rollbackOf?: number }) : [];
      const undone = new Set(rows.map(r => r.rollbackOf).filter((n): n is number => typeof n === 'number'));
      let idx = -1;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.undo && rows[i]!.rollbackOf === undefined && !undone.has(i)) { idx = i; break; }
      if (idx < 0) { err('refused: nothing to roll back'); exit(1); return; }
      run(rows[idx]!.undo!, o.dryRun, { rollbackOf: idx });
    });

  org.command('move <duty>').description('Move a duty to another seat').requiredOption('--to <seat>').option('--dry-run')
    .action((duty: string, o: { to: string; dryRun?: boolean }) => run({ op: 'move', duty, to: o.to }, o.dryRun));
  org.command('set-role <seat> <role>').description('Set a seat role').option('--dry-run')
    .action((seat: string, role: string, o: { dryRun?: boolean }) => run({ op: 'set-role', seat, role }, o.dryRun));
  org.command('add-space <space>').description('Add a space').requiredOption('--leader <seat>').option('--advisor <seat>').option('--steward <seat>').option('--dry-run')
    .action((space: string, o: { leader: string; advisor?: string; steward?: string; dryRun?: boolean }) =>
      run({ op: 'add-space', space, leader: o.leader, ...(o.advisor ? { advisor: o.advisor } : {}), ...(o.steward ? { steward: o.steward } : {}) }, o.dryRun));
  org.command('remove-space <space>').description('Remove a space (refused if it orphans a duty)').option('--dry-run')
    .action((space: string, o: { dryRun?: boolean }) => run({ op: 'remove-space', space }, o.dryRun));
}
