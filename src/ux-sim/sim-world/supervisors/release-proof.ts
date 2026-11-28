// SIM-WORLD supervisors — RELEASE-HUMAN-PROOF-TRUST-ROOT (대표 11-28 13:3x YES · DESIGN-TRUST-ROOT.md ⑥ S1~S9).
// 0.3.35 and 0.3.38: the CEO approved the publish card on Telegram, the ledger said `decided · human`, and critpath said
// «human proof unverified» — nobody signed. Each scene drives the REAL pieces end to end inside its own universe:
// the real critpath card (critpathApprovalCard) in the real DecisionLedger · the real Telegram tap path
// (DecisionCardService.tap: owner check → irreversible two-step → signApprovalProof) · the real PWA route
// (handleDecisions: 428 confirm token → owner credential → signer) · the real TOFU signer (ensureApprovalSigner ·
// rotate · revoke) on disk (0700/0600 · trust-root.json · credential owner slot). Only the outside is faked: the bot
// transport, and critpath's prepare/publish/npm/verify. Five seeds per scene, both engines:
//   legacy = the approval check critpath and `decisions verify` read (approvalState over the ledger + trust root)
//   graph  = the full critpath run (runCritpath) — publish/npm/verify run only on a verified proof
// Expectations are independent literals (rule 11): states, reasons and call lists are written here, not rendered.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { approvalRef, approvalState, runCritpath, type ApprovalBinding, type ApprovalState, type CritpathDeps } from '../../../../scripts/release-loop/critpath.js';
import { critpathApprovalCard } from '../../../cli/release-critpath-cli.js';
import { DecisionCardService, type CardTransport } from '../../../decisions/decision-cards.js';
import { DecisionLedger, readDecisionTrustRoots, type ApprovalProofBinding, type DecisionEntry } from '../../../decisions/decision-ledger.js';
import { ensureApprovalSigner, revokeApprovalSigner, rotateApprovalSigner, signApprovalProof, signerPaths, type SignOutcome, type SignerStatus } from '../../../decisions/approval-signer.js';
import { handleDecisions } from '../../../nexus/api/decisions-route.js';
import { readCredentialOwner } from '../../../nexus/config/secrets/cred-owner.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];
const same = (got: unknown, want: unknown): boolean => JSON.stringify(got) === JSON.stringify(want);
const HOST = 'mshq'; // not-policy: sim fixture — the literal host name the scene expects in keyIds and the owner slot
const OWNER = '5550001111';
const STRANGER = '5550002222';

/** Per seed: version · cut · day (seed 1 replays the 0.3.38 card D-20261127-01's cut). Literal rows. */
const ROWS: ReadonlyArray<{ version: string; cut: string; day: string }> = [
  { version: '0.3.38', cut: 'e976fc64df18'.padEnd(40, '0'), day: '2026-11-27' },
  { version: '0.3.39', cut: '9126baa991f0'.padEnd(40, '1'), day: '2026-11-28' },
  { version: '0.3.40', cut: '6ac7d7b2cc30'.padEnd(40, '2'), day: '2026-11-29' },
  { version: '0.3.41', cut: 'a7f6683894c0'.padEnd(40, '3'), day: '2026-11-30' },
  { version: '0.3.42', cut: '2c4ed3bbfdf0'.padEnd(40, '4'), day: '2026-12-01' },
];
const row = (seed: number) => ROWS[((seed - 1) % 5 + 5) % 5]!;

interface World {
  readonly root: string; readonly stateDir: string; readonly ownerLedger: string; readonly ledger: DecisionLedger;
  readonly binding: ApprovalBinding; readonly notes: string; readonly alerts: string[]; readonly version: string; readonly cut: string;
  boot(): SignerStatus;
  raise(binding?: ApprovalBinding): DecisionEntry;
  readonly signer: (b: ApprovalProofBinding) => SignOutcome;
  tg(user: string, data: string): Promise<string>;
  judge(engine: SimWorldEngine, binding?: ApprovalBinding, stateDir?: string): Promise<Judged>;
}
interface Judged { readonly state: ApprovalState['state']; readonly reason: string | null; readonly keyId: string | null; readonly calls: string[]; readonly detail: string }

function world(ctx: SimWorldScenarioContext, tag: string, seed: number): World {
  const { version, cut, day } = row(seed);
  const root = join(ctx.universeRoot, tag);
  const stateDir = join(root, 'mshq-state');
  mkdirSync(stateDir, { recursive: true });
  const ownerLedger = join(root, 'credential-owner-ledger.json');
  const at = `${day}T05:00:00.000Z`;
  const ledger = new DecisionLedger({ stateDir, now: () => new Date(at), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
  const notes = join(root, 'notes.md');
  writeFileSync(notes, `# elanous v${version}\n\nPublic notes for seed ${seed}.\n`);
  const binding: ApprovalBinding = { version, cutSha: cut, notesSha256: createHash('sha256').update(readFileSync(notes)).digest('hex') };
  const alerts: string[] = [];
  const transport: CardTransport = { platform: 'telegram', ownerChats: async () => [OWNER], send: async () => ({ chat: OWNER, message: '1' }), edit: async () => undefined, notify: async () => undefined };
  // The universe's own owner ledger and host — the production default reads ~/.elanous and the HQ host file.
  const signer = (b: ApprovalProofBinding) => signApprovalProof(b, { stateDir, ownerLedgerPath: ownerLedger, host: HOST });
  const service = new DecisionCardService({ transport, ownerIds: [OWNER], ledger, statePath: join(stateDir, 'decisions', 'cards-telegram.json'), signer });
  let runs = 0; // every critpath judge is a fresh run ledger (a rerun would skip steps a previous judge already did)
  return {
    root, stateDir, ownerLedger, ledger, binding, notes, alerts, version, cut, signer,
    boot: () => ensureApprovalSigner({ stateDir, ownerLedgerPath: ownerLedger, host: HOST, now: () => new Date(at), notify: (line) => { alerts.push(line); } }),
    raise: (b = binding) => ledger.raiseOnce(critpathApprovalCard(b), approvalRef(b)),
    tg: async (user, data) => (await service.tap(user, data)).kind,
    async judge(engine, b = binding, dir = stateDir) {
      const roots = readDecisionTrustRoots(dir);
      const records = ledger.list({ status: 'all' });
      if (engine === 'legacy') {
        const s = approvalState(records, b, roots);
        return { state: s.state, reason: s.state === 'unverified' ? s.reason ?? null : null, keyId: s.state === 'approved' ? s.keyId ?? null : null, calls: [], detail: '' };
      }
      const calls: string[] = [];
      const deps: CritpathDeps = {
        readPrepared: () => ({ dir: root, version: b.version, tag: `v${b.version}`, publicRepo: 'example/elanous', sourceRef: b.cutSha, sourceCommit: b.cutSha,
          publicCommit: 'c'.repeat(40), tgz: join(root, 'elanous.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }),
        resolveBranch: () => b.cutSha, prepare: async () => { throw new Error('unexpected prepare'); },
        githubReleaseExists: () => false, publish: async () => { calls.push('publish'); },
        npmRegistry: async () => ({ visible: false }), npmDryRun: () => ({ ok: true, detail: 'ok' }),
        npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
        verify: async () => { calls.push('verify'); return { ok: true, summary: 'verify ok' }; },
        approvalRecords: () => ledger.list({ status: 'all' }), trustRoots: () => readDecisionTrustRoots(dir),
        requestApproval: (nb) => { calls.push('card'); return { id: ledger.raiseOnce(critpathApprovalCard(nb), approvalRef(nb)).id }; },
        log: () => undefined, now: () => new Date(at),
      };
      const ledgerPath = join(root, `critpath-run-${++runs}.json`);
      const r = await runCritpath({ version: b.version, notesFile: notes, cutCommit: b.cutSha, out: join(root, 'prepared'), ledgerPath }, deps);
      const approval = r.approval;
      const state = r.status === 'done' ? 'approved' : approval?.state ?? 'none';
      const critLedger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '';
      return { state, reason: approval?.state === 'unverified' ? approval.reason ?? null : null, keyId: null, calls, detail: `${r.status}/${r.exitCode} ${critLedger.includes('human-proof-unavailable:') ? /human-proof-unavailable:[a-z-]+/.exec(critLedger)![0] : ''}`.trim() };
    },
  };
}

async function tapApprove(w: World, id: string, user = OWNER): Promise<string[]> {
  return [await w.tg(user, `dec:${id}:a`), await w.tg(user, `dec:${id}:a:ok`)];
}

async function scene(ctx: SimWorldScenarioContext, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) {
    const out = await body(seed, ctx.engine);
    if (out) return out;
  }
  ctx.recorder.event('release-proof:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
  return { ok: true };
}
const approvedOk = (j: Judged, engine: SimWorldEngine): boolean => engine === 'legacy' ? j.state === 'approved' : j.state === 'approved' && same(j.calls, ['publish', 'npm', 'verify']);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'RP-S1',
    title: 'owner taps A twice on Telegram → the TOFU signer signs → critpath approved and publishes (no OP delegation)',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s1-${engine}-s${seed}`, seed);
        const boot = w.boot();
        const day = row(seed).day.replaceAll('-', '');
        if (boot.state !== 'generated' || boot.keyId !== `nexus-mshq-${day}`) return fail('tofu', `seed ${seed} ${engine}: boot ${JSON.stringify(boot)} (want generated nexus-mshq-${day})`);
        const p = signerPaths(w.stateDir);
        const modes = [(statSync(p.dir).mode & 0o777).toString(8), (statSync(p.key).mode & 0o777).toString(8)];
        if (!same(modes, ['700', '600'])) return fail('key-perms', `seed ${seed} ${engine}: modes ${modes.join('/')} (want 700/600)`);
        const slot = readCredentialOwner('release-approval-signer', w.ownerLedger);
        if (!same(slot, { slot: 'release-approval-signer', ownerHost: 'mshq', mirrors: [] })) return fail('owner-slot', `seed ${seed} ${engine}: ${JSON.stringify(slot)}`);
        if (/BEGIN PRIVATE KEY/.test(readFileSync(p.trustRoot, 'utf8')) || w.alerts.some(a => /PRIVATE KEY/.test(a))) return fail('key-leak', `seed ${seed} ${engine}: private key text outside the key file`);
        const card = w.raise();
        const taps = await tapApprove(w, card.id);
        if (!same(taps, ['confirm', 'decided'])) return fail('tap', `seed ${seed} ${engine}: taps ${JSON.stringify(taps)} (want ["confirm","decided"])`);
        const decided = w.ledger.show(card.id);
        if (!same(decided.decidedBy, { kind: 'human', via: 'telegram', platformUserId: OWNER }) || decided.proof?.keyId !== `nexus-mshq-${day}`) return fail('row', `seed ${seed} ${engine}: ${JSON.stringify({ by: decided.decidedBy, proof: decided.proof?.keyId })}`);
        const j = await w.judge(engine);
        if (!approvedOk(j, engine)) return fail('not-approved', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want approved${engine === 'graph' ? ' + publish/npm/verify' : ''})`);
        if (engine === 'legacy' && j.keyId !== `nexus-mshq-${day}`) return fail('keyid', `seed ${seed}: approved by ${j.keyId}`);
        const second = w.boot();
        if (second.state !== 'ready' || readDecisionTrustRoots(w.stateDir).length !== 1) return fail('tofu-twice', `seed ${seed} ${engine}: second boot ${JSON.stringify(second)}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S2',
    title: 'approved, then the cut is redone (notes change) → the old proof does not carry · a new card is raised',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s2-${engine}-s${seed}`, seed);
        w.boot();
        const card = w.raise();
        await tapApprove(w, card.id);
        writeFileSync(w.notes, `# elanous v${w.version}\n\nRecut notes for seed ${seed}.\n`);
        const recut: ApprovalBinding = { ...w.binding, notesSha256: createHash('sha256').update(readFileSync(w.notes)).digest('hex') };
        const j = await w.judge(engine, recut);
        const open = w.ledger.list({ status: 'open' }).filter(e => e.refs?.includes(approvalRef(recut)));
        if (engine === 'legacy') {
          if (j.state !== 'none') return fail('carried', `seed ${seed}: recut state ${j.state} (want none)`);
        } else if (j.state !== 'pending' || !same(j.calls, ['card']) || open.length !== 1 || open[0]!.id === card.id) {
          return fail('no-new-card', `seed ${seed}: ${JSON.stringify(j)} · open ${JSON.stringify(open.map(e => e.id))}`);
        }
        const old = await w.judge('legacy', w.binding);
        if (old.state !== 'approved') return fail('old-lost', `seed ${seed} ${engine}: the original binding is ${old.state}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S3',
    title: 'a valid proof copied onto another card (forged human row) → unverified(bad-sig) · nothing published',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s3-${engine}-s${seed}`, seed);
        w.boot();
        const good = w.raise();
        await tapApprove(w, good.id);
        const stolen = w.ledger.show(good.id).proof!;
        const other: ApprovalBinding = { ...w.binding, cutSha: w.cut.slice(0, 39) + 'f' };
        const target = w.raise(other);
        // The same-UID forger writes a chain-valid human row and pastes the real proof.
        w.ledger.decide(target.id, 'a', { kind: 'human', via: 'telegram', platformUserId: OWNER }, undefined, undefined, stolen);
        const j = await w.judge(engine, other);
        if (j.state !== 'unverified' || j.reason !== 'bad-sig' || j.calls.length) return fail('transplant-accepted', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want unverified bad-sig · no calls)`);
        return null;
      });
    },
  },
  {
    id: 'RP-S4',
    title: 'private key deleted while the trust root stays → no regeneration · alert · the tap records no proof · critpath names the delegation reason',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s4-${engine}-s${seed}`, seed);
        const first = w.boot();
        unlinkSync(signerPaths(w.stateDir).key);
        const again = w.boot();
        if (again.state !== 'signer-missing' || existsSync(signerPaths(w.stateDir).key)) return fail('regenerated', `seed ${seed} ${engine}: ${JSON.stringify(again)} key=${existsSync(signerPaths(w.stateDir).key)}`);
        if (!same(readDecisionTrustRoots(w.stateDir).map(k => k.keyId), [first.keyId])) return fail('root-changed', `seed ${seed} ${engine}: roots ${JSON.stringify(readDecisionTrustRoots(w.stateDir))}`);
        if (w.alerts.length !== 2 || !w.alerts[1]!.includes('signer-missing') || !w.alerts[1]!.includes('human-proof-unavailable:signer-missing')) return fail('no-alert', `seed ${seed} ${engine}: ${JSON.stringify(w.alerts)}`);
        const card = w.raise();
        await tapApprove(w, card.id);
        if (w.ledger.show(card.id).proof) return fail('proof-without-key', `seed ${seed} ${engine}`);
        const j = await w.judge(engine);
        if (j.state !== 'unverified' || j.reason !== 'no-proof' || j.calls.length) return fail('not-unverified', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        if (engine === 'graph' && j.detail !== 'waiting-approval/75 human-proof-unavailable:no-proof') return fail('delegation-reason', `seed ${seed}: ${j.detail}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S5',
    title: 'rotate → an old proof still verifies and a new tap signs with the new key · revoke the old key → its proof is unknown-key',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s5-${engine}-s${seed}`, seed);
        const first = w.boot();
        const oldCard = w.raise();
        await tapApprove(w, oldCard.id);
        const rotated = rotateApprovalSigner({ stateDir: w.stateDir, ownerLedgerPath: w.ownerLedger, host: HOST, now: () => new Date(`${row(seed).day}T06:00:00.000Z`) });
        const day = row(seed).day.replaceAll('-', '');
        if (!same(rotated, { keyId: `nexus-mshq-${day}-2`, previous: `nexus-mshq-${day}` })) return fail('rotate', `seed ${seed} ${engine}: ${JSON.stringify(rotated)}`);
        if ((await w.judge(engine)).state !== 'approved') return fail('old-proof-lost', `seed ${seed} ${engine}: old proof after rotate`);
        const next: ApprovalBinding = { ...w.binding, cutSha: w.cut.slice(0, 39) + 'e' };
        const newCard = w.raise(next);
        await tapApprove(w, newCard.id);
        if (w.ledger.show(newCard.id).proof?.keyId !== rotated.keyId) return fail('new-key', `seed ${seed} ${engine}: ${w.ledger.show(newCard.id).proof?.keyId}`);
        const revoked = revokeApprovalSigner(first.keyId!, { stateDir: w.stateDir });
        if (!same(revoked, { revoked: true, deletedPrivateKey: false })) return fail('revoke', `seed ${seed} ${engine}: ${JSON.stringify(revoked)}`);
        const old = await w.judge(engine);
        if (old.state !== 'unverified' || old.reason !== 'unknown-key' || old.calls.length) return fail('revoked-accepted', `seed ${seed} ${engine}: ${JSON.stringify(old)}`);
        const fresh = await w.judge(engine, next);
        if (!approvedOk(fresh, engine)) return fail('new-proof', `seed ${seed} ${engine}: ${JSON.stringify(fresh)}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S6',
    title: 'a Telegram user who is not the owner taps A → refused · the card stays open · nothing signed',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s6-${engine}-s${seed}`, seed);
        w.boot();
        const card = w.raise();
        const taps = await tapApprove(w, card.id, STRANGER);
        if (!same(taps, ['refused', 'refused'])) return fail('stranger', `seed ${seed} ${engine}: ${JSON.stringify(taps)}`);
        const audit = existsSync(signerPaths(w.stateDir).audit) ? readFileSync(signerPaths(w.stateDir).audit, 'utf8') : '';
        if (w.ledger.show(card.id).status !== 'open' || audit.includes('"signed"')) return fail('stranger-effect', `seed ${seed} ${engine}: ${w.ledger.show(card.id).status}`);
        const j = await w.judge(engine);
        if (j.state !== 'pending' || j.calls.length) return fail('not-pending', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S7',
    title: 'a seat writes a human approval row straight into the ledger (no tap) → unverified(no-proof)',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s7-${engine}-s${seed}`, seed);
        w.boot();
        const card = w.raise();
        w.ledger.decide(card.id, 'a', { kind: 'human', via: 'telegram', platformUserId: OWNER });
        const j = await w.judge(engine);
        if (j.state !== 'unverified' || j.reason !== 'no-proof' || j.calls.length) return fail('row-is-proof', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S8',
    title: 'Telegram is down → the owner answers in the PWA (428 confirm → owner credential) → approved with via pwa',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s8-${engine}-s${seed}`, seed);
        const boot = w.boot();
        const card = w.raise();
        const url = `http://nexus.test/v1/decisions/${card.id}/decide`;
        const post = (body: object) => handleDecisions(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          { authorize: () => true, ownerProof: () => true, ledger: w.ledger, signer: w.signer });
        const asked = await post({ choice: 'a' });
        const { confirmToken } = await asked.json() as { confirmToken: string };
        if (asked.status !== 428 || w.ledger.show(card.id).status !== 'open') return fail('no-confirm-step', `seed ${seed} ${engine}: first POST ${asked.status}`);
        const done = await post({ choice: 'a', confirmToken });
        const decided = w.ledger.show(card.id);
        if (done.status !== 200 || !same(decided.decidedBy, { kind: 'human', via: 'pwa', platformUserId: 'pwa-owner' }) || decided.proof?.keyId !== boot.keyId) return fail('pwa-row', `seed ${seed} ${engine}: ${done.status} ${JSON.stringify({ by: decided.decidedBy, proof: decided.proof?.keyId })}`);
        const j = await w.judge(engine);
        if (!approvedOk(j, engine)) return fail('pwa-not-approved', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        return null;
      });
    },
  },
  {
    id: 'RP-S9',
    title: 'critpath on another host with only the public trust root copied → approved · that host holds no private key',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s9-${engine}-s${seed}`, seed);
        w.boot();
        const card = w.raise();
        await tapApprove(w, card.id);
        const other = join(w.root, 'node-b-state');
        mkdirSync(join(other, 'release'), { recursive: true });
        copyFileSync(signerPaths(w.stateDir).trustRoot, join(other, 'release', 'trust-root.json'));
        const j = await w.judge(engine, w.binding, other);
        if (!approvedOk(j, engine)) return fail('remote-not-approved', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        if (existsSync(signerPaths(other).key)) return fail('key-copied', `seed ${seed} ${engine}`);
        return null;
      });
    },
  },
];
