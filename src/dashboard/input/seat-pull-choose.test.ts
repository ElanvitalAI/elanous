// SEAT-PULL-ON-IDLE-LIVE PR-a — one pure chooser, one order, a table.
// landed-but-yellow (any owner) beats an own cell, which beats an ownerless claim.
// NUMGUARD: no numeric bound is asserted.
import { describe, expect, test } from 'bun:test';
import { chooseSeatPull, type SeatPullCell, type SeatPullKind, type SeatPullPrLookup } from './seat-pull-choose.js';

const SEAT = 'HAND-TUI-D';
const VERSION = '0.3.29';
const MERGED = 'bb60ca6cb6';

function cell(over: Partial<SeatPullCell> & { id: string }): SeatPullCell {
  return { title: `${over.id} title`, status: 'yellow', owner: SEAT, ...over };
}

const lookup: SeatPullPrLookup = (number) => number === 38351 ? { merged: true, sha: MERGED } : null;
/** Nothing is merged, but the landed state was actually checked. */
const noneMerged: SeatPullPrLookup = () => ({ merged: false, sha: '' });

describe('chooseSeatPull order', () => {
  const table: Array<{
    name: string;
    cells: SeatPullCell[];
    look?: SeatPullPrLookup;
    seat?: string;
    kind: SeatPullKind | null;
    id?: string;
  }> = [
    {
      name: 'a landed yellow cell beats this seat’s own cell, whoever owns the landed one',
      cells: [
        cell({ id: 'OWN-P0', priority: 'P0' }),
        cell({ id: 'LANDED', owner: 'RES', priority: 'P2', evidencePrs: [38351] }),
      ],
      kind: 'landed', id: 'LANDED',
    },
    {
      name: 'an ownerless landed yellow cell still beats an own cell',
      cells: [
        cell({ id: 'OWN', priority: 'P0' }),
        cell({ id: 'LANDED-FREE', owner: '', evidencePrs: [38351] }),
      ],
      kind: 'landed', id: 'LANDED-FREE',
    },
    {
      name: 'with no landed cell, the own open cell wins over an ownerless claim',
      cells: [
        cell({ id: 'FREE', owner: '' }),
        cell({ id: 'OWN-P1', priority: 'P1' }),
        cell({ id: 'OWN-P0', priority: 'P0' }),
      ],
      look: noneMerged,
      kind: 'own', id: 'OWN-P0',
    },
    {
      name: 'a failed gh look-up is not landed, so the own cell is next',
      cells: [
        cell({ id: 'OPEN', owner: 'RES', evidencePrs: [38351] }),
        cell({ id: 'OWN', priority: 'P1' }),
      ],
      look: () => null,
      kind: 'own', id: 'OWN',
    },
    {
      name: 'an ownerless yellow cell is a claim when nothing landed and nothing is ours',
      cells: [
        cell({ id: 'TAKEN', owner: 'UX' }),
        cell({ id: 'FREE', owner: '  ', title: 'empty owner cell' }),
        cell({ id: 'GREEN', owner: '', status: 'green' }),
      ],
      look: noneMerged,
      kind: 'claim', id: 'FREE',
    },
    {
      name: 'red, green, and done cells are not a pull',
      cells: [
        cell({ id: 'DONE', status: 'done', evidencePrs: [38351] }),
        cell({ id: 'RED', status: 'red', owner: '' }),
        cell({ id: 'GREEN', status: 'green', owner: SEAT }),
      ],
      look: noneMerged,
      kind: null,
    },
    {
      name: 'a blank seat chooses nothing',
      cells: [cell({ id: 'FREE', owner: '' })],
      seat: '  ',
      look: noneMerged,
      kind: null,
    },
  ];

  for (const row of table) {
    test(row.name, () => {
      const choice = chooseSeatPull(row.seat ?? SEAT, row.cells, VERSION, row.look ?? lookup);
      expect(choice?.kind ?? null).toBe(row.kind);
      if (row.id) expect(choice?.id).toBe(row.id);
    });
  }

  test('the landed line names the evidence PR and sha, and keeps the owner', () => {
    const choice = chooseSeatPull(SEAT, [cell({ id: 'LANDED', owner: 'RES', evidencePrs: [38351] })], VERSION, lookup);
    expect(choice?.line).toContain('landed-but-yellow');
    expect(choice?.line).toContain('#38351');
    expect(choice?.line).toContain(MERGED);
    expect(choice?.mail?.to).toBe('OP');
    expect(choice?.mail?.body).toContain('owner stays RES');
    expect(choice?.mail?.body).not.toContain('선점');
  });

  test('an own cell names the rank and sends no mail', () => {
    const choice = chooseSeatPull(SEAT, [cell({ id: 'OWN-P0', priority: 'P0' })], VERSION, noneMerged);
    expect(choice?.line).toContain('OWN-P0');
    expect(choice?.line).toContain('own');
    expect(choice?.mail).toBeUndefined();
  });

  test('a claim asks OP and does not assign the owner', () => {
    const choice = chooseSeatPull(SEAT, [cell({ id: 'FREE', owner: '', title: 'empty owner cell' })], VERSION, noneMerged);
    expect(choice?.line).toContain('claim-request');
    expect(choice?.mail?.body.startsWith('[CELL-CLAIM-REQ]')).toBe(true);
    expect(choice?.mail?.body).toContain('원장 변경은 OP 확인 뒤');
    expect(choice?.mail?.body).not.toContain('owner=');
  });

  test('without a lookup the landed state stays unknown, so own and claim are not confirmed', () => {
    const cells = [
      cell({ id: 'OWN-P0', priority: 'P0' }),
      cell({ id: 'FREE', owner: '' }),
    ];
    expect(chooseSeatPull(SEAT, cells, VERSION, undefined as unknown as SeatPullPrLookup)).toBeNull();
  });
});
