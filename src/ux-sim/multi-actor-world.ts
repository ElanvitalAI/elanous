import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createAppActions, handleAppActionRequest, type AppActionDeclaration } from '../nexus/apps/app-actions.js';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { createAppKillSwitch } from '../relay/app-kill-switch.js';
import { serverIdFromPublicKey } from '../relay/channel.js';
import { startRelayServer } from '../relay/relay-server.js';
import { planTrain } from '../self-implement/merge-train.js';
import { createFakeAppAuth } from './fake-app-auth.js';

export interface MultiActorLedgerEntry {
  readonly actorId: string;
  readonly event: string;
  readonly outcome: string;
}

/** Exercises production invitation, app-action authorization, kill-switch, and train-planning paths. */
export async function runMultiActorSimulation(options: { invitationRoleOverrides?: Readonly<Record<string, string>> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'multi-actor-world-')));
  const auth = createFakeAppAuth({ dir: join(root, 'auth'), key: 'multi-actor-simulation-key' });
  const roles = { owner: { via: 'nexus-session' }, editor: { via: 'share-link' }, agent: { via: 'share-link' }, viewer: { via: 'share-link' } };
  const actors = [
    { id: 'owner-user', role: 'owner' },
    { id: 'editor-user', role: 'editor' },
    { id: 'editing-agent', role: 'agent' },
    { id: 'reader-user', role: 'viewer' },
  ] as const;
  const sessions = new Map<string, string>();
  const relayMemberToken = 'emt_multi_actor_editing_agent';
  const ledger: MultiActorLedgerEntry[] = [];
  const manifest = {
    apiVersion: 'elanous.app/v0' as const,
    slug: 'multi-actor',
    title: 'Multi actor simulation',
    frontend: { kind: 'static-export' as const, out: 'out' },
    roles,
    actions: { summarize: { builtin: 'summarize' as const,
      input: { text: 'text' }, output: { text: 'text' }, uses: ['cred:openai.api_key'], allow: ['editor', 'agent'] } },
  };
  const parsedManifest = parseAppManifest(JSON.stringify(manifest));
  if (!parsedManifest.ok) throw new Error(`invalid multi-actor app manifest: ${JSON.stringify(parsedManifest.errors)}`);
  const actionDeclaration = (parsedManifest.manifest.actions as Record<string, AppActionDeclaration>).summarize!;
  const manifestRoles = parsedManifest.manifest.roles as Record<string, unknown>;
  const appActions = createAppActions({ secrets: { async resolve() { return 'simulation-only'; } }, async summarize({ text }) { return text; } });
  const authDatabase = new Database(':memory:');
  authDatabase.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content TEXT NOT NULL)');
  // Source: a newly created shared document begins at revision 0 in this scenario fixture.
  authDatabase.run('INSERT INTO documents VALUES (?, ?, ?)', ['shared-note', 0, 'base']);
  const documentDb = authDatabase;
  const killSwitch = createAppKillSwitch(join(root, 'kill-switch.sqlite'), {
    authorizeReactivation: ({ actor }) => actor.kind === 'operator' && actor.id === 'admin-user',
  });
  let relay: ReturnType<typeof startRelayServer> | undefined;

  try {
    for (const actor of actors) {
      const invitation = auth.issueInvitation({
        appSlug: 'multi-actor', invitedBy: 'owner-user', role: options.invitationRoleOverrides?.[actor.id] ?? actor.role,
      });
      const accepted = auth.acceptInvitation({ appSlug: 'multi-actor', token: invitation.token });
      if (accepted.status !== 200 || !accepted.sessionToken) throw new Error(`invitation failed for ${actor.id}`);
      sessions.set(actor.id, accepted.sessionToken);
      ledger.push({ actorId: actor.id, event: 'invitation.accepted', outcome: accepted.role ?? 'unknown' });
    }

    const invokeAction = async (actorId: string, phase: string) => {
      const sessionToken = sessions.get(actorId);
      if (!sessionToken) throw new Error(`no app session for ${actorId}`);
      const actorSession = auth.verifySession({ appSlug: manifest.slug, token: sessionToken });
      const actorRole = actorSession.role ?? '';
      if (actorSession.status !== 200) throw new Error(`app session failed verification for ${actorId}`);
      // Source: relay-server.ts publicFetch denies the targeted app with HTTP 403 while its kill switch is down.
      if (killSwitch.isDown(manifest.slug, manifest.slug)) {
        ledger.push({ actorId, event: `action.summarize.${phase}`, outcome: 'blocked' });
        return { actorId, status: 403 };
      }
      let status = 0;
      const response = await handleAppActionRequest(new Request(`http://${manifest.slug}.invalid/v1/apps/${manifest.slug}/actions/summarize`, {
        method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: `edit by ${actorId}` }),
      }), {
        authorize(request, slug) {
          const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
          const session = auth.verifySession({ appSlug: slug, token });
          const role = session.role ?? '';
          return slug === manifest.slug && session.status === 200 && Object.hasOwn(manifestRoles, role)
            && actionDeclaration.allow?.includes(role) === true;
        },
        getDeclaration: async (slug, name) => slug === manifest.slug && name === 'summarize' ? actionDeclaration : undefined,
        run: (input) => appActions.run(input),
      });
      status = response?.status ?? 0;
      ledger.push({ actorId, event: `action.summarize.${phase}`, outcome: status === 200 ? 'allowed' : 'denied' });
      return { actorId, role: actorRole, status };
    };
    const actionResults = await Promise.all(actors.filter((actor) => actor.role !== 'owner')
      .map((actor) => invokeAction(actor.id, 'initial')));

    const edits = actors.filter((actor) => actor.role === 'editor' || actor.role === 'agent');
    const editResults = await Promise.all(edits.map(async (actor) => {
      await Promise.resolve();
      const result = documentDb.query('UPDATE documents SET content = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .run(`edit by ${actor.id}`, 'shared-note', 0);
      const outcome = result.changes === 1 ? 'committed' : 'revision-conflict';
      ledger.push({ actorId: actor.id, event: 'document.edit', outcome });
      return { actorId: actor.id, outcome };
    }));
    const document = documentDb.query('SELECT revision, content FROM documents WHERE id = ?').get('shared-note') as { revision: number; content: string };

    const signingKey = generateKeyPairSync('ed25519');
    const signingPublicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const hostKey = generateKeyPairSync('x25519');
    const serverId = serverIdFromPublicKey(new Uint8Array(hostKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
    relay = startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]), publicDomain: 'elanous.app',
      publicServerId: serverId, publicUserId: manifest.slug, memberRequired: true,
      hostOwnerMemberIds: new Map([[serverId, 'editing-agent']]),
      validateMemberToken: async (token) => {
        if (token !== relayMemberToken) return null;
        const sessionToken = sessions.get('editing-agent');
        const session = sessionToken ? auth.verifySession({ appSlug: manifest.slug, token: sessionToken }) : null;
        return session?.status === 200 && session.role === 'agent' ? { memberId: 'editing-agent' } : null;
      }, appKillSwitch: killSwitch });
    const requestAsEditingAgent = async (phase: string) => {
      const response = await fetch(`http://127.0.0.1:${relay!.port}/v1/apps/${manifest.slug}/actions/summarize`, {
        method: 'POST', headers: { host: `${manifest.slug}--${manifest.slug}.elanous.app`, authorization: `Bearer ${relayMemberToken}`,
          'content-type': 'application/json' }, body: JSON.stringify({ text: 'request from editing agent' }),
      });
      ledger.push({ actorId: 'editing-agent', event: `app-action.request.${phase}`, outcome: String(response.status) });
      return { actorId: 'editing-agent', status: response.status };
    };
    const actionBeforeBlock = await requestAsEditingAgent('before-block');

    killSwitch.applyIncident({ userId: 'multi-actor', appId: 'multi-actor', incident: 'abuse-report',
      reason: 'administrator simulation block', requestedBy: 'admin-user' });
    const blocked = killSwitch.isDown('multi-actor', 'multi-actor');
    ledger.push({ actorId: 'admin-user', event: 'app.block', outcome: blocked ? 'blocked' : 'not-blocked' });
    const actionDuringBlock = await requestAsEditingAgent('during-block');
    killSwitch.reactivate({ userId: 'multi-actor', appId: 'multi-actor', actor: { kind: 'operator', id: 'admin-user' } });
    const reactivated = !killSwitch.isDown('multi-actor', 'multi-actor');
    ledger.push({ actorId: 'admin-user', event: 'app.unblock', outcome: reactivated ? 'reactivated' : 'still-blocked' });
    const actionAfterReactivation = await requestAsEditingAgent('after-reactivation');

    // Source: src/self-implement/merge-train.ts planTrain maxBatch and overlap-defer contract.
    // Source: two distinct seat submissions are required to observe an overlap deferral.
    const submissions = [
      { actorId: 'seat-alpha', number: 1, head: '1'.repeat(40), files: ['src/shared/document.ts'] },
      { actorId: 'seat-beta', number: 2, head: '2'.repeat(40), files: ['src/shared/document.ts'] },
    ];
    const landPlan = planTrain(submissions.map(({ number, head, files }) => ({ number, head, files })), { maxBatch: 2 });
    const selectedSubmission = submissions.find((submission) => submission.number === landPlan.batch[0]?.number);
    const deferredSubmission = submissions.find((submission) => submission.number === landPlan.deferred[0]?.number);
    const landRace = {
      selectedSeat: selectedSubmission?.actorId,
      deferredSeat: deferredSubmission?.actorId,
      deferredReason: landPlan.deferred[0]?.reason,
      deferredWith: landPlan.deferred[0]?.with,
    };
    if (selectedSubmission) ledger.push({ actorId: selectedSubmission.actorId, event: 'land.submit', outcome: 'selected' });
    if (deferredSubmission) ledger.push({ actorId: deferredSubmission.actorId, event: 'land.submit', outcome: landPlan.deferred[0]?.reason ?? 'selected' });

    const invitations = actors.map(({ id }) => {
      const token = sessions.get(id)!;
      const session = auth.verifySession({ appSlug: manifest.slug, token });
      return { actorId: id, role: session.role ?? 'unknown', accepted: session.status === 200 };
    });
    const expectedRoles = actors.map(({ id, role }) => ({ actorId: id, role }));
    const invitationRolesMatch = expectedRoles.every((expected) => invitations.some((actual) =>
      actual.actorId === expected.actorId && actual.role === expected.role && actual.accepted))
      && invitations.every((actual) => expectedRoles.some((expected) =>
        expected.actorId === actual.actorId && expected.role === actual.role));
    const expectedActions = [
      { actorId: 'editor-user', role: 'editor', status: 200 },
      { actorId: 'editing-agent', role: 'agent', status: 200 },
      { actorId: 'reader-user', role: 'viewer', status: 401 },
    ];
    const actionOutcomesMatch = expectedActions.every((expected) => actionResults.some((actual) =>
      actual.actorId === expected.actorId && actual.role === expected.role && actual.status === expected.status));
    const declaredAllowListMatches = JSON.stringify([...(actionDeclaration.allow ?? [])].sort()) === JSON.stringify(['agent', 'editor']);

    return {
      pass: invitationRolesMatch && declaredAllowListMatches && actionOutcomesMatch
        && editResults.filter((result) => result.outcome === 'committed').length === 1
        && editResults.filter((result) => result.outcome === 'revision-conflict').length === 1
        && blocked && actionBeforeBlock.status === 503 && actionDuringBlock.status === 403
        && reactivated && actionAfterReactivation.status === 503
        && selectedSubmission?.actorId === 'seat-alpha' && deferredSubmission?.actorId === 'seat-beta'
        && !!selectedSubmission && landPlan.deferred[0]?.reason === 'overlap'
        && landPlan.deferred[0]?.with?.includes(selectedSubmission.number),
      invitations,
      invitationRolesMatch,
      actions: actionResults,
      edits: { results: editResults, document },
      adminBlock: { blocked, actionBeforeBlock, actionDuringBlock, reactivated, actionAfterReactivation },
      landRace,
      ledger,
    };
  } finally {
    relay?.stop();
    killSwitch.close();
    authDatabase.close();
    rmSync(root, { recursive: true, force: true });
  }
}
