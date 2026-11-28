// SIM-WORLD supervisors — RELEASE-PRESIGNED-AUTO (대표 11-28 14:4x «자기 전에 미리 서명 · 그 서명으로 자동 발행·서저리 발행»).
// Design: seat-state/OP/evidence/20261128/DESIGN-PRESIGNED-RELEASE.md ⑦. Each scene drives the REAL pieces in its own
// universe: the real pre-auth card (kit raisePreAuth over graphs/policies/release-proof.yaml) in the real DecisionLedger ·
// the real Telegram tap (DecisionCardService.tap: owner → irreversible two-step → signApprovalProof) · the real TOFU signer
// on disk · the real gate (kit preAuthGate). Only the outside is faked: the bot transport, the checklist reds / HOLDs
// (scene facts), and critpath's prepare/publish/npm/verify. Five seeds per scene, both engines:
//   legacy = the kit gate alone (preAuthGate · judge ⊕ record) — what the release graph's `go` calls
//   graph  = the full critpath run (dry run on the cut, then the real run) — publish/npm/verify only on a usable pre-auth
// Expectations are independent literals (rule 11): reasons, lines and call lists are written here, not rendered.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalRef, runCritpath, type ApprovalBinding, type CritpathDeps } from '../../../../scripts/release-loop/critpath.js';
import { critpathApprovalCard, defaultPreAuthDeps } from '../../../cli/release-critpath-cli.js';
import { DecisionCardService, type CardTransport } from '../../../decisions/decision-cards.js';
import { DecisionLedger, readDecisionTrustRoots } from '../../../decisions/decision-ledger.js';
import { ensureApprovalSigner, signApprovalProof } from '../../../decisions/approval-signer.js';
import { loadPreAuthPolicy, preAuthGate, raisePreAuth, readPreAuthUses, revokePreAuth, type ChecklistRed, type PreAuthGateIo, type PreAuthMode, type PreAuthUse } from '../../../kit/release-preauth/index.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];
const same = (got: unknown, want: unknown): boolean => JSON.stringify(got) === JSON.stringify(want);
const HOST = 'mshq'; // not-policy: sim fixture — the literal host name of the signer owner slot
const OWNER = '5550001111';

/** Per seed: version · cut · the evening the CEO signs (KST) — the publish slot is 06:00 KST the next morning (21:00Z). Literal rows. */
const ROWS: ReadonlyArray<{ version: string; cut: string; recut: string; day: string }> = [
  { version: '0.3.39', cut: '9126baa991f0'.padEnd(40, '1'), recut: 'b446762b4460'.padEnd(40, '1'), day: '2026-11-28' },
  { version: '0.3.40', cut: '6ac7d7b2cc30'.padEnd(40, '2'), recut: '85aa32c325d0'.padEnd(40, '2'), day: '2026-11-29' },
  { version: '0.3.41', cut: 'a7f6683894c0'.padEnd(40, '3'), recut: '09bac2a0af70'.padEnd(40, '3'), day: '2026-11-30' },
  { version: '0.3.42', cut: '2c4ed3bbfdf0'.padEnd(40, '4'), recut: '51a75f825930'.padEnd(40, '4'), day: '2026-12-01' },
  { version: '0.3.43', cut: 'e976fc64df18'.padEnd(40, '5'), recut: '445dcc116da0'.padEnd(40, '5'), day: '2026-12-02' },
];
const row = (seed: number) => ROWS[((seed - 1) % 5 + 5) % 5]!;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

interface Judged { published: boolean; reason: string | null; use: PreAuthUse | null; calls: string[] }
interface World {
  readonly stateDir: string; readonly ledger: DecisionLedger; readonly version: string; readonly notes: string; readonly lines: string[];
  readonly reds: ChecklistRed[]; readonly holds: string[];
  /** Set the universe clock (ISO). */
  at(iso: string): void;
  sign(mode: PreAuthMode, user?: string): Promise<{ id: string; taps: string[] }>;
  judge(engine: SimWorldEngine, cut: string, waiveReason?: string): Promise<Judged>;
}

function world(ctx: SimWorldScenarioContext, tag: string, seed: number): World {
  const { version, day } = row(seed);
  const root = join(ctx.universeRoot, tag);
  const stateDir = join(root, 'mshq-state');
  mkdirSync(stateDir, { recursive: true });
  const ownerLedger = join(root, 'credential-owner-ledger.json');
  let now = `${day}T13:30:00.000Z`; // 22:30 KST — the CEO signs before sleeping
  const clock = () => new Date(now);
  const ledger = new DecisionLedger({ stateDir, now: clock, resolveVersion: () => ({ released: null, dev: null, codename: null }) });
  const notes = join(root, 'notes.md');
  writeFileSync(notes, `# elanous v${version}\n\nPublic notes for seed ${seed}.\n`);
  const lines: string[] = []; const reds: ChecklistRed[] = []; const holds: string[] = [];
  const transport: CardTransport = { platform: 'telegram', ownerChats: async () => [OWNER], send: async () => ({ chat: OWNER, message: '1' }), edit: async () => undefined, notify: async () => undefined };
  const signer = (b: Parameters<typeof signApprovalProof>[0]) => signApprovalProof(b, { stateDir, ownerLedgerPath: ownerLedger, host: HOST, now: clock });
  const service = new DecisionCardService({ transport, ownerIds: [OWNER], ledger, statePath: join(stateDir, 'decisions', 'cards-telegram.json'), signer, now: clock });
  ensureApprovalSigner({ stateDir, ownerLedgerPath: ownerLedger, host: HOST, now: clock, notify: () => undefined });
  const io: PreAuthGateIo = {
    stateDir, records: () => ledger.list({ status: 'all' }), trustRoots: () => readDecisionTrustRoots(stateDir), policy: () => loadPreAuthPolicy(),
    reds: () => reds, openHolds: () => holds, notify: (line) => { lines.push(line); }, now: clock,
  };
  let runs = 0;
  return {
    stateDir, ledger, version, notes, lines, reds, holds,
    at: (iso) => { now = iso; },
    async sign(mode, user = OWNER) {
      const r = raisePreAuth(ledger, loadPreAuthPolicy(), { version, mode, publishAt: `${day}T21:00:00.000Z`, now: clock() });
      return { id: r.id, taps: [(await service.tap(user, `dec:${r.id}:a`)).kind, (await service.tap(user, `dec:${r.id}:a:ok`)).kind] };
    },
    async judge(engine, cut, waiveReason) {
      const binding: ApprovalBinding = { version, cutSha: cut, notesSha256: sha256(notes) };
      if (engine === 'legacy') {
        const r = await preAuthGate(io, { binding, preparedCommit: cut, branchHead: cut, notesFile: notes, dryRunPass: { cutSha: cut, notesSha256: binding.notesSha256, at: now },
          ...(waiveReason ? { waiveReason } : {}) }, { record: true, by: 'release-graph:go' });
        return { published: r.ok, reason: r.ok ? null : r.reasons.join('; '), use: r.ok ? r.use : null, calls: [] };
      }
      const calls: string[] = [];
      const deps: CritpathDeps = {
        readPrepared: () => ({ dir: root, version, tag: `v${version}`, publicRepo: 'example/elanous', sourceRef: cut, sourceCommit: cut,
          publicCommit: 'c'.repeat(40), tgz: join(root, 'elanous.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }),
        resolveBranch: () => cut, prepare: async () => { throw new Error('unexpected prepare'); },
        githubReleaseExists: () => false, publish: async ({ yes }) => { if (yes) calls.push('publish'); },
        npmRegistry: async () => ({ visible: false }), npmDryRun: () => ({ ok: true, detail: 'ok' }),
        npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
        verify: async () => { calls.push('verify'); return { ok: true, summary: 'verify ok' }; },
        approvalRecords: () => ledger.list({ status: 'all' }), trustRoots: () => readDecisionTrustRoots(stateDir),
        requestApproval: (nb) => { calls.push('card'); return { id: ledger.raiseOnce(critpathApprovalCard(nb), approvalRef(nb)).id }; },
        preAuth: await defaultPreAuthDeps(io),
        log: () => undefined, now: clock,
      };
      const ledgerPath = join(root, `critpath-run-${++runs}.json`);
      const opts = { version, notesFile: notes, cutCommit: cut, out: join(root, 'prepared'), ledgerPath, ...(waiveReason ? { waiveReason } : {}) };
      await runCritpath({ ...opts, dryRun: true }, deps);
      const r = await runCritpath(opts, deps);
      const crit = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as { preAuthUse?: PreAuthUse; entries: Array<{ step: string; outcome: string; detail?: string }> } : { entries: [] };
      const wait = crit.entries.filter(e => e.step === 'approval' && e.outcome === 'waiting-approval').at(-1)?.detail ?? '';
      const skipped = /preauth skipped \{(.*)\}$/.exec(wait)?.[1] ?? null;
      return { published: r.status === 'done', reason: skipped, use: crit.preAuthUse ?? null, calls };
    },
  };
}

async function scene(ctx: SimWorldScenarioContext, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) {
    const out = await body(seed, ctx.engine);
    if (out) return out;
  }
  ctx.recorder.event('release-preauth:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
  return { ok: true };
}
const publishAt = (seed: number) => `${row(seed).day}T21:00:00.000Z`; // 06:00 KST next morning
const pubOk = (j: Judged, engine: SimWorldEngine) => j.published && (engine === 'legacy' || same(j.calls, ['publish', 'npm', 'verify']));
const heldOk = (j: Judged, engine: SimWorldEngine) => !j.published && (engine === 'legacy' || same(j.calls, ['card']));
/** The auto-mode condition snapshot, written out (rule 11). */
const autoSnapshot = (cut: string, notesSha: string, at: string) => ({
  'red-0': '🔴 0', 'dry-run-exact-cut': `dry-run ✓ ${at}`, 'open-hold-0': 'HOLD 0', 'notes-present': `notes ✓ ${notesSha.slice(0, 12)}`, 'cut-head-prepared': `cut head = prepared ${cut.slice(0, 12)}`,
});

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'PA-S1',
    title: 'CEO pre-signs auto at 22:30 KST → at 06:00 every condition holds → publish without a card · one use row · one TG line',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s1-${engine}-s${seed}`, seed);
        const { cut, version } = { cut: row(seed).cut, version: row(seed).version };
        const s = await w.sign('auto');
        if (!same(s.taps, ['confirm', 'decided'])) return fail('tap', `seed ${seed} ${engine}: taps ${JSON.stringify(s.taps)} (want ["confirm","decided"])`);
        if (!w.ledger.show(s.id).proof?.keyId) return fail('unsigned', `seed ${seed} ${engine}: the pre-auth card has no proof`);
        w.at(publishAt(seed));
        const j = await w.judge(engine, cut);
        if (!pubOk(j, engine)) return fail('not-published', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        const notesSha = sha256(w.notes);
        const want = { preAuthId: s.id, version, mode: 'auto', cutSha: cut, notesSha256: notesSha, conditions: autoSnapshot(cut, notesSha, publishAt(seed)), waivers: [] };
        const got = j.use && { preAuthId: j.use.preAuthId, version: j.use.version, mode: j.use.mode, cutSha: j.use.cutSha, notesSha256: j.use.notesSha256, conditions: j.use.conditions, waivers: j.use.waivers };
        if (!same(got, want)) return fail('use-row', `seed ${seed} ${engine}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
        if (readPreAuthUses(w.stateDir).length !== 1) return fail('use-count', `seed ${seed} ${engine}: ${readPreAuthUses(w.stateDir).length} use rows (want 1)`);
        const line = `사전 승인 ${s.id} 로 v${version} 발행 (auto, cut ${cut.slice(0, 12)}, 조건 🔴 0 · dry-run ✓ ${publishAt(seed)} · HOLD 0 · notes ✓ ${notesSha.slice(0, 12)} · cut head = prepared ${cut.slice(0, 12)})`;
        if (!same(w.lines, [line])) return fail('tg-line', `seed ${seed} ${engine}: ${JSON.stringify(w.lines)} (want [${line}])`);
        return null;
      });
    },
  },
  {
    id: 'PA-S2',
    title: 'pre-signed auto, but one 🔴 at publish time → no publish · the normal publish card goes to the CEO · the reason names the red',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s2-${engine}-s${seed}`, seed);
        const s = await w.sign('auto');
        w.reds.push({ id: 'SIM-RED-CELL', priority: 'P1' });
        w.at(publishAt(seed));
        const j = await w.judge(engine, row(seed).cut);
        if (!heldOk(j, engine)) return fail('published', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want no publish${engine === 'graph' ? ' + card' : ''})`);
        const want = `${s.id}(auto): conditions: red-0: 🔴 1 (SIM-RED-CELL)`;
        if (j.reason !== want) return fail('reason', `seed ${seed} ${engine}: ${j.reason} (want ${want})`);
        if (readPreAuthUses(w.stateDir).length !== 0 || w.lines.length !== 0) return fail('recorded', `seed ${seed} ${engine}: a refused pre-auth left a use row or a line`);
        return null;
      });
    },
  },
  {
    id: 'PA-S3',
    title: 'pre-signed auto, the run comes after the window (08:30 KST) → no publish · window-passed',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s3-${engine}-s${seed}`, seed);
        const s = await w.sign('auto');
        w.at(`${row(seed).day}T23:30:00.000Z`);
        const j = await w.judge(engine, row(seed).cut);
        if (!heldOk(j, engine) || j.reason !== `${s.id}(auto): window-passed`) return fail('window', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want held · ${s.id}(auto): window-passed)`);
        return null;
      });
    },
  },
  {
    id: 'PA-S4',
    title: 'pre-signed auto, then revoked (TG /preauth 취소 → revokePreAuth) → no publish · revoked',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s4-${engine}-s${seed}`, seed);
        const s = await w.sign('auto');
        const r = revokePreAuth(w.stateDir, s.id, `telegram:${OWNER}`, 'CEO revoked on Telegram', new Date(`${row(seed).day}T14:00:00.000Z`));
        if (!same(r, { revoked: true, already: false })) return fail('revoke', `seed ${seed} ${engine}: ${JSON.stringify(r)}`);
        w.at(publishAt(seed));
        const j = await w.judge(engine, row(seed).cut);
        if (!heldOk(j, engine) || j.reason !== `${s.id}(auto): revoked`) return fail('revoked', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want held · ${s.id}(auto): revoked)`);
        return null;
      });
    },
  },
  {
    id: 'PA-S5',
    title: 'pre-signed surgery · a non-critical 🔴 (P1) with its known-issue line → publish · the waiver is recorded; a P0 🔴 still blocks',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s5-${engine}-s${seed}`, seed);
        const s = await w.sign('surgery');
        w.reds.push({ id: 'SIM-P0-CELL', priority: 'P0' });
        w.at(publishAt(seed));
        const blocked = await w.judge(engine, row(seed).cut);
        const wantBlocked = `${s.id}(surgery): conditions: critical-red-0: critical 🔴 1 (SIM-P0-CELL)`;
        if (!heldOk(blocked, engine) || blocked.reason !== wantBlocked) return fail('critical', `seed ${seed} ${engine}: ${JSON.stringify(blocked)} (want held · ${wantBlocked})`);
        w.reds.splice(0, w.reds.length, { id: 'SIM-P1-CELL', priority: 'P1', knownIssue: 'The settings page may show the old theme until reload.' });
        const j = await w.judge(engine, row(seed).cut);
        if (!pubOk(j, engine)) return fail('not-published', `seed ${seed} ${engine}: ${JSON.stringify(j)}`);
        if (!same(j.use?.waivers, [{ id: 'SIM-P1-CELL', reason: 'The settings page may show the old theme until reload.' }]) || j.use?.mode !== 'surgery') return fail('waiver', `seed ${seed} ${engine}: ${JSON.stringify(j.use)}`);
        if (!same(j.use?.conditions['noncritical-red-waived'], 'non-critical 🔴 1 waived 1')) return fail('snapshot', `seed ${seed} ${engine}: ${JSON.stringify(j.use?.conditions)}`);
        return null;
      });
    },
  },
  {
    id: 'PA-S6',
    title: 'the cut is redone after signing → still allowed (bound to the version, not a sha) · the use records the new cut · a third cut is refused (single use)',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s6-${engine}-s${seed}`, seed);
        const { cut, recut } = row(seed);
        const s = await w.sign('auto');
        w.at(publishAt(seed));
        const j = await w.judge(engine, recut);
        if (!pubOk(j, engine) || j.use?.cutSha !== recut || j.use?.preAuthId !== s.id) return fail('recut', `seed ${seed} ${engine}: ${JSON.stringify({ published: j.published, cut: j.use?.cutSha, calls: j.calls })} (want published from ${recut})`);
        const again = await w.judge(engine, recut);
        if (!again.published || readPreAuthUses(w.stateDir).length !== 1 || w.lines.length !== 1) return fail('rerun', `seed ${seed} ${engine}: same cut rerun → ${JSON.stringify(again)} · uses ${readPreAuthUses(w.stateDir).length} · lines ${w.lines.length} (want allowed · 1 · 1)`);
        const third = await w.judge(engine, cut);
        const want = `${s.id}(auto): already-used:${recut.slice(0, 12)}`;
        if (!heldOk(third, engine) || third.reason !== want) return fail('single-use', `seed ${seed} ${engine}: ${JSON.stringify(third)} (want held · ${want})`);
        return null;
      });
    },
  },
  {
    id: 'PA-S7',
    title: 'a seat writes the human row on the pre-auth card itself (no tap, no proof) → unverified:no-proof · no publish',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `s7-${engine}-s${seed}`, seed);
        const r = raisePreAuth(w.ledger, loadPreAuthPolicy(), { version: w.version, mode: 'auto', publishAt: publishAt(seed), now: new Date(`${row(seed).day}T13:30:00.000Z`) });
        w.ledger.decide(r.id, 'a', { kind: 'human', via: 'telegram', platformUserId: OWNER });
        w.at(publishAt(seed));
        const j = await w.judge(engine, row(seed).cut);
        if (!heldOk(j, engine) || j.reason !== `${r.id}(auto): unverified:no-proof`) return fail('forged', `seed ${seed} ${engine}: ${JSON.stringify(j)} (want held · ${r.id}(auto): unverified:no-proof)`);
        return null;
      });
    },
  },
];
