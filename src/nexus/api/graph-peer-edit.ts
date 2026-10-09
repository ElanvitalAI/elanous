// W9c run guard (TC security review of #25123) — a peer «edit» grant lets another token rewrite a «mine» graph.
// Running that graph would run the peer's change with this machine's privileges, so a peer save leaves a
// marker next to the graph's access grants (`<mine>/.access/<id>.peer-edit.json`) and every run entry for a
// «mine» graph refuses it until the owner approves that exact version (or re-saves it themselves).
// Fail closed: a marker that exists but cannot be read or parsed refuses the run.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PEER_EDIT_REFUSAL = '상대가 바꾼 그래프 — 변경을 확인하고 승인해야 실행할 수 있다';

export interface PeerEditRecord {
  /** `peer:<first 8 hex of the peer token's sha256>` — never the token itself. */
  editedBy: string;
  /** The version id the peer save produced (`pending` while the save is in flight). */
  version: string;
  at: string;
  approved?: { version: string; at: string };
}

export type PeerEditGate =
  | { ok: true }
  | { ok: false; error: 'peer-edit-unapproved'; record: PeerEditRecord }
  | { ok: false; error: 'peer-edit-unreadable'; reason: string };

export function peerEditFile(mineDir: string, id: string): string {
  return join(mineDir, '.access', `${id}.peer-edit.json`);
}

/** null = no peer ever saved this graph. Throws when the marker exists but is unreadable or malformed. */
export function readPeerEdit(mineDir: string, id: string): PeerEditRecord | null {
  let text: string;
  try { text = readFileSync(peerEditFile(mineDir, id), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const record = parsed as PeerEditRecord;
  if (!parsed || typeof parsed !== 'object' || typeof record.editedBy !== 'string' || typeof record.version !== 'string'
    || typeof record.at !== 'string'
    || (record.approved !== undefined && (typeof record.approved !== 'object' || record.approved === null
      || typeof record.approved.version !== 'string' || typeof record.approved.at !== 'string'))) {
    throw new Error('invalid peer-edit marker');
  }
  return record;
}

export function writePeerEdit(mineDir: string, id: string, record: PeerEditRecord): void {
  mkdirSync(join(mineDir, '.access'), { recursive: true, mode: 0o700 });
  const target = peerEditFile(mineDir, id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
}

/** An owner-authorized save replaces the peer's bytes with bytes the owner chose. */
export function clearPeerEdit(mineDir: string, id: string): void {
  rmSync(peerEditFile(mineDir, id), { force: true });
}

export function peerEditRunGate(mineDir: string, id: string): PeerEditGate {
  let record: PeerEditRecord | null;
  try { record = readPeerEdit(mineDir, id); }
  catch (error) { return { ok: false, error: 'peer-edit-unreadable', reason: String(error).slice(0, 200) }; }
  if (!record || record.approved?.version === record.version) return { ok: true };
  return { ok: false, error: 'peer-edit-unapproved', record };
}

/** The 409 body every refusing run entry returns — `reason` is what the editor shows. */
export function peerEditRefusalBody(id: string, gate: Exclude<PeerEditGate, { ok: true }>): Record<string, unknown> {
  return gate.error === 'peer-edit-unapproved'
    ? { error: gate.error, id, reason: PEER_EDIT_REFUSAL, editedBy: gate.record.editedBy, version: gate.record.version, editedAt: gate.record.at }
    : { error: gate.error, id, reason: PEER_EDIT_REFUSAL, detail: gate.reason };
}
