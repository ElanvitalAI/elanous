// els journal — <state>/els/journal.json. One owner: only the els server process (src/els/server.ts) writes it, so there
// is no file lock. Restart restores ws/tab/pane and cwd from here; the PTY processes themselves are not restored.

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { emptyJournal, type Pane, type SpaceJournal, type Tab, type Workspace } from './space.js';

export function elsJournalPath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'els', 'journal.json');
}

export class JournalCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`els journal unreadable (refusing to replace ${path}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JournalCorruptError';
  }
}

/** A missing file is an empty journal. Any other read or parse failure throws — never replaced by an empty journal. */
export function loadJournal(path: string): SpaceJournal {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyJournal();
    throw new JournalCorruptError(path, error);
  }
  try {
    return validJournal(JSON.parse(text));
  } catch (error) {
    throw new JournalCorruptError(path, error);
  }
}

const PANE_STATES = new Set(['working', 'idle', 'blocked', 'done', 'exited']);
const PANE_KINDS = new Set(['pty', 'agent', 'harness-child', 'graph-view', 'remote']);
const RESTORE_POLICIES = new Set(['none', 'cwd', 'command', 'resume']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * A version-1 journal whose every record has its fields with the right types, whose ids are unique across
 * workspaces, tabs and panes, and whose tab → workspace and pane → tab references resolve. Anything else throws, so
 * a damaged journal is refused before the owner changes (and saves) it.
 */
export function validJournal(raw: unknown): SpaceJournal {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.workspaces) || !Array.isArray(raw.tabs) || !Array.isArray(raw.panes)) {
    throw new Error('journal shape is not version 1');
  }
  const bad = (what: string, index: number): Error => new Error(`${what}[${index}] is malformed`);
  const workspaces = raw.workspaces.map((ws, index): Workspace => {
    if (!isRecord(ws) || ![ws.id, ws.name, ws.rootCwd, ws.purpose, ws.host].every(isString) || !ws.id) throw bad('workspaces', index);
    if (ws.role !== undefined && ws.role !== 'coordinator') throw bad('workspaces', index);
    if (ws.coordinatorSeat !== undefined && (typeof ws.coordinatorSeat !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(ws.coordinatorSeat))) throw bad('workspaces', index);
    return { id: ws.id as string, name: ws.name as string, rootCwd: ws.rootCwd as string, purpose: ws.purpose as string, host: ws.host as string,
      ...(ws.role === 'coordinator' ? { role: 'coordinator' as const } : {}),
      ...(typeof ws.coordinatorSeat === 'string' ? { coordinatorSeat: ws.coordinatorSeat } : {}) };
  });
  if (workspaces.filter(ws => ws.role === 'coordinator').length > 1) throw new Error('journal has multiple coordinators');
  const assigned = workspaces.flatMap(ws => ws.coordinatorSeat ? [ws.coordinatorSeat] : []);
  if (new Set(assigned).size !== assigned.length) throw new Error('journal has duplicate coordinator seats');
  const tabs = raw.tabs.map((tab, index): Tab => {
    if (!isRecord(tab) || ![tab.id, tab.workspaceId, tab.label, tab.focusPaneId].every(isString) || !tab.id) throw bad('tabs', index);
    return { id: tab.id as string, workspaceId: tab.workspaceId as string, label: tab.label as string, focusPaneId: tab.focusPaneId as string };
  });
  const panes = raw.panes.map((pane, index): Pane => {
    if (!isRecord(pane) || ![pane.id, pane.tabId, pane.title, pane.cwd, pane.ptyId, pane.scrollback].every(isString) || !pane.id
      || !Array.isArray(pane.command) || !pane.command.every(isString)
      || (pane.exitedAt !== undefined && (!Number.isSafeInteger(pane.exitedAt) || (pane.exitedAt as number) < 0))
      || (pane.ownerSeat !== undefined && (typeof pane.ownerSeat !== 'string' || !pane.ownerSeat.trim()))
      || (pane.seatIdentity !== undefined && (typeof pane.seatIdentity !== 'string' || !/^[A-Z][A-Z0-9_-]{0,63}$/.test(pane.seatIdentity)))
      || (pane.cwdOsc7 !== undefined && pane.cwdOsc7 !== true)
      || (pane.cwdOscPending !== undefined && (!Array.isArray(pane.cwdOscPending) || pane.cwdOscPending.length > 65
        || !pane.cwdOscPending.every((path: unknown) => isString(path) && path.startsWith('/') && !path.includes('\0') && path.length <= 8192)))
      // ELS-POD-TAB: place, when present, is { host, runtime: process|pod } — anything else is a damaged journal.
      || (pane.place !== undefined && !(isRecord(pane.place) && isString(pane.place.host)
        && (pane.place.runtime === 'process' || pane.place.runtime === 'pod')))
      // ELS-POD-TAB: inbox, when present, is the pod pane's bounded control inbox — anything else is a damaged journal.
      || (pane.inbox !== undefined && !(Array.isArray(pane.inbox) && pane.inbox.length <= 32
        && pane.inbox.every((memo: unknown) => isRecord(memo) && isString(memo.from) && memo.from.length > 0 && memo.from.length <= 64
          && Number.isSafeInteger(memo.at) && (memo.at as number) >= 0
          && isString(memo.text) && memo.text.length > 0 && !memo.text.includes('\0'))))
      || !PANE_STATES.has(pane.state as string) || !PANE_KINDS.has(pane.kind as string) || !RESTORE_POLICIES.has(pane.restore as string)) {
      throw bad('panes', index);
    }
    return { id: pane.id as string, tabId: pane.tabId as string, kind: pane.kind as Pane['kind'], title: pane.title as string,
      cwd: pane.cwd as string, command: pane.command as string[], state: pane.state as Pane['state'], restore: pane.restore as Pane['restore'],
      ptyId: pane.ptyId as string, scrollback: pane.scrollback as string,
      ...(pane.exitedAt !== undefined ? { exitedAt: pane.exitedAt as number } : {}),
      ...(pane.cwdOsc7 === true ? { cwdOsc7: true as const } : {}),
      ...(Array.isArray(pane.cwdOscPending) ? { cwdOscPending: pane.cwdOscPending as string[] } : {}),
      ...(typeof pane.ownerSeat === 'string' ? { ownerSeat: pane.ownerSeat } : {}),
      ...(typeof pane.seatIdentity === 'string' ? { seatIdentity: pane.seatIdentity } : {}),
      ...(isRecord(pane.place) ? { place: pane.place as unknown as Pane['place'] } : {}),
      ...(Array.isArray(pane.inbox) ? { inbox: pane.inbox as unknown as Pane['inbox'] } : {}) };
  });
  const ids = [...workspaces, ...tabs, ...panes].map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new Error('journal ids are not unique');
  const workspaceIds = new Set(workspaces.map((ws) => ws.id));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  tabs.forEach((tab, index) => { if (!workspaceIds.has(tab.workspaceId)) throw new Error(`tabs[${index}] points at a missing workspace`); });
  panes.forEach((pane, index) => { if (!tabIds.has(pane.tabId)) throw new Error(`panes[${index}] points at a missing tab`); });
  if (raw.coordinatorAudit !== undefined && (!Array.isArray(raw.coordinatorAudit) || !raw.coordinatorAudit.every(row =>
    isRecord(row) && isString(row.at) && (row.op === 'coordinator' || row.op === 'coordinator-unset') && isString(row.result)
      && (row.peerPid === undefined || (Number.isSafeInteger(row.peerPid) && (row.peerPid as number) > 0))))) {
    throw new Error('coordinator audit is malformed');
  }
  if (raw.hqCoordinatorSeat !== undefined && (typeof raw.hqCoordinatorSeat !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(raw.hqCoordinatorSeat))) throw new Error('HQ coordinator seat is malformed');
  if (raw.hqAuthorityLocation !== undefined && (typeof raw.hqAuthorityLocation !== 'string' || !raw.hqAuthorityLocation.trim() || raw.hqAuthorityLocation.includes('\0'))) throw new Error('HQ authority location is malformed');
  const focus = raw.lastFocus;
  if (focus !== undefined && (!isRecord(focus) || !(isString(focus.workspaceId) && focus.workspaceId.length > 0 && ((focus.tabId === undefined && focus.paneId === undefined) || ([focus.tabId, focus.paneId].every(v => isString(v) && v.length > 0)))))) throw new Error('last focus is malformed');
  const lastFocus = focus as SpaceJournal['lastFocus'];
  const coordinatorAudit = raw.coordinatorAudit as SpaceJournal['coordinatorAudit'];
  return { version: 1, workspaces, tabs, panes, ...(lastFocus ? { lastFocus } : {}), ...(coordinatorAudit !== undefined ? { coordinatorAudit } : {}),
    ...(typeof raw.hqCoordinatorSeat === 'string' ? { hqCoordinatorSeat: raw.hqCoordinatorSeat } : {}),
    ...(typeof raw.hqAuthorityLocation === 'string' ? { hqAuthorityLocation: raw.hqAuthorityLocation } : {}) };
}

let saveSequence = 0;

/** The file operations a save uses (a test seam for the failure paths). */
export interface JournalFs {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}
const realFs: JournalFs = { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync };

/**
 * Replace the journal atomically. Every step that can fail (directory, temp file, its 0600 mode) runs before the
 * rename, and the rename is the last step: a save either fails with the previous file untouched, or succeeds whole.
 * Directory 0700, file 0600. Only the owner calls this.
 */
export function saveJournal(path: string, journal: SpaceJournal, fs: JournalFs = realFs): void {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${++saveSequence}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    throw error;
  }
}

export function upsertWorkspace(journal: SpaceJournal, ws: Workspace): SpaceJournal {
  return { ...journal, workspaces: [...journal.workspaces.filter((row) => row.id !== ws.id), ws] };
}

export function addTab(journal: SpaceJournal, tab: Tab): SpaceJournal {
  return { ...journal, tabs: [...journal.tabs, tab] };
}

export function addPane(journal: SpaceJournal, pane: Pane): SpaceJournal {
  return { ...journal, panes: [...journal.panes, pane] };
}

export function patchPane(journal: SpaceJournal, id: string, patch: Partial<Pane>): SpaceJournal {
  return { ...journal, panes: journal.panes.map((pane) => pane.id === id ? { ...pane, ...patch } : pane) };
}

export function findWorkspace(journal: SpaceJournal, nameOrId: string): Workspace | undefined {
  return journal.workspaces.find((ws) => ws.id === nameOrId || ws.name === nameOrId);
}

export function findPane(journal: SpaceJournal, ref: string): Pane | undefined {
  return journal.panes.find((pane) => pane.id === ref || pane.title === ref || (pane.ptyId !== '' && pane.ptyId === ref));
}

/** Every workspace, tab and pane id in the journal (ids are unique across all three). */
export function journalIds(journal: SpaceJournal): Set<string> {
  return new Set([...journal.workspaces.map((ws) => ws.id), ...journal.tabs.map((tab) => tab.id), ...journal.panes.map((pane) => pane.id)]);
}
