import { expect, test } from 'bun:test';
import { runMultiActorSimulation } from './multi-actor-world.js';

test('SIM-MULTI-ACTOR keeps per-actor evidence across invitation, edits, admin block, and seat contention', async () => {
  const result = await runMultiActorSimulation();

  expect(result.pass).toBe(true);
  // Source: invitation roles are issued by the actor fixtures in multi-actor-world.ts.
  expect(result.invitations).toEqual([
    { actorId: 'owner-user', role: 'owner', accepted: true },
    { actorId: 'editor-user', role: 'editor', accepted: true },
    { actorId: 'editing-agent', role: 'agent', accepted: true },
    { actorId: 'reader-user', role: 'viewer', accepted: true },
  ]);
  // Source: AppAuthResponse uses HTTP statuses 200 and 401 (src/ux-sim/fake-app-auth.ts).
  expect(result.actions).toEqual([
    { actorId: 'editor-user', role: 'editor', status: 200 },
    { actorId: 'editing-agent', role: 'agent', status: 200 },
    { actorId: 'reader-user', role: 'viewer', status: 401 },
  ]);
  expect(result.edits.results.map(({ outcome }) => outcome).sort()).toEqual(['committed', 'revision-conflict']);
  // Source: relay-server.ts returns 503 for an offline host and 403 for a blocked public app request.
  expect(result.adminBlock).toMatchObject({
    blocked: true,
    actionBeforeBlock: { actorId: 'editing-agent', status: 503 },
    actionDuringBlock: { actorId: 'editing-agent', status: 403 },
    reactivated: true,
    actionAfterReactivation: { actorId: 'editing-agent', status: 503 },
  });
  // Source: two seat candidates in multi-actor-world.ts are numbered 1 and 2 and share one path.
  expect(result.landRace).toMatchObject({
    selectedSeat: 'seat-alpha',
    deferredSeat: 'seat-beta',
    deferredReason: 'overlap',
    deferredWith: [1],
  });
  expect(new Set(result.ledger.map(({ actorId }) => actorId))).toEqual(new Set([
    'owner-user', 'editor-user', 'editing-agent', 'reader-user', 'admin-user', 'seat-alpha', 'seat-beta',
  ]));
  expect(result.ledger.filter(({ actorId }) => actorId === 'editing-agent').map(({ event }) => event)
    .sort()).toEqual([
      'action.summarize.initial', 'app-action.request.after-reactivation', 'app-action.request.before-block',
      'app-action.request.during-block', 'document.edit', 'invitation.accepted',
    ]);
});

test('SIM-MULTI-ACTOR rejects an invitation whose issued session role differs from the actor role', async () => {
  const result = await runMultiActorSimulation({ invitationRoleOverrides: { 'reader-user': 'agent' } });

  expect(result.invitations.find(({ actorId }) => actorId === 'reader-user')).toEqual({
    actorId: 'reader-user', role: 'agent', accepted: true,
  });
  expect(result.invitationRolesMatch).toBe(false);
  expect(result.pass).toBe(false);
});
