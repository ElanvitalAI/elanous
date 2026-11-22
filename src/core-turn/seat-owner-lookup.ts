import { parseOwner, type Checklist } from '../release-loop/checklist.js';
import { checkSeatOwner, type OwnerFact, type SeatOwnerCheck, type WorkReference } from './seat-owner-check.js';

/** Readers return fresh complete snapshots, or throw. Versions are unique per cell. */
export interface SeatOwnerReaders {
  checklistVersion: (cellId: string) => string | null;
  readChecklist: (version: string) => Pick<Checklist, 'version' | 'items'>;
  readPullRequest: (repository: string, number: number) => { number: number; body?: string | null; assignees?: readonly { login: string }[] } | null;
  resolveAssignee?: (login: string) => string | null;
  readMail: (id: number) => { id: number; body?: string } | null;
  /** All relevant 0.3.x snapshots, required to match mail body IDs without guessing. */
  listChecklists?: () => readonly Pick<Checklist, 'version' | 'items'>[];
}

function checklistSeat(owner: unknown): string | null {
  if (typeof owner !== 'string') return null;
  try { const { seat } = parseOwner(owner); return seat.includes('*') ? null : seat; }
  catch { return null; }
}

/** Only explicit line-head completion markers, never title, author, paths, quotes or code. */
export function pullRequestCellIds(body: string): string[] {
  const ids = new Set<string>();
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null; continue; }
    if (marker) { fence = { char: marker[0]!, length: marker.length }; continue; }
    const match = /^ {0,3}(?:[-*] +)?칸 닫음:[ \t]*([A-Za-z0-9_.-]+)[ \t]*$/.exec(line);
    if (match) ids.add(match[1]!);
  }
  return [...ids];
}

function bodyContainsId(body: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(body);
}

/** Advisory only: ownership comes exclusively from checklist cells, not PR or mail identities. */
export function lookupSeatOwners(seat: string, references: readonly WorkReference[], readers: SeatOwnerReaders): SeatOwnerCheck {
  const facts: OwnerFact[] = references.flatMap((reference): OwnerFact[] => {
    const source = 'release-checklist';
    const unknown = (): OwnerFact[] => [{ reference, source, owner: null }];
    try {
      let ids: string[];
      if (reference.kind === 'cell') ids = [reference.id];
      else if (reference.kind === 'pr') {
        const pr = readers.readPullRequest(reference.repository, reference.number);
        if (!pr || pr.number !== reference.number || typeof pr.body !== 'string') return unknown();
        ids = pullRequestCellIds(pr.body);
      } else {
        if (!/^[1-9][0-9]*$/.test(reference.id) || !Number.isSafeInteger(Number(reference.id))) return unknown();
        const mail = readers.readMail(Number(reference.id));
        if (!mail || mail.id !== Number(reference.id) || typeof mail.body !== 'string' || !readers.listChecklists) return unknown();
        const snapshots = readers.listChecklists();
        ids = [...new Set(snapshots.flatMap(c => c.items.map(i => i.id)).filter(id => id && bodyContainsId(mail.body!, id)))];
      }
      if (!ids.length) return unknown();
      return ids.map(id => {
        const version = reference.kind === 'cell' && reference.version ? reference.version : readers.checklistVersion(id);
        if (!version || !/^0\.3\.\d+$/.test(version)) return { reference, source, owner: null };
        const checklist = readers.readChecklist(version);
        const items = checklist.items.filter(item => item.id === id);
        return { reference, source, owner: checklist.version === version && items.length === 1 ? checklistSeat(items[0]!.owner) : null };
      });
    } catch { return unknown(); }
  });
  return checkSeatOwner(seat, references, facts);
}
