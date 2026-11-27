// OP-HANDLES-L2a (TRACE-OP-RESOURCE-OPTIMIZATION-1125 §5): ElsControl send/new from the OP seat were refused 12/12 with
// «no rule grants input/new to this pane». The coordinator grant: HQ → new/type/close on federation seat panes in every
// space; a space coordinator → the same inside its own spaces; nobody else. Expectations are literals.
import { describe, expect, test } from 'bun:test';
import { authorizeRequest, coordinatorAuthority, coordinatorGrant, coordinatorTabScope, type FederationJournal, type ServerRole } from './server-auth.js';

const JOURNAL: FederationJournal = {
  hqCoordinatorSeat: 'OP',
  workspaces: [
    { id: 'w-hq', name: 'HQ', coordinatorSeat: 'OP' },
    { id: 'w-tc', name: 'TC-SPACE', coordinatorSeat: 'TC' },
    { id: 'w-ux', name: 'UX-SPACE', coordinatorSeat: 'UX' },
  ],
  tabs: [
    { id: 't-op', workspaceId: 'w-hq' },
    { id: 't-h1', workspaceId: 'w-tc' },
    { id: 't-h2', workspaceId: 'w-ux' },
    { id: 't-x', workspaceId: 'w-tc' },
  ],
  panes: [
    { id: 'p-op', tabId: 't-op', ownerSeat: 'OP' },
    { id: 'p-h1', tabId: 't-h1', ownerSeat: 'TC-H-CX-7' },
    { id: 'p-h2', tabId: 't-h2', ownerSeat: 'UX-H-1' },
    { id: 'p-x', tabId: 't-x', ownerSeat: 'STRANGER' },
  ],
};
const SEATS: ReadonlySet<string> = new Set(['OP', 'TC', 'UX', 'TC-H-CX-7', 'UX-H-1']);

describe('coordinatorAuthority', () => {
  test('a seatless pane in the HQ workspace is the HQ coordinator (the eln OP pane opened by els seat)', () => {
    expect(coordinatorAuthority('unknown', 'p-op', JOURNAL)).toEqual({ scope: 'hq', seat: 'OP' });
  });
  test('the HQ seat named in federation.yaml counts when the journal names none', () => {
    const { hqCoordinatorSeat: _drop, ...noHq } = JOURNAL;
    expect(coordinatorAuthority('HQX', undefined, noHq, 'HQX')).toEqual({ scope: 'hq', seat: 'HQX' });
  });
  test('a space coordinator gets only its spaces · a hand gets nothing', () => {
    expect(coordinatorAuthority('TC', 'p-tc', JOURNAL)).toEqual({ scope: 'space', seat: 'TC', workspaceIds: ['w-tc'] });
    expect(coordinatorAuthority('TC-H-CX-7', 'p-h1', JOURNAL)).toBeUndefined();
  });
});

describe('coordinatorGrant', () => {
  const hq = { scope: 'hq', seat: 'OP' } as const;
  const tc = { scope: 'space', seat: 'TC', workspaceIds: ['w-tc'] } as const;

  test('HQ types into a hand pane in another space and the grant carries its audit line', () => {
    const grant = coordinatorGrant(hq, { op: 'input-line', pane: 'p-h2' }, JOURNAL, SEATS);
    expect(grant?.allow).toBe(true);
    expect(grant?.audit.event).toBe('els.coordinator-grant');
    expect(grant?.audit.scope).toBe('hq');
    expect(grant?.audit.pane).toBe('p-h2');
    expect(grant?.audit.owner).toBe('UX-H-1');
  });
  test('HQ opens a tab in any space; a space coordinator only in its own', () => {
    expect(coordinatorGrant(hq, { op: 'new', ws: 'UX-SPACE' }, JOURNAL, SEATS)?.audit.workspace).toBe('UX-SPACE');
    expect(coordinatorGrant(tc, { op: 'new', ws: 'TC-SPACE' }, JOURNAL, SEATS)?.allow).toBe(true);
    expect(coordinatorGrant(tc, { op: 'new', ws: 'UX-SPACE' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(hq, { op: 'new', ws: 'NO-SUCH' }, JOURNAL, SEATS)).toBeUndefined();
  });
  test('a pane whose owner is not a federation seat is never granted', () => {
    expect(coordinatorGrant(hq, { op: 'input-line', pane: 'p-x' }, JOURNAL, SEATS)).toBeUndefined();
  });
  test('COORD-RIGHTS: interrupt (op · ESC · ^C) is granted in scope; EOF/suspend/quit bytes stay owner-only', () => {
    expect(coordinatorGrant(hq, { op: 'interrupt', pane: 'p-h1' }, JOURNAL, SEATS)?.audit.pane).toBe('p-h1');
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: '\x03' }, JOURNAL, SEATS)?.allow).toBe(true);
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: '\x1b' }, JOURNAL, SEATS)?.allow).toBe(true);
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: '\x04' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: '\x1a' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: '\x03\x04' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(hq, { op: 'input', pane: 'p-h1', bytes: 'go\r' }, JOURNAL, SEATS)?.allow).toBe(true);
    // A space coordinator interrupts in its own space only.
    expect(coordinatorGrant(tc, { op: 'interrupt', pane: 'p-h1' }, JOURNAL, SEATS)?.allow).toBe(true);
    expect(coordinatorGrant(tc, { op: 'interrupt', pane: 'p-h2' }, JOURNAL, SEATS)).toBeUndefined();
  });
  test('COORD-RIGHTS: observe = every coordinator reads every pane in every space (no scope, any owner)', () => {
    for (const op of ['read', 'tile-frame', 'status', 'snapshot']) {
      expect(coordinatorGrant(tc, { op, pane: 'p-h2' }, JOURNAL, SEATS)?.audit).toMatchObject({ op, pane: 'p-h2', owner: 'UX-H-1', observe: true });
      expect(coordinatorGrant(tc, { op, pane: 'p-op' }, JOURNAL, SEATS)?.allow).toBe(true);
      expect(coordinatorGrant(hq, { op, pane: 'p-x' }, JOURNAL, SEATS)?.allow).toBe(true);
    }
    expect(coordinatorGrant(tc, { op: 'read', pane: 'p-none' }, JOURNAL, SEATS, () => undefined)).toBeUndefined();
    // A hand (no authority) still gets nothing.
    expect(coordinatorGrant(undefined, { op: 'read', pane: 'p-h2' }, JOURNAL, SEATS)).toBeUndefined();
  });
  test('close: a hand tab yes · the OP pane/tab no', () => {
    expect(coordinatorGrant(hq, { op: 'close-tab', tab: 't-h1' }, JOURNAL, SEATS)?.audit.tab).toBe('t-h1');
    expect(coordinatorGrant(hq, { op: 'close-tab', tab: 't-op' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(hq, { op: 'close', pane: 'p-op' }, JOURNAL, SEATS)).toBeUndefined();
    expect(coordinatorGrant(tc, { op: 'close', pane: 'p-h2' }, JOURNAL, SEATS)).toBeUndefined();
  });
  test('pane refs resolve through the server lookup', () => {
    expect(coordinatorGrant(hq, { op: 'send', pane: 'w-tc/t-h1/1' }, JOURNAL, SEATS, ref => ref === 'w-tc/t-h1/1' ? 'p-h1' : undefined)?.audit.pane).toBe('p-h1');
  });
});

describe('authorizeRequest with a grant (the 11-25 refusal reproduced → 0)', () => {
  const SEATLESS: ServerRole = { kind: 'hand', seat: 'unknown', workspaces: ['HQ'], pane: 'p-op' };
  test('without the grant the seatless OP pane is refused exactly as on 11-25', () => {
    expect(authorizeRequest(SEATLESS, { op: 'input-line', pane: 'p-h2' }, 'UX-SPACE', [])).toEqual({ allow: false,
      reason: 'els: input-line denied — no rule grants input to this pane; an OP pane is authorized for this request at this gate (other checks may still apply)' });
    expect(authorizeRequest(SEATLESS, { op: 'new', ws: 'UX-SPACE' }, 'UX-SPACE', [])).toEqual({ allow: false,
      reason: 'els: new denied — no rule grants new to this pane; an OP pane is authorized for this request at this gate (other checks may still apply)' });
  });
  test('with the grant: send, new, close-tab, interrupt and snapshot pass; without it interrupt does not', () => {
    expect(authorizeRequest(SEATLESS, { op: 'input-line', pane: 'p-h2' }, 'UX-SPACE', [], undefined, false, true)).toEqual({ allow: true });
    expect(authorizeRequest(SEATLESS, { op: 'new', ws: 'UX-SPACE' }, 'UX-SPACE', [], undefined, false, true)).toEqual({ allow: true });
    const scope = { tabId: 't-h1', workspace: 'TC-SPACE', ownerSeats: ['TC-H-CX-7'], opTab: false, label: 'H1', paneCount: 1 };
    expect(authorizeRequest(SEATLESS, { op: 'close-tab', tab: 't-h1' }, 'TC-SPACE', [], scope, false, true)).toEqual({ allow: true });
    expect(authorizeRequest(SEATLESS, { op: 'interrupt', pane: 'p-h2' }, 'UX-SPACE', [], undefined, false, true).allow).toBe(true);
    expect(authorizeRequest(SEATLESS, { op: 'snapshot', pane: 'p-h2' }, 'UX-SPACE', [], undefined, false, true).allow).toBe(true);
    expect(authorizeRequest(SEATLESS, { op: 'interrupt', pane: 'p-h2' }, 'UX-SPACE', []).allow).toBe(false);
  });
});

describe('coordinatorTabScope', () => {
  test('the HQ coordinator seat is not confined to the one space it also coordinates', () => {
    const journal = { hqCoordinatorSeat: 'HQX', workspaces: [{ id: 'w1', name: 'HQ', coordinatorSeat: 'HQX' }, { id: 'w2', name: 'OTHER' }], tabs: [] };
    const role: ServerRole = { kind: 'hand', seat: 'HQX', workspaces: [], pane: 'p' };
    expect(coordinatorTabScope(role, { op: 'new', ws: 'OTHER' }, journal)).toBeUndefined();
    const space: ServerRole = { kind: 'hand', seat: 'TC', workspaces: [], pane: 'p' };
    expect(coordinatorTabScope(space, { op: 'new', ws: 'OTHER' }, { workspaces: [{ id: 'w3', name: 'TCS', coordinatorSeat: 'TC' }, { id: 'w2', name: 'OTHER' }], tabs: [] }))
      .toEqual({ allow: false, reason: 'els: new denied — coordinator is restricted to its assigned workspace' });
  });
});
