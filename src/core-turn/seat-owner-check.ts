/** Structured identifiers supplied by the caller, never extracted from prose. */
export type WorkReference =
  | { kind: 'cell'; id: string; version?: string }
  | { kind: 'pr'; repository: string; number: number }
  | { kind: 'mail'; id: string };

/** Owner facts are supplied by trusted, structured sources; text is not evidence.
 * Missing or incomplete source results must be represented by owner: null. */
export interface OwnerFact {
  reference: WorkReference;
  owner: string | null;
  source: string;
}

export interface ReferenceOwnerCheck {
  reference: WorkReference;
  status: 'owned' | 'foreign' | 'unknown' | 'conflict';
  owners: string[];
  sources: string[];
}

export interface SeatOwnerCheck {
  status: 'owned' | 'foreign' | 'unknown' | 'conflict';
  references: ReferenceOwnerCheck[];
}

function validReference(ref: WorkReference): boolean {
  switch (ref.kind) {
    case 'cell': case 'mail': return typeof ref.id === 'string' && ref.id.trim() !== '' && ref.id === ref.id.trim();
    case 'pr': return typeof ref.repository === 'string' && ref.repository.trim() !== '' && ref.repository === ref.repository.trim() && Number.isSafeInteger(ref.number) && ref.number > 0;
    default: return false;
  }
}

function sameReference(a: WorkReference, b: WorkReference): boolean {
  if (!validReference(a) || !validReference(b) || a.kind !== b.kind) return false;
  if (a.kind === 'pr' && b.kind === 'pr') return a.repository === b.repository && a.number === b.number;
  if (a.kind === 'cell' && b.kind === 'cell') return a.id === b.id;
  if (a.kind === 'mail' && b.kind === 'mail') return a.id === b.id;
  return false;
}

/** Advisory ownership check, not authorization. Callers establish trust, freshness,
 * source completeness and the identity of the current seat before calling. */
export function checkSeatOwner(seat: string, references: readonly WorkReference[], facts: readonly OwnerFact[]): SeatOwnerCheck {
  const validSeat = typeof seat === 'string' && seat.trim() !== '' && seat === seat.trim();
  const results: ReferenceOwnerCheck[] = references.map((reference) => {
    const matches = facts.filter((fact) => sameReference(reference, fact.reference));
    const owners = [...new Set(matches.flatMap(({ owner }) =>
      typeof owner === 'string' && owner.trim() !== '' && owner === owner.trim() ? [owner] : []))].sort();
    const sources = [...new Set(matches.map(({ source }) => source))].sort();
    const incomplete = matches.length === 0 || matches.some(({ owner, source }) =>
      typeof owner !== 'string' || owner.trim() === '' || owner !== owner.trim() ||
      typeof source !== 'string' || source.trim() === '' || source !== source.trim());
    const status = owners.length > 1 ? 'conflict' :
      !validSeat || incomplete || !validReference(reference) ? 'unknown' :
      owners[0] === seat ? 'owned' : 'foreign';
    return { reference, status, owners, sources };
  });
  const status = results.some((r) => r.status === 'conflict') ? 'conflict' :
    results.some((r) => r.status === 'foreign') ? 'foreign' :
    results.length === 0 || results.some((r) => r.status === 'unknown') ? 'unknown' : 'owned';
  return { status, references: results };
}
